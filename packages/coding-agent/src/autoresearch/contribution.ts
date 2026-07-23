import * as git from "../utils/git";

export const OFFICIAL_CONTRIBUTION_HOST = "github.com" as const;
export const OFFICIAL_CONTRIBUTION_OWNER = "can1357" as const;
export const OFFICIAL_CONTRIBUTION_REPO = "oh-my-pi" as const;
export const OFFICIAL_CONTRIBUTION_REF = "main" as const;
export const OFFICIAL_CONTRIBUTION_GOAL_PATH = ".github/AUTORESEARCH_GOAL.md" as const;
export const OFFICIAL_CONTRIBUTION_REPOSITORY = `${OFFICIAL_CONTRIBUTION_OWNER}/${OFFICIAL_CONTRIBUTION_REPO}` as const;
export const CONTRIBUTION_GOAL_MAX_BYTES = 32 * 1024;
export const CONTRIBUTION_GOAL_TITLE_MAX_LENGTH = 120;
export const CONTRIBUTION_HUMAN_SUMMARY_PLACEHOLDER =
	"[EMPTY — required: add one human-written sentence before opening the pull request]" as const;
export const CONTRIBUTION_SCENARIO_PLACEHOLDER =
	"[EMPTY — required: describe the exercised scenario before opening the pull request]" as const;
export const CONTRIBUTION_RESULT_PLACEHOLDER =
	"[EMPTY — required: describe the observed result before opening the pull request]" as const;

const CONTRIBUTION_GOAL_MAX_BASE64_LENGTH =
	Math.ceil(CONTRIBUTION_GOAL_MAX_BYTES / 3) * 4 +
	Math.ceil((Math.ceil(CONTRIBUTION_GOAL_MAX_BYTES / 3) * 4) / 60) +
	2;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;
const CANDIDATE_COMMIT_PATTERN = /^[0-9a-f]{40,64}$/i;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const GITHUB_OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const GITHUB_REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+$/;

export type ContributionErrorCode =
	| "goal_fetch_failed"
	| "goal_ref_invalid"
	| "goal_commit_invalid"
	| "goal_tree_invalid"
	| "goal_path_missing"
	| "goal_blob_invalid"
	| "goal_too_large"
	| "goal_encoding_invalid"
	| "goal_base64_invalid"
	| "goal_content_invalid"
	| "goal_title_invalid"
	| "goal_changed"
	| "remote_invalid"
	| "remote_not_fork"
	| "remote_official"
	| "remote_missing"
	| "remote_changed"
	| "branch_invalid"
	| "branch_mismatch"
	| "worktree_dirty"
	| "candidate_invalid"
	| "candidate_head_mismatch"
	| "candidate_not_descendant"
	| "fork_verification_failed"
	| "base_inspection_failed"
	| "base_worktree_dirty"
	| "base_head_mismatch"
	| "approval_mismatch"
	| "push_failed";

export class ContributionError extends Error {
	readonly code: ContributionErrorCode;

	constructor(code: ContributionErrorCode, message: string) {
		super(message);
		this.name = "ContributionError";
		this.code = code;
	}
}

export interface ContributionGoal {
	readonly owner: typeof OFFICIAL_CONTRIBUTION_OWNER;
	readonly repository: typeof OFFICIAL_CONTRIBUTION_REPOSITORY;
	readonly ref: typeof OFFICIAL_CONTRIBUTION_REF;
	readonly path: typeof OFFICIAL_CONTRIBUTION_GOAL_PATH;
	readonly commitSha: string;
	readonly blobSha: string;
	readonly sha256: string;
	readonly title: string;
	readonly content: string;
}

export interface ContributionGitHubRequestSpec {
	readonly hostname: typeof OFFICIAL_CONTRIBUTION_HOST;
	readonly endpoint: string;
	readonly jq: string;
}

export type ContributionGitHubRequest = (spec: ContributionGitHubRequestSpec, signal?: AbortSignal) => Promise<unknown>;

export interface FetchOfficialContributionGoalOptions {
	readonly signal?: AbortSignal;
	readonly request?: ContributionGitHubRequest;
}

export interface ContributionBaseProof {
	readonly clean: true;
	readonly baseSha: string;
	readonly currentHead: string;
	readonly initialGoalCommitSha: string;
}

export interface ContributionPreflightGit {
	status(
		cwd: string,
		options: {
			readonly porcelainV1: true;
			readonly untrackedFiles: "all";
			readonly z: true;
			readonly signal?: AbortSignal;
		},
	): Promise<string>;
	headSha(cwd: string, signal?: AbortSignal): Promise<string | null>;
}

export interface VerifyContributionBaseOptions {
	readonly git?: ContributionPreflightGit;
	readonly signal?: AbortSignal;
}

export interface GitHubRemote {
	readonly owner: string;
	readonly repository: string;
	readonly slug: string;
	readonly canonicalUrl: string;
}

export interface ContributionCandidate {
	readonly status: "keep";
	readonly flagged: boolean;
	readonly segment: number;
	readonly runNumber: number | null;
	readonly commit: string;
	readonly scenario: string;
	readonly description: string;
	readonly metric: number;
	readonly metricName: string;
	readonly metricUnit: string;
}

