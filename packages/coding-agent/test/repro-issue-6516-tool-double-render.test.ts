import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { buildSessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * Regression for issue #6516 — a tool call renders twice in the transcript.
 *
 * `rebuildChatFromMessages` (fired mid-stream by /shake, auto-compaction, and
 * settings toggles) preserves the live `pendingTools` components across a
 * clear+replay so streaming keeps routing into them. That preservation assumes
 * every pending-tool component is still *dangling* — its result lives outside
 * `state.messages`. Once a tool's result has landed in the session entries while
 * its component still lingers in `pendingTools` (a rebuild racing the
 * tool-completion event, or a background/displaceable snapshot), the replay
 * reconstructs the completed block from the persisted `toolResult` AND the
 * preserved live component is re-appended — the same tool call renders twice.
 */
const CMD = "mvn -q -pl module -Dmaven.gitcommitid.skip=true -DskipTests clean compile";
const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function countCommand(mode: InteractiveMode): number {
	const rendered = Bun.stripANSI(mode.chatContainer.render(120).join("\n"));
	let count = 0;
	let index = 0;
	while (true) {
		const found = rendered.indexOf(CMD, index);
		if (found === -1) return count;
		count++;
		index = found + CMD.length;
	}
}

describe("issue #6516 — tool output appears twice", () => {
	let authStorage: AuthStorage;
	let mode: InteractiveMode;
	let session: AgentSession;
	let tempDir: TempDir;
	const created: ToolExecutionComponent[] = [];

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "setEncoding").mockReturnValue(process.stdin);
		if (typeof process.stdin.setRawMode === "function") {
			vi.spyOn(process.stdin, "setRawMode").mockReturnValue(process.stdin);
		}

		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-issue-6516-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 test model");

		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
		mode.ui.requestRender = vi.fn();
	});

	afterEach(async () => {
		for (const component of created.splice(0)) component.stopAnimation();
		mode?.stop();
		vi.restoreAllMocks();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	function addLiveBash(): ToolExecutionComponent {
		const component = new ToolExecutionComponent(
			"bash",
			{ command: CMD },
			{},
			undefined,
			mode.ui,
			tempDir.path(),
			"call-1",
		);
		created.push(component);
		mode.chatContainer.addChild(component);
		mode.pendingTools.set("call-1", component);
		return component;
	}

	it("renders a completed tool once when its component lingers in pendingTools during a rebuild", () => {
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "m1",
				parentId: null,
				timestamp: Date.now(),
				message: { role: "user", content: [{ type: "text", text: "run it" }], timestamp: 1 },
			},
			{
				type: "message",
				id: "m2",
				parentId: "m1",
				timestamp: Date.now(),
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: CMD } }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-sonnet-4-5",
					usage,
					stopReason: "toolUse",
					timestamp: 2,
				},
			},
			{
				type: "message",
				id: "m3",
				parentId: "m2",
				timestamp: Date.now(),
				message: {
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "bash",
					content: [{ type: "text", text: "" }],
					isError: false,
					timestamp: 3,
				},
			},
		] as unknown as SessionEntry[];

		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => true });
		vi.spyOn(session, "buildTranscriptSessionContext").mockReturnValue(
			buildSessionContext(entries, undefined, undefined, { transcript: true }),
		);

		addLiveBash();
		expect(countCommand(mode)).toBe(1);

		mode.rebuildChatFromMessages();

		// The replay reconstructs the completed block from the persisted
		// toolResult; the stale live component must NOT be re-appended on top.
		expect(countCommand(mode)).toBe(1);
	});

	it("keeps a genuinely in-flight tool call across a rebuild (still exactly once, still live)", () => {
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "m1",
				parentId: null,
				timestamp: Date.now(),
				message: { role: "user", content: [{ type: "text", text: "run it" }], timestamp: 1 },
			},
			{
				type: "message",
				id: "m2",
				parentId: "m1",
				timestamp: Date.now(),
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: CMD } }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-sonnet-4-5",
					usage,
					stopReason: "toolUse",
					timestamp: 2,
				},
			},
		] as unknown as SessionEntry[];

		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => true });
		vi.spyOn(session, "buildTranscriptSessionContext").mockReturnValue(
			buildSessionContext(entries, undefined, undefined, { transcript: true }),
		);

		const live = addLiveBash();
		mode.rebuildChatFromMessages();

		expect(countCommand(mode)).toBe(1);
		// The in-flight component is preserved for live routing so the pending
		// tool's result still lands in the on-screen block.
		expect(mode.pendingTools.get("call-1")).toBe(live);
	});
});
