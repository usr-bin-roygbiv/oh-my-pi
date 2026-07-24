import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AutocompleteItem } from "@oh-my-pi/pi-tui";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import type { ExtensionContext, ExtensionFactory } from "../extensibility/extensions";
import { ToolAbortError, throwIfAborted } from "../tools/tool-errors";
import * as git from "../utils/git";
import commandResumeTemplate from "./command-resume.md" with { type: "text" };
import {
	assertContributionGoalUnchanged,
	buildContributionCompareUrl,
	buildContributionPrDraft,
	buildContributionReviewUrl,
	CONTRIBUTION_HARNESS_SHA256_ASI_KEY,
	CONTRIBUTION_INVOCATION_SHA256_ASI_KEY,
	CONTRIBUTION_WORKTREE_TREE_ASI_KEY,
	type ContributionCandidate,
	ContributionError,
	type ContributionGoal,
	type ContributionPrDraft,
	type ContributionPublicationGit,
	fetchOfficialContributionGoal,
	type GitHubRemote,
	type PublishedContributionCandidate,
	publishContributionCandidate,
	validateContributionForkRemote,
	verifyContributionBase,
	verifyContributionFork,
} from "./contribution";
import contributionGoalRefreshTemplate from "./contribution-goal-refresh.md" with { type: "text" };
import contributionPromptTemplate from "./contribution-prompt.md" with { type: "text" };
import { createDashboardController } from "./dashboard";
import { allocateAutoresearchBranchName, ensureAutoresearchBranch } from "./git";
import { formatNum } from "./helpers";
import promptTemplate from "./prompt.md" with { type: "text" };
import setupPromptTemplate from "./prompt-setup.md" with { type: "text" };
import resumeMessageTemplate from "./resume-message.md" with { type: "text" };
import {
	buildExperimentState,
	createExperimentState,
	createRuntimeStore,
	currentResults,
	findBaselineMetric,
	findBaselineRunNumber,
	findBestKeptMetric,
	reconstructControlState,
} from "./state";
import {
	type AutoresearchStorage,
	hasActiveAutoresearchSession,
	openAutoresearchStorage,
	openAutoresearchStorageIfExists,
	type RunRow,
	type SessionRow,
} from "./storage";
import { createInitExperimentTool } from "./tools/init-experiment";
import { createLogExperimentTool } from "./tools/log-experiment";
import { createRunExperimentTool } from "./tools/run-experiment";
import { createUpdateNotesTool } from "./tools/update-notes";
import type {
	AutoresearchMutationAuthorization,
	AutoresearchRuntime,
	AutoresearchSessionOwner,
	ContributionRunningState,
	ExperimentResult,
	PendingRunSummary,
} from "./types";
import { CONTRIBUTION_HEAD_SHA_ASI_KEY } from "./types";

const EXPERIMENT_TOOL_NAMES = ["init_experiment", "run_experiment", "log_experiment", "update_notes"];

const CONTRIBUTION_PAUSE_MARKER = "[CONTRIBUTE_PAUSE]";

interface ContributionRemoteChoice {
	name: string;
	url: string;
	pushUrl: string;
	remote: GitHubRemote;
	pushRemote: GitHubRemote;
}

interface ContributionStartTransaction {
	token: symbol | null;
	phase: "confirming" | "activating";
	readonly settlement: PromiseWithResolvers<void>;
}

interface AutoresearchMutationOperation {
	readonly controller: AbortController;
	readonly settlement: PromiseWithResolvers<void>;
}

interface ContributionPublicationOperation {
	readonly controller: AbortController;
	phase: "pre-push" | "pushing" | "committed";
	readonly settlement: PromiseWithResolvers<void>;
}

interface AsyncLifecycleIdentity {
	readonly sessionKey: string;
	readonly epoch: number;
	readonly runtime: AutoresearchRuntime;
	readonly contribution: AutoresearchRuntime["contribution"];
	readonly state: AutoresearchRuntime["state"];
	readonly autoresearchMode: boolean;
	readonly ordinarySessionOwner: AutoresearchRuntime["ordinarySessionOwner"];
	readonly ordinaryOwnerlessBranch: AutoresearchRuntime["ordinaryOwnerlessBranch"];
}

interface TransitionAdmissionHold {
	readonly sessionKey: string;
	readonly release: () => void;
	endReceived: boolean;
	settled: boolean;
}

const CONTRIBUTION_PUBLICATION_ENTRY = "autoresearch-contribution-publication";
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

interface ContributionPublicationEntryData {
	readonly phase: "intent" | "success";
	readonly remoteName: string;
	readonly remoteUrl: string;
	readonly pushRemoteUrl: string;
	readonly branchName: string;
	readonly targetRef: string;
	readonly refspec: string;
	readonly candidateHead: string;
	readonly baseSha: string;
	readonly reviewUrl: string;
	readonly compareUrl: string;
	readonly prDraft: ContributionPrDraft;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maxLength: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= maxLength && !value.includes("\0");
}

function boundedPossiblyEmptyString(value: unknown, maxLength: number): value is string {
	return typeof value === "string" && value.length <= maxLength && !value.includes("\0");
}

function parsePublicationDraft(
	value: unknown,
	remote: GitHubRemote,
	branchName: string,
	baseSha: string,
	candidateHead: string,
): ContributionPrDraft | null {
	if (!isRecord(value)) return null;
	if (!boundedString(value.title, 500) || !boundedString(value.body, 32 * 1024)) return null;
	if (value.humanSummary !== "" || value.base !== "main" || value.head !== `${remote.owner}:${branchName}`)
		return null;
	if (value.baseSha !== baseSha || value.candidateHead !== candidateHead) return null;
	if (!boundedPossiblyEmptyString(value.scenario, 500) || !boundedPossiblyEmptyString(value.result, 500)) return null;
	if (
		!boundedString(value.initialGoalCommitSha, 40) ||
		!boundedString(value.goalCommitSha, 40) ||
		!boundedString(value.goalBlobSha, 40) ||
		!boundedString(value.goalSha256, 64)
	) {
		return null;
	}
	return value as unknown as ContributionPrDraft;
}

function parsePublicationEntryData(value: unknown): ContributionPublicationEntryData | null {
	if (!isRecord(value) || (value.phase !== "intent" && value.phase !== "success")) return null;
	if (
		!boundedString(value.remoteName, 100) ||
		!boundedString(value.remoteUrl, 2048) ||
		!boundedString(value.pushRemoteUrl, 2048) ||
		!boundedString(value.branchName, 250) ||
		!boundedString(value.targetRef, 300) ||
		!boundedString(value.refspec, 400) ||
		!boundedString(value.candidateHead, 40) ||
		!boundedString(value.baseSha, 40) ||
		!boundedString(value.reviewUrl, 4096) ||
		!boundedString(value.compareUrl, 4096)
	) {
		return null;
	}
	const candidateHead = value.candidateHead.toLowerCase();
	const baseSha = value.baseSha.toLowerCase();
	if (!GIT_SHA_PATTERN.test(candidateHead) || !GIT_SHA_PATTERN.test(baseSha)) return null;
	try {
		const remote = validateContributionForkRemote(value.remoteUrl);
		const pushRemote = validateContributionForkRemote(value.pushRemoteUrl);
		if (remote.slug !== pushRemote.slug) return null;
		const targetRef = `refs/heads/${value.branchName}`;
		if (value.targetRef !== targetRef || value.refspec !== `${candidateHead}:${targetRef}`) return null;
		const reviewUrl = buildContributionReviewUrl(remote, baseSha, candidateHead);
		const compareUrl = buildContributionCompareUrl(remote, value.branchName);
		if (value.reviewUrl !== reviewUrl || value.compareUrl !== compareUrl) return null;
		const prDraft = parsePublicationDraft(value.prDraft, remote, value.branchName, baseSha, candidateHead);
		if (!prDraft) return null;
		return {
			phase: value.phase,
			remoteName: value.remoteName,
			remoteUrl: value.remoteUrl,
			pushRemoteUrl: value.pushRemoteUrl,
			branchName: value.branchName,
			targetRef,
			refspec: value.refspec,
			candidateHead,
			baseSha,
			reviewUrl,
			compareUrl,
			prDraft,
		};
	} catch {
		return null;
	}
}

function reconstructPublicationEntry(entries: readonly unknown[]): ContributionPublicationEntryData | null {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== CONTRIBUTION_PUBLICATION_ENTRY) continue;
		return parsePublicationEntryData(entry.data);
	}
	return null;
}

function renderPublicationHandoff(prefix: string, publication: ContributionPublicationEntryData): string {
	return `${prefix}\nImmutable SHA review: ${publication.reviewUrl}\nMutable branch compare: ${publication.compareUrl}\nCandidate: ${publication.candidateHead}\n\nPR draft (human sentence intentionally empty):\n${publication.prDraft.title}\n\n${publication.prDraft.body}`;
}

function createPublicationEntryData(
	phase: ContributionPublicationEntryData["phase"],
	contribution: ContributionRunningState,
	pushRemoteUrl: string,
	candidateHead: string,
	publication: PublishedContributionCandidate,
): ContributionPublicationEntryData {
	const targetRef = `refs/heads/${publication.branchName}`;
	return {
		phase,
		remoteName: contribution.remoteName,
		remoteUrl: contribution.remoteUrl,
		pushRemoteUrl,
		branchName: publication.branchName,
		targetRef,
		refspec: publication.refspec,
		candidateHead,
		baseSha: contribution.baseProof.baseSha,
		reviewUrl: publication.reviewUrl,
		compareUrl: publication.compareUrl,
		prDraft: publication.prDraft,
	};
}

function hasExecutableContributionTddProof(
	session: SessionRow,
	candidate: RunRow | null,
	loggedRuns: readonly RunRow[],
): boolean {
	const command = session.preferredCommand?.trim() ?? "";
	const candidateHarness = candidate?.parsedAsi?.[CONTRIBUTION_HARNESS_SHA256_ASI_KEY];
	const candidateInvocation = candidate?.parsedAsi?.[CONTRIBUTION_INVOCATION_SHA256_ASI_KEY];
	const candidateTree = candidate?.parsedAsi?.[CONTRIBUTION_WORKTREE_TREE_ASI_KEY];
	const candidateHead = candidate?.parsedAsi?.[CONTRIBUTION_HEAD_SHA_ASI_KEY];
	if (
		!candidate ||
		command.length === 0 ||
		candidate.sessionId !== session.id ||
		candidate.segment !== session.currentSegment ||
		candidate.command !== command ||
		candidate.status !== "keep" ||
		candidate.flagged ||
		candidate.completedAt === null ||
		candidate.timedOut ||
		candidate.exitCode !== 0 ||
		typeof candidateHarness !== "string" ||
		!/^[0-9a-f]{64}$/.test(candidateHarness) ||
		typeof candidateInvocation !== "string" ||
		!/^[0-9a-f]{64}$/.test(candidateInvocation) ||
		typeof candidateTree !== "string" ||
		!/^[0-9a-f]{40}$/.test(candidateTree) ||
		typeof candidateHead !== "string" ||
		!/^[0-9a-f]{40}$/.test(candidateHead)
	) {
		return false;
	}
	return loggedRuns.some(run => {
		const redHarness = run.parsedAsi?.[CONTRIBUTION_HARNESS_SHA256_ASI_KEY];
		const redInvocation = run.parsedAsi?.[CONTRIBUTION_INVOCATION_SHA256_ASI_KEY];
		const redTree = run.parsedAsi?.[CONTRIBUTION_WORKTREE_TREE_ASI_KEY];
		return (
			run.id < candidate.id &&
			run.sessionId === session.id &&
			run.segment === session.currentSegment &&
			run.command === command &&
			run.status === "checks_failed" &&
			!run.flagged &&
			run.completedAt !== null &&
			(run.timedOut || (run.exitCode !== null && run.exitCode !== 0)) &&
			redHarness === candidateHarness &&
			redInvocation === candidateInvocation &&
			redTree !== candidateTree &&
			typeof redTree === "string" &&
			/^[0-9a-f]{40}$/.test(redTree)
		);
	});
}

const contributionPublicationGit: ContributionPublicationGit = {
	readRemoteUrl: (cwd, remote, signal) => git.remote.url(cwd, remote, signal),
	readPushRemoteUrl: (cwd, remote, signal) => git.remote.pushUrl(cwd, remote, signal),
	readBranch: (cwd, signal) => git.branch.current(cwd, signal),
	readHead: (cwd, signal) => git.head.sha(cwd, signal),
	readStatus: (cwd, signal) => git.status(cwd, { porcelainV1: true, untrackedFiles: "all", z: true, signal }),
	readRawCommitTree: async (cwd, sha, signal) => (await git.rawCommit(cwd, sha, signal))?.treeSha ?? null,
	isAncestor: (cwd, ancestor, descendant, signal) => git.isAncestor(cwd, ancestor, descendant, signal),
	push: (cwd, options) =>
		git.push(cwd, {
			remote: options.remote,
			verifiedRemoteUrl: options.verifiedRemoteUrl,
			refspec: options.refspec,
			forceWithLease: options.forceWithLease,
			recurseSubmodules: options.recurseSubmodules,
			signal: options.signal,
		}),
};

