import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent, type AgentMessage, type StreamFn } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, Context, Message, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { Rule } from "@oh-my-pi/pi-coding-agent/capability/rule";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TtsrManager } from "@oh-my-pi/pi-coding-agent/export/ttsr";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getProjectAgentDir, TempDir, withTimeout } from "@oh-my-pi/pi-utils";

const runtimeSignalStoreKey = "__ompRuntimeSignals";

type MockStreamHandler = (context: Context, options?: SimpleStreamOptions) => MockResponse | Promise<MockResponse>;

function captureMockContexts(contexts: Context[], handler: MockStreamHandler): StreamFn {
	const mock = createMockModel({
		handler: (context, options) => {
			contexts.push(context);
			return handler(context, options);
		},
	});
	return (model, context, options) => mock.stream(model, context, options);
}

function textParts(messages: readonly AgentMessage[]): string[] {
	return messages.flatMap(message => {
		const content = "content" in message ? message.content : undefined;
		if (typeof content === "string") return [content];
		if (!Array.isArray(content)) return [];
		return content.flatMap(part => (part.type === "text" ? [part.text] : []));
	});
}

function makeAssistantMessage(text: string, stopReason: "stop" | "aborted"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "mock",
		provider: "ttsr-regression",
		model: "ttsr-discard-retry-model",
		usage: {
			input: 100,
			output: 100,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 200,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

type RuntimeSignalGlobal = typeof globalThis & { [runtimeSignalStoreKey]?: string[] };

function getRuntimeSignals(): string[] {
	const globalWithSignals = globalThis as RuntimeSignalGlobal;
	if (!globalWithSignals[runtimeSignalStoreKey]) {
		globalWithSignals[runtimeSignalStoreKey] = [];
	}
	return globalWithSignals[runtimeSignalStoreKey];
}

/**
 * Regression test: auto-compaction completion should resume the agent loop when
 * there are queued agent-level messages (follow-up/steering/custom).
 */
describe("AgentSession auto-compaction queue resume", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let ttsrManager: TtsrManager;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-auto-compaction-queue-");
		vi.useFakeTimers();

		// Provide an extension that short-circuits compaction so the test doesn't
		// make any LLM calls.
		const extensionsDir = path.join(getProjectAgentDir(tempDir.path()), "extensions");
		fs.mkdirSync(extensionsDir, { recursive: true });
		const extensionPath = path.join(extensionsDir, "compaction-short-circuit.ts");
		fs.writeFileSync(
			extensionPath,
			[
				"export default function(pi) {",
				'	pi.on("session_before_compact", async (event) => {',
				"		const summaryInputs = [event.preparation.messagesToSummarize, event.preparation.turnPrefixMessages].flat().map((message) => {",
				'			const content = message && typeof message === "object" && "content" in message ? message.content : undefined;',
				'			if (typeof content === "string") return content;',
				'			if (Array.isArray(content)) return content.map((part) => part && part.type === "text" ? part.text : "").join("\\n");',
				'			return "";',
				"		}).filter(Boolean);",
				"		return {",
				"			compaction: {",
				'				summary: summaryInputs.join("\\n") || "compacted",',
				"				shortSummary: undefined,",
				"				firstKeptEntryId: event.preparation.firstKeptEntryId,",
				"				tokensBefore: event.preparation.tokensBefore,",
				"				details: {},",
				"			},",
				"		};",
				"\t});",
				'\tpi.on("auto_compaction_start", async (event) => {',
				`\t\tconst signals = globalThis.${runtimeSignalStoreKey} ?? (globalThis.${runtimeSignalStoreKey} = []);`,
				'\t\tsignals.push("compaction:start:" + event.reason);',
				"\t});",
				'\tpi.on("auto_compaction_end", async (event) => {',
				`\t\tconst signals = globalThis.${runtimeSignalStoreKey} ?? (globalThis.${runtimeSignalStoreKey} = []);`,
				'\t\tsignals.push("compaction:end:" + (event.aborted ? "aborted" : "ok"));',
				"\t});",
				'\tpi.on("todo_reminder", async (event) => {',
				`\t\tconst signals = globalThis.${runtimeSignalStoreKey} ?? (globalThis.${runtimeSignalStoreKey} = []);`,
				'\t\tsignals.push("todo:" + event.attempt + "/" + event.maxAttempts);',
				"\t});",
				"}",
			].join("\n"),
		);

		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		getRuntimeSignals().length = 0;
		ttsrManager = new TtsrManager({
			enabled: true,
			contextMode: "discard",
			interruptMode: "always",
			repeatMode: "once",
			repeatGap: 10,
		});

		const extensionsResult = await loadExtensions([extensionPath], tempDir.path());
		const extensionRunner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			tempDir.path(),
			sessionManager,
			modelRegistry,
		);

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected built-in anthropic model to exist");
		}

		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const convertToLlm = (messages: AgentMessage[]): Message[] =>
			messages.flatMap(message => {
				if (message.role === "user" || message.role === "assistant" || message.role === "toolResult") {
					return [message];
				}
				if (message.role === "custom" && message.customType === "ttsr-injection") {
					return [
						{
							role: "user",
							content: message.content,
							attribution: message.attribution,
							timestamp: message.timestamp,
						},
					];
				}
				return [];
			});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: mock.stream,
			convertToLlm,
		});

		// Seed a minimal session branch so prepareCompaction() returns a preparation.
		sessionManager.appendMessage({
			role: "user",
			content: "hello",
			timestamp: Date.now(),
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.autoContinue": false,
				"todo.reminders": true,
				"todo.reminders.max": 3,
			}),
			modelRegistry,
			extensionRunner,
			ttsrManager,
		});
	});

	afterEach(async () => {
		await session.dispose();
		authStorage.close();
		tempDir.removeSync();
		vi.useRealTimers();
		getRuntimeSignals().length = 0;
		vi.restoreAllMocks();
	});

	it("resumes after threshold compaction when only agent-level queued messages exist", async () => {
		session.agent.followUp({
			role: "custom",
			customType: "test",
			content: [{ type: "text", text: "Queued custom" }],
			display: false,
			timestamp: Date.now(),
		});

		expect(session.agent.hasQueuedMessages()).toBe(true);

		const continueSpy = vi.spyOn(session.agent, "continue").mockImplementation(async () => {
			// Real continue() polls and consumes the queued steering/follow-up
			// messages. Mirror that here so the stranded-queue drain settles after
			// one resume instead of rescheduling itself forever (a no-op mock
			// leaves the queue populated, spinning the drain into an OOM loop).
			session.agent.clearAllQueues();
		});

		// Wait for auto_compaction_end event to know when the async handler is done
		const { promise: compactionDone, resolve: onCompactionDone } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") onCompactionDone();
		});

		// Build a fake AssistantMessage with high token usage to trigger threshold
		// compaction (contextWindow=200000, threshold ~80%).
		const assistantMsg = {
			role: "assistant" as const,
			// Non-empty content: an empty `stop` turn would trip the empty-stop guard
			// (#handleEmptyAssistantStop) and short-circuit the agent_end handler before
			// compaction/todo checks run — hanging this test forever under fake timers.
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

		// Drive auto-compaction through the event flow:
		// message_end → stores #lastAssistantMessage
		// agent_end   → #checkCompaction → shouldCompact → #runAutoCompaction
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });

		// Wait for compaction completion, then verify waitForIdle blocks on queued continuation.
		await compactionDone;
		await Promise.resolve();
		const idlePromise = session.waitForIdle();
		let idleResolved = false;
		void idlePromise.then(() => {
			idleResolved = true;
		});
		await Promise.resolve();
		expect(idleResolved).toBe(false);
		vi.advanceTimersByTime(200);
		await idlePromise;

		expect(continueSpy).toHaveBeenCalledTimes(1);
		const runtimeSignals = getRuntimeSignals();
		expect(runtimeSignals).toContain("compaction:start:threshold");
		expect(runtimeSignals.some(signal => signal.startsWith("compaction:end:"))).toBe(true);
	});

	it("has isCompacting true when the auto_compaction_start event fires", async () => {
		// Defect 1: the compaction AbortController (which backs isCompacting) must be
		// installed before auto_compaction_start is emitted. If it is installed after,
		// a message typed the instant the loader appears is read while
		// isCompacting === false and mis-routed into the core steering queue (which a
		// later handoff reset would wipe) instead of the safe UI compaction queue.
		let capturedIsCompacting: boolean | undefined;
		const { promise: compactionDone, resolve: onCompactionDone } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_compaction_start") {
				capturedIsCompacting = session.isCompacting;
			} else if (event.type === "auto_compaction_end") {
				onCompactionDone();
			}
		});

		// Defensive: mirror the resume-drain stub so any queued continuation settles
		// instead of spinning the drain (see the threshold test above).
		vi.spyOn(session.agent, "continue").mockImplementation(async () => {
			session.agent.clearAllQueues();
		});

		const assistantMsg = {
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

		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });

		await compactionDone;

		expect(capturedIsCompacting).toBe(true);
	});

	it("forwards todo reminder lifecycle signals to extensions", async () => {
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();

		session.setTodoPhases([
			{
				name: "Execution",
				tasks: [{ content: "Finish pending task", status: "in_progress" }],
			},
		]);

		const { promise: reminderDone, resolve: onReminderDone } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "todo_reminder") onReminderDone();
		});

		const assistantMsg = {
			role: "assistant" as const,
			// Non-empty content: see comment on the first test's assistantMsg.
			content: [{ type: "text" as const, text: "Done." }],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			stopReason: "stop" as const,
			usage: {
				input: 100,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 120,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};

		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });

		await withTimeout(reminderDone, 1000, "Todo reminder timed out");
		for (let i = 0; i < 20; i++) {
			await Promise.resolve();
		}

		expect(getRuntimeSignals()).toContain("todo:1/3");
		expect(continueSpy).toHaveBeenCalledTimes(1);
		await session.waitForIdle();
	});

	it("triggers pre-prompt compaction before intermediate agent.continue execution", async () => {
		const continueSpy = vi.spyOn(session.agent, "continue").mockImplementation(async () => {
			session.agent.clearAllQueues();
		});

		session.settings.override("compaction.thresholdTokens", 20);
		session.settings.override("compaction.enabled", true);

		const userMsg = { role: "user" as const, content: "hello", timestamp: Date.now() };
		const assistantMsg = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "Done." }],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			stopReason: "stop" as const,
			usage: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 15,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
		session.agent.replaceMessages([userMsg, assistantMsg]);

		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });

		await session.followUp("a ".repeat(50));

		for (let i = 0; i < 20; i++) {
			await Promise.resolve();
		}
		vi.advanceTimersByTime(200);
		for (let i = 0; i < 20; i++) {
			await Promise.resolve();
		}

		await session.waitForIdle();

		const signals = getRuntimeSignals();
		expect(signals).toContain("compaction:start:threshold");
		expect(continueSpy).toHaveBeenCalledTimes(1);
	});

	it("includes the queued follow-up payload in pre-continue compaction estimates", async () => {
		const userMsg = { role: "user" as const, content: "hello", timestamp: Date.now() - 2 };
		const assistantMsg = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "Done." }],
			usage: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 15,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop" as const,
			timestamp: Date.now() - 1,
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
		};
		sessionManager.appendMessage(assistantMsg);
		session.agent.replaceMessages([userMsg, assistantMsg]);

		const contextWindow = session.model?.contextWindow ?? 200_000;
		const baseline = session.getContextBreakdown({ contextWindow, pendingMessages: [] })?.usedTokens ?? 0;
		session.settings.override("compaction.thresholdTokens", baseline + 10);
		session.settings.override("compaction.enabled", true);
		session.settings.override("contextPromotion.enabled", false);

		const { promise: compactionDone, resolve: onCompactionDone } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") onCompactionDone();
		});
		const continueSpy = vi.spyOn(session.agent, "continue").mockImplementation(async () => {
			session.agent.clearAllQueues();
		});

		await session.followUp("queued follow-up ".repeat(500));
		await withTimeout(compactionDone, 1000, "Queued follow-up compaction timed out");
		await session.waitForIdle();

		expect(getRuntimeSignals()).toContain("compaction:start:threshold");
		expect(continueSpy).toHaveBeenCalledTimes(1);
	});

	it("preserves queued follow-up through pre-continue handoff and resumes it", async () => {
		vi.useRealTimers();
		const generateHandoffSpy = vi.spyOn(compactionModule, "generateHandoff").mockResolvedValue("## Goal\nContinue");
		const userMsg = { role: "user" as const, content: "hello", timestamp: Date.now() - 2 };
		const assistantMsg = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "Done." }],
			usage: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 15,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop" as const,
			timestamp: Date.now() - 1,
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
		};
		sessionManager.appendMessage(assistantMsg);
		session.agent.replaceMessages([userMsg, assistantMsg]);

		const contextWindow = session.model?.contextWindow ?? 200_000;
		const baseline = session.getContextBreakdown({ contextWindow, pendingMessages: [] })?.usedTokens ?? 0;
		session.settings.override("compaction.strategy", "handoff");
		session.settings.override("compaction.thresholdTokens", baseline + 10);
		session.settings.override("compaction.enabled", true);
		session.settings.override("contextPromotion.enabled", false);
		const queuedText = "queued follow-up sentinel ".repeat(500);

		const compactionDone = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") compactionDone.resolve();
		});
		const postHandoffCalls: Context[] = [];
		const continued = Promise.withResolvers<void>();
		const mock = createMockModel({
			handler: context => {
				postHandoffCalls.push(context);
				continued.resolve();
				return { content: ["follow-up consumed"] };
			},
		});
		session.agent.streamFn = mock.stream;

		await session.followUp(queuedText);
		await withTimeout(compactionDone.promise, 1000, "Pre-continue handoff did not finish");
		await withTimeout(continued.promise, 1000, "Queued handoff follow-up was not resumed");
		await session.waitForIdle();

		expect(generateHandoffSpy).toHaveBeenCalledTimes(1);
		expect(postHandoffCalls).toHaveLength(1);
		const finalMessage = postHandoffCalls[0]?.messages.at(-1);
		expect(finalMessage?.role).toBe("user");
		expect(JSON.stringify(finalMessage)).toContain("queued follow-up sentinel");
		expect(session.agent.hasQueuedMessages()).toBe(false);
	});

	it("delivers one queued follow-up after handoff without draining the next one", async () => {
		vi.useRealTimers();
		vi.spyOn(compactionModule, "generateHandoff").mockResolvedValue("## Goal\nContinue");
		const userMsg = { role: "user" as const, content: "hello", timestamp: Date.now() - 2 };
		const assistantMsg = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "Done." }],
			usage: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 15,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop" as const,
			timestamp: Date.now() - 1,
			api: "anthropic-messages" as const,
			provider: "anthropic",
			model: "claude-sonnet-4-5",
		};
		sessionManager.appendMessage(assistantMsg);
		session.agent.replaceMessages([userMsg, assistantMsg]);
		session.settings.override("compaction.strategy", "handoff");
		session.settings.override("compaction.thresholdTokens", 1);
		session.settings.override("compaction.enabled", true);
		session.settings.override("contextPromotion.enabled", false);
		session.agent.setFollowUpMode("one-at-a-time");

		const contexts: Context[] = [];
		const delivered = Promise.withResolvers<void>();
		session.agent.streamFn = captureMockContexts(contexts, () => {
			delivered.resolve();
			return { content: ["follow-up consumed"] };
		});

		await session.followUp("first queued follow-up");
		await session.followUp("second queued follow-up");

		await withTimeout(delivered.promise, 1000, "Queued follow-up was not delivered");

		expect(contexts).not.toHaveLength(0);
		expect(textParts(contexts[0]?.messages ?? [])).toContain("first queued follow-up");
		expect(textParts(contexts[0]?.messages ?? [])).not.toContain("second queued follow-up");

		await session.waitForIdle();
	});

	it("preserves transient messages during pre-prompt compaction", async () => {
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue();

		session.settings.override("compaction.thresholdTokens", 5);
		session.settings.override("compaction.enabled", true);

		const userMsg = { role: "user" as const, content: "hello", timestamp: Date.now() };
		const assistantMsg = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "a ".repeat(50) }],
			usage: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 15,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop" as const,
			timestamp: Date.now(),
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
		};

		sessionManager.appendMessage(assistantMsg);

		const transientMsg = {
			role: "developer" as const,
			content: [{ type: "text" as const, text: "Transient reminder" }],
			attribution: "agent" as const,
			timestamp: Date.now(),
		};
		session.agent.replaceMessages([userMsg, assistantMsg, transientMsg]);

		await session.prompt("Next turn");

		const signals = getRuntimeSignals();
		expect(signals).toContain("compaction:start:threshold");

		const finalMessages = session.agent.state.messages;
		const transientIndex = finalMessages.findIndex(
			m => m.role === "developer" && (m as any).content[0]?.text === "Transient reminder",
		);
		expect(transientIndex).toBeGreaterThan(-1);
		expect(finalMessages[finalMessages.length - 1].role).toBe("developer");
		expect((finalMessages[finalMessages.length - 1] as any).content[0]?.text).toBe("Transient reminder");
		expect(promptSpy).toHaveBeenCalledTimes(1);
	});

	it("does not restore failed assistant during retry pre-continue compaction", async () => {
		vi.useRealTimers();
		const userMsg = { role: "user" as const, content: "hello", timestamp: Date.now() - 2 };
		const failedAssistantMsg = {
			role: "assistant" as const,
			content: [],
			usage: {
				input: 100,
				output: 100,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 200,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error" as const,
			errorMessage: "503 service unavailable",
			timestamp: Date.now() - 1,
			api: "mock" as const,
			provider: "retry-regression",
			model: "retry-regression-model",
		};
		sessionManager.appendMessage(userMsg);
		sessionManager.appendMessage(failedAssistantMsg);
		session.agent.replaceMessages([userMsg, failedAssistantMsg]);
		session.settings.override("compaction.thresholdTokens", 1);
		session.settings.override("compaction.enabled", true);
		session.settings.override("compaction.keepRecentTokens", 1);
		session.settings.override("contextPromotion.enabled", false);
		session.settings.override("retry.baseDelayMs", 0);

		const contexts: Context[] = [];
		const retryContinued = Promise.withResolvers<void>();
		const mock = createMockModel({
			id: "retry-regression-model",
			provider: "retry-regression",
			handler: context => {
				contexts.push(context);
				retryContinued.resolve();
				return { content: ["retry ok"] };
			},
		});
		session.agent.streamFn = mock.stream;
		session.agent.setModel(mock);

		expect(await session.retry()).toBe(true);

		await withTimeout(retryContinued.promise, 1000, "Retry continuation did not run");
		await session.waitForIdle();

		expect(getRuntimeSignals()).toContain("compaction:start:threshold");
		expect(contexts).toHaveLength(1);
		expect(
			contexts[0]?.messages.some(message => message.role === "assistant" && message.stopReason === "error"),
		).toBe(false);
		expect(
			session.agent.state.messages.some(message => message.role === "assistant" && message.stopReason === "error"),
		).toBe(false);
	});

	it("uses context-full retry compaction instead of handoff during pre-continue retry", async () => {
		vi.useRealTimers();
		const generateHandoffSpy = vi.spyOn(compactionModule, "generateHandoff").mockResolvedValue("## Goal\nwrong path");
		const userMsg = { role: "user" as const, content: "hello", timestamp: Date.now() - 2 };
		const failedAssistantMsg = {
			role: "assistant" as const,
			content: [],
			usage: {
				input: 100,
				output: 100,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 200,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error" as const,
			errorMessage: "503 service unavailable",
			timestamp: Date.now() - 1,
			api: "mock" as const,
			provider: "retry-regression",
			model: "retry-regression-model",
		};
		sessionManager.appendMessage(userMsg);
		sessionManager.appendMessage(failedAssistantMsg);
		session.agent.replaceMessages([userMsg, failedAssistantMsg]);
		session.settings.override("compaction.strategy", "handoff");
		session.settings.override("compaction.thresholdTokens", 1);
		session.settings.override("compaction.enabled", true);
		session.settings.override("compaction.keepRecentTokens", 1);
		session.settings.override("contextPromotion.enabled", false);

		const retryContinued = Promise.withResolvers<void>();
		const mock = createMockModel({
			id: "retry-regression-model",
			provider: "retry-regression",
			handler: () => {
				retryContinued.resolve();
				return { content: ["retry ok"] };
			},
		});
		session.agent.streamFn = mock.stream;
		session.agent.setModel(mock);

		expect(await session.retry()).toBe(true);

		await withTimeout(retryContinued.promise, 1000, "Retry continuation did not run");
		await session.waitForIdle();

		expect(generateHandoffSpy).not.toHaveBeenCalled();
		expect(getRuntimeSignals()).toContain("compaction:start:threshold");
	});

	it("does not rerun pre-prompt compaction after shake retry recovery", async () => {
		vi.useRealTimers();
		const userMsg = { role: "user" as const, content: `hello ${"x ".repeat(4000)}`, timestamp: Date.now() - 2 };
		const failedAssistantMsg = {
			role: "assistant" as const,
			content: [],
			usage: {
				input: 100,
				output: 100,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 200,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error" as const,
			errorMessage: "503 service unavailable",
			timestamp: Date.now() - 1,
			api: "mock" as const,
			provider: "retry-regression",
			model: "retry-regression-model",
		};
		sessionManager.appendMessage(userMsg);
		sessionManager.appendMessage(failedAssistantMsg);
		session.agent.replaceMessages([userMsg, failedAssistantMsg]);
		session.settings.override("compaction.strategy", "shake");
		session.settings.override("compaction.thresholdTokens", 1);
		session.settings.override("compaction.enabled", true);
		session.settings.override("contextPromotion.enabled", false);

		const shakeSpy = vi.spyOn(session, "shake").mockResolvedValue({
			mode: "elide",
			toolResultsDropped: 0,
			blocksDropped: 1,
			tokensFreed: 10_000,
		});
		const retryContinued = Promise.withResolvers<void>();
		const mock = createMockModel({
			id: "retry-regression-model",
			provider: "retry-regression",
			handler: () => {
				retryContinued.resolve();
				return { content: ["retry ok"] };
			},
		});
		session.agent.streamFn = mock.stream;
		session.agent.setModel(mock);

		expect(await session.retry()).toBe(true);

		await withTimeout(retryContinued.promise, 1000, "Retry continuation did not run");
		await session.waitForIdle();

		expect(shakeSpy).toHaveBeenCalledTimes(1);
	});

	it("keeps TTSR discard retry on context-full compaction with the injection", async () => {
		vi.useRealTimers();
		const generateHandoffSpy = vi.spyOn(compactionModule, "generateHandoff").mockResolvedValue("## Goal\nwrong path");
		const ttsrRule: Rule = {
			name: "no-unwrap",
			path: path.join(tempDir.path(), "no-unwrap.md"),
			content: "Do not call unwrap.",
			condition: ["\\.unwrap\\("],
			_source: {
				provider: "test",
				providerName: "test",
				path: path.join(tempDir.path(), "no-unwrap.md"),
				level: "project",
			},
		};
		ttsrManager.addRule(ttsrRule);
		session.settings.override("compaction.strategy", "handoff");
		session.settings.override("compaction.thresholdTokens", 199_999);
		session.settings.override("compaction.enabled", false);
		session.settings.override("compaction.keepRecentTokens", 1);
		session.settings.override("contextPromotion.enabled", false);

		const contexts: Context[] = [];
		let streamCallCount = 0;
		const retryContinued = Promise.withResolvers<void>();
		authStorage.setRuntimeApiKey("ttsr-regression", "test-key");
		const mock = createMockModel({ id: "ttsr-discard-retry-model", provider: "ttsr-regression" });
		const ttsrStreamFn: StreamFn = (_model, context, options) => {
			contexts.push(context);
			streamCallCount++;
			const stream = new AssistantMessageEventStream();
			if (streamCallCount === 1) {
				session.settings.override("compaction.thresholdTokens", 1);
				session.settings.override("compaction.enabled", true);
				queueMicrotask(() => {
					const partial = makeAssistantMessage("", "stop");
					stream.push({ type: "start", partial });
					stream.push({
						type: "text_delta",
						contentIndex: 0,
						delta: "let value = result.unwrap(",
						partial: makeAssistantMessage("let value = result.unwrap(", "stop"),
					});
					options?.signal?.addEventListener(
						"abort",
						() => {
							stream.push({
								type: "error",
								reason: "aborted",
								error: makeAssistantMessage("let value = result.unwrap(", "aborted"),
							});
						},
						{ once: true },
					);
				});
				return stream;
			}
			session.settings.override("compaction.enabled", false);
			queueMicrotask(() => {
				retryContinued.resolve();
				const message = makeAssistantMessage("retry ok", "stop");
				stream.push({ type: "start", partial: makeAssistantMessage("", "stop") });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};
		session.agent.streamFn = ttsrStreamFn;
		session.agent.setModel(mock);

		await session.prompt("Write Rust code");
		await withTimeout(retryContinued.promise, 1000, "TTSR retry continuation did not run");
		await session.waitForIdle();

		expect(generateHandoffSpy).not.toHaveBeenCalled();
		expect(getRuntimeSignals()).toContain("compaction:start:threshold");
		expect(contexts).toHaveLength(2);
		const retryText = textParts(contexts[1]?.messages ?? []).join("\n");
		expect(retryText).toContain("Do not call unwrap.");
		expect(retryText).not.toContain("let value = result.unwrap(");
	});

	it("delivers one queued steer after handoff without draining the next one", async () => {
		vi.useRealTimers();
		vi.spyOn(compactionModule, "generateHandoff").mockResolvedValue("## Goal\nContinue");
		const userMsg = { role: "user" as const, content: "hello", timestamp: Date.now() - 2 };
		const assistantMsg = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "Done." }],
			usage: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 15,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop" as const,
			timestamp: Date.now() - 1,
			api: "anthropic-messages" as const,
			provider: "anthropic",
			model: "claude-sonnet-4-5",
		};
		sessionManager.appendMessage(assistantMsg);
		session.agent.replaceMessages([userMsg, assistantMsg]);
		session.settings.override("compaction.strategy", "handoff");
		session.settings.override("compaction.thresholdTokens", 1);
		session.settings.override("compaction.enabled", true);
		session.settings.override("contextPromotion.enabled", false);
		session.agent.setSteeringMode("one-at-a-time");

		const contexts: Context[] = [];
		const delivered = Promise.withResolvers<void>();
		session.agent.streamFn = captureMockContexts(contexts, () => {
			delivered.resolve();
			return { content: ["steer consumed"] };
		});

		await session.steer("first queued steer");
		await session.steer("second queued steer");
		await session.followUp("queued follow-up after steers");

		await withTimeout(delivered.promise, 1000, "Queued steering was not delivered");
		await session.waitForIdle();

		expect(contexts).toHaveLength(1);
		expect(textParts(contexts[0]?.messages ?? [])).toContain("first queued steer");
		expect(textParts(contexts[0]?.messages ?? [])).not.toContain("second queued steer");
		expect(textParts(contexts[0]?.messages ?? [])).not.toContain("queued follow-up after steers");
		expect(textParts([...session.agent.peekSteeringQueue()])).toContain("second queued steer");
		expect(textParts([...session.agent.peekFollowUpQueue()])).toContain("queued follow-up after steers");
		session.agent.streamFn = captureMockContexts(contexts, () => ({ content: ["unexpected extra drain"] }));
		await Promise.resolve();
		await session.waitForIdle();

		expect(contexts).toHaveLength(1);
	});
});
