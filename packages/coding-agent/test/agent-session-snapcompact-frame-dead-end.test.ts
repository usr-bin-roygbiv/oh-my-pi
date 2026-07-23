import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { CompactionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getProjectAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import * as snapcompact from "@oh-my-pi/snapcompact";

/**
 * Regression test for the snapcompact frame dead-end.
 *
 * A branch whose LAST entry is a snapcompact CompactionEntry billed past the
 * maintenance threshold (FRAME_TOKEN_ESTIMATE × frames) dead-ends every pass:
 * prepareCompaction returns undefined (nothing after the entry to summarize),
 * and the elide/image rescue tiers only inspect "message"/"custom_message"
 * entries, so the `type: "compaction"` tail escapes both and the no-progress
 * warning re-fires on every resume — the shape issue #4786's rescue does not
 * cover.
 *
 * The fix rebuilds the trailing archive locally via snapcompact.compact() at
 * a threshold-derived frame budget (planArchive truncates the oldest chars),
 * persists it through appendCompaction (write-time elision drops the stale
 * frame payload), and skips the misleading no-progress warning.
 */
describe("AgentSession snapcompact frame dead-end rescue", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	const NOTICE_SOURCE = "compaction";
	const NO_PROGRESS_FRAGMENT = "Compaction freed too little context to make progress";
	const SEEDED_FRAME_COUNT = 16;

	function makeFrames(count: number): Record<string, unknown>[] {
		return Array.from({ length: count }, (_, i) => ({
			data: btoa(`stale-frame-${i}`),
			mimeType: "image/png",
			cols: 4,
			rows: 2,
			chars: 8,
		}));
	}

	function makeArchivePreserveData(frameCount: number): Record<string, unknown> {
		return {
			snapcompact: {
				frames: makeFrames(frameCount),
				text: `HEAD sentinel. ${"Archived history line. ".repeat(200)}TAIL sentinel.`,
				totalChars: 4600,
				truncatedChars: 0,
			},
		};
	}

	async function createSession(options: {
		frameCount: number;
		visionModel?: boolean;
		/** Seed no compaction entry; instead a hook supplies one carrying this
		 *  many frames — exercising the POST-PASS dead-end (a completed pass
		 *  whose just-written archive is itself the over-budget cost). */
		hookArchiveFrames?: number;
	}): Promise<void> {
		tempDir = TempDir.createSync("@pi-snapcompact-frame-dead-end-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());

		let extensionRunner: ExtensionRunner | undefined;
		if (options.hookArchiveFrames !== undefined) {
			// Short-circuit the summarization LLM call with a hook-supplied
			// compaction whose archive carries the oversized frame payload —
			// mirrors agent-session-auto-compaction-progress-guard.test.ts.
			const extensionsDir = path.join(getProjectAgentDir(tempDir.path()), "extensions");
			fs.mkdirSync(extensionsDir, { recursive: true });
			const extensionPath = path.join(extensionsDir, "compaction-short-circuit.ts");
			fs.writeFileSync(
				extensionPath,
				[
					"export default function(pi) {",
					'\tpi.on("session_before_compact", async (event) => {',
					"\t\treturn {",
					"\t\t\tcompaction: {",
					'\t\t\t\tsummary: "compacted",',
					"\t\t\t\tshortSummary: undefined,",
					"\t\t\t\tfirstKeptEntryId: event.preparation.firstKeptEntryId,",
					"\t\t\t\ttokensBefore: event.preparation.tokensBefore,",
					"\t\t\t\tdetails: {},",
					`\t\t\t\tpreserveData: ${JSON.stringify(makeArchivePreserveData(options.hookArchiveFrames))},`,
					"\t\t\t},",
					"\t\t};",
					"\t});",
					"}",
				].join("\n"),
			);
			const extensionsResult = await loadExtensions([extensionPath], tempDir.path());
			extensionRunner = new ExtensionRunner(
				extensionsResult.extensions,
				extensionsResult.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
		}

		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) {
			throw new Error("Expected built-in anthropic model to exist");
		}
		// Pin the window: threshold/band math below is tuned to 200k.
		const model = {
			...bundled,
			contextWindow: 200_000,
			maxTokens: 64_000,
			...(options.visionModel === false ? { input: ["text" as const] } : {}),
		};

		// Seed the poisoned shape: one user turn, then (unless the hook supplies
		// the archive) a trailing snapcompact CompactionEntry as the LAST branch
		// entry — the real prepareCompaction must hit its
		// last-entry-is-compaction guard organically.
		const userEntryId = sessionManager.appendMessage({
			role: "user",
			content: "hello",
			timestamp: Date.now(),
		});
		if (options.hookArchiveFrames === undefined) {
			sessionManager.appendCompaction(
				"Archived history onto stale snapcompact frames.",
				"stale snapcompact archive",
				userEntryId,
				150_000,
				{ readFiles: ["src/a.ts"], modifiedFiles: ["src/b.ts"] },
				false,
				makeArchivePreserveData(options.frameCount),
			);
		}

		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.autoContinue": true,
				"compaction.strategy": "snapcompact",
				// Fixed trigger so the rescue's threshold-derived frame budget is
				// deterministic: band 0.8 × 60k = 48k minus base/edge reserves
				// yields well under 16 frames — the rebuild must shrink.
				"compaction.thresholdTokens": 60_000,
			}),
			modelRegistry,
			extensionRunner,
		});
	}

	afterEach(async () => {
		try {
			await session?.dispose();
		} finally {
			authStorage?.close();
			await tempDir?.remove();
			vi.restoreAllMocks();
		}
	});

	function collectNotices() {
		const notices: { level: string; message: string; source?: string }[] = [];
		session.subscribe(event => {
			if (event.type === "notice") {
				notices.push({ level: event.level, message: event.message, source: event.source });
			}
		});
		return notices;
	}

	/** Threshold-tripping assistant turn against the 60k trigger. */
	function highUsageAssistant() {
		return {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "Done." }],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			stopReason: "stop" as const,
			usage: {
				input: 190000,
				output: 1000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 191000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
	}

	async function triggerMaintenance(): Promise<void> {
		const { promise: compactionDone, resolve: onCompactionDone } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") onCompactionDone();
		});
		const assistantMsg = highUsageAssistant();
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });
		await compactionDone;
		await session.waitForIdle();
	}

	it("rebuilds a stale trailing snapcompact archive and skips the no-progress warning", async () => {
		await createSession({ frameCount: SEEDED_FRAME_COUNT });
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined as never);
		vi.spyOn(session.agent, "continue").mockResolvedValue();
		vi.spyOn(session, "getContextUsage").mockReturnValue({ tokens: 190000, contextWindow: 200000, percent: 95 });
		const shakeSpy = vi
			.spyOn(session, "shake")
			.mockResolvedValue({ mode: "elide", toolResultsDropped: 0, blocksDropped: 0, tokensFreed: 0 });
		const compactSpy = vi.spyOn(snapcompact, "compact").mockResolvedValue({
			summary: "Rebuilt archive at a smaller frame budget.",
			shortSummary: "rebuilt snapcompact archive",
			firstKeptEntryId: (sessionManager.getBranch()[0] as { id: string }).id,
			tokensBefore: 150_000,
			details: { readFiles: ["src/a.ts"], modifiedFiles: ["src/b.ts"] },
			preserveData: makeArchivePreserveData(4),
		});

		const notices = collectNotices();
		await triggerMaintenance();

		expect(compactSpy).toHaveBeenCalledTimes(1);
		const [, compactOptions] = compactSpy.mock.calls[0] as [unknown, { maxFrames?: number }];
		expect(compactOptions.maxFrames).toBeDefined();
		expect(compactOptions.maxFrames as number).toBeLessThan(SEEDED_FRAME_COUNT);

		// The rebuilt entry supersedes the stale one; write-time elision must
		// have dropped the stale frame payload from the persisted branch.
		const compactions = sessionManager.getBranch().filter(e => e.type === "compaction") as CompactionEntry[];
		expect(compactions.length).toBe(2);
		const [stale, rebuilt] = compactions;
		expect(stale.summary).toContain("Superseded compaction summary elided");
		expect(stale.preserveData).toBeUndefined();
		const rebuiltArchive = snapcompact.getPreservedArchive(rebuilt.preserveData);
		expect(rebuiltArchive?.frames.length).toBe(4);

		// The frame rescue fired first: the elide/image tiers (provable no-ops
		// on a compaction tail) were skipped, and no misleading warning.
		expect(shakeSpy).not.toHaveBeenCalled();
		const noProgress = notices.filter(n => n.source === NOTICE_SOURCE && n.message.includes(NO_PROGRESS_FRAGMENT));
		expect(noProgress.length).toBe(0);
		const recovery = notices.filter(n => n.source === NOTICE_SOURCE && n.message.includes("dead-end recovery"));
		expect(recovery.length).toBe(1);
		expect(recovery[0].level).toBe("info");
	});

	it("rebuilds the just-written archive when a completed pass dead-ends on its own frames", async () => {
		// POST-PASS shape (observed live on 17.0.8): compaction ran and wrote a
		// frame archive, but the archive itself is the over-budget cost — each
		// pass re-renders the carried-forward text into MORE frames. The
		// elide/image tiers can't shrink it; tier 0 of the dead-end rescue must.
		await createSession({ frameCount: 0, hookArchiveFrames: SEEDED_FRAME_COUNT });
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined as never);
		vi.spyOn(session.agent, "continue").mockResolvedValue();
		let rebuiltArchiveApplied = false;
		vi.spyOn(session, "getContextUsage").mockImplementation(() =>
			rebuiltArchiveApplied
				? { tokens: 30000, contextWindow: 200000, percent: 15 }
				: { tokens: 190000, contextWindow: 200000, percent: 95 },
		);
		const shakeSpy = vi
			.spyOn(session, "shake")
			.mockResolvedValue({ mode: "elide", toolResultsDropped: 0, blocksDropped: 0, tokensFreed: 0 });
		const compactSpy = vi.spyOn(snapcompact, "compact").mockImplementation(async () => {
			rebuiltArchiveApplied = true;
			return {
				summary: "Rebuilt archive at a smaller frame budget.",
				shortSummary: "rebuilt snapcompact archive",
				firstKeptEntryId: (sessionManager.getBranch()[0] as { id: string }).id,
				tokensBefore: 150_000,
				details: { readFiles: [], modifiedFiles: [] },
				preserveData: makeArchivePreserveData(4),
			};
		});

		const notices = collectNotices();
		await triggerMaintenance();

		expect(compactSpy).toHaveBeenCalledTimes(1);
		const compactions = sessionManager.getBranch().filter(e => e.type === "compaction") as CompactionEntry[];
		expect(compactions.length).toBe(2);
		const [hookWritten, rebuilt] = compactions;
		expect(hookWritten.summary).toContain("Superseded compaction summary elided");
		expect(hookWritten.preserveData).toBeUndefined();
		expect(snapcompact.getPreservedArchive(rebuilt.preserveData)?.frames.length).toBe(4);
		expect(shakeSpy).not.toHaveBeenCalled();
		const noProgress = notices.filter(n => n.source === NOTICE_SOURCE && n.message.includes(NO_PROGRESS_FRAGMENT));
		expect(noProgress.length).toBe(0);
		const recovery = notices.filter(n => n.source === NOTICE_SOURCE && n.message.includes("dead-end recovery"));
		expect(recovery.length).toBe(1);
	});

	it("still warns once when the trailing archive is already at the minimum frame count", async () => {
		await createSession({ frameCount: 1 });
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined as never);
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();
		vi.spyOn(session, "getContextUsage").mockReturnValue({ tokens: 190000, contextWindow: 200000, percent: 95 });
		vi.spyOn(session, "shake").mockResolvedValue({
			mode: "elide",
			toolResultsDropped: 0,
			blocksDropped: 0,
			tokensFreed: 0,
		});
		const compactSpy = vi.spyOn(snapcompact, "compact");

		const notices = collectNotices();
		await triggerMaintenance();

		expect(compactSpy).not.toHaveBeenCalled();
		expect(promptSpy).not.toHaveBeenCalled();
		expect(continueSpy).not.toHaveBeenCalled();
		const noProgress = notices.filter(n => n.source === NOTICE_SOURCE && n.message.includes(NO_PROGRESS_FRAGMENT));
		expect(noProgress.length).toBe(1);
		expect(noProgress[0].level).toBe("warning");
	});

	it("skips the frame rescue when the active model is not vision-capable", async () => {
		await createSession({ frameCount: SEEDED_FRAME_COUNT, visionModel: false });
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined as never);
		vi.spyOn(session.agent, "continue").mockResolvedValue();
		vi.spyOn(session, "getContextUsage").mockReturnValue({ tokens: 190000, contextWindow: 200000, percent: 95 });
		const shakeSpy = vi
			.spyOn(session, "shake")
			.mockResolvedValue({ mode: "elide", toolResultsDropped: 0, blocksDropped: 0, tokensFreed: 0 });
		const compactSpy = vi.spyOn(snapcompact, "compact");

		const notices = collectNotices();
		await triggerMaintenance();

		// Text-only model: no frame re-render; existing tiers still run and the
		// existing dead-end warning is preserved.
		expect(compactSpy).not.toHaveBeenCalled();
		expect(shakeSpy).toHaveBeenCalledWith("elide", expect.anything());
		const noProgress = notices.filter(n => n.source === NOTICE_SOURCE && n.message.includes(NO_PROGRESS_FRAGMENT));
		expect(noProgress.length).toBe(1);
	});
});
