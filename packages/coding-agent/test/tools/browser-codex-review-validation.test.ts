import { describe, expect, it } from "bun:test";
import {
	type CodexBrowserAdapter,
	type CodexBrowserOperation,
	createCodexBrowserFacade,
} from "@oh-my-pi/pi-coding-agent/tools/browser/codex-facade";

const INHERITED_PROPERTY_NAMES = ["toString", "constructor", "__proto__"] as const;

type RecordedCall = {
	operation: CodexBrowserOperation;
	args: Readonly<Record<string, unknown>>;
};

class RecordingAdapter implements CodexBrowserAdapter {
	readonly currentTabId = "1";
	readonly calls: RecordedCall[] = [];

	async invoke<T>(operation: CodexBrowserOperation, args: Readonly<Record<string, unknown>>): Promise<T> {
		this.calls.push({ operation, args });
		if (operation === "tab.selected") return { id: "1" } as T;
		if (operation === "tab.content.exportGsuite") return "exported" as T;
		if (operation === "tabs.content" || operation === "tab.dev.logs") return [] as T;
		return undefined as T;
	}
}

async function captureError(run: () => unknown | Promise<unknown>): Promise<{ name: string; message: string }> {
	try {
		await run();
		return { name: "NO_ERROR", message: "" };
	} catch (error) {
		return {
			name: error instanceof Error ? error.name : typeof error,
			message: error instanceof Error ? error.message : String(error),
		};
	}
}

async function selectedTab(adapter: RecordingAdapter) {
	const browser = createCodexBrowserFacade(adapter);
	const tab = await browser.tabs.selected();
	if (!tab) throw new Error("Expected a selected browser tab");
	return { browser, tab };
}