export interface ContributionPrDraft {
	readonly title: string;
	readonly body: string;
	readonly base: typeof OFFICIAL_CONTRIBUTION_REF;
	readonly head: string;
	readonly humanSummary: "";
	readonly scenario: string;
	readonly result: string;
	readonly baseSha: string;
	readonly initialGoalCommitSha: string;
	readonly goalCommitSha: string;
	readonly goalBlobSha: string;
	readonly goalSha256: string;
	readonly candidateHead: string;
}

export interface ContributionPublicationGit {
	readRemoteUrl(cwd: string, remoteName: string, signal?: AbortSignal): Promise<string | undefined>;
	readPushRemoteUrl(cwd: string, remoteName: string, signal?: AbortSignal): Promise<string | undefined>;
	readBranch(cwd: string, signal?: AbortSignal): Promise<string | null>;
	readHead(cwd: string, signal?: AbortSignal): Promise<string | null>;
	readStatus(cwd: string, signal?: AbortSignal): Promise<string>;
	isAncestor(cwd: string, ancestor: string, descendant: string, signal?: AbortSignal): Promise<boolean>;
	push(
		cwd: string,
		options: {
			readonly remote: string;
			readonly verifiedRemoteUrl: string;
			readonly refspec: string;
			readonly forceWithLease: string;
			readonly signal?: AbortSignal;
		},
	): Promise<void>;
}

export interface PublishContributionCandidateOptions {
	readonly cwd: string;
	readonly remoteName: string;
	readonly confirmedRemoteUrl: string;
	readonly confirmedPushRemoteUrl: string;
	readonly branchName: string;
	readonly currentBranch: string | null;
	readonly currentHead: string;
	readonly baseProof: ContributionBaseProof;
	readonly worktreeClean: boolean;
	readonly currentSegment: number;
	readonly goal: ContributionGoal;
	readonly candidate: ContributionCandidate;
	readonly approvedDraft: ContributionPrDraft;
	readonly signal?: AbortSignal;
	readonly authorizePush?: () => void;
	readonly request?: ContributionGitHubRequest;
	readonly git?: ContributionPublicationGit;
}

export interface PublishedContributionCandidate {
	readonly remote: GitHubRemote;
	readonly branchName: string;
	readonly refspec: string;
	readonly compareUrl: string;
	readonly reviewUrl: string;
	readonly prDraft: ContributionPrDraft;
}

interface RefResponse {
	readonly sha: string;
	readonly type: string;
}

interface CommitResponse {
	readonly sha: string;
	readonly treeSha: string;
}

interface TreeEntryResponse {
	readonly path: string;
	readonly type: string;
	readonly sha: string;
	readonly size: number;
}

interface BlobResponse {
	readonly sha: string;
	readonly size: number;
	readonly encoding: string;
	readonly content: string;
}

export interface ContributionForkMetadata {
	readonly fork: true;
	readonly parent: string | null;
	readonly source: string | null;
}

export interface VerifyContributionForkOptions {
	readonly request?: ContributionGitHubRequest;
	readonly signal?: AbortSignal;
}

const DEFAULT_PUBLICATION_GIT: ContributionPublicationGit = {
	readRemoteUrl: (cwd, remoteName, signal) => git.remote.url(cwd, remoteName, signal),
	readPushRemoteUrl: (cwd, remoteName, signal) => git.remote.pushUrl(cwd, remoteName, signal),
	readBranch: (cwd, signal) => git.branch.current(cwd, signal),
	readHead: (cwd, signal) => git.head.sha(cwd, signal),
	readStatus: (cwd, signal) => git.status(cwd, { porcelainV1: true, untrackedFiles: "all", z: true, signal }),
	isAncestor: (cwd, ancestor, descendant, signal) => git.isAncestor(cwd, ancestor, descendant, signal),
	push: (cwd, options) => git.push(cwd, options),
};

const DEFAULT_PREFLIGHT_GIT: ContributionPreflightGit = {
	status: (cwd, options) => git.status(cwd, options),
	headSha: (cwd, signal) => git.head.sha(cwd, signal),
};

export async function fetchOfficialContributionGoal(
	cwd: string,
	options: FetchOfficialContributionGoalOptions = {},
): Promise<ContributionGoal> {
	const refSpec: ContributionGitHubRequestSpec = {
		hostname: OFFICIAL_CONTRIBUTION_HOST,
		endpoint: `/repos/${OFFICIAL_CONTRIBUTION_REPOSITORY}/git/ref/heads/${OFFICIAL_CONTRIBUTION_REF}`,
		jq: "{sha: .object.sha, type: .object.type}",
	};
	const ref = validateRefResponse(await requestGitHub(cwd, refSpec, options));

	const commitSpec: ContributionGitHubRequestSpec = {
		hostname: OFFICIAL_CONTRIBUTION_HOST,
		endpoint: `/repos/${OFFICIAL_CONTRIBUTION_REPOSITORY}/git/commits/${ref.sha}`,
		jq: "{sha: .sha, treeSha: .tree.sha}",
	};
	const commit = validateCommitResponse(await requestGitHub(cwd, commitSpec, options), ref.sha);

	const treeSpec: ContributionGitHubRequestSpec = {
		hostname: OFFICIAL_CONTRIBUTION_HOST,
		endpoint: `/repos/${OFFICIAL_CONTRIBUTION_REPOSITORY}/git/trees/${commit.treeSha}?recursive=1`,
		jq: `{truncated: .truncated, entries: [.tree[] | select(.path == ${JSON.stringify(OFFICIAL_CONTRIBUTION_GOAL_PATH)}) | {path, type, sha, size}]}`,
	};
	const treeEntry = validateTreeResponse(await requestGitHub(cwd, treeSpec, options));

	const blobSpec: ContributionGitHubRequestSpec = {
		hostname: OFFICIAL_CONTRIBUTION_HOST,
		endpoint: `/repos/${OFFICIAL_CONTRIBUTION_REPOSITORY}/git/blobs/${treeEntry.sha}`,
		jq: "{sha, size, encoding, content}",
	};
	const blob = validateBlobResponse(await requestGitHub(cwd, blobSpec, options), treeEntry);
	const decoded = decodeGoalBlob(blob);
	const content = decodeGoalContent(decoded);
	const title = extractGoalTitle(content);
	const sha256 = new Bun.SHA256().update(decoded).digest("hex");

	return {
		owner: OFFICIAL_CONTRIBUTION_OWNER,
		repository: OFFICIAL_CONTRIBUTION_REPOSITORY,
		ref: OFFICIAL_CONTRIBUTION_REF,
		path: OFFICIAL_CONTRIBUTION_GOAL_PATH,
		commitSha: commit.sha,
		blobSha: blob.sha,
		sha256,
		title,
		content,
	};
}