async function discoverContributionRemotes(cwd: string): Promise<ContributionRemoteChoice[]> {
	const choices: ContributionRemoteChoice[] = [];
	for (const name of await git.remote.list(cwd)) {
		const [url, pushUrl] = await Promise.all([git.remote.url(cwd, name), git.remote.pushUrl(cwd, name)]);
		if (!url || !pushUrl) continue;
		try {
			const remote = validateContributionForkRemote(url);
			const pushRemote = validateContributionForkRemote(pushUrl);
			if (pushRemote.slug !== remote.slug) continue;
			choices.push({ name, url, pushUrl, remote, pushRemote });
		} catch (error) {
			if (!(error instanceof ContributionError)) throw error;
		}
	}
	return choices;
}

function contributionEndMustPause(messages: AgentMessage[]): boolean {
	let firstRelevantIndex = 0;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		if (messages[index]?.role === "user") {
			firstRelevantIndex = index + 1;
			break;
		}
	}
	for (let index = firstRelevantIndex; index < messages.length; index += 1) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		if (message.stopReason === "aborted" || message.stopReason === "error") return true;
		const text = message.content
			.filter(part => part.type === "text")
			.map(part => part.text)
			.join("\n");
		if (text.includes(CONTRIBUTION_PAUSE_MARKER)) return true;
	}
	return false;
}

function renderContributionPrompt(baseSystemPrompt: string, state: ContributionRunningState): string {
	return prompt.render(contributionPromptTemplate, {
		base_system_prompt: baseSystemPrompt,
		base_sha: state.baseProof.baseSha,
		initial_goal_commit_sha: state.baseProof.initialGoalCommitSha,
		goal_commit_sha: state.goal.commitSha,
		goal_blob_sha: state.goal.blobSha,
		goal_sha256: state.goal.sha256,
		goal_title: state.goal.title,
		goal_content: state.goal.content,
		branch: state.branch,
		model_provider: state.model.provider,
		model_id: state.model.id,
		remote_name: state.remoteName,
		remote_url: state.remoteUrl,
	});
}

function renderContributionGoalRefresh(goal: ContributionGoal, segment: number): string {
	return prompt.render(contributionGoalRefreshTemplate, {
		segment: segment + 1,
		goal_commit_sha: goal.commitSha,
		goal_blob_sha: goal.blobSha,
		goal_sha256: goal.sha256,
		goal_title: goal.title,
		goal_content: goal.content,
	});
}

function describeContributionError(error: unknown): string {
	if (error instanceof ContributionError) return `${error.code}: ${error.message}`;
	return error instanceof Error ? error.message : String(error);
}

