import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Buffer } from "node:buffer";
import * as fs from "node:fs";
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
import {
	closeAllAutoresearchStorages,
	hasActiveAutoresearchSession,
	openAutoresearchStorage,
	type SessionRow,
} from "@oh-my-pi/pi-coding-agent/autoresearch/storage";
import type {
	AgentEndEvent,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionHandler,
	RegisteredCommand,
	SessionBeforeBranchEvent,
	SessionBeforeSwitchEvent,
	SessionBeforeTreeEvent,
	SessionBranchEvent,
	SessionShutdownEvent,
	SessionStartEvent,
	SessionSwitchEvent,
	SessionTreeEvent,
	ToolDefinition,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
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

function makeCandidate(overrides: Partial<ContributionCandidate> = {}): ContributionCandidate {
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
		...overrides,
	};
}

function makeBaseProof(): ContributionBaseProof {
	return {
		clean: true,
		baseSha: COMMIT_SHA,
		currentHead: COMMIT_SHA,
		initialGoalCommitSha: COMMIT_SHA,
	};
}

function makePublicationGit(overrides: Partial<ContributionPublicationGit> = {}): ContributionPublicationGit {
	return {
		readRemoteUrl: async () => FORK_URL,
		readPushRemoteUrl: async () => FORK_URL,
		readBranch: async () => CONTRIBUTION_BRANCH,
		readHead: async () => CURRENT_HEAD,
		readStatus: async () => "",
		isAncestor: async () => true,
		push: async () => {},
		...overrides,
	} as ContributionPublicationGit;
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

	it("re-reads the exact fork URL, verifies ancestry, and pushes only the exact HEAD refspec", async () => {
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

		expect(calls).toEqual(["read:/work/repo:origin", `ancestor:/work/repo:${COMMIT_SHA}:${CURRENT_HEAD}`, "push"]);
		expect(requests.map(request => request.endpoint)).toEqual(["/repos/alice/oh-my-pi"]);
		expect(pushes).toEqual([
			{
				cwd: "/work/repo",
				remote: "origin",
				verifiedRemoteUrl: FORK_URL,
				refspec: `HEAD:refs/heads/${CONTRIBUTION_BRANCH}`,
				forceWithLease: `refs/heads/${CONTRIBUTION_BRANCH}:`,
			},
		]);
		expect(published.refspec).toBe(`HEAD:refs/heads/${CONTRIBUTION_BRANCH}`);
		expect(published.compareUrl).toContain("/compare/main...alice:");
		expect(published.reviewUrl).toBe(
			`https://github.com/${OFFICIAL_CONTRIBUTION_OWNER}/${OFFICIAL_CONTRIBUTION_REPO}/compare/${COMMIT_SHA}...alice:${CURRENT_HEAD}?expand=1`,
		);
		expect(published.reviewUrl).not.toBe(published.compareUrl);
		expect(published.prDraft.body).toContain(CONTRIBUTION_HUMAN_SUMMARY_PLACEHOLDER);
		expect(published.prDraft).toEqual(approvedDraft);
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

	it("rejects HEAD or clean-worktree drift during the awaited final ancestry check before literal-HEAD push", async () => {
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
	onConfirm?(callNumber: number, title: string): void | Promise<void>;
	onSetModel?(callNumber: number): void | Promise<void>;
	onCheckoutNewAt?(callNumber: number): void | Promise<void>;
	onSetActiveTools?(callNumber: number): void | Promise<void>;
	onForkMetadataRequest?(callNumber: number, signal?: AbortSignal): void | Promise<void>;
	onAncestryRequest?(callNumber: number, signal?: AbortSignal): void | Promise<void>;
	statusText?: string;
	headSha?: string;
	hasPendingMessages?: boolean;
	initialTools?: string[];
	sessionId?: string;
	refExistsResults?: boolean[];
	ancestryResults?: boolean[];
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
	pushes: Array<{
		remote?: string;
		verifiedRemoteUrl?: string;
		refspec?: string;
		forceWithLease?: boolean | string;
	}>;
	approvalModeMutations: string[];
	setPendingMessages(value: boolean): void;
	setStatusText(value: string): void;
	setHeadSha(value: string): void;
	setRefOccupied(value: boolean): void;
	setNextStatusRequest(callback: () => void | Promise<void>): void;
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
	const pushes: Array<{
		remote?: string;
		verifiedRemoteUrl?: string;
		refspec?: string;
		forceWithLease?: boolean | string;
	}> = [];
	const approvalModeMutations: string[] = [];
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
	let nextStatusRequest: (() => void | Promise<void>) | null = null;
	let sessionId = options.sessionId ?? "contribution-session";
	let sessionBranch: unknown[] = [];
	let setActiveToolsCallCount = 0;
	const goals = options.goalVersions ?? defaultGoalVersions();
	let activeGoal = goals[0];
	let goalLoadCount = 0;
	let forkMetadataRequestCount = 0;
	let ancestryRequestCount = 0;

	vi.spyOn(git.repo, "root").mockResolvedValue(cwd);
	vi.spyOn(git.show, "prefix").mockResolvedValue("");
	const statusMock = Object.assign(
		async () => {
			const callback = nextStatusRequest;
			nextStatusRequest = null;
			await callback?.();
			gitEvents.push(`status:${statusText}`);
			return statusText;
		},
		{ parse: git.status.parse, summary: git.status.summary },
	);
	vi.spyOn(git, "status").mockImplementation(statusMock);
	vi.spyOn(git.head, "sha").mockImplementation(async () => {
		gitEvents.push(`head:${headSha}`);
		return headSha;
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
			await options.onSetActiveTools?.(setActiveToolsCallCount);
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
		},
		shutdown(): void {},
		switchSession: async () => ({ cancelled: false }),
		ui: {
			confirm: async (title: string, message: string) => {
				confirmCalls.push({ title, message });
				gitEvents.push(`confirm:${confirmCalls.length}`);
				await options.onConfirm?.(confirmCalls.length, title);
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
			setWidget(): void {},
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
		approvalModeMutations,
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
		setNextStatusRequest(callback: () => void | Promise<void>): void {
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

async function prepareKeptContribution(harness: IntegrationHarness, cwd: string): Promise<SessionRow> {
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
		parsedAsi: { hypothesis: "Ran the focused contribution scenario." },
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
		loggedAt: now + 2,
	});
	harness.setHeadSha(CURRENT_HEAD);
	return session;
}
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
			let beforeSwitch: Promise<void> | undefined;
			harness = createIntegrationHarness(cwd.path(), {
				async onConfirm(callNumber): Promise<void> {
					if (callNumber !== 2) return;
					if (invalidation === "off") {
						await commandRequired(harness, "contribute").handler("off", harness.ctx);
						return;
					}
					beforeSwitch = Promise.resolve(
						handlerRequired<SessionBeforeSwitchEvent>(harness, "session_before_switch")(
							{ type: "session_before_switch", reason: "resume", targetSessionFile: "/tmp/switched.jsonl" },
							harness.ctx as ExtensionContext,
						),
					);
				},
			});
			const initialTools = [...harness.activeTools];
			const initialModel = harness.currentModel();

			await startContribution(harness);
			if (invalidation === "session switch") {
				if (!beforeSwitch) throw new Error("Expected session-before-switch handler to start");
				await beforeSwitch;
				harness.setSessionId("switched-session");
				await handlerRequired<SessionSwitchEvent>(harness, "session_switch")(
					{ type: "session_switch", reason: "resume", previousSessionFile: "/tmp/original.jsonl" },
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

	const partialStartTransitions = [
		{
			point: "setModel",
			beforeName: "session_before_switch",
			afterName: "session_switch",
			changesSession: true,
			beginBefore(harness: IntegrationHarness): Promise<void> {
				return Promise.resolve(
					handlerRequired<SessionBeforeSwitchEvent>(harness, "session_before_switch")(
						{ type: "session_before_switch", reason: "resume", targetSessionFile: "/tmp/target.jsonl" },
						harness.ctx as ExtensionContext,
					),
				);
			},
			rehydrate(harness: IntegrationHarness): Promise<void> {
				return Promise.resolve(
					handlerRequired<SessionSwitchEvent>(harness, "session_switch")(
						{ type: "session_switch", reason: "resume", previousSessionFile: "/tmp/source.jsonl" },
						harness.ctx as ExtensionContext,
					),
				);
			},
		},
		{
			point: "checkoutNewAt",
			beforeName: "session_before_branch",
			afterName: "session_branch",
			changesSession: true,
			beginBefore(harness: IntegrationHarness): Promise<void> {
				return Promise.resolve(
					handlerRequired<SessionBeforeBranchEvent>(harness, "session_before_branch")(
						{ type: "session_before_branch", entryId: "source-entry" },
						harness.ctx as ExtensionContext,
					),
				);
			},
			rehydrate(harness: IntegrationHarness): Promise<void> {
				return Promise.resolve(
					handlerRequired<SessionBranchEvent>(harness, "session_branch")(
						{ type: "session_branch", previousSessionFile: "/tmp/source.jsonl" },
						harness.ctx as ExtensionContext,
					),
				);
			},
		},
		{
			point: "setActiveTools",
			beforeName: "session_before_tree",
			afterName: "session_tree",
			changesSession: false,
			beginBefore(harness: IntegrationHarness): Promise<void> {
				return Promise.resolve(
					handlerRequired<SessionBeforeTreeEvent>(harness, "session_before_tree")(
						{
							type: "session_before_tree",
							preparation: {
								targetId: "target-leaf",
								oldLeafId: "source-leaf",
								commonAncestorId: "root",
								entriesToSummarize: [],
								userWantsSummary: false,
							},
							signal: new AbortController().signal,
						},
						harness.ctx as ExtensionContext,
					),
				);
			},
			rehydrate(harness: IntegrationHarness): Promise<void> {
				return Promise.resolve(
					handlerRequired<SessionTreeEvent>(harness, "session_tree")(
						{ type: "session_tree", newLeafId: "target-leaf", oldLeafId: "source-leaf" },
						harness.ctx as ExtensionContext,
					),
				);
			},
		},
	] as const;

	for (const transition of partialStartTransitions) {
		it(`waits for ${transition.beforeName} rollback before ${transition.afterName} rehydrate during ${transition.point}`, async () => {
			const priorModel = requiredBundledModel("anthropic", "claude-sonnet-4-5");
			const targetModel = requiredBundledModel("anthropic", "claude-sonnet-4-6");
			const targetBranch = "autoresearch/rehydrated-target";
			const targetGoal = "rehydrated target goal";
			let harness!: IntegrationHarness;
			let transitionTask: Promise<void> | undefined;
			const beginTransition = (): void => {
				if (transitionTask) return;
				const beforeHandler = transition.beginBefore(harness);
				transitionTask = (async () => {
					await beforeHandler;
					harness.gitEvents.push(`${transition.beforeName}:settled`);
					if (transition.changesSession) harness.setSessionId(`target-${transition.afterName}`);
					harness.setCurrentModel(targetModel);
					harness.setCurrentBranch(targetBranch);
					harness.setActiveToolState(["read", "target-tool"]);
					harness.setSessionBranch([
						{
							type: "custom",
							customType: "autoresearch-control",
							id: `target-${transition.afterName}`,
							parentId: null,
							timestamp: new Date(0).toISOString(),
							data: { mode: "on", goal: targetGoal },
						},
					]);
					await transition.rehydrate(harness);
					harness.gitEvents.push(`${transition.afterName}:rehydrated`);
				})();
			};
			const options: IntegrationHarnessOptions = {
				currentModel: priorModel,
				selectedModelId: targetModel.id,
			};
			if (transition.point === "setModel") {
				options.onSetModel = callNumber => {
					if (callNumber === 1) beginTransition();
				};
			} else if (transition.point === "checkoutNewAt") {
				options.onCheckoutNewAt = callNumber => {
					if (callNumber === 1) beginTransition();
				};
			} else {
				options.onSetActiveTools = callNumber => {
					if (callNumber === 1) beginTransition();
				};
			}
			harness = createIntegrationHarness(cwd.path(), options);

			await startContribution(harness);
			if (!transitionTask) throw new Error(`Expected ${transition.beforeName} handler to start`);
			await transitionTask;

			const rollbackModelEvent = `model:${priorModel.provider}/${priorModel.id}`;
			const rollbackIndex = harness.gitEvents.lastIndexOf(rollbackModelEvent);
			const beforeSettledIndex = harness.gitEvents.indexOf(`${transition.beforeName}:settled`);
			expect(rollbackIndex).toBeGreaterThanOrEqual(0);
			expect(beforeSettledIndex).toBeGreaterThan(rollbackIndex);
			expect(harness.currentModel()).toBe(targetModel);
			expect(harness.currentBranch()).toBe(targetBranch);
			expect(harness.activeTools).toEqual([
				"read",
				"target-tool",
				"init_experiment",
				"run_experiment",
				"log_experiment",
				"update_notes",
			]);
			const beforeAgentStart = await handlerRequired<
				{ type: "before_agent_start"; systemPrompt: string[] },
				{ systemPrompt: string[] }
			>(harness, "before_agent_start")(
				{ type: "before_agent_start", systemPrompt: [] },
				harness.ctx as ExtensionContext,
			);
			expect(beforeAgentStart?.systemPrompt.join("\n")).toContain(targetGoal);
			await commandRequired(harness, "contribute").handler("status", harness.ctx);
			expect(harness.notifications.at(-1)?.message).toBe("Contribution mode is off.");
			expect(harness.appendEntries).toEqual([]);
			expect(harness.sentUserMessages).toEqual([]);
			expect(snapshotStorageArtifacts(dbDir.path())).toEqual([]);
		});
	}

	for (const invalidationPoint of ["setModel", "checkout", "tool activation"] as const) {
		it(`rolls back only owned start mutations when stopped during awaited ${invalidationPoint}`, async () => {
			const priorModel = requiredBundledModel("anthropic", "claude-sonnet-4-5");
			const selectedModel = requiredBundledModel("anthropic", "claude-sonnet-4-6");
			let harness!: IntegrationHarness;
			const invalidate = async (callNumber: number): Promise<void> => {
				if (callNumber === 1) await commandRequired(harness, "contribute").handler("off", harness.ctx);
			};
			harness = createIntegrationHarness(cwd.path(), {
				currentModel: priorModel,
				selectedModelId: selectedModel.id,
				onSetModel: invalidationPoint === "setModel" ? invalidate : undefined,
				onCheckoutNewAt: invalidationPoint === "checkout" ? invalidate : undefined,
				onSetActiveTools: invalidationPoint === "tool activation" ? invalidate : undefined,
			});

			await startContribution(harness);

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
	for (const race of [
		{ point: "fork verification", invalidation: "off" },
		{ point: "pre-push ancestry", invalidation: "session switch" },
	] as const) {
		it(`aborts review publication during ${race.point} on ${race.invalidation} with zero push`, async () => {
			let harness!: IntegrationHarness;
			let publicationSignal: AbortSignal | undefined;
			const invalidate = async (signal: AbortSignal | undefined): Promise<void> => {
				publicationSignal = signal;
				if (race.invalidation === "off") {
					await commandRequired(harness, "contribute").handler("off", harness.ctx);
					return;
				}
				await handlerRequired<SessionBeforeSwitchEvent>(harness, "session_before_switch")(
					{ type: "session_before_switch", reason: "resume", targetSessionFile: "/tmp/review-switched.jsonl" },
					harness.ctx as ExtensionContext,
				);
				harness.setSessionId("review-switched-session");
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
		await Bun.write(`${cwd.path()}/autoresearch.sh`, "#!/usr/bin/env bash\necho METRIC runtime_ms=1\n");
		const init = harness.tools.get("init_experiment");
		if (!init) throw new Error("Expected init_experiment tool");
		await init.execute(
			"initial",
			{ name: "candidate", primary_metric: "runtime_ms", metric_unit: "ms" },
			undefined,
			undefined,
			harness.ctx as ExtensionContext,
		);

		const storage = await openAutoresearchStorage(cwd.path());
		const session = storage.getActiveSessionForBranch(harness.currentBranch());
		if (!session) throw new Error("Expected contribution session");
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
			parsedAsi: { hypothesis: "Ran the focused contribution scenario." },
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
			loggedAt: now + 2,
		});
		harness.setHeadSha(CURRENT_HEAD);

		await commandRequired(harness, "contribute").handler("review", harness.ctx);

		const branch = harness.currentBranch();
		expect(harness.pushes).toEqual([
			{
				remote: "origin",
				verifiedRemoteUrl: FORK_URL,
				refspec: `HEAD:refs/heads/${branch}`,
				forceWithLease: `refs/heads/${branch}:`,
			},
		]);
		expect(harness.confirmCalls.at(-1)?.message).toContain("Ran the focused contribution scenario.");
		expect(harness.confirmCalls.at(-1)?.message).toContain("Observed the focused scenario pass");
		expect(harness.confirmCalls.at(-1)?.message).toContain(CONTRIBUTION_HUMAN_SUMMARY_PLACEHOLDER);
		const reviewConfirmation = harness.confirmCalls.at(-1)?.message ?? "";
		expect(reviewConfirmation).toContain(`HEAD:refs/heads/${branch}`);
		expect(reviewConfirmation).not.toContain(`${CURRENT_HEAD}:refs/heads/${branch}`);
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

	it("drops process-local authentication and running state on shutdown/reopen", async () => {
		const harness = createIntegrationHarness(cwd.path());
		await startContribution(harness);
		const shutdown = handlerRequired<SessionShutdownEvent>(harness, "session_shutdown");
		await shutdown({ type: "session_shutdown" } as SessionShutdownEvent, harness.ctx as ExtensionContext);
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
		if (!init) throw new Error("Expected init_experiment tool");
		if (typeof init.concurrency !== "function") throw new Error("Expected argument-aware init concurrency");
		expect(init.concurrency({ new_segment: true })).toBe("exclusive");
		expect(init.concurrency({ new_segment: false })).toBe("shared");
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
		expect(observedSignal).toBe(controller.signal);
		expect(snapshotStorageArtifacts(dbDir.path())).toEqual(beforeArtifacts);
	});
});
