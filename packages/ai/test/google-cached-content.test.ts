import { describe, expect, it } from "bun:test";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { streamGoogle } from "@oh-my-pi/pi-ai/providers/google";
import type { GoogleGeminiCliOptions } from "@oh-my-pi/pi-ai/providers/google-gemini-cli";
import { buildGoogleGenerateContentParams } from "@oh-my-pi/pi-ai/providers/google-shared";
import { streamGoogleVertex } from "@oh-my-pi/pi-ai/providers/google-vertex";
import type { ApiOptionsMap, AssistantMessageEvent, Context, FetchImpl, Model, Tool } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const CACHE_NAME = "cachedContents/caller-owned-corpus-abc";
const VERTEX_CACHE_NAME = "projects/demo-project/locations/us-central1/cachedContents/caller-owned-corpus-abc";

const tool: Tool = {
	name: "lookup",
	description: "Lookup a fact",
	parameters: { type: "object", properties: {}, additionalProperties: false } as never,
};

const contextWithSystemAndTools: Context = {
	systemPrompt: ["stable system instruction"],
	messages: [{ role: "user", content: "use the cache", timestamp: 1 }],
	tools: [tool],
};

const geminiModel: Model<"google-generative-ai"> = buildModel({
	id: "gemini-2.5-flash",
	name: "Gemini 2.5 Flash",
	api: "google-generative-ai",
	provider: "google",
	baseUrl: "https://generativelanguage.googleapis.com/v1beta",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_000,
});

const vertexModel: Model<"google-vertex"> = buildModel({
	id: "gemini-2.5-flash",
	name: "Gemini 2.5 Flash (Vertex)",
	api: "google-vertex",
	provider: "google-vertex",
	baseUrl: "",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_000,
});