export const createAutoresearchExtension: ExtensionFactory = api => {
	const runtimeStore = createRuntimeStore();
	const dashboard = createDashboardController();
	const contributionStartTransactions = new Map<string, ContributionStartTransaction>();
	const contributionPublicationOperations = new Map<string, ContributionPublicationOperation>();
	const contributionStopOperations = new Map<string, Promise<string[]>>();
	const autoresearchMutationOperations = new Map<string, Set<AutoresearchMutationOperation>>();
	const autoresearchCommandOperations = new Map<
		string,
		{ token: symbol; settlement: Promise<void>; settle: () => void }
	>();
	const mutationAdmissionHolds = new Map<string, number>();
	const transitionAdmissionHolds = new Map<string, TransitionAdmissionHold>();
	const rehydrateOperations = new Map<string, Promise<void>>();
	const lifecycleEpochs = new Map<string, number>();

	const acquireMutationAdmissionHold = (sessionKey: string): (() => void) => {
		mutationAdmissionHolds.set(sessionKey, (mutationAdmissionHolds.get(sessionKey) ?? 0) + 1);
		let released = false;
		return (): void => {
			if (released) return;
			released = true;
			const remaining = (mutationAdmissionHolds.get(sessionKey) ?? 1) - 1;
			if (remaining > 0) mutationAdmissionHolds.set(sessionKey, remaining);
			else mutationAdmissionHolds.delete(sessionKey);
		};
	};

	const mutationAdmissionClosed = (sessionKey: string): boolean => (mutationAdmissionHolds.get(sessionKey) ?? 0) > 0;

	const invalidateContributionOperations = (sessionKey: string): Promise<void> | undefined => {
		const settlements: Promise<void>[] = [];
		const startTransaction = contributionStartTransactions.get(sessionKey);
		if (startTransaction) {
			startTransaction.token = null;
			if (startTransaction.phase === "activating") settlements.push(startTransaction.settlement.promise);
		}
		const publication = contributionPublicationOperations.get(sessionKey);
		if (publication) {
			if (publication.phase === "pre-push") {
				publication.controller.abort(new ToolAbortError("Contribution publication authorization changed."));
			}
			settlements.push(publication.settlement.promise);
		}
		return settlements.length > 0 ? Promise.allSettled(settlements).then(() => undefined) : undefined;
	};

	const drainAutoresearchMutationOperations = async (sessionKey: string): Promise<void> => {
		while (true) {
			const operations = [...(autoresearchMutationOperations.get(sessionKey) ?? [])];
			if (operations.length === 0) return;
			for (const operation of operations) {
				operation.controller.abort(new ToolAbortError("Autoresearch mutation authorization changed."));
			}
			await Promise.allSettled(operations.map(operation => operation.settlement.promise));
		}
	};

	const getSessionKey = (ctx: ExtensionContext): string => ctx.sessionManager.getSessionId();
	const getRuntime = (ctx: ExtensionContext): AutoresearchRuntime => runtimeStore.ensure(getSessionKey(ctx));
	const advanceLifecycleEpoch = (sessionKey: string): void => {
		lifecycleEpochs.set(sessionKey, (lifecycleEpochs.get(sessionKey) ?? 0) + 1);
	};
	const captureLifecycleIdentity = (ctx: ExtensionContext): AsyncLifecycleIdentity => {
		const sessionKey = getSessionKey(ctx);
		const runtime = getRuntime(ctx);
		return {
			sessionKey,
			epoch: lifecycleEpochs.get(sessionKey) ?? 0,
			runtime,
			contribution: runtime.contribution,
			state: runtime.state,
			autoresearchMode: runtime.autoresearchMode,
			ordinarySessionOwner: runtime.ordinarySessionOwner,
			ordinaryOwnerlessBranch: runtime.ordinaryOwnerlessBranch,
		};
	};
	const lifecycleIdentityIsCurrent = (ctx: ExtensionContext, identity: AsyncLifecycleIdentity): boolean =>
		getSessionKey(ctx) === identity.sessionKey &&
		getRuntime(ctx) === identity.runtime &&
		(lifecycleEpochs.get(identity.sessionKey) ?? 0) === identity.epoch &&
		identity.runtime.contribution === identity.contribution &&
		identity.runtime.state === identity.state &&
		identity.runtime.ordinarySessionOwner === identity.ordinarySessionOwner &&
		identity.runtime.ordinaryOwnerlessBranch === identity.ordinaryOwnerlessBranch &&
		identity.runtime.autoresearchMode === identity.autoresearchMode &&
		!mutationAdmissionClosed(identity.sessionKey);
	const showPersistedPublicationStatus = async (ctx: ExtensionContext): Promise<boolean> => {
		const publication = reconstructPublicationEntry(ctx.sessionManager.getBranch());
		if (!publication) return false;
		if (publication.phase === "success") {
			ctx.ui.notify(renderPublicationHandoff("Contribution publication recorded:", publication), "info");
			return true;
		}
		try {
			const remote = validateContributionForkRemote(publication.remoteUrl);
			const endpoint = `/repos/${remote.slug}/git/ref/heads/${encodeURIComponent(publication.branchName)}`;
			const response = await git.github.json<unknown>(
				ctx.cwd,
				[
					"api",
					endpoint,
					"--hostname",
					"github.com",
					"--method",
					"GET",
					"--jq",
					"{sha: .object.sha, type: .object.type}",
				],
				undefined,
				{ repoProvided: true },
			);
			if (!isRecord(response) || response.type !== "commit" || typeof response.sha !== "string") {
				throw new Error("GitHub returned malformed candidate ref data.");
			}
			const publishedSha = response.sha.toLowerCase();
			if (publishedSha !== publication.candidateHead) {
				ctx.ui.notify(
					renderPublicationHandoff(
						`Contribution publication outcome differs from the approved candidate (remote ${publishedSha}).`,
						publication,
					),
					"warning",
				);
				return true;
			}
			ctx.ui.notify(renderPublicationHandoff("Contribution publication recovered:", publication), "info");
		} catch (error) {
			ctx.ui.notify(
				renderPublicationHandoff(
					`Contribution publication outcome is unknown: ${describeContributionError(error)}`,
					publication,
				),
				"warning",
			);
		}
		return true;
	};
	const assertContributionStartIdentity = (
		ctx: ExtensionContext,
		runtime: AutoresearchRuntime,
		sessionKey: string,
		transaction: ContributionStartTransaction,
	): void => {
		if (
			getSessionKey(ctx) !== sessionKey ||
			getRuntime(ctx) !== runtime ||
			contributionStartTransactions.get(sessionKey) !== transaction ||
			transaction.token === null
		) {
			throw new Error("Contribution start authorization changed.");
		}
	};
	const assertContributionStartFresh = (
		ctx: ExtensionContext,
		runtime: AutoresearchRuntime,
		sessionKey: string,
		transaction: ContributionStartTransaction,
		contribution: AutoresearchRuntime["contribution"],
		state: AutoresearchRuntime["state"],
	): void => {
		assertContributionStartIdentity(ctx, runtime, sessionKey, transaction);
		if (
			runtime.contribution !== contribution ||
			runtime.state !== state ||
			runtime.autoresearchMode ||
			runtime.autoResumeArmed
		) {
			throw new Error("Contribution start state changed.");
		}
	};

	const sessionOwnerForRuntime = (runtime: AutoresearchRuntime): AutoresearchSessionOwner | null => {
		if (runtime.contribution.status === "running" && runtime.contribution.sessionId !== null) {
			return { sessionId: runtime.contribution.sessionId, branch: runtime.contribution.branch };
		}
		return runtime.contribution.status === "off" ? runtime.ordinarySessionOwner : null;
	};

	const loadActiveSession = async (
		ctx: ExtensionContext,
		owner: AutoresearchSessionOwner | null,
		ownerlessBranch: string | null | undefined,
	): Promise<{ session: SessionRow | null; currentBranch: string | null; onActiveBranch: boolean }> => {
		const currentBranch = await tryReadBranch(ctx.cwd);
		const storage = await openAutoresearchStorageIfExists(ctx.cwd);
		const confirmedBranch = await tryReadBranch(ctx.cwd);
		if (confirmedBranch !== currentBranch) {
			return { session: null, currentBranch: confirmedBranch, onActiveBranch: false };
		}
		if (!storage) {
			const onActiveBranch = owner === null && (ownerlessBranch === undefined || ownerlessBranch === currentBranch);
			return { session: null, currentBranch, onActiveBranch };
		}
		if (owner) {
			const ownedSession = storage.getSessionById(owner.sessionId);
			const activeOwnedSession =
				ownedSession?.closedAt === null && ownedSession.branch === owner.branch ? ownedSession : null;
			const onActiveBranch = activeOwnedSession !== null && activeOwnedSession.branch === currentBranch;
			return {
				session: onActiveBranch ? activeOwnedSession : null,
				currentBranch,
				onActiveBranch,
			};
		}
		if (ownerlessBranch !== undefined) {
			const onActiveBranch = ownerlessBranch === currentBranch;
			return {
				session: onActiveBranch ? storage.getActiveSessionForBranch(currentBranch) : null,
				currentBranch,
				onActiveBranch,
			};
		}
		const session = storage.getActiveSessionForBranch(currentBranch);
		return {
			session,
			currentBranch,
			onActiveBranch: session !== null || storage.getActiveSession() === null,
		};
	};

	const rehydrate = (ctx: ExtensionContext): Promise<void> => {
		const sessionKey = getSessionKey(ctx);
		const previous = rehydrateOperations.get(sessionKey) ?? Promise.resolve();
		const releaseAdmission = acquireMutationAdmissionHold(sessionKey);
		let operation: Promise<void>;
		operation = (async (): Promise<void> => {
			await previous.catch(() => undefined);
			await drainAutoresearchMutationOperations(sessionKey);
			const activationSettlement = invalidateContributionOperations(sessionKey);
			if (activationSettlement) await activationSettlement;

			const runtime = getRuntime(ctx);
			const control = reconstructControlState(ctx.sessionManager.getBranch());
			const contributionRunning = runtime.contribution.status === "running";
			if (!contributionRunning) runtime.goal = control.goal;
			runtime.autoResumeArmed = false;
			runtime.lastAutoResumePendingRunNumber = null;

			// Skip storage entirely if autoresearch was never activated in this conversation.
			// This is the common case: every project gets a session_start event but most
			// never touch autoresearch, so we must not create a SQLite file just to look.
			const everActivated = control.lastMode !== null || contributionRunning;
			const expectedOwner = sessionOwnerForRuntime(runtime);
			const { session, currentBranch, onActiveBranch } = everActivated
				? await loadActiveSession(ctx, expectedOwner, runtime.ordinaryOwnerlessBranch)
				: { session: null, currentBranch: null, onActiveBranch: true };

			// Mode is effective only when the exact retained session owner matches the
			// current branch. Legacy runtimes without an owner fall back to a session on
			// the current branch, never to the globally newest active session.
			const onContributionBranch =
				!contributionRunning ||
				runtime.contribution.status !== "running" ||
				runtime.contribution.branch === currentBranch;
			runtime.autoresearchMode = contributionRunning
				? onActiveBranch && onContributionBranch
				: control.autoresearchMode && onActiveBranch;

			if (session && onActiveBranch) {
				if (!contributionRunning) {
					runtime.ordinarySessionOwner = { sessionId: session.id, branch: session.branch };
					runtime.ordinaryOwnerlessBranch = undefined;
				}
				const storage = await openAutoresearchStorageIfExists(ctx.cwd);
				if (storage) {
					const loggedRuns = storage.listLoggedRuns(session.id);
					runtime.state = buildExperimentState(session, loggedRuns);
					runtime.goal = runtime.goal ?? session.goal;
					runtime.lastRunSummary = pendingRunSummaryFromRow(storage.getPendingRun(session.id));
				} else {
					runtime.state = createExperimentState();
					runtime.lastRunSummary = null;
				}
			} else {
				runtime.state = createExperimentState();
				runtime.lastRunSummary = null;
			}
			runtime.lastRunDuration = runtime.lastRunSummary?.durationSeconds ?? null;
			runtime.lastRunAsi = runtime.lastRunSummary?.parsedAsi ?? null;
			runtime.lastRunArtifactDir = runtime.lastRunSummary?.runDirectory ?? null;
			runtime.lastRunNumber = runtime.lastRunSummary?.runNumber ?? null;
			runtime.runningExperiment = null;
			dashboard.updateWidget(ctx, runtime);

			const activeTools = api.getActiveTools();
			const experimentTools = new Set(EXPERIMENT_TOOL_NAMES);
			const nextActiveTools = runtime.autoresearchMode
				? [...new Set([...activeTools, ...EXPERIMENT_TOOL_NAMES])]
				: activeTools.filter(name => !experimentTools.has(name));
			const toolsChanged =
				nextActiveTools.length !== activeTools.length ||
				nextActiveTools.some((name, index) => name !== activeTools[index]);
			if (toolsChanged) {
				await api.setActiveTools(nextActiveTools);
			}
		})().finally(() => {
			releaseAdmission();
			if (rehydrateOperations.get(sessionKey) === operation) rehydrateOperations.delete(sessionKey);
		});
		rehydrateOperations.set(sessionKey, operation);
		return operation;
	};

	const setMode = (
		ctx: ExtensionContext,
		enabled: boolean,
		goal: string | null,
		mode: "on" | "off" | "clear",
	): void => {
		const runtime = getRuntime(ctx);
		advanceLifecycleEpoch(getSessionKey(ctx));
		runtime.autoresearchMode = enabled;
		runtime.autoResumeArmed = false;
		runtime.goal = goal;
		runtime.lastAutoResumePendingRunNumber = null;
		api.appendEntry("autoresearch-control", goal ? { mode, goal } : { mode });
	};

	const closeContributionSession = async (
		ctx: ExtensionContext,
		contribution: Pick<ContributionRunningState, "branch" | "sessionId">,
	): Promise<void> => {
		if (contribution.sessionId === null) return;
		const storage = await openAutoresearchStorageIfExists(ctx.cwd);
		if (!storage) return;
		const session = storage.getActiveSessionForBranch(contribution.branch);
		if (session?.id === contribution.sessionId) {
			storage.closeSession(session.id);
		}
	};

	const stopContributionRuntime = (ctx: ExtensionContext, runtime: AutoresearchRuntime): Promise<string[]> => {
		const sessionKey = getSessionKey(ctx);
		const existing = contributionStopOperations.get(sessionKey);
		if (existing) return existing;
		advanceLifecycleEpoch(sessionKey);
		const releaseAdmission = acquireMutationAdmissionHold(sessionKey);
		const initialContribution = runtime.contribution;
		let operation: Promise<string[]>;
		operation = (async (): Promise<string[]> => {
			const mutationSettlement = drainAutoresearchMutationOperations(sessionKey);
			const contributionSettlement = invalidateContributionOperations(sessionKey);
			await Promise.allSettled(
				contributionSettlement ? [mutationSettlement, contributionSettlement] : [mutationSettlement],
			);
			if (getSessionKey(ctx) !== sessionKey || getRuntime(ctx) !== runtime) return [];
			if (
				initialContribution.status === "running" &&
				runtime.contribution.status === "review" &&
				runtime.contribution.authorization === initialContribution.authorization
			) {
				return [];
			}
			if (runtime.contribution.status === "off") return [];
			const contribution = runtime.contribution;
			const warnings: string[] = [];
			runtime.contribution = { status: "off" };
			runtime.autoresearchMode = false;
			runtime.autoResumeArmed = false;
			runtime.state = createExperimentState();
			runtime.goal = null;
			try {
				await closeContributionSession(ctx, contribution);
			} catch (error) {
				warnings.push(`session close: ${describeContributionError(error)}`);
			}
			try {
				const experimentTools = new Set(EXPERIMENT_TOOL_NAMES);
				await api.setActiveTools(api.getActiveTools().filter(name => !experimentTools.has(name)));
			} catch (error) {
				warnings.push(`tool deactivation: ${describeContributionError(error)}`);
			}
			return warnings;
		})().finally(() => {
			releaseAdmission();
			if (contributionStopOperations.get(sessionKey) === operation) {
				contributionStopOperations.delete(sessionKey);
			}
		});
		contributionStopOperations.set(sessionKey, operation);
		return operation;
	};

	const beginSessionTransition = (
		event: { readonly transitionId: string },
		ctx: ExtensionContext,
	): { cancel: true } | undefined => {
		const sessionKey = getSessionKey(ctx);
		if (transitionAdmissionHolds.has(event.transitionId)) return { cancel: true };
		advanceLifecycleEpoch(sessionKey);
		const runtime = getRuntime(ctx);
		const mutationActive = (autoresearchMutationOperations.get(sessionKey)?.size ?? 0) > 0;
		const contributionWorkActive =
			contributionStartTransactions.has(sessionKey) ||
			contributionPublicationOperations.has(sessionKey) ||
			contributionStopOperations.has(sessionKey) ||
			mutationActive ||
			runtime.contribution.status !== "off";
		const busy = mutationAdmissionClosed(sessionKey) || contributionWorkActive;
		const hold: TransitionAdmissionHold = {
			sessionKey,
			release: acquireMutationAdmissionHold(sessionKey),
			endReceived: false,
			settled: !contributionWorkActive,
		};
		transitionAdmissionHolds.set(event.transitionId, hold);
		if (contributionWorkActive) {
			void stopContributionRuntime(ctx, runtime)
				.then(() => {
					if (getSessionKey(ctx) !== sessionKey || getRuntime(ctx) !== runtime) return;
					dashboard.updateWidget(ctx, runtime);
					dashboard.requestRender();
				})
				.catch(error => {
					logger.warn("Failed to settle contribution lifecycle transition", {
						error: describeContributionError(error),
						sessionKey,
					});
				})
				.finally(() => {
					hold.settled = true;
					if (!hold.endReceived || transitionAdmissionHolds.get(event.transitionId) !== hold) return;
					transitionAdmissionHolds.delete(event.transitionId);
					hold.release();
				});
		}
		return busy ? { cancel: true } : undefined;
	};

	const finishSessionTransition = (transitionId: string): void => {
		const hold = transitionAdmissionHolds.get(transitionId);
		if (!hold) return;
		hold.endReceived = true;
		if (!hold.settled) return;
		transitionAdmissionHolds.delete(transitionId);
		hold.release();
	};

	const deactivateOrdinaryAfterMove = async (ctx: ExtensionContext): Promise<void> => {
		const runtime = getRuntime(ctx);
		if (runtime.contribution.status !== "off" || !runtime.autoresearchMode) return;
		runtime.ordinaryOwnerlessBranch = undefined;
		setMode(ctx, false, runtime.goal, "off");
		dashboard.updateWidget(ctx, runtime);
		const experimentTools = new Set(EXPERIMENT_TOOL_NAMES);
		await api.setActiveTools(api.getActiveTools().filter(name => !experimentTools.has(name)));
	};
	const captureMutationAuthorization = (ctx: ExtensionContext): AutoresearchMutationAuthorization => {
		const sessionKey = getSessionKey(ctx);
		if (mutationAdmissionClosed(sessionKey)) {
			throw new ToolAbortError("Autoresearch mutations are paused for a lifecycle transition.");
		}
		if (contributionStartTransactions.has(sessionKey)) {
			throw new Error("Contribution startup is already active for this session.");
		}
		const capturedRuntime = getRuntime(ctx);
		const captured = capturedRuntime.contribution;
		const capturedOrdinarySessionOwner = capturedRuntime.ordinarySessionOwner;
		const capturedOrdinaryOwnerlessBranch = capturedRuntime.ordinaryOwnerlessBranch;
		const capturedSessionOwner = sessionOwnerForRuntime(capturedRuntime);
		let capturedOwnerlessOrdinaryBranch = capturedOrdinaryOwnerlessBranch;
		if (captured.status === "review") {
			throw new Error("Contribution review state does not authorize autoresearch mutation.");
		}
		if (captured.status === "off" && !capturedRuntime.autoresearchMode) {
			throw new ToolAbortError("Autoresearch mode is not active on the current branch.");
		}
		const operation: AutoresearchMutationOperation = {
			controller: new AbortController(),
			settlement: Promise.withResolvers<void>(),
		};
		let operations = autoresearchMutationOperations.get(sessionKey);
		if (!operations) {
			operations = new Set();
			autoresearchMutationOperations.set(sessionKey, operations);
		}
		operations.add(operation);
		let settled = false;
		const assertProcessIdentity = (currentCtx: ExtensionContext): void => {
			const currentRuntime = getRuntime(currentCtx);
			const current = currentRuntime.contribution;
			if (getSessionKey(currentCtx) !== sessionKey || currentRuntime !== capturedRuntime) {
				throw new Error("Autoresearch mutation authorization changed before mutation.");
			}
			if (captured.status === "off") {
				if (current.status !== "off") {
					throw new Error("Contribution startup overtook autoresearch mutation before mutation.");
				}
				if (
					currentRuntime.ordinarySessionOwner !== capturedOrdinarySessionOwner ||
					currentRuntime.ordinaryOwnerlessBranch !== capturedOrdinaryOwnerlessBranch
				) {
					throw new Error("Autoresearch session ownership changed before mutation.");
				}
				return;
			}
			if (
				current.status !== "running" ||
				current.authorization !== captured.authorization ||
				current.branch !== captured.branch ||
				current.sessionId !== captured.sessionId
			) {
				throw new Error("Contribution mutation authorization changed before mutation.");
			}
		};
		return {
			signal: operation.controller.signal,
			async authorizeMutation(currentCtx, signal): Promise<void> {
				throwIfAborted(signal);
				assertProcessIdentity(currentCtx);
				if (captured.status === "off" && capturedSessionOwner === null) {
					const currentBranch = (await git.branch.current(currentCtx.cwd, signal)) ?? null;
					if (capturedOwnerlessOrdinaryBranch === undefined) {
						capturedOwnerlessOrdinaryBranch = currentBranch;
					} else if (currentBranch !== capturedOwnerlessOrdinaryBranch) {
						throw new ToolAbortError("Autoresearch ownerless initialization changed branches before mutation.");
					}
				}
				if (capturedSessionOwner) {
					const storage = await openAutoresearchStorageIfExists(currentCtx.cwd);
					const currentBranch = await git.branch.current(currentCtx.cwd, signal);
					const session = storage?.getActiveSessionForBranch(capturedSessionOwner.branch) ?? null;
					if (currentBranch !== capturedSessionOwner.branch || session?.id !== capturedSessionOwner.sessionId) {
						if (captured.status === "running") {
							throw new Error("Contribution branch or experiment session changed before mutation.");
						}
						throw new ToolAbortError("Autoresearch session branch or ownership changed before mutation.");
					}
				} else if (captured.status === "running") {
					const storage = await openAutoresearchStorageIfExists(currentCtx.cwd);
					const currentBranch = await git.branch.current(currentCtx.cwd, signal);
					const session = storage?.getActiveSessionForBranch(captured.branch) ?? null;
					if (currentBranch !== captured.branch || session !== null) {
						throw new Error("Contribution branch or experiment session changed before mutation.");
					}
				}
				assertProcessIdentity(currentCtx);
				throwIfAborted(signal);
			},
			assertRuntimeCurrent(currentCtx, signal): void {
				throwIfAborted(signal);
				assertProcessIdentity(currentCtx);
			},
			settle(): void {
				if (settled) return;
				settled = true;
				const currentOperations = autoresearchMutationOperations.get(sessionKey);
				currentOperations?.delete(operation);
				if (currentOperations?.size === 0) autoresearchMutationOperations.delete(sessionKey);
				operation.settlement.resolve();
			},
		};
	};

	api.registerTool(
		createInitExperimentTool({
			dashboard,
			getRuntime,
			pi: api,
			captureMutationAuthorization,
			forceUncapped: ctx => getRuntime(ctx).contribution.status === "running",
			onSessionUpdated(ctx, state): void {
				const runtime = getRuntime(ctx);
				if (runtime.contribution.status === "running") {
					if (state.branch !== runtime.contribution.branch) return;
					runtime.contribution = {
						...runtime.contribution,
						sessionId: state.sessionId,
						currentSegment: state.currentSegment,
					};
					return;
				}
				if (state.sessionId !== null) {
					runtime.ordinarySessionOwner = { sessionId: state.sessionId, branch: state.branch };
					runtime.ordinaryOwnerlessBranch = undefined;
				}
			},
			async prepareNewSegment(ctx, signal) {
				const runtime = getRuntime(ctx);
				if (runtime.contribution.status !== "running" || runtime.contribution.sessionId === null) return null;
				const expectedBranch = runtime.contribution.branch;
				const expectedSessionId = runtime.contribution.sessionId;
				const storage = await openAutoresearchStorageIfExists(ctx.cwd);
				const session = storage?.getActiveSessionForBranch(expectedBranch) ?? null;
				if (storage === null || !session || session.id !== expectedSessionId) {
					throw new Error("Contribution session changed before the next segment could be prepared.");
				}
				if (storage.getPendingRun(expectedSessionId)) {
					throw new Error(
						"Contribution segment boundary requires the pending experiment to be logged before starting a new segment.",
					);
				}
				let goal: ContributionGoal;
				try {
					goal = await fetchOfficialContributionGoal(ctx.cwd, { signal });
				} catch (error) {
					if (signal?.aborted) throw error;
					throw new Error(
						`Official contribution goal refresh failed before segment mutation: ${describeContributionError(error)}`,
						{ cause: error },
					);
				}
				return {
					goal: goal.content,
					complete(state): string | null {
						const current = getRuntime(ctx);
						if (
							current.contribution.status !== "running" ||
							current.contribution.branch !== expectedBranch ||
							current.contribution.sessionId !== expectedSessionId ||
							state.branch !== expectedBranch ||
							state.sessionId !== expectedSessionId
						) {
							return null;
						}
						current.goal = goal.content;
						current.contribution = {
							...current.contribution,
							goal,
							currentSegment: state.currentSegment,
						};
						ctx.ui.notify(
							`Contribution goal refreshed for segment ${state.currentSegment + 1}: ${goal.title} (${goal.commitSha.slice(0, 12)})`,
							"info",
						);
						return renderContributionGoalRefresh(goal, state.currentSegment);
					},
				};
			},
		}),
	);

	api.registerTool(createRunExperimentTool({ captureMutationAuthorization, dashboard, getRuntime, pi: api }));
	api.registerTool(createLogExperimentTool({ captureMutationAuthorization, dashboard, getRuntime, pi: api }));
	api.registerTool(createUpdateNotesTool({ captureMutationAuthorization, dashboard, getRuntime, pi: api }));

	api.registerCommand("autoresearch", {
		description: "Toggle builtin autoresearch mode, or pass off / clear, or a goal message.",
		getArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
			if (argumentPrefix.includes(" ")) return null;
			const normalized = argumentPrefix.trim().toLowerCase();
			if (normalized.length === 0) return null;
			const completions: AutocompleteItem[] = [
				{ label: "off", value: "off", description: "Leave autoresearch mode" },
				{
					label: "clear",
					value: "clear",
					description: "Reset worktree to baseline and close the active session",
				},
			];
			const filtered = completions.filter(item => item.label.startsWith(normalized));
			return filtered.length > 0 ? filtered : null;
		},
		async handler(args, ctx): Promise<void> {
			const trimmed = args.trim();
			const runtime = getRuntime(ctx);
			const sessionKey = getSessionKey(ctx);
			const contributionLifecycleActive =
				runtime.contribution.status !== "off" ||
				contributionStartTransactions.has(sessionKey) ||
				contributionPublicationOperations.has(sessionKey) ||
				contributionStopOperations.has(sessionKey) ||
				autoresearchCommandOperations.has(sessionKey) ||
				mutationAdmissionClosed(sessionKey);
			if (contributionLifecycleActive) {
				ctx.ui.notify("Stop contribution mode with `/contribute off` before using `/autoresearch`.", "error");
				return;
			}

			const operationToken = Symbol("autoresearch-command-operation");
			const operationSettlement = Promise.withResolvers<void>();
			const operation = {
				token: operationToken,
				settlement: operationSettlement.promise,
				settle: () => operationSettlement.resolve(),
			};
			const initialContribution = runtime.contribution;
			autoresearchCommandOperations.set(sessionKey, operation);
			const releaseAdmission = acquireMutationAdmissionHold(sessionKey);
			const operationIsCurrent = (): boolean =>
				getSessionKey(ctx) === sessionKey &&
				getRuntime(ctx) === runtime &&
				runtime.contribution === initialContribution &&
				autoresearchCommandOperations.get(sessionKey)?.token === operationToken;
			try {
				if (trimmed === "" && runtime.autoresearchMode) {
					await drainAutoresearchMutationOperations(sessionKey);
					if (!operationIsCurrent()) return;
					runtime.ordinaryOwnerlessBranch = undefined;
					setMode(ctx, false, runtime.goal, "off");
					dashboard.updateWidget(ctx, runtime);
					const experimentTools = new Set(EXPERIMENT_TOOL_NAMES);
					if (!operationIsCurrent()) return;
					await api.setActiveTools(api.getActiveTools().filter(name => !experimentTools.has(name)));
					if (!operationIsCurrent()) return;
					ctx.ui.notify("Autoresearch mode disabled", "info");
					return;
				}

				if (trimmed === "off") {
					await drainAutoresearchMutationOperations(sessionKey);
					if (!operationIsCurrent()) return;
					runtime.ordinaryOwnerlessBranch = undefined;
					setMode(ctx, false, runtime.goal, "off");
					dashboard.updateWidget(ctx, runtime);
					const experimentTools = new Set(EXPERIMENT_TOOL_NAMES);
					if (!operationIsCurrent()) return;
					await api.setActiveTools(api.getActiveTools().filter(name => !experimentTools.has(name)));
					if (!operationIsCurrent()) return;
					ctx.ui.notify("Autoresearch mode disabled", "info");
					return;
				}

				if (trimmed === "clear" || trimmed.startsWith("clear ")) {
					await drainAutoresearchMutationOperations(sessionKey);
					if (!operationIsCurrent()) return;
					const flagPart = trimmed === "clear" ? "" : trimmed.slice("clear ".length).trim();
					const keepTree = flagPart.includes("--keep-tree");
					const resetTreeForce = flagPart.includes("--reset-tree");
					await handleClear(ctx, runtime, { keepTree, resetTreeForce });
					return;
				}

				await drainAutoresearchMutationOperations(sessionKey);
				if (!operationIsCurrent()) return;
				const goalArg = trimmed.length > 0 ? trimmed : null;
				const branchResult = await ensureAutoresearchBranch(api, ctx.cwd, goalArg ?? runtime.goal);
				if (!operationIsCurrent()) return;
				if (!branchResult.ok) {
					ctx.ui.notify(branchResult.error, "error");
					return;
				}
				if (branchResult.warning) {
					ctx.ui.notify(branchResult.warning, "warning");
				}

				// Look up an existing session for the branch we just landed on. A session
				// recorded under a different autoresearch/* branch is intentionally ignored
				// — `/autoresearch` on a fresh branch starts a fresh session. Only open the
				// DB if it already exists; the empty-state path must not create one.
				const existingStorage = await openAutoresearchStorageIfExists(ctx.cwd);
				const confirmedBranch = await tryReadBranch(ctx.cwd);
				if (!operationIsCurrent()) return;
				if (confirmedBranch !== branchResult.branchName) {
					ctx.ui.notify("Autoresearch branch changed while session state was loading.", "error");
					return;
				}
				const existingSession = existingStorage?.getActiveSessionForBranch(branchResult.branchName) ?? null;
				const resumeContext = trimmed;
				const branchStatusLine = branchResult.branchName
					? branchResult.created
						? `Created and checked out dedicated git branch \`${branchResult.branchName}\` before resuming.`
						: `Using dedicated git branch \`${branchResult.branchName}\`.`
					: "Continuing on the current branch — no autoresearch branch was created.";

				if (existingSession && existingStorage) {
					if (!operationIsCurrent()) return;
					if (goalArg) existingStorage.updateSession(existingSession.id, { goal: goalArg });
					if (branchResult.branchName) {
						existingStorage.updateSession(existingSession.id, { branch: branchResult.branchName });
					}
					const refreshed = existingStorage.getSessionById(existingSession.id) ?? existingSession;
					runtime.state = buildExperimentState(refreshed, existingStorage.listLoggedRuns(refreshed.id));
					runtime.ordinarySessionOwner = { sessionId: refreshed.id, branch: refreshed.branch };
					runtime.ordinaryOwnerlessBranch = undefined;
					runtime.goal = refreshed.goal ?? goalArg;
					setMode(ctx, true, runtime.goal, "on");
					dashboard.updateWidget(ctx, runtime);
					if (!operationIsCurrent()) return;
					await api.setActiveTools([...new Set([...api.getActiveTools(), ...EXPERIMENT_TOOL_NAMES])]);
					if (!operationIsCurrent()) return;
					api.sendUserMessage(
						prompt.render(commandResumeTemplate, {
							branch_status_line: branchStatusLine,
							has_resume_context: resumeContext.length > 0,
							resume_context: resumeContext,
						}),
					);
					return;
				}

				if (!operationIsCurrent()) return;
				runtime.ordinarySessionOwner = null;
				runtime.ordinaryOwnerlessBranch = branchResult.branchName;
				setMode(ctx, true, goalArg, "on");
				dashboard.updateWidget(ctx, runtime);
				if (!operationIsCurrent()) return;
				await api.setActiveTools([...new Set([...api.getActiveTools(), ...EXPERIMENT_TOOL_NAMES])]);
				if (!operationIsCurrent()) return;
				if (goalArg !== null) {
					api.sendUserMessage(goalArg);
				} else {
					ctx.ui.notify("Autoresearch enabled—describe what to optimize in your next message.", "info");
				}
			} finally {
				if (autoresearchCommandOperations.get(sessionKey)?.token === operationToken) {
					autoresearchCommandOperations.delete(sessionKey);
				}
				releaseAdmission();
				operation.settle();
			}
		},
	});

	api.registerCommand("contribute", {
		description: "Run a fresh official upstream contribution session, inspect status, stop, or publish for review.",
		getArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
			if (argumentPrefix.includes(" ")) return null;
			const normalized = argumentPrefix.trim().toLowerCase();
			const completions: AutocompleteItem[] = [
				{ label: "status", value: "status", description: "Show process-local contribution status" },
				{ label: "off", value: "off", description: "Stop contribution mode" },
				{ label: "review", value: "review", description: "Validate and push a kept candidate for human review" },
			];
			const filtered = completions.filter(item => item.label.startsWith(normalized));
			return filtered.length > 0 ? filtered : null;
		},
		async handler(args, ctx): Promise<void> {
			const command = args.trim().toLowerCase();
			const runtime = getRuntime(ctx);

			if (command === "status") {
				if (runtime.contribution.status === "off") {
					if (await showPersistedPublicationStatus(ctx)) return;
					ctx.ui.notify("Contribution mode is off.", "info");
				} else if (runtime.contribution.status === "running") {
					ctx.ui.notify(
						`Contribution running on ${runtime.contribution.branch}\nGoal: ${runtime.contribution.goal.title}\nInitial base: ${runtime.contribution.baseProof.baseSha}\nInitial goal commit: ${runtime.contribution.baseProof.initialGoalCommitSha}\nCurrent goal commit: ${runtime.contribution.goal.commitSha}\nCurrent goal SHA-256: ${runtime.contribution.goal.sha256}\nModel: ${runtime.contribution.model.provider}/${runtime.contribution.model.id}\nConfirmed fork: ${runtime.contribution.remoteName} (${runtime.contribution.remoteUrl})`,
						"info",
					);
				} else {
					ctx.ui.notify(
						`Contribution review ready:\nImmutable SHA review: ${runtime.contribution.publication.reviewUrl}\nMutable branch compare: ${runtime.contribution.publication.compareUrl}\nCandidate: ${runtime.contribution.candidateHead}`,
						"info",
					);
				}
				return;
			}

			if (command === "off") {
				const sessionKey = getSessionKey(ctx);
				const wasOff = runtime.contribution.status === "off";
				if (
					wasOff &&
					!contributionStartTransactions.has(sessionKey) &&
					!contributionPublicationOperations.has(sessionKey) &&
					!contributionStopOperations.has(sessionKey)
				) {
					ctx.ui.notify("Contribution mode is already off.", "info");
					return;
				}
				const warnings = await stopContributionRuntime(ctx, runtime);
				dashboard.updateWidget(ctx, runtime);
				if (runtime.contribution.status === "review") {
					ctx.ui.notify(
						`Contribution candidate was pushed; review handoff preserved.\nImmutable SHA review: ${runtime.contribution.publication.reviewUrl}\nMutable branch compare: ${runtime.contribution.publication.compareUrl}`,
						"info",
					);
				} else if (wasOff) {
					ctx.ui.notify("Contribution mode is already off.", "info");
				} else if (warnings.length > 0) {
					ctx.ui.notify(`Contribution mode stopped with cleanup warnings: ${warnings.join("; ")}`, "warning");
				} else {
					ctx.ui.notify("Contribution mode stopped.", "info");
				}
				return;
			}

			if (command === "review") {
				if (runtime.contribution.status !== "running") {
					ctx.ui.notify("Contribution review requires a running contribution session.", "error");
					return;
				}
				const reviewSessionKey = getSessionKey(ctx);
				if (contributionPublicationOperations.has(reviewSessionKey)) {
					ctx.ui.notify("A contribution review or publication is already active for this session.", "error");
					return;
				}
				const contribution = runtime.contribution;
				const reviewAuthorization = contribution.authorization;
				const reviewBranch = contribution.branch;
				const reviewSessionId = contribution.sessionId;
				const publicationOperation: ContributionPublicationOperation = {
					controller: new AbortController(),
					phase: "pre-push",
					settlement: Promise.withResolvers<void>(),
				};
				contributionPublicationOperations.set(reviewSessionKey, publicationOperation);
				advanceLifecycleEpoch(reviewSessionKey);
				let publicationSettled = false;
				const settlePublicationOperation = (): void => {
					if (publicationSettled) return;
					publicationSettled = true;
					if (contributionPublicationOperations.get(reviewSessionKey) === publicationOperation) {
						contributionPublicationOperations.delete(reviewSessionKey);
					}
					publicationOperation.settlement.resolve();
				};
				const assertContributionIdentity = (): void => {
					const currentRuntime = getRuntime(ctx);
					const current = currentRuntime.contribution;
					if (
						getSessionKey(ctx) !== reviewSessionKey ||
						currentRuntime !== runtime ||
						current.status !== "running" ||
						current.authorization !== reviewAuthorization ||
						current.branch !== reviewBranch ||
						current.sessionId !== reviewSessionId
					) {
						throw new Error("Contribution publication authorization changed.");
					}
				};
				const authorizePublication = (): void => {
					throwIfAborted(publicationOperation.controller.signal);
					if (contributionPublicationOperations.get(reviewSessionKey) !== publicationOperation) {
						throw new Error("Contribution publication authorization changed.");
					}
					assertContributionIdentity();
				};
				const releaseReviewAdmission = acquireMutationAdmissionHold(reviewSessionKey);
				try {
					await drainAutoresearchMutationOperations(reviewSessionKey);
					try {
						authorizePublication();
					} catch (error) {
						ctx.ui.notify(`Contribution review failed: ${describeContributionError(error)}`, "error");
						return;
					}
					if (runtime.contribution.status !== "running") {
						ctx.ui.notify("Contribution review authorization changed while active mutations settled.", "error");
						return;
					}
					let storage: AutoresearchStorage | null;
					try {
						storage = await openAutoresearchStorageIfExists(ctx.cwd);
						authorizePublication();
					} catch (error) {
						ctx.ui.notify(`Contribution review failed: ${describeContributionError(error)}`, "error");
						return;
					}
					if (!storage || contribution.sessionId === null) {
						ctx.ui.notify("Contribution review requires an initialized experiment session.", "error");
						return;
					}
					const session = storage.getSessionById(contribution.sessionId);
					if (!session || session.branch !== contribution.branch) {
						ctx.ui.notify(
							"The recorded contribution experiment no longer matches its dedicated branch.",
							"error",
						);
						return;
					}
					if (storage.getPendingRun(session.id)) {
						ctx.ui.notify("Contribution review requires every pending experiment to be logged first.", "error");
						return;
					}
					runtime.state = buildExperimentState(session, storage.listLoggedRuns(session.id));
					let currentBranch: string | null;
					let currentHead: string | null;
					let statusOutput: string;
					try {
						[currentBranch, currentHead, statusOutput] = await Promise.all([
							git.branch.current(ctx.cwd, publicationOperation.controller.signal),
							git.head.sha(ctx.cwd, publicationOperation.controller.signal),
							git.status(ctx.cwd, {
								porcelainV1: true,
								untrackedFiles: "all",
								z: true,
								signal: publicationOperation.controller.signal,
							}),
						]);
						authorizePublication();
					} catch (error) {
						ctx.ui.notify(`Contribution review failed: ${describeContributionError(error)}`, "error");
						return;
					}
					if (currentBranch !== contribution.branch) {
						ctx.ui.notify("Review requires the recorded dedicated contribution branch.", "error");
						return;
					}
					if (statusOutput.length > 0) {
						ctx.ui.notify("Review requires a completely clean contribution worktree.", "error");
						return;
					}
					if (!currentHead) {
						ctx.ui.notify("Unable to read the contribution candidate HEAD.", "error");
						return;
					}
					currentHead = currentHead.toLowerCase();
					if (!GIT_SHA_PATTERN.test(currentHead)) {
						ctx.ui.notify("The contribution candidate HEAD is not a canonical full commit SHA.", "error");
						return;
					}
					try {
						if (
							!(await git.isAncestor(
								ctx.cwd,
								contribution.baseProof.baseSha,
								currentHead,
								publicationOperation.controller.signal,
							))
						) {
							throw new ContributionError(
								"candidate_not_descendant",
								"The contribution candidate does not descend from the frozen official base.",
							);
						}
						authorizePublication();
					} catch (error) {
						ctx.ui.notify(`Contribution review failed: ${describeContributionError(error)}`, "error");
						return;
					}
					const candidateResult = keptResultAtHead(
						runtime.state.results,
						runtime.state.currentSegment,
						currentHead,
					);
					if (!candidateResult) {
						ctx.ui.notify(
							"Contribution review requires the current HEAD to be an unflagged kept result in the current segment.",
							"error",
						);
						return;
					}
					const candidateRun =
						candidateResult.runNumber === null ? null : storage.getRunById(candidateResult.runNumber);
					const candidateTree = candidateRun?.parsedAsi?.[CONTRIBUTION_WORKTREE_TREE_ASI_KEY];
					if (
						typeof candidateTree !== "string" ||
						!hasExecutableContributionTddProof(session, candidateRun, storage.listLoggedRuns(session.id))
					) {
						ctx.ui.notify(
							"Contribution review requires executable TDD proof: an earlier unflagged failing or timed-out run and the kept passing candidate must use the same fixed harness and invocation identity in the current segment.",
							"error",
						);
						return;
					}
					const scenario =
						typeof candidateResult.asi?.hypothesis === "string"
							? candidateResult.asi.hypothesis.trim().replace(/\s+/g, " ").slice(0, 500)
							: "";
					const result = candidateResult.description.trim().replace(/\s+/g, " ").slice(0, 500);
					const candidate: ContributionCandidate = {
						status: "keep",
						flagged: candidateResult.flagged,
						segment: candidateResult.segment,
						runNumber: candidateResult.runNumber,
						commit: currentHead,
						treeSha: candidateTree,
						description: result,
						scenario,
						metric: candidateResult.metric,
						metricName: runtime.state.metricName.trim().replace(/\s+/g, " ").slice(0, 80) || "metric",
						metricUnit: runtime.state.metricUnit.trim().replace(/\s+/g, " ").slice(0, 20),
					};
					let reviewPushRemoteUrl: string;
					try {
						const [reviewRemoteUrl, pushRemoteUrl] = await Promise.all([
							git.remote.url(ctx.cwd, contribution.remoteName, publicationOperation.controller.signal),
							git.remote.pushUrl(ctx.cwd, contribution.remoteName, publicationOperation.controller.signal),
						]);
						if (reviewRemoteUrl !== contribution.remoteUrl || pushRemoteUrl === undefined) {
							throw new ContributionError(
								"remote_changed",
								"The confirmed fork destination changed before review.",
							);
						}
						const reviewRemote = validateContributionForkRemote(reviewRemoteUrl);
						const pushRemote = validateContributionForkRemote(pushRemoteUrl);
						if (pushRemote.slug !== reviewRemote.slug) {
							throw new ContributionError(
								"remote_changed",
								"The push-effective destination differs from the confirmed fork.",
							);
						}
						await verifyContributionFork(ctx.cwd, pushRemote, {
							signal: publicationOperation.controller.signal,
						});
						authorizePublication();
						reviewPushRemoteUrl = pushRemoteUrl;
					} catch (error) {
						ctx.ui.notify(`Contribution review failed: ${describeContributionError(error)}`, "error");
						return;
					}
					const remote = validateContributionForkRemote(contribution.remoteUrl);
					const approvedDraft = buildContributionPrDraft(
						contribution.goal,
						candidate,
						remote,
						contribution.branch,
						contribution.baseProof,
					);
					const approved = await ctx.ui.confirm(
						"Push exact contribution candidate for review?",
						`${approvedDraft.body}\n\nThis approval pushes only the verified candidate ${currentHead} with \`${currentHead}:refs/heads/${contribution.branch}\` through the confirmed fork remote ${contribution.remoteName}. Its verified push-effective destination is ${reviewPushRemoteUrl}, and the candidate branch must be absent. A command-scoped explicit pushurl prevents Git URL rewrite rules from changing that destination. This does not create or approve a pull request. The SHA-bound human sentence remains empty and must be written by the human reviewer.`,
						{ signal: publicationOperation.controller.signal },
					);
					if (!approved) return;
					try {
						authorizePublication();
					} catch (error) {
						ctx.ui.notify(`Contribution review failed: ${describeContributionError(error)}`, "error");
						return;
					}
					const confirmedSession = storage.getSessionById(session.id);
					const confirmedCandidateRun = candidateRun === null ? null : storage.getRunById(candidateRun.id);
					if (
						!confirmedSession ||
						confirmedSession.branch !== contribution.branch ||
						confirmedSession.currentSegment !== session.currentSegment ||
						confirmedCandidateRun?.commitHash !== currentHead ||
						!hasExecutableContributionTddProof(
							confirmedSession,
							confirmedCandidateRun,
							storage.listLoggedRuns(confirmedSession.id),
						)
					) {
						ctx.ui.notify("Contribution review proof changed after approval; publication cancelled.", "error");
						return;
					}
					const authorizePush = async (publication: PublishedContributionCandidate): Promise<void> => {
						authorizePublication();
						const intent = createPublicationEntryData(
							"intent",
							contribution,
							reviewPushRemoteUrl,
							currentHead,
							publication,
						);
						api.appendEntry(CONTRIBUTION_PUBLICATION_ENTRY, intent);
						await ctx.sessionManager.flush({ durable: true });
						authorizePublication();
						ctx.ui.notify(
							renderPublicationHandoff("Contribution publication plan (push outcome pending):", intent),
							"info",
						);
					};
					const publicationGit: ContributionPublicationGit = {
						...contributionPublicationGit,
						push(cwd, options) {
							publicationOperation.phase = "pushing";
							return contributionPublicationGit.push(cwd, options);
						},
					};

					try {
						let publication: PublishedContributionCandidate;
						try {
							publication = await publishContributionCandidate({
								cwd: ctx.cwd,
								remoteName: contribution.remoteName,
								confirmedRemoteUrl: contribution.remoteUrl,
								confirmedPushRemoteUrl: reviewPushRemoteUrl,
								branchName: contribution.branch,
								currentBranch,
								currentHead,
								baseProof: contribution.baseProof,
								worktreeClean: statusOutput.length === 0,
								currentSegment: runtime.state.currentSegment,
								goal: contribution.goal,
								candidate,
								approvedDraft,
								signal: publicationOperation.controller.signal,
								authorizePush,
								git: publicationGit,
							});
						} catch (error) {
							ctx.ui.notify(`Contribution review failed: ${describeContributionError(error)}`, "error");
							return;
						}
						publicationOperation.phase = "committed";
						api.appendEntry(
							CONTRIBUTION_PUBLICATION_ENTRY,
							createPublicationEntryData("success", contribution, reviewPushRemoteUrl, currentHead, publication),
						);
						runtime.contribution = {
							...contribution,
							status: "review",
							candidateHead: currentHead,
							publication,
						};
						runtime.autoresearchMode = false;
						runtime.autoResumeArmed = false;

						const cleanupWarnings: string[] = [];
						try {
							await closeContributionSession(ctx, contribution);
						} catch (error) {
							cleanupWarnings.push(`session close: ${describeContributionError(error)}`);
						}
						try {
							const experimentTools = new Set(EXPERIMENT_TOOL_NAMES);
							await api.setActiveTools(api.getActiveTools().filter(name => !experimentTools.has(name)));
						} catch (error) {
							cleanupWarnings.push(`tool deactivation: ${describeContributionError(error)}`);
						}
						try {
							dashboard.updateWidget(ctx, runtime);
						} catch (error) {
							cleanupWarnings.push(`dashboard update: ${describeContributionError(error)}`);
						}
						if (cleanupWarnings.length > 0) {
							ctx.ui.notify(
								`Contribution candidate was pushed, but cleanup needs attention: ${cleanupWarnings.join("; ")}`,
								"warning",
							);
						}
						ctx.ui.notify(
							`Immutable SHA review: ${publication.reviewUrl}\nMutable branch compare: ${publication.compareUrl}\n\nPR draft (human sentence intentionally empty):\n${publication.prDraft.title}\n\n${publication.prDraft.body}`,
							"info",
						);
					} finally {
						settlePublicationOperation();
					}
					return;
				} finally {
					settlePublicationOperation();
					releaseReviewAdmission();
				}
			}

			if (command !== "") {
				ctx.ui.notify("Usage: /contribute [status|off|review]", "error");
				return;
			}
			const contributionStartSession = getSessionKey(ctx);
			if (autoresearchCommandOperations.has(contributionStartSession)) {
				ctx.ui.notify(
					"Wait for the active autoresearch lifecycle operation before starting contribution mode.",
					"error",
				);
				return;
			}
			if (!ctx.hasUI) {
				ctx.ui.notify("Contribution mode requires an interactive UI for explicit confirmations.", "error");
				return;
			}
			if (!ctx.sessionManager.getSessionFile()) {
				ctx.ui.notify(
					"Contribution mode requires a persistent session transcript for publication recovery.",
					"error",
				);
				return;
			}
			const initialStartSessionKey = getSessionKey(ctx);
			const initialRehydrate = rehydrateOperations.get(initialStartSessionKey);
			if (initialRehydrate) await initialRehydrate;
			if (getSessionKey(ctx) !== initialStartSessionKey) {
				ctx.ui.notify("Contribution mode session changed while startup state was loading.", "error");
				return;
			}
			if (runtime.contribution.status === "running") {
				ctx.ui.notify("Stop the running contribution flow before starting another.", "error");
				return;
			}
			const preflightConfirmed = await ctx.ui.confirm(
				"Inspect official contribution prerequisites?",
				"Run bounded read-only discovery of official goal provenance, authenticated models, the clean base, active autoresearch state, and GitHub fork remotes? No model, branch, tools, or durable contribution state will change.",
			);
			if (!preflightConfirmed) return;
			let contributionStartSessionKey: string | null = null;
			let contributionStartTransaction: ContributionStartTransaction | null = null;
			let releaseStartAdmission: (() => void) | null = null;
			const startSessionKey = getSessionKey(ctx);
			const startTransaction: ContributionStartTransaction = {
				token: Symbol("contribution-start-authorization"),
				phase: "confirming",
				settlement: Promise.withResolvers<void>(),
			};
			contributionStartSessionKey = startSessionKey;
			contributionStartTransaction = startTransaction;
			releaseStartAdmission = acquireMutationAdmissionHold(startSessionKey);
			contributionStartTransactions.set(startSessionKey, startTransaction);
			advanceLifecycleEpoch(startSessionKey);
			try {
				const currentRehydrate = rehydrateOperations.get(startSessionKey);
				if (currentRehydrate) await currentRehydrate;
				assertContributionStartIdentity(ctx, runtime, startSessionKey, startTransaction);
				const startContribution = runtime.contribution;
				const startState = runtime.state;
				let ownedContribution: AutoresearchRuntime["contribution"] = startContribution;
				let ownedState = startState;
				const control = reconstructControlState(ctx.sessionManager.getBranch());
				const resumingAfterReview = runtime.contribution.status === "review";
				if (
					control.autoresearchMode ||
					runtime.autoresearchMode ||
					(!resumingAfterReview && runtime.state.sessionId !== null)
				) {
					ctx.ui.notify(
						"Contribution mode requires no active or resumable autoresearch state. Run `/autoresearch clear` deliberately first.",
						"error",
					);
					return;
				}
				if (await hasActiveAutoresearchSession(ctx.cwd)) {
					ctx.ui.notify(
						"Contribution mode requires no active autoresearch database session. Run `/autoresearch clear` deliberately first.",
						"error",
					);
					return;
				}
				const [goal, remotes] = await Promise.all([
					fetchOfficialContributionGoal(ctx.cwd),
					discoverContributionRemotes(ctx.cwd),
				]);
				await verifyContributionBase(ctx.cwd, goal);
				const priorBranch = await git.branch.current(ctx.cwd);
				if (priorBranch?.startsWith("autoresearch/")) {
					ctx.ui.notify(
						"Contribution mode must start from the official base, not an existing autoresearch branch.",
						"error",
					);
					return;
				}
				const authenticatedModels = ctx.models.list();
				if (authenticatedModels.length === 0) {
					ctx.ui.notify("No authenticated model is available for contribution mode.", "error");
					return;
				}
				const priorModel = ctx.models.current();
				if (
					!priorModel ||
					!authenticatedModels.some(model => model.provider === priorModel.provider && model.id === priorModel.id)
				) {
					ctx.ui.notify(
						"Contribution mode requires an authenticated current model so failures can restore it.",
						"error",
					);
					return;
				}
				const modelLabels = authenticatedModels.map(model => `${model.provider}/${model.id}`);
				const defaultModelIndex = priorModel
					? authenticatedModels.findIndex(
							model => model.provider === priorModel.provider && model.id === priorModel.id,
						)
					: -1;
				const modelSelection = await ctx.ui.select("Select authenticated contribution model", modelLabels, {
					initialIndex: defaultModelIndex >= 0 ? defaultModelIndex : 0,
				});
				if (!modelSelection) return;
				const selectedModel = authenticatedModels[modelLabels.indexOf(modelSelection)];
				if (!selectedModel) return;
				if (remotes.length === 0) {
					ctx.ui.notify("No eligible GitHub fork remote is configured for can1357/oh-my-pi.", "error");
					return;
				}
				const remoteLabels = remotes.map(choice => `${choice.name}: ${choice.remote.slug}`);
				const remoteSelection = await ctx.ui.select("Select GitHub fork publication remote", remoteLabels);
				if (!remoteSelection) return;
				const selectedRemote = remotes[remoteLabels.indexOf(remoteSelection)];
				if (!selectedRemote) return;
				await verifyContributionFork(ctx.cwd, selectedRemote.pushRemote);
				const branchName = await allocateAutoresearchBranchName(api, ctx.cwd, `contribute-${goal.title}`);
				assertContributionStartFresh(
					ctx,
					runtime,
					startSessionKey,
					startTransaction,
					startContribution,
					startState,
				);
				const finalConfirmed = await ctx.ui.confirm(
					"Start exact upstream contribution session?",
					`Goal: ${goal.title}\nOfficial main commit/base: ${goal.commitSha}\nGoal blob: ${goal.blobSha}\nGoal SHA-256: ${goal.sha256}\nModel: ${selectedModel.provider}/${selectedModel.id}\nConfirmed fork: ${selectedRemote.name} (${selectedRemote.url})\nVerified push-effective destination: ${selectedRemote.pushUrl}\nFresh local candidate branch: ${branchName}\n\nThis native OMP session continues indefinitely until /contribute off, an input/review gate, interruption, or session exit. Its uncapped model token use may consume subscription quota and incur API charges. There is no estimate and no cap. It runs tests/commands under normal approval policy and may create commits on the candidate branch. /contribute review requires another exact approval before an absent candidate branch is pushed to this fork; it never opens a pull request.\n\nOn confirmation only: recheck the official base and fork, switch model, create this exact branch from the frozen base commit, activate the existing autoresearch tools, then start the turn. Global approval policy is unchanged.`,
				);
				if (!finalConfirmed) return;
				await drainAutoresearchMutationOperations(startSessionKey);
				assertContributionStartFresh(
					ctx,
					runtime,
					startSessionKey,
					startTransaction,
					startContribution,
					startState,
				);

				const recheckedGoal = await fetchOfficialContributionGoal(ctx.cwd);
				assertContributionGoalUnchanged(goal, recheckedGoal);

				const [recheckedRemoteUrl, recheckedPushRemoteUrl] = await Promise.all([
					git.remote.url(ctx.cwd, selectedRemote.name),
					git.remote.pushUrl(ctx.cwd, selectedRemote.name),
				]);
				if (recheckedRemoteUrl !== selectedRemote.url || recheckedPushRemoteUrl !== selectedRemote.pushUrl) {
					ctx.ui.notify(
						"The selected fork or its push-effective destination changed after confirmation; start cancelled.",
						"error",
					);
					return;
				}
				const recheckedRemote = validateContributionForkRemote(recheckedRemoteUrl);
				const recheckedPushRemote = validateContributionForkRemote(recheckedPushRemoteUrl);
				if (
					recheckedRemote.slug !== selectedRemote.remote.slug ||
					recheckedPushRemote.slug !== selectedRemote.pushRemote.slug ||
					recheckedPushRemote.slug !== recheckedRemote.slug
				) {
					ctx.ui.notify("The selected fork destination changed after confirmation; start cancelled.", "error");
					return;
				}
				await verifyContributionFork(ctx.cwd, recheckedPushRemote);

				const frozenBaseProof = await verifyContributionBase(ctx.cwd, goal);
				if (await hasActiveAutoresearchSession(ctx.cwd)) {
					ctx.ui.notify(
						"Autoresearch state became active before contribution checkout; start cancelled.",
						"error",
					);
					return;
				}
				if ((await git.branch.current(ctx.cwd)) !== priorBranch) {
					ctx.ui.notify("The base branch changed after confirmation; start cancelled.", "error");
					return;
				}
				if (await git.ref.exists(ctx.cwd, `refs/heads/${branchName}`)) {
					ctx.ui.notify(`Fresh contribution branch became occupied before checkout: ${branchName}`, "error");
					return;
				}
				const previousTools = api.getActiveTools();
				let modelChanged = false;
				let branchCreated = false;
				let toolsTouched = false;
				try {
					assertContributionStartFresh(
						ctx,
						runtime,
						startSessionKey,
						startTransaction,
						startContribution,
						startState,
					);
					startTransaction.phase = "activating";
					modelChanged = true;
					const modelAccepted = await api.setModel(selectedModel);
					assertContributionStartFresh(
						ctx,
						runtime,
						startSessionKey,
						startTransaction,
						startContribution,
						startState,
					);
					if (!modelAccepted) {
						throw new Error(`Authenticated model switch failed: ${selectedModel.provider}/${selectedModel.id}`);
					}
					assertContributionStartFresh(
						ctx,
						runtime,
						startSessionKey,
						startTransaction,
						startContribution,
						startState,
					);
					await git.branch.checkoutNewAt(ctx.cwd, branchName, frozenBaseProof.baseSha);
					branchCreated = true;
					assertContributionStartFresh(
						ctx,
						runtime,
						startSessionKey,
						startTransaction,
						startContribution,
						startState,
					);
					await verifyContributionBase(ctx.cwd, goal);
					if ((await git.branch.current(ctx.cwd)) !== branchName) {
						throw new Error("Contribution checkout did not land on the frozen candidate branch.");
					}
					assertContributionStartFresh(
						ctx,
						runtime,
						startSessionKey,
						startTransaction,
						startContribution,
						startState,
					);
					toolsTouched = true;
					await api.setActiveTools([...new Set([...previousTools, ...EXPERIMENT_TOOL_NAMES])]);
					assertContributionStartFresh(
						ctx,
						runtime,
						startSessionKey,
						startTransaction,
						startContribution,
						startState,
					);
					await verifyContributionBase(ctx.cwd, goal);
					if ((await git.branch.current(ctx.cwd)) !== branchName) {
						throw new Error("Contribution checkout changed during tool activation.");
					}
					assertContributionStartFresh(
						ctx,
						runtime,
						startSessionKey,
						startTransaction,
						startContribution,
						startState,
					);
					const contribution: ContributionRunningState = {
						status: "running",
						authorization: Symbol("contribution-authorization"),
						goal,
						baseProof: frozenBaseProof,
						branch: branchName,
						model: { provider: selectedModel.provider, id: selectedModel.id },
						remoteName: selectedRemote.name,
						remoteUrl: selectedRemote.url,
						currentSegment: null,
						sessionId: null,
					};
					const contributionState = createExperimentState();
					ownedContribution = contribution;
					ownedState = contributionState;
					runtime.state = contributionState;
					runtime.goal = goal.content;
					runtime.contribution = contribution;
					runtime.autoresearchMode = true;
					runtime.autoResumeArmed = true;
					runtime.lastAutoResumePendingRunNumber = null;
					dashboard.updateWidget(ctx, runtime);
					assertContributionStartIdentity(ctx, runtime, startSessionKey, startTransaction);
					if (runtime.contribution !== contribution) {
						throw new Error("Contribution start state changed before the initial turn.");
					}
					api.sendUserMessage(goal.title);
				} catch (error) {
					const rollbackErrors: string[] = [];
					if (toolsTouched) {
						try {
							await api.setActiveTools(previousTools);
						} catch (rollbackError) {
							rollbackErrors.push(`tools: ${describeContributionError(rollbackError)}`);
						}
					}
					if (branchCreated) {
						try {
							await git.checkout(ctx.cwd, priorBranch ?? frozenBaseProof.baseSha);
							await git.branch.delete(ctx.cwd, branchName);
						} catch (rollbackError) {
							rollbackErrors.push(`branch: ${describeContributionError(rollbackError)}`);
						}
					}
					if (modelChanged && priorModel) {
						try {
							if (!(await api.setModel(priorModel))) rollbackErrors.push("model: previous model rejected");
						} catch (rollbackError) {
							rollbackErrors.push(`model: ${describeContributionError(rollbackError)}`);
						}
					}
					if (
						getSessionKey(ctx) === startSessionKey &&
						getRuntime(ctx) === runtime &&
						runtime.contribution === ownedContribution &&
						runtime.state === ownedState
					) {
						runtime.contribution = { status: "off" };
						runtime.autoresearchMode = false;
						runtime.autoResumeArmed = false;
						runtime.goal = null;
						runtime.state = createExperimentState();
						dashboard.updateWidget(ctx, runtime);
					}
					const rollback = rollbackErrors.length > 0 ? ` Rollback errors: ${rollbackErrors.join("; ")}` : "";
					ctx.ui.notify(`Contribution start failed: ${describeContributionError(error)}.${rollback}`, "error");
				}
			} catch (error) {
				ctx.ui.notify(`Contribution preflight failed: ${describeContributionError(error)}`, "error");
			} finally {
				if (contributionStartSessionKey !== null && contributionStartTransaction !== null) {
					if (contributionStartTransactions.get(contributionStartSessionKey) === contributionStartTransaction) {
						contributionStartTransactions.delete(contributionStartSessionKey);
					}
					contributionStartTransaction.settlement.resolve();
				}
				releaseStartAdmission?.();
			}
		},
	});

	api.registerShortcut("ctrl+x", {
		description: "Toggle autoresearch dashboard",
		handler(ctx): void {
			const runtime = getRuntime(ctx);
			if (runtime.state.results.length === 0 && !runtime.runningExperiment) {
				ctx.ui.notify("No autoresearch results yet", "info");
				return;
			}
			runtime.dashboardExpanded = !runtime.dashboardExpanded;
			dashboard.updateWidget(ctx, runtime);
		},
	});

	api.registerShortcut("ctrl+shift+x", {
		description: "Show autoresearch dashboard overlay",
		handler(ctx): Promise<void> {
			return dashboard.showOverlay(ctx, getRuntime(ctx));
		},
	});

	api.on("session_start", (_event, ctx) => rehydrate(ctx));
	api.on("session_before_switch", (event, ctx) => beginSessionTransition(event, ctx));
	api.on("session_before_move", (event, ctx) => beginSessionTransition(event, ctx));
	api.on("session_before_branch", (event, ctx) => beginSessionTransition(event, ctx));
	api.on("session_before_tree", (event, ctx) => beginSessionTransition(event, ctx));
	api.on("session_switch", (_event, ctx) => rehydrate(ctx));
	api.on("session_move", (_event, ctx) => deactivateOrdinaryAfterMove(ctx));
	api.on("session_branch", (_event, ctx) => rehydrate(ctx));
	api.on("session_tree", (_event, ctx) => rehydrate(ctx));
	api.on("session_transition_end", event => finishSessionTransition(event.transitionId));
	api.on("session_shutdown", (_event, ctx) => {
		const sessionKey = getSessionKey(ctx);
		const runtime = getRuntime(ctx);
		const publicationPhase = contributionPublicationOperations.get(sessionKey)?.phase;
		const transportStarted = publicationPhase === "pushing" || publicationPhase === "committed";
		dashboard.clear(ctx);
		const commandSettlement = autoresearchCommandOperations.get(sessionKey)?.settlement;
		const rehydrateSettlement = rehydrateOperations.get(sessionKey);
		const settlement = (async () => {
			await Promise.allSettled([commandSettlement, rehydrateSettlement]);
			await stopContributionRuntime(ctx, runtime);
			if (getSessionKey(ctx) !== sessionKey || getRuntime(ctx) !== runtime) return;
			const experimentTools = new Set(EXPERIMENT_TOOL_NAMES);
			await api.setActiveTools(api.getActiveTools().filter(name => !experimentTools.has(name)));
		})()
			.catch(error => {
				logger.warn("Failed to settle contribution shutdown", {
					error: describeContributionError(error),
					sessionKey,
				});
			})
			.finally(() => {
				if (getSessionKey(ctx) !== sessionKey || getRuntime(ctx) !== runtime) return;
				dashboard.clear(ctx);
				runtimeStore.clear(sessionKey);
			});
		if (transportStarted) {
			void settlement;
			return;
		}
		return settlement;
	});
	api.on("agent_end", async (event, ctx) => {
		let identity = captureLifecycleIdentity(ctx);
		const runtime = identity.runtime;
		const contributionRunning = runtime.contribution.status === "running";
		if ((!runtime.autoresearchMode && !contributionRunning) || mutationAdmissionClosed(identity.sessionKey)) return;
		runtime.runningExperiment = null;
		dashboard.updateWidget(ctx, runtime);
		dashboard.requestRender();
		if (contributionRunning) {
			// Approval dialogs cannot coexist with agent_end; queued messages and the
			// explicit pause marker cover the observable input gates at this boundary.
			if (event.willContinue || ctx.hasPendingMessages() || contributionEndMustPause(event.messages)) {
				runtime.autoResumeArmed = false;
				return;
			}
		} else if (ctx.hasPendingMessages()) {
			runtime.autoResumeArmed = false;
			return;
		}

		const { session, onActiveBranch } = await loadActiveSession(
			ctx,
			sessionOwnerForRuntime(runtime),
			runtime.ordinaryOwnerlessBranch,
		);
		if (!lifecycleIdentityIsCurrent(ctx, identity)) return;
		if (!contributionRunning && !onActiveBranch) {
			runtime.autoResumeArmed = false;
			return;
		}
		const storage = session ? await openAutoresearchStorageIfExists(ctx.cwd) : null;
		if (!lifecycleIdentityIsCurrent(ctx, identity)) return;
		const pendingRow = session && storage ? storage.getPendingRun(session.id) : null;
		const pendingRun = pendingRunSummaryFromRow(pendingRow);
		runtime.lastRunSummary = pendingRun;
		runtime.lastRunDuration = pendingRun?.durationSeconds ?? runtime.lastRunDuration;
		runtime.lastRunAsi = pendingRun?.parsedAsi ?? runtime.lastRunAsi;

		if (runtime.contribution.status === "running") {
			const currentBranch = await git.branch.current(ctx.cwd);
			if (!lifecycleIdentityIsCurrent(ctx, identity)) return;
			if (currentBranch !== runtime.contribution.branch) {
				await stopContributionRuntime(ctx, runtime);
				if (getSessionKey(ctx) !== identity.sessionKey || getRuntime(ctx) !== runtime) return;
				dashboard.updateWidget(ctx, runtime);
				dashboard.requestRender();
				return;
			}
			if (runtime.contribution.currentSegment === null && runtime.state.sessionId !== null) {
				runtime.contribution = {
					...runtime.contribution,
					currentSegment: runtime.state.currentSegment,
				};
				identity = captureLifecycleIdentity(ctx);
			}
			if (
				!lifecycleIdentityIsCurrent(ctx, identity) ||
				event.willContinue ||
				ctx.hasPendingMessages() ||
				contributionEndMustPause(event.messages)
			) {
				runtime.autoResumeArmed = false;
				return;
			}
			runtime.autoResumeArmed = false;
			runtime.lastAutoResumePendingRunNumber = pendingRun?.runNumber ?? null;
			if (!lifecycleIdentityIsCurrent(ctx, identity)) return;
			api.sendMessage(
				{
					customType: "autoresearch-resume",
					content: prompt.render(resumeMessageTemplate, {
						has_pending_run: Boolean(pendingRun),
					}),
					display: false,
					attribution: "agent",
				},
				{ deliverAs: "nextTurn", triggerTurn: true },
			);
			return;
		}

		const shouldResumePendingRun =
			pendingRun !== null && runtime.lastAutoResumePendingRunNumber !== pendingRun.runNumber;
		if (!shouldResumePendingRun && !runtime.autoResumeArmed) return;
		if (!lifecycleIdentityIsCurrent(ctx, identity) || ctx.hasPendingMessages()) return;
		runtime.autoResumeArmed = false;
		runtime.lastAutoResumePendingRunNumber = pendingRun?.runNumber ?? null;
		if (!lifecycleIdentityIsCurrent(ctx, identity)) return;
		api.sendMessage(
			{
				customType: "autoresearch-resume",
				content: prompt.render(resumeMessageTemplate, {
					has_pending_run: Boolean(pendingRun),
				}),
				display: false,
				attribution: "agent",
			},
			{ deliverAs: "nextTurn", triggerTurn: true },
		);
	});

	api.on("before_agent_start", async (event, ctx) => {
		let identity = captureLifecycleIdentity(ctx);
		const runtime = identity.runtime;
		if (mutationAdmissionClosed(identity.sessionKey)) return;
		if (!runtime.autoresearchMode) {
			if (
				runtime.contribution.status !== "off" ||
				(runtime.ordinarySessionOwner === null && runtime.ordinaryOwnerlessBranch === undefined)
			)
				return;
			const control = reconstructControlState(ctx.sessionManager.getBranch());
			if (!control.autoresearchMode) return;
			await rehydrate(ctx);
			identity = captureLifecycleIdentity(ctx);
			if (!runtime.autoresearchMode || mutationAdmissionClosed(identity.sessionKey)) return;
		}
		// Re-check git branch on every agent start. If the user manually switched
		// off the autoresearch/* branch between turns, we silently drop autoresearch
		// from this turn — the widget hides, the experiment tools detach, and we do
		// not inject the autoresearch system prompt.
		const expectedOwner = sessionOwnerForRuntime(runtime);
		const { session, currentBranch, onActiveBranch } = await loadActiveSession(
			ctx,
			expectedOwner,
			runtime.ordinaryOwnerlessBranch,
		);
		if (!lifecycleIdentityIsCurrent(ctx, identity)) return;
		if (session && runtime.contribution.status === "off") {
			const owner = runtime.ordinarySessionOwner;
			if (owner?.sessionId !== session.id || owner.branch !== session.branch) {
				runtime.ordinarySessionOwner = { sessionId: session.id, branch: session.branch };
				runtime.ordinaryOwnerlessBranch = undefined;
				identity = captureLifecycleIdentity(ctx);
			}
		}
		const onContributionBranch =
			runtime.contribution.status !== "running" || runtime.contribution.branch === currentBranch;
		if (!onActiveBranch || !onContributionBranch) {
			if (runtime.contribution.status === "running") {
				await stopContributionRuntime(ctx, runtime);
				if (getSessionKey(ctx) !== identity.sessionKey || getRuntime(ctx) !== runtime) return;
			} else {
				advanceLifecycleEpoch(identity.sessionKey);
				runtime.autoresearchMode = false;
				runtime.state = createExperimentState();
				runtime.lastRunSummary = null;
				runtime.runningExperiment = null;
			}
			dashboard.updateWidget(ctx, runtime);
			dashboard.requestRender();
			const settledIdentity = captureLifecycleIdentity(ctx);
			const experimentTools = new Set(EXPERIMENT_TOOL_NAMES);
			if (!lifecycleIdentityIsCurrent(ctx, settledIdentity)) return;
			await api.setActiveTools(api.getActiveTools().filter(name => !experimentTools.has(name)));
			if (!lifecycleIdentityIsCurrent(ctx, settledIdentity)) return;
			return;
		}
		const storage = await openAutoresearchStorageIfExists(ctx.cwd);
		if (!lifecycleIdentityIsCurrent(ctx, identity)) return;
		const nextState =
			session && storage ? buildExperimentState(session, storage.listLoggedRuns(session.id)) : runtime.state;
		const pendingRow = session && storage ? storage.getPendingRun(session.id) : null;
		const pendingRun = pendingRunSummaryFromRow(pendingRow);
		if (!lifecycleIdentityIsCurrent(ctx, identity)) return;
		runtime.state = nextState;
		runtime.lastRunSummary = pendingRun;
		runtime.lastRunDuration = pendingRun?.durationSeconds ?? runtime.lastRunDuration;
		runtime.lastRunAsi = pendingRun?.parsedAsi ?? runtime.lastRunAsi;
		identity = captureLifecycleIdentity(ctx);
		const state = runtime.state;
		// `event.systemPrompt` is typed `string[]`, but upstream code paths can leave
		// it unset (issue #3665). Coerce defensively so the autoresearch block still
		// renders — the model just loses the upstream prefix for this turn, which is
		// strictly better than crashing the handler.
		const basePrompt = Array.isArray(event.systemPrompt) ? event.systemPrompt.join("\n\n") : "";
		const currentSegmentResults = currentResults(state.results, state.currentSegment);
		const baselineMetric = findBaselineMetric(state.results, state.currentSegment);
		const baselineRunNumber = findBaselineRunNumber(state.results, state.currentSegment);
		const bestMetric = findBestKeptMetric(state.results, state.currentSegment, state.bestDirection);
		const bestResult = bestKeptResult(state.results, state.currentSegment, state.bestDirection);
		const goal = runtime.goal ?? state.goal ?? state.name ?? "";
		const recentResults = currentSegmentResults.slice(-3).map(result => {
			const asiSummary = summarizeExperimentAsi(result);
			return {
				asi_summary: asiSummary,
				description: result.description,
				has_asi_summary: Boolean(asiSummary),
				metric_display: formatNum(result.metric, state.metricUnit),
				run_number: result.runNumber ?? state.results.indexOf(result) + 1,
				status: result.status,
				has_deviations: result.scopeDeviations.length > 0,
				deviations: result.scopeDeviations.join(", "),
				justified: Boolean(result.justification),
				flagged: result.flagged,
				flagged_reason: result.flaggedReason ?? "",
			};
		});
		const unjustifiedRuns = currentSegmentResults
			.filter(r => r.status === "keep" && !r.flagged && r.scopeDeviations.length > 0 && !r.justification)
			.slice(-3)
			.map(r => ({
				run_number: r.runNumber,
				paths: r.scopeDeviations.join(", "),
			}));
		if (!session) {
			const onAutoresearchBranch = currentBranch?.startsWith("autoresearch/") ?? false;
			const baselineWarning = onAutoresearchBranch
				? null
				: "Heads up: you are not on a dedicated `autoresearch/*` branch. `log_experiment discard` will only revert run-modified files, not reset to baseline — so harness files written before `init_experiment` may not survive a discard. Clean the worktree and re-run `/autoresearch` if you want full revert safety.";
			const renderedSetupPrompt = prompt.render(setupPromptTemplate, {
				base_system_prompt: basePrompt,
				has_goal: goal.trim().length > 0,
				goal,
				working_dir: ctx.cwd,
				has_branch: Boolean(currentBranch),
				branch: currentBranch ?? "",
				has_baseline_warning: baselineWarning !== null,
				baseline_warning: baselineWarning ?? "",
			});
			if (!lifecycleIdentityIsCurrent(ctx, identity)) return;
			return {
				systemPrompt: [
					runtime.contribution.status === "running"
						? renderContributionPrompt(renderedSetupPrompt, runtime.contribution)
						: renderedSetupPrompt,
				],
			};
		}
		const renderedPrompt = prompt.render(promptTemplate, {
			base_system_prompt: basePrompt,
			has_goal: goal.trim().length > 0,
			goal,
			working_dir: ctx.cwd,
			default_metric_name: state.metricName,
			metric_name: state.metricName,
			has_branch: Boolean(state.branch),
			branch: state.branch,
			has_baseline_commit: Boolean(state.baselineCommit),
			baseline_commit: state.baselineCommit ? state.baselineCommit.slice(0, 12) : "",
			has_notes: state.notes.trim().length > 0,
			notes: state.notes,
			current_segment: state.currentSegment + 1,
			current_segment_run_count: currentSegmentResults.length,
			has_baseline_metric: baselineMetric !== null,
			baseline_metric_display: formatNum(baselineMetric, state.metricUnit),
			baseline_run_number: baselineRunNumber,
			has_best_result: bestResult !== null && bestMetric !== null,
			best_metric_display: bestMetric !== null ? formatNum(bestMetric, state.metricUnit) : "-",
			best_run_number: bestResult ? (bestResult.runNumber ?? state.results.indexOf(bestResult) + 1) : null,
			has_recent_results: recentResults.length > 0,
			recent_results: recentResults,
			has_unjustified_runs: unjustifiedRuns.length > 0,
			unjustified_runs: unjustifiedRuns,
			has_pending_run: Boolean(pendingRun),
			pending_run_number: pendingRun?.runNumber,
			pending_run_command: pendingRun?.command,
			pending_run_passed: pendingRun?.passed ?? false,
			has_pending_run_metric: pendingRun?.parsedPrimary !== null && pendingRun?.parsedPrimary !== undefined,
			pending_run_metric_display:
				pendingRun?.parsedPrimary !== null && pendingRun?.parsedPrimary !== undefined
					? formatNum(pendingRun.parsedPrimary, state.metricUnit)
					: null,
		});
		if (!lifecycleIdentityIsCurrent(ctx, identity)) return;
		return {
			systemPrompt: [
				runtime.contribution.status === "running"
					? renderContributionPrompt(renderedPrompt, runtime.contribution)
					: renderedPrompt,
			],
		};
	});

	async function handleClear(
		ctx: ExtensionContext,
		runtime: AutoresearchRuntime,
		opts: { keepTree: boolean; resetTreeForce: boolean },
	): Promise<void> {
		const branchName = await tryReadBranch(ctx.cwd);
		const storage = await openAutoresearchStorage(ctx.cwd);
		const session = storage.getActiveSessionForBranch(branchName);
		const onAutoresearchBranch = branchName?.startsWith("autoresearch/") ?? false;
		const shouldResetTree = !opts.keepTree && (onAutoresearchBranch || opts.resetTreeForce);
		if (shouldResetTree && session?.baselineCommit) {
			try {
				await git.reset(ctx.cwd, { hard: true, target: session.baselineCommit });
				await git.clean(ctx.cwd);
				ctx.ui.notify(`Reset worktree to baseline ${session.baselineCommit.slice(0, 12)}.`, "info");
			} catch (err) {
				ctx.ui.notify(
					`Failed to reset worktree to baseline: ${err instanceof Error ? err.message : String(err)}`,
					"error",
				);
			}
		} else if (shouldResetTree) {
			ctx.ui.notify("No baseline commit recorded — skipped worktree reset.", "warning");
		}

		removeLegacyArtifacts(ctx.cwd);

		if (session) {
			storage.closeSession(session.id);
			if (runtime.ordinarySessionOwner?.sessionId === session.id) {
				runtime.ordinarySessionOwner = null;
			}
		}
		runtime.state = createExperimentState();
		runtime.goal = null;
		runtime.lastRunDuration = null;
		runtime.lastRunAsi = null;
		runtime.lastRunArtifactDir = null;
		runtime.lastRunNumber = null;
		runtime.lastRunSummary = null;
		runtime.ordinaryOwnerlessBranch = undefined;
		setMode(ctx, false, null, "clear");
		dashboard.updateWidget(ctx, runtime);
		const experimentTools = new Set(EXPERIMENT_TOOL_NAMES);
		await api.setActiveTools(api.getActiveTools().filter(name => !experimentTools.has(name)));
		ctx.ui.notify("Autoresearch session cleared.", "info");
	}
};

