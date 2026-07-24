import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { BrowserTool, type BrowserToolDetails } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { CmuxCodexBrowserAdapter } from "@oh-my-pi/pi-coding-agent/tools/browser/cmux/codex-adapter";
import { CmuxSocketClient } from "@oh-my-pi/pi-coding-agent/tools/browser/cmux/socket-client";
import {
	CODEX_BROWSER_CAPABILITIES,
	type CodexBrowserAdapter,
	type CodexBrowserOperation,
	createCodexBrowserFacade,
} from "@oh-my-pi/pi-coding-agent/tools/browser/codex-facade";
import { PuppeteerCodexBrowserAdapter } from "@oh-my-pi/pi-coding-agent/tools/browser/codex-puppeteer";
import { ensureChromiumExecutable } from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import { getTabsMapForTest, releaseTab } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";

type RpcCall = {
	method: string;
	params: Record<string, unknown>;
	timeoutMs?: number;
};

type RunResult = AgentToolResult<BrowserToolDetails>;

function makeSession(settings: Record<string, unknown>): ToolSession {
	return {
		cwd: "/tmp/browser-contract",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(settings),
	} as ToolSession;
}

function textOf(result: RunResult): string {
	return result.content
		.filter((entry): entry is { type: "text"; text: string } => entry.type === "text")
		.map(entry => entry.text)
		.join("\n");
}

async function runJson<T>(tool: BrowserTool, name: string, code: string): Promise<T> {
	const result = await tool.execute("codex-browser-contract", { action: "run", name, code, timeout: 20 });
	return JSON.parse(textOf(result)) as T;
}

async function drainTabs(): Promise<void> {
	for (const name of [...getTabsMapForTest().keys()]) {
		await releaseTab(name, { kill: true }).catch(() => undefined);
	}
}

async function withCmuxTool(test: (tool: BrowserTool, name: string, calls: RpcCall[]) => Promise<void>): Promise<void> {
	const priorSocket = process.env.CMUX_SOCKET_PATH;
	const socketPath = `/tmp/browser-contract-${crypto.randomUUID()}.sock`;
	process.env.CMUX_SOCKET_PATH = socketPath;
	const calls: RpcCall[] = [];
	const urlsBySurface = new Map<string, string>();

	spyOn(CmuxSocketClient.prototype, "connect").mockResolvedValue(undefined);
	spyOn(CmuxSocketClient.prototype, "close").mockImplementation(() => undefined);
	spyOn(CmuxSocketClient.prototype, "request").mockImplementation(
		async (
			method: string,
			params: Record<string, unknown> = {},
			options?: { timeoutMs?: number },
		): Promise<Record<string, unknown>> => {
			calls.push({ method, params, timeoutMs: options?.timeoutMs });
			switch (method) {
				case "browser.open_split": {
					const surfaceId = `surface-${crypto.randomUUID()}`;
					const requested =
						typeof params.url === "string" && params.url !== "about:blank"
							? params.url
							: "https://fixture.test/start";
					if (requested.endsWith("/fail")) throw new Error("deterministic navigation failure");
					urlsBySurface.set(surfaceId, requested);
					return { surface_id: surfaceId, url: requested };
				}
				case "browser.tab.list":
					return {
						tabs: [{ id: "tab-1", url: "https://fixture.test/start", title: "Contract fixture", focused: true }],
					};
				case "browser.url.get":
					return { url: urlsBySurface.get(String(params.surface_id)) ?? "https://fixture.test/start" };
				case "browser.navigate": {
					const url = String(params.url);
					if (url.endsWith("/fail")) throw new Error("deterministic navigation failure");
					urlsBySurface.set(String(params.surface_id), url);
					return { url };
				}
				case "browser.snapshot": {
					const url = urlsBySurface.get(String(params.surface_id)) ?? "https://fixture.test/start";
					return {
						page: {
							url,
							title: "Contract fixture",
							html: "<main><button id='target'>Target</button><input aria-label='Name'></main>",
						},
						refs: { e1: { role: "button", name: "Target" } },
					};
				}
				case "browser.geometry":
					return {
						innerWidth: 800,
						innerHeight: 600,
						dpr: 1,
						scrollX: 0,
						scrollY: 0,
						scrollWidth: 800,
						scrollHeight: 600,
					};
				case "browser.screenshot":
					return { png_base64: "aQ==", width: 1, height: 1 };
				case "browser.eval":
					if (params.script === "document.title") return { value: "Contract fixture" };
					if (typeof params.script === "string" && params.script.includes("document.documentElement?.outerHTML")) {
						return {
							value: "<main><button id='target'>Target</button><input aria-label='Name'></main>",
						};
					}
					if (typeof params.script === "string" && params.script.includes("includeNonInteractable")) {
						return {
							value: {
								tagName: "button",
								role: "button",
								text: "Leaf action",
								interactable: true,
								attributes: { id: "target", "data-testid": "target" },
								boundingBox: { x: 0, y: 0, width: 120, height: 80 },
							},
						};
					}
					if (
						typeof params.script === "string" &&
						params.script.includes("return globalThis.__ompCodexBrowserState.fileEventSequence")
					) {
						return { value: 0 };
					}
					return { value: true };
				case "browser.scroll":
				case "browser.mouse":
				case "browser.keypress":
				case "browser.type":
				case "surface.close":
					return {};
				default:
					return {};
			}
		},
	);

	const tool = new BrowserTool(makeSession({ "browser.cmux": true, "browser.headless": true }));
	const name = `cmux-contract-${crypto.randomUUID()}`;
	try {
		await tool.execute("codex-browser-open", { action: "open", name });
		await test(tool, name, calls);
	} finally {
		await tool.execute("codex-browser-close", { action: "close", name, kill: true }).catch(() => undefined);
		vi.restoreAllMocks();
		if (priorSocket === undefined) delete process.env.CMUX_SOCKET_PATH;
		else process.env.CMUX_SOCKET_PATH = priorSocket;
	}
}