function sseStop(usage?: Record<string, number>): Response {
	const chunk = {
		candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
		usageMetadata: {
			promptTokenCount: usage?.promptTokenCount ?? 100,
			candidatesTokenCount: usage?.candidatesTokenCount ?? 4,
			totalTokenCount: usage?.totalTokenCount ?? 104,
			...(usage?.cachedContentTokenCount !== undefined
				? { cachedContentTokenCount: usage.cachedContentTokenCount }
				: {}),
		},
	};
	return new Response(`data: ${JSON.stringify(chunk)}\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

async function drain(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

interface Captured {
	url: string;
	body: Record<string, unknown>;
}

function capturingFetch(response: Response = sseStop()): {
	fetch: FetchImpl;
	calls: () => Captured[];
} {
	const calls: Captured[] = [];
	const fetch: FetchImpl = async (input, init) => {
		calls.push({
			url: input instanceof Request ? input.url : String(input),
			body: JSON.parse(String(init?.body ?? "{}")),
		});
		return response;
	};
	return { fetch, calls: () => calls };
}

// Compile-time: cachedContent is only on GenerateContent / Vertex options, not Gemini CLI /
// Antigravity (google-gemini-cli) or any other Google transport registration.
type _GeminiCliLacksCachedContent = "cachedContent" extends keyof GoogleGeminiCliOptions ? never : true;
true satisfies _GeminiCliLacksCachedContent;
type _CliApiLacksCachedContent = "cachedContent" extends keyof ApiOptionsMap["google-gemini-cli"] ? never : true;
true satisfies _CliApiLacksCachedContent;
type _GenerativeAiHasCachedContent = "cachedContent" extends keyof ApiOptionsMap["google-generative-ai"] ? true : never;
true satisfies _GenerativeAiHasCachedContent;
type _VertexHasCachedContent = "cachedContent" extends keyof ApiOptionsMap["google-vertex"] ? true : never;
true satisfies _VertexHasCachedContent;

describe("Google caller-owned cachedContent", () => {
	it("sets exact cachedContent on the direct Gemini GenerateContent wire body", async () => {
		const { fetch, calls } = capturingFetch();
		await drain(
			streamGoogle(geminiModel, contextWithSystemAndTools, {
				apiKey: "k",
				cachedContent: CACHE_NAME,
				fetch,
			}),
		);

		expect(calls()).toHaveLength(1);
		const { url, body } = calls()[0]!;
		expect(url).toContain(":streamGenerateContent");
		expect(url).not.toContain("/cachedContents");
		expect(body.cachedContent).toBe(CACHE_NAME);
		expect(body.systemInstruction).toEqual({
			parts: [{ text: "stable system instruction" }],
		});
		expect(body.tools).toEqual([
			{
				functionDeclarations: [
					expect.objectContaining({
						name: "lookup",
						description: "Lookup a fact",
					}),
				],
			},
		]);
	});

	it("sets exact cachedContent on the Vertex GenerateContent wire body", async () => {
		const { fetch, calls } = capturingFetch();
		await drain(
			streamGoogleVertex(vertexModel, contextWithSystemAndTools, {
				apiKey: "k",
				project: "demo-project",
				location: "us-central1",
				cachedContent: VERTEX_CACHE_NAME,
				fetch,
			}),
		);

		expect(calls()).toHaveLength(1);
		const { url, body } = calls()[0]!;
		expect(url).toContain(":streamGenerateContent");
		expect(url).not.toMatch(/\/cachedContents(?:\/|$|\?)/);
		expect(body.cachedContent).toBe(VERTEX_CACHE_NAME);
		expect(body.systemInstruction).toEqual({
			parts: [{ text: "stable system instruction" }],
		});
		expect((body.tools as unknown[] | undefined)?.length).toBe(1);
	});

	it("rejects blank cachedContent in the shared builder before transport", () => {
		for (const blank of ["", "   ", "\t\n"]) {
			expect(() =>
				buildGoogleGenerateContentParams(geminiModel, contextWithSystemAndTools, {
					apiKey: "k",
					cachedContent: blank,
				}),
			).toThrow(AIError.ValidationError);
		}
	});

	it("rejects blank cachedContent in the stream before any fetch", async () => {
		const { fetch, calls } = capturingFetch();
		const events = await drain(
			streamGoogle(geminiModel, contextWithSystemAndTools, {
				apiKey: "k",
				cachedContent: "  ",
				fetch,
			}),
		);
		expect(calls()).toHaveLength(0);
		const error = events.find(e => e.type === "error");
		expect(error).toBeDefined();
		if (error?.type === "error") {
			expect(error.error.errorMessage).toContain("cachedContent must not be blank");
		}
	});

	it("omits cachedContent when the option is unset", () => {
		const params = buildGoogleGenerateContentParams(geminiModel, contextWithSystemAndTools, { apiKey: "k" });
		expect(params.config?.cachedContent).toBeUndefined();
	});

	it("preserves caller systemInstruction and tools alongside cachedContent in the builder", () => {
		const params = buildGoogleGenerateContentParams(geminiModel, contextWithSystemAndTools, {
			apiKey: "k",
			cachedContent: CACHE_NAME,
		});
		expect(params.config?.cachedContent).toBe(CACHE_NAME);
		expect(params.config?.systemInstruction).toEqual({
			parts: [{ text: "stable system instruction" }],
		});
		expect(params.config?.tools).toBeDefined();
		expect(params.config?.tools?.[0]?.functionDeclarations?.[0]?.name).toBe("lookup");
	});

	it("normalizes cachedContentTokenCount into Usage.cacheRead without double-counting input", async () => {
		const { fetch } = capturingFetch(
			sseStop({
				promptTokenCount: 100,
				cachedContentTokenCount: 80,
				candidatesTokenCount: 5,
				totalTokenCount: 105,
			}),
		);
		const events = await drain(
			streamGoogle(geminiModel, contextWithSystemAndTools, {
				apiKey: "k",
				cachedContent: CACHE_NAME,
				fetch,
			}),
		);
		const done = events.find(e => e.type === "done");
		expect(done?.type).toBe("done");
		if (done?.type === "done") {
			expect(done.message.usage.input).toBe(20);
			expect(done.message.usage.cacheRead).toBe(80);
			expect(done.message.usage.cacheWrite).toBe(0);
			expect(done.message.usage.output).toBe(5);
			expect(done.message.usage.totalTokens).toBe(105);
		}
	});

	it("does not invoke Google cache lifecycle endpoints when referencing cached content", async () => {
		const { fetch, calls } = capturingFetch();
		await drain(
			streamGoogle(geminiModel, contextWithSystemAndTools, {
				apiKey: "k",
				cachedContent: CACHE_NAME,
				fetch,
			}),
		);
		const urls = calls().map(c => c.url);
		expect(urls).toHaveLength(1);
		expect(urls[0]).toMatch(/models\/gemini-2\.5-flash:streamGenerateContent/);
		for (const url of urls) {
			expect(url).not.toMatch(/\/cachedContents(?:\/[^:]*)?(?:\?|$)/);
			expect(url).not.toMatch(/cachedContents.*:(?:create|delete|patch)/i);
		}
	});
});