const LEGACY_ARTIFACTS = [
	"autoresearch.md",
	"autoresearch.sh",
	"autoresearch.checks.sh",
	"autoresearch.program.md",
	"autoresearch.ideas.md",
	"autoresearch.jsonl",
	"autoresearch.config.json",
	".autoresearch",
];

function removeLegacyArtifacts(workDir: string): void {
	for (const name of LEGACY_ARTIFACTS) {
		const target = path.join(workDir, name);
		try {
			fs.rmSync(target, { recursive: true, force: true });
		} catch (err) {
			logger.warn("Failed to remove legacy autoresearch artifact", {
				path: target,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
}

function pendingRunSummaryFromRow(row: RunRow | null): PendingRunSummary | null {
	if (!row) return null;
	if (row.status !== null) return null;
	if (row.completedAt === null) return null;
	const passed = row.exitCode === 0 && !row.timedOut;
	return {
		command: row.command,
		durationSeconds: row.durationMs !== null ? row.durationMs / 1000 : null,
		parsedAsi: row.parsedAsi,
		parsedMetrics: row.parsedMetrics,
		parsedPrimary: row.parsedPrimary,
		passed,
		preRunDirtyPaths: row.preRunDirtyPaths,
		runDirectory: path.dirname(row.logPath),
		runNumber: row.id,
		exitCode: row.exitCode,
		timedOut: row.timedOut,
	};
}

function summarizeExperimentAsi(result: ExperimentResult): string | null {
	const hypothesis = typeof result.asi?.hypothesis === "string" ? result.asi.hypothesis.trim() : "";
	const rollback = typeof result.asi?.rollback_reason === "string" ? result.asi.rollback_reason.trim() : "";
	const next = typeof result.asi?.next_action_hint === "string" ? result.asi.next_action_hint.trim() : "";
	const summary = [hypothesis, rollback, next].filter(part => part.length > 0).join(" | ");
	return summary.length > 0 ? summary.slice(0, 220) : null;
}

function bestKeptResult(
	results: ExperimentResult[],
	segment: number,
	direction: "lower" | "higher",
): ExperimentResult | null {
	let best: ExperimentResult | null = null;
	for (const result of results) {
		if (result.segment !== segment || result.status !== "keep" || result.flagged) continue;
		if (!best) {
			best = result;
			continue;
		}
		const better = direction === "lower" ? result.metric < best.metric : result.metric > best.metric;
		if (better) best = result;
	}
	return best;
}

function keptResultAtHead(results: ExperimentResult[], segment: number, head: string): ExperimentResult | null {
	for (let index = results.length - 1; index >= 0; index -= 1) {
		const result = results[index];
		if (
			result &&
			result.segment === segment &&
			result.status === "keep" &&
			!result.flagged &&
			result.commit.toLowerCase() === head.toLowerCase()
		) {
			return result;
		}
	}
	return null;
}

async function tryReadBranch(cwd: string): Promise<string | null> {
	try {
		return (await git.branch.current(cwd)) ?? null;
	} catch {
		return null;
	}
}
