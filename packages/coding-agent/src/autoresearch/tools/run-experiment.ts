import * as fs from "node:fs";
import * as path from "node:path";
import { Text } from "@oh-my-pi/pi-tui";
import { formatBytes } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import { executeBash } from "../../exec/bash-executor";
import type { ToolDefinition } from "../../extensibility/extensions";
import type { Theme } from "../../modes/theme/theme";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, TailBuffer, truncateTail } from "../../session/streaming-output";
import { replaceTabs, shortenPath } from "../../tools/render-utils";
import { throwIfAborted } from "../../tools/tool-errors";
import * as git from "../../utils/git";
import {
	CONTRIBUTION_HARNESS_MAX_BYTES,
	CONTRIBUTION_HARNESS_SHA256_ASI_KEY,
	CONTRIBUTION_INVOCATION_SHA256_ASI_KEY,
	CONTRIBUTION_WORKTREE_TREE_ASI_KEY,
} from "../contribution";
import { parseWorkDirDirtyPaths } from "../git";
import {
	EXPERIMENT_MAX_BYTES,
	EXPERIMENT_MAX_LINES,
	formatElapsed,
	formatNum,
	parseAsiLines,
	parseMetricLines,
	tryGitPrefix,
	tryGitStatus,
} from "../helpers";
import { buildExperimentState } from "../state";
import { openAutoresearchStorageIfExists } from "../storage";
import type { AutoresearchToolFactoryOptions, RunDetails, RunExperimentProgressDetails } from "../types";
import { CONTRIBUTION_HEAD_SHA_ASI_KEY } from "../types";
import { DEFAULT_HARNESS_COMMAND, HARNESS_FILENAME } from "./init-experiment";
import { beginAutoresearchMutation } from "./mutation-authorization";

const runExperimentSchema = type({
	"timeout_seconds?": type("number").describe("timeout in seconds (default 600)"),
});

interface ProcessExecutionResult {
	exitCode: number | null;
	killed: boolean;
	logPath: string;
	output: string;
}

interface ProgressSnapshot {
	elapsed: string;
	runDirectory: string;
	fullOutputPath: string;
	tailOutput: string;
	truncation?: RunExperimentProgressDetails["truncation"];
}

interface ContributionExecutionProof {
	readonly harnessSha256: string;
	readonly invocationSha256: string;
	readonly worktreeTreeSha: string;
	readonly headSha: string;
}

