import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { instrumentedCompleteSimple, resolveTelemetry } from "@oh-my-pi/pi-agent-core";
import { type Api, completeSimple, type Model, type ToolExample } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import { extractTextContent } from "../commit/utils";

import {
	expandRoleAlias,
	getModelMatchPreferences,
	resolveConfiguredModelPatterns,
	resolveModelFromString,
} from "../config/model-resolver";
import { isAuthenticated, kNoAuth } from "../config/model-registry";
import inspectImageDescription from "../prompts/tools/inspect-image.md" with { type: "text" };
import inspectImageSystemPromptTemplate from "../prompts/tools/inspect-image-system.md" with { type: "text" };
import {
	ImageInputTooLargeError,
	type LoadedImageInput,
	loadImageInput,
	MAX_IMAGE_INPUT_BYTES,
	webpExclusionForModel,
} from "../utils/image-loading";
import type { ToolSession } from "./index";
import { ToolError } from "./tool-errors";

const inspectImageSchema = type({
	path: type("string").describe("image path"),
	question: type("string").describe("question about image"),
	"+": "reject",
});

export type InspectImageParams = typeof inspectImageSchema.infer;

export interface InspectImageToolDetails {
	model: string;
	imagePath: string;
	mimeType: string;
}

export class InspectImageTool implements AgentTool<typeof inspectImageSchema, InspectImageToolDetails> {
	readonly name = "inspect_image";
	readonly approval = "read" as const;
	readonly label = "InspectImage";
	readonly loadMode = "discoverable";
	readonly summary = "Describe or analyze an image file";
	readonly description: string;
	readonly parameters = inspectImageSchema;
	readonly strict = false;

	readonly examples: readonly ToolExample<typeof inspectImageSchema.infer>[] = [
		{
			caption: "OCR with strict formatting",
			call: {
				path: "screenshots/error.png",
				question: "Extract all visible text verbatim. Return as bullet list in reading order.",
			},
		},
		{
			caption: "Screenshot debugging",
			call: {
				path: "screenshots/settings.png",
				question:
					"Identify the likely cause of the disabled Save button. Return: (1) observations, (2) likely cause, (3) confidence.",
			},
		},
		{
			caption: "Scene/object question",
			call: {
				path: "photos/shelf.jpg",
				question:
					"List all clearly visible product labels and their shelf positions (top/middle/bottom). If unreadable, say unreadable.",
			},
		},
	];

	constructor(
		private readonly session: ToolSession,
		private readonly completeImageRequest: typeof completeSimple = completeSimple,
	) {
		this.description = prompt.render(inspectImageDescription);
	}