describe("Codex browser public facade closed vocabularies", () => {
	it("rejects inherited property names as tabs.content content types while accepting a valid content type", async () => {
		const adapter = new RecordingAdapter();
		const { browser } = await selectedTab(adapter);

		await expect(browser.tabs.content({ urls: ["https://fixture.test"], contentType: "html" })).resolves.toEqual([]);
		expect(adapter.calls.at(-1)).toMatchObject({
			operation: "tabs.content",
			args: { urls: ["https://fixture.test"], contentType: "html" },
		});

		const outcomes = await Promise.all(
			INHERITED_PROPERTY_NAMES.map(contentType =>
				captureError(() => browser.tabs.content({ urls: [], contentType } as never)),
			),
		);
		expect(outcomes).toEqual(
			INHERITED_PROPERTY_NAMES.map(() => ({
				name: "Error",
				message: "browser.tabs.content contentType must be html, text, or domSnapshot",
			})),
		);
	});

	it("rejects inherited property names as GSuite formats while accepting a valid format", async () => {
		const adapter = new RecordingAdapter();
		const { tab } = await selectedTab(adapter);

		await expect(tab.content.exportGsuite("pdf")).resolves.toBe("exported");
		expect(adapter.calls.at(-1)).toMatchObject({
			operation: "tab.content.exportGsuite",
			args: { tabId: "1", format: "pdf" },
		});

		const outcomes = await Promise.all(
			INHERITED_PROPERTY_NAMES.map(format => captureError(() => tab.content.exportGsuite(format as never))),
		);
		expect(outcomes).toEqual(
			INHERITED_PROPERTY_NAMES.map(() => ({
				name: "Error",
				message: "content.exportGsuite requires a supported format",
			})),
		);
	});

	it("rejects inherited property names from every load-state entry point while accepting valid states", async () => {
		const adapter = new RecordingAdapter();
		const { tab } = await selectedTab(adapter);

		await tab.playwright.waitForURL("https://fixture.test", { waitUntil: "load" });
		await tab.playwright.waitForLoadState({ state: "domcontentloaded" });
		await expect(tab.playwright.expectNavigation(() => "navigated", { waitUntil: "networkidle" })).resolves.toBe(
			"navigated",
		);

		const outcomes = await Promise.all(
			INHERITED_PROPERTY_NAMES.flatMap(state => [
				captureError(() => tab.playwright.waitForURL("https://fixture.test", { waitUntil: state } as never)),
				captureError(() => tab.playwright.waitForLoadState({ state } as never)),
				captureError(() => tab.playwright.expectNavigation(() => undefined, { waitUntil: state } as never)),
			]),
		);
		expect(outcomes).toEqual(
			INHERITED_PROPERTY_NAMES.flatMap(() => [
				{ name: "Error", message: "playwright.waitForURL state is invalid" },
				{ name: "Error", message: "playwright.waitForLoadState state is invalid" },
				{ name: "Error", message: "playwright.expectNavigation state is invalid" },
			]),
		);
	});

	it("rejects inherited property names as dev log levels while accepting every valid level", async () => {
		const adapter = new RecordingAdapter();
		const { tab } = await selectedTab(adapter);

		await expect(tab.dev.logs({ levels: ["debug", "info", "log", "warn", "warning", "error"] })).resolves.toEqual([]);
		expect(adapter.calls.at(-1)).toMatchObject({
			operation: "tab.dev.logs",
			args: { tabId: "1", levels: ["debug", "info", "log", "warn", "warn", "error"] },
		});

		const outcomes = await Promise.all(
			INHERITED_PROPERTY_NAMES.map(level => captureError(() => tab.dev.logs({ levels: [level] } as never))),
		);
		expect(outcomes).toEqual(
			INHERITED_PROPERTY_NAMES.map(() => ({
				name: "Error",
				message: "dev.logs levels contains an invalid level",
			})),
		);
	});

	it("rejects inherited property names as click and dblclick option keys while accepting valid keys", async () => {
		const adapter = new RecordingAdapter();
		const { tab } = await selectedTab(adapter);
		const locator = tab.playwright.locator("#target");

		await locator.click({ button: "left", modifiers: ["Alt"], force: true, timeoutMs: 25 });
		await locator.dblclick({ button: "right", modifiers: ["Shift"], force: false, timeoutMs: 50 });

		const outcomes = await Promise.all(
			INHERITED_PROPERTY_NAMES.flatMap(key => {
				const options = Object.fromEntries([[key, true]]);
				return [
					captureError(() => locator.click(options as never)),
					captureError(() => locator.dblclick(options as never)),
				];
			}),
		);
		expect(outcomes).toEqual(
			INHERITED_PROPERTY_NAMES.flatMap(key => [
				{ name: "Error", message: `locator.click does not accept ${key}` },
				{ name: "Error", message: `locator.dblclick does not accept ${key}` },
			]),
		);
	});

	it("rejects inherited property names as click and dblclick modifiers while accepting every valid modifier", async () => {
		const adapter = new RecordingAdapter();
		const { tab } = await selectedTab(adapter);
		const locator = tab.playwright.locator("#target");
		const validModifiers = ["Alt", "Control", "ControlOrMeta", "Meta", "Shift"] as const;

		await locator.click({ modifiers: [...validModifiers] });
		await locator.dblclick({ modifiers: [...validModifiers] });

		const outcomes = await Promise.all(
			INHERITED_PROPERTY_NAMES.flatMap(modifier => [
				captureError(() => locator.click({ modifiers: [modifier] } as never)),
				captureError(() => locator.dblclick({ modifiers: [modifier] } as never)),
			]),
		);
		expect(outcomes).toEqual(
			INHERITED_PROPERTY_NAMES.flatMap(() => [
				{
					name: "Error",
					message: "locator.click modifiers must contain only Alt, Control, ControlOrMeta, Meta, or Shift",
				},
				{
					name: "Error",
					message: "locator.dblclick modifiers must contain only Alt, Control, ControlOrMeta, Meta, or Shift",
				},
			]),
		);
	});
});
