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
	buildContributionPrDraft,
	type ContributionCandidate,
	ContributionError,
	type ContributionGoal,
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
import type { AutoresearchRuntime, ContributionRunningState, ExperimentResult, PendingRunSummary } from "./types";

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

interface InitExperimentOperation {
	readonly controller: AbortController;
	readonly settlement: PromiseWithResolvers<void>;
}

const contributionPublicationGit: ContributionPublicationGit = {
	readRemoteUrl: (cwd, remote, signal) => git.remote.url(cwd, remote, signal),
	readPushRemoteUrl: (cwd, remote, signal) => git.remote.pushUrl(cwd, remote, signal),
	readBranch: (cwd, signal) => git.branch.current(cwd, signal),
	readHead: (cwd, signal) => git.head.sha(cwd, signal),
	readStatus: (cwd, signal) => git.status(cwd, { porcelainV1: true, untrackedFiles: "all", z: true, signal }),
	isAncestor: (cwd, ancestor, descendant, signal) => git.isAncestor(cwd, ancestor, descendant, signal),
	push: (cwd, options) =>
		git.push(cwd, {
			remote: options.remote,
			verifiedRemoteUrl: options.verifiedRemoteUrl,
			refspec: options.refspec,
			forceWithLease: options.forceWithLease,
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
	for (let index = messages.length - 1; index >= 0; index -= 1) {
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
	const contributionPublicationControllers = new Map<string, AbortController>();
	const initExperimentOperations = new Map<string, InitExperimentOperation>();

	const invalidateContributionOperations = (sessionKey: string): Promise<void> | undefined => {
		const startTransaction = contributionStartTransactions.get(sessionKey);
		if (startTransaction) startTransaction.token = null;
		const controller = contributionPublicationControllers.get(sessionKey);
		if (controller) {
			contributionPublicationControllers.delete(sessionKey);
			controller.abort();
		}
		return startTransaction?.phase === "activating" ? startTransaction.settlement.promise : undefined;
	};

	const invalidateInitExperimentOperation = (sessionKey: string): Promise<void> | undefined => {
		const operation = initExperimentOperations.get(sessionKey);
		if (!operation) return undefined;
		operation.controller.abort(new ToolAbortError("Autoresearch init authorization changed before mutation."));
		return operation.settlement.promise;
	};

	const getSessionKey = (ctx: ExtensionContext): string => ctx.sessionManager.getSessionId();
	const getRuntime = (ctx: ExtensionContext): AutoresearchRuntime => runtimeStore.ensure(getSessionKey(ctx));
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

	const loadActiveSession = async (
		ctx: ExtensionContext,
	): Promise<{ session: SessionRow | null; currentBranch: string | null }> => {
		const currentBranch = await tryReadBranch(ctx.cwd);
		const storage = await openAutoresearchStorageIfExists(ctx.cwd);
		if (!storage) return { session: null, currentBranch };
		const session = storage.getActiveSessionForBranch(currentBranch);
		return { session, currentBranch };
	};

	const rehydrate = async (ctx: ExtensionContext): Promise<void> => {
		const activationSettlement = invalidateContributionOperations(getSessionKey(ctx));
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
		const { session, currentBranch } = everActivated
			? await loadActiveSession(ctx)
			: { session: null, currentBranch: null };

		// Mode is effective only when the recorded session matches the current git
		// branch. When the user switches off the autoresearch branch the widget hides
		// and the experiment tools detach, but the session entries are preserved so
		// switching back resumes seamlessly.
		const onActiveBranch = session === null || session.branch === null || session.branch === currentBranch;
		const onContributionBranch =
			!contributionRunning ||
			runtime.contribution.status !== "running" ||
			runtime.contribution.branch === currentBranch;
		runtime.autoresearchMode = contributionRunning
			? onActiveBranch && onContributionBranch
			: control.autoresearchMode && onActiveBranch;

		if (session && onActiveBranch) {
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
	};

	const setMode = (
		ctx: ExtensionContext,
		enabled: boolean,
		goal: string | null,
		mode: "on" | "off" | "clear",
	): void => {
		const runtime = getRuntime(ctx);
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

	const stopContributionRuntime = async (
		ctx: ExtensionContext,
		runtime: AutoresearchRuntime,
		awaitActivationRollback = false,
	): Promise<string[]> => {
		const sessionKey = getSessionKey(ctx);
		const initSettlement = invalidateInitExperimentOperation(sessionKey);
		const activationSettlement = invalidateContributionOperations(sessionKey);
		if (initSettlement) await initSettlement;
		if (awaitActivationRollback && activationSettlement) await activationSettlement;
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
	};

	api.registerTool(
		createInitExperimentTool({
			dashboard,
			getRuntime,
			pi: api,
			captureMutationAuthorization(ctx) {
				const sessionKey = getSessionKey(ctx);
				if (contributionStartTransactions.has(sessionKey)) {
					throw new Error("Contribution startup is already active for this session.");
				}
				if (initExperimentOperations.has(sessionKey)) {
					throw new Error("An init_experiment operation is already active for this session.");
				}
				const captured = getRuntime(ctx).contribution;
				const operation: InitExperimentOperation = {
					controller: new AbortController(),
					settlement: Promise.withResolvers<void>(),
				};
				initExperimentOperations.set(sessionKey, operation);
				let settled = false;
				const assertProcessIdentity = (currentCtx: ExtensionContext): void => {
					const current = getRuntime(currentCtx).contribution;
					if (getSessionKey(currentCtx) !== sessionKey) {
						throw new Error("Autoresearch init authorization changed before mutation.");
					}
					if (captured.status !== "running") {
						if (current.status === "running") {
							throw new Error("Contribution startup overtook autoresearch init before mutation.");
						}
						return;
					}
					if (
						current.status !== "running" ||
						current.authorization !== captured.authorization ||
						current.branch !== captured.branch ||
						current.sessionId !== captured.sessionId
					) {
						throw new Error("Contribution init authorization changed before mutation.");
					}
				};
				return {
					signal: operation.controller.signal,
					async authorizeMutation(currentCtx, signal): Promise<void> {
						throwIfAborted(signal);
						assertProcessIdentity(currentCtx);
						if (captured.status === "running") {
							const storage = await openAutoresearchStorageIfExists(currentCtx.cwd);
							const currentBranch = await git.branch.current(currentCtx.cwd, signal);
							const session = storage?.getActiveSessionForBranch(captured.branch) ?? null;
							if (
								currentBranch !== captured.branch ||
								(captured.sessionId === null ? session !== null : session?.id !== captured.sessionId)
							) {
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
						if (initExperimentOperations.get(sessionKey) === operation) {
							initExperimentOperations.delete(sessionKey);
						}
						operation.settlement.resolve();
					},
				};
			},
			forceUncapped: ctx => getRuntime(ctx).contribution.status === "running",
			onSessionUpdated(ctx, state): void {
				const runtime = getRuntime(ctx);
				if (runtime.contribution.status !== "running" || state.branch !== runtime.contribution.branch) return;
				runtime.contribution = {
					...runtime.contribution,
					sessionId: state.sessionId,
					currentSegment: state.currentSegment,
				};
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

	api.registerTool(createRunExperimentTool({ dashboard, getRuntime, pi: api }));
	api.registerTool(createLogExperimentTool({ dashboard, getRuntime, pi: api }));
	api.registerTool(createUpdateNotesTool({ dashboard, getRuntime, pi: api }));

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
			if (runtime.contribution.status !== "off") {
				ctx.ui.notify("Stop contribution mode with `/contribute off` before using `/autoresearch`.", "error");
				return;
			}

			if (trimmed === "" && runtime.autoresearchMode) {
				setMode(ctx, false, runtime.goal, "off");
				dashboard.updateWidget(ctx, runtime);
				const experimentTools = new Set(EXPERIMENT_TOOL_NAMES);
				await api.setActiveTools(api.getActiveTools().filter(name => !experimentTools.has(name)));
				ctx.ui.notify("Autoresearch mode disabled", "info");
				return;
			}

			if (trimmed === "off") {
				setMode(ctx, false, runtime.goal, "off");
				dashboard.updateWidget(ctx, runtime);
				const experimentTools = new Set(EXPERIMENT_TOOL_NAMES);
				await api.setActiveTools(api.getActiveTools().filter(name => !experimentTools.has(name)));
				ctx.ui.notify("Autoresearch mode disabled", "info");
				return;
			}

			if (trimmed === "clear" || trimmed.startsWith("clear ")) {
				const flagPart = trimmed === "clear" ? "" : trimmed.slice("clear ".length).trim();
				const keepTree = flagPart.includes("--keep-tree");
				const resetTreeForce = flagPart.includes("--reset-tree");
				await handleClear(ctx, runtime, { keepTree, resetTreeForce });
				return;
			}

			const goalArg = trimmed.length > 0 ? trimmed : null;
			const branchResult = await ensureAutoresearchBranch(api, ctx.cwd, goalArg ?? runtime.goal);
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
			const existingSession = existingStorage?.getActiveSessionForBranch(branchResult.branchName) ?? null;
			const resumeContext = trimmed;
			const branchStatusLine = branchResult.branchName
				? branchResult.created
					? `Created and checked out dedicated git branch \`${branchResult.branchName}\` before resuming.`
					: `Using dedicated git branch \`${branchResult.branchName}\`.`
				: "Continuing on the current branch — no autoresearch branch was created.";

			if (existingSession && existingStorage) {
				if (goalArg) existingStorage.updateSession(existingSession.id, { goal: goalArg });
				if (branchResult.branchName) {
					existingStorage.updateSession(existingSession.id, { branch: branchResult.branchName });
				}
				const refreshed = existingStorage.getSessionById(existingSession.id) ?? existingSession;
				runtime.state = buildExperimentState(refreshed, existingStorage.listLoggedRuns(refreshed.id));
				runtime.goal = refreshed.goal ?? goalArg;
				setMode(ctx, true, runtime.goal, "on");
				dashboard.updateWidget(ctx, runtime);
				await api.setActiveTools([...new Set([...api.getActiveTools(), ...EXPERIMENT_TOOL_NAMES])]);
				api.sendUserMessage(
					prompt.render(commandResumeTemplate, {
						branch_status_line: branchStatusLine,
						has_resume_context: resumeContext.length > 0,
						resume_context: resumeContext,
					}),
				);
				return;
			}

			setMode(ctx, true, goalArg, "on");
			dashboard.updateWidget(ctx, runtime);
			await api.setActiveTools([...new Set([...api.getActiveTools(), ...EXPERIMENT_TOOL_NAMES])]);
			if (goalArg !== null) {
				api.sendUserMessage(goalArg);
			} else {
				ctx.ui.notify("Autoresearch enabled—describe what to optimize in your next message.", "info");
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
				invalidateContributionOperations(getSessionKey(ctx));
				if (runtime.contribution.status === "off") {
					ctx.ui.notify("Contribution mode is already off.", "info");
					return;
				}
				const warnings = await stopContributionRuntime(ctx, runtime);
				dashboard.updateWidget(ctx, runtime);
				if (warnings.length > 0) {
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
				const contribution = runtime.contribution;
				const storage = await openAutoresearchStorageIfExists(ctx.cwd);
				if (!storage || contribution.sessionId === null) {
					ctx.ui.notify("Contribution review requires an initialized experiment session.", "error");
					return;
				}
				const session = storage.getSessionById(contribution.sessionId);
				if (!session || session.branch !== contribution.branch) {
					ctx.ui.notify("The recorded contribution experiment no longer matches its dedicated branch.", "error");
					return;
				}
				runtime.state = buildExperimentState(session, storage.listLoggedRuns(session.id));
				let currentBranch: string | null;
				let currentHead: string | null;
				let statusOutput: string;
				try {
					[currentBranch, currentHead, statusOutput] = await Promise.all([
						git.branch.current(ctx.cwd),
						git.head.sha(ctx.cwd),
						git.status(ctx.cwd, { porcelainV1: true, untrackedFiles: "all", z: true }),
					]);
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
				try {
					if (!(await git.isAncestor(ctx.cwd, contribution.baseProof.baseSha, currentHead))) {
						throw new ContributionError(
							"candidate_not_descendant",
							"The contribution candidate does not descend from the frozen official base.",
						);
					}
				} catch (error) {
					ctx.ui.notify(`Contribution review failed: ${describeContributionError(error)}`, "error");
					return;
				}
				const candidateResult = keptResultAtHead(runtime.state.results, runtime.state.currentSegment, currentHead);
				if (!candidateResult) {
					ctx.ui.notify(
						"Contribution review requires the current HEAD to be an unflagged kept result in the current segment.",
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
					description: result,
					scenario,
					metric: candidateResult.metric,
					metricName: runtime.state.metricName.trim().replace(/\s+/g, " ").slice(0, 80) || "metric",
					metricUnit: runtime.state.metricUnit.trim().replace(/\s+/g, " ").slice(0, 20),
				};
				let reviewPushRemoteUrl: string;
				try {
					const [reviewRemoteUrl, pushRemoteUrl] = await Promise.all([
						git.remote.url(ctx.cwd, contribution.remoteName),
						git.remote.pushUrl(ctx.cwd, contribution.remoteName),
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
					await verifyContributionFork(ctx.cwd, pushRemote);
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
				const reviewSessionKey = getSessionKey(ctx);
				const reviewAuthorization = contribution.authorization;
				const reviewBranch = contribution.branch;
				const reviewSessionId = contribution.sessionId;
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
				const approved = await ctx.ui.confirm(
					"Push exact contribution candidate for review?",
					`${approvedDraft.body}\n\nThis approval pushes only the verified current HEAD candidate ${currentHead} with \`HEAD:refs/heads/${contribution.branch}\` through the confirmed fork remote ${contribution.remoteName}. Its verified push-effective destination is ${reviewPushRemoteUrl}, and the candidate branch must be absent. A command-scoped explicit pushurl prevents Git URL rewrite rules from changing that destination. This does not create or approve a pull request. The SHA-bound human sentence remains empty and must be written by the human reviewer.`,
				);
				if (!approved) return;
				try {
					assertContributionIdentity();
				} catch (error) {
					ctx.ui.notify(`Contribution review failed: ${describeContributionError(error)}`, "error");
					return;
				}
				const priorPublicationController = contributionPublicationControllers.get(reviewSessionKey);
				priorPublicationController?.abort();
				const publicationController = new AbortController();
				contributionPublicationControllers.set(reviewSessionKey, publicationController);
				const authorizePublication = (): void => {
					throwIfAborted(publicationController.signal);
					if (contributionPublicationControllers.get(reviewSessionKey) !== publicationController) {
						throw new Error("Contribution publication authorization changed.");
					}
					assertContributionIdentity();
				};

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
						signal: publicationController.signal,
						authorizePush: authorizePublication,
						git: contributionPublicationGit,
					});
					authorizePublication();
				} catch (error) {
					ctx.ui.notify(`Contribution review failed: ${describeContributionError(error)}`, "error");
					return;
				} finally {
					if (contributionPublicationControllers.get(reviewSessionKey) === publicationController) {
						contributionPublicationControllers.delete(reviewSessionKey);
					}
				}

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
				return;
			}

			if (command !== "") {
				ctx.ui.notify("Usage: /contribute [status|off|review]", "error");
				return;
			}
			if (!ctx.hasUI) {
				ctx.ui.notify("Contribution mode requires an interactive UI for explicit confirmations.", "error");
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
			const preflightInitSettlement = invalidateInitExperimentOperation(getSessionKey(ctx));
			if (preflightInitSettlement) await preflightInitSettlement;

			let contributionStartSessionKey: string | null = null;
			let contributionStartTransaction: ContributionStartTransaction | null = null;
			try {
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
				const startSessionKey = getSessionKey(ctx);
				const startTransaction: ContributionStartTransaction = {
					token: Symbol("contribution-start-authorization"),
					phase: "confirming",
					settlement: Promise.withResolvers<void>(),
				};
				const startContribution = runtime.contribution;
				const startState = runtime.state;
				let ownedContribution: AutoresearchRuntime["contribution"] = startContribution;
				let ownedState = startState;
				contributionStartSessionKey = startSessionKey;
				contributionStartTransaction = startTransaction;
				contributionStartTransactions.set(startSessionKey, startTransaction);
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
					`Goal: ${goal.title}\nOfficial main commit/base: ${goal.commitSha}\nGoal blob: ${goal.blobSha}\nGoal SHA-256: ${goal.sha256}\nModel: ${selectedModel.provider}/${selectedModel.id}\nConfirmed fork: ${selectedRemote.name} (${selectedRemote.url})\nVerified push-effective destination: ${selectedRemote.pushUrl}\nFresh local candidate branch: ${branchName}\n\nThis native OMP session continues indefinitely until /contribute off, an input/review gate, interruption, or session exit. It consumes model tokens, runs tests/commands under normal approval policy, and may create commits on the candidate branch. /contribute review requires another exact approval before an absent candidate branch is pushed to this fork; it never opens a pull request.\n\nOn confirmation only: recheck the official base and fork, switch model, create this exact branch from the frozen base commit, activate the existing autoresearch tools, then start the turn. Global approval policy is unchanged.`,
				);
				if (!finalConfirmed) return;
				const confirmedInitSettlement = invalidateInitExperimentOperation(startSessionKey);
				if (confirmedInitSettlement) await confirmedInitSettlement;
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
	api.on("session_before_switch", async (_event, ctx) => {
		await stopContributionRuntime(ctx, getRuntime(ctx), true);
	});
	api.on("session_before_branch", async (_event, ctx) => {
		await stopContributionRuntime(ctx, getRuntime(ctx), true);
	});
	api.on("session_before_tree", async (_event, ctx) => {
		await stopContributionRuntime(ctx, getRuntime(ctx), true);
	});
	api.on("session_switch", (_event, ctx) => rehydrate(ctx));
	api.on("session_branch", (_event, ctx) => rehydrate(ctx));
	api.on("session_tree", (_event, ctx) => rehydrate(ctx));
	api.on("session_shutdown", async (_event, ctx) => {
		try {
			await stopContributionRuntime(ctx, getRuntime(ctx), true);
		} finally {
			try {
				const experimentTools = new Set(EXPERIMENT_TOOL_NAMES);
				await api.setActiveTools(api.getActiveTools().filter(name => !experimentTools.has(name)));
			} finally {
				dashboard.clear(ctx);
				runtimeStore.clear(getSessionKey(ctx));
			}
		}
	});
	api.on("agent_end", async (event, ctx) => {
		const runtime = getRuntime(ctx);
		runtime.runningExperiment = null;
		dashboard.updateWidget(ctx, runtime);
		dashboard.requestRender();
		const contributionRunning = runtime.contribution.status === "running";
		if (!runtime.autoresearchMode && !contributionRunning) return;
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

		const { session } = await loadActiveSession(ctx);
		const storage = session ? await openAutoresearchStorageIfExists(ctx.cwd) : null;
		const pendingRow = session && storage ? storage.getPendingRun(session.id) : null;
		const pendingRun = pendingRunSummaryFromRow(pendingRow);
		runtime.lastRunSummary = pendingRun;
		runtime.lastRunDuration = pendingRun?.durationSeconds ?? runtime.lastRunDuration;
		runtime.lastRunAsi = pendingRun?.parsedAsi ?? runtime.lastRunAsi;

		if (runtime.contribution.status === "running") {
			const currentBranch = await git.branch.current(ctx.cwd);
			if (currentBranch !== runtime.contribution.branch) {
				await stopContributionRuntime(ctx, runtime);
				const experimentTools = new Set(EXPERIMENT_TOOL_NAMES);
				await api.setActiveTools(api.getActiveTools().filter(name => !experimentTools.has(name)));
				dashboard.updateWidget(ctx, runtime);
				return;
			}
			if (runtime.contribution.currentSegment === null && runtime.state.sessionId !== null) {
				runtime.contribution = {
					...runtime.contribution,
					currentSegment: runtime.state.currentSegment,
				};
			}
			runtime.autoResumeArmed = false;
			runtime.lastAutoResumePendingRunNumber = pendingRun?.runNumber ?? null;
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
		runtime.autoResumeArmed = false;
		runtime.lastAutoResumePendingRunNumber = pendingRun?.runNumber ?? null;
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
		const runtime = getRuntime(ctx);
		if (!runtime.autoresearchMode) return;
		// Re-check git branch on every agent start. If the user manually switched
		// off the autoresearch/* branch between turns, we silently drop autoresearch
		// from this turn — the widget hides, the experiment tools detach, and we do
		// not inject the autoresearch system prompt.
		const { session, currentBranch } = await loadActiveSession(ctx);
		const onActiveBranch = session === null || session.branch === null || session.branch === currentBranch;
		const onContributionBranch =
			runtime.contribution.status !== "running" || runtime.contribution.branch === currentBranch;
		if (!onActiveBranch || !onContributionBranch) {
			if (runtime.contribution.status === "running") {
				await stopContributionRuntime(ctx, runtime);
			} else {
				runtime.autoresearchMode = false;
				runtime.state = createExperimentState();
				runtime.lastRunSummary = null;
				runtime.runningExperiment = null;
			}
			dashboard.updateWidget(ctx, runtime);
			const experimentTools = new Set(EXPERIMENT_TOOL_NAMES);
			await api.setActiveTools(api.getActiveTools().filter(name => !experimentTools.has(name)));
			return;
		}
		const storage = await openAutoresearchStorageIfExists(ctx.cwd);
		if (session && storage) {
			runtime.state = buildExperimentState(session, storage.listLoggedRuns(session.id));
		}
		const pendingRow = session && storage ? storage.getPendingRun(session.id) : null;
		const pendingRun = pendingRunSummaryFromRow(pendingRow);
		runtime.lastRunSummary = pendingRun;
		runtime.lastRunDuration = pendingRun?.durationSeconds ?? runtime.lastRunDuration;
		runtime.lastRunAsi = pendingRun?.parsedAsi ?? runtime.lastRunAsi;
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
			const currentBranch = await tryReadBranch(ctx.cwd);
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
		const storage = await openAutoresearchStorage(ctx.cwd);
		const session = storage.getActiveSession();
		const branchName = await tryReadBranch(ctx.cwd);
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
		}
		runtime.state = createExperimentState();
		runtime.goal = null;
		runtime.lastRunDuration = null;
		runtime.lastRunAsi = null;
		runtime.lastRunArtifactDir = null;
		runtime.lastRunNumber = null;
		runtime.lastRunSummary = null;
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