	async execute(
		_toolCallId: string,
		params: InspectImageParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<InspectImageToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<InspectImageToolDetails>> {
		if (this.session.settings.get("images.blockImages")) {
			throw new ToolError(
				"Image submission is disabled by settings (images.blockImages=true). Disable it to use inspect_image.",
			);
		}

		const modelRegistry = this.session.modelRegistry;
		if (!modelRegistry) {
			throw new ToolError("Model registry is unavailable for inspect_image.");
		}

		const availableModels = modelRegistry.getAvailable();
		if (availableModels.length === 0) {
			throw new ToolError("No models available for inspect_image.");
		}

		const matchPreferences = getModelMatchPreferences(this.session.settings);
		const resolvePattern = (pattern: string | undefined): Model<Api> | undefined => {
			if (!pattern) return undefined;
			const expanded = expandRoleAlias(pattern, this.session.settings);
			return resolveModelFromString(expanded, availableModels, matchPreferences, modelRegistry);
		};

		const activeModelPattern = this.session.getActiveModelString?.() ?? this.session.getModelString?.();

		// Build a deduplicated candidate list from multiple sources so a model
		// with invalid credentials doesn't block the tool:
		//   1. Configured vision role (modelRoles.vision)
		//   2. Built-in vision priority chain from priority.json (Gemini-first)
		//   3. Active session model
		//   4. Configured default role
		const seenPatterns = new Set<string>();
		const candidatePatterns: string[] = [];
		for (const pattern of [
			...resolveConfiguredModelPatterns("pi/vision", this.session.settings),
			...resolveConfiguredModelPatterns("pi/vision"),
			activeModelPattern,
			...resolveConfiguredModelPatterns("pi/default", this.session.settings),
		]) {
			if (pattern && !seenPatterns.has(pattern)) {
				seenPatterns.add(pattern);
				candidatePatterns.push(pattern);
			}
		}

		// Filter to image-capable models that have credentials
		const seenModelIds = new Set<string>();
		const viableCandidates: Model<Api>[] = [];
		for (const pattern of candidatePatterns) {
			const candidate = resolvePattern(pattern);
			if (!candidate || !candidate.input.includes("image")) continue;
			const id = `${candidate.provider}/${candidate.id}`;
			if (seenModelIds.has(id)) continue;
			const key = await modelRegistry.getApiKey(candidate);
			if (key !== kNoAuth && !isAuthenticated(key)) continue;
			seenModelIds.add(id);
			viableCandidates.push(candidate);
		}

		// Last resort: scan all available image-capable authenticated models
		for (const candidate of availableModels) {
			const id = `${candidate.provider}/${candidate.id}`;
			if (seenModelIds.has(id)) continue;
			if (!candidate.input.includes("image")) continue;
			const key = await modelRegistry.getApiKey(candidate);
			if (key !== kNoAuth && !isAuthenticated(key)) continue;
			seenModelIds.add(id);
			viableCandidates.push(candidate);
		}

		if (viableCandidates.length === 0) {
			throw new ToolError(
				"Unable to resolve an image-capable model with credentials for inspect_image. " +
					"Configure modelRoles.vision to a vision-capable model (e.g. a Gemini model) with working API credentials.",
			);
		}

		// Load the image once for all candidates
		let imageInput: LoadedImageInput | null;
		try {
			imageInput = await loadImageInput({
				path: params.path,
				cwd: this.session.cwd,
				autoResize: this.session.settings.get("images.autoResize"),
				maxBytes: MAX_IMAGE_INPUT_BYTES,
				excludeWebP: webpExclusionForModel(viableCandidates[0]),
			});
		} catch (error) {
			if (error instanceof ImageInputTooLargeError) {
				throw new ToolError(error.message);
			}
			throw error;
		}

		if (!imageInput) {
			throw new ToolError("inspect_image only supports PNG, JPEG, GIF, and WEBP files detected by file content.");
		}

		const telemetry = resolveTelemetry(this.session.getTelemetry?.(), this.session.getSessionId?.() ?? undefined);
		const authErrorPattern = /401|403|auth|api.?key|forbidden|x-api-key|invalid.*key/i;
		let lastError: string | undefined;

		// Try each candidate; on auth failure, fall through to the next
		for (const candidate of viableCandidates) {
			try {
				const response = await instrumentedCompleteSimple(
					candidate,
					{
						systemPrompt: [prompt.render(inspectImageSystemPromptTemplate)],
						messages: [
							{
								role: "user",
								content: [
									{ type: "image", data: imageInput.data, mimeType: imageInput.mimeType },
									{ type: "text", text: params.question },
								],
								timestamp: Date.now(),
							},
						],
					},
					{
						apiKey: modelRegistry.resolver(candidate, this.session.getSessionId?.() ?? undefined),
						signal,
					},
					{ telemetry, oneshotKind: "inspect_image", completeImpl: this.completeImageRequest },
				);

				if (response.stopReason === "error") {
					const msg = response.errorMessage ?? "";
					if (authErrorPattern.test(msg)) {
						lastError = msg;
						continue;
					}
					throw new ToolError(msg || "inspect_image request failed.");
				}
				if (response.stopReason === "aborted") {
					throw new ToolError("inspect_image request aborted.");
				}

				const text = extractTextContent(response);
				if (!text) {
					throw new ToolError("inspect_image model returned no text output.");
				}

				return {
					content: [{ type: "text", text }],
					details: {
						model: `${candidate.provider}/${candidate.id}`,
						imagePath: imageInput.resolvedPath,
						mimeType: imageInput.mimeType,
					},
				};
			} catch (err) {
				if (err instanceof ToolError) throw err;
				const msg = err instanceof Error ? err.message : String(err);
				if (authErrorPattern.test(msg)) {
					lastError = msg;
					continue;
				}
				throw err;
			}
		}

		throw new ToolError(
			`All ${viableCandidates.length} image-capable model(s) failed. ` +
				(lastError ? `Last error: ${lastError}. ` : "") +
				"Configure modelRoles.vision to a vision-capable model with working API credentials.",
		);
	}
}

export { inspectImageToolRenderer } from "./inspect-image-renderer";