export function assertContributionGoalUnchanged(approved: ContributionGoal, current: ContributionGoal): void {
	const unchanged =
		current.commitSha === approved.commitSha &&
		current.blobSha === approved.blobSha &&
		current.sha256 === approved.sha256 &&
		current.title === approved.title &&
		current.content === approved.content;
	if (!unchanged) {
		throw new ContributionError(
			"goal_changed",
			"The official contribution goal changed after final confirmation; start cancelled.",
		);
	}
}

export function createContributionBaseProof(
	goal: ContributionGoal,
	currentHead: string | null,
	statusOutput: string,
): ContributionBaseProof {
	validateGoalForDraft(goal);
	if (statusOutput.length > 0) {
		throw new ContributionError("base_worktree_dirty", "Contribution mode requires a clean whole worktree.");
	}
	if (
		currentHead === null ||
		!CANDIDATE_COMMIT_PATTERN.test(currentHead) ||
		currentHead.toLowerCase() !== goal.commitSha.toLowerCase()
	) {
		throw new ContributionError(
			"base_head_mismatch",
			"Contribution mode requires local HEAD to equal the fetched official main commit.",
		);
	}
	const baseSha = currentHead.toLowerCase();
	return {
		clean: true,
		baseSha,
		currentHead: baseSha,
		initialGoalCommitSha: goal.commitSha.toLowerCase(),
	};
}

