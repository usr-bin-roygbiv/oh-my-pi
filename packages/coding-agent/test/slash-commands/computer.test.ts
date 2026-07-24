import { describe, expect, it, vi } from "bun:test";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";

function acpRuntime(options?: {
	enabled?: boolean;
	applyResult?: boolean;
	supportsComputerUse?: boolean;
	codex?: boolean;
}) {
	const store = {
		"computer.enabled": options?.enabled ?? false,
		"computer.backend": "auto",
		"computer.display": "all",
		"computer.maxWidth": 1920,
		"computer.maxHeight": 1200,
	};
	const get = vi.fn((path: string) => store[path as keyof typeof store]);
	const override = vi.fn((path: string, value: boolean) => {
		if (path === "computer.enabled") store[path] = value;
	});
	const set = vi.fn();
	const setComputerToolEnabled = vi.fn(async () => options?.applyResult ?? true);
	const getEnabledToolNames = vi.fn(() => (store["computer.enabled"] ? ["computer"] : []));
	const output = vi.fn();
	const model = options?.codex
		? {
				provider: "openai-codex",
				id: "gpt-5.6-sol",
				api: "openai-codex-responses",
				supportsComputerUse: options.supportsComputerUse ?? false,
			}
		: {
				provider: "google",
				id: "gemini-2.5-flash",
				api: "google-generative-ai",
				supportsComputerUse: options?.supportsComputerUse ?? false,
			};
	const runtime = {
		session: {
			settings: { get, override, set },
			setComputerToolEnabled,
			getEnabledToolNames,
			model,
		},
		output,
	} as unknown as SlashCommandRuntime;
	return { get, override, set, setComputerToolEnabled, getEnabledToolNames, output, runtime };
}

describe("/computer slash command", () => {
	it("toggles a disabled session on: slate refresh first, then session-only override", async () => {
		const h = acpRuntime({ enabled: false });

		const result = await executeAcpBuiltinSlashCommand("/computer", h.runtime);

		expect(result).toEqual({ consumed: true });
		expect(h.setComputerToolEnabled).toHaveBeenCalledWith(true);
		expect(h.override).toHaveBeenCalledWith("computer.enabled", true);
		expect(h.set).not.toHaveBeenCalled();
		expect(h.output).toHaveBeenCalledWith(
			"Computer use enabled for this session. Computer use: enabled · tool: active · backend: auto · display: all · capture: 1920×1200 · model: google/gemini-2.5-flash · exposure: function",
		);
	});

	it("toggles an enabled session off", async () => {
		const h = acpRuntime({ enabled: true });

		await executeAcpBuiltinSlashCommand("/computer", h.runtime);

		expect(h.setComputerToolEnabled).toHaveBeenCalledWith(false);
		expect(h.override).toHaveBeenCalledWith("computer.enabled", false);
		expect(h.output).toHaveBeenCalledWith("Computer use disabled for this session.");
	});

	it("honors explicit on/off regardless of current state", async () => {
		const on = acpRuntime({ enabled: true });
		await executeAcpBuiltinSlashCommand("/computer on", on.runtime);
		expect(on.setComputerToolEnabled).toHaveBeenCalledWith(true);
		expect(on.override).toHaveBeenCalledWith("computer.enabled", true);

		const off = acpRuntime({ enabled: false });
		await executeAcpBuiltinSlashCommand("/computer off", off.runtime);
		expect(off.setComputerToolEnabled).toHaveBeenCalledWith(false);
		expect(off.override).toHaveBeenCalledWith("computer.enabled", false);
	});

	it("reports status without touching the tool slate or settings", async () => {
		const h = acpRuntime({ enabled: true });

		await executeAcpBuiltinSlashCommand("/computer status", h.runtime);

		expect(h.setComputerToolEnabled).not.toHaveBeenCalled();
		expect(h.override).not.toHaveBeenCalled();
		expect(h.output).toHaveBeenCalledWith(
			"Computer use: enabled · tool: active · backend: auto · display: all · capture: 1920×1200 · model: google/gemini-2.5-flash · exposure: function",
		);
	});

	it("reports subscription Codex computer exposure as a callable function", async () => {
		const h = acpRuntime({ enabled: true, codex: true });

		await executeAcpBuiltinSlashCommand("/computer status", h.runtime);

		expect(h.output).toHaveBeenCalledWith(
			"Computer use: enabled · tool: active · backend: auto · display: all · capture: 1920×1200 · model: openai-codex/gpt-5.6-sol · exposure: function",
		);
	});

	it("reports explicit Codex native opt-in without masking the override", async () => {
		const h = acpRuntime({ enabled: true, codex: true, supportsComputerUse: true });

		await executeAcpBuiltinSlashCommand("/computer status", h.runtime);

		expect(h.output).toHaveBeenCalledWith(
			"Computer use: enabled · tool: active · backend: auto · display: all · capture: 1920×1200 · model: openai-codex/gpt-5.6-sol · exposure: native",
		);
	});

	it("leaves the override untouched when the session cannot build the tool", async () => {
		const h = acpRuntime({ enabled: false, applyResult: false });

		await executeAcpBuiltinSlashCommand("/computer on", h.runtime);

		expect(h.setComputerToolEnabled).toHaveBeenCalledWith(true);
		expect(h.override).not.toHaveBeenCalled();
		expect(h.output).toHaveBeenCalledWith("Computer use is unavailable in this session.");
	});

	it("rejects unknown arguments with usage", async () => {
		const h = acpRuntime();

		await executeAcpBuiltinSlashCommand("/computer bogus", h.runtime);

		expect(h.setComputerToolEnabled).not.toHaveBeenCalled();
		expect(h.output).toHaveBeenCalledWith("Usage: /computer [on|off|status]");
	});
});