export function createRunExperimentTool(
	options: AutoresearchToolFactoryOptions,
): ToolDefinition<typeof runExperimentSchema, RunDetails | RunExperimentProgressDetails> {
	return {
		name: "run_experiment",
		label: "Run Experiment",
		description:
			"Run any benchmark command. Output is captured automatically; `METRIC name=value` and `ASI key=value` lines printed by the command are parsed.",
		parameters: runExperimentSchema,
		defaultInactive: true,
		concurrency: () => "exclusive",
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const mutation = beginAutoresearchMutation(options, ctx, signal);
			const operationSignal = mutation.signal;
			try {
				await mutation.authorizeMutation();
				const storage = await openAutoresearchStorageIfExists(ctx.cwd);
				const currentBranch = (await git.branch.current(ctx.cwd, operationSignal)) ?? null;
				await mutation.authorizeMutation();
				const session = storage?.getActiveSessionForBranch(currentBranch) ?? null;
				if (!storage || !session) {
					return {
						content: [
							{
								type: "text",
								text: "Error: no active autoresearch session for the current branch. Call init_experiment first.",
							},
						],
					};
				}

				const runtime = options.getRuntime(ctx);

				const abandonedPriorRun = (() => {
					const pending = storage.getPendingRun(session.id);
					if (!pending) return null;
					storage.abandonPendingRuns(session.id);
					return pending.id;
				})();

				const resolvedCommand = DEFAULT_HARNESS_COMMAND;
				const preRunStatus = await tryGitStatus(ctx.cwd, operationSignal);
				const workDirPrefix = await tryGitPrefix(ctx.cwd, operationSignal);
				const preRunDirtyPaths = parseWorkDirDirtyPaths(preRunStatus, workDirPrefix);
				await mutation.authorizeMutation();

				const startedAt = Date.now();
				const insertedRun = storage.insertRun({
					sessionId: session.id,
					segment: session.currentSegment,
					command: resolvedCommand,
					logPath: "", // patched after we know the run id
					preRunDirtyPaths,
					startedAt,
				});

				const runDirectory = path.join(storage.projectDir, "runs", String(insertedRun.id).padStart(4, "0"));
				const benchmarkLogPath = path.join(runDirectory, "benchmark.log");
				fs.mkdirSync(runDirectory, { recursive: true });
				storage.updateRunLogPath(insertedRun.id, benchmarkLogPath);

				runtime.lastRunDuration = null;
				runtime.lastRunAsi = null;
				runtime.lastRunArtifactDir = runDirectory;
				runtime.lastRunNumber = insertedRun.id;
				runtime.lastRunSummary = null;
				runtime.runningExperiment = {
					startedAt,
					command: resolvedCommand,
					runDirectory,
					runNumber: insertedRun.id,
				};
				options.dashboard.updateWidget(ctx, runtime);
				options.dashboard.requestRender();

				const requestedTimeoutMs = Math.max(0, Math.floor((params.timeout_seconds ?? 600) * 1000));
				const effectiveTimeoutMs = requestedTimeoutMs > 0 ? requestedTimeoutMs : 2_147_000_000;
				let execution: ProcessExecutionResult;
				let contributionProof: ContributionExecutionProof | null = null;
				try {
					await mutation.authorizeMutation();
					if (runtime.contribution.status === "running") {
						contributionProof = await captureContributionExecutionProof(
							ctx.cwd,
							resolvedCommand,
							effectiveTimeoutMs,
							operationSignal,
						);
					}
					execution = await executeProcess({
						command: resolvedCommand,
						cwd: ctx.cwd,
						logPath: benchmarkLogPath,
						timeoutMs: effectiveTimeoutMs,
						signal: operationSignal,
						onProgress: details => {
							onUpdate?.({
								content: [{ type: "text", text: details.tailOutput }],
								details: {
									phase: "running",
									elapsed: details.elapsed,
									truncation: details.truncation,
									fullOutputPath: details.fullOutputPath,
									runDirectory: details.runDirectory,
								},
							});
						},
					});
					if (contributionProof !== null) {
						const postExecutionProof = await captureContributionExecutionProof(
							ctx.cwd,
							resolvedCommand,
							effectiveTimeoutMs,
							operationSignal,
						);
						if (!sameContributionExecutionProof(contributionProof, postExecutionProof)) {
							throw new Error(
								"Contribution harness, invocation, HEAD, or worktree bytes changed during execution.",
							);
						}
					}
				} finally {
					runtime.runningExperiment = null;
					options.dashboard.updateWidget(ctx, runtime);
					options.dashboard.requestRender();
				}
				await mutation.authorizeMutation();

				const completedAt = Date.now();
				const durationMs = completedAt - startedAt;
				const durationSeconds = durationMs / 1000;
				runtime.lastRunDuration = durationSeconds;

				const llmTruncation = truncateTail(execution.output, {
					maxBytes: EXPERIMENT_MAX_BYTES,
					maxLines: EXPERIMENT_MAX_LINES,
				});
				const displayTruncation = truncateTail(execution.output, {
					maxBytes: DEFAULT_MAX_BYTES,
					maxLines: DEFAULT_MAX_LINES,
				});

				const parsedMetricsMap = parseMetricLines(execution.output);
				const parsedMetrics = parsedMetricsMap.size > 0 ? Object.fromEntries(parsedMetricsMap.entries()) : null;
				const parsedPrimary = parsedMetricsMap.get(session.primaryMetric) ?? null;
				const parsedAsi = parseAsiLines(execution.output);
				const storedParsedAsi =
					contributionProof === null
						? parsedAsi
						: {
								...(parsedAsi ?? {}),
								[CONTRIBUTION_HARNESS_SHA256_ASI_KEY]: contributionProof.harnessSha256,
								[CONTRIBUTION_WORKTREE_TREE_ASI_KEY]: contributionProof.worktreeTreeSha,
								[CONTRIBUTION_INVOCATION_SHA256_ASI_KEY]: contributionProof.invocationSha256,
								[CONTRIBUTION_HEAD_SHA_ASI_KEY]: contributionProof.headSha,
							};
				runtime.lastRunAsi = storedParsedAsi;

				storage.markRunCompleted({
					runId: insertedRun.id,
					completedAt,
					durationMs,
					exitCode: execution.exitCode,
					timedOut: execution.killed,
					parsedPrimary,
					parsedMetrics,
					parsedAsi: storedParsedAsi,
				});

				const passed = execution.exitCode === 0 && !execution.killed;
				const resultDetails: RunDetails = {
					runNumber: insertedRun.id,
					runDirectory,
					benchmarkLogPath,
					command: resolvedCommand,
					exitCode: execution.exitCode,
					durationSeconds,
					passed,
					crashed: execution.exitCode !== 0 || execution.killed,
					timedOut: execution.killed,
					tailOutput: displayTruncation.content,
					parsedMetrics,
					parsedPrimary,
					parsedAsi: storedParsedAsi,
					metricName: session.primaryMetric,
					metricUnit: session.metricUnit,
					preRunDirtyPaths,
					abandonedPriorRun,
					truncation: llmTruncation.truncated ? llmTruncation : undefined,
					fullOutputPath: execution.logPath,
				};

				runtime.lastRunSummary = {
					command: resolvedCommand,
					durationSeconds,
					parsedAsi: storedParsedAsi,
					parsedMetrics,
					parsedPrimary,
					passed,
					preRunDirtyPaths,
					runDirectory,
					runNumber: insertedRun.id,
					exitCode: execution.exitCode,
					timedOut: execution.killed,
				};
				runtime.autoResumeArmed = true;
				runtime.lastAutoResumePendingRunNumber = null;

				// Refresh state to reflect any prior abandonment changes (logged set unchanged).
				const refreshedSession = storage.getSessionById(session.id);
				if (refreshedSession) {
					runtime.state = buildExperimentState(refreshedSession, storage.listLoggedRuns(session.id));
				}
				options.dashboard.updateWidget(ctx, runtime);
				options.dashboard.requestRender();

				const headerLines: string[] = [];
				if (abandonedPriorRun !== null) {
					headerLines.push(`Note: abandoned prior pending run #${abandonedPriorRun} before starting this run.`);
				}
				const warningPrefix = headerLines.length > 0 ? `${headerLines.join("\n")}\n\n` : "";

				return {
					content: [
						{
							type: "text",
							text: warningPrefix + buildRunText(resultDetails, llmTruncation.content, runtime.state.bestMetric),
						},
					],
					details: resultDetails,
				};
			} finally {
				mutation.settle();
			}
		},
		renderCall(_args, _options, theme): Text {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("run_experiment"))} ${theme.fg("muted", DEFAULT_HARNESS_COMMAND)}`,
				0,
				0,
			);
		},
		renderResult(result, options, theme): Text {
			if (isProgressDetails(result.details)) {
				const header = theme.fg("warning", `Running ${result.details.elapsed}...`);
				const preview = replaceTabs(result.content.find(part => part.type === "text")?.text ?? "");
				return new Text(preview ? `${header}\n${theme.fg("dim", preview)}` : header, 0, 0);
			}
			const details = result.details;
			if (!details || !isRunDetails(details)) {
				return new Text(replaceTabs(result.content.find(part => part.type === "text")?.text ?? ""), 0, 0);
			}
			const statusText = renderStatus(details, theme);
			if (!options.expanded && details.tailOutput.trim().length === 0) {
				return new Text(statusText, 0, 0);
			}
			const preview = replaceTabs(
				options.expanded ? details.tailOutput : details.tailOutput.split("\n").slice(-5).join("\n"),
			);
			const suffix =
				options.expanded && details.truncation && details.fullOutputPath
					? `\n${theme.fg("warning", `Full output: ${shortenPath(details.fullOutputPath)}`)}`
					: "";
			return new Text(preview ? `${statusText}\n${theme.fg("dim", preview)}${suffix}` : statusText, 0, 0);
		},
	};
}
async function captureContributionExecutionProof(
	cwd: string,
	command: string,
	effectiveTimeoutMs: number,
	signal?: AbortSignal,
): Promise<ContributionExecutionProof> {
	const headSha = await git.head.sha(cwd, signal);
	if (headSha === null) throw new Error("Contribution execution requires an immutable HEAD commit.");
	const worktreePrefix = await git.show.prefix(cwd, signal);
	const worktreeProof = await git.writeWorktreeTreeWithAttestation(
		cwd,
		`${worktreePrefix}${HARNESS_FILENAME}`,
		CONTRIBUTION_HARNESS_MAX_BYTES,
		signal,
	);
	const invocation = JSON.stringify({ command, effectiveTimeoutMs });
	const invocationSha256 = new Bun.CryptoHasher("sha256").update(invocation).digest("hex");
	return {
		harnessSha256: worktreeProof.attestation.sha256,
		invocationSha256,
		worktreeTreeSha: worktreeProof.treeSha,
		headSha,
	};
}

function sameContributionExecutionProof(
	before: ContributionExecutionProof,
	after: ContributionExecutionProof,
): boolean {
	return (
		before.harnessSha256 === after.harnessSha256 &&
		before.invocationSha256 === after.invocationSha256 &&
		before.worktreeTreeSha === after.worktreeTreeSha &&
		before.headSha === after.headSha
	);
}

async function executeProcess(opts: {
	command: string;
	cwd: string;
	logPath: string;
	timeoutMs: number;
	signal?: AbortSignal;
	onProgress?(details: ProgressSnapshot): void;
}): Promise<ProcessExecutionResult> {
	const tailBuffer = new TailBuffer(DEFAULT_MAX_BYTES * 2);

	const startedAt = Date.now();
	const snapshot = (): ProgressSnapshot => {
		const tail = truncateTail(tailBuffer.text(), {
			maxBytes: DEFAULT_MAX_BYTES,
			maxLines: DEFAULT_MAX_LINES,
		});
		return {
			elapsed: formatElapsed(Date.now() - startedAt),
			runDirectory: path.dirname(opts.logPath),
			fullOutputPath: opts.logPath,
			tailOutput: tail.content,
			truncation: tail.truncated ? tail : undefined,
		};
	};

	const progressTimer = opts.onProgress
		? setInterval(() => {
				opts.onProgress?.(snapshot());
			}, 1000)
		: undefined;

	const logSink = Bun.file(opts.logPath).writer();
	let logSinkClosed = false;
	const closeLogSink = async (): Promise<void> => {
		if (logSinkClosed) return;
		logSinkClosed = true;
		await logSink.end();
	};
	try {
		const result = await executeBash(opts.command, {
			cwd: opts.cwd,
			sessionKey: `autoresearch:${opts.cwd}`,
			timeout: opts.timeoutMs,
			signal: opts.signal,
			chunkThrottleMs: 0,
			onChunk: chunk => {
				tailBuffer.append(chunk);
				logSink.write(chunk);
			},
		});
		await closeLogSink();
		throwIfAborted(opts.signal);

		const output = await fs.promises.readFile(opts.logPath, "utf8");

		return {
			exitCode: result.exitCode ?? null,
			killed: result.cancelled,
			logPath: opts.logPath,
			output,
		};
	} finally {
		if (progressTimer) clearInterval(progressTimer);
		if (!logSinkClosed) {
			try {
				await closeLogSink();
			} catch {
				// Preserve the command failure when cleanup is best-effort.
			}
		}
	}
}

function buildRunText(details: RunDetails, outputPreview: string, bestMetric: number | null): string {
	const lines: string[] = [];
	lines.push(`Run #${details.runNumber} directory: ${details.runDirectory}`);
	if (details.timedOut) {
		lines.push(`TIMEOUT after ${details.durationSeconds.toFixed(1)}s`);
	} else if (details.exitCode !== 0) {
		lines.push(`FAILED with exit code ${details.exitCode} in ${details.durationSeconds.toFixed(1)}s`);
	} else {
		lines.push(`PASSED in ${details.durationSeconds.toFixed(1)}s`);
	}
	if (bestMetric !== null) {
		lines.push(`Current baseline ${details.metricName}: ${formatNum(bestMetric, details.metricUnit)}`);
	}
	if (details.parsedPrimary !== null) {
		lines.push(`Parsed ${details.metricName}: ${details.parsedPrimary}`);
		lines.push(`Next log_experiment metric: ${details.parsedPrimary}`);
	}
	if (details.parsedMetrics) {
		const secondaryEntries = Object.entries(details.parsedMetrics)
			.filter(([name]) => name !== details.metricName)
			.map(([name, value]) => [name, value] as const);
		const secondary = secondaryEntries.map(([name, value]) => `${name}=${value}`);
		if (secondary.length > 0) {
			lines.push(`Parsed metrics: ${secondary.join(", ")}`);
			lines.push(`Next log_experiment metrics: ${JSON.stringify(Object.fromEntries(secondaryEntries))}`);
		}
	}
	if (details.parsedAsi) {
		lines.push(`Parsed ASI keys: ${Object.keys(details.parsedAsi).join(", ")}`);
	}
	lines.push("");
	lines.push(outputPreview);
	if (details.truncation && details.fullOutputPath) {
		lines.push("");
		lines.push(
			`Output truncated (${formatBytes(EXPERIMENT_MAX_BYTES)} limit). Full output: ${details.fullOutputPath}`,
		);
	}
	return lines.join("\n").trimEnd();
}

function renderStatus(details: RunDetails, theme: Theme): string {
	if (details.timedOut) {
		return theme.fg("error", `TIMEOUT ${details.durationSeconds.toFixed(1)}s`);
	}
	if (details.exitCode !== 0) {
		return theme.fg("error", `FAIL exit=${details.exitCode} ${details.durationSeconds.toFixed(1)}s`);
	}
	const metric =
		details.parsedPrimary !== null
			? ` ${details.metricName}=${formatNum(details.parsedPrimary, details.metricUnit)}`
			: "";
	return theme.fg("success", `PASS ${details.durationSeconds.toFixed(1)}s${metric}`);
}

function isRunDetails(value: unknown): value is RunDetails {
	if (typeof value !== "object" || value === null) return false;
	return "command" in value && "durationSeconds" in value;
}

function isProgressDetails(value: unknown): value is RunExperimentProgressDetails {
	if (typeof value !== "object" || value === null) return false;
	return "phase" in value && (value as { phase: unknown }).phase === "running";
}