export async function verifyContributionBase(
	cwd: string,
	goal: ContributionGoal,
	options: VerifyContributionBaseOptions = {},
): Promise<ContributionBaseProof> {
	const preflightGit = options.git ?? DEFAULT_PREFLIGHT_GIT;
	let statusOutput: string;
	let currentHead: string | null;
	try {
		[statusOutput, currentHead] = await Promise.all([
			preflightGit.status(cwd, {
				porcelainV1: true,
				untrackedFiles: "all",
				z: true,
				signal: options.signal,
			}),
			preflightGit.headSha(cwd, options.signal),
		]);
	} catch (error) {
		throw new ContributionError(
			"base_inspection_failed",
			`Unable to verify the contribution base: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return createContributionBaseProof(goal, currentHead, statusOutput);
}

export function canonicalizeGitHubRemote(remoteUrl: string): GitHubRemote | null {
	const value = remoteUrl.trim();
	let owner: string;
	let repository: string;

	const scpMatch = /^git@github\.com:([^/]+)\/([^/]+)$/i.exec(value);
	if (scpMatch) {
		owner = scpMatch[1] ?? "";
		repository = scpMatch[2] ?? "";
	} else {
		let parsed: URL;
		try {
			parsed = new URL(value);
		} catch {
			return null;
		}
		if (parsed.hostname.toLowerCase() !== "github.com" || parsed.port !== "" || parsed.search || parsed.hash) {
			return null;
		}
		if (parsed.protocol === "https:") {
			if (parsed.username || parsed.password) return null;
		} else if (parsed.protocol === "ssh:") {
			if ((parsed.username && parsed.username !== "git") || parsed.password) return null;
		} else {
			return null;
		}
		const path = parsed.pathname.replace(/^\/+|\/+$/g, "");
		const segments = path.split("/");
		if (segments.length !== 2) return null;
		owner = segments[0] ?? "";
		repository = segments[1] ?? "";
	}

	repository = repository.replace(/\.git$/i, "");
	if (
		!GITHUB_OWNER_PATTERN.test(owner) ||
		!GITHUB_REPOSITORY_PATTERN.test(repository) ||
		repository === "." ||
		repository === ".." ||
		owner.includes("--")
	) {
		return null;
	}
	const normalizedOwner = owner.toLowerCase();
	const normalizedRepository = repository.toLowerCase();
	const slug = `${normalizedOwner}/${normalizedRepository}`;
	return {
		owner: normalizedOwner,
		repository: normalizedRepository,
		slug,
		canonicalUrl: `https://github.com/${slug}`,
	};
}

export function validateContributionForkRemote(remoteUrl: string): GitHubRemote {
	const remote = canonicalizeGitHubRemote(remoteUrl);
	if (!remote) {
		throw new ContributionError("remote_invalid", "The selected remote is not a safe github.com repository URL.");
	}
	if (remote.slug.toLowerCase() === OFFICIAL_CONTRIBUTION_REPOSITORY.toLowerCase()) {
		throw new ContributionError("remote_official", "Publishing directly to the official repository is not allowed.");
	}
	if (remote.repository.toLowerCase() !== OFFICIAL_CONTRIBUTION_REPO.toLowerCase()) {
		throw new ContributionError("remote_not_fork", "The selected remote is not an oh-my-pi fork.");
	}
	return remote;
}

export function buildContributionCompareUrl(remote: GitHubRemote, branchName: string): string {
	validateBranchName(branchName);
	validateRemoteObject(remote);
	const base = encodeURIComponent(OFFICIAL_CONTRIBUTION_REF);
	const owner = encodeURIComponent(remote.owner);
	const head = encodeURIComponent(branchName);
	return `https://github.com/${encodeURIComponent(OFFICIAL_CONTRIBUTION_OWNER)}/${encodeURIComponent(OFFICIAL_CONTRIBUTION_REPO)}/compare/${base}...${owner}:${head}?expand=1`;
}

export function buildContributionReviewUrl(remote: GitHubRemote, baseSha: string, candidateSha: string): string {
	validateRemoteObject(remote);
	if (!GIT_SHA_PATTERN.test(baseSha)) {
		throw new ContributionError("base_head_mismatch", "Contribution review requires an immutable base SHA.");
	}
	if (!CANDIDATE_COMMIT_PATTERN.test(candidateSha)) {
		throw new ContributionError("candidate_invalid", "Contribution review requires an immutable candidate SHA.");
	}
	const base = encodeURIComponent(baseSha.toLowerCase());
	const owner = encodeURIComponent(remote.owner);
	const head = encodeURIComponent(candidateSha.toLowerCase());
	return `https://github.com/${encodeURIComponent(OFFICIAL_CONTRIBUTION_OWNER)}/${encodeURIComponent(OFFICIAL_CONTRIBUTION_REPO)}/compare/${base}...${owner}:${head}?expand=1`;
}

export function buildContributionPrDraft(
	goal: ContributionGoal,
	candidate: ContributionCandidate,
	remote: GitHubRemote,
	branchName: string,
	baseProof: ContributionBaseProof,
): ContributionPrDraft {
	validateGoalForDraft(goal);
	validateBaseProof(baseProof);
	validateCandidate(candidate, candidate.segment);
	validateBranchName(branchName);
	validateRemoteObject(remote);
	const scenarioText = collapseInlineText(candidate.scenario);
	const resultText = collapseInlineText(candidate.description);
	const scenario = scenarioText;
	const result = resultText;
	const metricName = collapseInlineText(candidate.metricName);
	const metricUnit = collapseInlineText(candidate.metricUnit);
	const metric = `${candidate.metric}${metricUnit}`;
	const run = candidate.runNumber === null ? "kept candidate" : `run #${candidate.runNumber}`;
	const body = [
		"## Human summary (required)",
		"",
		`${CONTRIBUTION_HUMAN_SUMMARY_PLACEHOLDER} (base ${baseProof.baseSha}; candidate ${candidate.commit})`,
		"",
		"## Exercised scenario",
		"",
		scenario || CONTRIBUTION_SCENARIO_PLACEHOLDER,
		"",
		"## Observed result",
		"",
		result || CONTRIBUTION_RESULT_PLACEHOLDER,
		"",
		"## Frozen provenance",
		"",
		`- Goal: ${goal.title}`,
		`- Metric: ${metricName}=${metric}`,
		`- Source: ${run}`,
		`- Base SHA: ${baseProof.baseSha}`,
		`- Initial goal commit: ${baseProof.initialGoalCommitSha}`,
		`- Current segment goal commit: ${goal.commitSha}`,
		`- Goal blob: ${goal.blobSha}`,
		`- Goal SHA-256: ${goal.sha256}`,
		`- Candidate HEAD: ${candidate.commit}`,
	].join("\n");
	return {
		title: `Autoresearch: ${goal.title}`,
		body,
		base: OFFICIAL_CONTRIBUTION_REF,
		head: `${remote.owner}:${branchName}`,
		humanSummary: "",
		scenario,
		result,
		baseSha: baseProof.baseSha,
		initialGoalCommitSha: baseProof.initialGoalCommitSha,
		goalCommitSha: goal.commitSha,
		goalBlobSha: goal.blobSha,
		goalSha256: goal.sha256,
		candidateHead: candidate.commit,
	};
}

export async function publishContributionCandidate(
	options: PublishContributionCandidateOptions,
): Promise<PublishedContributionCandidate> {
	validateBranchName(options.branchName);
	validateGoalForDraft(options.goal);
	validateBaseProof(options.baseProof);
	if (typeof options.currentHead !== "string" || !CANDIDATE_COMMIT_PATTERN.test(options.currentHead)) {
		throw new ContributionError("candidate_head_mismatch", "Contribution review requires the exact current HEAD.");
	}
	validateCandidate(options.candidate, options.currentSegment, options.currentHead);
	if (options.currentBranch !== options.branchName) {
		throw new ContributionError(
			"branch_mismatch",
			`Contribution review requires the recorded branch ${options.branchName} to be checked out.`,
		);
	}
	if (!options.worktreeClean) {
		throw new ContributionError("worktree_dirty", "Contribution review requires a clean worktree.");
	}
	validateRemoteName(options.remoteName);
	const approvedRemote = validateContributionForkRemote(options.confirmedRemoteUrl);
	const approvedPushRemote = validateContributionForkRemote(options.confirmedPushRemoteUrl);
	if (approvedPushRemote.slug !== approvedRemote.slug) {
		throw new ContributionError("remote_changed", "The approved push destination differs from the confirmed fork.");
	}
	const approvedDraft = buildContributionPrDraft(
		options.goal,
		options.candidate,
		approvedRemote,
		options.branchName,
		options.baseProof,
	);
	validateApprovedDraft(options.approvedDraft, approvedDraft);

	const publicationGit = options.git ?? DEFAULT_PUBLICATION_GIT;
	const currentRemoteUrl = await publicationGit.readRemoteUrl(options.cwd, options.remoteName, options.signal);
	if (currentRemoteUrl === undefined) {
		throw new ContributionError("remote_missing", `The confirmed remote ${options.remoteName} no longer exists.`);
	}
	if (currentRemoteUrl !== options.confirmedRemoteUrl) {
		throw new ContributionError(
			"remote_changed",
			`The confirmed remote ${options.remoteName} changed before review.`,
		);
	}
	const currentRemote = validateContributionForkRemote(currentRemoteUrl);
	if (currentRemote.slug !== approvedRemote.slug) {
		throw new ContributionError("remote_changed", `The confirmed remote ${options.remoteName} changed destination.`);
	}
	validateContributionPushRemoteUrl(
		await publicationGit.readPushRemoteUrl(options.cwd, options.remoteName, options.signal),
		options.confirmedPushRemoteUrl,
		approvedRemote,
		options.remoteName,
	);
	await verifyContributionFork(options.cwd, currentRemote, {
		request: options.request,
		signal: options.signal,
	});

	const [currentBranch, currentHead, statusOutput] = await Promise.all([
		publicationGit.readBranch(options.cwd, options.signal),
		publicationGit.readHead(options.cwd, options.signal),
		publicationGit.readStatus(options.cwd, options.signal),
	]);
	if (currentBranch !== options.branchName) {
		throw new ContributionError(
			"branch_mismatch",
			`Contribution review requires the recorded branch ${options.branchName} to remain checked out.`,
		);
	}
	if (
		currentHead === null ||
		!CANDIDATE_COMMIT_PATTERN.test(currentHead) ||
		currentHead.toLowerCase() !== options.candidate.commit.toLowerCase()
	) {
		throw new ContributionError("candidate_head_mismatch", "The approved contribution candidate is no longer HEAD.");
	}
	if (statusOutput.length > 0) {
		throw new ContributionError("worktree_dirty", "The contribution worktree changed after approval.");
	}

	const targetRef = `refs/heads/${options.branchName}`;
	const refspec = `${options.candidate.commit}:${targetRef}`;
	const compareUrl = buildContributionCompareUrl(currentRemote, options.branchName);
	const reviewUrl = buildContributionReviewUrl(currentRemote, options.baseProof.baseSha, options.candidate.commit);
	const prDraft = buildContributionPrDraft(
		options.goal,
		options.candidate,
		currentRemote,
		options.branchName,
		options.baseProof,
	);
	if (
		!(await publicationGit.isAncestor(
			options.cwd,
			options.baseProof.baseSha,
			options.candidate.commit,
			options.signal,
		))
	) {
		throw new ContributionError(
			"candidate_not_descendant",
			"The contribution candidate does not descend from the frozen official base.",
		);
	}
	const [finalBranch, finalHead, finalStatusOutput, finalPushRemoteUrl] = await Promise.all([
		publicationGit.readBranch(options.cwd, options.signal),
		publicationGit.readHead(options.cwd, options.signal),
		publicationGit.readStatus(options.cwd, options.signal),
		publicationGit.readPushRemoteUrl(options.cwd, options.remoteName, options.signal),
	]);
	if (finalBranch !== options.branchName) {
		throw new ContributionError(
			"branch_mismatch",
			`Contribution review requires the recorded branch ${options.branchName} to remain checked out.`,
		);
	}
	if (finalHead !== options.candidate.commit) {
		throw new ContributionError("candidate_head_mismatch", "The approved contribution candidate is no longer HEAD.");
	}
	if (finalStatusOutput.length > 0) {
		throw new ContributionError("worktree_dirty", "The contribution worktree changed after approval.");
	}
	validateContributionPushRemoteUrl(
		finalPushRemoteUrl,
		options.confirmedPushRemoteUrl,
		approvedRemote,
		options.remoteName,
	);
	options.authorizePush?.();
	try {
		await publicationGit.push(options.cwd, {
			remote: options.remoteName,
			verifiedRemoteUrl: options.confirmedPushRemoteUrl,
			refspec,
			forceWithLease: `${targetRef}:`,
			signal: options.signal,
		});
	} catch (error) {
		throw new ContributionError(
			"push_failed",
			`Failed to publish the contribution candidate: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return {
		remote: currentRemote,
		branchName: options.branchName,
		refspec,
		compareUrl,
		reviewUrl,
		prDraft,
	};
}

async function requestGitHub(
	cwd: string,
	spec: ContributionGitHubRequestSpec,
	options: FetchOfficialContributionGoalOptions,
): Promise<unknown> {
	try {
		return await executeGitHubRequest(cwd, spec, options.request, options.signal);
	} catch (error) {
		if (error instanceof ContributionError) throw error;
		throw new ContributionError(
			"goal_fetch_failed",
			`Unable to fetch the official contribution goal: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

export async function verifyContributionFork(
	cwd: string,
	remote: GitHubRemote,
	options: VerifyContributionForkOptions = {},
): Promise<ContributionForkMetadata> {
	validateRemoteObject(remote);
	const spec: ContributionGitHubRequestSpec = {
		hostname: OFFICIAL_CONTRIBUTION_HOST,
		endpoint: `/repos/${remote.slug}`,
		jq: "{fork: .fork, parent: .parent.full_name, source: .source.full_name}",
	};
	let value: unknown;
	try {
		value = await executeGitHubRequest(cwd, spec, options.request, options.signal);
	} catch (error) {
		throw new ContributionError(
			"fork_verification_failed",
			`Unable to verify the GitHub fork: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (
		!isRecord(value) ||
		typeof value.fork !== "boolean" ||
		!(value.parent === null || typeof value.parent === "string") ||
		!(value.source === null || typeof value.source === "string")
	) {
		throw new ContributionError("fork_verification_failed", "GitHub returned malformed fork metadata.");
	}
	if (!value.fork) {
		throw new ContributionError("remote_not_fork", "The selected GitHub repository is not a fork.");
	}
	const official = OFFICIAL_CONTRIBUTION_REPOSITORY.toLowerCase();
	const parent = value.parent?.toLowerCase() ?? null;
	const source = value.source?.toLowerCase() ?? null;
	if (parent !== official && source !== official) {
		throw new ContributionError(
			"remote_not_fork",
			"The selected GitHub repository is not a fork of the official repository.",
		);
	}
	return { fork: true, parent: value.parent, source: value.source };
}

async function executeGitHubRequest(
	cwd: string,
	spec: ContributionGitHubRequestSpec,
	request: ContributionGitHubRequest | undefined,
	signal: AbortSignal | undefined,
): Promise<unknown> {
	if (request) return request(spec, signal);
	return git.github.json<unknown>(
		cwd,
		["api", spec.endpoint, "--hostname", spec.hostname, "--method", "GET", "--jq", spec.jq],
		signal,
		{ repoProvided: true },
	);
}

function validateRefResponse(value: unknown): RefResponse {
	if (!isRecord(value) || !isGitSha(value.sha) || value.type !== "commit") {
		throw new ContributionError("goal_ref_invalid", "The official goal ref response is malformed.");
	}
	return { sha: value.sha.toLowerCase(), type: value.type };
}

function validateCommitResponse(value: unknown, expectedSha: string): CommitResponse {
	if (!isRecord(value) || !isGitSha(value.sha) || !isGitSha(value.treeSha)) {
		throw new ContributionError("goal_commit_invalid", "The official goal commit response is malformed.");
	}
	if (value.sha.toLowerCase() !== expectedSha.toLowerCase()) {
		throw new ContributionError("goal_commit_invalid", "The official goal commit did not match the requested ref.");
	}
	return { sha: value.sha.toLowerCase(), treeSha: value.treeSha.toLowerCase() };
}

function validateTreeResponse(value: unknown): TreeEntryResponse {
	if (!isRecord(value) || value.truncated !== false || !Array.isArray(value.entries)) {
		throw new ContributionError("goal_tree_invalid", "The official goal tree response is malformed or truncated.");
	}
	if (value.entries.length === 0) {
		throw new ContributionError(
			"goal_path_missing",
			`The official goal path ${OFFICIAL_CONTRIBUTION_GOAL_PATH} is missing.`,
		);
	}
	if (value.entries.length !== 1) {
		throw new ContributionError("goal_tree_invalid", "The official goal tree contained duplicate path entries.");
	}
	const entry: unknown = value.entries[0];
	if (
		!isRecord(entry) ||
		entry.path !== OFFICIAL_CONTRIBUTION_GOAL_PATH ||
		entry.type !== "blob" ||
		!isGitSha(entry.sha) ||
		!isNonnegativeInteger(entry.size)
	) {
		throw new ContributionError("goal_tree_invalid", "The official goal tree entry is malformed.");
	}
	if (entry.size > CONTRIBUTION_GOAL_MAX_BYTES) {
		throw new ContributionError("goal_too_large", "The official contribution goal exceeds 32 KiB.");
	}
	return {
		path: entry.path,
		type: entry.type,
		sha: entry.sha.toLowerCase(),
		size: entry.size,
	};
}

function validateBlobResponse(value: unknown, treeEntry: TreeEntryResponse): BlobResponse {
	if (
		!isRecord(value) ||
		!isGitSha(value.sha) ||
		!isNonnegativeInteger(value.size) ||
		typeof value.encoding !== "string" ||
		typeof value.content !== "string"
	) {
		throw new ContributionError("goal_blob_invalid", "The official goal blob response is malformed.");
	}
	if (value.size > CONTRIBUTION_GOAL_MAX_BYTES) {
		throw new ContributionError("goal_too_large", "The official contribution goal exceeds 32 KiB.");
	}
	if (value.sha.toLowerCase() !== treeEntry.sha || value.size !== treeEntry.size) {
		throw new ContributionError("goal_blob_invalid", "The official goal blob did not match its tree entry.");
	}
	if (value.encoding !== "base64") {
		throw new ContributionError("goal_encoding_invalid", "The official goal blob is not base64 encoded.");
	}
	if (value.content.length > CONTRIBUTION_GOAL_MAX_BASE64_LENGTH) {
		throw new ContributionError("goal_too_large", "The encoded official contribution goal exceeds its size bound.");
	}
	return {
		sha: value.sha.toLowerCase(),
		size: value.size,
		encoding: value.encoding,
		content: value.content,
	};
}

function decodeGoalBlob(blob: BlobResponse): Buffer {
	const normalized = blob.content.replace(/[\r\n]/g, "");
	const maxEncodedLength = Math.ceil(CONTRIBUTION_GOAL_MAX_BYTES / 3) * 4;
	if (normalized.length > maxEncodedLength || normalized.length % 4 !== 0 || !BASE64_PATTERN.test(normalized)) {
		throw new ContributionError("goal_base64_invalid", "The official goal blob contains malformed base64.");
	}
	const decoded = Buffer.from(normalized, "base64");
	if (decoded.toString("base64") !== normalized) {
		throw new ContributionError("goal_base64_invalid", "The official goal blob contains non-canonical base64.");
	}
	if (decoded.byteLength > CONTRIBUTION_GOAL_MAX_BYTES) {
		throw new ContributionError("goal_too_large", "The decoded official contribution goal exceeds 32 KiB.");
	}
	if (decoded.byteLength !== blob.size) {
		throw new ContributionError("goal_blob_invalid", "The decoded official goal size does not match the Git blob.");
	}
	return decoded;
}

function decodeGoalContent(decoded: Uint8Array): string {
	let content: string;
	try {
		content = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
	} catch {
		throw new ContributionError("goal_content_invalid", "The official contribution goal is not valid UTF-8.");
	}
	if (content.includes("\0")) {
		throw new ContributionError("goal_content_invalid", "The official contribution goal contains a NUL byte.");
	}
	return content;
}

function extractGoalTitle(content: string): string {
	let start = 0;
	while (start <= content.length) {
		const newline = content.indexOf("\n", start);
		const end = newline < 0 ? content.length : newline;
		const line = content.slice(start, end).replace(/\r$/, "").trim();
		if (line.length > 0) {
			if (!line.startsWith("# ")) {
				throw new ContributionError(
					"goal_title_invalid",
					"The first nonblank goal line must be a level-one title.",
				);
			}
			const title = line.slice(2).trim();
			if (title.length === 0 || title.length > CONTRIBUTION_GOAL_TITLE_MAX_LENGTH || /[\x00-\x1f\x7f]/.test(title)) {
				throw new ContributionError("goal_title_invalid", "The official goal title must be 1 to 120 characters.");
			}
			return title;
		}
		if (newline < 0) break;
		start = newline + 1;
	}
	throw new ContributionError("goal_title_invalid", "The official contribution goal has no title.");
}

function validateBranchName(branchName: string): void {
	const segments = branchName.split("/");
	if (
		branchName.length === 0 ||
		branchName.length > 255 ||
		branchName === "@" ||
		branchName.startsWith("-") ||
		branchName.startsWith("/") ||
		branchName.endsWith("/") ||
		branchName.endsWith(".") ||
		branchName.includes("//") ||
		branchName.includes("..") ||
		branchName.includes("@{") ||
		/[\x00-\x20\x7f~^:?*\\[]/.test(branchName) ||
		segments.some(segment => segment.length === 0 || segment.startsWith(".") || segment.endsWith(".lock"))
	) {
		throw new ContributionError("branch_invalid", "The contribution branch is not a safe Git ref name.");
	}
}

function validateCandidate(candidate: ContributionCandidate, currentSegment: number, currentHead?: string): void {
	if (
		!isRecord(candidate) ||
		candidate.status !== "keep" ||
		candidate.flagged !== false ||
		!Number.isInteger(candidate.segment) ||
		!Number.isInteger(currentSegment) ||
		candidate.segment !== currentSegment ||
		(candidate.runNumber !== null && (!Number.isInteger(candidate.runNumber) || candidate.runNumber <= 0)) ||
		typeof candidate.scenario !== "string" ||
		collapseInlineText(candidate.scenario).length > 500 ||
		typeof candidate.description !== "string" ||
		collapseInlineText(candidate.description).length > 500 ||
		typeof candidate.metric !== "number" ||
		!Number.isFinite(candidate.metric) ||
		typeof candidate.metricName !== "string" ||
		collapseInlineText(candidate.metricName).length === 0 ||
		collapseInlineText(candidate.metricName).length > 80 ||
		typeof candidate.metricUnit !== "string" ||
		collapseInlineText(candidate.metricUnit).length > 20
	) {
		throw new ContributionError(
			"candidate_invalid",
			"Contribution review requires an unflagged kept result from the current segment with bounded evidence.",
		);
	}
	if (typeof candidate.commit !== "string" || !CANDIDATE_COMMIT_PATTERN.test(candidate.commit)) {
		throw new ContributionError(
			currentHead === undefined ? "candidate_invalid" : "candidate_head_mismatch",
			"The kept contribution candidate has no valid commit.",
		);
	}
	if (
		currentHead !== undefined &&
		(!CANDIDATE_COMMIT_PATTERN.test(currentHead) || candidate.commit.toLowerCase() !== currentHead.toLowerCase())
	) {
		throw new ContributionError(
			"candidate_head_mismatch",
			"The kept contribution candidate is not the current HEAD.",
		);
	}
}

function validateBaseProof(proof: ContributionBaseProof): void {
	if (
		!isRecord(proof) ||
		proof.clean !== true ||
		typeof proof.baseSha !== "string" ||
		typeof proof.currentHead !== "string" ||
		typeof proof.initialGoalCommitSha !== "string" ||
		!CANDIDATE_COMMIT_PATTERN.test(proof.baseSha) ||
		proof.baseSha.toLowerCase() !== proof.currentHead.toLowerCase() ||
		proof.baseSha.toLowerCase() !== proof.initialGoalCommitSha.toLowerCase()
	) {
		throw new ContributionError("base_head_mismatch", "The frozen contribution base proof is inconsistent.");
	}
}

function validateApprovedDraft(approved: ContributionPrDraft, expected: ContributionPrDraft): void {
	if (
		!isRecord(approved) ||
		approved.title !== expected.title ||
		approved.body !== expected.body ||
		approved.base !== expected.base ||
		approved.head !== expected.head ||
		approved.humanSummary !== "" ||
		approved.scenario !== expected.scenario ||
		approved.result !== expected.result ||
		approved.baseSha !== expected.baseSha ||
		approved.initialGoalCommitSha !== expected.initialGoalCommitSha ||
		approved.goalCommitSha !== expected.goalCommitSha ||
		approved.goalBlobSha !== expected.goalBlobSha ||
		approved.goalSha256 !== expected.goalSha256 ||
		approved.candidateHead !== expected.candidateHead
	) {
		throw new ContributionError(
			"approval_mismatch",
			"The approved contribution draft does not exactly match the frozen publication candidate.",
		);
	}
}

function validateGoalForDraft(goal: ContributionGoal): void {
	if (
		!isRecord(goal) ||
		goal.owner !== OFFICIAL_CONTRIBUTION_OWNER ||
		goal.repository !== OFFICIAL_CONTRIBUTION_REPOSITORY ||
		goal.ref !== OFFICIAL_CONTRIBUTION_REF ||
		goal.path !== OFFICIAL_CONTRIBUTION_GOAL_PATH ||
		!isGitSha(goal.commitSha) ||
		!isGitSha(goal.blobSha) ||
		typeof goal.sha256 !== "string" ||
		!/^[0-9a-f]{64}$/i.test(goal.sha256) ||
		typeof goal.title !== "string" ||
		goal.title.length === 0 ||
		goal.title.length > CONTRIBUTION_GOAL_TITLE_MAX_LENGTH ||
		typeof goal.content !== "string"
	) {
		throw new ContributionError("goal_content_invalid", "The contribution goal provenance is malformed.");
	}
	const contentBytes = Buffer.byteLength(goal.content);
	if (contentBytes > CONTRIBUTION_GOAL_MAX_BYTES || goal.content.includes("\0")) {
		throw new ContributionError("goal_content_invalid", "The contribution goal content violates its safety bounds.");
	}
	const title = extractGoalTitle(goal.content);
	const sha256 = new Bun.SHA256().update(goal.content).digest("hex");
	if (title !== goal.title || sha256.toLowerCase() !== goal.sha256.toLowerCase()) {
		throw new ContributionError(
			"goal_content_invalid",
			"The contribution goal content does not match its provenance.",
		);
	}
}

function validateRemoteObject(remote: GitHubRemote): void {
	if (!isRecord(remote) || typeof remote.canonicalUrl !== "string") {
		throw new ContributionError("remote_invalid", "The contribution remote is malformed.");
	}
	const canonical = canonicalizeGitHubRemote(remote.canonicalUrl);
	if (
		!canonical ||
		canonical.slug !== remote.slug ||
		canonical.owner !== remote.owner ||
		canonical.repository !== remote.repository
	) {
		throw new ContributionError("remote_invalid", "The contribution remote is malformed.");
	}
	validateContributionForkRemote(remote.canonicalUrl);
}

function validateRemoteName(remoteName: string): void {
	if (remoteName.length === 0 || /[\x00-\x20\x7f]/.test(remoteName) || remoteName.startsWith("-")) {
		throw new ContributionError("remote_invalid", "The contribution remote name is invalid.");
	}
}

function validateContributionPushRemoteUrl(
	remoteUrl: string | undefined,
	confirmedRemoteUrl: string,
	approvedRemote: GitHubRemote,
	remoteName: string,
): GitHubRemote {
	if (remoteUrl === undefined) {
		throw new ContributionError("remote_missing", `The confirmed push remote ${remoteName} no longer exists.`);
	}
	const remote = validateContributionForkRemote(remoteUrl);
	if (remoteUrl !== confirmedRemoteUrl) {
		throw new ContributionError("remote_changed", `The confirmed push destination for ${remoteName} changed.`);
	}
	if (remote.slug !== approvedRemote.slug) {
		throw new ContributionError("remote_changed", `The push destination for ${remoteName} changed repository.`);
	}
	return remote;
}

function collapseInlineText(value: string): string {
	return value.trim().replace(/\s+/g, " ");
}

function isGitSha(value: unknown): value is string {
	return typeof value === "string" && GIT_SHA_PATTERN.test(value);
}

function isNonnegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
