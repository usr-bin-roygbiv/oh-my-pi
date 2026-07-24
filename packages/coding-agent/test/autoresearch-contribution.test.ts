import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Database } from "bun:sqlite";
import { Buffer } from "node:buffer";
import * as fs from "node:fs";
import * as os from "node:os";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { type GeneratedProvider, getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { createAutoresearchExtension } from "@oh-my-pi/pi-coding-agent/autoresearch";
import {
	assertContributionGoalUnchanged,
	buildContributionCompareUrl,
	buildContributionPrDraft,
	buildContributionReviewUrl,
	CONTRIBUTION_GOAL_MAX_BYTES,
	CONTRIBUTION_HUMAN_SUMMARY_PLACEHOLDER,
	type ContributionBaseProof,
	type ContributionCandidate,
	type ContributionErrorCode,
	type ContributionGitHubRequest,
	type ContributionGitHubRequestSpec,
	type ContributionGoal,
	type ContributionPrDraft,
	type ContributionPreflightGit,
	type ContributionPublicationGit,
	canonicalizeGitHubRemote,
	createContributionBaseProof,
	fetchOfficialContributionGoal,
	OFFICIAL_CONTRIBUTION_GOAL_PATH,
	OFFICIAL_CONTRIBUTION_HOST,
	OFFICIAL_CONTRIBUTION_OWNER,
	OFFICIAL_CONTRIBUTION_REF,
	OFFICIAL_CONTRIBUTION_REPO,
	OFFICIAL_CONTRIBUTION_REPOSITORY,
	publishContributionCandidate,
	validateContributionForkRemote,
	verifyContributionBase,
	verifyContributionFork,
} from "@oh-my-pi/pi-coding-agent/autoresearch/contribution";
import * as autoresearchStorage from "@oh-my-pi/pi-coding-agent/autoresearch/storage";
import {
	closeAllAutoresearchStorages,
	hasActiveAutoresearchSession,
	openAutoresearchStorage,
	type SessionRow,
} from "@oh-my-pi/pi-coding-agent/autoresearch/storage";
import * as bashExecutor from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import type {
	AgentEndEvent,
	BeforeAgentStartEvent,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionHandler,
	RegisteredCommand,
	SessionBeforeBranchEvent,
	SessionBeforeSwitchEvent,
	SessionBeforeTreeEvent,
	SessionShutdownEvent,
	SessionStartEvent,
	ToolDefinition,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { ExtensionUiController } from "@oh-my-pi/pi-coding-agent/modes/controllers/extension-ui-controller";
import * as git from "@oh-my-pi/pi-coding-agent/utils/git";
import { TempDir } from "@oh-my-pi/pi-utils";
import { $ } from "bun";

afterEach(() => {
	vi.restoreAllMocks();
});

const COMMIT_SHA = "1".repeat(40);
const TREE_SHA = "2".repeat(40);
const BLOB_SHA = "3".repeat(40);
const CURRENT_HEAD = "4".repeat(40);
const GOAL_CONTENT = "\n# Faster contributor loop\n\nReduce latency without weakening validation.\n";
const FORK_URL = "git@github.com:alice/oh-my-pi.git";
const CONTRIBUTION_BRANCH = "autoresearch/faster-contributor-loop-20260723";
const CONTRIBUTION_HARNESS_SHA256_ASI_KEY = "_omp_contribution_harness_sha256";
const CONTRIBUTION_WORKTREE_TREE_ASI_KEY = "_omp_contribution_worktree_tree";
const CONTRIBUTION_INVOCATION_SHA256_ASI_KEY = "_omp_contribution_invocation_sha256";
const CONTRIBUTION_HEAD_SHA_ASI_KEY = "_omp_contribution_head_sha";
const CONTRIBUTION_HARNESS_MAX_BYTES = 1024 * 1024;
const HARNESS_SHA256 = "a".repeat(64);
const CHANGED_HARNESS_SHA256 = "b".repeat(64);
const INVOCATION_SHA256 = "d".repeat(64);
const TIMEOUT_CHANGED_INVOCATION_SHA256 = "e".repeat(64);
const CONFIG_CHANGED_INVOCATION_SHA256 = "f".repeat(64);
const RED_TREE_SHA = "b".repeat(40);
const CANDIDATE_TREE_SHA = "c".repeat(40);

function snapshotFileSizes(root: string): string[] {
	if (!fs.existsSync(root)) return [];
	const files: string[] = [];
	const visit = (directory: string): void => {
		for (const entry of fs
			.readdirSync(directory, { withFileTypes: true })
			.sort((a, b) => a.name.localeCompare(b.name))) {
			const entryPath = `${directory}/${entry.name}`;
			if (entry.isDirectory()) {
				visit(entryPath);
			} else if (entry.isFile()) {
				const bytes = fs.readFileSync(entryPath);
				files.push(`${entryPath.slice(root.length + 1)}:${bytes.byteLength}:${Bun.hash(bytes).toString(16)}`);
			}
		}
	};
	visit(root);
	return files;
}
function snapshotWorktreeTreeTemps(): string[] {
	return fs
		.readdirSync(os.tmpdir(), { withFileTypes: true })
		.filter(entry => entry.name.startsWith("omp-worktree-tree-"))
		.map(entry => `${entry.name}:${entry.isDirectory() ? "directory" : "file"}`)
		.sort();
}

function growFileAfterSnapshotStat(targetPath: string, grownBytes: number): () => boolean {
	const realOpen = fs.promises.open;
	let grew = false;
	vi.spyOn(fs.promises, "open").mockImplementation(async (file, flags, mode) => {
		const handle = await realOpen(file, flags, mode);
		if (String(file) !== targetPath) return handle;
		const realStat = handle.stat.bind(handle) as unknown as (...args: unknown[]) => Promise<fs.Stats>;
		handle.stat = (async (...args: unknown[]) => {
			const stat = await realStat(...args);
			if (!grew) {
				grew = true;
				fs.truncateSync(targetPath, grownBytes);
			}
			return stat;
		}) as typeof handle.stat;
		return handle;
	});
	return () => grew;
}

async function readRawCommitTree(cwd: string, commit: string): Promise<string | null> {
	const result = await $`git -C ${cwd} --no-replace-objects cat-file commit ${commit}`.quiet().nothrow();
	if (result.exitCode !== 0) return null;
	const treeHeader = result
		.text()
		.split("\n")
		.find(line => line.startsWith("tree "));
	return treeHeader?.slice("tree ".length) ?? null;
}

interface GoalRequestFixture {
	request: ContributionGitHubRequest;
	calls: ContributionGitHubRequestSpec[];
}

function makeGoalRequest(
	options: { ref?: unknown; commit?: unknown; tree?: unknown; blob?: unknown; content?: string } = {},
): GoalRequestFixture {
	const content = options.content ?? GOAL_CONTENT;
	const size = Buffer.byteLength(content);
	const responses = [
		options.ref ?? { sha: COMMIT_SHA, type: "commit" },
		options.commit ?? { sha: COMMIT_SHA, treeSha: TREE_SHA },
		options.tree ?? {
			truncated: false,
			entries: [{ path: OFFICIAL_CONTRIBUTION_GOAL_PATH, type: "blob", sha: BLOB_SHA, size }],
		},
		options.blob ?? {
			sha: BLOB_SHA,
			size,
			encoding: "base64",
			content: Buffer.from(content).toString("base64"),
		},
	];
	const calls: ContributionGitHubRequestSpec[] = [];
	const request: ContributionGitHubRequest = async spec => {
		calls.push(spec);
		const response = responses[calls.length - 1];
		if (response === undefined) throw new Error(`Unexpected GitHub request ${spec.endpoint}`);
		return response;
	};
	return { request, calls };
}

async function expectContributionError(promise: Promise<unknown>, code: ContributionErrorCode): Promise<void> {
	await expect(promise).rejects.toMatchObject({ name: "ContributionError", code });
}

function contributionErrorCode(error: unknown): unknown {
	if (error === null || typeof error !== "object" || !("code" in error)) return undefined;
	return error.code;
}

function expectedGoalEndpoints(): string[] {
	return [
		`/repos/${OFFICIAL_CONTRIBUTION_OWNER}/${OFFICIAL_CONTRIBUTION_REPO}/git/ref/heads/${OFFICIAL_CONTRIBUTION_REF}`,
		`/repos/${OFFICIAL_CONTRIBUTION_OWNER}/${OFFICIAL_CONTRIBUTION_REPO}/git/commits/${COMMIT_SHA}`,
		`/repos/${OFFICIAL_CONTRIBUTION_OWNER}/${OFFICIAL_CONTRIBUTION_REPO}/git/trees/${TREE_SHA}?recursive=1`,
		`/repos/${OFFICIAL_CONTRIBUTION_OWNER}/${OFFICIAL_CONTRIBUTION_REPO}/git/blobs/${BLOB_SHA}`,
	];
}

function makeGoal(overrides: Partial<ContributionGoal> = {}): ContributionGoal {
	const content = overrides.content ?? GOAL_CONTENT;
	return {
		owner: OFFICIAL_CONTRIBUTION_OWNER,
		repository: OFFICIAL_CONTRIBUTION_REPOSITORY,
		ref: OFFICIAL_CONTRIBUTION_REF,
		path: OFFICIAL_CONTRIBUTION_GOAL_PATH,
		commitSha: COMMIT_SHA,
		blobSha: BLOB_SHA,
		sha256: new Bun.CryptoHasher("sha256").update(content).digest("hex"),
		title: "Faster contributor loop",
		content,
		...overrides,
	};
}

function makeCandidate(overrides: Partial<ContributionCandidate> & { treeSha?: string } = {}): ContributionCandidate {
	return {
		status: "keep",
		runNumber: 7,
		commit: CURRENT_HEAD,
		description: "Observed runtime_ms improve from 21.7 ms to 18.25 ms.",
		scenario: "Ran the focused edit benchmark three times on Linux x64.",
		metric: 18.25,
		metricName: "runtime_ms",
		metricUnit: "ms",
		flagged: false,
		segment: 2,
		treeSha: CANDIDATE_TREE_SHA,
		...overrides,
	} as ContributionCandidate;
}

function makeBaseProof(): ContributionBaseProof {
	return {
		clean: true,
		baseSha: COMMIT_SHA,
		currentHead: COMMIT_SHA,
		initialGoalCommitSha: COMMIT_SHA,
	};
}

type ContributionPublicationGitWithRawTree = ContributionPublicationGit & {
	readRawCommitTree(cwd: string, commit: string, signal?: AbortSignal): Promise<string | null>;
};

function makePublicationGit(
	overrides: Partial<ContributionPublicationGitWithRawTree> = {},
): ContributionPublicationGitWithRawTree {
	return {
		readRemoteUrl: async () => FORK_URL,
		readPushRemoteUrl: async () => FORK_URL,
		readBranch: async () => CONTRIBUTION_BRANCH,
		readHead: async () => CURRENT_HEAD,
		readStatus: async () => "",
		readRawCommitTree: async () => CANDIDATE_TREE_SHA,
		isAncestor: async () => true,
		push: async () => {},
		...overrides,
	} as ContributionPublicationGitWithRawTree;
}

function makeApprovedDraft(
	goal: ContributionGoal = makeGoal(),
	candidate: ContributionCandidate = makeCandidate(),
): ContributionPrDraft {
	return buildContributionPrDraft(
		goal,
		candidate,
		validateContributionForkRemote(FORK_URL),
		CONTRIBUTION_BRANCH,
		makeBaseProof(),
	);
}

describe("official contribution goal loading", () => {
	it("uses the immutable official ref→commit→tree→blob Git-data chain and records provenance", async () => {
		const fixture = makeGoalRequest();
		const goal = await fetchOfficialContributionGoal("/work/repo", { request: fixture.request });

		expect(fixture.calls.map(call => call.endpoint)).toEqual(expectedGoalEndpoints());
		expect(fixture.calls.every(call => call.hostname === OFFICIAL_CONTRIBUTION_HOST)).toBe(true);
		expect(fixture.calls.every(call => call.jq.trim().length > 0)).toBe(true);
		expect(goal).toMatchObject({
			owner: OFFICIAL_CONTRIBUTION_OWNER,
			repository: OFFICIAL_CONTRIBUTION_REPOSITORY,
			ref: OFFICIAL_CONTRIBUTION_REF,
			path: OFFICIAL_CONTRIBUTION_GOAL_PATH,
			commitSha: COMMIT_SHA,
			blobSha: BLOB_SHA,
			title: "Faster contributor loop",
			content: GOAL_CONTENT,
		});
		const expectedDigest = new Bun.CryptoHasher("sha256").update(GOAL_CONTENT).digest("hex");
		expect(goal.sha256).toBe(expectedDigest);
	});

	it("requires every approved goal identity and content field to remain exact", () => {
		const approved = makeGoal();
		const mismatches: ContributionGoal[] = [
			makeGoal({ commitSha: "9".repeat(40) }),
			makeGoal({ blobSha: "8".repeat(40) }),
			makeGoal({ sha256: "7".repeat(64) }),
			makeGoal({ title: "Changed title" }),
			makeGoal({ content: `${GOAL_CONTENT}\nDrifted content.\n` }),
		];
		for (const current of mismatches) {
			expect(() => assertContributionGoalUnchanged(approved, current)).toThrow(
				expect.objectContaining({ code: "goal_changed" }),
			);
		}
	});

	it("rejects a ref that does not resolve to a commit before requesting a commit", async () => {
		const fixture = makeGoalRequest({ ref: { sha: COMMIT_SHA, type: "tag" } });
		await expectContributionError(
			fetchOfficialContributionGoal("/work/repo", { request: fixture.request }),
			"goal_ref_invalid",
		);
		expect(fixture.calls).toHaveLength(1);
	});

	it("rejects a commit response whose identity does not match the resolved ref", async () => {
		const fixture = makeGoalRequest({ commit: { sha: "9".repeat(40), treeSha: TREE_SHA } });
		await expectContributionError(
			fetchOfficialContributionGoal("/work/repo", { request: fixture.request }),
			"goal_commit_invalid",
		);
		expect(fixture.calls).toHaveLength(2);
	});

	it("rejects truncated trees instead of treating an absent entry as authoritative", async () => {
		const fixture = makeGoalRequest({ tree: { truncated: true, entries: [] } });
		await expectContributionError(
			fetchOfficialContributionGoal("/work/repo", { request: fixture.request }),
			"goal_tree_invalid",
		);
		expect(fixture.calls).toHaveLength(3);
	});

	it("rejects a missing official goal path without falling back to a worktree or remote", async () => {
		const fixture = makeGoalRequest({ tree: { truncated: false, entries: [] } });
		await expectContributionError(
			fetchOfficialContributionGoal("/work/repo", { request: fixture.request }),
			"goal_path_missing",
		);
		expect(fixture.calls).toHaveLength(3);
	});

	it("rejects a tree-declared oversized blob before downloading it", async () => {
		const fixture = makeGoalRequest({
			tree: {
				truncated: false,
				entries: [
					{
						path: OFFICIAL_CONTRIBUTION_GOAL_PATH,
						type: "blob",
						sha: BLOB_SHA,
						size: CONTRIBUTION_GOAL_MAX_BYTES + 1,
					},
				],
			},
		});
		await expectContributionError(
			fetchOfficialContributionGoal("/work/repo", { request: fixture.request }),
			"goal_too_large",
		);
		expect(fixture.calls).toHaveLength(3);
	});

	it("rejects malformed base64", async () => {
		const fixture = makeGoalRequest({
			tree: {
				truncated: false,
				entries: [{ path: OFFICIAL_CONTRIBUTION_GOAL_PATH, type: "blob", sha: BLOB_SHA, size: 12 }],
			},
			blob: { sha: BLOB_SHA, size: 12, encoding: "base64", content: "%%%not-base64%%%" },
		});
		await expectContributionError(
			fetchOfficialContributionGoal("/work/repo", { request: fixture.request }),
			"goal_base64_invalid",
		);
	});

	it("rejects decoded content over 32 KiB even when GitHub declares a smaller size", async () => {
		const oversized = Buffer.alloc(CONTRIBUTION_GOAL_MAX_BYTES + 1, 0x61);
		const fixture = makeGoalRequest({
			tree: {
				truncated: false,
				entries: [{ path: OFFICIAL_CONTRIBUTION_GOAL_PATH, type: "blob", sha: BLOB_SHA, size: 1 }],
			},
			blob: { sha: BLOB_SHA, size: 1, encoding: "base64", content: oversized.toString("base64") },
		});
		await expectContributionError(
			fetchOfficialContributionGoal("/work/repo", { request: fixture.request }),
			"goal_too_large",
		);
	});

	it("rejects NUL-bearing content", async () => {
		const fixture = makeGoalRequest({ content: "# Valid title\nunsafe\0tail\n" });
		await expectContributionError(
			fetchOfficialContributionGoal("/work/repo", { request: fixture.request }),
			"goal_content_invalid",
		);
	});

	it("rejects content whose first nonblank line is not a bounded H1 title", async () => {
		const invalidContents = ["plain text\n# Later heading\n", `# ${"x".repeat(121)}\n`, "## Wrong heading level\n"];
		for (const content of invalidContents) {
			const fixture = makeGoalRequest({ content });
			await expectContributionError(
				fetchOfficialContributionGoal("/work/repo", { request: fixture.request }),
				"goal_title_invalid",
			);
		}
	});
});

interface StorageArtifact {
	name: string;
	kind: "file" | "directory";
	size: number;
	sha256: string | null;
}

function snapshotStorageArtifacts(dir: string): StorageArtifact[] {
	return fs
		.readdirSync(dir, { withFileTypes: true })
		.map(entry => {
			const path = `${dir}/${entry.name}`;
			if (!entry.isFile()) {
				return { name: entry.name, kind: "directory" as const, size: 0, sha256: null };
			}
			const bytes = fs.readFileSync(path);
			return {
				name: entry.name,
				kind: "file" as const,
				size: bytes.byteLength,
				sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
			};
		})
		.sort((left, right) => left.name.localeCompare(right.name));
}

function openHistoricalSession(cwd: string) {
	return openAutoresearchStorage(cwd).then(storage => {
		const session = storage.openSession({
			name: "existing",
			goal: "historical work",
			primaryMetric: "runtime_ms",
			metricUnit: "ms",
			direction: "lower",
			preferredCommand: "bash autoresearch.sh",
			branch: "autoresearch/existing-20260723",
			baselineCommit: COMMIT_SHA,
			maxIterations: 3,
			scopePaths: [],
			offLimits: [],
			constraints: [],
			secondaryMetrics: [],
		});
		return { storage, session };
	});
}

async function openUncachedActiveSession(cwd: string): Promise<autoresearchStorage.AutoresearchStorage> {
	const { storage, session } = await openHistoricalSession(cwd);
	storage.closeSession(session.id);
	const dbPath = storage.dbPath;
	const projectDir = storage.projectDir;
	closeAllAutoresearchStorages();
	const baselineCheckpointer = new Database(dbPath);
	baselineCheckpointer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
	baselineCheckpointer.close();
	const uncached = new autoresearchStorage.AutoresearchStorage(dbPath, projectDir);
	uncached.openSession({
		name: "concurrent active session",
		goal: "active only in the current SQLite snapshot",
		primaryMetric: "runtime_ms",
		metricUnit: "ms",
		direction: "lower",
		preferredCommand: "bash autoresearch.sh",
		branch: "autoresearch/concurrent-active",
		baselineCommit: COMMIT_SHA,
		maxIterations: 3,
		scopePaths: [],
		offLimits: [],
		constraints: [],
		secondaryMetrics: [],
	});
	return uncached;
}

describe("read-only contribution storage preflight", () => {
	let cwd: TempDir;
	let dbDir: TempDir;

	beforeEach(() => {
		cwd = TempDir.createSync("@pi-contribution-preflight-cwd-");
		dbDir = TempDir.createSync("@pi-contribution-preflight-db-");
		process.env.OMP_AUTORESEARCH_DB_DIR = dbDir.path();
		vi.spyOn(git.repo, "root").mockResolvedValue(cwd.path());
	});

	afterEach(() => {
		delete process.env.OMP_AUTORESEARCH_DB_DIR;
		closeAllAutoresearchStorages();
		cwd.removeSync();
		dbDir.removeSync();
	});

	it("does not create a database, schema, journal, or cache artifact when no storage exists", async () => {
		expect(snapshotStorageArtifacts(dbDir.path())).toEqual([]);
		await expect(hasActiveAutoresearchSession(cwd.path())).resolves.toBe(false);
		expect(snapshotStorageArtifacts(dbDir.path())).toEqual([]);
	});

	it("rejects an active cached session and an active disk session without mutating SQLite", async () => {
		await openHistoricalSession(cwd.path());
		await expect(hasActiveAutoresearchSession(cwd.path())).resolves.toBe(true);

		closeAllAutoresearchStorages();
		const before = snapshotStorageArtifacts(dbDir.path());
		await expect(hasActiveAutoresearchSession(cwd.path())).resolves.toBe(true);
		expect(snapshotStorageArtifacts(dbDir.path())).toEqual(before);
	});

	it("allows a historical database whose sessions are all closed, still without writes", async () => {
		const { storage, session } = await openHistoricalSession(cwd.path());
		storage.closeSession(session.id);
		closeAllAutoresearchStorages();
		const before = snapshotStorageArtifacts(dbDir.path());

		await expect(hasActiveAutoresearchSession(cwd.path())).resolves.toBe(false);
		expect(snapshotStorageArtifacts(dbDir.path())).toEqual(before);
	});

	for (const oversizedArtifact of ["database", "write-ahead log"] as const) {
		it(`rejects an oversized ${oversizedArtifact} before copying any state`, async () => {
			await openHistoricalSession(cwd.path());
			closeAllAutoresearchStorages();
			const dbName = fs.readdirSync(dbDir.path()).find(name => name.endsWith(".db"));
			if (!dbName) throw new Error("Expected autoresearch database fixture");
			const dbPath = `${dbDir.path()}/${dbName}`;
			const oversizedPath = oversizedArtifact === "database" ? dbPath : `${dbPath}-wal`;
			if (oversizedArtifact === "write-ahead log") fs.closeSync(fs.openSync(oversizedPath, "w"));
			fs.truncateSync(oversizedPath, 512 * 1024 * 1024 + 1);
			const probeTemps = (): string[] =>
				fs
					.readdirSync(os.tmpdir())
					.filter(name => name.startsWith("omp-autoresearch-probe-"))
					.sort();
			const tempsBefore = probeTemps();
			const mkdtempSpy = vi.spyOn(fs, "mkdtempSync");
			const copyAttempts: string[] = [];
			const realCopyFileSync = fs.copyFileSync;
			vi.spyOn(fs, "copyFileSync").mockImplementation((source, destination) => {
				copyAttempts.push(String(source));
				if (fs.statSync(source).size > 512 * 1024 * 1024) {
					throw new Error("Test intercepted an unbounded state copy");
				}
				realCopyFileSync(source, destination);
			});

			const result = await hasActiveAutoresearchSession(cwd.path()).then(
				value => ({ value }),
				(error: unknown) => ({ error }),
			);

			expect(result).toEqual({ error: expect.any(Error) });
			if (!("error" in result) || !(result.error instanceof Error)) throw new Error("Expected bounded probe error");
			expect(result.error.message).toContain("read-only probe limit");
			expect(copyAttempts).toEqual([]);
			expect(mkdtempSpy.mock.calls.filter(([prefix]) => String(prefix).includes("omp-autoresearch-probe-"))).toEqual(
				[],
			);
			expect(probeTemps()).toEqual(tempsBefore);
		});
	}

	it("cannot lose an active WAL row when a checkpoint races the read-only probe", async () => {
		const writer = await openUncachedActiveSession(cwd.path());
		const dbPath = writer.dbPath;
		const realCopyFileSync = fs.copyFileSync;
		let databaseCopies = 0;
		let checkpointedAfterDatabaseCopy = false;
		const checkpointer: { current: Database | null } = { current: null };
		vi.spyOn(fs, "copyFileSync").mockImplementation((source, destination) => {
			realCopyFileSync(source, destination);
			if (String(source) !== dbPath || checkpointedAfterDatabaseCopy) return;
			databaseCopies++;
			checkpointer.current = new Database(dbPath);
			checkpointer.current.exec("PRAGMA wal_checkpoint(TRUNCATE)");
			checkpointer.current.exec(
				"INSERT INTO runs (session_id, segment, command, started_at, pre_run_dirty_paths_json, log_path) VALUES (1, 0, 'probe', 0, '[]', '')",
			);
			checkpointedAfterDatabaseCopy = true;
		});

		let probeResult: { value: boolean } | { error: unknown } | undefined;
		let sourceStayedActive = false;
		try {
			probeResult = await hasActiveAutoresearchSession(cwd.path()).then(
				value => ({ value }),
				(error: unknown) => ({ error }),
			);
			const inspector = new Database(dbPath, { readonly: true, create: false });
			try {
				sourceStayedActive =
					inspector.query<{ active: number }, []>("SELECT 1 AS active FROM sessions WHERE closed_at IS NULL LIMIT 1").get() !==
					null;
			} finally {
				inspector.close();
			}
		} finally {
			checkpointer.current?.close();
			writer.close();
		}

		expect(databaseCopies === 0 || checkpointedAfterDatabaseCopy).toBe(true);
		expect(sourceStayedActive).toBe(true);
		if (!probeResult) throw new Error("Expected read-only probe outcome");
		if ("error" in probeResult) {
			expect(probeResult.error).toBeInstanceOf(Error);
			expect((probeResult.error as Error).message).toContain("changed during the read-only probe");
		} else {
			expect(probeResult.value).toBe(true);
		}
	});

	it("rejects source growth after the initial size check without attempting an unbounded copy", async () => {
		await openHistoricalSession(cwd.path());
		closeAllAutoresearchStorages();
		const dbName = fs.readdirSync(dbDir.path()).find(name => name.endsWith(".db"));
		if (!dbName) throw new Error("Expected autoresearch database fixture");
		const dbPath = `${dbDir.path()}/${dbName}`;
		const walPath = `${dbPath}-wal`;
		fs.writeFileSync(walPath, Buffer.alloc(32));
		const realLstatSync = fs.lstatSync as unknown as (...args: unknown[]) => fs.Stats;
		let growthInjected = false;
		vi.spyOn(fs, "lstatSync").mockImplementation(
			((...args: unknown[]) => {
				const stat = realLstatSync(...args);
				if (!growthInjected && String(args[0]) === walPath) {
					growthInjected = true;
					fs.truncateSync(walPath, 512 * 1024 * 1024 + 1);
				}
				return stat;
			}) as typeof fs.lstatSync,
		);
		const realCopyFileSync = fs.copyFileSync;
		let unboundedCopyAttempted = false;
		vi.spyOn(fs, "copyFileSync").mockImplementation((source, destination) => {
			if (fs.statSync(source).size > 512 * 1024 * 1024) {
				unboundedCopyAttempted = true;
				throw new Error("Test intercepted an unbounded state copy");
			}
			realCopyFileSync(source, destination);
		});

		const result = await hasActiveAutoresearchSession(cwd.path()).then(
			value => ({ value }),
			(error: unknown) => ({ error }),
		);

		expect(growthInjected).toBe(true);
		expect(result).toEqual({ error: expect.any(Error) });
		if (!("error" in result) || !(result.error instanceof Error)) throw new Error("Expected bounded probe error");
		expect(result.error.message).toContain("read-only probe limit");
		expect(unboundedCopyAttempted).toBe(false);
	});

	it("reuses one storage when concurrent creators resume from the same authorization gate", async () => {
		const bothCreatorsEntered = Promise.withResolvers<void>();
		const releaseCreators = Promise.withResolvers<void>();
		let creatorCount = 0;
		const beforeCreate = async (): Promise<void> => {
			creatorCount++;
			if (creatorCount === 2) bothCreatorsEntered.resolve();
			await releaseCreators.promise;
		};

		const firstPromise = openAutoresearchStorage(cwd.path(), beforeCreate);
		const secondPromise = openAutoresearchStorage(cwd.path(), beforeCreate);
		await bothCreatorsEntered.promise;
		releaseCreators.resolve();
		const [first, second] = await Promise.all([firstPromise, secondPromise]);
		const cached = await openAutoresearchStorage(cwd.path());
		if (first !== second) {
			const leaked = first === cached ? second : first;
			leaked.close();
		}

		expect(creatorCount).toBe(2);
		expect(first).toBe(second);
		expect(cached).toBe(first);
	});

	it("blocks malformed existing storage conservatively without repairing or replacing it", async () => {
		await openHistoricalSession(cwd.path());
		closeAllAutoresearchStorages();
		const dbName = fs.readdirSync(dbDir.path()).find(name => name.endsWith(".db"));
		if (!dbName) throw new Error("Expected autoresearch database fixture");
		const dbPath = `${dbDir.path()}/${dbName}`;
		fs.writeFileSync(dbPath, "not a sqlite database");
		const before = snapshotStorageArtifacts(dbDir.path());

		await expect(hasActiveAutoresearchSession(cwd.path())).rejects.toThrow();
		expect(snapshotStorageArtifacts(dbDir.path())).toEqual(before);
	});
});

describe("contribution base proof", () => {
	it("binds a clean local checkout to the exact official-main goal commit", () => {
		const proof = createContributionBaseProof(makeGoal(), COMMIT_SHA, "");
		expect(proof).toEqual({
			clean: true,
			baseSha: COMMIT_SHA,
			currentHead: COMMIT_SHA,
			initialGoalCommitSha: COMMIT_SHA,
		});
	});

	it("rejects any whole-worktree dirt, including on an existing autoresearch branch", () => {
		expect(() =>
			createContributionBaseProof(makeGoal(), COMMIT_SHA, " M packages/coding-agent/src/index.ts\n"),
		).toThrow(expect.objectContaining({ code: "base_worktree_dirty" }));
	});

	it("rejects a local HEAD that is not the exact official main commit", () => {
		expect(() => createContributionBaseProof(makeGoal(), "9".repeat(40), "")).toThrow(
			expect.objectContaining({ code: "base_head_mismatch" }),
		);
	});

	it("inspects status and HEAD through the injected read-only preflight adapter", async () => {
		const calls: string[] = [];
		const git: ContributionPreflightGit = {
			async status(cwd) {
				calls.push(`status:${cwd}`);
				return "";
			},
			async headSha(cwd) {
				calls.push(`head:${cwd}`);
				return COMMIT_SHA;
			},
		};
		await expect(verifyContributionBase("/work/repo", makeGoal(), { git })).resolves.toEqual(makeBaseProof());
		expect(calls).toEqual(["status:/work/repo", "head:/work/repo"]);
	});

	it("conservatively rejects an unqueryable base", async () => {
		const git: ContributionPreflightGit = {
			status: async () => {
				throw new Error("git status failed");
			},
			headSha: async () => COMMIT_SHA,
		};
		await expectContributionError(
			verifyContributionBase("/work/repo", makeGoal(), { git }),
			"base_inspection_failed",
		);
	});

	it("rejects an official-base HEAD whose replacement ref materializes a different tree", async () => {
		const repo = TempDir.createSync("@pi-contribution-replaced-base-");
		try {
			await $`git -C ${repo.path()} init -b main`.quiet();
			await Bun.write(`${repo.path()}/official.txt`, "official base bytes\n");
			await $`git -C ${repo.path()} add official.txt`.quiet();
			await $`git -C ${repo.path()} -c user.name=OMP -c user.email=omp@example.invalid commit -m official`.quiet();
			const officialSha = (await $`git -C ${repo.path()} rev-parse HEAD`.quiet()).text().trim();
			const officialTree = (await $`git -C ${repo.path()} show -s --format=%T HEAD`.quiet()).text().trim();

			await $`git -C ${repo.path()} checkout --orphan replacement-materialization`.quiet();
			await $`git -C ${repo.path()} rm -rf .`.quiet();
			await Bun.write(`${repo.path()}/replacement.txt`, "replacement-only bytes\n");
			await $`git -C ${repo.path()} add replacement.txt`.quiet();
			await $`git -C ${repo.path()} -c user.name=OMP -c user.email=omp@example.invalid commit -m replacement`.quiet();
			const replacementSha = (await $`git -C ${repo.path()} rev-parse HEAD`.quiet()).text().trim();
			const replacementTree = (await $`git -C ${repo.path()} show -s --format=%T HEAD`.quiet()).text().trim();

			await $`git -C ${repo.path()} checkout main`.quiet();
			await $`git -C ${repo.path()} replace ${officialSha} ${replacementSha}`.quiet();
			await $`git -C ${repo.path()} reset --hard ${officialSha}`.quiet();
			const rawHead = (await $`git -C ${repo.path()} --no-replace-objects rev-parse HEAD`.quiet()).text().trim();
			const rawHeadTree = (await $`git -C ${repo.path()} --no-replace-objects show -s --format=%T HEAD`.quiet())
				.text()
				.trim();
			const materializedHeadTree = (await $`git -C ${repo.path()} show -s --format=%T HEAD`.quiet()).text().trim();
			const status = await git.status(repo.path(), { porcelainV1: true, untrackedFiles: "all", z: true });
			const outcome = await verifyContributionBase(repo.path(), makeGoal({ commitSha: officialSha })).then(
				() => "accepted" as const,
				() => "rejected" as const,
			);

			expect({ rawHead, rawHeadTree, materializedHeadTree, status, outcome }).toEqual({
				rawHead: officialSha,
				rawHeadTree: officialTree,
				materializedHeadTree: replacementTree,
				status: "",
				outcome: "rejected",
			});
		} finally {
			repo.removeSync();
		}
	});
});

describe("contribution fork validation and publication", () => {
	it("canonicalizes HTTPS and SCP GitHub fork URLs without accepting arbitrary hosts", () => {
		expect(canonicalizeGitHubRemote("https://github.com/Alice/oh-my-pi.git")).toMatchObject({
			owner: "alice",
			repository: "oh-my-pi",
		});
		expect(canonicalizeGitHubRemote(FORK_URL)).toMatchObject({
			owner: "alice",
			repository: "oh-my-pi",
			slug: "alice/oh-my-pi",
		});
		expect(canonicalizeGitHubRemote("https://gitlab.com/alice/oh-my-pi.git")).toBeNull();
	});

	it("refuses the canonical upstream and non-fork repository names", () => {
		expect(() => validateContributionForkRemote("https://github.com/can1357/oh-my-pi.git")).toThrow(
			expect.objectContaining({ code: "remote_official" }),
		);
		expect(() => validateContributionForkRemote("https://github.com/alice/not-oh-my-pi.git")).toThrow(
			expect.objectContaining({ code: "remote_not_fork" }),
		);
	});

	it("verifies fork parent/source metadata through one bounded authenticated request", async () => {
		const remote = validateContributionForkRemote(FORK_URL);
		const calls: ContributionGitHubRequestSpec[] = [];
		const request: ContributionGitHubRequest = async spec => {
			calls.push(spec);
			return { fork: true, parent: "can1357/oh-my-pi", source: "CAN1357/OH-MY-PI" };
		};

		await expect(verifyContributionFork("/work/repo", remote, { request })).resolves.toEqual({
			fork: true,
			parent: "can1357/oh-my-pi",
			source: "CAN1357/OH-MY-PI",
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]?.endpoint).toBe("/repos/alice/oh-my-pi");
		expect(calls[0]?.hostname).toBe(OFFICIAL_CONTRIBUTION_HOST);
		expect(calls[0]?.jq).toContain("parent");
		expect(calls[0]?.jq).toContain("source");
	});

	it("rejects unrelated fork ancestry and malformed verification responses", async () => {
		const remote = validateContributionForkRemote(FORK_URL);
		await expectContributionError(
			verifyContributionFork("/work/repo", remote, {
				request: async () => ({ fork: true, parent: "someone/else", source: "someone/else" }),
			}),
			"remote_not_fork",
		);
		await expectContributionError(
			verifyContributionFork("/work/repo", remote, { request: async () => ({ fork: "yes" }) }),
			"fork_verification_failed",
		);
		await expectContributionError(
			verifyContributionFork("/work/repo", remote, {
				request: async () => {
					throw new Error("network failed");
				},
			}),
			"fork_verification_failed",
		);
	});

	it("builds a SHA-bound upstream compare draft with visibly empty human approval", () => {
		const remote = validateContributionForkRemote(FORK_URL);
		const goal = makeGoal();
		const candidate = makeCandidate();
		const baseProof = makeBaseProof();
		const compareUrl = buildContributionCompareUrl(remote, CONTRIBUTION_BRANCH);
		const reviewUrl = buildContributionReviewUrl(remote, baseProof.baseSha, candidate.commit);
		const draft = buildContributionPrDraft(goal, candidate, remote, CONTRIBUTION_BRANCH, baseProof);

		expect(compareUrl).toBe(
			`https://github.com/${OFFICIAL_CONTRIBUTION_OWNER}/${OFFICIAL_CONTRIBUTION_REPO}/compare/main...alice:${encodeURIComponent(CONTRIBUTION_BRANCH)}?expand=1`,
		);
		expect(reviewUrl).toBe(
			`https://github.com/${OFFICIAL_CONTRIBUTION_OWNER}/${OFFICIAL_CONTRIBUTION_REPO}/compare/${baseProof.baseSha}...alice:${candidate.commit}?expand=1`,
		);
		expect(reviewUrl).not.toBe(compareUrl);
		expect(draft).toMatchObject({
			base: "main",
			head: `alice:${CONTRIBUTION_BRANCH}`,
			humanSummary: "",
			scenario: candidate.scenario,
			result: candidate.description,
			baseSha: baseProof.baseSha,
			initialGoalCommitSha: baseProof.initialGoalCommitSha,
			goalCommitSha: goal.commitSha,
			goalBlobSha: goal.blobSha,
			goalSha256: goal.sha256,
			candidateHead: candidate.commit,
		});
		expect(draft.body).toContain(CONTRIBUTION_HUMAN_SUMMARY_PLACEHOLDER);
		expect(draft.body).toContain(goal.commitSha);
		expect(draft.body).toContain(goal.blobSha);
		expect(draft.body).toContain(goal.sha256);
		expect(draft.body).toContain(candidate.commit);
	});

	it("keeps empty human, scenario, and result approvals visibly unresolved", () => {
		const candidate = makeCandidate({ scenario: "", description: "" });
		const draft = buildContributionPrDraft(
			makeGoal(),
			candidate,
			validateContributionForkRemote(FORK_URL),
			CONTRIBUTION_BRANCH,
			makeBaseProof(),
		);
		expect(draft).toMatchObject({ humanSummary: "", scenario: "", result: "" });
		expect(draft.body).toContain(CONTRIBUTION_HUMAN_SUMMARY_PLACEHOLDER);
		expect(draft.body.match(/\bEMPTY\b/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
	});

	it("re-reads the exact fork URL, verifies ancestry, and pushes only the frozen candidate SHA", async () => {
		const calls: string[] = [];
		const pushes: Array<{
			cwd: string;
			remote: string;
			verifiedRemoteUrl: string;
			refspec: string;
			forceWithLease: string;
		}> = [];
		const git = makePublicationGit({
			async readRemoteUrl(cwd, remote) {
				calls.push(`read:${cwd}:${remote}`);
				return FORK_URL;
			},
			async readRawCommitTree(cwd, commit) {
				calls.push(`tree:${cwd}:${commit}`);
				return CANDIDATE_TREE_SHA;
			},
			async isAncestor(cwd, ancestor, descendant) {
				calls.push(`ancestor:${cwd}:${ancestor}:${descendant}`);
				return true;
			},
			async push(cwd, options) {
				calls.push("push");
				pushes.push({
					cwd,
					remote: options.remote,
					verifiedRemoteUrl: options.verifiedRemoteUrl,
					refspec: options.refspec,
					forceWithLease: options.forceWithLease,
				});
			},
		});
		const requests: ContributionGitHubRequestSpec[] = [];
		const goal = makeGoal();
		const candidate = makeCandidate();
		const baseProof = makeBaseProof();
		const approvedDraft = buildContributionPrDraft(
			goal,
			candidate,
			validateContributionForkRemote(FORK_URL),
			CONTRIBUTION_BRANCH,
			baseProof,
		);
		const published = await publishContributionCandidate({
			cwd: "/work/repo",
			remoteName: "origin",
			confirmedRemoteUrl: FORK_URL,
			confirmedPushRemoteUrl: FORK_URL,
			branchName: CONTRIBUTION_BRANCH,
			currentBranch: CONTRIBUTION_BRANCH,
			worktreeClean: true,
			goal,
			candidate,
			currentSegment: 2,
			currentHead: CURRENT_HEAD,
			baseProof,
			approvedDraft,
			git,
			request: async spec => {
				requests.push(spec);
				return { fork: true, parent: "can1357/oh-my-pi", source: "can1357/oh-my-pi" };
			},
		});

		expect(calls).toEqual([
			"read:/work/repo:origin",
			`tree:/work/repo:${CURRENT_HEAD}`,
			`ancestor:/work/repo:${COMMIT_SHA}:${CURRENT_HEAD}`,
			"push",
		]);
		expect(requests.map(request => request.endpoint)).toEqual(["/repos/alice/oh-my-pi"]);
		expect(pushes).toEqual([
			{
				cwd: "/work/repo",
				remote: "origin",
				verifiedRemoteUrl: FORK_URL,
				refspec: `${CURRENT_HEAD}:refs/heads/${CONTRIBUTION_BRANCH}`,
				forceWithLease: `refs/heads/${CONTRIBUTION_BRANCH}:`,
			},
		]);
		expect(published.refspec).toBe(`${CURRENT_HEAD}:refs/heads/${CONTRIBUTION_BRANCH}`);
		expect(published.compareUrl).toContain("/compare/main...alice:");
		expect(published.reviewUrl).toBe(
			`https://github.com/${OFFICIAL_CONTRIBUTION_OWNER}/${OFFICIAL_CONTRIBUTION_REPO}/compare/${COMMIT_SHA}...alice:${CURRENT_HEAD}?expand=1`,
		);
		expect(published.reviewUrl).not.toBe(published.compareUrl);
		expect(published.prDraft.body).toContain(CONTRIBUTION_HUMAN_SUMMARY_PLACEHOLDER);
		expect(published.prDraft).toEqual(approvedDraft);
	});

	it("rejects a candidate whose raw commit tree differs from the stored passing tree before push", async () => {
		const passingTree = "a".repeat(40);
		const rawCommitTree = "b".repeat(40);
		const candidate = makeCandidate({ treeSha: passingTree }) as ContributionCandidate & { treeSha: string };
		const treeReads: Array<{ cwd: string; commit: string }> = [];
		let pushCalls = 0;
		const publicationGit = {
			...makePublicationGit(),
			async readRawCommitTree(cwd: string, commit: string): Promise<string | null> {
				treeReads.push({ cwd, commit });
				return rawCommitTree;
			},
			async push(): Promise<void> {
				pushCalls++;
			},
		} as ContributionPublicationGit & {
			readRawCommitTree(cwd: string, commit: string, signal?: AbortSignal): Promise<string | null>;
		};
		const outcome = await publishContributionCandidate({
			cwd: "/work/repo",
			remoteName: "origin",
			confirmedRemoteUrl: FORK_URL,
			confirmedPushRemoteUrl: FORK_URL,
			branchName: CONTRIBUTION_BRANCH,
			currentBranch: CONTRIBUTION_BRANCH,
			worktreeClean: true,
			goal: makeGoal(),
			candidate,
			currentSegment: 2,
			currentHead: CURRENT_HEAD,
			baseProof: makeBaseProof(),
			approvedDraft: makeApprovedDraft(makeGoal(), candidate),
			git: publicationGit,
			request: async () => ({ fork: true, parent: "can1357/oh-my-pi", source: "can1357/oh-my-pi" }),
		}).then(
			() => "published" as const,
			() => "rejected" as const,
		);

		expect({ outcome, treeReads, pushCalls }).toEqual({
			outcome: "rejected",
			treeReads: [{ cwd: "/work/repo", commit: CURRENT_HEAD }],
			pushCalls: 0,
		});
	});
	it("publishes only the frozen candidate when HEAD moves after push URL verification", async () => {
		const movedHead = "5".repeat(40);
		let head = CURRENT_HEAD;
		let publishedCommit: string | undefined;
		const events: string[] = [];
		const publicationGit = makePublicationGit({
			readHead: async () => head,
			push: async (_cwd, options) => {
				expect(options.verifiedRemoteUrl).toBe(FORK_URL);
				events.push("push URL verified");
				head = movedHead;
				events.push("HEAD moved");
				const source = options.refspec.slice(0, options.refspec.indexOf(":"));
				publishedCommit = source === "HEAD" ? head : source;
				events.push("source resolved");
			},
		});

		await publishContributionCandidate({
			cwd: "/work/repo",
			remoteName: "origin",
			confirmedRemoteUrl: FORK_URL,
			confirmedPushRemoteUrl: FORK_URL,
			branchName: CONTRIBUTION_BRANCH,
			currentBranch: CONTRIBUTION_BRANCH,
			worktreeClean: true,
			goal: makeGoal(),
			candidate: makeCandidate(),
			currentSegment: 2,
			currentHead: CURRENT_HEAD,
			baseProof: makeBaseProof(),
			approvedDraft: makeApprovedDraft(),
			git: publicationGit,
			request: async () => ({ fork: true, parent: "can1357/oh-my-pi", source: "can1357/oh-my-pi" }),
		});

		expect(events).toEqual(["push URL verified", "HEAD moved", "source resolved"]);
		expect(publishedCommit).toBe(CURRENT_HEAD);
	});

	it("runs pre-push while a hook-moved worktree cannot retarget the frozen candidate SHA", async () => {
		const source = TempDir.createSync("@pi-contribution-sha-source-");
		const remote = TempDir.createSync("@pi-contribution-sha-remote-");
		try {
			await $`git init --bare ${remote.path()}`.quiet();
			await $`git -C ${source.path()} init -b main`.quiet();
			await Bun.write(`${source.path()}/proof.txt`, "base\n");
			await $`git -C ${source.path()} add proof.txt`.quiet();
			await $`git -C ${source.path()} -c user.name=OMP -c user.email=omp@example.invalid commit -m base`.quiet();
			const baseSha = (await $`git -C ${source.path()} rev-parse HEAD`.quiet()).text().trim();
			await $`git -C ${source.path()} checkout -b ${CONTRIBUTION_BRANCH}`.quiet();
			await Bun.write(`${source.path()}/proof.txt`, "candidate A\n");
			await $`git -C ${source.path()} add proof.txt`.quiet();
			await $`git -C ${source.path()} -c user.name=OMP -c user.email=omp@example.invalid commit -m candidate-a`.quiet();
			const candidateSha = (await $`git -C ${source.path()} rev-parse HEAD`.quiet()).text().trim();
			const candidateTree = await readRawCommitTree(source.path(), candidateSha);
			if (!candidateTree) throw new Error("Expected candidate tree");
			await Bun.write(`${source.path()}/proof.txt`, "candidate B\n");
			await $`git -C ${source.path()} add proof.txt`.quiet();
			await $`git -C ${source.path()} -c user.name=OMP -c user.email=omp@example.invalid commit -m candidate-b`.quiet();
			const movedSha = (await $`git -C ${source.path()} rev-parse HEAD`.quiet()).text().trim();
			await $`git -C ${source.path()} reset --hard ${candidateSha}`.quiet();
			const hookMarker = `${source.path()}/pre-push-ran`;
			const hookPath = `${source.path()}/.git/hooks/pre-push`;
			await Bun.write(
				hookPath,
				`#!/bin/sh\nprintf hook > ${JSON.stringify(hookMarker)}\ngit reset --hard ${movedSha}\n`,
			);
			fs.chmodSync(hookPath, 0o755);

			const goal = makeGoal({ commitSha: baseSha });
			const candidate = makeCandidate({ commit: candidateSha, treeSha: candidateTree });
			const baseProof: ContributionBaseProof = {
				clean: true,
				baseSha,
				currentHead: baseSha,
				initialGoalCommitSha: baseSha,
			};
			const approvedDraft = buildContributionPrDraft(
				goal,
				candidate,
				validateContributionForkRemote(FORK_URL),
				CONTRIBUTION_BRANCH,
				baseProof,
			);
			const publicationGit = {
				readRemoteUrl: async () => FORK_URL,
				readPushRemoteUrl: async () => FORK_URL,
				readBranch: async () => CONTRIBUTION_BRANCH,
				readHead: (cwd: string, signal?: AbortSignal) => git.head.sha(cwd, signal),
				readStatus: (cwd: string) => git.status(cwd, { porcelainV1: true, untrackedFiles: "all", z: true }),
				readRawCommitTree,
				isAncestor: (cwd: string, ancestor: string, descendant: string, signal?: AbortSignal) =>
					git.isAncestor(cwd, ancestor, descendant, signal),
				push: (cwd: string, options: { refspec: string; forceWithLease: string; signal?: AbortSignal }) =>
					git.push(cwd, {
						remote: `file://${remote.path()}`,
						refspec: options.refspec,
						forceWithLease: options.forceWithLease,
						signal: options.signal,
					}),
			} as ContributionPublicationGit & {
				readRawCommitTree(cwd: string, commit: string, signal?: AbortSignal): Promise<string | null>;
			};

			const published = await publishContributionCandidate({
				cwd: source.path(),
				remoteName: "origin",
				confirmedRemoteUrl: FORK_URL,
				confirmedPushRemoteUrl: FORK_URL,
				branchName: CONTRIBUTION_BRANCH,
				currentBranch: CONTRIBUTION_BRANCH,
				worktreeClean: true,
				goal,
				candidate,
				currentSegment: 2,
				currentHead: candidateSha,
				baseProof,
				approvedDraft,
				git: publicationGit,
				request: async () => ({ fork: true, parent: "can1357/oh-my-pi", source: "can1357/oh-my-pi" }),
			});
			const remoteSha = (await $`git --git-dir ${remote.path()} rev-parse refs/heads/${CONTRIBUTION_BRANCH}`.quiet())
				.text()
				.trim();

			expect(published.refspec).toBe(`${candidateSha}:refs/heads/${CONTRIBUTION_BRANCH}`);
			expect(await git.head.sha(source.path())).toBe(movedSha);
			expect((await Bun.file(`${source.path()}/proof.txt`).text()).trim()).toBe("candidate B");
			expect(remoteSha).toBe(candidateSha);
			expect(await Bun.file(hookMarker).text()).toBe("hook");
		} finally {
			source.removeSync();
			remote.removeSync();
		}
	});

	it("leaves the candidate ref absent when the normal pre-push hook rejects", async () => {
		const source = TempDir.createSync("@pi-contribution-rejected-push-source-");
		const remote = TempDir.createSync("@pi-contribution-rejected-push-remote-");
		try {
			await $`git init --bare ${remote.path()}`.quiet();
			await $`git -C ${source.path()} init -b main`.quiet();
			await Bun.write(`${source.path()}/proof.txt`, "base\n");
			await $`git -C ${source.path()} add proof.txt`.quiet();
			await $`git -C ${source.path()} -c user.name=OMP -c user.email=omp@example.invalid commit -m base`.quiet();
			const baseSha = (await $`git -C ${source.path()} rev-parse HEAD`.quiet()).text().trim();
			await $`git -C ${source.path()} checkout -b ${CONTRIBUTION_BRANCH}`.quiet();
			await Bun.write(`${source.path()}/proof.txt`, "candidate\n");
			await $`git -C ${source.path()} add proof.txt`.quiet();
			await $`git -C ${source.path()} -c user.name=OMP -c user.email=omp@example.invalid commit -m candidate`.quiet();
			const candidateSha = (await $`git -C ${source.path()} rev-parse HEAD`.quiet()).text().trim();
			const candidateTree = await readRawCommitTree(source.path(), candidateSha);
			if (!candidateTree) throw new Error("Expected candidate tree");
			const hookMarker = `${source.path()}/pre-push-rejected`;
			const hookPath = `${source.path()}/.git/hooks/pre-push`;
			await Bun.write(hookPath, `#!/bin/sh\nprintf rejected > ${JSON.stringify(hookMarker)}\nexit 1\n`);
			fs.chmodSync(hookPath, 0o755);
			const goal = makeGoal({ commitSha: baseSha });
			const candidate = makeCandidate({ commit: candidateSha, treeSha: candidateTree });
			const baseProof: ContributionBaseProof = {
				clean: true,
				baseSha,
				currentHead: baseSha,
				initialGoalCommitSha: baseSha,
			};
			const publicationGit = {
				readRemoteUrl: async () => FORK_URL,
				readPushRemoteUrl: async () => FORK_URL,
				readBranch: async () => CONTRIBUTION_BRANCH,
				readHead: (cwd: string, signal?: AbortSignal) => git.head.sha(cwd, signal),
				readStatus: (cwd: string) => git.status(cwd, { porcelainV1: true, untrackedFiles: "all", z: true }),
				readRawCommitTree,
				isAncestor: (cwd: string, ancestor: string, descendant: string, signal?: AbortSignal) =>
					git.isAncestor(cwd, ancestor, descendant, signal),
				push: (cwd: string, options: { refspec: string; forceWithLease: string; signal?: AbortSignal }) =>
					git.push(cwd, {
						remote: `file://${remote.path()}`,
						refspec: options.refspec,
						forceWithLease: options.forceWithLease,
						signal: options.signal,
					}),
			} as ContributionPublicationGit & {
				readRawCommitTree(cwd: string, commit: string, signal?: AbortSignal): Promise<string | null>;
			};

			await expect(
				publishContributionCandidate({
					cwd: source.path(),
					remoteName: "origin",
					confirmedRemoteUrl: FORK_URL,
					confirmedPushRemoteUrl: FORK_URL,
					branchName: CONTRIBUTION_BRANCH,
					currentBranch: CONTRIBUTION_BRANCH,
					worktreeClean: true,
					goal,
					candidate,
					currentSegment: 2,
					currentHead: candidateSha,
					baseProof,
					approvedDraft: buildContributionPrDraft(
						goal,
						candidate,
						validateContributionForkRemote(FORK_URL),
						CONTRIBUTION_BRANCH,
						baseProof,
					),
					git: publicationGit,
					request: async () => ({ fork: true, parent: "can1357/oh-my-pi", source: "can1357/oh-my-pi" }),
				}),
			).rejects.toMatchObject({ code: "push_failed" });
			const remoteRef =
				await $`git --git-dir ${remote.path()} show-ref --verify --quiet refs/heads/${CONTRIBUTION_BRANCH}`
					.quiet()
					.nothrow();
			expect(await Bun.file(hookMarker).text()).toBe("rejected");
			expect(remoteRef.exitCode).not.toBe(0);
		} finally {
			source.removeSync();
			remote.removeSync();
		}
	});

	it("ignores replacement refs and legacy grafts for ancestry proof", async () => {
		const source = TempDir.createSync("@pi-contribution-ancestry-source-");
		try {
			await $`git -C ${source.path()} init -b main`.quiet();
			await Bun.write(`${source.path()}/proof.txt`, "base\n");
			await $`git -C ${source.path()} add proof.txt`.quiet();
			await $`git -C ${source.path()} -c user.name=OMP -c user.email=omp@example.invalid commit -m base`.quiet();
			const baseSha = (await $`git -C ${source.path()} rev-parse HEAD`.quiet()).text().trim();
			await $`git -C ${source.path()} checkout --orphan unrelated`.quiet();
			await $`git -C ${source.path()} rm -rf .`.quiet();
			await Bun.write(`${source.path()}/unrelated.txt`, "unrelated\n");
			await $`git -C ${source.path()} add unrelated.txt`.quiet();
			await $`git -C ${source.path()} -c user.name=OMP -c user.email=omp@example.invalid commit -m unrelated`.quiet();
			const unrelatedSha = (await $`git -C ${source.path()} rev-parse HEAD`.quiet()).text().trim();

			await $`git -C ${source.path()} replace --graft ${unrelatedSha} ${baseSha}`.quiet();
			expect(await git.isAncestor(source.path(), baseSha, unrelatedSha)).toBe(false);

			await $`git -C ${source.path()} replace -d ${unrelatedSha}`.quiet();
			await fs.promises.mkdir(`${source.path()}/.git/info`, { recursive: true });
			await Bun.write(`${source.path()}/.git/info/grafts`, `${unrelatedSha} ${baseSha}\n`);
			expect(await git.isAncestor(source.path(), baseSha, unrelatedSha)).toBe(false);
		} finally {
			source.removeSync();
		}
	});

	it("does not inspect legacy graft content before raw ancestry traversal", async () => {
		const source = TempDir.createSync("@pi-contribution-graft-read-");
		try {
			await $`git -C ${source.path()} init -b main`.quiet();
			await Bun.write(`${source.path()}/base.txt`, "base\n");
			await $`git -C ${source.path()} add base.txt`.quiet();
			await $`git -C ${source.path()} -c user.name=OMP -c user.email=omp@example.invalid commit -m base`.quiet();
			const baseSha = (await $`git -C ${source.path()} rev-parse HEAD`.quiet()).text().trim();
			await $`git -C ${source.path()} checkout --orphan unrelated`.quiet();
			await $`git -C ${source.path()} rm -rf .`.quiet();
			await Bun.write(`${source.path()}/unrelated.txt`, "unrelated\n");
			await $`git -C ${source.path()} add unrelated.txt`.quiet();
			await $`git -C ${source.path()} -c user.name=OMP -c user.email=omp@example.invalid commit -m unrelated`.quiet();
			const unrelatedSha = (await $`git -C ${source.path()} rev-parse HEAD`.quiet()).text().trim();
			const graftPath = `${source.path()}/.git/info/grafts`;
			const callBunFile = Bun.file as unknown as (input: unknown) => unknown;
			vi.spyOn(Bun, "file").mockImplementation(((input: unknown) => {
				if (String(input) !== graftPath) return callBunFile(input) as never;
				throw new Error("Legacy graft content was inspected before raw ancestry traversal.");
			}) as typeof Bun.file);

			await expect(git.isAncestor(source.path(), baseSha, unrelatedSha)).resolves.toBe(false);
		} finally {
			source.removeSync();
		}
	});

	it("rejects a worktree proof file above the 32 MiB materialization limit", async () => {
		const source = TempDir.createSync("@pi-contribution-tree-file-limit-");
		const tempsBefore = snapshotWorktreeTreeTemps();
		try {
			await $`git -C ${source.path()} init -b main`.quiet();
			await Bun.write(`${source.path()}/base.txt`, "base\n");
			await $`git -C ${source.path()} add base.txt`.quiet();
			await $`git -C ${source.path()} -c user.name=OMP -c user.email=omp@example.invalid commit -m base`.quiet();
			const oversizedPath = `${source.path()}/oversized.bin`;
			fs.closeSync(fs.openSync(oversizedPath, "w"));
			fs.truncateSync(oversizedPath, 32 * 1024 * 1024 + 1);

			await expect(git.writeWorktreeTree(source.path())).rejects.toThrow("32 MiB");
			expect(snapshotWorktreeTreeTemps()).toEqual(tempsBefore);
		} finally {
			source.removeSync();
		}
	});

	it("rejects worktree proof files above the 256 MiB aggregate materialization limit", async () => {
		const source = TempDir.createSync("@pi-contribution-tree-total-limit-");
		const tempsBefore = snapshotWorktreeTreeTemps();
		try {
			await $`git -C ${source.path()} init -b main`.quiet();
			await Bun.write(`${source.path()}/base.txt`, "base\n");
			await $`git -C ${source.path()} add base.txt`.quiet();
			await $`git -C ${source.path()} -c user.name=OMP -c user.email=omp@example.invalid commit -m base`.quiet();
			for (let index = 0; index < 9; index++) {
				const partPath = `${source.path()}/part-${index}.bin`;
				fs.closeSync(fs.openSync(partPath, "w"));
				fs.truncateSync(partPath, 32 * 1024 * 1024);
			}

			await expect(git.writeWorktreeTree(source.path())).rejects.toThrow("256 MiB");
			expect(snapshotWorktreeTreeTemps()).toEqual(tempsBefore);
		} finally {
			source.removeSync();
		}
	});

	it("rejects a worktree file that grows beyond 32 MiB after its snapshot stat", async () => {
		const source = TempDir.createSync("@pi-contribution-tree-file-growth-");
		const tempsBefore = snapshotWorktreeTreeTemps();
		try {
			await $`git -C ${source.path()} init -b main`.quiet();
			await Bun.write(`${source.path()}/base.txt`, "base\n");
			await $`git -C ${source.path()} add base.txt`.quiet();
			await $`git -C ${source.path()} -c user.name=OMP -c user.email=omp@example.invalid commit -m base`.quiet();
			const growingPath = `${source.path()}/growing.bin`;
			await Bun.write(growingPath, Buffer.alloc(1));
			const didGrow = growFileAfterSnapshotStat(growingPath, 32 * 1024 * 1024 + 1);

			const outcome = await git.writeWorktreeTree(source.path()).then(
				value => ({ value }),
				(error: unknown) => ({ error }),
			);

			expect(didGrow()).toBe(true);
			expect(outcome).toEqual({ error: expect.any(Error) });
			if (!("error" in outcome) || !(outcome.error instanceof Error)) throw new Error("Expected proof size error");
			expect(outcome.error.message).toContain("32 MiB");
			expect(snapshotWorktreeTreeTemps()).toEqual(tempsBefore);
		} finally {
			source.removeSync();
		}
	});

	it("counts bytes appended after stat toward the 256 MiB aggregate proof limit", async () => {
		const source = TempDir.createSync("@pi-contribution-tree-total-growth-");
		const tempsBefore = snapshotWorktreeTreeTemps();
		try {
			await $`git -C ${source.path()} init -b main`.quiet();
			await Bun.write(`${source.path()}/base.txt`, "base\n");
			await $`git -C ${source.path()} add base.txt`.quiet();
			await $`git -C ${source.path()} -c user.name=OMP -c user.email=omp@example.invalid commit -m base`.quiet();
			for (let index = 0; index < 8; index++) {
				const partPath = `${source.path()}/part-${index}.bin`;
				fs.closeSync(fs.openSync(partPath, "w"));
				fs.truncateSync(partPath, 31 * 1024 * 1024);
			}
			const growingPath = `${source.path()}/zz-growing.bin`;
			fs.closeSync(fs.openSync(growingPath, "w"));
			fs.truncateSync(growingPath, 1024 * 1024);
			const didGrow = growFileAfterSnapshotStat(growingPath, 16 * 1024 * 1024);

			const outcome = await git.writeWorktreeTree(source.path()).then(
				value => ({ value }),
				(error: unknown) => ({ error }),
			);

			expect(didGrow()).toBe(true);
			expect(outcome).toEqual({ error: expect.any(Error) });
			if (!("error" in outcome) || !(outcome.error instanceof Error)) throw new Error("Expected proof size error");
			expect(outcome.error.message).toContain("256 MiB");
			expect(snapshotWorktreeTreeTemps()).toEqual(tempsBefore);
		} finally {
			source.removeSync();
		}
	});

	it("isolates worktree snapshots from the real index and object database and removes every temporary artifact", async () => {
		const source = TempDir.createSync("@pi-contribution-tree-objects-");
		const expected = TempDir.createSync("@pi-contribution-tree-expected-");
		try {
			await $`git -C ${source.path()} init -b main`.quiet();
			await Bun.write(`${source.path()}/tracked.txt`, "baseline\n");
			await Bun.write(`${source.path()}/deleted.txt`, "deleted baseline\n");
			await $`git -C ${source.path()} add tracked.txt deleted.txt`.quiet();
			await $`git -C ${source.path()} -c user.name=OMP -c user.email=omp@example.invalid commit -m baseline`.quiet();
			await Bun.write(`${source.path()}/tracked.txt`, "staged user bytes\n");
			await $`git -C ${source.path()} add tracked.txt`.quiet();
			await Bun.write(`${source.path()}/tracked.txt`, "unstaged worktree bytes\n");
			await Bun.write(`${source.path()}/untracked.txt`, "untracked worktree bytes\n");
			await fs.promises.rm(`${source.path()}/deleted.txt`);
			await Bun.write(`${source.path()}/executable.sh`, "#!/bin/sh\necho raw\n");
			fs.chmodSync(`${source.path()}/executable.sh`, 0o755);
			fs.symlinkSync("tracked.txt", `${source.path()}/tracked-link`);
			await Bun.write(`${source.path()}/.gitignore`, "ignored.txt\n");
			await Bun.write(`${source.path()}/ignored.txt`, "must stay ignored\n");

			const indexPath = `${source.path()}/.git/index`;
			const objectDirectory = `${source.path()}/.git/objects`;
			const beforeIndex = fs.readFileSync(indexPath);
			const beforeIndexState = (await $`git -C ${source.path()} diff --cached --raw -z`.quiet()).arrayBuffer();
			const beforeObjects = snapshotFileSizes(objectDirectory);
			const beforeTemps = snapshotWorktreeTreeTemps();

			const tree = await git.writeWorktreeTree(source.path());

			expect(tree).toMatch(/^[0-9a-f]{40}$/);
			expect(fs.readFileSync(indexPath)).toEqual(beforeIndex);
			expect((await $`git -C ${source.path()} diff --cached --raw -z`.quiet()).arrayBuffer()).toEqual(
				beforeIndexState,
			);
			expect(snapshotFileSizes(objectDirectory)).toEqual(beforeObjects);
			expect(snapshotWorktreeTreeTemps()).toEqual(beforeTemps);

			const filterMarker = `${source.path()}/.git/snapshot-filter-ran`;
			const filterScript = `${source.path()}/.git/snapshot-filter.sh`;
			await Bun.write(`${source.path()}/.gitattributes`, "tracked.txt filter=snapshot-filter\n");
			await Bun.write(
				filterScript,
				`#!/bin/sh\nprintf invoked > ${JSON.stringify(filterMarker)}\nprintf transformed\n`,
			);
			fs.chmodSync(filterScript, 0o755);
			await $`git -C ${expected.path()} init -b main`.quiet();
			await Bun.write(`${expected.path()}/tracked.txt`, "unstaged worktree bytes\n");
			await Bun.write(`${expected.path()}/untracked.txt`, "untracked worktree bytes\n");
			await Bun.write(`${expected.path()}/executable.sh`, "#!/bin/sh\necho raw\n");
			fs.chmodSync(`${expected.path()}/executable.sh`, 0o755);
			fs.symlinkSync("tracked.txt", `${expected.path()}/tracked-link`);
			await Bun.write(`${expected.path()}/.gitignore`, "ignored.txt\n");
			await Bun.write(`${expected.path()}/ignored.txt`, "must stay ignored\n");
			await Bun.write(`${expected.path()}/.gitattributes`, "tracked.txt filter=snapshot-filter\n");
			await $`git -C ${expected.path()} add -A`.quiet();
			const expectedTree = (await $`git -C ${expected.path()} write-tree`.quiet()).text().trim();
			const rawTree = await git.writeWorktreeTree(source.path());
			expect(rawTree).toBe(expectedTree);
			await $`git -C ${source.path()} config filter.snapshot-filter.clean ${filterScript}`.quiet();
			await $`git -C ${source.path()} config filter.snapshot-filter.required true`.quiet();

			const configuredFilterTree = await git.writeWorktreeTree(source.path());

			expect(configuredFilterTree).toBe(rawTree);
			expect(fs.existsSync(filterMarker)).toBe(false);
			expect(fs.readFileSync(indexPath)).toEqual(beforeIndex);
			expect((await $`git -C ${source.path()} diff --cached --raw -z`.quiet()).arrayBuffer()).toEqual(
				beforeIndexState,
			);
			expect(snapshotFileSizes(objectDirectory)).toEqual(beforeObjects);
			expect(snapshotWorktreeTreeTemps()).toEqual(beforeTemps);
		} finally {
			source.removeSync();
			expected.removeSync();
		}
	});

	it("matches Git tree modes, parent symlink replacement, and invalid-cwd behavior without filters", async () => {
		const source = TempDir.createSync("@pi-contribution-tree-edge-");
		const external = TempDir.createSync("@pi-contribution-tree-external-");
		try {
			await $`git -C ${source.path()} init -b main`.quiet();
			await Bun.write(`${source.path()}/mode.txt`, "mode\n");
			await fs.promises.mkdir(`${source.path()}/nested`);
			await Bun.write(`${source.path()}/nested/file.txt`, "tracked\n");
			await $`git -C ${source.path()} add -A`.quiet();
			await $`git -C ${source.path()} -c user.name=OMP -c user.email=omp@example.invalid commit -m baseline`.quiet();

			fs.chmodSync(`${source.path()}/mode.txt`, 0o610);
			await fs.promises.rm(`${source.path()}/nested`, { recursive: true });
			await Bun.write(`${external.path()}/file.txt`, "external bytes must not be followed\n");
			fs.symlinkSync(external.path(), `${source.path()}/nested`);

			const tree = await git.writeWorktreeTree(source.path());
			await $`git -C ${source.path()} add -A`.quiet();
			const expectedTree = (await $`git -C ${source.path()} write-tree`.quiet()).text().trim();

			expect(tree).toBe(expectedTree);

			const missingCwd = `${source.path()}/missing-directory`;
			await expect(git.writeWorktreeTree(missingCwd)).rejects.toThrow();
		} finally {
			source.removeSync();
			external.removeSync();
		}
	});

	it("records the checked-out submodule commit in a filter-free worktree tree", async () => {
		const source = TempDir.createSync("@pi-contribution-tree-submodule-");
		const submodule = TempDir.createSync("@pi-contribution-tree-submodule-source-");
		try {
			await $`git -C ${submodule.path()} init -b main`.quiet();
			await Bun.write(`${submodule.path()}/value.txt`, "one\n");
			await $`git -C ${submodule.path()} add value.txt`.quiet();
			await $`git -C ${submodule.path()} -c user.name=OMP -c user.email=omp@example.invalid commit -m one`.quiet();
			await $`git -C ${source.path()} init -b main`.quiet();
			await $`git -C ${source.path()} -c protocol.file.allow=always submodule add ${submodule.path()} child`.quiet();
			await $`git -C ${source.path()} -c user.name=OMP -c user.email=omp@example.invalid commit -am baseline`.quiet();

			await Bun.write(`${submodule.path()}/value.txt`, "two\n");
			await $`git -C ${submodule.path()} add value.txt`.quiet();
			await $`git -C ${submodule.path()} -c user.name=OMP -c user.email=omp@example.invalid commit -m two`.quiet();
			const nextSubmoduleHead = (await $`git -C ${submodule.path()} rev-parse HEAD`.quiet()).text().trim();
			await $`git -C ${source.path()}/child -c protocol.file.allow=always fetch`.quiet();
			await $`git -C ${source.path()}/child checkout ${nextSubmoduleHead}`.quiet();

			const tree = await git.writeWorktreeTree(source.path());
			await $`git -C ${source.path()} add child`.quiet();
			const expectedTree = (await $`git -C ${source.path()} write-tree`.quiet()).text().trim();
			expect(tree).toBe(expectedTree);
		} finally {
			source.removeSync();
			submodule.removeSync();
		}
	});

	it("rejects a push-effective URL rewrite away from the confirmed fork", async () => {
		let pushCalls = 0;
		const publicationGit = {
			...makePublicationGit({
				push: async () => {
					pushCalls++;
				},
			}),
			readPushRemoteUrl: async () => "https://github.com/can1357/oh-my-pi.git",
		} as ContributionPublicationGit;
		await expectContributionError(
			publishContributionCandidate({
				cwd: "/work/repo",
				remoteName: "origin",
				confirmedRemoteUrl: FORK_URL,
				confirmedPushRemoteUrl: FORK_URL,
				branchName: CONTRIBUTION_BRANCH,
				currentBranch: CONTRIBUTION_BRANCH,
				worktreeClean: true,
				goal: makeGoal(),
				candidate: makeCandidate(),
				currentSegment: 2,
				currentHead: CURRENT_HEAD,
				baseProof: makeBaseProof(),
				approvedDraft: makeApprovedDraft(),
				git: publicationGit,
				request: async () => ({ fork: true, parent: "can1357/oh-my-pi", source: "can1357/oh-my-pi" }),
			}),
			"remote_official",
		);
		expect(pushCalls).toBe(0);
	});

	it("uses an explicit command-scoped pushurl that ignores pushInsteadOf", async () => {
		const source = TempDir.createSync("@pi-contribution-push-source-");
		const intended = TempDir.createSync("@pi-contribution-push-intended-");
		const redirected = TempDir.createSync("@pi-contribution-push-redirected-");
		try {
			const intendedUrl = `file://${intended.path()}`;
			const redirectedUrl = `file://${redirected.path()}`;
			await $`git init --bare ${intended.path()}`.quiet();
			await $`git init --bare ${redirected.path()}`.quiet();
			await $`git -C ${source.path()} init -b main`.quiet();
			await Bun.write(`${source.path()}/proof.txt`, "verified fork only\n");
			await $`git -C ${source.path()} add proof.txt`.quiet();
			await $`git -C ${source.path()} -c user.name=OMP -c user.email=omp@example.invalid commit -m proof`.quiet();
			await $`git -C ${source.path()} remote add origin ${intendedUrl}`.quiet();
			const rewriteKey = `url.${redirectedUrl}.pushInsteadOf`;
			await $`git -C ${source.path()} config ${rewriteKey} ${intendedUrl}`.quiet();

			await git.push(source.path(), {
				remote: "origin",
				verifiedRemoteUrl: intendedUrl,
				refspec: "HEAD:refs/heads/candidate",
			});

			const intendedRef = await $`git --git-dir ${intended.path()} show-ref --verify --quiet refs/heads/candidate`
				.quiet()
				.nothrow();
			const redirectedRef =
				await $`git --git-dir ${redirected.path()} show-ref --verify --quiet refs/heads/candidate`
					.quiet()
					.nothrow();
			expect(intendedRef.exitCode).toBe(0);
			expect(redirectedRef.exitCode).not.toBe(0);
		} finally {
			source.removeSync();
			intended.removeSync();
			redirected.removeSync();
		}
	});

	it("neutralizes insteadOf after resolving a pushInsteadOf destination", async () => {
		const source = TempDir.createSync("@pi-contribution-chain-source-");
		const intended = TempDir.createSync("@pi-contribution-chain-intended-");
		const redirected = TempDir.createSync("@pi-contribution-chain-redirected-");
		try {
			const confirmedUrl = "omp-confirmed://alice/oh-my-pi.git";
			const intendedUrl = `file://${intended.path()}`;
			const redirectedUrl = `file://${redirected.path()}`;
			await $`git init --bare ${intended.path()}`.quiet();
			await $`git init --bare ${redirected.path()}`.quiet();
			await $`git -C ${source.path()} init -b main`.quiet();
			await Bun.write(`${source.path()}/proof.txt`, "verified rewrite chain\n");
			await $`git -C ${source.path()} add proof.txt`.quiet();
			await $`git -C ${source.path()} -c user.name=OMP -c user.email=omp@example.invalid commit -m proof`.quiet();
			await $`git -C ${source.path()} remote add origin ${confirmedUrl}`.quiet();
			const pushRewriteKey = `url.${intendedUrl}.pushInsteadOf`;
			const fetchRewriteKey = `url.${redirectedUrl}.insteadOf`;
			await $`git -C ${source.path()} config ${pushRewriteKey} ${confirmedUrl}`.quiet();
			await $`git -C ${source.path()} config ${fetchRewriteKey} ${intendedUrl}`.quiet();
			await expect(git.remote.pushUrl(source.path(), "origin")).resolves.toBe(intendedUrl);

			await git.push(source.path(), {
				remote: "origin",
				verifiedRemoteUrl: intendedUrl,
				refspec: "HEAD:refs/heads/candidate",
			});

			const intendedRef = await $`git --git-dir ${intended.path()} show-ref --verify --quiet refs/heads/candidate`
				.quiet()
				.nothrow();
			const redirectedRef =
				await $`git --git-dir ${redirected.path()} show-ref --verify --quiet refs/heads/candidate`
					.quiet()
					.nothrow();
			expect(intendedRef.exitCode).toBe(0);
			expect(redirectedRef.exitCode).not.toBe(0);
		} finally {
			source.removeSync();
			intended.removeSync();
			redirected.removeSync();
		}
	});

	it("rechecks frozen-base ancestry immediately before push", async () => {
		const calls: string[] = [];
		await expectContributionError(
			publishContributionCandidate({
				cwd: "/work/repo",
				remoteName: "origin",
				confirmedRemoteUrl: FORK_URL,
				confirmedPushRemoteUrl: FORK_URL,
				branchName: CONTRIBUTION_BRANCH,
				currentBranch: CONTRIBUTION_BRANCH,
				worktreeClean: true,
				goal: makeGoal(),
				candidate: makeCandidate(),
				currentSegment: 2,
				currentHead: CURRENT_HEAD,
				baseProof: makeBaseProof(),
				approvedDraft: makeApprovedDraft(),
				git: makePublicationGit({
					isAncestor: async (_cwd, ancestor, descendant) => {
						calls.push(`ancestor:${ancestor}:${descendant}`);
						return false;
					},
					push: async () => {
						calls.push("push");
					},
				}),
				request: async () => ({ fork: true, parent: "can1357/oh-my-pi", source: "can1357/oh-my-pi" }),
			}),
			"candidate_not_descendant",
		);
		expect(calls).toEqual([`ancestor:${COMMIT_SHA}:${CURRENT_HEAD}`]);
	});

	it("rejects HEAD or clean-worktree drift during final ancestry before immutable-SHA push", async () => {
		for (const drift of ["HEAD", "worktree"] as const) {
			let currentHead = CURRENT_HEAD;
			let statusOutput = "";
			let firstHeadRead = false;
			let pushCalls = 0;
			const git = makePublicationGit({
				readHead: async () => {
					firstHeadRead = true;
					return currentHead;
				},
				readStatus: async () => statusOutput,
				isAncestor: async () => {
					if (!firstHeadRead) throw new Error("Expected candidate HEAD validation before ancestry");
					await Promise.resolve();
					if (drift === "HEAD") currentHead = "9".repeat(40);
					else statusOutput = " M changed-during-ancestry.ts\0";
					return true;
				},
				push: async () => {
					pushCalls++;
				},
			});
			const outcome = await publishContributionCandidate({
				cwd: "/work/repo",
				remoteName: "origin",
				confirmedRemoteUrl: FORK_URL,
				confirmedPushRemoteUrl: FORK_URL,
				branchName: CONTRIBUTION_BRANCH,
				currentBranch: CONTRIBUTION_BRANCH,
				worktreeClean: true,
				goal: makeGoal(),
				candidate: makeCandidate(),
				currentSegment: 2,
				currentHead: CURRENT_HEAD,
				baseProof: makeBaseProof(),
				approvedDraft: makeApprovedDraft(),
				git,
				request: async () => ({ fork: true, parent: "can1357/oh-my-pi", source: "can1357/oh-my-pi" }),
			}).then(
				() => ({ rejectionCode: undefined }),
				(error: unknown) => ({ rejectionCode: contributionErrorCode(error) }),
			);

			expect({ pushCalls, rejectionCode: outcome.rejectionCode }, drift).toEqual({
				pushCalls: 0,
				rejectionCode: drift === "HEAD" ? "candidate_head_mismatch" : "worktree_dirty",
			});
		}
	});

	it("refuses branch, HEAD, or worktree drift after exact draft approval", async () => {
		const cases: Array<{
			name: string;
			code: ContributionErrorCode;
			git: Partial<ContributionPublicationGit>;
		}> = [
			{ name: "branch", code: "branch_mismatch", git: { readBranch: async () => "main" } },
			{ name: "HEAD", code: "candidate_head_mismatch", git: { readHead: async () => "9".repeat(40) } },
			{ name: "worktree", code: "worktree_dirty", git: { readStatus: async () => " M changed.ts\0" } },
		];
		for (const testCase of cases) {
			let pushCalls = 0;
			await expectContributionError(
				publishContributionCandidate({
					cwd: "/work/repo",
					remoteName: "origin",
					confirmedRemoteUrl: FORK_URL,
					confirmedPushRemoteUrl: FORK_URL,
					branchName: CONTRIBUTION_BRANCH,
					currentBranch: CONTRIBUTION_BRANCH,
					worktreeClean: true,
					goal: makeGoal(),
					candidate: makeCandidate(),
					currentSegment: 2,
					currentHead: CURRENT_HEAD,
					baseProof: makeBaseProof(),
					approvedDraft: makeApprovedDraft(),
					git: makePublicationGit({
						...testCase.git,
						push: async () => {
							pushCalls++;
						},
					}),
					request: async () => ({ fork: true, parent: "can1357/oh-my-pi", source: "can1357/oh-my-pi" }),
				}),
				testCase.code,
			);
			expect(pushCalls, testCase.name).toBe(0);
		}
	});

	it("publishes a refreshed segment goal while preserving immutable start provenance", async () => {
		const refreshedGoal = makeGoal({
			commitSha: "6".repeat(40),
			blobSha: "7".repeat(40),
			title: "Refreshed official goal",
			content: "# Refreshed official goal\n\nNew segment direction.\n",
		});
		const candidate = makeCandidate();
		const baseProof = makeBaseProof();
		const remote = validateContributionForkRemote(FORK_URL);
		const approvedDraft = buildContributionPrDraft(refreshedGoal, candidate, remote, CONTRIBUTION_BRANCH, baseProof);
		let pushed = false;
		const published = await publishContributionCandidate({
			cwd: "/work/repo",
			remoteName: "origin",
			confirmedRemoteUrl: FORK_URL,
			confirmedPushRemoteUrl: FORK_URL,
			branchName: CONTRIBUTION_BRANCH,
			currentBranch: CONTRIBUTION_BRANCH,
			worktreeClean: true,
			goal: refreshedGoal,
			candidate,
			currentSegment: 2,
			currentHead: CURRENT_HEAD,
			baseProof,
			approvedDraft,
			git: makePublicationGit({
				push: async () => {
					pushed = true;
				},
			}),
			request: async () => ({ fork: true, parent: "can1357/oh-my-pi", source: "can1357/oh-my-pi" }),
		});

		expect(pushed).toBe(true);
		expect(published.prDraft).toMatchObject({
			baseSha: COMMIT_SHA,
			initialGoalCommitSha: COMMIT_SHA,
			goalCommitSha: refreshedGoal.commitSha,
			goalBlobSha: refreshedGoal.blobSha,
			goalSha256: refreshedGoal.sha256,
		});
	});

	it("refuses a changed remote before metadata verification or push", async () => {
		let requestCalls = 0;
		let pushCalls = 0;
		const git = makePublicationGit({
			readRemoteUrl: async () => "git@github.com:mallory/oh-my-pi.git",
			push: async () => {
				pushCalls++;
			},
		});
		await expectContributionError(
			publishContributionCandidate({
				cwd: "/work/repo",
				remoteName: "origin",
				confirmedRemoteUrl: FORK_URL,
				confirmedPushRemoteUrl: FORK_URL,
				branchName: CONTRIBUTION_BRANCH,
				currentBranch: CONTRIBUTION_BRANCH,
				worktreeClean: true,
				goal: makeGoal(),
				candidate: makeCandidate(),
				currentSegment: 2,
				currentHead: CURRENT_HEAD,
				git,
				request: async () => {
					requestCalls++;
					return { fork: true, parent: "can1357/oh-my-pi", source: "can1357/oh-my-pi" };
				},
				baseProof: makeBaseProof(),
				approvedDraft: makeApprovedDraft(),
			}),
			"remote_changed",
		);
		expect(requestCalls).toBe(0);
		expect(pushCalls).toBe(0);
	});

	it("refuses an upstream push even when the confirmed and current URLs match", async () => {
		const upstreamUrl = "https://github.com/can1357/oh-my-pi.git";
		let pushCalls = 0;
		await expectContributionError(
			publishContributionCandidate({
				cwd: "/work/repo",
				remoteName: "upstream",
				confirmedRemoteUrl: upstreamUrl,
				confirmedPushRemoteUrl: upstreamUrl,
				branchName: CONTRIBUTION_BRANCH,
				currentBranch: CONTRIBUTION_BRANCH,
				worktreeClean: true,
				goal: makeGoal(),
				candidate: makeCandidate(),
				currentSegment: 2,
				currentHead: CURRENT_HEAD,
				git: makePublicationGit({
					readRemoteUrl: async () => upstreamUrl,
					push: async () => {
						pushCalls++;
					},
				}),
				request: async () => ({ fork: false, parent: null, source: null }),
				baseProof: makeBaseProof(),
				approvedDraft: makeApprovedDraft(),
			}),
			"remote_official",
		);
		expect(pushCalls).toBe(0);
	});

	it("blocks mismatched HEAD, branch, dirty tree, and invalid current-segment candidates before push", async () => {
		const cases: Array<{
			name: string;
			code: ContributionErrorCode;
			overrides: Record<string, unknown>;
		}> = [
			{ name: "head", code: "candidate_head_mismatch", overrides: { currentHead: "9".repeat(40) } },
			{ name: "branch", code: "branch_mismatch", overrides: { currentBranch: "main" } },
			{ name: "dirty", code: "worktree_dirty", overrides: { worktreeClean: false } },
			{ name: "flagged", code: "candidate_invalid", overrides: { candidate: makeCandidate({ flagged: true }) } },
			{ name: "old segment", code: "candidate_invalid", overrides: { candidate: makeCandidate({ segment: 1 }) } },
		];
		for (const testCase of cases) {
			let pushCalls = 0;
			const candidate = (testCase.overrides.candidate as ContributionCandidate | undefined) ?? makeCandidate();
			const goal = makeGoal();
			const baseProof = makeBaseProof();
			const options = {
				cwd: "/work/repo",
				remoteName: "origin",
				confirmedRemoteUrl: FORK_URL,
				confirmedPushRemoteUrl: FORK_URL,
				branchName: CONTRIBUTION_BRANCH,
				currentBranch: CONTRIBUTION_BRANCH,
				worktreeClean: true,
				goal,
				candidate,
				currentSegment: 2,
				currentHead: CURRENT_HEAD,
				git: makePublicationGit({
					push: async () => {
						pushCalls++;
					},
				}),
				request: async () => ({ fork: true, parent: "can1357/oh-my-pi", source: "can1357/oh-my-pi" }),
				...testCase.overrides,
				baseProof,
				approvedDraft: buildContributionPrDraft(
					goal,
					makeCandidate(),
					validateContributionForkRemote(FORK_URL),
					CONTRIBUTION_BRANCH,
					baseProof,
				),
			};
			await expectContributionError(publishContributionCandidate(options as never), testCase.code);
			expect(pushCalls, testCase.name).toBe(0);
		}
	});

	it("requires verified official ancestry before push", async () => {
		let pushCalls = 0;
		await expectContributionError(
			publishContributionCandidate({
				cwd: "/work/repo",
				remoteName: "origin",
				confirmedRemoteUrl: FORK_URL,
				confirmedPushRemoteUrl: FORK_URL,
				branchName: CONTRIBUTION_BRANCH,
				currentBranch: CONTRIBUTION_BRANCH,
				worktreeClean: true,
				goal: makeGoal(),
				candidate: makeCandidate(),
				currentSegment: 2,
				currentHead: CURRENT_HEAD,
				git: makePublicationGit({
					push: async () => {
						pushCalls++;
					},
				}),
				request: async () => ({ fork: true, parent: "someone/other", source: "someone/other" }),
				baseProof: makeBaseProof(),
				approvedDraft: makeApprovedDraft(),
			}),
			"remote_not_fork",
		);
		expect(pushCalls).toBe(0);
	});

	it("refuses final approval when either frozen provenance chain or the candidate differs", async () => {
		const approvedDraft = makeApprovedDraft();
		const mismatches: ContributionPrDraft[] = [
			{ ...approvedDraft, initialGoalCommitSha: "9".repeat(40) },
			{ ...approvedDraft, goalBlobSha: "9".repeat(40) },
			{ ...approvedDraft, candidateHead: "9".repeat(40) },
		];
		for (const mismatchedDraft of mismatches) {
			let readCalls = 0;
			let pushCalls = 0;
			await expectContributionError(
				publishContributionCandidate({
					cwd: "/work/repo",
					remoteName: "origin",
					confirmedRemoteUrl: FORK_URL,
					confirmedPushRemoteUrl: FORK_URL,
					branchName: CONTRIBUTION_BRANCH,
					currentBranch: CONTRIBUTION_BRANCH,
					worktreeClean: true,
					goal: makeGoal(),
					candidate: makeCandidate(),
					currentSegment: 2,
					currentHead: CURRENT_HEAD,
					baseProof: makeBaseProof(),
					approvedDraft: mismatchedDraft,
					git: makePublicationGit({
						readRemoteUrl: async () => {
							readCalls++;
							return FORK_URL;
						},
						push: async () => {
							pushCalls++;
						},
					}),
					request: async () => ({ fork: true, parent: "can1357/oh-my-pi", source: "can1357/oh-my-pi" }),
				}),
				"approval_mismatch",
			);
			expect(readCalls).toBe(0);
			expect(pushCalls).toBe(0);
		}
	});
});

interface IntegrationGoalVersion {
	commitSha: string;
	treeSha: string;
	blobSha: string;
	content: string;
}

interface InitContributionDetails {
	createdSession: boolean;
	bumpedSegment: boolean;
	state: {
		branch: string | null;
		currentSegment: number;
		goal: string | null;
		maxExperiments: number | null;
	};
}

interface IntegrationHarnessOptions {
	confirmAnswers?: boolean[];
	selectedModelId?: string;
	models?: Model<Api>[];
	currentModel?: Model<Api>;
	goalVersions?: IntegrationGoalVersion[];
	setModelResults?: boolean[];
	setModelFailureAt?: number;
	setActiveToolsFailureAt?: number;
	checkoutFailure?: Error;
	rollbackCheckoutFailure?: Error;
	branchDeleteFailure?: Error;
	onGoalRefRequest?(signal?: AbortSignal): void | Promise<void>;
	onConfirm?(callNumber: number, title: string, signal?: AbortSignal): void | Promise<void>;
	onSetModel?(callNumber: number): void | Promise<void>;
	onCheckoutNewAt?(callNumber: number): void | Promise<void>;
	onSetActiveTools?(callNumber: number, names: readonly string[]): void | Promise<void>;
	onSetWidget?(value: unknown): void;
	onForkMetadataRequest?(callNumber: number, signal?: AbortSignal): void | Promise<void>;
	onAncestryRequest?(callNumber: number, signal?: AbortSignal): void | Promise<void>;
	statusText?: string;
	headSha?: string;
	hasPendingMessages?: boolean;
	initialTools?: string[];
	sessionId?: string;
	refExistsResults?: boolean[];
	ancestryResults?: boolean[];
	publishedRefSha?: string;
	flushFailureAt?: number;
	sessionFile?: string | null;
}

interface CapturedNotification {
	message: string;
	type: "info" | "warning" | "error" | undefined;
}

interface CapturedSendMessage {
	message: unknown;
	options: unknown;
}

interface IntegrationHarness {
	api: ExtensionAPI;
	ctx: ExtensionCommandContext;
	commands: Map<string, RegisteredCommand>;
	tools: Map<string, ToolDefinition>;
	handlers: Map<string, ExtensionHandler<unknown, unknown>>;
	activeTools: string[];
	appendEntries: Array<{ customType: string; data: unknown }>;
	confirmCalls: Array<{ title: string; message: string }>;
	selectCalls: Array<{ title: string; labels: string[] }>;
	notifications: CapturedNotification[];
	sentUserMessages: string[];
	sentMessages: CapturedSendMessage[];
	setModelCalls: Model<Api>[];
	setActiveToolsCalls: string[][];
	checkoutNewCalls: string[];
	checkoutCalls: string[];
	deletedBranches: string[];
	githubEndpoints: string[];
	githubArgumentVectors: string[][];
	gitEvents: string[];
	flushRequests: Array<{ durable?: boolean } | undefined>;
	pushes: Array<{
		remote?: string;
		verifiedRemoteUrl?: string;
		refspec?: string;
		forceWithLease?: boolean | string;
	}>;
	approvalModeMutations: string[];
	readonly widgetUpdates: number;
	widgetValues: unknown[];
	setPendingMessages(value: boolean): void;
	setStatusText(value: string): void;
	setHeadSha(value: string): void;
	setRefOccupied(value: boolean): void;
	setNextStatusRequest(callback: (signal?: AbortSignal) => void | Promise<void>): void;
	setSessionId(value: string): void;
	setActiveToolState(names: string[]): void;
	setCurrentBranch(value: string): void;
	setCurrentModel(value: Model<Api>): void;
	setSessionBranch(entries: unknown[]): void;
	currentBranch(): string;
	currentModel(): Model<Api> | undefined;
}

function requiredBundledModel(provider: GeneratedProvider, id: string): Model<Api> {
	const model = getBundledModel(provider, id);
	if (!model) throw new Error(`Expected bundled model ${provider}/${id}`);
	return model;
}

function optionLabel(option: string | { label: string }): string {
	return typeof option === "string" ? option : option.label;
}

function defaultGoalVersions(): IntegrationGoalVersion[] {
	const initial = { commitSha: COMMIT_SHA, treeSha: TREE_SHA, blobSha: BLOB_SHA, content: GOAL_CONTENT };
	return [
		initial,
		{ ...initial },
		{
			commitSha: "6".repeat(40),
			treeSha: "7".repeat(40),
			blobSha: "8".repeat(40),
			content: "# Refreshed official goal\n\nNew segment direction.\n",
		},
	];
}

function createIntegrationHarness(cwd: string, options: IntegrationHarnessOptions = {}): IntegrationHarness {
	const commands = new Map<string, RegisteredCommand>();
	const tools = new Map<string, ToolDefinition>();
	const handlers = new Map<string, ExtensionHandler<unknown, unknown>>();
	const activeTools = [...(options.initialTools ?? ["read", "bash"])];
	const appendEntries: Array<{ customType: string; data: unknown }> = [];
	const confirmCalls: Array<{ title: string; message: string }> = [];
	const selectCalls: Array<{ title: string; labels: string[] }> = [];
	const notifications: CapturedNotification[] = [];
	const widgetValues: unknown[] = [];
	const sentUserMessages: string[] = [];
	const sentMessages: CapturedSendMessage[] = [];
	const setModelCalls: Model<Api>[] = [];
	const setActiveToolsCalls: string[][] = [];
	const checkoutNewCalls: string[] = [];
	const checkoutCalls: string[] = [];
	const deletedBranches: string[] = [];
	const githubEndpoints: string[] = [];
	const githubArgumentVectors: string[][] = [];
	const gitEvents: string[] = [];
	const flushRequests: Array<{ durable?: boolean } | undefined> = [];
	const pushes: Array<{
		remote?: string;
		verifiedRemoteUrl?: string;
		refspec?: string;
		forceWithLease?: boolean | string;
	}> = [];
	const approvalModeMutations: string[] = [];
	let widgetUpdates = 0;
	const confirmAnswers = [...(options.confirmAnswers ?? [true, true])];
	const setModelResults = [...(options.setModelResults ?? [])];
	const models = options.models ?? [
		requiredBundledModel("anthropic", "claude-sonnet-4-5"),
		requiredBundledModel("anthropic", "claude-sonnet-4-6"),
	];
	let selectedModel = options.currentModel ?? models[0];
	let pendingMessages = options.hasPendingMessages ?? false;
	let statusText = options.statusText ?? "";
	let headSha = options.headSha ?? COMMIT_SHA;
	let currentBranch = "main";
	let refOccupied = false;
	const refExistsResults = [...(options.refExistsResults ?? [])];
	const ancestryResults = [...(options.ancestryResults ?? [])];
	let nextStatusRequest: ((signal?: AbortSignal) => void | Promise<void>) | null = null;
	let sessionId = options.sessionId ?? "contribution-session";
	let sessionBranch: unknown[] = [];
	let setActiveToolsCallCount = 0;
	let flushCallCount = 0;
	const goals = options.goalVersions ?? defaultGoalVersions();
	let activeGoal = goals[0];
	let goalLoadCount = 0;
	let forkMetadataRequestCount = 0;
	let ancestryRequestCount = 0;

	const realWriteWorktreeTree = git.writeWorktreeTree;
	const realWriteTree = git.writeTree;
	const realRawCommit = git.rawCommit;
	const realCommit = git.commit;
	const realHeadSha = git.head.sha;
	vi.spyOn(git, "writeWorktreeTree").mockImplementation(async (workDir, signal) =>
		fs.existsSync(`${workDir}/.git`) ? realWriteWorktreeTree(workDir, signal) : CANDIDATE_TREE_SHA,
	);
	vi.spyOn(git, "writeTree").mockImplementation(async (workDir, writeOptions) =>
		fs.existsSync(`${workDir}/.git`) ? realWriteTree(workDir, writeOptions) : CANDIDATE_TREE_SHA,
	);
	vi.spyOn(git, "rawCommit").mockImplementation(async (workDir, commit, signal) => {
		if (commit !== COMMIT_SHA && commit !== CURRENT_HEAD) return realRawCommit(workDir, commit, signal);
		const treeSha = fs.existsSync(`${workDir}/.git`)
			? await realWriteWorktreeTree(workDir, signal)
			: CANDIDATE_TREE_SHA;
		return { treeSha, parentShas: [COMMIT_SHA] };
	});
	vi.spyOn(git.repo, "root").mockResolvedValue(cwd);
	vi.spyOn(git.show, "prefix").mockResolvedValue("");
	const statusMock = Object.assign(
		async (...args: Parameters<typeof git.status>) => {
			const callback = nextStatusRequest;
			const response = statusText;
			nextStatusRequest = null;
			await callback?.(args[1]?.signal);
			gitEvents.push(`status:${response}`);
			return response;
		},
		{ parse: git.status.parse, summary: git.status.summary },
	);
	vi.spyOn(git, "status").mockImplementation(statusMock);
	vi.spyOn(git.head, "sha").mockImplementation(async () => {
		gitEvents.push(`head:${headSha}`);
		return headSha;
	});
	vi.spyOn(git, "commit").mockImplementation(async (workDir, message, commitOptions) => {
		const result = await realCommit(workDir, message, commitOptions);
		if (fs.existsSync(`${workDir}/.git`)) headSha = (await realHeadSha(workDir, commitOptions?.signal)) ?? headSha;
		return result;
	});
	vi.spyOn(git.branch, "current").mockImplementation(async () => currentBranch);
	vi.spyOn(git, "isAncestor").mockImplementation(async (_workDir, ancestor, descendant, signal) => {
		ancestryRequestCount++;
		await options.onAncestryRequest?.(ancestryRequestCount, signal);
		gitEvents.push(`ancestor:${ancestor}:${descendant}`);
		return ancestryResults.shift() ?? true;
	});
	vi.spyOn(git.ref, "exists").mockImplementation(async (_workDir, ref) => {
		gitEvents.push(`exists:${ref}`);
		return refExistsResults.shift() ?? refOccupied;
	});
	vi.spyOn(git.branch, "checkoutNew").mockImplementation(async (_workDir, branch) => {
		checkoutNewCalls.push(branch);
		gitEvents.push(`checkoutNew:${branch}`);
		if (options.checkoutFailure) throw options.checkoutFailure;
		currentBranch = branch;
	});
	vi.spyOn(git.branch, "checkoutNewAt").mockImplementation(async (_workDir, branch, startPoint) => {
		checkoutNewCalls.push(branch);
		gitEvents.push(`checkoutNewAt:${branch}:${startPoint}`);
		await options.onCheckoutNewAt?.(checkoutNewCalls.length);
		if (options.checkoutFailure) throw options.checkoutFailure;
		currentBranch = branch;
	});
	vi.spyOn(git, "checkout").mockImplementation(async (_workDir, branch) => {
		checkoutCalls.push(branch);
		gitEvents.push(`checkout:${branch}`);
		if (options.rollbackCheckoutFailure) throw options.rollbackCheckoutFailure;
		currentBranch = branch;
	});
	vi.spyOn(git.branch, "delete").mockImplementation(async (_workDir, branch) => {
		deletedBranches.push(branch);
		gitEvents.push(`delete:${branch}`);
		if (options.branchDeleteFailure) throw options.branchDeleteFailure;
	});
	vi.spyOn(git.remote, "list").mockResolvedValue(["origin", "upstream"]);
	vi.spyOn(git.remote, "url").mockImplementation(async (_workDir, remote) =>
		remote === "origin" ? FORK_URL : "https://github.com/can1357/oh-my-pi.git",
	);
	vi.spyOn(git.remote, "pushUrl").mockImplementation(async (_workDir, remote) =>
		remote === "origin" ? FORK_URL : "https://github.com/can1357/oh-my-pi.git",
	);
	vi.spyOn(git, "push").mockImplementation(async (_workDir, pushOptions) => {
		gitEvents.push("push");
		pushes.push({
			remote: pushOptions?.remote,
			verifiedRemoteUrl: pushOptions?.verifiedRemoteUrl,
			refspec: pushOptions?.refspec,
			forceWithLease: pushOptions?.forceWithLease,
		});
	});
	vi.spyOn(git.github, "json").mockImplementation(async (_workDir, args, signal) => {
		githubArgumentVectors.push([...args]);
		const endpoint = args.find(arg => arg.startsWith("/repos/"));
		if (!endpoint) throw new Error(`Missing GitHub API endpoint in ${args.join(" ")}`);
		githubEndpoints.push(endpoint);
		if (endpoint.startsWith("/repos/alice/oh-my-pi/git/ref/heads/")) {
			return { sha: options.publishedRefSha ?? CURRENT_HEAD, type: "commit" } as never;
		}
		if (endpoint === "/repos/alice/oh-my-pi") {
			forkMetadataRequestCount++;
			await options.onForkMetadataRequest?.(forkMetadataRequestCount, signal);
			return { fork: true, parent: "can1357/oh-my-pi", source: "can1357/oh-my-pi" } as never;
		}
		if (endpoint.includes("/git/ref/heads/")) {
			await options.onGoalRefRequest?.(signal);
			activeGoal = goals[Math.min(goalLoadCount, goals.length - 1)] ?? goals[0];
			goalLoadCount++;
			return { sha: activeGoal.commitSha, type: "commit" } as never;
		}
		if (endpoint.includes("/git/commits/")) {
			return { sha: activeGoal.commitSha, treeSha: activeGoal.treeSha } as never;
		}
		if (endpoint.includes("/git/trees/")) {
			return {
				truncated: false,
				entries: [
					{
						path: OFFICIAL_CONTRIBUTION_GOAL_PATH,
						type: "blob",
						sha: activeGoal.blobSha,
						size: Buffer.byteLength(activeGoal.content),
					},
				],
			} as never;
		}
		if (endpoint.includes("/git/blobs/")) {
			return {
				sha: activeGoal.blobSha,
				size: Buffer.byteLength(activeGoal.content),
				encoding: "base64",
				content: Buffer.from(activeGoal.content).toString("base64"),
			} as never;
		}
		throw new Error(`Unexpected GitHub API endpoint ${endpoint}`);
	});

	const api = {
		appendEntry(customType: string, data?: unknown): void {
			appendEntries.push({ customType, data });
			if (
				customType === "autoresearch-contribution-publication" &&
				data !== null &&
				typeof data === "object" &&
				"phase" in data &&
				data.phase === "intent"
			) {
				gitEvents.push("append:intent");
			}
		},
		exec: async () => ({ code: 0, stderr: "", stdout: "" }),
		getActiveTools: () => [...activeTools],
		getAllTools: () => [...activeTools, ...tools.keys()],
		getCommands: () => [],
		getSessionName: () => undefined,
		getThinkingLevel: () => undefined,
		on(event: string, handler: ExtensionHandler<unknown, unknown>): void {
			handlers.set(event, handler);
		},
		registerCommand(name: string, command: Omit<RegisteredCommand, "name">): void {
			commands.set(name, { name, ...command });
		},
		registerShortcut(): void {},
		registerTool(tool: ToolDefinition): void {
			tools.set(tool.name, tool);
		},
		sendMessage(message: unknown, sendOptions?: unknown): void {
			sentMessages.push({ message, options: sendOptions });
		},
		sendUserMessage(content: string | unknown[]): void {
			if (typeof content !== "string") throw new Error("Expected contribution turn to use plain text");
			sentUserMessages.push(content);
		},
		setActiveTools: async (names: string[]): Promise<void> => {
			setActiveToolsCallCount++;
			setActiveToolsCalls.push([...names]);
			await options.onSetActiveTools?.(setActiveToolsCallCount, names);
			if (options.setActiveToolsFailureAt === setActiveToolsCallCount) throw new Error("setActiveTools failed");
			activeTools.splice(0, activeTools.length, ...names);
			gitEvents.push(`tools:${names.join(",")}`);
		},
		setModel: async (model: Model<Api>): Promise<boolean> => {
			setModelCalls.push(model);
			await options.onSetModel?.(setModelCalls.length);
			if (options.setModelFailureAt === setModelCalls.length) {
				selectedModel = model;
				throw new Error("setModel synchronization failed");
			}
			const accepted = setModelResults.shift() ?? true;
			if (accepted) {
				selectedModel = model;
				gitEvents.push(`model:${model.provider}/${model.id}`);
			}
			return accepted;
		},
		setSessionName: async () => {},
		setThinkingLevel(): void {},
		setApprovalMode(mode: string): void {
			approvalModeMutations.push(mode);
		},
	} as unknown as ExtensionAPI;
	createAutoresearchExtension(api);

	const ctx = {
		abort(): void {},
		branch: async () => ({ cancelled: false }),
		compact: async () => {},
		cwd,
		get model(): Model<Api> | undefined {
			return selectedModel;
		},
		models: {
			list: () => [...models],
			current: () => selectedModel,
			resolve: (spec: string) => models.find(model => `${model.provider}/${model.id}` === spec || model.id === spec),
			family: (model: Model<Api>) => model.provider,
		},
		getContextUsage: () => undefined,
		getSystemPrompt: () => [],
		hasPendingMessages: () => pendingMessages,
		hasUI: true,
		isIdle: () => true,
		modelRegistry: {},
		navigateTree: async () => ({ cancelled: false }),
		newSession: async () => ({ cancelled: false }),
		reload: async () => {},
		sessionManager: {
			getBranch: () => sessionBranch as never,
			getEntries: () => [],
			getSessionId: () => sessionId,
			flush: async (flushOptions?: { durable?: boolean }): Promise<void> => {
				flushCallCount++;
				flushRequests.push(flushOptions);
				gitEvents.push(`flush:${flushOptions?.durable === true ? "durable" : "ordinary"}`);
				if (options.flushFailureAt === flushCallCount) throw new Error("session persistence failed");
			},
			getSessionFile: () => (options.sessionFile === null ? undefined : (options.sessionFile ?? "/tmp/omp.jsonl")),
		},
		shutdown(): void {},
		switchSession: async () => ({ cancelled: false }),
		ui: {
			confirm: async (title: string, message: string, dialogOptions?: { signal?: AbortSignal }) => {
				confirmCalls.push({ title, message });
				gitEvents.push(`confirm:${confirmCalls.length}`);
				await options.onConfirm?.(confirmCalls.length, title, dialogOptions?.signal);
				return confirmAnswers.shift() ?? false;
			},
			custom: async () => undefined,
			input: async () => undefined,
			notify(message: string, type?: "info" | "warning" | "error"): void {
				notifications.push({ message, type });
			},
			onTerminalInput: () => () => {},
			select: async (title: string, choices: Array<string | { label: string }>) => {
				const labels = choices.map(optionLabel);
				selectCalls.push({ title, labels });
				const requested = options.selectedModelId ?? selectedModel?.id;
				return labels.find(label => (requested ? label.includes(requested) : false)) ?? labels[0];
			},
			setFooter(): void {},
			setHeader(): void {},
			setStatus(): void {},
			setTitle(): void {},
			setWidget(_id: string, value: unknown): void {
				widgetUpdates++;
				widgetValues.push(value);
				options.onSetWidget?.(value);
			},
			setWorkingMessage(): void {},
		},
		waitForIdle: async () => {},
	} as unknown as ExtensionCommandContext;

	return {
		api,
		ctx,
		commands,
		tools,
		handlers,
		activeTools,
		appendEntries,
		confirmCalls,
		selectCalls,
		notifications,
		sentUserMessages,
		sentMessages,
		setModelCalls,
		setActiveToolsCalls,
		checkoutNewCalls,
		checkoutCalls,
		deletedBranches,
		githubEndpoints,
		githubArgumentVectors,
		gitEvents,
		pushes,
		flushRequests,
		approvalModeMutations,
		widgetValues,
		get widgetUpdates(): number {
			return widgetUpdates;
		},
		setPendingMessages(value: boolean): void {
			pendingMessages = value;
		},
		setStatusText(value: string): void {
			statusText = value;
		},
		setHeadSha(value: string): void {
			headSha = value;
		},
		setRefOccupied(value: boolean): void {
			refOccupied = value;
		},
		setNextStatusRequest(callback: (signal?: AbortSignal) => void | Promise<void>): void {
			nextStatusRequest = callback;
		},
		setSessionId(value: string): void {
			sessionId = value;
		},
		currentBranch: () => currentBranch,
		currentModel: () => selectedModel,
		setActiveToolState(names: string[]): void {
			activeTools.splice(0, activeTools.length, ...names);
		},
		setCurrentBranch(value: string): void {
			currentBranch = value;
		},
		setCurrentModel(value: Model<Api>): void {
			selectedModel = value;
		},
		setSessionBranch(entries: unknown[]): void {
			sessionBranch = entries;
		},
	};
}

function commandRequired(harness: IntegrationHarness, name: string): RegisteredCommand {
	const command = harness.commands.get(name);
	if (!command) throw new Error(`Expected /${name} command`);
	return command;
}

function handlerRequired<TEvent, TResult = void>(
	harness: IntegrationHarness,
	name: string,
): ExtensionHandler<TEvent, TResult> {
	const handler = harness.handlers.get(name);
	if (!handler) throw new Error(`Expected ${name} handler`);
	return handler as ExtensionHandler<TEvent, TResult>;
}

async function startContribution(harness: IntegrationHarness): Promise<void> {
	await commandRequired(harness, "contribute").handler("", harness.ctx);
}

function terminalAgentEnd(stopReason: "stop" | "aborted" | "error", text = "done"): AgentEndEvent {
	return {
		type: "agent_end",
		messages: [
			{
				role: "assistant",
				content: [{ type: "text", text }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
				stopReason,
				timestamp: 0,
			},
		],
	} as AgentEndEvent;
}

interface KeptContributionOptions {
	candidateExitCode?: number;
	candidateTimedOut?: boolean;
	redProof?: "valid" | "missing" | "passing" | "flagged";
	harnessProof?: "valid" | "missing" | "changed";
	invocationProof?: "valid" | "missing" | "timeout-changed" | "config-changed";
	redTreeProof?: "valid" | "same" | "missing";
}

async function prepareKeptContribution(
	harness: IntegrationHarness,
	cwd: string,
	options: KeptContributionOptions = {},
): Promise<SessionRow> {
	await Bun.write(`${cwd}/autoresearch.sh`, "#!/usr/bin/env bash\necho METRIC runtime_ms=1\n");
	const init = harness.tools.get("init_experiment");
	if (!init) throw new Error("Expected init_experiment tool");
	await init.execute(
		"initial",
		{ name: "candidate", primary_metric: "runtime_ms", metric_unit: "ms" },
		undefined,
		undefined,
		harness.ctx as ExtensionContext,
	);
	const storage = await openAutoresearchStorage(cwd);
	const session = storage.getActiveSessionForBranch(harness.currentBranch());
	if (!session) throw new Error("Expected contribution session");
	const now = Date.now();
	if (options.redProof !== "missing") {
		const redRun = storage.insertRun({
			sessionId: session.id,
			segment: session.currentSegment,
			command: "bash autoresearch.sh",
			startedAt: now,
			logPath: "",
			preRunDirtyPaths: [],
		});
		storage.markRunCompleted({
			runId: redRun.id,
			completedAt: now + 1,
			durationMs: 1,
			exitCode: options.redProof === "passing" ? 0 : 1,
			timedOut: false,
			parsedPrimary: null,
			parsedMetrics: null,
			parsedAsi:
				options.harnessProof === "missing"
					? { hypothesis: "The focused contribution scenario should fail before the fix." }
					: {
							hypothesis: "The focused contribution scenario should fail before the fix.",
							[CONTRIBUTION_HARNESS_SHA256_ASI_KEY]: HARNESS_SHA256,
							...(options.redTreeProof === "missing"
								? {}
								: {
										[CONTRIBUTION_WORKTREE_TREE_ASI_KEY]:
											options.redTreeProof === "same" ? CANDIDATE_TREE_SHA : RED_TREE_SHA,
									}),
							...(options.invocationProof === "missing"
								? {}
								: { [CONTRIBUTION_INVOCATION_SHA256_ASI_KEY]: INVOCATION_SHA256 }),
						},
		});
		storage.markRunLogged({
			runId: redRun.id,
			status: "checks_failed",
			description: "Observed the focused scenario fail before implementation.",
			metric: 0,
			metrics: {},
			asi: { hypothesis: "The focused contribution scenario should fail before the fix." },
			commitHash: COMMIT_SHA,
			confidence: null,
			modifiedPaths: [],
			scopeDeviations: [],
			justification: null,
			loggedAt: now + 2,
		});
		if (options.redProof === "flagged") storage.flagRun(redRun.id, "invalid red proof");
	}
	const run = storage.insertRun({
		sessionId: session.id,
		segment: session.currentSegment,
		command: "bash autoresearch.sh",
		startedAt: now + 10,
		logPath: "",
		preRunDirtyPaths: [],
	});
	storage.markRunCompleted({
		runId: run.id,
		completedAt: now + 11,
		durationMs: 1,
		exitCode: options.candidateExitCode ?? 0,
		timedOut: options.candidateTimedOut ?? false,
		parsedPrimary: 1,
		parsedMetrics: { runtime_ms: 1 },
		parsedAsi:
			options.harnessProof === "missing"
				? { hypothesis: "Ran the focused contribution scenario." }
				: {
						hypothesis: "Ran the focused contribution scenario.",
						[CONTRIBUTION_HARNESS_SHA256_ASI_KEY]:
							options.harnessProof === "changed" ? CHANGED_HARNESS_SHA256 : HARNESS_SHA256,
						[CONTRIBUTION_WORKTREE_TREE_ASI_KEY]: CANDIDATE_TREE_SHA,
						[CONTRIBUTION_HEAD_SHA_ASI_KEY]: COMMIT_SHA,
						...(options.invocationProof === "missing"
							? {}
							: {
									[CONTRIBUTION_INVOCATION_SHA256_ASI_KEY]:
										options.invocationProof === "timeout-changed"
											? TIMEOUT_CHANGED_INVOCATION_SHA256
											: options.invocationProof === "config-changed"
												? CONFIG_CHANGED_INVOCATION_SHA256
												: INVOCATION_SHA256,
								}),
					},
	});
	storage.markRunLogged({
		runId: run.id,
		status: "keep",
		description: "Observed the focused scenario pass at runtime_ms=1.",
		metric: 1,
		metrics: {},
		asi: { hypothesis: "Ran the focused contribution scenario." },
		commitHash: CURRENT_HEAD,
		confidence: null,
		modifiedPaths: [],
		scopeDeviations: [],
		justification: null,
		loggedAt: now + 12,
	});
	harness.setHeadSha(CURRENT_HEAD);
	return session;
}

async function prepareInitializedContribution(harness: IntegrationHarness, cwd: string) {
	await Bun.write(`${cwd}/autoresearch.sh`, "#!/usr/bin/env bash\necho METRIC runtime_ms=1\n");
	const init = harness.tools.get("init_experiment");
	if (!init) throw new Error("Expected init_experiment tool");
	await init.execute(
		"initial-session",
		{ name: "candidate", primary_metric: "runtime_ms", metric_unit: "ms" },
		undefined,
		undefined,
		harness.ctx as ExtensionContext,
	);
	const storage = await openAutoresearchStorage(cwd);
	const session = storage.getActiveSessionForBranch(harness.currentBranch());
	if (!session) throw new Error("Expected contribution session");
	return { session, storage };
}

async function preparePendingContribution(harness: IntegrationHarness, cwd: string) {
	const { session, storage } = await prepareInitializedContribution(harness, cwd);
	const now = Date.now();
	const run = storage.insertRun({
		sessionId: session.id,
		segment: session.currentSegment,
		command: "bash autoresearch.sh",
		startedAt: now,
		logPath: "",
		preRunDirtyPaths: [],
	});
	storage.markRunCompleted({
		runId: run.id,
		completedAt: now + 1,
		durationMs: 1,
		exitCode: 0,
		timedOut: false,
		parsedPrimary: 1,
		parsedMetrics: { runtime_ms: 1 },
		parsedAsi: {
			[CONTRIBUTION_HARNESS_SHA256_ASI_KEY]: HARNESS_SHA256,
			[CONTRIBUTION_WORKTREE_TREE_ASI_KEY]: CANDIDATE_TREE_SHA,
			[CONTRIBUTION_INVOCATION_SHA256_ASI_KEY]: INVOCATION_SHA256,
			[CONTRIBUTION_HEAD_SHA_ASI_KEY]: COMMIT_SHA,
		},
	});
	return { run, session, storage };
}

async function initializeRealContributionRepository(cwd: string): Promise<void> {
	await $`git -C ${cwd} init -b main`.quiet();
	await $`git -C ${cwd} config user.name OMP`.quiet();
	await $`git -C ${cwd} config user.email omp@example.invalid`.quiet();
	await Bun.write(`${cwd}/autoresearch.sh`, "#!/usr/bin/env bash\necho METRIC runtime_ms=1\n");
	await Bun.write(`${cwd}/source.ts`, "export const value = 'baseline';\n");
	await $`git -C ${cwd} add autoresearch.sh source.ts`.quiet();
	await $`git -C ${cwd} commit -m baseline`.quiet();
}

describe("interactive contribution review confirmation", () => {
	it("propagates cancellation through the initialized TUI confirmation selector", async () => {
		let uiContext: ExtensionContext["ui"] | undefined;
		const controller = new ExtensionUiController({
			editor: {
				setText: vi.fn(),
				handleInput: vi.fn(),
				getText: vi.fn(() => ""),
			},
			ui: { requestRender: vi.fn() },
			session: {
				extensionRunner: undefined,
				setUsageFallbackConfirmer: vi.fn(),
			},
			setToolUIContext(context: ExtensionContext["ui"]): void {
				uiContext = context;
			},
			addAutocompleteProvider: vi.fn(),
		} as never);
		const selectorEntered = Promise.withResolvers<void>();
		const releaseSelector = Promise.withResolvers<void>();
		let selectorSignal: AbortSignal | undefined;
		vi.spyOn(controller, "showHookSelector").mockImplementation(async (_title, _options, dialogOptions) => {
			selectorSignal = dialogOptions?.signal;
			selectorEntered.resolve();
			await releaseSelector.promise;
			return dialogOptions?.signal?.aborted ? undefined : "Yes";
		});
		await controller.initHooksAndCustomTools();
		if (!uiContext) throw new Error("Expected initialized extension UI context");
		const abortController = new AbortController();
		const confirmation = uiContext.confirm("Review", "Push candidate?", {
			signal: abortController.signal,
		});
		await selectorEntered.promise;

		abortController.abort(new DOMException("Review invalidated", "AbortError"));
		const selectorSignalBeforeRelease = selectorSignal;
		const selectorAbortedBeforeRelease = selectorSignal?.aborted;
		releaseSelector.resolve();
		const confirmed = await confirmation;

		expect(selectorSignalBeforeRelease).toBe(abortController.signal);
		expect(selectorAbortedBeforeRelease).toBe(true);
		expect(confirmed).toBe(false);
	});
});

describe("process-local contribution lifecycle", () => {
	let cwd: TempDir;
	let dbDir: TempDir;

	beforeEach(() => {
		cwd = TempDir.createSync("@pi-contribution-lifecycle-cwd-");
		dbDir = TempDir.createSync("@pi-contribution-lifecycle-db-");
		process.env.OMP_AUTORESEARCH_DB_DIR = dbDir.path();
	});

	afterEach(() => {
		delete process.env.OMP_AUTORESEARCH_DB_DIR;
		closeAllAutoresearchStorages();
		cwd.removeSync();
		dbDir.removeSync();
	});

	for (const transition of ["switch", "branch", "tree"] as const) {
		it(`returns cancel immediately for ${transition} and renders off only after its named async stop settles`, async () => {
			const stopEntered = Promise.withResolvers<void>();
			const releaseStop = Promise.withResolvers<void>();
			const widgetCleared = Promise.withResolvers<void>();
			let contributionStarted = false;
			const harness = createIntegrationHarness(cwd.path(), {
				sessionId: `transition-${transition}`,
				onSetActiveTools(_callNumber, names) {
					if (!contributionStarted || names.includes("init_experiment")) return;
					stopEntered.resolve();
					return releaseStop.promise;
				},
				onSetWidget(value) {
					if (contributionStarted && value === undefined) widgetCleared.resolve();
				},
			});
			await startContribution(harness);
			contributionStarted = true;
			const transitionId = `named-${transition}-stop`;
			let result: unknown;
			if (transition === "switch") {
				result = handlerRequired<SessionBeforeSwitchEvent, { cancel?: boolean }>(harness, "session_before_switch")(
					{
						type: "session_before_switch",
						transitionId,
						reason: "resume",
						targetSessionFile: "/tmp/named-transition.jsonl",
					},
					harness.ctx as ExtensionContext,
				);
			} else if (transition === "branch") {
				result = handlerRequired<SessionBeforeBranchEvent, { cancel?: boolean }>(harness, "session_before_branch")(
					{ type: "session_before_branch", transitionId, entryId: "named-transition-source" },
					harness.ctx as ExtensionContext,
				);
			} else {
				result = handlerRequired<SessionBeforeTreeEvent, { cancel?: boolean }>(harness, "session_before_tree")(
					{
						type: "session_before_tree",
						transitionId,
						preparation: {
							targetId: "named-transition-target",
							oldLeafId: "named-transition-source",
							commonAncestorId: "root",
							entriesToSummarize: [],
							userWantsSummary: false,
						},
						signal: new AbortController().signal,
					},
					harness.ctx as ExtensionContext,
				);
			}

			expect(result).toEqual({ cancel: true });
			await stopEntered.promise;
			expect(harness.widgetValues.at(-1)).not.toBeUndefined();
			releaseStop.resolve();
			await widgetCleared.promise;
			expect(harness.activeTools).not.toContain("init_experiment");
			expect(harness.widgetValues.at(-1)).toBeUndefined();
			await commandRequired(harness, "contribute").handler("status", harness.ctx);
			expect(harness.notifications.at(-1)?.message).toBe("Contribution mode is off.");

			const transitionEnd = handlerRequired<{
				type: "session_transition_end";
				transitionId: string;
				kind: "switch" | "branch" | "tree";
				committed: boolean;
			}>(harness, "session_transition_end");
			const endEvent = {
				type: "session_transition_end" as const,
				transitionId,
				kind: transition,
				committed: false,
			};
			await transitionEnd(endEvent, harness.ctx as ExtensionContext);
			await transitionEnd(endEvent, harness.ctx as ExtensionContext);
			harness.setCurrentBranch(`autoresearch/ordinary-after-${transition}`);
			await commandRequired(harness, "autoresearch").handler("ordinary after transition", harness.ctx);
			await Bun.write(`${cwd.path()}/autoresearch.sh`, "#!/usr/bin/env bash\necho METRIC runtime_ms=1\n");
			const init = harness.tools.get("init_experiment");
			if (!init) throw new Error("Expected init_experiment tool");
			const mutation = await Promise.allSettled([
				init.execute(
					`ordinary-after-${transition}`,
					{ name: "ordinary", primary_metric: "runtime_ms" },
					undefined,
					undefined,
					harness.ctx as ExtensionContext,
				),
			]);
			expect(mutation[0]?.status).toBe("fulfilled");
		});
	}

	it("waits for activating contribution rollback before off returns", async () => {
		const rollbackEntered = Promise.withResolvers<void>();
		const releaseRollback = Promise.withResolvers<void>();
		const priorModel = requiredBundledModel("anthropic", "claude-sonnet-4-5");
		const selectedModel = requiredBundledModel("anthropic", "claude-sonnet-4-6");
		const initialTools = ["read", "bash"];
		const harness = createIntegrationHarness(cwd.path(), {
			currentModel: priorModel,
			selectedModelId: selectedModel.id,
			setActiveToolsFailureAt: 1,
			onSetActiveTools(_callNumber, names) {
				if (names.length !== initialTools.length || names.some((name, index) => name !== initialTools[index]))
					return;
				rollbackEntered.resolve();
				return releaseRollback.promise;
			},
		});
		const startPromise = startContribution(harness);
		await rollbackEntered.promise;
		let offSettled = false;
		const offPromise = commandRequired(harness, "contribute")
			.handler("off", harness.ctx)
			.finally(() => {
				offSettled = true;
			});
		for (let turn = 0; turn < 4; turn++) await Promise.resolve();
		const offSettledBeforeRelease = offSettled;

		releaseRollback.resolve();
		const [startResult, offResult] = await Promise.allSettled([startPromise, offPromise]);

		expect(offSettledBeforeRelease).toBe(false);
		expect(offSettled).toBe(true);
		expect(startResult.status).toBe("fulfilled");
		expect(offResult.status).toBe("fulfilled");
		expect(harness.currentModel()).toBe(priorModel);
		expect(harness.currentBranch()).toBe("main");
		expect(harness.activeTools).toEqual(initialTools);
		expect(harness.sentUserMessages).toEqual([]);
		expect(harness.widgetValues.at(-1)).toBeUndefined();
		await commandRequired(harness, "contribute").handler("status", harness.ctx);
		expect(harness.notifications.at(-1)?.message).toBe("Contribution mode is off.");
	});

	it("rejects ordinary autoresearch while confirmed contribution activation awaits its model", async () => {
		const modelActivationEntered = Promise.withResolvers<void>();
		const releaseModelActivation = Promise.withResolvers<void>();
		const harness = createIntegrationHarness(cwd.path(), {
			onSetModel(callNumber) {
				if (callNumber !== 1) return;
				modelActivationEntered.resolve();
				return releaseModelActivation.promise;
			},
		});
		const initialBranch = harness.currentBranch();
		const startPromise = startContribution(harness);
		await modelActivationEntered.promise;

		await commandRequired(harness, "autoresearch").handler("ordinary goal", harness.ctx);

		expect(harness.notifications.at(-1)).toEqual({
			message: "Stop contribution mode with `/contribute off` before using `/autoresearch`.",
			type: "error",
		});
		expect(harness.appendEntries).toEqual([]);
		expect(harness.sentUserMessages).toEqual([]);
		expect(harness.checkoutNewCalls).toEqual([]);
		expect(harness.currentBranch()).toBe(initialBranch);

		releaseModelActivation.resolve();
		await startPromise;

		expect(harness.appendEntries).toEqual([]);
		expect(harness.sentUserMessages).toEqual(["Faster contributor loop"]);
		expect(harness.checkoutNewCalls).toHaveLength(1);
		expect(harness.currentBranch()).toBe(harness.checkoutNewCalls[0]);
		await commandRequired(harness, "contribute").handler("status", harness.ctx);
		expect(harness.notifications.at(-1)?.message).toStartWith("Contribution running on ");
	});

	it("keeps mutation admission closed across overlapping rehydrate handlers", async () => {
		const harness = createIntegrationHarness(cwd.path());
		harness.setSessionBranch([
			{
				type: "custom",
				customType: "autoresearch-control",
				id: "overlapping-rehydrate",
				parentId: null,
				timestamp: new Date(0).toISOString(),
				data: { mode: "on", goal: "ordinary autoresearch goal" },
			},
		]);

		const firstBranchEntered = Promise.withResolvers<void>();
		const secondBranchEntered = Promise.withResolvers<void>();
		const releaseFirstBranch = Promise.withResolvers<void>();
		const releaseSecondBranch = Promise.withResolvers<void>();
		let branchReadCount = 0;
		vi.spyOn(git.branch, "current").mockImplementation(async () => {
			branchReadCount++;
			if (branchReadCount === 2) {
				firstBranchEntered.resolve();
				await releaseFirstBranch.promise;
			} else if (branchReadCount === 3) {
				secondBranchEntered.resolve();
				await releaseSecondBranch.promise;
			}
			return "main";
		});
		const sessionStart = handlerRequired<SessionStartEvent>(harness, "session_start");
		const firstRehydrate = Promise.resolve(
			sessionStart({ type: "session_start" } as SessionStartEvent, harness.ctx as ExtensionContext),
		);
		await firstBranchEntered.promise;
		const secondRehydrate = Promise.resolve(
			sessionStart({ type: "session_start" } as SessionStartEvent, harness.ctx as ExtensionContext),
		);

		releaseFirstBranch.resolve();
		const [firstResult] = await Promise.allSettled([firstRehydrate]);
		await secondBranchEntered.promise;
		const updateNotes = harness.tools.get("update_notes");
		if (!updateNotes) throw new Error("Expected update_notes tool");
		const [mutationResult] = await Promise.allSettled([
			updateNotes.execute(
				"notes-during-overlapping-rehydrate",
				{ body: "must not publish" },
				undefined,
				undefined,
				harness.ctx as ExtensionContext,
			),
		]);
		releaseSecondBranch.resolve();
		const [secondResult] = await Promise.allSettled([secondRehydrate]);

		expect(firstResult.status).toBe("fulfilled");
		expect(mutationResult).toMatchObject({ status: "rejected", reason: { name: "ToolAbortError" } });
		expect(secondResult.status).toBe("fulfilled");
		expect(snapshotStorageArtifacts(dbDir.path())).toEqual([]);
	});

	it("waits for in-flight rehydrate before contribution startup", async () => {
		const harness = createIntegrationHarness(cwd.path());
		harness.setSessionBranch([
			{
				type: "custom",
				customType: "autoresearch-control",
				id: "startup-rehydrate",
				parentId: null,
				timestamp: new Date(0).toISOString(),
				data: { mode: "off" },
			},
		]);
		const branchEntered = Promise.withResolvers<void>();
		const releaseBranch = Promise.withResolvers<void>();
		let branchReadCount = 0;
		vi.spyOn(git.branch, "current").mockImplementation(async () => {
			branchReadCount++;
			if (branchReadCount === 1) {
				branchEntered.resolve();
				await releaseBranch.promise;
			}
			return harness.currentBranch();
		});
		const sessionStart = handlerRequired<SessionStartEvent>(harness, "session_start");
		const rehydratePromise = Promise.resolve(
			sessionStart({ type: "session_start" } as SessionStartEvent, harness.ctx as ExtensionContext),
		);
		await branchEntered.promise;
		const startPromise = startContribution(harness);
		for (let turn = 0; turn < 4; turn++) await Promise.resolve();
		const confirmationsBeforeRehydrate = harness.confirmCalls.length;

		releaseBranch.resolve();
		const [rehydrateResult, startResult] = await Promise.allSettled([rehydratePromise, startPromise]);

		expect(confirmationsBeforeRehydrate).toBe(0);
		expect(rehydrateResult.status).toBe("fulfilled");
		expect(startResult.status).toBe("fulfilled");
		await commandRequired(harness, "contribute").handler("status", harness.ctx);
		expect(harness.notifications.at(-1)?.message).toStartWith("Contribution running on ");
		expect(harness.activeTools).toEqual([
			"read",
			"bash",
			"init_experiment",
			"run_experiment",
			"log_experiment",
			"update_notes",
		]);
	});

	it("does not wedge ordinary autoresearch when a tree transition never commits", async () => {
		const harness = createIntegrationHarness(cwd.path());
		await commandRequired(harness, "autoresearch").handler("ordinary goal", harness.ctx);
		await Bun.write(`${cwd.path()}/autoresearch.sh`, "#!/usr/bin/env bash\necho METRIC runtime_ms=1\n");
		const init = harness.tools.get("init_experiment");
		if (!init) throw new Error("Expected init_experiment tool");
		await init.execute(
			"ordinary-session",
			{ name: "ordinary", primary_metric: "runtime_ms", metric_unit: "ms" },
			undefined,
			undefined,
			harness.ctx as ExtensionContext,
		);
		const storage = await openAutoresearchStorage(cwd.path());
		const session = storage.getActiveSessionForBranch(harness.currentBranch());
		if (!session) throw new Error("Expected ordinary autoresearch session");

		const transitionId = "cancelled-tree-transition";
		const beforeEvent = {
			type: "session_before_tree",
			transitionId,
			preparation: {
				targetId: "uncommitted-target",
				oldLeafId: "ordinary-source",
				commonAncestorId: "root",
				entriesToSummarize: [],
				userWantsSummary: false,
			},
			signal: new AbortController().signal,
		} satisfies SessionBeforeTreeEvent & { transitionId: string };
		const beforeResult = await handlerRequired<SessionBeforeTreeEvent, { cancel?: boolean }>(
			harness,
			"session_before_tree",
		)(beforeEvent, harness.ctx as ExtensionContext);
		await handlerRequired<{
			type: "session_transition_end";
			transitionId: string;
			kind: "tree";
			committed: boolean;
		}>(harness, "session_transition_end")(
			{ type: "session_transition_end", transitionId, kind: "tree", committed: false },
			harness.ctx as ExtensionContext,
		);
		const updateNotes = harness.tools.get("update_notes");
		if (!updateNotes) throw new Error("Expected update_notes tool");
		const [updateResult] = await Promise.allSettled([
			updateNotes.execute(
				"notes-after-cancelled-tree",
				{ body: "ordinary notes remain writable" },
				undefined,
				undefined,
				harness.ctx as ExtensionContext,
			),
		]);

		expect(beforeResult).toBeUndefined();
		expect(updateResult.status).toBe("fulfilled");
		expect(storage.getSessionById(session.id)?.notes).toBe("ordinary notes remain writable");
	});

	it("aborts and drains a kept log commit before contribution off", async () => {
		const harness = createIntegrationHarness(cwd.path());
		await startContribution(harness);
		const { run, session, storage } = await preparePendingContribution(harness, cwd.path());
		harness.setStatusText(" M autoresearch.sh\0");
		const log = harness.tools.get("log_experiment");
		if (!log) throw new Error("Expected log_experiment tool");
		let stageSignal: AbortSignal | undefined;
		let diffSignal: AbortSignal | undefined;
		let commitSignal: AbortSignal | undefined;
		let offPromise: Promise<void> | null = null;
		let offSettled = false;
		let statusDuringCommit: string | undefined;
		let offSettledDuringCommit = false;
		vi.spyOn(git.stage, "files").mockImplementation(async (_workDir, _files, signal) => {
			stageSignal = signal;
		});
		vi.spyOn(git.diff, "has").mockImplementation(async (_workDir, options) => {
			diffSignal = options?.signal;
			return true;
		});
		vi.spyOn(git, "commit").mockImplementation(async (_workDir, _message, options) => {
			commitSignal = options?.signal;
			offPromise = commandRequired(harness, "contribute")
				.handler("off", harness.ctx)
				.finally(() => {
					offSettled = true;
				});
			await commandRequired(harness, "contribute").handler("status", harness.ctx);
			statusDuringCommit = harness.notifications.at(-1)?.message;
			offSettledDuringCommit = offSettled;
			if (commitSignal?.aborted) {
				throw commitSignal.reason ?? new DOMException("Contribution log aborted", "AbortError");
			}
			harness.setHeadSha("9".repeat(40));
			return { exitCode: 0, stdout: "", stderr: "" };
		});

		const [logResult] = await Promise.allSettled([
			log.execute(
				"kept-log-during-off",
				{ metric: 1, status: "keep", description: "candidate result" },
				undefined,
				undefined,
				harness.ctx as ExtensionContext,
			),
		]);
		const startedOff = offPromise as Promise<void> | null;
		if (!startedOff) throw new Error("Expected contribution off to start during log commit");
		const [offResult] = await Promise.allSettled([startedOff]);

		expect(statusDuringCommit).toStartWith("Contribution running on ");
		expect(offSettledDuringCommit).toBe(false);
		expect(stageSignal).toBeDefined();
		expect(diffSignal).toBe(stageSignal);
		expect(commitSignal).toBe(stageSignal);
		expect(stageSignal?.aborted).toBe(true);
		expect(logResult).toMatchObject({ status: "rejected", reason: { name: "ToolAbortError" } });
		expect(offResult.status).toBe("fulfilled");
		expect(await git.head.sha(cwd.path())).toBe(COMMIT_SHA);
		expect(storage.getPendingRun(session.id)?.id).toBe(run.id);
		expect(storage.listLoggedRuns(session.id)).toEqual([]);
		expect(harness.activeTools).toEqual(["read", "bash"]);
	});

	it("aborts and drains a discarded log reset before a session transition", async () => {
		const deactivationEntered = Promise.withResolvers<void>();
		const harness = createIntegrationHarness(cwd.path(), {
			onSetActiveTools(callNumber) {
				if (callNumber === 2) deactivationEntered.resolve();
			},
		});
		await startContribution(harness);
		const { run, session, storage } = await preparePendingContribution(harness, cwd.path());
		const log = harness.tools.get("log_experiment");
		if (!log) throw new Error("Expected log_experiment tool");
		let resetSignal: AbortSignal | undefined;
		let firstLifecycleEvent: "aborted" | "revoked" | undefined;
		let transitionPromise: Promise<void> | null = null;
		let cleanCalls = 0;
		vi.spyOn(git, "reset").mockImplementation(async (_workDir, options) => {
			resetSignal = options?.signal;
			const abortObserved = Promise.withResolvers<void>();
			if (resetSignal?.aborted) {
				abortObserved.resolve();
			} else {
				resetSignal?.addEventListener("abort", () => abortObserved.resolve(), { once: true });
			}
			transitionPromise = Promise.resolve(
				handlerRequired<SessionBeforeSwitchEvent>(harness, "session_before_switch")(
					{
						type: "session_before_switch",
						transitionId: "log-switch",
						reason: "resume",
						targetSessionFile: "/tmp/log-switch.jsonl",
					},
					harness.ctx as ExtensionContext,
				),
			);
			firstLifecycleEvent = await Promise.race([
				abortObserved.promise.then(() => "aborted" as const),
				deactivationEntered.promise.then(() => "revoked" as const),
			]);
			if (resetSignal?.aborted) {
				throw resetSignal.reason ?? new DOMException("Contribution log aborted", "AbortError");
			}
		});
		vi.spyOn(git, "clean").mockImplementation(async () => {
			cleanCalls++;
		});

		const [logResult] = await Promise.allSettled([
			log.execute(
				"discarded-log-during-switch",
				{ metric: 1, status: "discard", description: "discard candidate" },
				undefined,
				undefined,
				harness.ctx as ExtensionContext,
			),
		]);
		const startedTransition = transitionPromise as Promise<void> | null;
		if (!startedTransition) throw new Error("Expected session transition to start during log reset");
		const [transitionResult] = await Promise.allSettled([startedTransition]);
		await commandRequired(harness, "contribute").handler("off", harness.ctx);

		expect(firstLifecycleEvent).toBe("aborted");
		expect(resetSignal).toBeDefined();
		expect(resetSignal?.aborted).toBe(true);
		expect(cleanCalls).toBe(0);
		expect(logResult).toMatchObject({ status: "rejected", reason: { name: "ToolAbortError" } });
		expect(transitionResult.status).toBe("fulfilled");
		expect(storage.getPendingRun(session.id)?.id).toBe(run.id);
		expect(storage.listLoggedRuns(session.id)).toEqual([]);
		expect(harness.activeTools).toEqual(["read", "bash"]);
	});

	it("aborts and drains an in-flight run before contribution off publishes completion", async () => {
		const harness = createIntegrationHarness(cwd.path());
		await startContribution(harness);
		const { session, storage } = await prepareInitializedContribution(harness, cwd.path());
		const run = harness.tools.get("run_experiment");
		if (!run) throw new Error("Expected run_experiment tool");
		let processSignal: AbortSignal | undefined;
		let offPromise: Promise<void> | null = null;
		let offSettled = false;
		let offSettledDuringProcess = false;
		vi.spyOn(bashExecutor, "executeBash").mockImplementation(async (_command, options) => {
			processSignal = options?.signal;
			offPromise = commandRequired(harness, "contribute")
				.handler("off", harness.ctx)
				.finally(() => {
					offSettled = true;
				});
			for (let turn = 0; turn < 4; turn++) await Promise.resolve();
			offSettledDuringProcess = offSettled;
			if (processSignal?.aborted) {
				throw processSignal.reason ?? new DOMException("Contribution run aborted", "AbortError");
			}
			return {
				output: "",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				totalLines: 0,
				totalBytes: 0,
				outputLines: 0,
				outputBytes: 0,
			};
		});

		const [runResult] = await Promise.allSettled([
			run.execute("run-during-off", {}, undefined, undefined, harness.ctx as ExtensionContext),
		]);
		const startedOff = offPromise as Promise<void> | null;
		if (!startedOff) throw new Error("Expected contribution off to start during run");
		const [offResult] = await Promise.allSettled([startedOff]);
		const pendingRun = storage.getPendingRun(session.id);

		expect(offSettledDuringProcess).toBe(false);
		expect(processSignal).toBeDefined();
		expect(processSignal?.aborted).toBe(true);
		expect(runResult).toMatchObject({ status: "rejected", reason: { name: "ToolAbortError" } });
		expect(offResult.status).toBe("fulfilled");
		expect(pendingRun).not.toBeNull();
		expect(pendingRun?.completedAt).toBeNull();
		expect(storage.listLoggedRuns(session.id)).toEqual([]);
		expect(harness.activeTools).toEqual(["read", "bash"]);
	});

	it("awaits shutdown until an abortable contribution run has drained", async () => {
		const deactivated = Promise.withResolvers<void>();
		const harness = createIntegrationHarness(cwd.path(), {
			onSetActiveTools(_callNumber, names) {
				if (names.length === 2 && names[0] === "read" && names[1] === "bash") deactivated.resolve();
			},
		});
		await startContribution(harness);
		const { session, storage } = await prepareInitializedContribution(harness, cwd.path());
		const run = harness.tools.get("run_experiment");
		if (!run) throw new Error("Expected run_experiment tool");
		let processSignal: AbortSignal | undefined;
		let shutdownPromise: Promise<void> | null = null;
		let shutdownSettled = false;
		let shutdownSettledDuringProcess = false;
		vi.spyOn(bashExecutor, "executeBash").mockImplementation(async (_command, options) => {
			processSignal = options?.signal;
			shutdownPromise = Promise.resolve(
				handlerRequired<SessionShutdownEvent>(harness, "session_shutdown")(
					{ type: "session_shutdown" } as SessionShutdownEvent,
					harness.ctx as ExtensionContext,
				),
			).finally(() => {
				shutdownSettled = true;
			});
			for (let turn = 0; turn < 4; turn++) await Promise.resolve();
			shutdownSettledDuringProcess = shutdownSettled;
			if (processSignal?.aborted) {
				throw processSignal.reason ?? new DOMException("Contribution run aborted by shutdown", "AbortError");
			}
			return {
				output: "METRIC runtime_ms=1",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				totalLines: 1,
				totalBytes: 19,
				outputLines: 1,
				outputBytes: 19,
			};
		});

		const [runResult] = await Promise.allSettled([
			run.execute("run-during-shutdown", {}, undefined, undefined, harness.ctx as ExtensionContext),
		]);
		const startedShutdown = shutdownPromise as Promise<void> | null;
		if (!startedShutdown) throw new Error("Expected shutdown to start during run execution");
		const [shutdownResult] = await Promise.allSettled([startedShutdown]);
		await deactivated.promise;

		expect(shutdownSettledDuringProcess).toBe(false);
		expect(processSignal).toBeDefined();
		expect(processSignal?.aborted).toBe(true);
		expect(runResult).toMatchObject({ status: "rejected", reason: { name: "ToolAbortError" } });
		expect(shutdownResult.status).toBe("fulfilled");
		const pendingRun = storage.getPendingRun(session.id);
		expect(pendingRun).not.toBeNull();
		expect(pendingRun?.completedAt).toBeNull();
		expect(storage.listLoggedRuns(session.id)).toEqual([]);
		expect(harness.activeTools).toEqual(["read", "bash"]);
	});

	it("awaits an in-flight ordinary clear before shutdown releases its runtime", async () => {
		const harness = createIntegrationHarness(cwd.path());
		const branch = "autoresearch/shutdown-clear";
		harness.setCurrentBranch(branch);
		await commandRequired(harness, "autoresearch").handler("shutdown clear", harness.ctx);
		const storage = await openAutoresearchStorage(cwd.path());
		const session = storage.openSession({
			name: "shutdown clear",
			goal: "shutdown clear",
			primaryMetric: "runtime_ms",
			metricUnit: "ms",
			direction: "lower",
			preferredCommand: "bash autoresearch.sh",
			branch,
			baselineCommit: COMMIT_SHA,
			maxIterations: 10,
			scopePaths: [],
			offLimits: [],
			constraints: [],
			secondaryMetrics: [],
		});
		const resetEntered = Promise.withResolvers<void>();
		const releaseReset = Promise.withResolvers<void>();
		vi.spyOn(git, "reset").mockImplementation(async () => {
			resetEntered.resolve();
			await releaseReset.promise;
		});
		vi.spyOn(git, "clean").mockResolvedValue();

		const clearPromise = commandRequired(harness, "autoresearch").handler("clear", harness.ctx);
		await resetEntered.promise;
		let shutdownSettled = false;
		const shutdownPromise = Promise.resolve(
			handlerRequired<SessionShutdownEvent>(harness, "session_shutdown")(
				{ type: "session_shutdown" } as SessionShutdownEvent,
				harness.ctx as ExtensionContext,
			),
		).finally(() => {
			shutdownSettled = true;
		});
		const shutdownFence = Promise.withResolvers<void>();
		setImmediate(shutdownFence.resolve);
		await shutdownFence.promise;
		const shutdownSettledDuringReset = shutdownSettled;
		releaseReset.resolve();
		const [clearResult, shutdownResult] = await Promise.allSettled([clearPromise, shutdownPromise]);

		expect(shutdownSettledDuringReset).toBe(false);
		expect(clearResult.status).toBe("fulfilled");
		expect(shutdownResult.status).toBe("fulfilled");
		expect(storage.getSessionById(session.id)).toMatchObject({ id: session.id, closedAt: expect.any(Number) });
		expect(harness.activeTools).toEqual(["read", "bash"]);
	});

	it("awaits an in-flight ordinary rehydrate before shutdown deactivates tools", async () => {
		const harness = createIntegrationHarness(cwd.path());
		const branch = "autoresearch/shutdown-rehydrate";
		harness.setCurrentBranch(branch);
		const storage = await openAutoresearchStorage(cwd.path());
		storage.openSession({
			name: "shutdown rehydrate",
			goal: "shutdown rehydrate",
			primaryMetric: "runtime_ms",
			metricUnit: "ms",
			direction: "lower",
			preferredCommand: "bash autoresearch.sh",
			branch,
			baselineCommit: COMMIT_SHA,
			maxIterations: 10,
			scopePaths: [],
			offLimits: [],
			constraints: [],
			secondaryMetrics: [],
		});
		harness.setSessionBranch([
			{
				type: "custom",
				customType: "autoresearch-control",
				data: { mode: "on", goal: "shutdown rehydrate" },
			},
		]);
		const branchReadEntered = Promise.withResolvers<void>();
		const releaseBranchRead = Promise.withResolvers<void>();
		let branchReads = 0;
		vi.spyOn(git.branch, "current").mockImplementation(async () => {
			branchReads++;
			if (branchReads === 1) {
				branchReadEntered.resolve();
				await releaseBranchRead.promise;
			}
			return branch;
		});

		const rehydratePromise = Promise.resolve(
			handlerRequired<SessionStartEvent>(harness, "session_start")(
				{ type: "session_start" } as SessionStartEvent,
				harness.ctx as ExtensionContext,
			),
		);
		await branchReadEntered.promise;
		let shutdownSettled = false;
		const shutdownPromise = Promise.resolve(
			handlerRequired<SessionShutdownEvent>(harness, "session_shutdown")(
				{ type: "session_shutdown" } as SessionShutdownEvent,
				harness.ctx as ExtensionContext,
			),
		).finally(() => {
			shutdownSettled = true;
		});
		const shutdownFence = Promise.withResolvers<void>();
		setImmediate(shutdownFence.resolve);
		await shutdownFence.promise;
		const shutdownSettledDuringRehydrate = shutdownSettled;
		releaseBranchRead.resolve();
		const [rehydrateResult, shutdownResult] = await Promise.allSettled([rehydratePromise, shutdownPromise]);

		expect(shutdownSettledDuringRehydrate).toBe(false);
		expect(rehydrateResult.status).toBe("fulfilled");
		expect(shutdownResult.status).toBe("fulfilled");
		expect(branchReads).toBeGreaterThanOrEqual(2);
		expect(harness.activeTools).toEqual(["read", "bash"]);
	});

	it("does not complete or publish a passing run whose harness mutates source during execution", async () => {
		await initializeRealContributionRepository(cwd.path());
		const harness = createIntegrationHarness(cwd.path());
		await startContribution(harness);
		const { session, storage } = await prepareInitializedContribution(harness, cwd.path());
		const run = harness.tools.get("run_experiment");
		if (!run) throw new Error("Expected contribution run tool");
		let executionCalls = 0;
		vi.spyOn(bashExecutor, "executeBash").mockImplementation(async () => {
			executionCalls++;
			await Bun.write(`${cwd.path()}/source.ts`, "export const value = 'mutated by harness';\n");
			harness.setStatusText(" M source.ts\0");
			return {
				output: "METRIC runtime_ms=1",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				totalLines: 1,
				totalBytes: 19,
				outputLines: 1,
				outputBytes: 19,
			};
		});

		await Promise.allSettled([
			run.execute("self-mutating-harness", {}, undefined, undefined, harness.ctx as ExtensionContext),
		]);
		const pending = storage.getPendingRun(session.id);

		expect({ executionCalls, completedAt: pending?.completedAt, logged: storage.listLoggedRuns(session.id) }).toEqual(
			{
				executionCalls: 1,
				completedAt: null,
				logged: [],
			},
		);
	});

	it("leaves a self-modifying contribution harness incomplete and ineligible for logging", async () => {
		await initializeRealContributionRepository(cwd.path());
		const harness = createIntegrationHarness(cwd.path());
		await startContribution(harness);
		const { session, storage } = await prepareInitializedContribution(harness, cwd.path());
		const run = harness.tools.get("run_experiment");
		if (!run) throw new Error("Expected contribution run tool");
		vi.spyOn(bashExecutor, "executeBash").mockImplementation(async () => {
			await Bun.write(`${cwd.path()}/autoresearch.sh`, "#!/usr/bin/env bash\necho changed during execution\n");
			harness.setStatusText(" M autoresearch.sh\0");
			return {
				output: "METRIC runtime_ms=1",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				totalLines: 1,
				totalBytes: 19,
				outputLines: 1,
				outputBytes: 19,
			};
		});

		await Promise.allSettled([
			run.execute("self-modifying-autoresearch-harness", {}, undefined, undefined, harness.ctx as ExtensionContext),
		]);
		const pending = storage.getPendingRun(session.id);
		expect(pending).not.toBeNull();
		expect(pending?.completedAt).toBeNull();
		expect(storage.listLoggedRuns(session.id)).toEqual([]);
	});

	it("rejects execution-time source commits even when the harness restores a clean worktree", async () => {
		await initializeRealContributionRepository(cwd.path());
		const initialHead = (await $`git -C ${cwd.path()} rev-parse HEAD`.quiet()).text().trim();
		const harness = createIntegrationHarness(cwd.path());
		await startContribution(harness);
		const { session, storage } = await prepareInitializedContribution(harness, cwd.path());
		const run = harness.tools.get("run_experiment");
		if (!run) throw new Error("Expected contribution run tool");
		let committedHead: string | null = null;
		vi.spyOn(bashExecutor, "executeBash").mockImplementation(async () => {
			await Bun.write(`${cwd.path()}/source.ts`, "export const value = 'committed during execution';\n");
			await $`git -C ${cwd.path()} add source.ts`.quiet();
			await $`git -C ${cwd.path()} commit -m harness-mutated-source`.quiet();
			committedHead = (await $`git -C ${cwd.path()} rev-parse HEAD`.quiet()).text().trim();
			harness.setHeadSha(committedHead);
			harness.setStatusText("");
			return {
				output: "METRIC runtime_ms=1",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				totalLines: 1,
				totalBytes: 19,
				outputLines: 1,
				outputBytes: 19,
			};
		});

		await Promise.allSettled([
			run.execute("commit-source-during-execution", {}, undefined, undefined, harness.ctx as ExtensionContext),
		]);
		const pending = storage.getPendingRun(session.id);
		expect(committedHead).toMatch(/^[0-9a-f]{40}$/);
		expect(committedHead).not.toBe(initialHead);
		expect((await $`git -C ${cwd.path()} status --porcelain=v1 -z`.quiet()).arrayBuffer().byteLength).toBe(0);
		expect(pending).not.toBeNull();
		expect(pending?.completedAt).toBeNull();
		expect(storage.listLoggedRuns(session.id)).toEqual([]);
	});

	it("rejects an oversized contribution harness before allocating execution output or launching it", async () => {
		const harness = createIntegrationHarness(cwd.path());
		await startContribution(harness);
		const { session, storage } = await prepareInitializedContribution(harness, cwd.path());
		await Bun.write(
			`${cwd.path()}/autoresearch.sh`,
			`#!/usr/bin/env bash\n# ${"x".repeat(CONTRIBUTION_HARNESS_MAX_BYTES)}\necho METRIC runtime_ms=1\n`,
		);
		const run = harness.tools.get("run_experiment");
		if (!run) throw new Error("Expected contribution run tool");
		let executionCalls = 0;
		vi.spyOn(bashExecutor, "executeBash").mockImplementation(async () => {
			executionCalls++;
			return {
				output: "METRIC runtime_ms=1",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				totalLines: 1,
				totalBytes: 19,
				outputLines: 1,
				outputBytes: 19,
			};
		});

		await Promise.allSettled([
			run.execute("oversized-contribution-harness", {}, undefined, undefined, harness.ctx as ExtensionContext),
		]);
		const pending = storage.getPendingRun(session.id);
		expect(executionCalls).toBe(0);
		expect(pending?.completedAt ?? null).toBeNull();
		expect(storage.listLoggedRuns(session.id)).toEqual([]);
	});

	it("runs normal commit hooks and logs only the exact one-parent passing-tree commit", async () => {
		await initializeRealContributionRepository(cwd.path());
		const baseHead = (await $`git -C ${cwd.path()} rev-parse HEAD`.quiet()).text().trim();
		const harness = createIntegrationHarness(cwd.path());
		await startContribution(harness);
		const { session, storage } = await prepareInitializedContribution(harness, cwd.path());
		harness.setHeadSha(baseHead);
		await Bun.write(`${cwd.path()}/source.ts`, "export const value = 'candidate';\n");
		harness.setStatusText(" M source.ts\0");
		vi.spyOn(bashExecutor, "executeBash").mockResolvedValue({
			output: "METRIC runtime_ms=1",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			totalLines: 1,
			totalBytes: 19,
			outputLines: 1,
			outputBytes: 19,
		});
		const run = harness.tools.get("run_experiment");
		const log = harness.tools.get("log_experiment");
		if (!run || !log) throw new Error("Expected contribution run and log tools");
		await run.execute("passing-tree-before-hooks", {}, undefined, undefined, harness.ctx as ExtensionContext);
		const passingTree = storage.getPendingRun(session.id)?.parsedAsi?.[CONTRIBUTION_WORKTREE_TREE_ASI_KEY];

		const prepareMarker = `${cwd.path()}/.git/prepare-commit-msg-ran`;
		const postMarker = `${cwd.path()}/.git/post-commit-ran`;
		const prepareHook = `${cwd.path()}/.git/hooks/prepare-commit-msg`;
		const postHook = `${cwd.path()}/.git/hooks/post-commit`;
		await Bun.write(prepareHook, "#!/bin/sh\nprintf prepare > .git/prepare-commit-msg-ran\n");
		await Bun.write(postHook, "#!/bin/sh\nprintf post > .git/post-commit-ran\n");
		fs.chmodSync(prepareHook, 0o755);
		fs.chmodSync(postHook, 0o755);

		const tracePath = `${cwd.path()}/.git/contribution-commit-trace.json`;
		const previousTracePath = process.env.GIT_TRACE2_EVENT;
		process.env.GIT_TRACE2_EVENT = tracePath;
		try {
			harness.setNextStatusRequest(() => harness.setStatusText(""));
			await log.execute(
				"keep-with-normal-hooks",
				{ status: "keep", metric: 1, description: "candidate whose tested bytes must be committed" },
				undefined,
				undefined,
				harness.ctx as ExtensionContext,
			);
		} finally {
			if (previousTracePath === undefined) delete process.env.GIT_TRACE2_EVENT;
			else process.env.GIT_TRACE2_EVENT = previousTracePath;
		}
		const committedHead = (await $`git -C ${cwd.path()} rev-parse HEAD`.quiet()).text().trim();
		const rawCommit = (
			await $`git -C ${cwd.path()} --no-replace-objects cat-file commit ${committedHead}`.quiet()
		).text();
		const headers = rawCommit.slice(0, rawCommit.indexOf("\n\n")).split("\n");
		const treeHeaders = headers.filter(header => header.startsWith("tree "));
		const parentHeaders = headers.filter(header => header.startsWith("parent "));
		const porcelain = (await $`git -C ${cwd.path()} status --porcelain=v1 -z`.quiet()).arrayBuffer();
		const loggedRuns = storage.listLoggedRuns(session.id);
		const traceEvents = (await Bun.file(tracePath).text())
			.split("\n")
			.filter(Boolean)
			.map(line => JSON.parse(line) as { event?: string; argv?: unknown });
		const commitStart = traceEvents.find(
			event => event.event === "start" && Array.isArray(event.argv) && event.argv.includes("commit"),
		);
		const commitArgv = Array.isArray(commitStart?.argv) ? commitStart.argv.map(String) : [];
		const commitIndex = commitArgv.indexOf("commit");

		expect({
			prepareHook: await Bun.file(prepareMarker).text(),
			postHook: await Bun.file(postMarker).text(),
			treeHeaders,
			parentHeaders,
			porcelainBytes: porcelain.byteLength,
			loggedCommit: loggedRuns[0]?.commitHash,
			loggedRuns: loggedRuns.length,
			commitArgs: commitIndex < 0 ? [] : commitArgv.slice(commitIndex + 1),
			bypassedHooks: commitArgv.includes("--no-verify"),
		}).toEqual({
			prepareHook: "prepare",
			postHook: "post",
			treeHeaders: [`tree ${passingTree}`],
			parentHeaders: [`parent ${baseHead}`],
			porcelainBytes: 0,
			loggedCommit: committedHead,
			loggedRuns: 1,
			commitArgs: ["-F", "-"],
			bypassedHooks: false,
		});
	});

	it("rejects a keep when a normal commit hook changes the index, worktree, and committed tree", async () => {
		await initializeRealContributionRepository(cwd.path());
		const baseHead = (await $`git -C ${cwd.path()} rev-parse HEAD`.quiet()).text().trim();
		const harness = createIntegrationHarness(cwd.path());
		await startContribution(harness);
		const { session, storage } = await prepareInitializedContribution(harness, cwd.path());
		harness.setHeadSha(baseHead);
		await Bun.write(`${cwd.path()}/source.ts`, "export const value = 'passing candidate';\n");
		harness.setStatusText(" M source.ts\0");
		vi.spyOn(bashExecutor, "executeBash").mockResolvedValue({
			output: "METRIC runtime_ms=1",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			totalLines: 1,
			totalBytes: 19,
			outputLines: 1,
			outputBytes: 19,
		});
		const run = harness.tools.get("run_experiment");
		const log = harness.tools.get("log_experiment");
		if (!run || !log) throw new Error("Expected contribution run and log tools");
		await run.execute("passing-tree-before-mutating-hook", {}, undefined, undefined, harness.ctx as ExtensionContext);
		const pendingBeforeLog = storage.getPendingRun(session.id);
		const passingTree = pendingBeforeLog?.parsedAsi?.[CONTRIBUTION_WORKTREE_TREE_ASI_KEY];

		const hookMarker = `${cwd.path()}/.git/pre-commit-mutated`;
		const preCommitHook = `${cwd.path()}/.git/hooks/pre-commit`;
		await Bun.write(
			preCommitHook,
			`#!/bin/sh\nprintf hook > .git/pre-commit-mutated\nprintf "%s\\n" "export const value = 'hook-mutated';" > source.ts\ngit add -- source.ts\n`,
		);
		fs.chmodSync(preCommitHook, 0o755);

		harness.setNextStatusRequest(() => harness.setStatusText(""));
		const logResult = await log.execute(
			"keep-with-mutating-hook",
			{ status: "keep", metric: 1, description: "must reject commit-hook drift" },
			undefined,
			undefined,
			harness.ctx as ExtensionContext,
		);
		const committedHead = (await $`git -C ${cwd.path()} rev-parse HEAD`.quiet()).text().trim();
		const committedTree = await readRawCommitTree(cwd.path(), committedHead);
		if (!committedTree) throw new Error("Expected mutating hook commit tree");
		const indexTree = (await $`git -C ${cwd.path()} write-tree`.quiet()).text().trim();
		const porcelain = (await $`git -C ${cwd.path()} status --porcelain=v1 -z`.quiet()).arrayBuffer();

		expect(logResult).toMatchObject({
			content: [
				{
					type: "text",
					text: "Error: commit hooks changed the exact tested tree, parent, or clean worktree",
				},
			],
		});
		expect({
			hook: await Bun.file(hookMarker).text(),
			headChanged: committedHead !== baseHead,
			committedTree,
			indexTree,
			passingTree,
			worktree: await Bun.file(`${cwd.path()}/source.ts`).text(),
			porcelainBytes: porcelain.byteLength,
			pendingRunId: storage.getPendingRun(session.id)?.id,
			loggedRuns: storage.listLoggedRuns(session.id),
		}).toEqual({
			hook: "hook",
			headChanged: true,
			committedTree: expect.stringMatching(/^[0-9a-f]{40}$/),
			indexTree: committedTree,
			passingTree: expect.stringMatching(/^[0-9a-f]{40}$/),
			worktree: "export const value = 'hook-mutated';\n",
			porcelainBytes: 0,
			pendingRunId: pendingBeforeLog?.id,
			loggedRuns: [],
		});
		expect(committedTree).not.toBe(passingTree);
	});
	it("refuses to keep files changed after the passing harness execution", async () => {
		await $`git -C ${cwd.path()} init -b main`.quiet();
		await $`git -C ${cwd.path()} config user.name OMP`.quiet();
		await $`git -C ${cwd.path()} config user.email omp@example.invalid`.quiet();
		await Bun.write(`${cwd.path()}/autoresearch.sh`, "#!/usr/bin/env bash\necho METRIC runtime_ms=1\n");
		await $`git -C ${cwd.path()} add autoresearch.sh`.quiet();
		await $`git -C ${cwd.path()} commit -m baseline`.quiet();
		const baseHead = (await $`git -C ${cwd.path()} rev-parse HEAD`.quiet()).text().trim();
		const harness = createIntegrationHarness(cwd.path());
		await startContribution(harness);
		const { session, storage } = await prepareInitializedContribution(harness, cwd.path());
		vi.spyOn(bashExecutor, "executeBash").mockResolvedValue({
			output: "METRIC runtime_ms=1",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			totalLines: 1,
			totalBytes: 19,
			outputLines: 1,
			outputBytes: 19,
		});
		const run = harness.tools.get("run_experiment");
		const log = harness.tools.get("log_experiment");
		if (!run || !log) throw new Error("Expected contribution run and log tools");
		await run.execute("passing-tree", {}, undefined, undefined, harness.ctx as ExtensionContext);

		await Bun.write(`${cwd.path()}/untested.ts`, "export const untested = true;\n");
		harness.setStatusText("?? untested.ts\0");
		const logResult = await log.execute(
			"keep-untested-tree",
			{ status: "keep", metric: 1, description: "must not keep untested bytes" },
			undefined,
			undefined,
			harness.ctx as ExtensionContext,
		);
		const logText = logResult.content.map(part => (part.type === "text" ? part.text : "")).join("\n");

		expect(logText).toContain("changed after the harness execution");
		expect((await $`git -C ${cwd.path()} rev-parse HEAD`.quiet()).text().trim()).toBe(baseHead);
		expect(storage.getPendingRun(session.id)).not.toBeNull();
		expect(storage.listLoggedRuns(session.id)).toEqual([]);
	});

	it("refuses to log a passing contribution after HEAD changes with the tested tree unchanged", async () => {
		await initializeRealContributionRepository(cwd.path());
		const baseHead = (await $`git -C ${cwd.path()} rev-parse HEAD`.quiet()).text().trim();
		const harness = createIntegrationHarness(cwd.path());
		await startContribution(harness);
		const { session, storage } = await prepareInitializedContribution(harness, cwd.path());
		harness.setHeadSha(baseHead);
		vi.spyOn(bashExecutor, "executeBash").mockResolvedValue({
			output: "METRIC runtime_ms=1",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			totalLines: 1,
			totalBytes: 19,
			outputLines: 1,
			outputBytes: 19,
		});
		const run = harness.tools.get("run_experiment");
		const log = harness.tools.get("log_experiment");
		if (!run || !log) throw new Error("Expected contribution run and log tools");
		await run.execute("passing-before-head-drift", {}, undefined, undefined, harness.ctx as ExtensionContext);
		await $`git -C ${cwd.path()} commit --allow-empty -m untested-ancestry`.quiet();
		const untestedHead = (await $`git -C ${cwd.path()} rev-parse HEAD`.quiet()).text().trim();
		harness.setHeadSha(untestedHead);
		harness.setStatusText("");

		const logResult = await log.execute(
			"keep-after-head-drift",
			{ status: "keep", metric: 1, description: "must reject untested ancestry" },
			undefined,
			undefined,
			harness.ctx as ExtensionContext,
		);
		const logText = logResult.content.map(part => (part.type === "text" ? part.text : "")).join("\n");

		expect(logText).toContain("HEAD changed after the harness execution");
		expect(untestedHead).not.toBe(baseHead);
		expect(storage.getPendingRun(session.id)).not.toBeNull();
		expect(storage.listLoggedRuns(session.id)).toEqual([]);
	});

	it("aborts and drains update_notes before SQLite and runtime mutation on session transition", async () => {
		const harness = createIntegrationHarness(cwd.path());
		await startContribution(harness);
		const { session, storage } = await prepareInitializedContribution(harness, cwd.path());
		const updateNotes = harness.tools.get("update_notes");
		if (!updateNotes) throw new Error("Expected update_notes tool");
		const originalNotes = session.notes;
		const widgetUpdatesBefore = harness.widgetUpdates;
		const contributionBranch = harness.currentBranch();
		let branchSignal: AbortSignal | undefined;
		let transitionPromise: Promise<void> | null = null;
		vi.spyOn(git.branch, "current").mockImplementation(async (_workDir, signal) => {
			branchSignal = signal;
			transitionPromise = Promise.resolve(
				handlerRequired<SessionBeforeSwitchEvent>(harness, "session_before_switch")(
					{
						type: "session_before_switch",
						transitionId: "notes-switch",
						reason: "resume",
						targetSessionFile: "/tmp/notes-switch.jsonl",
					},
					harness.ctx as ExtensionContext,
				),
			);
			return contributionBranch;
		});

		const [updateResult] = await Promise.allSettled([
			updateNotes.execute(
				"notes-during-switch",
				{ body: "mutated after transition" },
				undefined,
				undefined,
				harness.ctx as ExtensionContext,
			),
		]);
		const startedTransition = transitionPromise as Promise<void> | null;
		if (!startedTransition) throw new Error("Expected session transition to start during notes branch read");
		const [transitionResult] = await Promise.allSettled([startedTransition]);

		expect(branchSignal).toBeDefined();
		expect(branchSignal?.aborted).toBe(true);
		expect(updateResult).toMatchObject({ status: "rejected", reason: { name: "ToolAbortError" } });
		expect(transitionResult.status).toBe("fulfilled");
		expect(storage.getSessionById(session.id)?.notes).toBe(originalNotes);
		expect(harness.widgetUpdates).toBe(widgetUpdatesBefore);
		await commandRequired(harness, "contribute").handler("off", harness.ctx);
		expect(harness.activeTools).toEqual(["read", "bash"]);
	});

	it("cancels a contribution move and settles it through the shared lifecycle", async () => {
		const deactivated = Promise.withResolvers<void>();
		const harness = createIntegrationHarness(cwd.path(), {
			onSetActiveTools(_callNumber, names) {
				if (names.length === 2 && names[0] === "read" && names[1] === "bash") deactivated.resolve();
			},
		});
		await startContribution(harness);
		const transitionId = "contribution-move";
		const moveHandler = handlerRequired<
			{ type: "session_before_move"; transitionId: string; targetCwd: string },
			{ cancel?: boolean }
		>(harness, "session_before_move");

		const result = await moveHandler(
			{ type: "session_before_move", transitionId, targetCwd: "/tmp/contribution-move-target" },
			harness.ctx as ExtensionContext,
		);
		await handlerRequired<{
			type: "session_transition_end";
			transitionId: string;
			kind: "move";
			committed: boolean;
		}>(harness, "session_transition_end")(
			{ type: "session_transition_end", transitionId, kind: "move", committed: false },
			harness.ctx as ExtensionContext,
		);
		await deactivated.promise;

		expect(result).toEqual({ cancel: true });
		await commandRequired(harness, "contribute").handler("status", harness.ctx);
		expect(harness.notifications.at(-1)?.message).toBe("Contribution mode is off.");
		expect(harness.activeTools).toEqual(["read", "bash"]);
	});

	it("turns ordinary autoresearch off when its session moves to another repository", async () => {
		const destination = TempDir.createSync("@pi-autoresearch-move-target-");
		try {
			await $`git -C ${destination.path()} init -b main`.quiet();
			const harness = createIntegrationHarness(cwd.path());
			await commandRequired(harness, "autoresearch").handler("ordinary source goal", harness.ctx);
			expect(harness.activeTools).toContain("run_experiment");
			const moveHandler = handlerRequired<{
				type: "session_move";
				previousCwd: string;
				cwd: string;
			}>(harness, "session_move");
			const movedCtx = { ...harness.ctx, cwd: destination.path() } as ExtensionContext;

			await moveHandler({ type: "session_move", previousCwd: cwd.path(), cwd: destination.path() }, movedCtx);
			const prompt = await handlerRequired<BeforeAgentStartEvent, { systemPrompt?: string[] }>(
				harness,
				"before_agent_start",
			)({ type: "before_agent_start", prompt: "after move", systemPrompt: ["base prompt"] }, movedCtx);

			expect(prompt).toBeUndefined();
			expect(harness.activeTools).toEqual(["read", "bash"]);
			expect(harness.appendEntries.at(-1)).toEqual({
				customType: "autoresearch-control",
				data: { mode: "off", goal: "ordinary source goal" },
			});
		} finally {
			destination.removeSync();
		}
	});

	it("drains a successful publication into its immutable handoff during off", async () => {
		const harness = createIntegrationHarness(cwd.path(), { confirmAnswers: [true, true, true] });
		await startContribution(harness);
		await prepareKeptContribution(harness, cwd.path());
		const transportApplied = Promise.withResolvers<void>();
		const releaseTransport = Promise.withResolvers<void>();
		let pushSignal: AbortSignal | undefined;
		vi.spyOn(git, "push").mockImplementation(async (_workDir, options) => {
			pushSignal = options?.signal;
			transportApplied.resolve();
			await releaseTransport.promise;
		});

		const reviewPromise = commandRequired(harness, "contribute").handler("review", harness.ctx);
		await transportApplied.promise;
		const planDisplayedBeforeRelease = harness.notifications.some(notification =>
			notification.message.startsWith("Contribution publication plan (push outcome pending):"),
		);
		let offSettled = false;
		const offPromise = commandRequired(harness, "contribute")
			.handler("off", harness.ctx)
			.finally(() => {
				offSettled = true;
			});
		for (let turn = 0; turn < 4; turn++) await Promise.resolve();
		const offSettledBeforeRelease = offSettled;

		releaseTransport.resolve();
		const [reviewResult, offResult] = await Promise.allSettled([reviewPromise, offPromise]);

		expect(planDisplayedBeforeRelease).toBe(true);
		expect(offSettledBeforeRelease).toBe(false);
		expect(pushSignal).toBeDefined();
		expect(pushSignal?.aborted).toBe(false);
		expect(reviewResult.status).toBe("fulfilled");
		expect(offResult.status).toBe("fulfilled");
		expect(
			harness.notifications.some(notification =>
				notification.message.startsWith("Contribution candidate was pushed; review handoff preserved."),
			),
		).toBe(true);
		expect(harness.notifications.some(notification => notification.message === "Contribution mode stopped.")).toBe(
			false,
		);
		await commandRequired(harness, "contribute").handler("status", harness.ctx);
		expect(harness.notifications.at(-1)?.message).toStartWith("Contribution review ready:");
	});

	for (const transition of ["session_before_switch", "session_before_branch", "session_before_tree"] as const) {
		it(`cancels ${transition} immediately while an immutable publication settles`, async () => {
			const harness = createIntegrationHarness(cwd.path(), { confirmAnswers: [true, true, true] });
			await startContribution(harness);
			await prepareKeptContribution(harness, cwd.path());
			const transportApplied = Promise.withResolvers<void>();
			const releaseTransport = Promise.withResolvers<void>();
			let pushSignal: AbortSignal | undefined;
			vi.spyOn(git, "push").mockImplementation(async (_workDir, options) => {
				pushSignal = options?.signal;
				transportApplied.resolve();
				await releaseTransport.promise;
			});

			const reviewPromise = commandRequired(harness, "contribute").handler("review", harness.ctx);
			await transportApplied.promise;
			const planDisplayedBeforeRelease = harness.notifications.some(notification =>
				notification.message.startsWith("Contribution publication plan (push outcome pending):"),
			);
			let transitionResult: { cancel?: boolean } | undefined;
			let transitionSettled = false;
			const transitionPromise = (
				transition === "session_before_switch"
					? Promise.resolve(
							handlerRequired<SessionBeforeSwitchEvent, { cancel?: boolean }>(harness, transition)(
								{
									type: "session_before_switch",
									transitionId: `${transition}-publication`,
									reason: "resume",
									targetSessionFile: "/tmp/publication-switch.jsonl",
								},
								harness.ctx as ExtensionContext,
							),
						)
					: transition === "session_before_branch"
						? Promise.resolve(
								handlerRequired<SessionBeforeBranchEvent, { cancel?: boolean }>(harness, transition)(
									{
										type: "session_before_branch",
										transitionId: `${transition}-publication`,
										entryId: "publication-source",
									},
									harness.ctx as ExtensionContext,
								),
							)
						: Promise.resolve(
								handlerRequired<SessionBeforeTreeEvent, { cancel?: boolean }>(harness, transition)(
									{
										type: "session_before_tree",
										transitionId: `${transition}-publication`,
										preparation: {
											targetId: "publication-target",
											oldLeafId: "publication-source",
											commonAncestorId: "root",
											entriesToSummarize: [],
											userWantsSummary: false,
										},
										signal: new AbortController().signal,
									},
									harness.ctx as ExtensionContext,
								),
							)
			).then(async result => {
				transitionResult = result ?? undefined;
				const kind =
					transition === "session_before_switch"
						? "switch"
						: transition === "session_before_branch"
							? "branch"
							: "tree";
				await handlerRequired<{
					type: "session_transition_end";
					transitionId: string;
					kind: "switch" | "branch" | "tree";
					committed: boolean;
				}>(harness, "session_transition_end")(
					{
						type: "session_transition_end",
						transitionId: `${transition}-publication`,
						kind,
						committed: false,
					},
					harness.ctx as ExtensionContext,
				);
			});
			void transitionPromise.finally(() => {
				transitionSettled = true;
			});
			for (let turn = 0; turn < 4; turn++) await Promise.resolve();
			const transitionSettledBeforeRelease = transitionSettled;

			releaseTransport.resolve();
			const [reviewResult, settledTransition] = await Promise.allSettled([reviewPromise, transitionPromise]);

			expect(planDisplayedBeforeRelease).toBe(true);
			expect(transitionSettledBeforeRelease).toBe(true);
			expect(transitionResult).toEqual({ cancel: true });
			expect(pushSignal).toBeDefined();
			expect(pushSignal?.aborted).toBe(false);
			expect(reviewResult.status).toBe("fulfilled");
			expect(settledTransition.status).toBe("fulfilled");
			expect(
				harness.notifications.some(notification => notification.message.startsWith("Immutable SHA review:")),
			).toBe(true);
		});
	}

	it("returns from shutdown without waiting for a push after pre-displaying the deterministic handoff", async () => {
		const harness = createIntegrationHarness(cwd.path(), { confirmAnswers: [true, true, true] });
		await startContribution(harness);
		await prepareKeptContribution(harness, cwd.path());
		const transportApplied = Promise.withResolvers<void>();
		const releaseTransport = Promise.withResolvers<void>();
		let pushSignal: AbortSignal | undefined;
		vi.spyOn(git, "push").mockImplementation(async (_workDir, options) => {
			pushSignal = options?.signal;
			transportApplied.resolve();
			await releaseTransport.promise;
		});

		const reviewPromise = commandRequired(harness, "contribute").handler("review", harness.ctx);
		await transportApplied.promise;
		const planDisplayedBeforeShutdown = harness.notifications.some(notification =>
			notification.message.startsWith("Contribution publication plan (push outcome pending):"),
		);
		const durableIntentBeforeShutdown = harness.appendEntries.find(
			entry => entry.customType === "autoresearch-contribution-publication",
		);
		let shutdownSettled = false;
		const shutdownPromise = Promise.resolve(
			handlerRequired<SessionShutdownEvent>(harness, "session_shutdown")(
				{ type: "session_shutdown" } as SessionShutdownEvent,
				harness.ctx as ExtensionContext,
			),
		).finally(() => {
			shutdownSettled = true;
		});
		for (let turn = 0; turn < 4; turn++) await Promise.resolve();
		const shutdownSettledBeforeRelease = shutdownSettled;

		releaseTransport.resolve();
		const [reviewResult, shutdownResult] = await Promise.allSettled([reviewPromise, shutdownPromise]);

		expect(planDisplayedBeforeShutdown).toBe(true);
		expect(durableIntentBeforeShutdown?.data).toMatchObject({
			phase: "intent",
			candidateHead: CURRENT_HEAD,
			remoteUrl: FORK_URL,
		});
		expect(shutdownSettledBeforeRelease).toBe(true);
		expect(pushSignal).toBeDefined();
		expect(pushSignal?.aborted).toBe(false);
		expect(reviewResult.status).toBe("fulfilled");
		expect(shutdownResult.status).toBe("fulfilled");
	});

	it("reconciles a durable publication intent after restart without retrying the push", async () => {
		const harness = createIntegrationHarness(cwd.path(), { publishedRefSha: CURRENT_HEAD });
		const remote = validateContributionForkRemote(FORK_URL);
		const goal = makeGoal();
		const candidate = makeCandidate({ scenario: "", description: "" });
		const baseProof = makeBaseProof();
		const prDraft = buildContributionPrDraft(goal, candidate, remote, CONTRIBUTION_BRANCH, baseProof);
		const reviewUrl = buildContributionReviewUrl(remote, baseProof.baseSha, candidate.commit);
		const compareUrl = buildContributionCompareUrl(remote, CONTRIBUTION_BRANCH);
		harness.setSessionBranch([
			{
				type: "custom",
				customType: "autoresearch-contribution-publication",
				id: "durable-publication-intent",
				parentId: null,
				timestamp: new Date(0).toISOString(),
				data: {
					phase: "intent",
					remoteName: "origin",
					remoteUrl: FORK_URL,
					pushRemoteUrl: FORK_URL,
					branchName: CONTRIBUTION_BRANCH,
					targetRef: `refs/heads/${CONTRIBUTION_BRANCH}`,
					refspec: `${CURRENT_HEAD}:refs/heads/${CONTRIBUTION_BRANCH}`,
					candidateHead: CURRENT_HEAD,
					baseSha: baseProof.baseSha,
					reviewUrl,
					compareUrl,
					prDraft,
				},
			},
		]);

		await commandRequired(harness, "contribute").handler("status", harness.ctx);

		expect(harness.pushes).toEqual([]);
		expect(harness.githubEndpoints).toContain(
			`/repos/alice/oh-my-pi/git/ref/heads/${encodeURIComponent(CONTRIBUTION_BRANCH)}`,
		);
		expect(harness.notifications.at(-1)?.message).toStartWith("Contribution publication recovered:");
		expect(harness.notifications.at(-1)?.message).toContain(reviewUrl);
		expect(harness.notifications.at(-1)?.message).toContain(CURRENT_HEAD);
	});

	it("preflight cancellation performs no discovery or filesystem/durable mutation", async () => {
		const harness = createIntegrationHarness(cwd.path(), { confirmAnswers: [false] });
		const initialTools = [...harness.activeTools];

		await startContribution(harness);

		expect(harness.confirmCalls).toEqual([
			expect.objectContaining({ title: "Inspect official contribution prerequisites?" }),
		]);
		expect(harness.githubEndpoints).toEqual([]);
		expect(harness.setModelCalls).toEqual([]);
		expect(harness.checkoutNewCalls).toEqual([]);
		expect(harness.activeTools).toEqual(initialTools);
		expect(harness.appendEntries).toEqual([]);
		expect(harness.sentUserMessages).toEqual([]);
		expect(snapshotStorageArtifacts(dbDir.path())).toEqual([]);
	});

	it("rejects contribution mode when the transcript is not persistent", async () => {
		const harness = createIntegrationHarness(cwd.path(), {
			confirmAnswers: [true, true],
			sessionFile: null,
		});

		await startContribution(harness);

		expect(harness.confirmCalls).toEqual([]);
		expect(harness.githubEndpoints).toEqual([]);
		expect(harness.checkoutNewCalls).toEqual([]);
		expect(harness.notifications.at(-1)).toMatchObject({
			type: "error",
			message: expect.stringContaining("persistent session"),
		});
	});

	it("refuses publication when the durable intent cannot be flushed", async () => {
		const harness = createIntegrationHarness(cwd.path(), {
			confirmAnswers: [true, true, true],
			flushFailureAt: 1,
		});
		await startContribution(harness);
		await prepareKeptContribution(harness, cwd.path());

		await commandRequired(harness, "contribute").handler("review", harness.ctx);

		expect(harness.pushes).toEqual([]);
		expect(harness.notifications.at(-1)).toMatchObject({
			type: "error",
			message: expect.stringContaining("persistence failed"),
		});
	});

	it("requests an explicit durable session flush after recording intent and before push", async () => {
		const harness = createIntegrationHarness(cwd.path(), { confirmAnswers: [true, true, true] });
		await startContribution(harness);
		await prepareKeptContribution(harness, cwd.path());

		await commandRequired(harness, "contribute").handler("review", harness.ctx);

		const publicationTimeline = harness.gitEvents.filter(event =>
			["append:intent", "flush:durable", "push"].includes(event),
		);
		expect(harness.appendEntries.some(entry => entry.customType === "autoresearch-contribution-publication")).toBe(
			true,
		);
		expect(harness.flushRequests).toEqual([{ durable: true }]);
		expect(publicationTimeline).toEqual(["append:intent", "flush:durable", "push"]);
	});

	it("final cancellation shows exact frozen provenance and branch but performs no mutation", async () => {
		const harness = createIntegrationHarness(cwd.path(), { confirmAnswers: [true, false] });
		const initialTools = [...harness.activeTools];

		await startContribution(harness);

		expect(harness.confirmCalls.map(call => call.title)).toEqual([
			"Inspect official contribution prerequisites?",
			"Start exact upstream contribution session?",
		]);
		const finalMessage = harness.confirmCalls[1]?.message ?? "";
		expect(finalMessage).toContain(COMMIT_SHA);
		expect(finalMessage).toContain(BLOB_SHA);
		expect(finalMessage).toContain(FORK_URL);
		expect(finalMessage).toMatch(/autoresearch\/contribute-faster-contributor-loop-\d{8}/);
		expect(finalMessage).toMatch(/uncapped/i);
		expect(finalMessage).toMatch(/subscription quota/i);
		expect(finalMessage).toMatch(/token/i);
		expect(finalMessage).toMatch(/api charges?/i);
		expect(finalMessage).toMatch(/no estimate/i);
		expect(finalMessage).toMatch(/no cap/i);
		expect(harness.setModelCalls).toEqual([]);
		expect(harness.checkoutNewCalls).toEqual([]);
		expect(harness.activeTools).toEqual(initialTools);
		expect(harness.appendEntries).toEqual([]);
		expect(harness.sentUserMessages).toEqual([]);
		expect(snapshotStorageArtifacts(dbDir.path())).toEqual([]);
	});
	for (const invalidation of ["off", "session switch"] as const) {
		it(`invalidates a confirmed start during final confirmation on ${invalidation} without mutation`, async () => {
			let harness!: IntegrationHarness;
			let beforeSwitch: Promise<{ cancel?: boolean } | undefined> | undefined;
			harness = createIntegrationHarness(cwd.path(), {
				async onConfirm(callNumber): Promise<void> {
					if (callNumber !== 2) return;
					if (invalidation === "off") {
						await commandRequired(harness, "contribute").handler("off", harness.ctx);
						return;
					}
					beforeSwitch = Promise.resolve(
						handlerRequired<SessionBeforeSwitchEvent, { cancel?: boolean }>(harness, "session_before_switch")(
							{
								type: "session_before_switch",
								transitionId: "final-confirm-switch",
								reason: "resume",
								targetSessionFile: "/tmp/switched.jsonl",
							},
							harness.ctx as ExtensionContext,
						),
					).then(result => result ?? undefined);
				},
			});
			const initialTools = [...harness.activeTools];
			const initialModel = harness.currentModel();

			await startContribution(harness);
			if (invalidation === "session switch") {
				if (!beforeSwitch) throw new Error("Expected session-before-switch handler to start");
				expect(await beforeSwitch).toEqual({ cancel: true });
				await handlerRequired<{
					type: "session_transition_end";
					transitionId: string;
					kind: "switch";
					committed: boolean;
				}>(harness, "session_transition_end")(
					{
						type: "session_transition_end",
						transitionId: "final-confirm-switch",
						kind: "switch",
						committed: false,
					},
					harness.ctx as ExtensionContext,
				);
			}

			expect(harness.confirmCalls.at(-1)?.title).toBe("Start exact upstream contribution session?");
			expect(harness.setModelCalls).toEqual([]);
			expect(harness.checkoutNewCalls).toEqual([]);
			expect(harness.currentBranch()).toBe("main");
			expect(harness.currentModel()).toBe(initialModel);
			expect(harness.activeTools).toEqual(initialTools);
			expect(harness.sentUserMessages).toEqual([]);
			expect(snapshotStorageArtifacts(dbDir.path())).toEqual([]);
		});
	}

	it("cancels a session transition immediately while contribution activation rolls back", async () => {
		const rollbackEntered = Promise.withResolvers<void>();
		const releaseRollback = Promise.withResolvers<void>();
		const priorModel = requiredBundledModel("anthropic", "claude-sonnet-4-5");
		const selectedModel = requiredBundledModel("anthropic", "claude-sonnet-4-6");
		let harness!: IntegrationHarness;
		let transitionResult: { cancel?: boolean } | undefined;
		let transitionSettled = false;
		let transitionPromise: Promise<void> | null = null;
		harness = createIntegrationHarness(cwd.path(), {
			currentModel: priorModel,
			selectedModelId: selectedModel.id,
			async onSetModel(callNumber): Promise<void> {
				if (callNumber === 1) {
					transitionPromise = Promise.resolve(
						handlerRequired<SessionBeforeSwitchEvent, { cancel?: boolean }>(harness, "session_before_switch")(
							{
								type: "session_before_switch",
								transitionId: "activation-switch",
								reason: "resume",
								targetSessionFile: "/tmp/activation-switch.jsonl",
							},
							harness.ctx as ExtensionContext,
						),
					).then(async result => {
						transitionResult = result ?? undefined;
						await handlerRequired<{
							type: "session_transition_end";
							transitionId: string;
							kind: "switch";
							committed: boolean;
						}>(harness, "session_transition_end")(
							{
								type: "session_transition_end",
								transitionId: "activation-switch",
								kind: "switch",
								committed: false,
							},
							harness.ctx as ExtensionContext,
						);
						transitionSettled = true;
					});
				} else if (callNumber === 2) {
					rollbackEntered.resolve();
					await releaseRollback.promise;
				}
			},
		});

		const startPromise = startContribution(harness);
		await rollbackEntered.promise;
		for (let turn = 0; turn < 4; turn++) await Promise.resolve();
		const transitionSettledBeforeRollback = transitionSettled;
		const transitionResultBeforeRollback = transitionResult;

		releaseRollback.resolve();
		const startedTransition = transitionPromise as Promise<void> | null;
		if (!startedTransition) throw new Error("Expected session transition to start during model activation");
		const [startResult, settledTransition] = await Promise.allSettled([startPromise, startedTransition]);

		expect(transitionSettledBeforeRollback).toBe(true);
		expect(transitionResultBeforeRollback).toEqual({ cancel: true });
		expect(startResult.status).toBe("fulfilled");
		expect(settledTransition.status).toBe("fulfilled");
		expect(harness.currentModel()).toBe(priorModel);
		expect(harness.currentBranch()).toBe("main");
		expect(harness.activeTools).toEqual(["read", "bash"]);
		expect(harness.sentUserMessages).toEqual([]);
		expect(snapshotStorageArtifacts(dbDir.path())).toEqual([]);
	});

	for (const invalidationPoint of ["setModel", "checkout", "tool activation"] as const) {
		it(`rolls back only owned start mutations when stopped during awaited ${invalidationPoint}`, async () => {
			const priorModel = requiredBundledModel("anthropic", "claude-sonnet-4-5");
			const selectedModel = requiredBundledModel("anthropic", "claude-sonnet-4-6");
			let harness!: IntegrationHarness;
			let offPromise: Promise<void> | null = null;
			const invalidate = (callNumber: number): void => {
				if (callNumber === 1) {
					offPromise = commandRequired(harness, "contribute").handler("off", harness.ctx);
				}
			};
			harness = createIntegrationHarness(cwd.path(), {
				currentModel: priorModel,
				selectedModelId: selectedModel.id,
				onSetModel: invalidationPoint === "setModel" ? invalidate : undefined,
				onCheckoutNewAt: invalidationPoint === "checkout" ? invalidate : undefined,
				onSetActiveTools: invalidationPoint === "tool activation" ? invalidate : undefined,
			});

			await startContribution(harness);
			const startedOff = offPromise as Promise<void> | null;
			if (!startedOff) throw new Error("Expected contribution off during activation");
			await startedOff;

			expect(harness.currentModel()).toBe(priorModel);
			expect(harness.currentBranch()).toBe("main");
			expect(harness.activeTools).toEqual(["read", "bash"]);
			expect(harness.sentUserMessages).toEqual([]);
			expect(snapshotStorageArtifacts(dbDir.path())).toEqual([]);
			await commandRequired(harness, "contribute").handler("status", harness.ctx);
			expect(harness.notifications.at(-1)?.message).toBe("Contribution mode is off.");
		});
	}

	it("cancels post-confirm goal drift before model, branch, tool, runtime, or SQLite mutation", async () => {
		const initial = defaultGoalVersions()[0]!;
		const driftedContent = "# Drifted official goal\n\nChanged after approval.\n";
		const harness = createIntegrationHarness(cwd.path(), {
			goalVersions: [
				initial,
				{
					commitSha: "9".repeat(40),
					treeSha: "8".repeat(40),
					blobSha: "7".repeat(40),
					content: driftedContent,
				},
			],
		});
		const initialTools = [...harness.activeTools];

		await startContribution(harness);

		expect(harness.confirmCalls.map(call => call.title)).toEqual([
			"Inspect official contribution prerequisites?",
			"Start exact upstream contribution session?",
		]);
		expect(harness.githubEndpoints.filter(endpoint => endpoint.includes("/git/ref/heads/"))).toHaveLength(2);
		expect(harness.notifications.at(-1)).toMatchObject({
			type: "error",
			message: expect.stringContaining("goal_changed"),
		});
		expect(harness.setModelCalls).toEqual([]);
		expect(harness.checkoutNewCalls).toEqual([]);
		expect(harness.activeTools).toEqual(initialTools);
		expect(harness.sentUserMessages).toEqual([]);
		expect(snapshotStorageArtifacts(dbDir.path())).toEqual([]);
	});

	it("defaults to the current authenticated model and rechecks the exact base before fresh checkout", async () => {
		const harness = createIntegrationHarness(cwd.path());
		const priorModel = harness.currentModel();

		await startContribution(harness);

		expect(harness.selectCalls.map(call => call.title)).toEqual([
			"Select authenticated contribution model",
			"Select GitHub fork publication remote",
		]);
		expect(harness.selectCalls[0]?.labels).toEqual(["anthropic/claude-sonnet-4-5", "anthropic/claude-sonnet-4-6"]);
		expect(harness.setModelCalls).toEqual(priorModel ? [priorModel] : []);
		expect(harness.checkoutNewCalls).toHaveLength(1);
		const branch = harness.checkoutNewCalls[0] ?? "";
		expect(harness.confirmCalls[1]?.message).toContain(branch);
		expect(harness.currentBranch()).toBe(branch);
		expect(harness.activeTools).toEqual([
			"read",
			"bash",
			"init_experiment",
			"run_experiment",
			"log_experiment",
			"update_notes",
		]);
		expect(harness.sentUserMessages).toEqual(["Faster contributor loop"]);
		expect(harness.appendEntries).toEqual([]);
		expect(harness.approvalModeMutations).toEqual([]);
		expect(snapshotStorageArtifacts(dbDir.path())).toEqual([]);
		expect(
			harness.githubArgumentVectors.every(args => {
				const hostnameIndex = args.indexOf("--hostname");
				return args[hostnameIndex + 1] === OFFICIAL_CONTRIBUTION_HOST;
			}),
		).toBe(true);

		const finalConfirmIndex = harness.gitEvents.indexOf("confirm:2");
		const postConfirmStatusIndex = harness.gitEvents.findIndex(
			(event, index) => index > finalConfirmIndex && event.startsWith("status:"),
		);
		const postConfirmHeadIndex = harness.gitEvents.findIndex(
			(event, index) => index > finalConfirmIndex && event.startsWith("head:"),
		);
		const checkoutIndex = harness.gitEvents.indexOf(`checkoutNewAt:${branch}:${COMMIT_SHA}`);
		expect(postConfirmStatusIndex).toBeGreaterThan(finalConfirmIndex);
		expect(postConfirmHeadIndex).toBeGreaterThan(finalConfirmIndex);
		expect(checkoutIndex).toBeGreaterThan(postConfirmStatusIndex);
		expect(checkoutIndex).toBeGreaterThan(postConfirmHeadIndex);
	});

	it("creates only a fresh dedicated uncapped session with the official goal", async () => {
		const harness = createIntegrationHarness(cwd.path());
		await startContribution(harness);
		await Bun.write(`${cwd.path()}/autoresearch.sh`, "#!/usr/bin/env bash\necho METRIC runtime_ms=1\n");
		const init = harness.tools.get("init_experiment");
		if (!init) throw new Error("Expected init_experiment tool");

		const result = await init.execute(
			"init-contribution",
			{
				name: "official contribution",
				goal: "attempted override",
				primary_metric: "runtime_ms",
				max_iterations: 1,
			},
			undefined,
			undefined,
			harness.ctx as ExtensionContext,
		);
		const details = result.details as InitContributionDetails | undefined;
		expect(details?.createdSession).toBe(true);
		expect(details?.state.maxExperiments).toBeNull();
		expect(details?.state.goal).toBe(GOAL_CONTENT);
		expect(details?.state.branch).toBe(harness.currentBranch());

		const storage = await openAutoresearchStorage(cwd.path());
		const session = storage.getActiveSessionForBranch(harness.currentBranch());
		expect(session).not.toBeNull();
		expect(session?.maxIterations).toBeNull();
		expect(session?.goal).toBe(GOAL_CONTENT);
	});

	it("rejects an inactive ordinary init before contribution startup activation", async () => {
		const harness = createIntegrationHarness(cwd.path());
		harness.setCurrentBranch("autoresearch/ordinary");
		await Bun.write(`${cwd.path()}/autoresearch.sh`, "#!/usr/bin/env bash\necho METRIC runtime_ms=1\n");
		const init = harness.tools.get("init_experiment");
		if (!init) throw new Error("Expected init_experiment tool");
		let statusRequests = 0;
		harness.setStatusText(" M autoresearch.sh\0");
		harness.setNextStatusRequest(() => {
			statusRequests++;
		});

		const [initResult] = await Promise.allSettled([
			init.execute(
				"inactive-ordinary-before-contribution",
				{ name: "ordinary", primary_metric: "runtime_ms" },
				undefined,
				undefined,
				harness.ctx as ExtensionContext,
			),
		]);
		const statusRequestsBeforeStart = statusRequests;
		harness.setNextStatusRequest(() => {});
		const initialHead = await git.head.sha(cwd.path());
		harness.setCurrentBranch("main");
		harness.setStatusText("");
		const [startResult] = await Promise.allSettled([startContribution(harness)]);

		expect(initResult).toMatchObject({
			status: "rejected",
			reason: {
				name: "ToolAbortError",
				message: "Autoresearch mode is not active on the current branch.",
			},
		});
		expect(statusRequestsBeforeStart).toBe(0);
		expect(startResult.status).toBe("fulfilled");
		expect(await git.head.sha(cwd.path())).toBe(initialHead);
		expect(snapshotStorageArtifacts(dbDir.path())).toEqual([]);
		await expect(hasActiveAutoresearchSession(cwd.path())).resolves.toBe(false);
		await commandRequired(harness, "contribute").handler("status", harness.ctx);
		expect(harness.notifications.at(-1)?.message).toStartWith("Contribution running on ");
		expect(harness.activeTools).toEqual([
			"read",
			"bash",
			"init_experiment",
			"run_experiment",
			"log_experiment",
			"update_notes",
		]);
	});

	it("binds an ownerless ordinary init to its first authorized branch before mutation", async () => {
		const harness = createIntegrationHarness(cwd.path());
		const branchA = "autoresearch/ownerless-a";
		const branchB = "autoresearch/ownerless-b";
		harness.setCurrentBranch(branchA);
		harness.setSessionBranch([
			{
				type: "custom",
				customType: "autoresearch-control",
				id: "ownerless-branch-control",
				parentId: null,
				timestamp: new Date(0).toISOString(),
				data: { mode: "on", goal: "ownerless branch binding" },
			},
		]);
		const sessionStart = handlerRequired<SessionStartEvent>(harness, "session_start");
		await sessionStart({ type: "session_start" } as SessionStartEvent, harness.ctx as ExtensionContext);
		expect(harness.currentBranch()).toBe(branchA);
		expect(snapshotStorageArtifacts(dbDir.path())).toEqual([]);
		await expect(hasActiveAutoresearchSession(cwd.path())).resolves.toBe(false);
		expect(harness.activeTools).toEqual([
			"read",
			"bash",
			"init_experiment",
			"run_experiment",
			"log_experiment",
			"update_notes",
		]);
		await Bun.write(`${cwd.path()}/autoresearch.sh`, "#!/usr/bin/env bash\necho METRIC runtime_ms=1\n");
		harness.setStatusText(" M autoresearch.sh\0");
		let switchCount = 0;
		harness.setNextStatusRequest(() => {
			switchCount++;
			expect(harness.currentBranch()).toBe(branchA);
			harness.setCurrentBranch(branchB);
		});
		const stageSpy = vi.spyOn(git.stage, "files").mockResolvedValue();
		const commitSpy = vi.spyOn(git, "commit").mockResolvedValue({
			exitCode: 0,
			stdout: "",
			stderr: "",
		});
		const initialHead = await git.head.sha(cwd.path());
		const init = harness.tools.get("init_experiment");
		if (!init) throw new Error("Expected init_experiment tool");

		const [initResult] = await Promise.allSettled([
			init.execute(
				"ownerless-branch-switch",
				{ name: "ownerless branch", primary_metric: "runtime_ms" },
				undefined,
				undefined,
				harness.ctx as ExtensionContext,
			),
		]);

		expect(initResult).toMatchObject({
			status: "rejected",
			reason: {
				name: "ToolAbortError",
				message: "Autoresearch ownerless initialization changed branches before mutation.",
			},
		});
		expect(switchCount).toBe(1);
		expect(harness.currentBranch()).toBe(branchB);
		expect(stageSpy).not.toHaveBeenCalled();
		expect(commitSpy).not.toHaveBeenCalled();
		expect(await git.head.sha(cwd.path())).toBe(initialHead);
		expect(snapshotStorageArtifacts(dbDir.path())).toEqual([]);
		await expect(hasActiveAutoresearchSession(cwd.path())).resolves.toBe(false);
	});

	it("fails closed when contribution is stopped during initial init preparation", async () => {
		const harness = createIntegrationHarness(cwd.path());
		await startContribution(harness);
		await Bun.write(`${cwd.path()}/autoresearch.sh`, "#!/usr/bin/env bash\necho METRIC runtime_ms=1\n");
		const init = harness.tools.get("init_experiment");
		if (!init) throw new Error("Expected init_experiment tool");
		harness.setNextStatusRequest(async () => {
			await commandRequired(harness, "contribute").handler("off", harness.ctx);
		});

		await expect(
			init.execute(
				"stopped-initial",
				{ name: "initial", primary_metric: "runtime_ms" },
				undefined,
				undefined,
				harness.ctx as ExtensionContext,
			),
		).rejects.toThrow("authorization changed");
		expect(snapshotStorageArtifacts(dbDir.path())).toEqual([]);
		expect(harness.activeTools).toEqual(["read", "bash"]);
		await commandRequired(harness, "contribute").handler("status", harness.ctx);
		expect(harness.notifications.at(-1)?.message).toBe("Contribution mode is off.");
	});

	it("aborts and drains an in-flight harness commit before contribution off", async () => {
		const harness = createIntegrationHarness(cwd.path());
		await startContribution(harness);
		await Bun.write(`${cwd.path()}/autoresearch.sh`, "#!/usr/bin/env bash\necho METRIC runtime_ms=1\n");
		harness.setStatusText(" M autoresearch.sh\0");
		const init = harness.tools.get("init_experiment");
		if (!init) throw new Error("Expected init_experiment tool");
		let stageSignal: AbortSignal | undefined;
		let commitSignal: AbortSignal | undefined;
		let offPromise: Promise<void> | null = null;
		let offSettled = false;
		let statusDuringCommit: string | undefined;
		let offSettledDuringCommit = false;
		let stageAbortedDuringCommit = false;
		let commitAbortedDuringCommit = false;
		vi.spyOn(git.stage, "files").mockImplementation(async (_workDir, _files, signal) => {
			stageSignal = signal;
		});
		vi.spyOn(git, "commit").mockImplementation(async (_workDir, _message, options) => {
			commitSignal = options?.signal;
			offPromise = commandRequired(harness, "contribute")
				.handler("off", harness.ctx)
				.finally(() => {
					offSettled = true;
				});
			await commandRequired(harness, "contribute").handler("status", harness.ctx);
			statusDuringCommit = harness.notifications.at(-1)?.message;
			offSettledDuringCommit = offSettled;
			stageAbortedDuringCommit = stageSignal?.aborted ?? false;
			commitAbortedDuringCommit = commitSignal?.aborted ?? false;
			if (commitSignal?.aborted) {
				throw commitSignal.reason ?? new DOMException("Contribution init aborted", "AbortError");
			}
			harness.setHeadSha("9".repeat(40));
			return { exitCode: 0, stdout: "", stderr: "" };
		});

		const [initResult] = await Promise.allSettled([
			init.execute(
				"deferred-commit",
				{ name: "initial", primary_metric: "runtime_ms" },
				undefined,
				undefined,
				harness.ctx as ExtensionContext,
			),
		]);
		const startedOff = offPromise as Promise<void> | null;
		if (!startedOff) throw new Error("Expected contribution off to start during commit");
		const [offResult] = await Promise.allSettled([startedOff]);

		expect(statusDuringCommit).toStartWith("Contribution running on ");
		expect(offSettledDuringCommit).toBe(false);
		expect(stageAbortedDuringCommit).toBe(true);
		expect(commitAbortedDuringCommit).toBe(true);
		expect(initResult.status).toBe("rejected");
		expect(offResult.status).toBe("fulfilled");
		expect(await git.head.sha(cwd.path())).toBe(COMMIT_SHA);
		expect(snapshotStorageArtifacts(dbDir.path())).toEqual([]);
		await expect(hasActiveAutoresearchSession(cwd.path())).resolves.toBe(false);
	});

	it("fails closed when the process-local session switches during initial init preparation", async () => {
		const harness = createIntegrationHarness(cwd.path());
		await startContribution(harness);
		await Bun.write(`${cwd.path()}/autoresearch.sh`, "#!/usr/bin/env bash\necho METRIC runtime_ms=1\n");
		const init = harness.tools.get("init_experiment");
		if (!init) throw new Error("Expected init_experiment tool");
		harness.setNextStatusRequest(() => {
			harness.setSessionId("switched-session");
		});

		await expect(
			init.execute(
				"switched-initial",
				{ name: "initial", primary_metric: "runtime_ms" },
				undefined,
				undefined,
				harness.ctx as ExtensionContext,
			),
		).rejects.toThrow("authorization changed");
		expect(snapshotStorageArtifacts(dbDir.path())).toEqual([]);
		expect(harness.sentUserMessages).toEqual(["Faster contributor loop"]);
	});

	it("allows selection only from authenticated models and cancels cleanly when none exist", async () => {
		const noAuth = createIntegrationHarness(cwd.path(), { models: [], currentModel: undefined });
		await startContribution(noAuth);
		expect(noAuth.selectCalls).toEqual([]);
		expect(noAuth.setModelCalls).toEqual([]);
		expect(noAuth.checkoutNewCalls).toEqual([]);
		expect(
			noAuth.notifications.some(note => note.type === "error" && /authenticated model/i.test(note.message)),
		).toBe(true);
		expect(snapshotStorageArtifacts(dbDir.path())).toEqual([]);
	});

	it("fails an occupied post-confirm branch race without reusing or reallocating it", async () => {
		const harness = createIntegrationHarness(cwd.path(), { refExistsResults: [false, true] });

		await startContribution(harness);

		expect(harness.confirmCalls).toHaveLength(2);
		expect(harness.checkoutNewCalls).toEqual([]);
		expect(harness.setModelCalls).toEqual([]);
		const checkedRefs = harness.gitEvents.filter(event => event.startsWith("exists:refs/heads/"));
		expect(checkedRefs).toHaveLength(2);
		expect(new Set(checkedRefs).size).toBe(1);
		expect(
			harness.notifications.some(note => note.type === "error" && /branch|occupied|exists/i.test(note.message)),
		).toBe(true);
	});

	it("rolls back model, tools, branch, and fresh ref when post-confirm activation fails", async () => {
		const priorModel = requiredBundledModel("anthropic", "claude-sonnet-4-5");
		const selectedModel = requiredBundledModel("anthropic", "claude-sonnet-4-6");
		const harness = createIntegrationHarness(cwd.path(), {
			currentModel: priorModel,
			selectedModelId: selectedModel.id,
			setActiveToolsFailureAt: 1,
		});

		await startContribution(harness);

		expect(harness.setModelCalls.map(model => model.id)).toEqual([selectedModel.id, priorModel.id]);
		expect(harness.checkoutNewCalls).toHaveLength(1);
		expect(harness.checkoutCalls).toEqual(["main"]);
		expect(harness.deletedBranches).toEqual(harness.checkoutNewCalls);
		expect(harness.currentBranch()).toBe("main");
		expect(harness.currentModel()?.id).toBe(priorModel.id);
		expect(harness.activeTools).toEqual(["read", "bash"]);
		expect(harness.appendEntries).toEqual([]);
		expect(harness.sentUserMessages).toEqual([]);
		expect(harness.notifications.some(note => note.type === "error")).toBe(true);
	});

	it("restores the prior model when setModel mutates before rejecting", async () => {
		const priorModel = requiredBundledModel("anthropic", "claude-sonnet-4-5");
		const selectedModel = requiredBundledModel("anthropic", "claude-sonnet-4-6");
		const harness = createIntegrationHarness(cwd.path(), {
			currentModel: priorModel,
			selectedModelId: selectedModel.id,
			setModelFailureAt: 1,
		});

		await startContribution(harness);

		expect(harness.setModelCalls.map(model => model.id)).toEqual([selectedModel.id, priorModel.id]);
		expect(harness.currentModel()?.id).toBe(priorModel.id);
		expect(harness.checkoutNewCalls).toEqual([]);
		expect(harness.activeTools).toEqual(["read", "bash"]);
		expect(harness.notifications.some(note => note.type === "error")).toBe(true);
	});

	it("cannot forge reserved harness, tree, or invocation proof through harness ASI and log ASI", async () => {
		const harness = createIntegrationHarness(cwd.path(), { confirmAnswers: [true, true, true] });
		await startContribution(harness);
		const { session, storage } = await prepareInitializedContribution(harness, cwd.path());
		const run = harness.tools.get("run_experiment");
		const log = harness.tools.get("log_experiment");
		if (!run || !log) throw new Error("Expected contribution run and log tools");
		const spoofHarness = "7".repeat(64);
		const spoofTree = "8".repeat(40);
		const spoofInvocation = "9".repeat(64);
		let execution = 0;
		vi.spyOn(bashExecutor, "executeBash").mockImplementation(async () => {
			execution++;
			const passed = execution === 2;
			const output = [
				`ASI ${CONTRIBUTION_HARNESS_SHA256_ASI_KEY}=${spoofHarness}`,
				`ASI ${CONTRIBUTION_WORKTREE_TREE_ASI_KEY}=${spoofTree}`,
				`ASI ${CONTRIBUTION_INVOCATION_SHA256_ASI_KEY}=${spoofInvocation}`,
				...(passed ? ["METRIC runtime_ms=1"] : []),
			].join("\n");
			return {
				output,
				exitCode: passed ? 0 : 1,
				cancelled: false,
				truncated: false,
				totalLines: 4,
				totalBytes: Buffer.byteLength(output),
				outputLines: 4,
				outputBytes: Buffer.byteLength(output),
			};
		});
		vi.spyOn(git, "reset").mockResolvedValue();
		vi.spyOn(git, "clean").mockResolvedValue();

		await run.execute("spoofed-red", { timeout_seconds: 1 }, undefined, undefined, harness.ctx as ExtensionContext);
		await log.execute(
			"log-spoofed-red",
			{
				status: "checks_failed",
				metric: 0,
				description: "red proof with spoofed reserved ASI",
				asi: {
					[CONTRIBUTION_HARNESS_SHA256_ASI_KEY]: spoofHarness,
					[CONTRIBUTION_WORKTREE_TREE_ASI_KEY]: spoofTree,
					[CONTRIBUTION_INVOCATION_SHA256_ASI_KEY]: spoofInvocation,
				},
			},
			undefined,
			undefined,
			harness.ctx as ExtensionContext,
		);
		await run.execute("spoofed-green", { timeout_seconds: 2 }, undefined, undefined, harness.ctx as ExtensionContext);
		await log.execute(
			"log-spoofed-green",
			{
				status: "keep",
				metric: 1,
				description: "green proof with spoofed reserved ASI",
				asi: {
					[CONTRIBUTION_HARNESS_SHA256_ASI_KEY]: spoofHarness,
					[CONTRIBUTION_WORKTREE_TREE_ASI_KEY]: spoofTree,
					[CONTRIBUTION_INVOCATION_SHA256_ASI_KEY]: spoofInvocation,
				},
			},
			undefined,
			undefined,
			harness.ctx as ExtensionContext,
		);
		await commandRequired(harness, "contribute").handler("review", harness.ctx);
		const [red, green] = storage.listLoggedRuns(session.id);

		for (const row of [red, green]) {
			expect(row?.parsedAsi?.[CONTRIBUTION_HARNESS_SHA256_ASI_KEY]).not.toBe(spoofHarness);
			expect(row?.parsedAsi?.[CONTRIBUTION_WORKTREE_TREE_ASI_KEY]).not.toBe(spoofTree);
			expect(row?.parsedAsi?.[CONTRIBUTION_INVOCATION_SHA256_ASI_KEY]).not.toBe(spoofInvocation);
		}
		expect(red?.parsedAsi?.[CONTRIBUTION_INVOCATION_SHA256_ASI_KEY]).not.toBe(
			green?.parsedAsi?.[CONTRIBUTION_INVOCATION_SHA256_ASI_KEY],
		);
		expect(harness.pushes).toEqual([]);

		expect(harness.notifications.at(-1)).toMatchObject({
			type: "error",
			message: expect.stringContaining("TDD"),
		});
	});

	it("rejects a flaky red and green result executed against the same worktree tree", async () => {
		await initializeRealContributionRepository(cwd.path());
		const harness = createIntegrationHarness(cwd.path(), { confirmAnswers: [true, true, true] });
		await startContribution(harness);
		const { session, storage } = await prepareInitializedContribution(harness, cwd.path());
		const run = harness.tools.get("run_experiment");
		const log = harness.tools.get("log_experiment");
		if (!run || !log) throw new Error("Expected contribution run and log tools");
		let execution = 0;
		vi.spyOn(bashExecutor, "executeBash").mockImplementation(async () => {
			execution++;
			const passed = execution === 2;
			return {
				output: passed ? "METRIC runtime_ms=1" : "focused scenario failed",
				exitCode: passed ? 0 : 1,
				cancelled: false,
				truncated: false,
				totalLines: 1,
				totalBytes: 23,
				outputLines: 1,
				outputBytes: 23,
			};
		});

		await run.execute("same-tree-red", {}, undefined, undefined, harness.ctx as ExtensionContext);
		await log.execute(
			"same-tree-red-log",
			{ status: "checks_failed", metric: 0, description: "same tree failed once" },
			undefined,
			undefined,
			harness.ctx as ExtensionContext,
		);
		await run.execute("same-tree-green", {}, undefined, undefined, harness.ctx as ExtensionContext);
		await log.execute(
			"same-tree-green-log",
			{ status: "keep", metric: 1, description: "same tree passed once" },
			undefined,
			undefined,
			harness.ctx as ExtensionContext,
		);
		const [red, green] = storage.listLoggedRuns(session.id);

		await commandRequired(harness, "contribute").handler("review", harness.ctx);

		expect(red).toMatchObject({ status: "checks_failed", exitCode: 1, timedOut: false });
		expect(green).toMatchObject({ status: "keep", exitCode: 0, timedOut: false });
		expect(red?.parsedAsi?.[CONTRIBUTION_WORKTREE_TREE_ASI_KEY]).toMatch(/^[0-9a-f]{40,64}$/);
		expect(red?.parsedAsi?.[CONTRIBUTION_WORKTREE_TREE_ASI_KEY]).toBe(
			green?.parsedAsi?.[CONTRIBUTION_WORKTREE_TREE_ASI_KEY],
		);
		expect(harness.pushes).toEqual([]);
		expect(harness.notifications.at(-1)).toMatchObject({
			type: "error",
			message: expect.stringContaining("TDD"),
		});
	});

	for (const testCase of [
		{ name: "the kept candidate benchmark failed", options: { candidateExitCode: 1 } },
		{ name: "the prior failing proof is missing", options: { redProof: "missing" as const } },
		{ name: "the prior checks_failed proof actually passed", options: { redProof: "passing" as const } },
		{ name: "the prior failing proof is flagged", options: { redProof: "flagged" as const } },
		{ name: "the proof harness identity is missing", options: { harnessProof: "missing" as const } },
		{ name: "the proof harness changed between red and green", options: { harnessProof: "changed" as const } },
		{ name: "the effective invocation identity is missing", options: { invocationProof: "missing" as const } },
		{
			name: "red and green use different effective timeout configuration",
			options: { invocationProof: "timeout-changed" as const },
		},
		{
			name: "red and green use different effective command invocation configuration",
			options: { invocationProof: "config-changed" as const },
		},
		{
			name: "red and green use the same tested worktree tree",
			options: { redTreeProof: "same" as const },
		},
	] as const) {
		it(`rejects publication when ${testCase.name}`, async () => {
			const harness = createIntegrationHarness(cwd.path(), { confirmAnswers: [true, true, true] });
			await startContribution(harness);
			await prepareKeptContribution(harness, cwd.path(), testCase.options);

			await commandRequired(harness, "contribute").handler("review", harness.ctx);

			expect(harness.pushes).toEqual([]);
			expect(harness.notifications.at(-1)).toMatchObject({
				type: "error",
				message: expect.stringContaining("TDD"),
			});
		});
	}

	it("rejects an orphan candidate before displaying contribution review", async () => {
		const harness = createIntegrationHarness(cwd.path(), { ancestryResults: [false] });
		await startContribution(harness);
		await prepareKeptContribution(harness, cwd.path());
		const confirmationsBeforeReview = harness.confirmCalls.length;

		await commandRequired(harness, "contribute").handler("review", harness.ctx);

		expect(harness.confirmCalls).toHaveLength(confirmationsBeforeReview);
		expect(harness.pushes).toEqual([]);
		expect(harness.gitEvents).toContain(`ancestor:${COMMIT_SHA}:${CURRENT_HEAD}`);
		expect(harness.notifications.at(-1)).toMatchObject({
			type: "error",
			message: expect.stringContaining("candidate_not_descendant"),
		});
	});

	it("rechecks candidate ancestry after review approval and immediately before push", async () => {
		const harness = createIntegrationHarness(cwd.path(), {
			confirmAnswers: [true, true, true],
			ancestryResults: [true, false],
		});
		await startContribution(harness);
		await prepareKeptContribution(harness, cwd.path());

		await commandRequired(harness, "contribute").handler("review", harness.ctx);

		expect(harness.confirmCalls.at(-1)?.title).toBe("Push exact contribution candidate for review?");
		expect(harness.pushes).toEqual([]);
		expect(harness.gitEvents.filter(event => event === `ancestor:${COMMIT_SHA}:${CURRENT_HEAD}`)).toHaveLength(2);
		expect(harness.notifications.at(-1)).toMatchObject({
			type: "error",
			message: expect.stringContaining("candidate_not_descendant"),
		});
	});
	it("aborts and drains review preparation before off can close its session", async () => {
		const harness = createIntegrationHarness(cwd.path(), { confirmAnswers: [true, true, true] });
		await startContribution(harness);
		await prepareKeptContribution(harness, cwd.path());
		const reviewReadEntered = Promise.withResolvers<void>();
		const releaseReviewRead = Promise.withResolvers<void>();
		let reviewSignal: AbortSignal | undefined;
		vi.spyOn(git.branch, "current").mockImplementation(async (_workDir, signal) => {
			reviewSignal = signal;
			reviewReadEntered.resolve();
			await releaseReviewRead.promise;
			if (signal?.aborted) throw signal.reason ?? new DOMException("Review preparation invalidated", "AbortError");
			return harness.currentBranch();
		});

		let reviewSettled = false;
		const reviewPromise = commandRequired(harness, "contribute")
			.handler("review", harness.ctx)
			.finally(() => {
				reviewSettled = true;
			});
		await reviewReadEntered.promise;
		let offSettled = false;
		const offPromise = commandRequired(harness, "contribute")
			.handler("off", harness.ctx)
			.finally(() => {
				offSettled = true;
			});
		for (let turn = 0; turn < 4; turn++) await Promise.resolve();
		const reviewSettledBeforeRelease = reviewSettled;
		const offSettledBeforeRelease = offSettled;
		const reviewSignalDefinedBeforeRelease = reviewSignal !== undefined;
		const reviewSignalAbortedBeforeRelease = reviewSignal?.aborted;

		releaseReviewRead.resolve();
		const [reviewResult, offResult] = await Promise.allSettled([reviewPromise, offPromise]);

		expect(reviewSettledBeforeRelease).toBe(false);
		expect(offSettledBeforeRelease).toBe(false);
		expect(reviewSignalDefinedBeforeRelease).toBe(true);
		expect(reviewSignalAbortedBeforeRelease).toBe(true);
		expect(reviewResult.status).toBe("fulfilled");
		expect(offResult.status).toBe("fulfilled");

		expect(harness.pushes).toEqual([]);
		expect(harness.activeTools).toEqual(["read", "bash"]);
		await commandRequired(harness, "contribute").handler("status", harness.ctx);
		expect(harness.notifications.at(-1)?.message).toBe("Contribution mode is off.");
	});

	it("aborts and drains a pending review confirmation before off settles", async () => {
		const reviewConfirmEntered = Promise.withResolvers<void>();
		const releaseReviewConfirm = Promise.withResolvers<void>();
		let reviewConfirmSignal: AbortSignal | undefined;
		const harness = createIntegrationHarness(cwd.path(), {
			confirmAnswers: [true, true, true],
			async onConfirm(_callNumber, title, signal) {
				if (title !== "Push exact contribution candidate for review?") return;
				reviewConfirmSignal = signal;
				reviewConfirmEntered.resolve();
				await releaseReviewConfirm.promise;
			},
		});
		await startContribution(harness);
		await prepareKeptContribution(harness, cwd.path());

		let reviewSettled = false;
		const reviewPromise = commandRequired(harness, "contribute")
			.handler("review", harness.ctx)
			.finally(() => {
				reviewSettled = true;
			});
		await reviewConfirmEntered.promise;
		let offSettled = false;
		const offPromise = commandRequired(harness, "contribute")
			.handler("off", harness.ctx)
			.finally(() => {
				offSettled = true;
			});
		for (let turn = 0; turn < 4; turn++) await Promise.resolve();
		const reviewSettledBeforeRelease = reviewSettled;
		const offSettledBeforeRelease = offSettled;
		const reviewSignalDefinedBeforeRelease = reviewConfirmSignal !== undefined;
		const reviewSignalAbortedBeforeRelease = reviewConfirmSignal?.aborted;

		releaseReviewConfirm.resolve();
		const [reviewResult, offResult] = await Promise.allSettled([reviewPromise, offPromise]);

		expect(reviewSettledBeforeRelease).toBe(false);
		expect(offSettledBeforeRelease).toBe(false);
		expect(reviewSignalDefinedBeforeRelease).toBe(true);
		expect(reviewSignalAbortedBeforeRelease).toBe(true);
		expect(reviewResult.status).toBe("fulfilled");
		expect(offResult.status).toBe("fulfilled");
		expect(harness.pushes).toEqual([]);
		await commandRequired(harness, "contribute").handler("status", harness.ctx);
		expect(harness.notifications.at(-1)?.message).toBe("Contribution mode is off.");
	});

	for (const race of [
		{ point: "fork verification", invalidation: "off" },
		{ point: "pre-push ancestry", invalidation: "session switch" },
	] as const) {
		it(`aborts review publication during ${race.point} on ${race.invalidation} with zero push`, async () => {
			let harness!: IntegrationHarness;
			let publicationSignal: AbortSignal | undefined;
			let invalidationPromise: Promise<void> | null = null;
			const invalidate = async (signal: AbortSignal | undefined): Promise<void> => {
				publicationSignal = signal;
				if (race.invalidation === "off") {
					invalidationPromise = commandRequired(harness, "contribute").handler("off", harness.ctx);
					return;
				}
				const result = await handlerRequired<SessionBeforeSwitchEvent, { cancel?: boolean }>(
					harness,
					"session_before_switch",
				)(
					{
						type: "session_before_switch",
						transitionId: "review-switch",
						reason: "resume",
						targetSessionFile: "/tmp/review-switched.jsonl",
					},
					harness.ctx as ExtensionContext,
				);
				expect(result).toEqual({ cancel: true });
				await handlerRequired<{
					type: "session_transition_end";
					transitionId: string;
					kind: "switch";
					committed: boolean;
				}>(harness, "session_transition_end")(
					{ type: "session_transition_end", transitionId: "review-switch", kind: "switch", committed: false },
					harness.ctx as ExtensionContext,
				);
				invalidationPromise = commandRequired(harness, "contribute").handler("off", harness.ctx);
			};
			harness = createIntegrationHarness(cwd.path(), {
				confirmAnswers: [true, true, true],
				async onForkMetadataRequest(_callNumber, signal): Promise<void> {
					if (race.point === "fork verification" && signal) await invalidate(signal);
				},
				async onAncestryRequest(callNumber, signal): Promise<void> {
					if (race.point === "pre-push ancestry" && callNumber === 2) await invalidate(signal);
				},
			});
			await startContribution(harness);
			await prepareKeptContribution(harness, cwd.path());

			await commandRequired(harness, "contribute").handler("review", harness.ctx);
			const startedInvalidation = invalidationPromise as Promise<void> | null;
			if (!startedInvalidation) throw new Error("Expected publication invalidation");
			await startedInvalidation;

			expect(publicationSignal).toBeDefined();
			expect(publicationSignal?.aborted).toBe(true);
			expect(harness.pushes).toEqual([]);
			await commandRequired(harness, "contribute").handler("status", harness.ctx);
			expect(harness.notifications.at(-1)?.message).toBe("Contribution mode is off.");
		});
	}

	it("pushes one exact kept candidate and creates only a human review handoff", async () => {
		const harness = createIntegrationHarness(cwd.path(), { confirmAnswers: [true, true, true] });
		await startContribution(harness);
		const session = await prepareKeptContribution(harness, cwd.path());
		const storage = await openAutoresearchStorage(cwd.path());

		await commandRequired(harness, "contribute").handler("review", harness.ctx);

		const branch = harness.currentBranch();
		expect(harness.pushes).toEqual([
			{
				remote: "origin",
				verifiedRemoteUrl: FORK_URL,
				refspec: `${CURRENT_HEAD}:refs/heads/${branch}`,
				forceWithLease: `refs/heads/${branch}:`,
			},
		]);
		expect(harness.confirmCalls.at(-1)?.message).toContain("Ran the focused contribution scenario.");
		expect(harness.confirmCalls.at(-1)?.message).toContain("Observed the focused scenario pass");
		expect(harness.confirmCalls.at(-1)?.message).toContain(CONTRIBUTION_HUMAN_SUMMARY_PLACEHOLDER);
		const reviewConfirmation = harness.confirmCalls.at(-1)?.message ?? "";
		expect(reviewConfirmation).toContain(`${CURRENT_HEAD}:refs/heads/${branch}`);
		expect(reviewConfirmation).not.toContain(`HEAD:refs/heads/${branch}`);
		expect(harness.activeTools).toEqual(["read", "bash"]);
		expect(storage.getSessionById(session.id)?.closedAt).not.toBeNull();
		expect(harness.githubEndpoints.every(endpoint => endpoint.startsWith("/repos/"))).toBe(true);
		expect(harness.gitEvents.filter(event => event === `ancestor:${COMMIT_SHA}:${CURRENT_HEAD}`)).toHaveLength(2);

		await commandRequired(harness, "contribute").handler("status", harness.ctx);
		expect(harness.notifications.at(-1)?.message).toContain("Contribution review ready:");
		const statusMessage = harness.notifications.at(-1)?.message ?? "";
		expect(statusMessage).toContain(
			`Immutable SHA review: https://github.com/${OFFICIAL_CONTRIBUTION_OWNER}/${OFFICIAL_CONTRIBUTION_REPO}/compare/${COMMIT_SHA}...alice:${CURRENT_HEAD}?expand=1`,
		);
		expect(statusMessage).toContain(
			`Mutable branch compare: https://github.com/${OFFICIAL_CONTRIBUTION_OWNER}/${OFFICIAL_CONTRIBUTION_REPO}/compare/main...alice:${encodeURIComponent(branch)}?expand=1`,
		);
		await commandRequired(harness, "contribute").handler("", harness.ctx);
		expect(harness.confirmCalls.at(-1)?.title).toBe("Inspect official contribution prerequisites?");
	});

	it("uses only the latest deliberate user turn and following assistant outcome to queue one contribution resume", async () => {
		const harness = createIntegrationHarness(cwd.path());
		await startContribution(harness);
		const agentEnd = handlerRequired<AgentEndEvent>(harness, "agent_end");
		harness.sentMessages.length = 0;
		const olderPause = terminalAgentEnd("stop", "need approval [CONTRIBUTE_PAUSE]").messages[0];
		const olderError = terminalAgentEnd("error", "failed before the user replied").messages[0];
		const latestSafe = terminalAgentEnd("stop", "completed the deliberate follow-up safely").messages[0];
		const currentPause = terminalAgentEnd("stop", "need new approval [CONTRIBUTE_PAUSE]").messages[0];
		if (!olderPause || !olderError || !latestSafe || !currentPause) throw new Error("Expected agent messages");
		const deliberateUser = {
			role: "user",
			content: [{ type: "text", text: "Continue after the earlier pause and error." }],
			timestamp: 1,
		};

		await agentEnd(
			{
				type: "agent_end",
				messages: [olderPause, olderError, deliberateUser, latestSafe],
			} as unknown as AgentEndEvent,
			harness.ctx as ExtensionContext,
		);
		expect(harness.sentMessages).toHaveLength(1);
		expect(harness.sentMessages[0]?.options).toEqual({ deliverAs: "nextTurn", triggerTurn: true });

		await agentEnd(
			{
				type: "agent_end",
				messages: [latestSafe, deliberateUser, currentPause],
			} as unknown as AgentEndEvent,
			harness.ctx as ExtensionContext,
		);
		expect(harness.sentMessages).toHaveLength(1);
	});

	it("continues indefinitely only for safe terminal contribution settles and stops on every guard", async () => {
		const harness = createIntegrationHarness(cwd.path());
		await startContribution(harness);
		const agentEnd = handlerRequired<AgentEndEvent>(harness, "agent_end");
		harness.sentMessages.length = 0;

		await agentEnd(terminalAgentEnd("stop"), harness.ctx as ExtensionContext);
		await agentEnd(terminalAgentEnd("stop"), harness.ctx as ExtensionContext);
		expect(harness.sentMessages).toHaveLength(2);

		await agentEnd({ ...terminalAgentEnd("stop"), willContinue: true }, harness.ctx as ExtensionContext);
		harness.setPendingMessages(true);
		await agentEnd(terminalAgentEnd("stop"), harness.ctx as ExtensionContext);
		harness.setPendingMessages(false);
		await agentEnd(terminalAgentEnd("aborted"), harness.ctx as ExtensionContext);
		await agentEnd(terminalAgentEnd("error"), harness.ctx as ExtensionContext);
		await agentEnd(terminalAgentEnd("stop", "pause now [CONTRIBUTE_PAUSE]"), harness.ctx as ExtensionContext);
		const earlierPause = terminalAgentEnd("stop", "pause before tool [CONTRIBUTE_PAUSE]").messages[0];
		const laterAssistant = terminalAgentEnd("stop", "tool completed").messages[0];
		if (!earlierPause || !laterAssistant) throw new Error("Expected assistant messages");
		await agentEnd({ type: "agent_end", messages: [earlierPause, laterAssistant] }, harness.ctx as ExtensionContext);
		expect(harness.sentMessages).toHaveLength(2);

		await commandRequired(harness, "contribute").handler("off", harness.ctx);
		await agentEnd(terminalAgentEnd("stop"), harness.ctx as ExtensionContext);
		expect(harness.sentMessages).toHaveLength(2);
		expect(harness.appendEntries).toEqual([]);
		expect(harness.approvalModeMutations).toEqual([]);
	});

	it("does not resume contribution after off wins an awaited agent-end branch lookup", async () => {
		const harness = createIntegrationHarness(cwd.path());
		await startContribution(harness);
		await preparePendingContribution(harness, cwd.path());
		harness.sentMessages.length = 0;
		const contributionBranch = harness.currentBranch();
		const branchLookupEntered = Promise.withResolvers<void>();
		const releaseBranchLookup = Promise.withResolvers<void>();
		let gateAgentEndLookup = true;
		vi.spyOn(git.branch, "current").mockImplementation(async () => {
			if (gateAgentEndLookup) {
				gateAgentEndLookup = false;
				branchLookupEntered.resolve();
				await releaseBranchLookup.promise;
			}
			return contributionBranch;
		});
		const agentEndPromise = handlerRequired<AgentEndEvent>(harness, "agent_end")(
			terminalAgentEnd("stop"),
			harness.ctx as ExtensionContext,
		);
		await branchLookupEntered.promise;

		await commandRequired(harness, "contribute").handler("off", harness.ctx);
		releaseBranchLookup.resolve();
		await agentEndPromise;

		expect(harness.sentMessages).toEqual([]);
		expect(harness.activeTools).toEqual(["read", "bash"]);
		expect(harness.widgetValues.at(-1)).toBeUndefined();
		await commandRequired(harness, "contribute").handler("status", harness.ctx);
		expect(harness.notifications.at(-1)?.message).toBe("Contribution mode is off.");
	});

	it("does not rebuild a stopped contribution from an in-flight before-agent-start lookup", async () => {
		const harness = createIntegrationHarness(cwd.path());
		await startContribution(harness);
		await preparePendingContribution(harness, cwd.path());
		const storageLookupEntered = Promise.withResolvers<void>();
		const releaseStorageLookup = Promise.withResolvers<void>();
		const realOpenAutoresearchStorageIfExists = autoresearchStorage.openAutoresearchStorageIfExists;
		let gateBeforeAgentStartLookup = true;
		vi.spyOn(autoresearchStorage, "openAutoresearchStorageIfExists").mockImplementation(async workDir => {
			const openedStorage = await realOpenAutoresearchStorageIfExists(workDir);
			if (gateBeforeAgentStartLookup) {
				gateBeforeAgentStartLookup = false;
				storageLookupEntered.resolve();
				await releaseStorageLookup.promise;
			}
			return openedStorage;
		});
		const beforeAgentStartPromise = handlerRequired<BeforeAgentStartEvent, { systemPrompt?: string[] }>(
			harness,
			"before_agent_start",
		)(
			{
				type: "before_agent_start",
				prompt: "continue",
				systemPrompt: ["base prompt"],
			},
			harness.ctx as ExtensionContext,
		);
		await storageLookupEntered.promise;

		await commandRequired(harness, "contribute").handler("off", harness.ctx);
		releaseStorageLookup.resolve();
		const beforeAgentStartResult = await beforeAgentStartPromise;

		expect(beforeAgentStartResult).toBeUndefined();
		expect(harness.activeTools).toEqual(["read", "bash"]);
		expect(harness.widgetValues.at(-1)).toBeUndefined();
		await commandRequired(harness, "contribute").handler("status", harness.ctx);
		expect(harness.notifications.at(-1)?.message).toBe("Contribution mode is off.");
	});

	it("drops process-local authentication and running state on shutdown/reopen", async () => {
		const harness = createIntegrationHarness(cwd.path());
		await startContribution(harness);
		const shutdown = handlerRequired<SessionShutdownEvent>(harness, "session_shutdown");
		await shutdown({ type: "session_shutdown" } as SessionShutdownEvent, harness.ctx as ExtensionContext);
		await commandRequired(harness, "contribute").handler("off", harness.ctx);
		expect(harness.appendEntries).toEqual([]);
		expect(harness.activeTools).toEqual(["read", "bash"]);

		createAutoresearchExtension(harness.api);
		const sessionStart = handlerRequired<SessionStartEvent>(harness, "session_start");
		await sessionStart({ type: "session_start" } as SessionStartEvent, harness.ctx as ExtensionContext);
		harness.sentMessages.length = 0;
		await handlerRequired<AgentEndEvent>(harness, "agent_end")(
			terminalAgentEnd("stop"),
			harness.ctx as ExtensionContext,
		);
		expect(harness.sentMessages).toEqual([]);
	});

	it("starts fresh ordinary autoresearch on branch B while branch A retains an active session", async () => {
		const harness = createIntegrationHarness(cwd.path());
		const branchA = "autoresearch/ordinary-fresh-a";
		const branchB = "autoresearch/ordinary-fresh-b";
		harness.setCurrentBranch(branchA);
		await commandRequired(harness, "autoresearch").handler("branch A goal", harness.ctx);
		await Bun.write(`${cwd.path()}/autoresearch.sh`, "#!/usr/bin/env bash\necho METRIC runtime_ms=1\n");
		const init = harness.tools.get("init_experiment");
		if (!init) throw new Error("Expected init_experiment tool");
		await init.execute(
			"branch-a-session",
			{ name: "branch A", primary_metric: "runtime_ms" },
			undefined,
			undefined,
			harness.ctx as ExtensionContext,
		);
		const storage = await openAutoresearchStorage(cwd.path());
		const sessionA = storage.getActiveSessionForBranch(branchA);
		if (!sessionA) throw new Error("Expected active branch A session");

		harness.setCurrentBranch(branchB);
		await commandRequired(harness, "autoresearch").handler("branch B goal", harness.ctx);
		const beforeAgentStart = handlerRequired<BeforeAgentStartEvent, { systemPrompt?: string[] }>(
			harness,
			"before_agent_start",
		);
		const promptOnB = await beforeAgentStart(
			{ type: "before_agent_start", prompt: "start branch B", systemPrompt: ["base prompt"] },
			harness.ctx as ExtensionContext,
		);
		const initB = await init.execute(
			"branch-b-session",
			{ name: "branch B", primary_metric: "runtime_ms" },
			undefined,
			undefined,
			harness.ctx as ExtensionContext,
		);

		expect(storage.getActiveSessionForBranch(branchA)?.id).toBe(sessionA.id);
		expect(storage.getActiveSessionForBranch(branchB)).not.toBeNull();
		expect(promptOnB?.systemPrompt?.[0]).toContain("branch B goal");
		expect(initB.details).toMatchObject({ createdSession: true });
		expect(harness.activeTools).toEqual([
			"read",
			"bash",
			"init_experiment",
			"run_experiment",
			"log_experiment",
			"update_notes",
		]);
	});

	it("leaves ordinary /autoresearch persistence, start behavior, and approval mode unchanged", async () => {
		const harness = createIntegrationHarness(cwd.path());
		await commandRequired(harness, "autoresearch").handler("reduce edit latency", harness.ctx);

		expect(harness.confirmCalls).toEqual([]);
		expect(harness.selectCalls).toEqual([]);
		expect(harness.githubEndpoints).toEqual([]);
		expect(harness.setModelCalls).toEqual([]);
		expect(harness.appendEntries).toEqual([
			{ customType: "autoresearch-control", data: { mode: "on", goal: "reduce edit latency" } },
		]);
		expect(harness.sentUserMessages).toEqual(["reduce edit latency"]);
		expect(harness.approvalModeMutations).toEqual([]);

		const activeTools = [...harness.activeTools];
		await commandRequired(harness, "contribute").handler("off", harness.ctx);
		expect(harness.activeTools).toEqual(activeTools);
		expect(harness.appendEntries).toEqual([
			{ customType: "autoresearch-control", data: { mode: "on", goal: "reduce edit latency" } },
		]);
	});

	for (const lifecycleCommand of ["off", "clear"] as const) {
		it(`aborts and drains an admitted ordinary mutation before /autoresearch ${lifecycleCommand} settles`, async () => {
			await initializeRealContributionRepository(cwd.path());
			const repositoryHead = (await $`git -C ${cwd.path()} rev-parse HEAD`.quiet()).text().trim();
			const harness = createIntegrationHarness(cwd.path());
			const branchA = "autoresearch/ordinary-lifecycle-a";
			const branchB = "autoresearch/ordinary-lifecycle-b";
			harness.setCurrentBranch(branchA);
			harness.setHeadSha(repositoryHead);
			await commandRequired(harness, "autoresearch").handler("branch A lifecycle goal", harness.ctx);
			const init = harness.tools.get("init_experiment");
			const updateNotes = harness.tools.get("update_notes");
			if (!init || !updateNotes) throw new Error("Expected ordinary autoresearch tools");
			await init.execute(
				`ordinary-${lifecycleCommand}-session`,
				{ name: "ordinary lifecycle", primary_metric: "runtime_ms", metric_unit: "ms" },
				undefined,
				undefined,
				harness.ctx as ExtensionContext,
			);
			const storage = await openAutoresearchStorage(cwd.path());
			const sessionA = storage.getActiveSessionForBranch(branchA);
			if (!sessionA) throw new Error("Expected initialized branch A session");
			const sessionB = storage.openSession({
				name: "unrelated branch B session",
				goal: "branch B remains open",
				primaryMetric: "runtime_ms",
				metricUnit: "ms",
				direction: "lower",
				preferredCommand: "bash autoresearch.sh",
				branch: branchB,
				baselineCommit: repositoryHead,
				maxIterations: null,
				scopePaths: [],
				offLimits: [],
				constraints: [],
				secondaryMetrics: [],
			});
			await Bun.write(`${cwd.path()}/source.ts`, "export const value = 'candidate';\n");
			const notesBefore = sessionA.notes;
			const mutationEntered = Promise.withResolvers<void>();
			const releaseMutation = Promise.withResolvers<void>();
			let mutationSignal: AbortSignal | undefined;
			vi.spyOn(git.branch, "current").mockImplementation(async (_workDir, signal) => {
				if (signal) {
					mutationSignal = signal;
					mutationEntered.resolve();
					await releaseMutation.promise;
					if (signal.aborted) {
						throw signal.reason ?? new DOMException("Ordinary notes mutation invalidated", "AbortError");
					}
				}
				return harness.currentBranch();
			});

			const settlementOrder: string[] = [];
			let mutationSettled = false;
			const mutationPromise = updateNotes
				.execute(
					`ordinary-notes-during-${lifecycleCommand}`,
					{ body: "stale notes must not publish" },
					undefined,
					undefined,
					harness.ctx as ExtensionContext,
				)
				.finally(() => {
					mutationSettled = true;
					settlementOrder.push("mutation");
				});
			await mutationEntered.promise;
			let commandSettled = false;
			const commandPromise = commandRequired(harness, "autoresearch")
				.handler(lifecycleCommand, harness.ctx)
				.finally(() => {
					commandSettled = true;
					settlementOrder.push("command");
				});
			for (let turn = 0; turn < 4; turn++) await Promise.resolve();

			const mutationSettledBeforeRelease = mutationSettled;
			const commandSettledBeforeRelease = commandSettled;
			const mutationSignalDefinedBeforeRelease = mutationSignal !== undefined;
			const mutationSignalAbortedBeforeRelease = mutationSignal?.aborted;

			releaseMutation.resolve();
			const [mutationResult, commandResult] = await Promise.allSettled([mutationPromise, commandPromise]);
			expect(mutationSettledBeforeRelease).toBe(false);
			expect(commandSettledBeforeRelease).toBe(false);
			expect(mutationSignalDefinedBeforeRelease).toBe(true);
			expect(mutationSignalAbortedBeforeRelease).toBe(true);
			expect(mutationResult).toMatchObject({ status: "rejected", reason: { name: "ToolAbortError" } });
			expect(commandResult.status).toBe("fulfilled");
			expect(settlementOrder.indexOf("mutation")).toBeLessThan(settlementOrder.indexOf("command"));
			expect(storage.getSessionById(sessionA.id)?.notes).toBe(notesBefore);
			expect(storage.getSessionById(sessionB.id)?.closedAt).toBeNull();
			expect(harness.activeTools).toEqual(["read", "bash"]);
			expect(harness.widgetValues.at(-1)).toBeUndefined();
			expect((await $`git -C ${cwd.path()} rev-parse HEAD`.quiet()).text().trim()).toBe(repositoryHead);
			if (lifecycleCommand === "clear") {
				expect(storage.getSessionById(sessionA.id)?.closedAt).not.toBeNull();
				expect(storage.getActiveSessionForBranch(branchA)).toBeNull();
				expect(await Bun.file(`${cwd.path()}/source.ts`).text()).toBe("export const value = 'baseline';\n");
				expect(harness.appendEntries.at(-1)).toEqual({
					customType: "autoresearch-control",
					data: { mode: "clear" },
				});
			} else {
				expect(storage.getSessionById(sessionA.id)?.closedAt).toBeNull();
				expect(storage.getActiveSessionForBranch(branchA)?.id).toBe(sessionA.id);
				expect(await Bun.file(`${cwd.path()}/source.ts`).text()).toBe("export const value = 'candidate';\n");
				expect(harness.appendEntries.at(-1)).toEqual({
					customType: "autoresearch-control",
					data: { mode: "off" },
				});
			}

			const settledState = {
				notes: storage.getSessionById(sessionA.id)?.notes,
				closedAt: storage.getSessionById(sessionA.id)?.closedAt,
				activeTools: [...harness.activeTools],
				widgetUpdates: harness.widgetUpdates,
				head: (await $`git -C ${cwd.path()} rev-parse HEAD`.quiet()).text().trim(),
			};
			for (let turn = 0; turn < 4; turn++) await Promise.resolve();
			expect({
				notes: storage.getSessionById(sessionA.id)?.notes,
				closedAt: storage.getSessionById(sessionA.id)?.closedAt,
				activeTools: [...harness.activeTools],
				widgetUpdates: harness.widgetUpdates,
				head: (await $`git -C ${cwd.path()} rev-parse HEAD`.quiet()).text().trim(),
			}).toEqual(settledState);
		});
	}

	it("aborts and drains an admitted ordinary mutation before restarting autoresearch", async () => {
		await initializeRealContributionRepository(cwd.path());
		const repositoryHead = (await $`git -C ${cwd.path()} rev-parse HEAD`.quiet()).text().trim();
		const harness = createIntegrationHarness(cwd.path());
		const branch = "autoresearch/ordinary-restart";
		harness.setCurrentBranch(branch);
		harness.setHeadSha(repositoryHead);
		await commandRequired(harness, "autoresearch").handler("initial ordinary goal", harness.ctx);
		const init = harness.tools.get("init_experiment");
		const updateNotes = harness.tools.get("update_notes");
		if (!init || !updateNotes) throw new Error("Expected ordinary autoresearch tools");
		await init.execute(
			"ordinary-restart-session",
			{ name: "ordinary restart", primary_metric: "runtime_ms", metric_unit: "ms" },
			undefined,
			undefined,
			harness.ctx as ExtensionContext,
		);
		const storage = await openAutoresearchStorage(cwd.path());
		const session = storage.getActiveSessionForBranch(branch);
		if (!session) throw new Error("Expected initialized ordinary session");
		const notesBefore = session.notes;
		const mutationEntered = Promise.withResolvers<void>();
		const releaseMutation = Promise.withResolvers<void>();
		let mutationSignal: AbortSignal | undefined;
		vi.spyOn(git.branch, "current").mockImplementation(async (_workDir, signal) => {
			if (signal) {
				mutationSignal = signal;
				mutationEntered.resolve();
				await releaseMutation.promise;
				if (signal.aborted) throw signal.reason ?? new DOMException("Ordinary restart invalidated", "AbortError");
			}
			return harness.currentBranch();
		});

		let mutationSettled = false;
		const mutationPromise = updateNotes
			.execute(
				"ordinary-notes-during-restart",
				{ body: "stale notes must not publish across restart" },
				undefined,
				undefined,
				harness.ctx as ExtensionContext,
			)
			.finally(() => {
				mutationSettled = true;
			});
		await mutationEntered.promise;
		let commandSettled = false;
		const commandPromise = commandRequired(harness, "autoresearch")
			.handler("replacement ordinary goal", harness.ctx)
			.finally(() => {
				commandSettled = true;
			});
		for (let turn = 0; turn < 4; turn++) await Promise.resolve();
		const mutationSettledBeforeRelease = mutationSettled;
		const commandSettledBeforeRelease = commandSettled;
		const mutationSignalDefinedBeforeRelease = mutationSignal !== undefined;
		const mutationSignalAbortedBeforeRelease = mutationSignal?.aborted;

		releaseMutation.resolve();
		const [mutationResult, commandResult] = await Promise.allSettled([mutationPromise, commandPromise]);

		expect(mutationSettledBeforeRelease).toBe(false);
		expect(commandSettledBeforeRelease).toBe(false);
		expect(mutationSignalDefinedBeforeRelease).toBe(true);
		expect(mutationSignalAbortedBeforeRelease).toBe(true);
		expect(mutationResult).toMatchObject({ status: "rejected", reason: { name: "ToolAbortError" } });
		expect(commandResult.status).toBe("fulfilled");
		expect(storage.getSessionById(session.id)).toMatchObject({
			goal: "replacement ordinary goal",
			notes: notesBefore,
			closedAt: null,
		});
		expect(storage.getActiveSessionForBranch(branch)?.id).toBe(session.id);
		expect(harness.appendEntries.at(-1)).toEqual({
			customType: "autoresearch-control",
			data: { mode: "on", goal: "replacement ordinary goal" },
		});
	});

	it("binds an ordinary session to branch A and restores it only after returning from branch B", async () => {
		const harness = createIntegrationHarness(cwd.path());
		const branchA = "autoresearch/branch-owned-a";
		const branchB = "autoresearch/branch-owned-b";
		const goal = "branch-owned ordinary goal";
		harness.setCurrentBranch(branchA);
		await commandRequired(harness, "autoresearch").handler(goal, harness.ctx);
		await Bun.write(`${cwd.path()}/autoresearch.sh`, "#!/usr/bin/env bash\necho METRIC runtime_ms=1\n");
		const init = harness.tools.get("init_experiment");
		const updateNotes = harness.tools.get("update_notes");
		if (!init || !updateNotes) throw new Error("Expected ordinary autoresearch tools");
		await init.execute(
			"branch-owned-session",
			{ name: "branch owned", primary_metric: "runtime_ms", metric_unit: "ms" },
			undefined,
			undefined,
			harness.ctx as ExtensionContext,
		);
		await updateNotes.execute(
			"branch-a-notes",
			{ body: "branch A durable notes" },
			undefined,
			undefined,
			harness.ctx as ExtensionContext,
		);
		const storage = await openAutoresearchStorage(cwd.path());
		const sessionA = storage.getActiveSessionForBranch(branchA);
		if (!sessionA) throw new Error("Expected initialized branch A session");
		const storedABeforeB = {
			notes: storage.getSessionById(sessionA.id)?.notes,
			closedAt: storage.getSessionById(sessionA.id)?.closedAt,
			currentSegment: storage.getSessionById(sessionA.id)?.currentSegment,
		};
		harness.setSessionBranch([
			{
				type: "custom",
				customType: "autoresearch-control",
				id: "branch-owned-control",
				parentId: null,
				timestamp: new Date(0).toISOString(),
				data: { mode: "on", goal },
			},
		]);
		const rehydrate = handlerRequired<{ type: "session_branch" }>(harness, "session_branch");
		const beforeAgentStart = handlerRequired<BeforeAgentStartEvent, { systemPrompt?: string[] }>(
			harness,
			"before_agent_start",
		);
		const promptOnA = await beforeAgentStart(
			{ type: "before_agent_start", prompt: "continue on A", systemPrompt: ["base prompt"] },
			harness.ctx as ExtensionContext,
		);
		expect(promptOnA?.systemPrompt?.[0]).toContain("branch A durable notes");

		harness.setCurrentBranch(branchB);
		await rehydrate({ type: "session_branch" }, harness.ctx as ExtensionContext);
		const promptOnB = await beforeAgentStart(
			{ type: "before_agent_start", prompt: "continue on B", systemPrompt: ["base prompt"] },
			harness.ctx as ExtensionContext,
		);
		const [mutationOnB] = await Promise.allSettled([
			updateNotes.execute(
				"branch-b-stale-notes",
				{ body: "branch B must not mutate branch A" },
				undefined,
				undefined,
				harness.ctx as ExtensionContext,
			),
		]);

		expect(storage.getActiveSessionForBranch(branchB)).toBeNull();
		expect(promptOnB).toBeUndefined();
		expect(harness.activeTools).toEqual(["read", "bash"]);
		expect(harness.widgetValues.at(-1)).toBeUndefined();
		expect(mutationOnB).toMatchObject({ status: "rejected", reason: { name: "ToolAbortError" } });
		expect({
			notes: storage.getSessionById(sessionA.id)?.notes,
			closedAt: storage.getSessionById(sessionA.id)?.closedAt,
			currentSegment: storage.getSessionById(sessionA.id)?.currentSegment,
		}).toEqual(storedABeforeB);

		harness.setCurrentBranch(branchA);
		await rehydrate({ type: "session_branch" }, harness.ctx as ExtensionContext);
		const restoredPrompt = await beforeAgentStart(
			{ type: "before_agent_start", prompt: "continue on A again", systemPrompt: ["base prompt"] },
			harness.ctx as ExtensionContext,
		);
		expect(storage.getActiveSessionForBranch(branchA)?.id).toBe(sessionA.id);
		expect(storage.getActiveSessionForBranch(branchB)).toBeNull();
		expect(restoredPrompt?.systemPrompt?.[0]).toContain(goal);
		expect(restoredPrompt?.systemPrompt?.[0]).toContain("branch A durable notes");
		expect(harness.activeTools).toEqual([
			"read",
			"bash",
			"init_experiment",
			"run_experiment",
			"log_experiment",
			"update_notes",
		]);
		expect(harness.widgetValues.at(-1)).not.toBeUndefined();
		const [restoredMutation] = await Promise.allSettled([
			updateNotes.execute(
				"branch-a-restored-notes",
				{ body: "branch A restored notes" },
				undefined,
				undefined,
				harness.ctx as ExtensionContext,
			),
		]);
		expect(restoredMutation.status).toBe("fulfilled");
		expect(storage.getSessionById(sessionA.id)?.notes).toBe("branch A restored notes");
	});

	it("restores its retained ordinary owner after A to B to A manual checkout without a session event", async () => {
		const harness = createIntegrationHarness(cwd.path());
		const branchA = "autoresearch/prompt-owner-a";
		const branchB = "autoresearch/prompt-owner-b";
		const goal = "prompt-bound ordinary goal";
		harness.setCurrentBranch(branchA);
		await commandRequired(harness, "autoresearch").handler(goal, harness.ctx);
		await Bun.write(`${cwd.path()}/autoresearch.sh`, "#!/usr/bin/env bash\necho METRIC runtime_ms=1\n");
		const init = harness.tools.get("init_experiment");
		if (!init) throw new Error("Expected init_experiment tool");
		await init.execute(
			"prompt-owner-session",
			{ name: "prompt owner", primary_metric: "runtime_ms" },
			undefined,
			undefined,
			harness.ctx as ExtensionContext,
		);
		const storage = await openAutoresearchStorage(cwd.path());
		const sessionA = storage.getActiveSessionForBranch(branchA);
		if (!sessionA) throw new Error("Expected initialized branch A session");
		storage.updateSession(sessionA.id, { notes: "retained prompt owner notes" });
		expect(storage.getActiveSessionForBranch(branchA)?.id).toBe(sessionA.id);
		expect(storage.getSessionById(sessionA.id)?.notes).toBe("retained prompt owner notes");
		expect(storage.getActiveSessionForBranch(branchB)).toBeNull();
		expect(harness.activeTools).toEqual([
			"read",
			"bash",
			"init_experiment",
			"run_experiment",
			"log_experiment",
			"update_notes",
		]);
		harness.setSessionBranch([
			{
				type: "custom",
				customType: "autoresearch-control",
				id: "prompt-owner-control",
				parentId: null,
				timestamp: new Date(0).toISOString(),
				data: { mode: "on", goal },
			},
		]);
		expect(harness.ctx.sessionManager.getBranch()).toContainEqual(
			expect.objectContaining({ customType: "autoresearch-control", data: { mode: "on", goal } }),
		);
		const beforeAgentStart = handlerRequired<BeforeAgentStartEvent, { systemPrompt?: string[] }>(
			harness,
			"before_agent_start",
		);

		harness.setCurrentBranch(branchB);
		const promptOnB = await beforeAgentStart(
			{ type: "before_agent_start", prompt: "manual checkout B", systemPrompt: ["base prompt"] },
			harness.ctx as ExtensionContext,
		);
		expect(promptOnB).toBeUndefined();
		expect(harness.activeTools).toEqual(["read", "bash"]);
		expect(storage.getActiveSessionForBranch(branchA)?.id).toBe(sessionA.id);
		expect(storage.getSessionById(sessionA.id)?.notes).toBe("retained prompt owner notes");
		expect(storage.getActiveSessionForBranch(branchB)).toBeNull();

		harness.setCurrentBranch(branchA);
		const restoredPrompt = await beforeAgentStart(
			{ type: "before_agent_start", prompt: "manual checkout A", systemPrompt: ["base prompt"] },
			harness.ctx as ExtensionContext,
		);
		expect(storage.getActiveSessionForBranch(branchA)?.id).toBe(sessionA.id);
		expect(storage.getActiveSessionForBranch(branchB)).toBeNull();
		expect(restoredPrompt?.systemPrompt?.[0]).toContain(goal);
		expect(restoredPrompt?.systemPrompt?.[0]).toContain("retained prompt owner notes");
		expect(harness.activeTools).toEqual([
			"read",
			"bash",
			"init_experiment",
			"run_experiment",
			"log_experiment",
			"update_notes",
		]);
	});

	it("does not abort an ordinary mutation when contribution mode is already off", async () => {
		const harness = createIntegrationHarness(cwd.path());
		await commandRequired(harness, "autoresearch").handler("ordinary mutation", harness.ctx);
		await Bun.write(`${cwd.path()}/autoresearch.sh`, "#!/usr/bin/env bash\necho METRIC runtime_ms=1\n");
		harness.setStatusText(" M autoresearch.sh\0");
		const statusEntered = Promise.withResolvers<AbortSignal | undefined>();
		const releaseStatus = Promise.withResolvers<void>();
		harness.setNextStatusRequest(async signal => {
			statusEntered.resolve(signal);
			await releaseStatus.promise;
			if (signal?.aborted) throw signal.reason ?? new DOMException("Ordinary init aborted", "AbortError");
		});
		const init = harness.tools.get("init_experiment");
		if (!init) throw new Error("Expected init_experiment tool");
		const activeTools = [...harness.activeTools];
		const initPromise = init.execute(
			"ordinary-during-contribution-off",
			{ name: "ordinary", primary_metric: "runtime_ms" },
			undefined,
			undefined,
			harness.ctx as ExtensionContext,
		);
		const operationSignal = await statusEntered.promise;
		let offSettled = false;
		const offPromise = commandRequired(harness, "contribute")
			.handler("off", harness.ctx)
			.finally(() => {
				offSettled = true;
			});
		for (let turn = 0; turn < 4; turn++) await Promise.resolve();
		const offSettledDuringInit = offSettled;
		releaseStatus.resolve();
		const [initResult, offResult] = await Promise.allSettled([initPromise, offPromise]);

		expect(offSettledDuringInit).toBe(true);
		expect(operationSignal).toBeDefined();
		expect(operationSignal?.aborted).toBe(false);
		expect(initResult.status).toBe("fulfilled");
		expect(offResult.status).toBe("fulfilled");
		expect(harness.activeTools).toEqual(activeTools);
		expect(harness.appendEntries).toEqual([
			{ customType: "autoresearch-control", data: { mode: "on", goal: "ordinary mutation" } },
		]);
	});

	it("aborts an active mutation before review and refuses a pending experiment", async () => {
		const harness = createIntegrationHarness(cwd.path(), { confirmAnswers: [true, true, true] });
		await startContribution(harness);
		await prepareKeptContribution(harness, cwd.path());
		const run = harness.tools.get("run_experiment");
		if (!run) throw new Error("Expected run_experiment tool");
		const processEntered = Promise.withResolvers<void>();
		const releaseProcess = Promise.withResolvers<void>();
		const processAborted = Promise.withResolvers<void>();
		let processSignal: AbortSignal | undefined;
		vi.spyOn(bashExecutor, "executeBash").mockImplementation(async (_command, options) => {
			processSignal = options?.signal;
			if (processSignal?.aborted) processAborted.resolve();
			else processSignal?.addEventListener("abort", () => processAborted.resolve(), { once: true });
			processEntered.resolve();
			await releaseProcess.promise;
			if (processSignal?.aborted) {
				throw processSignal.reason ?? new DOMException("Contribution run aborted before review", "AbortError");
			}
			return {
				output: "METRIC runtime_ms=1",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				totalLines: 1,
				totalBytes: 19,
				outputLines: 1,
				outputBytes: 19,
			};
		});
		const pushSpy = vi.spyOn(git, "push").mockResolvedValue(undefined);
		const runPromise = run.execute("run-before-review", {}, undefined, undefined, harness.ctx as ExtensionContext);
		await processEntered.promise;
		const reviewPromise = commandRequired(harness, "contribute").handler("review", harness.ctx);
		const firstLifecycleEvent = await Promise.race([
			processAborted.promise.then(() => "aborted" as const),
			reviewPromise.then(() => "reviewed" as const),
		]);
		releaseProcess.resolve();
		const [runResult, reviewResult] = await Promise.allSettled([runPromise, reviewPromise]);

		expect(firstLifecycleEvent).toBe("aborted");
		expect(processSignal).toBeDefined();
		expect(processSignal?.aborted).toBe(true);
		expect(runResult).toMatchObject({ status: "rejected", reason: { name: "ToolAbortError" } });
		expect(reviewResult.status).toBe("fulfilled");
		expect(pushSpy).not.toHaveBeenCalled();
		expect(harness.notifications.at(-1)?.message).toContain("pending experiment");
		await commandRequired(harness, "contribute").handler("status", harness.ctx);
		expect(harness.notifications.at(-1)?.message).toStartWith("Contribution running on ");
	});

	it("fails closed when contribution is stopped during new-segment goal preparation", async () => {
		let refRequests = 0;
		let harness!: IntegrationHarness;
		harness = createIntegrationHarness(cwd.path(), {
			async onGoalRefRequest(): Promise<void> {
				refRequests++;
				if (refRequests === 3) await commandRequired(harness, "contribute").handler("off", harness.ctx);
			},
		});
		await startContribution(harness);
		await Bun.write(`${cwd.path()}/autoresearch.sh`, "#!/usr/bin/env bash\necho METRIC runtime_ms=1\n");
		const init = harness.tools.get("init_experiment");
		if (!init) throw new Error("Expected init_experiment tool");
		await init.execute(
			"initial",
			{ name: "initial", primary_metric: "runtime_ms" },
			undefined,
			undefined,
			harness.ctx as ExtensionContext,
		);
		const storage = await openAutoresearchStorage(cwd.path());
		const session = storage.getActiveSessionForBranch(harness.currentBranch());
		if (!session) throw new Error("Expected contribution session");

		await expect(
			init.execute(
				"stopped-segment",
				{ name: "next", primary_metric: "runtime_ms", new_segment: true },
				undefined,
				undefined,
				harness.ctx as ExtensionContext,
			),
		).rejects.toThrow("authorization changed");
		const unchanged = storage.getSessionById(session.id);
		expect(unchanged?.currentSegment).toBe(session.currentSegment);
		expect(unchanged?.goal).toBe(session.goal);
		expect(unchanged?.closedAt).not.toBeNull();
	});

	it("fails closed when the process-local session switches during new-segment goal preparation", async () => {
		let refRequests = 0;
		let harness!: IntegrationHarness;
		harness = createIntegrationHarness(cwd.path(), {
			onGoalRefRequest(): void {
				refRequests++;
				if (refRequests === 3) harness.setSessionId("switched-session");
			},
		});
		await startContribution(harness);
		await Bun.write(`${cwd.path()}/autoresearch.sh`, "#!/usr/bin/env bash\necho METRIC runtime_ms=1\n");
		const init = harness.tools.get("init_experiment");
		if (!init) throw new Error("Expected init_experiment tool");
		await init.execute(
			"initial",
			{ name: "initial", primary_metric: "runtime_ms" },
			undefined,
			undefined,
			harness.ctx as ExtensionContext,
		);
		const storage = await openAutoresearchStorage(cwd.path());
		const session = storage.getActiveSessionForBranch(harness.currentBranch());
		if (!session) throw new Error("Expected contribution session");
		const beforeArtifacts = snapshotStorageArtifacts(dbDir.path());

		await expect(
			init.execute(
				"switched-segment",
				{ name: "next", primary_metric: "runtime_ms", new_segment: true },
				undefined,
				undefined,
				harness.ctx as ExtensionContext,
			),
		).rejects.toThrow("authorization changed");
		expect(snapshotStorageArtifacts(dbDir.path())).toEqual(beforeArtifacts);
		expect(storage.getSessionById(session.id)).toMatchObject({
			currentSegment: session.currentSegment,
			goal: session.goal,
			closedAt: null,
		});
	});

	it("refuses a contribution segment boundary while any experiment is pending", async () => {
		const harness = createIntegrationHarness(cwd.path());
		await startContribution(harness);
		await Bun.write(`${cwd.path()}/autoresearch.sh`, "#!/usr/bin/env bash\necho METRIC runtime_ms=1\n");
		const init = harness.tools.get("init_experiment");
		const runTool = harness.tools.get("run_experiment");
		const logTool = harness.tools.get("log_experiment");
		const updateNotesTool = harness.tools.get("update_notes");
		if (!init || !runTool || !logTool || !updateNotesTool) {
			throw new Error("Expected all autoresearch mutation tools");
		}
		for (const tool of [init, runTool, logTool, updateNotesTool]) {
			const concurrency = typeof tool.concurrency === "function" ? tool.concurrency({} as never) : tool.concurrency;
			expect(concurrency).toBe("exclusive");
		}
		const initConcurrency =
			typeof init.concurrency === "function" ? init.concurrency({ new_segment: true }) : init.concurrency;
		expect(initConcurrency).toBe("exclusive");
		await init.execute(
			"initial",
			{ name: "initial", primary_metric: "runtime_ms" },
			undefined,
			undefined,
			harness.ctx as ExtensionContext,
		);
		const storage = await openAutoresearchStorage(cwd.path());
		const session = storage.getActiveSessionForBranch(harness.currentBranch());
		if (!session) throw new Error("Expected contribution session");
		const run = storage.insertRun({
			sessionId: session.id,
			segment: session.currentSegment,
			command: "bash autoresearch.sh",
			startedAt: Date.now(),
			logPath: "",
			preRunDirtyPaths: [],
		});

		for (const phase of ["running", "completed"] as const) {
			if (phase === "completed") {
				storage.markRunCompleted({
					runId: run.id,
					completedAt: Date.now(),
					durationMs: 1,
					exitCode: 0,
					timedOut: false,
					parsedPrimary: 1,
					parsedMetrics: { runtime_ms: 1 },
					parsedAsi: null,
				});
			}
			const beforeArtifacts = snapshotStorageArtifacts(dbDir.path());
			await expect(
				init.execute(
					`segment-${phase}`,
					{ name: "next", primary_metric: "runtime_ms", new_segment: true },
					undefined,
					undefined,
					harness.ctx as ExtensionContext,
				),
			).rejects.toThrow("pending experiment to be logged");
			expect(snapshotStorageArtifacts(dbDir.path())).toEqual(beforeArtifacts);
		}
		expect(harness.githubEndpoints.filter(endpoint => endpoint.includes("/git/ref/heads/"))).toHaveLength(2);
		expect(storage.getPendingRun(session.id)?.id).toBe(run.id);
	});

	it("blocks a failing new-segment goal refresh before SQLite mutation", async () => {
		const invalidRefresh: IntegrationGoalVersion = {
			commitSha: "6".repeat(40),
			treeSha: "7".repeat(40),
			blobSha: "8".repeat(40),
			content: "not an H1 goal\n",
		};
		const harness = createIntegrationHarness(cwd.path(), {
			goalVersions: [defaultGoalVersions()[0]!, defaultGoalVersions()[0]!, invalidRefresh],
		});
		await startContribution(harness);
		await Bun.write(`${cwd.path()}/autoresearch.sh`, "#!/usr/bin/env bash\necho METRIC runtime_ms=1\n");
		const init = harness.tools.get("init_experiment");
		if (!init) throw new Error("Expected init_experiment tool");
		await init.execute(
			"initial",
			{ name: "initial", primary_metric: "runtime_ms" },
			undefined,
			undefined,
			harness.ctx as ExtensionContext,
		);
		const beforeArtifacts = snapshotStorageArtifacts(dbDir.path());

		await expect(
			init.execute(
				"segment-fail",
				{ name: "next", primary_metric: "runtime_ms", new_segment: true },
				undefined,
				undefined,
				harness.ctx as ExtensionContext,
			),
		).rejects.toThrow("Official contribution goal refresh failed before segment mutation");
		expect(snapshotStorageArtifacts(dbDir.path())).toEqual(beforeArtifacts);
		expect(harness.githubEndpoints.filter(endpoint => endpoint.includes("/git/ref/heads/"))).toHaveLength(3);
	});

	it("adopts a validated goal in the successful segment tool result with no post-bump fetch", async () => {
		const refreshed: IntegrationGoalVersion = {
			commitSha: "6".repeat(40),
			treeSha: "7".repeat(40),
			blobSha: "8".repeat(40),
			content: "# Adopted segment goal\n\nNew bounded direction.\n",
		};
		const harness = createIntegrationHarness(cwd.path(), {
			goalVersions: [defaultGoalVersions()[0]!, defaultGoalVersions()[0]!, refreshed],
		});
		await startContribution(harness);
		await Bun.write(`${cwd.path()}/autoresearch.sh`, "#!/usr/bin/env bash\necho METRIC runtime_ms=1\n");
		const init = harness.tools.get("init_experiment");
		if (!init) throw new Error("Expected init_experiment tool");
		await init.execute(
			"initial",
			{ name: "initial", primary_metric: "runtime_ms" },
			undefined,
			undefined,
			harness.ctx as ExtensionContext,
		);

		const result = await init.execute(
			"adopt",
			{ name: "next", primary_metric: "runtime_ms", max_iterations: 1, new_segment: true },
			undefined,
			undefined,
			harness.ctx as ExtensionContext,
		);
		const fetchCountAfterResult = harness.githubEndpoints.length;
		const text = result.content.find(part => part.type === "text")?.text ?? "";
		expect(text).toContain("segment 2");
		const details = result.details as InitContributionDetails | undefined;
		expect(details?.bumpedSegment).toBe(true);
		expect(details?.state.currentSegment).toBe(1);
		expect(details?.state.maxExperiments).toBeNull();
		expect(text).toContain("Adopted segment goal");
		expect(text).toContain(refreshed.commitSha);

		const storage = await openAutoresearchStorage(cwd.path());
		const session = storage.getActiveSessionForBranch(harness.currentBranch());
		expect(session?.goal).toBe(refreshed.content);
		expect(session?.currentSegment).toBe(1);
		expect(harness.githubEndpoints).toHaveLength(fetchCountAfterResult);
	});

	it("propagates segment refresh cancellation before any Git or SQLite mutation", async () => {
		const controller = new AbortController();
		let observedSignal: AbortSignal | undefined;
		const harness = createIntegrationHarness(cwd.path(), {
			onGoalRefRequest(signal): void {
				if (!signal) return;
				observedSignal = signal;
				controller.abort(new Error("user interrupted"));
			},
		});
		await startContribution(harness);
		await Bun.write(`${cwd.path()}/autoresearch.sh`, "#!/usr/bin/env bash\necho METRIC runtime_ms=1\n");
		const init = harness.tools.get("init_experiment");
		if (!init) throw new Error("Expected init_experiment tool");
		await init.execute(
			"initial",
			{ name: "initial", primary_metric: "runtime_ms" },
			undefined,
			undefined,
			harness.ctx as ExtensionContext,
		);
		const beforeArtifacts = snapshotStorageArtifacts(dbDir.path());

		await expect(
			init.execute(
				"aborted-refresh",
				{ name: "next", primary_metric: "runtime_ms", new_segment: true },
				controller.signal,
				undefined,
				harness.ctx as ExtensionContext,
			),
		).rejects.toThrow("Operation aborted");
		expect(observedSignal).toBeDefined();
		expect(observedSignal?.aborted).toBe(true);
		expect(observedSignal?.reason).toBe(controller.signal.reason);
		expect(observedSignal?.reason?.message).toBe("user interrupted");
		expect(snapshotStorageArtifacts(dbDir.path())).toEqual(beforeArtifacts);
	});
});
