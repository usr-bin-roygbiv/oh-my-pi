/**
 * `/tree` re-answer for a past `ask` toolResult (issue #5642).
 *
 * Selecting an `ask` toolResult in the tree must not silently reposition the
 * leaf onto the old answer. `navigateTree()` instead hands back the original
 * questions (`reopenAsk`) so the caller can re-open the picker, then a
 * follow-up call with `reanswerAskResult` branches a *new* sibling toolResult
 * off the same `ask` toolCall — leaving the original answer's branch intact.
 */
import { describe, expect, it } from "bun:test";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { AskToolDetails } from "@oh-my-pi/pi-coding-agent/tools/ask";
import { assistantMsg, createTestSession, userMsg } from "./utilities";

const ORIGINAL_QUESTIONS = [
	{
		id: "deploy_target",
		question: "Which deploy target?",
		options: [{ label: "staging" }, { label: "production" }],
	},
];

/** Assistant message whose only content is a single `toolCall` block. */
function toolCallMsg(toolCallId: string, toolName: string, args: Record<string, unknown>) {
	return {
		...assistantMsg(""),
		content: [{ type: "toolCall" as const, id: toolCallId, name: toolName, arguments: args }],
		stopReason: "toolUse" as const,
	};
}

function toolResultMsg(toolCallId: string, toolName: string, text: string, details?: unknown) {
	return {
		role: "toolResult" as const,
		toolCallId,
		toolName,
		content: [{ type: "text" as const, text }],
		details,
		isError: false,
		timestamp: Date.now(),
	};
}

function staleAnswerResult(): AgentToolResult<AskToolDetails> {
	return {
		content: [{ type: "text", text: "User selected: staging" }],
		details: {
			question: ORIGINAL_QUESTIONS[0]!.question,
			options: ["staging", "production"],
			multi: false,
			selectedOptions: ["staging"],
		},
	};
}

function newAnswerResult(): AgentToolResult<AskToolDetails> {
	return {
		content: [{ type: "text", text: "User selected: production" }],
		details: {
			question: ORIGINAL_QUESTIONS[0]!.question,
			options: ["staging", "production"],
			multi: false,
			selectedOptions: ["production"],
		},
	};
}