async function chromiumCanLaunch(): Promise<boolean> {
	try {
		const executable = await ensureChromiumExecutable();
		if (!executable) return false;
		return Bun.spawnSync([executable, "--version"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
	} catch {
		return false;
	}
}

const CHROMIUM_AVAILABLE = await chromiumCanLaunch();

async function withPuppeteerTool(test: (tool: BrowserTool, name: string) => Promise<void>): Promise<void> {
	const tool = new BrowserTool(makeSession({ "browser.cmux": false, "browser.headless": true }));
	const name = `puppeteer-contract-${crypto.randomUUID()}`;
	const fixture = [
		"<style>html,body{margin:0;width:100%;height:100%}#target{width:120px;height:80px}.hidden{display:none}</style>",
		"<h1>Contract heading</h1><a id='docs-link' href='#docs'>Documentation</a>",
		"<button id='target' data-testid='target'><span>Leaf action</span></button>",
		"<input id='name' aria-label='Name'><label><input id='check' type='checkbox' aria-label='Check'>Check</label>",
		"<label for='label-conflict'>Associated Label</label><input id='label-conflict' aria-label='ARIA Name'>",
		"<span id='priority-label'>Labelled Priority</span><input id='priority' aria-labelledby='priority-label' aria-label='ARIA fallback'>",
		"<input id='radio' type='radio' aria-label='Radio'><select id='single'><option value='one'>One</option><option value='two'>Two</option></select>",
		"<img id='hero' alt='Hero image'><input id='range' type='range' aria-label='Range'><input id='image-button' type='image' alt='Image Button'>",
		"<button id='disabled' disabled>Disabled</button><div id='aria-disabled' role='button' aria-disabled='true'>ARIA disabled</div>",
		"<div id='not-checkable'>Not checkable</div><button id='hidden' class='hidden'>Hidden</button><div id='editable' contenteditable='true'></div>",
	].join("");
	try {
		await tool.execute("codex-browser-open", {
			action: "open",
			name,
			url: `data:text/html,${encodeURIComponent(fixture)}`,
			timeout: 20,
		});
		await test(tool, name);
	} finally {
		await tool.execute("codex-browser-close", { action: "close", name, kill: true }).catch(() => undefined);
	}
}

const SURFACE_PROBE = `
	const browserApi = agent.browser;
	const current = await browserApi.tabs.new();
	const locator = current.playwright.locator("body");
	const families = {
		browser: [browserApi, ["nameSession"]],
		tabs: [browserApi.tabs, ["new", "selected", "list", "get", "content"]],
		user: [browserApi.user, ["openTabs", "history"]],
		tab: [current, ["goto", "back", "forward", "reload", "close", "title", "url"]],
		content: [current.content, ["export", "exportGsuite"]],
		clipboard: [current.clipboard, ["read", "readText", "write", "writeText"]],
		dev: [current.dev, ["logs"]],
		playwright: [current.playwright, [
			"domSnapshot", "elementInfo", "elementScreenshot", "locator", "getByRole", "getByText",
			"getByLabel", "getByPlaceholder", "getByTestId", "frameLocator", "screenshot", "waitForURL",
			"waitForLoadState", "waitForTimeout", "expectNavigation", "waitForEvent"
		]],
		locator: [locator, [
			"all", "allTextContents", "and", "or", "filter", "locator", "first", "last", "nth", "count",
			"click", "dblclick", "downloadMedia", "fill", "type", "press", "selectOption", "check", "uncheck",
			"setChecked", "getAttribute", "innerText", "textContent", "isEnabled", "isVisible", "waitFor",
			"getByRole", "getByText", "getByLabel", "getByPlaceholder", "getByTestId", "frameLocator"
		]],
		cua: [current.cua, [
			"get_visible_screenshot", "click", "double_click", "drag", "keypress", "move", "scroll", "type", "downloadMedia"
		]],
		dom_cua: [current.dom_cua, [
			"get_visible_dom", "click", "double_click", "scroll", "type", "keypress", "downloadMedia"
		]],
	};
	const missing = {};
	for (const [family, [object, methods]] of Object.entries(families)) {
		missing[family] = methods.filter(method => typeof object?.[method] !== "function");
	}
	return {
		agentType: typeof agent,
		browserType: typeof browserApi,
		id: current.id,
		propertyFamilies: ["playwright", "cua", "dom_cua", "clipboard", "content", "dev"].filter(key => !current[key]),
		missing,
	};
`;

function expectCompleteSurface(value: {
	agentType: string;
	browserType: string;
	id: string;
	propertyFamilies: string[];
	missing: Record<string, string[]>;
}): void {
	expect(value.agentType).toBe("function");
	expect(value.browserType).toBe("object");
	expect(value.id).toMatch(/^[1-9]\d*$/);
	expect(value.propertyFamilies).toEqual([]);
	expect(value.missing).toEqual({
		browser: [],
		tabs: [],
		user: [],
		tab: [],
		content: [],
		clipboard: [],
		dev: [],
		playwright: [],
		locator: [],
		cua: [],
		dom_cua: [],
	});
}

class RecordingAdapter implements CodexBrowserAdapter {
	readonly currentTabId = "1";
	readonly calls: Array<{ operation: CodexBrowserOperation; args: Readonly<Record<string, unknown>> }> = [];
	readonly #respond: (
		operation: CodexBrowserOperation,
		args: Readonly<Record<string, unknown>>,
	) => unknown | Promise<unknown>;

	constructor(
		respond: (
			operation: CodexBrowserOperation,
			args: Readonly<Record<string, unknown>>,
		) => unknown | Promise<unknown> = operation => {
			if (operation === "tab.selected" || operation === "tab.new" || operation === "tab.get") return { id: "1" };
			if (operation === "tab.list") return [{ id: "1" }];
			return undefined;
		},
	) {
		this.#respond = respond;
	}

	async invoke<T>(operation: CodexBrowserOperation, args: Readonly<Record<string, unknown>>): Promise<T> {
		this.calls.push({ operation, args });
		return (await this.#respond(operation, args)) as T;
	}
}

async function caughtError(run: () => unknown | Promise<unknown>): Promise<{ name: string; message: string }> {
	try {
		await run();
		return { name: "NO_ERROR", message: "" };
	} catch (error) {
		return { name: (error as Error).name, message: (error as Error).message };
	}
}
async function assertLogicalTabLifecycle(tool: BrowserTool, name: string): Promise<void> {
	const first = await runJson<{
		oldId: string;
		freshId: string;
		selectedAfterClose: null;
		listedAfterClose: unknown[];
		missAfterClose: { name: string; message: string };
		staleAfterNew: { name: string; message: string };
		freshUrl: string;
	}>(
		tool,
		name,
		`await agent.browser.nameSession("  persistent contract name  ");
		 const oldTab = await agent.browser.tabs.selected();
		 globalThis.__codexStaleTab = oldTab;
		 await oldTab.close();
		 const selectedAfterClose = await agent.browser.tabs.selected() ?? null;
		 const listedAfterClose = await agent.browser.tabs.list();
		 let missAfterClose;
		 try { await agent.browser.tabs.get(oldTab.id); } catch (error) { missAfterClose = { name: error.name, message: error.message }; }
		 const fresh = await agent.browser.tabs.new();
		 let staleAfterNew;
		 try { await oldTab.url(); } catch (error) { staleAfterNew = { name: error.name, message: error.message }; }
		 return { oldId: oldTab.id, freshId: fresh.id, selectedAfterClose, listedAfterClose, missAfterClose, staleAfterNew, freshUrl: await fresh.url() };`,
	);

	expect(first.selectedAfterClose).toBeNull();
	expect(first.listedAfterClose).toEqual([]);
	expect(first.missAfterClose).toEqual({
		name: "Error",
		message: `tabs.get could not find tab id "${first.oldId}". Existing tabs: `,
	});
	expect(first.freshId).toMatch(/^[1-9]\d*$/);
	expect(Number(first.freshId)).toBe(Number(first.oldId) + 1);
	expect(first.freshUrl).toBeTruthy();
	expect(first.staleAfterNew).toEqual({
		name: "Error",
		message: `Browser tab id ${first.oldId} is stale; current tab id is ${first.freshId}`,
	});

	const second = await runJson<{
		selectedId: string;
		listedIds: string[];
		stale: { name: string; message: string };
		title: string;
	}>(
		tool,
		name,
		`const selected = await agent.browser.tabs.selected();
		 let stale;
		 try { await globalThis.__codexStaleTab.title(); } catch (error) { stale = { name: error.name, message: error.message }; }
		 return { selectedId: selected.id, listedIds: (await agent.browser.tabs.list()).map(tab => tab.id), stale, title: await selected.title() };`,
	);
	expect(second.selectedId).toBe(first.freshId);
	expect(second.listedIds).toEqual([first.freshId]);
	expect(second.stale).toEqual(first.staleAfterNew);
	expect(typeof second.title).toBe("string");

	await tool.execute("codex-browser-outer-close", { action: "close", name, kill: true });
	await tool.execute("codex-browser-outer-reopen", { action: "open", name });
	const reopened = await runJson<{ id: string; url: string }>(
		tool,
		name,
		"const selected = await agent.browser.tabs.selected(); return { id: selected.id, url: await selected.url() };",
	);
	expect(reopened.id).toMatch(/^[1-9]\d*$/);
	expect(reopened.url).toBeTruthy();
}

afterEach(async () => {
	vi.restoreAllMocks();
	await drainTabs();
});

describe("Codex agent.browser public contract", () => {
	it("publishes the canonical dev logs capability", () => {
		expect(CODEX_BROWSER_CAPABILITIES.DEV_LOGS).toBe("tab.dev.logs");
	});

	it("preserves callable agent and exposes the complete facade on the cmux adapter", async () => {
		await withCmuxTool(async (tool, name) => {
			const presence = await runJson<{ agentType: string; browserType: string }>(
				tool,
				name,
				"return { agentType: typeof agent, browserType: typeof agent.browser };",
			);
			expect(presence).toEqual({ agentType: "function", browserType: "object" });
			expectCompleteSurface(await runJson(tool, name, SURFACE_PROBE));
		});
	});

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"preserves callable agent and exposes the complete facade on the Puppeteer adapter",
		async () => {
			await withPuppeteerTool(async (tool, name) => {
				const presence = await runJson<{ agentType: string; browserType: string }>(
					tool,
					name,
					"return { agentType: typeof agent, browserType: typeof agent.browser };",
				);
				expect(presence).toEqual({ agentType: "function", browserType: "object" });
				expectCompleteSurface(await runJson(tool, name, SURFACE_PROBE));
			});
		},
		30_000,
	);

	it("trims session names, rejects blank names, and keeps one positive-integer-string current tab", async () => {
		await withCmuxTool(async (tool, name) => {
			const value = await runJson<{
				ids: string[];
				sameSelected: boolean;
				sameListed: boolean;
				sameLookup: boolean;
				errors: { name: string; message: string }[];
			}>(
				tool,
				name,
				`await agent.browser.nameSession("  contract session  ");
				 const created = await agent.browser.tabs.new();
				 const selected = await agent.browser.tabs.selected();
				 const listed = await agent.browser.tabs.list();
				 const fetched = await agent.browser.tabs.get(created.id);
				 const errors = [];
				 for (const invoke of [
					() => agent.browser.nameSession("  \\t\\n "),
					() => agent.browser.tabs.get(),
					() => agent.browser.tabs.get(""),
					() => agent.browser.tabs.get("0"),
					() => agent.browser.tabs.get("-1"),
					() => agent.browser.tabs.get("1.5"),
					() => agent.browser.tabs.get("tab-1"),
					() => agent.browser.tabs.get(1),
				 ]) {
					try { await invoke(); } catch (error) { errors.push({ name: error.name, message: error.message }); }
				 }
				 return {
					ids: [created.id, selected.id, ...listed.map(tab => tab.id), fetched.id],
					sameSelected: created === selected,
					sameListed: listed.length === 1 && listed[0].id === created.id,
					sameLookup: fetched === created,
					errors,
				 };`,
			);

			expect(value.ids).toHaveLength(4);
			for (const id of value.ids) expect(id).toMatch(/^[1-9]\d*$/);
			expect(new Set(value.ids).size).toBe(1);
			expect(value.sameSelected).toBe(true);
			expect(value.sameListed).toBe(true);
			expect(value.sameLookup).toBe(true);
			expect(value.errors).toHaveLength(8);
			expect(value.errors[0]).toEqual({ name: "Error", message: "browser.nameSession requires a name" });
			expect(value.errors.slice(1, 3)).toEqual([
				{ name: "Error", message: "tabs.get requires a tab id" },
				{ name: "Error", message: "tabs.get requires a tab id" },
			]);
			for (const error of value.errors.slice(3)) {
				expect(error.name).toBe("Error");
				expect(error.message).toMatch(/tabs\.get.*tab id/i);
			}
		});
	});

	it("applies 3s selector-action and 10s navigation defaults through the cmux adapter", async () => {
		await withCmuxTool(async (tool, name, calls) => {
			calls.length = 0;
			await runJson(
				tool,
				name,
				`const current = await agent.browser.tabs.selected();
				 await current.goto("https://fixture.test/next");
				 await current.playwright.locator("#target").click();
				 return { url: await current.url() };`,
			);

			const navigation = calls.find(call => call.method === "browser.navigate");
			const navigationTimeout = navigation?.timeoutMs;
			if (typeof navigationTimeout !== "number") throw new Error("Expected navigation timeout");
			expect(navigationTimeout).toBeGreaterThan(0);
			expect(navigationTimeout).toBeLessThanOrEqual(10_000);
			expect(calls.some(call => call.method === "browser.eval" && call.timeoutMs === 3_000)).toBe(true);
		});
	});

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"maps CUA mouse buttons 1/2/3 and rejects unsupported button values",
		async () => {
			await withPuppeteerTool(async (tool, name) => {
				const value = await runJson<{ buttons: number[]; errors: { name: string; message: string }[] }>(
					tool,
					name,
					`const current = await agent.browser.tabs.selected();
				 await page.evaluate(() => {
					globalThis.__buttons = [];
					document.querySelector("#target").addEventListener("mousedown", event => globalThis.__buttons.push(event.button));
				 });
				 const point = await page.evaluate(() => {
					const rect = document.querySelector("#target").getBoundingClientRect();
					return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
				 });
				 for (const button of [1, 2, 3]) await current.cua.click({ ...point, button });
				 const errors = [];
				 for (const button of [0, 4]) {
					try { await current.cua.click({ ...point, button }); }
					catch (error) { errors.push({ name: error.name, message: error.message }); }
				 }
				 return { buttons: await page.evaluate(() => globalThis.__buttons), errors };`,
				);
				expect(value.buttons).toEqual([0, 1, 2]);
				expect(value.errors).toHaveLength(2);
				for (const error of value.errors) {
					expect(error.name).toBe("Error");
					expect(error.message).toMatch(/button.*1.*2.*3/i);
				}
			});
		},
		30_000,
	);

	it("validates every dom_cua command before dispatch", async () => {
		await withCmuxTool(async (tool, name) => {
			const errors = await runJson<{ name: string; message: string }[]>(
				tool,
				name,
				`const dom = (await agent.browser.tabs.selected()).dom_cua;
				 const cases = [
					[() => dom.click({}), "dom_cua.click requires a node_id"],
					[() => dom.double_click({}), "dom_cua.double_click requires a node_id"],
					[() => dom.scroll({}), "dom_cua.scroll requires x and y numbers"],
					[() => dom.type({}), "dom_cua.type requires text"],
					[() => dom.keypress({ keys: [] }), "dom_cua.keypress requires a non-empty keys array"],
					[() => dom.downloadMedia({}), "dom_cua.downloadMedia requires a node_id"],
				 ];
				 const errors = [];
				 for (const [invoke, expected] of cases) {
					try { await invoke(); errors.push({ name: "NO_ERROR", message: expected }); }
					catch (error) { errors.push({ name: error.name, message: error.message }); }
				 }
				 return errors;`,
			);
			expect(errors).toEqual([
				{ name: "Error", message: "dom_cua.click requires a node_id" },
				{ name: "Error", message: "dom_cua.double_click requires a node_id" },
				{ name: "Error", message: "dom_cua.scroll requires x and y numbers" },
				{ name: "Error", message: "dom_cua.type requires text" },
				{ name: "Error", message: "dom_cua.keypress requires a non-empty keys array" },
				{ name: "Error", message: "dom_cua.downloadMedia requires a node_id" },
			]);
		});
	});

	it("validates browser, locator, clipboard, dev, event, and CUA inputs at the facade boundary", async () => {
		await withCmuxTool(async (tool, name) => {
			const value = await runJson<{
				emptyContent: unknown[];
				errors: { label: string; name: string; message: string }[];
			}>(
				tool,
				name,
				`const current = await agent.browser.tabs.selected();
				 const locator = current.playwright.locator("#target");
				 const emptyContent = await agent.browser.tabs.content({ urls: [], contentType: "html" });
				 const cases = [
					["tabs.content", () => agent.browser.tabs.content({ urls: ["https://fixture.test"], contentType: "xml" })],
					["tabs.content timeout", () => agent.browser.tabs.content({ urls: [], contentType: "html", timeoutMs: 0 })],
					["content.exportGsuite", () => current.content.exportGsuite("txt")],
					["clipboard.write", () => current.clipboard.write([])],
					["clipboard.write presentationStyle", () => current.clipboard.write([{ presentationStyle: "floating", entries: [{ mimeType: "text/plain", text: "value" }] }])],
					["dev.logs", () => current.dev.logs({ limit: 0 })],
					["playwright.waitForEvent", () => current.playwright.waitForEvent("dialog")],
					["locator.nth", () => locator.nth("1")],
					["locator.selectOption", () => locator.selectOption([])],
					["cua.click", () => current.cua.click({ x: 1, y: 1, button: 4 })],
					["cua.keypress", () => current.cua.keypress({ keys: [] })],
					["cua.drag", () => current.cua.drag({ path: [] })],
				 ];
				 const errors = [];
				 for (const [label, invoke] of cases) {
					try { await invoke(); errors.push({ label, name: "NO_ERROR", message: "" }); }
					catch (error) { errors.push({ label, name: error.name, message: error.message }); }
				 }
				 return { emptyContent, errors };`,
			);

			expect(value.emptyContent).toEqual([]);
			expect(value.errors).toHaveLength(12);
			for (const error of value.errors) {
				expect(error.name).toBe("Error");
				expect(error.message).toContain(error.label);
			}
			expect(value.errors.find(error => error.label === "playwright.waitForEvent")?.message).toBe(
				"playwright.waitForEvent only supports 'download' and 'filechooser'",
			);
		});
	});

	it("uses exact canonical capability errors for cmux and keeps backend-only gaps explicit", async () => {
		await withCmuxTool(async (tool, name) => {
			const result = await runJson<{
				openTabs: unknown[];
				exportPath: string;
				errors: Array<{ name: string; message: string }>;
			}>(
				tool,
				name,
				`const current = await agent.browser.tabs.selected();
				 const openTabs = await agent.browser.user.openTabs();
				 const exportPath = await current.content.export();
				 const calls = [
					() => agent.browser.user.history({ query: "fixture" }),
					() => current.content.exportGsuite("pdf"),
					() => current.playwright.waitForEvent("download"),
					() => current.playwright.waitForLoadState({ state: "networkidle" }),
					() => current.playwright.waitForURL("https://fixture.test", { waitUntil: "networkidle" }),
				 ];
				 const errors = [];
				 for (const invoke of calls) {
					try { await invoke(); errors.push({ name: "NO_ERROR", message: "" }); }
					catch (error) { errors.push({ name: error.name, message: error.message }); }
				 }
				 return { openTabs, exportPath, errors };`,
			);
			expect(Array.isArray(result.openTabs)).toBe(true);
			expect(typeof result.exportPath).toBe("string");
			expect(result.exportPath.length).toBeGreaterThan(0);
			expect(result.errors).toEqual([
				{ name: "BrowserCapabilityError", message: "Browser capability is unavailable: browser.user.history" },
				{ name: "BrowserCapabilityError", message: "Browser capability is unavailable: tab.content.exportGsuite" },
				{ name: "BrowserCapabilityError", message: "Browser capability is unavailable: playwright.waitForEvent" },
				{
					name: "BrowserCapabilityError",
					message: "Browser capability is unavailable: playwright.waitForLoadState networkidle",
				},
				{
					name: "BrowserCapabilityError",
					message: "Browser capability is unavailable: playwright.waitForURL networkidle",
				},
			]);
		});
	});

	it("keeps logical close/new state in adapter state without exposing session names to page evaluation", async () => {
		await withCmuxTool(async (tool, name, calls) => {
			await assertLogicalTabLifecycle(tool, name);
			const pageEvaluations = calls.filter(call => call.method === "browser.eval");
			expect(pageEvaluations.length).toBeGreaterThanOrEqual(2);
			for (const call of pageEvaluations) {
				const { script, ...pageArguments } = call.params;
				expect(String(script ?? "")).not.toContain("persistent contract name");
				expect(JSON.stringify(pageArguments)).not.toContain("persistent contract name");
			}
		});
	});

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"keeps logical close/new state across Puppeteer outer run cells",
		async () => {
			await withPuppeteerTool(async (tool, name) => await assertLogicalTabLifecycle(tool, name));
		},
		30_000,
	);

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"retains Puppeteer console logs across outer run cells",
		async () => {
			await withPuppeteerTool(async (tool, name) => {
				await runJson<boolean>(
					tool,
					name,
					`await page.evaluate(() => console.warn("persistent-codex-console")); await wait(20); return true;`,
				);
				const logs = await runJson<Array<{ level: string; text: string }>>(
					tool,
					name,
					`const current = await agent.browser.tabs.selected();
					 return await current.dev.logs({ filter: "persistent-codex-console", levels: ["warning"], limit: 1 });`,
				);
				expect(logs).toHaveLength(1);
				expect(logs[0]).toMatchObject({ level: "warn", text: "persistent-codex-console" });
			});
		},
		30_000,
	);

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"matches associated label text when aria-label differs",
		async () => {
			await withPuppeteerTool(async (tool, name) => {
				const result = await runJson<{ aria: number; associated: number }>(
					tool,
					name,
					`const current = await agent.browser.tabs.selected();
					 return {
						associated: await current.playwright.getByLabel("Associated Label", { exact: true }).count(),
						aria: await current.playwright.getByLabel("ARIA Name", { exact: true }).count(),
					 };`,
				);
				expect(result).toEqual({ associated: 1, aria: 1 });
			});
		},
		30_000,
	);

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"uses exact Puppeteer capabilities and resolves leaf text plus native implicit roles",
		async () => {
			await withPuppeteerTool(async (tool, name) => {
				const result = await runJson<{
					clicks: number;
					roles: Record<string, number>;
					capabilities: Array<{ name: string; message: string }>;
				}>(
					tool,
					name,
					`await page.evaluate(() => {
						globalThis.__leafClicks = 0;
						document.querySelector("#target").addEventListener("click", () => globalThis.__leafClicks++);
					 });
					 const current = await agent.browser.tabs.selected();
					 await current.playwright.getByText("Leaf action", { exact: true }).click();
					 const roles = {};
					 for (const [key, role, name] of [
						["heading", "heading", "Contract heading"], ["link", "link", "Documentation"],
						["textbox", "textbox", "Name"], ["checkbox", "checkbox", "Check"], ["radio", "radio", "Radio"],
						["combobox", "combobox", undefined], ["option", "option", "One"], ["img", "img", "Hero image"],
						["slider", "slider", "Range"], ["imageButton", "button", "Image Button"],
						["priorityTextbox", "textbox", "Labelled Priority"],
					 ]) roles[key] = await current.playwright.getByRole(role, name ? { name, exact: true } : {}).count();
					 const calls = [
						() => agent.browser.user.history({ query: "fixture" }),
						() => current.content.exportGsuite("pdf"),
					 ];
					 const capabilities = [];
					 for (const invoke of calls) {
						try { await invoke(); capabilities.push({ name: "NO_ERROR", message: "" }); }
						catch (error) { capabilities.push({ name: error.name, message: error.message }); }
					 }
					 return { clicks: await page.evaluate(() => globalThis.__leafClicks), roles, capabilities };`,
				);
				expect(result.clicks).toBe(1);
				expect(result.roles).toEqual({
					heading: 1,
					link: 1,
					textbox: 1,
					checkbox: 1,
					radio: 1,
					combobox: 1,
					option: 1,
					img: 1,
					slider: 1,
					imageButton: 1,
					priorityTextbox: 1,
				});
				expect(result.capabilities).toEqual([
					{ name: "BrowserCapabilityError", message: "Browser capability is unavailable: browser.user.history" },
					{
						name: "BrowserCapabilityError",
						message: "Browser capability is unavailable: tab.content.exportGsuite",
					},
				]);
			});
		},
		30_000,
	);

	it("normalizes cmux elementInfo and coordinate screenshot to the shared public DTOs", async () => {
		await withCmuxTool(async (tool, name) => {
			const result = await runJson<{ info: Array<Record<string, unknown>>; screenshot: string }>(
				tool,
				name,
				`const current = await agent.browser.tabs.selected();
				 return { info: await current.playwright.elementInfo({ x: 10, y: 10 }), screenshot: (await current.cua.get_visible_screenshot()).toBase64() };`,
			);
			expect(result.info).toHaveLength(1);
			expect(Object.keys(result.info[0] ?? {}).sort()).toEqual([
				"ariaName",
				"boundingBox",
				"preview",
				"role",
				"selector",
				"tagName",
				"testId",
				"visibleText",
			]);
			expect(result.info[0]).toMatchObject({
				tagName: "button",
				role: "button",
				visibleText: "Leaf action",
				ariaName: "Leaf action",
				testId: "target",
				boundingBox: { x: 0, y: 0, width: 120, height: 80 },
				selector: { candidates: expect.any(Array) },
			});
			expect(result.screenshot).toBe("aQ==");
		});
	});

	it("shares one cmux deadline across locator stages and URL/load-state stages", async () => {
		let now = 0;
		const timeouts: number[] = [];
		let loadStateTimeout = -1;
		spyOn(Date, "now").mockImplementation(() => now);
		const fakeTab = {
			surfaceId: "surface-contract",
			async codexEvaluate(_source: string, args: unknown[], timeoutMs: number) {
				timeouts.push(timeoutMs);
				if (args[1] === "status") {
					now = 2_500;
					return { attached: true, visible: true, enabled: true };
				}
				return true;
			},
			async click(_selector: string, timeoutMs: number) {
				timeouts.push(timeoutMs);
			},
			async codexUrl(timeoutMs: number) {
				timeouts.push(timeoutMs);
				now = 9_000;
				return "https://fixture.test/ready";
			},
			async codexWaitForLoadState(_state: string, timeoutMs: number) {
				loadStateTimeout = timeoutMs;
			},
		} as never;
		const adapter = new CmuxCodexBrowserAdapter(fakeTab);
		await adapter.invoke("locator.click", {
			tabId: "1",
			locator: { kind: "css", selector: "#target" },
			timeoutMs: 3_000,
		});
		expect(timeouts.slice(0, 2)).toEqual([3_000, 500]);

		now = 0;
		timeouts.length = 0;
		await adapter.invoke("playwright.waitForURL", {
			tabId: "1",
			url: { kind: "string", value: "https://fixture.test/ready", exact: true },
			waitUntil: "load",
			timeoutMs: 10_000,
		});
		expect(timeouts[0]).toBe(10_000);
		expect(loadStateTimeout).toBe(1_000);
	});

	it("accepts only the current-client networkidle wait state", async () => {
		const adapter = new RecordingAdapter();
		const current = await createCodexBrowserFacade(adapter).tabs.selected();
		if (!current) throw new Error("Expected selected contract tab");
		await current.playwright.waitForLoadState({ state: "networkidle" });
		await current.playwright.waitForURL("https://fixture.test", { waitUntil: "networkidle" });
		expect(await caughtError(() => current.playwright.waitForLoadState({ state: "networkidle0" } as never))).toEqual({
			name: "Error",
			message: "playwright.waitForLoadState state is invalid",
		});
		expect(
			await caughtError(() =>
				current.playwright.waitForURL("https://fixture.test", { waitUntil: "networkidle2" } as never),
			),
		).toEqual({ name: "Error", message: "playwright.waitForURL state is invalid" });
	});

	it("protects dblclick internals and validates the exact public option vocabulary", async () => {
		const adapter = new RecordingAdapter();
		const current = await createCodexBrowserFacade(adapter).tabs.selected();
		if (!current) throw new Error("Expected selected contract tab");
		const locator = current.playwright.locator("#target");
		const cases: Array<[unknown, string]> = [
			[{ button: "primary" }, "locator.dblclick button must be 'left', 'middle', or 'right'"],
			[
				{ modifiers: ["Command"] },
				"locator.dblclick modifiers must contain only Alt, Control, ControlOrMeta, Meta, or Shift",
			],
			[{ force: "yes" }, "locator.dblclick force must be a boolean"],
			[{ timeoutMs: 0 }, "locator.dblclick timeoutMs requires a positive integer"],
			[{ tabId: "999" }, "locator.dblclick does not accept tabId"],
			[{ locator: { kind: "css", selector: "#other" } }, "locator.dblclick does not accept locator"],
		];
		for (const [options, message] of cases) {
			expect(await caughtError(() => locator.dblclick(options as never))).toEqual({ name: "Error", message });
		}

		await locator.dblclick({ button: "right", modifiers: ["Alt", "ControlOrMeta", "Shift"], force: true });
		const call = adapter.calls.find(entry => entry.operation === "locator.dblclick");
		expect(call?.args).toMatchObject({
			tabId: "1",
			locator: { kind: "css", selector: "#target" },
			button: "right",
			modifiers: ["Alt", "ControlOrMeta", "Shift"],
			force: true,
			timeoutMs: 3_000,
		});
	});

	it("normalizes an empty-string selectOption value to an explicit value selection", async () => {
		const adapter = new RecordingAdapter(operation => {
			if (operation === "tab.selected") return { id: "1" };
			if (operation === "locator.selectOption") return [""];
			return undefined;
		});
		const current = await createCodexBrowserFacade(adapter).tabs.selected();
		if (!current) throw new Error("Expected selected contract tab");

		const locator = current.playwright.locator("#target");
		await expect(locator.selectOption("")).resolves.toEqual([""]);
		expect(adapter.calls.find(entry => entry.operation === "locator.selectOption")?.args).toMatchObject({
			selections: [{ value: "" }],
		});
		await expect(locator.selectOption({})).rejects.toThrow("locator.selectOption requires a value, label, or index");
		await expect(locator.selectOption([])).rejects.toThrow("locator.selectOption requires at least one selection");
		expect(adapter.calls.filter(entry => entry.operation === "locator.selectOption")).toHaveLength(1);
	});

	it("rejects expectNavigation promptly when navigation fails while its callback never resolves", async () => {
		const callback = Promise.withResolvers<void>();
		const adapter = new RecordingAdapter(operation => {
			if (operation === "tab.selected") return { id: "1" };
			if (operation === "playwright.expectNavigation") return Promise.reject(new Error("navigation timed out"));
			return undefined;
		});
		const current = await createCodexBrowserFacade(adapter).tabs.selected();
		if (!current) throw new Error("Expected selected contract tab");

		await expect(
			Promise.race([
				current.playwright.expectNavigation(() => callback.promise),
				Bun.sleep(50).then(() => {
					throw new Error("expectNavigation remained pending after navigation failed");
				}),
			]),
		).rejects.toThrow("navigation timed out");
	}, 500);

	it("settles expectNavigation waiters when callbacks fail and never emits an orphan rejection", async () => {
		const navigation = Promise.withResolvers<void>();
		const adapter = new RecordingAdapter(operation => {
			if (operation === "tab.selected") return { id: "1" };
			if (operation === "playwright.expectNavigation") return navigation.promise;
			return undefined;
		});
		const current = await createCodexBrowserFacade(adapter).tabs.selected();
		if (!current) throw new Error("Expected selected contract tab");
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown): void => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			await expect(
				current.playwright.expectNavigation(() => {
					queueMicrotask(() => navigation.reject(new Error("navigation waiter must be consumed")));
					throw new Error("callback failed");
				}),
			).rejects.toThrow("callback failed");
			for (let index = 0; index < 8; index++) await Promise.resolve();
			expect(unhandled).toEqual([]);
			expect(adapter.calls.filter(entry => entry.operation === "playwright.expectNavigation.cancel")).toHaveLength(
				1,
			);
		} finally {
			process.removeListener("unhandledRejection", onUnhandled);
		}
	}, 1_000);

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"enforces Puppeteer actionability, checked/select state, enabled state, clipboard errors, and CUA typing",
		async () => {
			await withPuppeteerTool(async (tool, name) => {
				const result = await runJson<{
					permanentErrors: Array<{ name: string; message: string }>;
					checkStates: boolean[];
					selectResult: string[];
					selectedValues: string[];
					enabled: boolean[];
					clipboard: Array<{ name: string; message: string }>;
					typing: {
						noFocus: Array<{ name: string; message: string }>;
						input: string;
						filledEditable: string;
						editable: string;
					};
				}>(
					tool,
					name,
					`const current = await agent.browser.tabs.selected();
					 const permanentErrors = [];
					 for (const invoke of [
						() => current.playwright.locator("#hidden").click({ timeoutMs: 100 }),
						() => current.playwright.locator("#disabled").click({ timeoutMs: 100 }),
						() => current.playwright.locator("#not-checkable").check(),
						() => current.playwright.locator("#not-checkable").uncheck(),
					 ]) {
						try { await invoke(); permanentErrors.push({ name: "NO_ERROR", message: "" }); }
						catch (error) { permanentErrors.push({ name: error.name, message: error.message }); }
					 }
					 const checkbox = current.playwright.locator("#check");
					 await checkbox.check();
					 const checked = await page.evaluate(() => document.querySelector("#check").checked);
					 await checkbox.uncheck();
					 const unchecked = await page.evaluate(() => document.querySelector("#check").checked);
					 await checkbox.setChecked(true, { force: true });
					 const forcedChecked = await page.evaluate(() => document.querySelector("#check").checked);
					 const selectResult = await current.playwright.locator("#single").selectOption(["one", "two"]);
					 const selectedValues = await page.evaluate(() => Array.from(document.querySelector("#single").selectedOptions, option => option.value));
					 const enabled = await Promise.all([
						current.playwright.locator("#target").isEnabled(),
						current.playwright.locator("#aria-disabled").isEnabled(),
						current.playwright.locator("#missing").isEnabled(),
					 ]);
					 await current.playwright.locator("#target").waitFor({ state: "visible", timeoutMs: 100 });
					 await current.playwright.locator("#missing").waitFor({ state: "detached", timeoutMs: 100 });
					 const clipboard = [];
					 for (const invoke of [
						() => current.clipboard.read(), () => current.clipboard.readText(),
						() => current.clipboard.write([{ entries: [{ mimeType: "text/plain", text: "x" }] }]),
						() => current.clipboard.writeText("x"),
					 ]) {
						try { await invoke(); clipboard.push({ name: "NO_ERROR", message: "" }); }
						catch (error) { clipboard.push({ name: error.name, message: error.message }); }
					 }
					 await page.evaluate(() => document.activeElement?.blur());
					 const noFocus = [];
					 for (const invoke of [() => current.cua.type({ text: "x" }), () => current.dom_cua.type({ text: "x" })]) {
						try { await invoke(); noFocus.push({ name: "NO_ERROR", message: "" }); }
						catch (error) { noFocus.push({ name: error.name, message: error.message }); }
					 }
					 await current.playwright.locator("#name").click(); await current.cua.type({ text: "input" });
					 await current.playwright.locator("#editable").fill("filled editable");
					 const filledEditable = await page.evaluate(() => document.querySelector("#editable").textContent);
					 await current.playwright.locator("#editable").click(); await current.dom_cua.type({ text: "editable" });
					 const typing = await page.evaluate(() => ({ input: document.querySelector("#name").value, editable: document.querySelector("#editable").textContent }));
					 return { permanentErrors, checkStates: [checked, unchecked, forcedChecked], selectResult, selectedValues, enabled, clipboard, typing: { noFocus, filledEditable, ...typing } };`,
				);
				expect(result.permanentErrors).toHaveLength(4);
				for (const error of result.permanentErrors.slice(0, 2)) {
					expect(error.name).toBe("Error");
					expect(error.message).toMatch(
						/visible|enabled|actionable|Locator operation timed out after 100ms|locator\.click timed out after 100ms/i,
					);
				}
				expect(result.permanentErrors.slice(2)).toEqual([
					{ name: "Error", message: "locator.setChecked requires a checkbox or radio input" },
					{ name: "Error", message: "locator.setChecked requires a checkbox or radio input" },
				]);
				expect(result.checkStates).toEqual([true, false, true]);
				expect(result.selectResult).toEqual(["one"]);
				expect(result.selectedValues).toEqual(["one"]);
				expect(result.enabled).toEqual([true, false, false]);
				expect(result.clipboard).toEqual([
					{ name: "BrowserCapabilityError", message: "Browser capability is unavailable: tab.clipboard.read" },
					{ name: "BrowserCapabilityError", message: "Browser capability is unavailable: tab.clipboard.readText" },
					{ name: "BrowserCapabilityError", message: "Browser capability is unavailable: tab.clipboard.write" },
					{
						name: "BrowserCapabilityError",
						message: "Browser capability is unavailable: tab.clipboard.writeText",
					},
				]);
				expect(result.typing.noFocus).toEqual([
					{ name: "Error", message: "cua.type requires an editable active element" },
					{ name: "Error", message: "dom_cua.type requires an editable active element" },
				]);
				expect(result.typing.filledEditable).toBe("filled editable");
				expect(result.typing.input).toBe("input");
				expect(result.typing.editable).toBe("filled editableeditable");
			});
		},
		30_000,
	);

	it("validates clipboard entry exclusivity and DOM CUA node ids before adapter dispatch", async () => {
		const adapter = new RecordingAdapter();
		const current = await createCodexBrowserFacade(adapter).tabs.selected();
		if (!current) throw new Error("Expected selected contract tab");
		const errors = await Promise.all([
			caughtError(() =>
				current.clipboard.write([{ entries: [{ mimeType: "text/plain", text: "x", base64: "eA==" }] }] as never),
			),
			caughtError(() => current.clipboard.write([{ entries: [{ mimeType: "text/plain" }] }] as never)),
			caughtError(() =>
				current.clipboard.write([
					{
						entries: [
							{ mimeType: "text/plain", text: "first" },
							{ mimeType: "text/plain", text: "second" },
						],
					},
				]),
			),
			caughtError(() => current.dom_cua.click({ node_id: 7 } as never)),
			caughtError(() => current.dom_cua.double_click({ node_id: false } as never)),
		]);
		expect(errors).toEqual([
			{ name: "Error", message: "clipboard.write entry requires exactly one of text or base64" },
			{ name: "Error", message: "clipboard.write entry requires exactly one of text or base64" },
			{ name: "Error", message: "clipboard.write item contains duplicate mimeType text/plain" },
			{ name: "Error", message: "dom_cua.click requires a node_id" },
			{ name: "Error", message: "dom_cua.double_click requires a node_id" },
		]);
		expect(
			adapter.calls.filter(call => call.operation === "tab.clipboard.write" || call.operation === "dom_cua.click"),
		).toEqual([]);
	});

	it("closes a Puppeteer content page that resolves after cancellation", async () => {
		const controller = new AbortController();
		const pageCreated = Promise.withResolvers<unknown>();
		let lateCloseCount = 0;
		const mainPage = {
			on: () => undefined,
			off: () => undefined,
			url: () => "https://fixture.test/start",
		} as never;
		const browser = { newPage: () => pageCreated.promise } as never;
		const adapter = new PuppeteerCodexBrowserAdapter({
			currentTabId: "1",
			page: mainPage,
			browser,
			signal: controller.signal,
			cwd: "/tmp/browser-contract",
			captureScreenshot: async () => "",
		});
		const pending = adapter.invoke("tabs.content", {
			urls: ["https://fixture.test/late"],
			contentType: "html",
			timeoutMs: 1_000,
		});
		controller.abort(new Error("contract cancellation"));
		await expect(pending).rejects.toBeDefined();
		pageCreated.resolve({
			close: async () => {
				lateCloseCount++;
			},
		});
		for (let index = 0; index < 8; index++) await Promise.resolve();
		expect(lateCloseCount).toBe(1);
		adapter.dispose();
	});

	it("disposes every Puppeteer handle when semantic resolution fails partway", async () => {
		const disposals = [0, 0, 0];
		const handles = [
			{
				evaluate: async () => ({ role: "div", name: "" }),
				dispose: async () => {
					disposals[0]++;
				},
			},
			{
				evaluate: async () => {
					throw new Error("detached during semantic scan");
				},
				dispose: async () => {
					disposals[1]++;
				},
			},
			{
				evaluate: async () => ({ role: "button", name: "Target" }),
				dispose: async () => {
					disposals[2]++;
				},
			},
		] as never[];
		const page = {
			on: () => undefined,
			off: () => undefined,
			$$: async () => handles,
		} as never;
		const adapter = new PuppeteerCodexBrowserAdapter({
			currentTabId: "1",
			page,
			browser: {} as never,
			signal: new AbortController().signal,
			cwd: "/tmp/browser-contract",
			captureScreenshot: async () => "",
		});
		await expect(
			adapter.invoke("locator.count", {
				tabId: "1",
				locator: { kind: "role", role: "button" },
			}),
		).rejects.toThrow("detached during semantic scan");
		expect(disposals).toEqual([1, 1, 1]);
		adapter.dispose();
	});

	it("rejects cmux download waits before invoking an unacknowledged transport", async () => {
		let waitCalls = 0;
		const fakeTab = {
			surfaceId: "surface-contract",
			async codexDownloadWait() {
				waitCalls++;
				return { download: {} };
			},
		} as never;
		const adapter = new CmuxCodexBrowserAdapter(fakeTab);
		expect(
			await caughtError(() =>
				adapter.invoke("playwright.waitForEvent", {
					tabId: "1",
					event: "download",
					timeoutMs: 3_000,
				}),
			),
		).toEqual({
			name: "BrowserCapabilityError",
			message: "Browser capability is unavailable: playwright.waitForEvent",
		});
		expect(waitCalls).toBe(0);
	});

	it("settles file-chooser and click deadlines while safely releasing deferred side effects", async () => {
		vi.useFakeTimers();
		try {
			const accepted = Promise.withResolvers<void>();
			const clicked = Promise.withResolvers<void>();
			const handle = {
				click: () => clicked.promise,
				dispose: async () => undefined,
			} as never;
			const chooser = {
				isMultiple: () => false,
				accept: () => accepted.promise,
			} as never;
			const page = {
				on: () => undefined,
				off: () => undefined,
				url: () => "https://fixture.test/start",
				title: async () => "Fixture",
				waitForFileChooser: async () => chooser,
				$$: async () => [handle],
			} as never;
			const adapter = new PuppeteerCodexBrowserAdapter({
				currentTabId: "1",
				page,
				browser: {} as never,
				signal: new AbortController().signal,
				cwd: "/tmp/browser-contract",
				captureScreenshot: async () => "",
			});
			const current = await createCodexBrowserFacade(adapter).tabs.selected();
			if (!current) throw new Error("Expected selected contract tab");
			const fileChooser = await current.playwright.waitForEvent("filechooser", { timeoutMs: 100 });
			if (!("setFiles" in fileChooser)) throw new Error("Expected file chooser event");
			let chooserSettled = false;
			const setFiles = fileChooser.setFiles("fixture.txt", { timeoutMs: 100 }).then(
				() => {
					chooserSettled = true;
				},
				() => {
					chooserSettled = true;
				},
			);
			let clickSettled = false;
			const click = current.playwright
				.locator("#target")
				.click({ timeoutMs: 100 })
				.then(
					() => {
						clickSettled = true;
					},
					() => {
						clickSettled = true;
					},
				);
			vi.advanceTimersByTime(100);
			for (let index = 0; index < 12; index++) await Promise.resolve();
			expect(chooserSettled).toBe(true);
			expect(clickSettled).toBe(true);
			accepted.resolve();
			clicked.resolve();
			await Promise.all([setFiles, click]);
			adapter.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	it("hides backend media paths and resolves public downloadMedia calls with undefined", async () => {
		const adapter = new RecordingAdapter(operation => {
			if (operation === "tab.selected") return { id: "1" };
			if (operation.endsWith("downloadMedia")) return "/tmp/internal-media-path";
			return undefined;
		});
		const current = await createCodexBrowserFacade(adapter).tabs.selected();
		if (!current) throw new Error("Expected selected contract tab");
		expect(
			await Promise.all([
				current.playwright.locator("img").downloadMedia(),
				current.dom_cua.downloadMedia({ node_id: "node-1" }),
				current.cua.downloadMedia({ x: 1, y: 2 }),
			]),
		).toEqual([undefined, undefined, undefined]);
	});

	it("never navigates the selected cmux surface to implement tabs.content", async () => {
		let selectedNavigations = 0;
		const fakeTab = {
			surfaceId: "surface-contract",
			async goto() {
				selectedNavigations++;
			},
			async codexUrl() {
				return "https://fixture.test/start";
			},
			async title() {
				return "Fixture";
			},
			async pageContent() {
				return "<main>Fixture</main>";
			},
		} as never;
		const adapter = new CmuxCodexBrowserAdapter(fakeTab);
		const outcome = await caughtError(() =>
			adapter.invoke("tabs.content", {
				urls: ["https://fixture.test/other"],
				contentType: "html",
				timeoutMs: 1_000,
			}),
		);
		expect(selectedNavigations).toBe(0);
		if (outcome.name !== "NO_ERROR") {
			expect(outcome).toEqual({
				name: "BrowserCapabilityError",
				message: "Browser capability is unavailable: tabs.content",
			});
		}
	});

	it("uses the native cmux reload operation without replacement navigation", async () => {
		await withCmuxTool(async (tool, name, calls) => {
			calls.length = 0;
			const outcome = await caughtError(() =>
				tool.execute("codex-browser-reload", {
					action: "run",
					name,
					code: "const current = await agent.browser.tabs.selected(); await current.reload();",
				}),
			);
			expect(outcome).toEqual({ name: "NO_ERROR", message: "" });
			expect(calls.some(call => call.method === "browser.navigate")).toBe(false);
			expect(calls.some(call => call.method === "browser.reload")).toBe(true);
		});
	});

	it("routes cmux locator type and press through native input primitives without dropping boundary spaces", async () => {
		const nativeCalls: Array<{ operation: string; args: unknown[] }> = [];
		let editableValue = "";
		const fakeTab = {
			surfaceId: "surface-contract",
			async codexEvaluate(_source: string, args: unknown[]) {
				if (args[1] === "status") return { attached: true, visible: true, enabled: true };
				if (args[1] === "editableValue") return editableValue;
				if (args.length === 1) editableValue += String(args[0]);
				nativeCalls.push({ operation: "evaluate", args });
				return true;
			},
			async type(selector: string, text: string) {
				nativeCalls.push({ operation: "type", args: [selector, text] });
				editableValue += text;
			},
			async focus(selector: string) {
				nativeCalls.push({ operation: "focus", args: [selector] });
			},
			async press(key: string) {
				nativeCalls.push({ operation: "press", args: [key] });
			},
		} as never;
		const adapter = new CmuxCodexBrowserAdapter(fakeTab);
		await adapter.invoke("locator.type", {
			tabId: "1",
			locator: { kind: "css", selector: "#name" },
			value: " ab ",
			timeoutMs: 3_000,
		});
		await adapter.invoke("locator.press", {
			tabId: "1",
			locator: { kind: "css", selector: "#name" },
			value: "Backspace",
			timeoutMs: 3_000,
		});
		expect(nativeCalls).toEqual([
			{ operation: "focus", args: ["#name"] },
			{ operation: "evaluate", args: [" "] },
			{ operation: "type", args: ["#name", "ab"] },
			{ operation: "evaluate", args: [" "] },
			{ operation: "focus", args: ["#name"] },
			{ operation: "press", args: ["Backspace"] },
		]);
	});

	it("does not begin a cmux locator side effect after its single deadline expires", async () => {
		let now = 0;
		let actionCount = 0;
		spyOn(Date, "now").mockImplementation(() => now);
		const fakeTab = {
			surfaceId: "surface-contract",
			async codexEvaluate(_source: string, args: unknown[]) {
				if (args[1] === "status") {
					now = 3_001;
					return { attached: true, visible: true, enabled: true };
				}
				actionCount++;
				return true;
			},
		} as never;
		const adapter = new CmuxCodexBrowserAdapter(fakeTab);
		await expect(
			adapter.invoke("locator.click", {
				tabId: "1",
				locator: { kind: "css", selector: "#target" },
				timeoutMs: 3_000,
			}),
		).rejects.toThrow(/timed out/i);
		expect(actionCount).toBe(0);
	});

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"returns Puppeteer element and screenshot DTOs plus exported content paths",
		async () => {
			await withPuppeteerTool(async (tool, name) => {
				const result = await runJson<{
					info: Array<Record<string, unknown>>;
					coordinateScreenshot: string;
					playwrightBase64: string;
					exportPath: string;
				}>(
					tool,
					name,
					`const current = await agent.browser.tabs.selected();
					 const point = await page.evaluate(() => {
						const rect = document.querySelector("#target span").getBoundingClientRect();
						return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
					 });
					 const image = await current.playwright.screenshot();
					 return {
						info: await current.playwright.elementInfo(point),
						coordinateScreenshot: (await current.cua.get_visible_screenshot()).toBase64(),
						playwrightBase64: image.toBase64(),
						exportPath: await current.content.export(),
					 };`,
				);
				expect(result.info).toHaveLength(1);
				expect(Object.keys(result.info[0] ?? {}).sort()).toEqual([
					"ariaName",
					"boundingBox",
					"preview",
					"role",
					"selector",
					"tagName",
					"testId",
					"visibleText",
				]);
				expect(result.info[0]).toMatchObject({
					tagName: "button",
					role: "button",
					visibleText: "Leaf action",
					ariaName: "Leaf action",
					testId: "target",
					selector: { candidates: expect.any(Array) },
				});
				expect(result.coordinateScreenshot.length).toBeGreaterThan(0);
				expect(result.playwrightBase64.length).toBeGreaterThan(0);
				expect(result.exportPath).toEqual(expect.any(String));
				expect(result.exportPath).not.toContain("<html");
			});
		},
		30_000,
	);

	it("preserves selected cmux state and normalizes per-URL tabs.content failures", async () => {
		await withCmuxTool(async (tool, name) => {
			const result = await runJson<{
				before: string;
				after: string;
				rows: Array<{ url: string; title: string | null; content: string | null }>;
			}>(
				tool,
				name,
				`const selected = await agent.browser.tabs.selected();
				 const before = await selected.url();
				 const rows = await agent.browser.tabs.content({
					urls: ["https://fixture.test/other", "https://fixture.test/fail"],
					contentType: "html",
					timeoutMs: 1_000,
				 });
				 return { before, after: await selected.url(), rows };`,
			);
			expect(result.after).toBe(result.before);
			expect(result.rows).toEqual([
				{
					url: "https://fixture.test/other",
					title: "Contract fixture",
					content: "<main><button id='target'>Target</button><input aria-label='Name'></main>",
				},
				{ url: "https://fixture.test/fail", title: null, content: null },
			]);
		});
	});

	it("fails inaccessible cmux frame locators immediately with the canonical capability", async () => {
		const fakeTab = {
			surfaceId: "surface-contract",
			async codexEvaluate(_source: string, args: unknown[]) {
				const descriptor = args[0] as { kind?: string } | undefined;
				if (descriptor?.kind === "frame") throw new Error("cross-origin frame access denied");
				return 0;
			},
		} as never;
		const adapter = new CmuxCodexBrowserAdapter(fakeTab);
		expect(
			await caughtError(() =>
				adapter.invoke("locator.count", {
					tabId: "1",
					locator: { kind: "frame", selector: "iframe" },
				}),
			),
		).toEqual({
			name: "BrowserCapabilityError",
			message: "Browser capability is unavailable: playwright.frameLocator cross-origin",
		});
	});

	it("ends cmux page observers when the run-scoped adapter is disposed", async () => {
		let evaluationCount = 0;
		const fakeTab = {
			surfaceId: "surface-contract",
			async codexEvaluate() {
				evaluationCount++;
				return 0;
			},
		} as never;
		const adapter = new CmuxCodexBrowserAdapter(fakeTab);
		await adapter.prepare();
		const beforeDispose = evaluationCount;
		const disposable = adapter as unknown as { dispose?: () => Promise<void> };
		expect(typeof disposable.dispose).toBe("function");
		await disposable.dispose?.();
		expect(evaluationCount).toBeGreaterThan(beforeDispose);
	});

	it("transfers Puppeteer media in bounded base64 chunks without per-byte arrays", async () => {
		const media = { contentType: "application/octet-stream", base64Chunks: ["AAEC", "AwQ="] } as Record<
			string,
			unknown
		>;
		Object.defineProperty(media, "bytes", {
			get() {
				throw new Error("per-byte media transport was accessed");
			},
		});
		const handle = {
			evaluate: async () => media,
			dispose: async () => undefined,
		} as never;
		const page = {
			on: () => undefined,
			off: () => undefined,
			url: () => "https://fixture.test/start",
			title: async () => "Fixture",
			$$: async () => [handle],
		} as never;
		const writes: Buffer[] = [];
		const fileHandle = {
			fd: 42,
			writeFile: async (data: Uint8Array) => {
				const bytes = Buffer.from(data);
				writes.push(bytes);
				return { bytesWritten: bytes.byteLength, buffer: data };
			},
			sync: async () => undefined,
			close: async () => undefined,
		};
		spyOn(fs.promises, "open").mockResolvedValue(fileHandle as never);
		spyOn(fs.promises, "rename").mockResolvedValue(undefined);
		const adapter = new PuppeteerCodexBrowserAdapter({
			currentTabId: "1",
			page,
			browser: {} as never,
			signal: new AbortController().signal,
			cwd: "/tmp/browser-contract",
			captureScreenshot: async () => "",
		});
		const current = await createCodexBrowserFacade(adapter).tabs.selected();
		if (!current) throw new Error("Expected selected contract tab");
		expect(await current.playwright.locator("img").downloadMedia()).toBeUndefined();
		expect(Buffer.concat(writes)).toEqual(Buffer.from([0, 1, 2, 3, 4]));
		adapter.dispose();
	});

	it("removes partial Puppeteer media output when chunk transfer is aborted", async () => {
		const controller = new AbortController();
		const handle = {
			evaluate: async () => ({ contentType: "application/octet-stream", base64Chunks: ["AAEC", "AwQ=", "BQY="] }),
			dispose: async () => undefined,
		} as never;
		const page = {
			on: () => undefined,
			off: () => undefined,
			url: () => "https://fixture.test/start",
			title: async () => "Fixture",
			$$: async () => [handle],
		} as never;
		let writeCount = 0;
		const fileHandle = {
			fd: 42,
			writeFile: async (data: Uint8Array) => {
				writeCount++;
				if (writeCount === 1) controller.abort(new Error("stop chunk transfer"));
				return { bytesWritten: data.byteLength, buffer: data };
			},
			sync: async () => undefined,
			close: async () => undefined,
		};
		spyOn(fs.promises, "open").mockResolvedValue(fileHandle as never);
		spyOn(fs.promises, "rename").mockResolvedValue(undefined);
		const removeSpy = spyOn(fs.promises, "rm").mockResolvedValue(undefined);
		const adapter = new PuppeteerCodexBrowserAdapter({
			currentTabId: "1",
			page,
			browser: {} as never,
			signal: controller.signal,
			cwd: "/tmp/browser-contract",
			captureScreenshot: async () => "",
		});
		const current = await createCodexBrowserFacade(adapter).tabs.selected();
		if (!current) throw new Error("Expected selected contract tab");
		await expect(current.playwright.locator("img").downloadMedia()).rejects.toBeDefined();
		expect(writeCount).toBe(1);
		expect(removeSpy).toHaveBeenCalledTimes(1);
		adapter.dispose();
	});

	it("bounds cmux native logs across repeated observer installation", async () => {
		let observerInstallCount = 0;
		const retained = Array.from({ length: 5_000 }, (_, index) => ({ level: "log", text: `entry-${index}` }));
		const fakeTab = {
			surfaceId: "surface-contract",
			async codexEvaluate(source: string) {
				if (source.includes("globalThis.__ompCodexBrowserState = state")) observerInstallCount++;
				return 0;
			},
			async codexRequest(method: string) {
				if (method === "browser.console.list") return { entries: retained };
				if (method === "browser.errors.list") return { entries: [], errors: [] };
				throw new Error(`Unexpected cmux RPC: ${method}`);
			},
		} as never;
		const adapter = new CmuxCodexBrowserAdapter(fakeTab);
		await adapter.prepare();
		await adapter.prepare();
		const logs = await adapter.invoke<unknown[]>("tab.dev.logs", { tabId: "1" });
		expect(observerInstallCount).toBeGreaterThanOrEqual(2);
		expect(logs.length).toBeLessThanOrEqual(1_000);
	});
});