describe("AgentSession tree navigation onto an ask toolResult", () => {
	it("(a) hands back reopenAsk with the original questions instead of moving the leaf", async () => {
		const ctx = await createTestSession({ inMemory: true });
		try {
			const { session, sessionManager } = ctx;

			// u1 -> a1(ask toolCall) -> tr1(stale answer) -> a2(next reply, leaf)
			sessionManager.appendMessage(userMsg("please deploy"));
			const askCallId = "ask-call-1";
			sessionManager.appendMessage(toolCallMsg(askCallId, "ask", { questions: ORIGINAL_QUESTIONS }));
			const tr1Id = sessionManager.appendMessage(
				toolResultMsg(askCallId, "ask", "User selected: staging", staleAnswerResult().details),
			);
			sessionManager.appendMessage(assistantMsg("deploying to staging"));
			const leafBeforeProbe = sessionManager.getLeafId();

			const result = await session.navigateTree(tr1Id);

			expect(result.cancelled).toBe(false);
			expect(result.reopenAsk).toBeDefined();
			expect(result.reopenAsk?.toolCallId).toBe(askCallId);
			expect(result.reopenAsk?.questions).toEqual(ORIGINAL_QUESTIONS);
			// Nothing was mutated: the leaf is exactly where it was before probing.
			expect(sessionManager.getLeafId()).toBe(leafBeforeProbe);
		} finally {
			await ctx.cleanup();
		}
	});

	it("(b)+(c) branches a new sibling toolResult and keeps the original branch reachable", async () => {
		const ctx = await createTestSession({ inMemory: true });
		try {
			const { session, sessionManager } = ctx;

			sessionManager.appendMessage(userMsg("please deploy"));
			const askCallId = "ask-call-1";
			const askCallEntryId = sessionManager.appendMessage(
				toolCallMsg(askCallId, "ask", { questions: ORIGINAL_QUESTIONS }),
			);
			const tr1Id = sessionManager.appendMessage(
				toolResultMsg(askCallId, "ask", "User selected: staging", staleAnswerResult().details),
			);
			const a2Id = sessionManager.appendMessage(assistantMsg("deploying to staging"));

			const probe = await session.navigateTree(tr1Id);
			expect(probe.reopenAsk).toBeDefined();

			const result = await session.navigateTree(tr1Id, { reanswerAskResult: newAnswerResult() });

			expect(result.cancelled).toBe(false);
			const newLeafId = sessionManager.getLeafId();
			expect(newLeafId).not.toBeNull();
			// (b) sibling, not mutation: a fresh entry, and the old one is untouched.
			expect(newLeafId).not.toBe(tr1Id);
			const newEntry = sessionManager.getEntry(newLeafId!);
			expect(newEntry?.parentId).toBe(askCallEntryId);
			const originalEntry = sessionManager.getEntry(tr1Id);
			expect(originalEntry).toBeDefined();
			expect(originalEntry?.parentId).toBe(askCallEntryId);
			if (originalEntry?.type === "message" && originalEntry.message.role === "toolResult") {
				expect(originalEntry.message.details).toEqual(staleAnswerResult().details);
			} else {
				throw new Error("expected original toolResult entry to survive untouched");
			}
			// The original branch (tr1 -> a2) is still fully reachable.
			expect(sessionManager.getEntry(a2Id)?.parentId).toBe(tr1Id);
			const siblingIds = sessionManager.getChildren(askCallEntryId).map(e => e.id);
			expect(siblingIds).toContain(tr1Id);
			expect(siblingIds).toContain(newLeafId!);

			// (c) the new toolResult reflects the *new* answer, same toolCallId.
			if (newEntry?.type === "message" && newEntry.message.role === "toolResult") {
				expect(newEntry.message.toolCallId).toBe(askCallId);
				expect(newEntry.message.toolName).toBe("ask");
				expect(newEntry.message.details).toEqual(newAnswerResult().details);
				expect(newEntry.message.content).toEqual(newAnswerResult().content);
			} else {
				throw new Error("expected the new leaf to be a toolResult entry");
			}
		} finally {
			await ctx.cleanup();
		}
	});

	it("(d) leaves plain (non-ask) toolResult navigation as a direct leaf move", async () => {
		const ctx = await createTestSession({ inMemory: true });
		try {
			const { session, sessionManager } = ctx;

			sessionManager.appendMessage(userMsg("read the config"));
			sessionManager.appendMessage(toolCallMsg("read-call-1", "read", { path: "config.txt" }));
			const tr1Id = sessionManager.appendMessage(toolResultMsg("read-call-1", "read", "file body"));
			sessionManager.appendMessage(assistantMsg("done reading"));

			const result = await session.navigateTree(tr1Id);

			expect(result.cancelled).toBe(false);
			expect(result.reopenAsk).toBeUndefined();
			expect(result.editorText).toBeUndefined();
			// Unlike `ask`, a plain toolResult lands the leaf directly on the target.
			expect(sessionManager.getLeafId()).toBe(tr1Id);
		} finally {
			await ctx.cleanup();
		}
	});

	it("(e) falls back to a plain leaf move when the original ask arguments can't be recovered", async () => {
		const ctx = await createTestSession({ inMemory: true });
		try {
			const { session, sessionManager } = ctx;

			sessionManager.appendMessage(userMsg("please deploy"));
			// Legacy/corrupted persisted args: `questions` fails schema validation.
			sessionManager.appendMessage(toolCallMsg("ask-call-bad", "ask", { questions: "not-an-array" }));
			const trBadId = sessionManager.appendMessage(toolResultMsg("ask-call-bad", "ask", "User selected: staging"));
			sessionManager.appendMessage(assistantMsg("deploying to staging"));

			const result = await session.navigateTree(trBadId);

			expect(result.cancelled).toBe(false);
			expect(result.reopenAsk).toBeUndefined();
			expect(sessionManager.getLeafId()).toBe(trBadId);
		} finally {
			await ctx.cleanup();
		}
	});
});
