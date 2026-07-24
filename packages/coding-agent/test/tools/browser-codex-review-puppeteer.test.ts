import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { BrowserTool } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { createCodexBrowserFacade } from "@oh-my-pi/pi-coding-agent/tools/browser/codex-facade";
import {
	attachPuppeteerCodexLogCapture,
	createPuppeteerCodexSessionState,
	detachPuppeteerCodexLogCapture,
	PuppeteerCodexBrowserAdapter,
} from "@oh-my-pi/pi-coding-agent/tools/browser/codex-puppeteer";
import { ensureChromiumExecutable } from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import { releaseTab } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";

function browserSession(): ToolSession {
	return {
		cwd: "/tmp/browser-contract",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "browser.cmux": false, "browser.headless": true }),
	} as ToolSession;
}

function browserText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(
			(entry): entry is { type: "text"; text: string } => entry.type === "text" && typeof entry.text === "string",
		)
		.map(entry => entry.text)
		.join("\n");
}

async function runBrowserCode(tool: BrowserTool, name: string, code: string, timeout = 2): Promise<unknown> {
	const result = await tool.execute("codex-browser-contract", { action: "run", name, code, timeout });
	return JSON.parse(browserText(result));
}
async function withPuppeteerTool(test: (tool: BrowserTool, name: string) => Promise<void>): Promise<void> {
	const executable = await ensureChromiumExecutable().catch(() => null);
	if (!executable || Bun.spawnSync([executable, "--version"], { stdout: "ignore", stderr: "ignore" }).exitCode !== 0)
		return;
	const tool = new BrowserTool(browserSession());
	const name = `puppeteer-regression-${crypto.randomUUID()}`;
	const fixture = `<style>
		body{margin:0;padding-top:90px}
		#heading{position:absolute;left:0;top:0;width:120px;height:30px;margin:0}
		#hero{position:absolute;left:0;top:40px;width:40px;height:30px}
		.gone{display:none}
		#scrollbox{width:120px;height:40px;overflow:auto}
		#scrollcontent{height:200px}
	</style>
	<h1 id="heading">Heading</h1><img id="no-alt" alt=""><img id="hero" alt="Hero">
	<input id="text" aria-label="Text"><input id="search" type="search" aria-label="Search">
	<input id="number" type="number" aria-label="Number"><input id="password" type="password" aria-label="Secret">
	<input id="listed" list="suggestions" aria-label="Listed"><datalist id="suggestions"><option value="One"></datalist>
	<input id="date" type="date" aria-label="Date"><input id="file" type="file">
	<button id="go">Go</button><button class="gone">Display Hidden</button><button aria-hidden="true">ARIA Hidden</button>
	<div id="plain">Plain target</div><div id="editable" contenteditable="true">edit</div>
	<ul><li>One Item</li></ul><button id="icon-button"><img alt="Save"></button><div>Mixed   Case Text</div><div inert><button>Inert Hidden</button></div>
	<input id="aria-readonly-input" aria-readonly=" TrUe " value="locked"><div id="aria-readonly-editable" contenteditable="true" aria-readonly="TRUE">locked content</div>
	<iframe id="only-frame" srcdoc="<button id='frame-button'>Frame target</button>"></iframe>
	<div id="button-row"><button id="stable">Stable target</button><button id="other">Other target</button></div>
	<div id="scrollbox" tabindex="0"><div id="scrollcontent">Scroll content</div></div>
	<select id="choices"><option>One</option></select>`;
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
		await releaseTab(name, { kill: true }).catch(() => undefined);
	}
}

type CdpListener = (event: Record<string, unknown>) => void;

type PathOutcome = { status: "fulfilled"; value: string | null } | { status: "rejected"; message: string };

class DownloadSessionDouble {
	readonly calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
	readonly #listeners = new Map<string, Set<CdpListener>>();
	readonly downloadListenerRegistered = Promise.withResolvers<void>();
	readonly detached = Promise.withResolvers<void>();
	detachCount = 0;

	constructor(private readonly sendHook?: (method: string, params?: Record<string, unknown>) => Promise<void>) {}

	async send(method: string, params?: Record<string, unknown>): Promise<void> {
		this.calls.push({ method, params });
		await this.sendHook?.(method, params);
	}

	on(event: string, listener: CdpListener): this {
		let listeners = this.#listeners.get(event);
		if (!listeners) {
			listeners = new Set();
			this.#listeners.set(event, listeners);
		}
		listeners.add(listener);
		if (event === "Browser.downloadWillBegin") this.downloadListenerRegistered.resolve();
		return this;
	}

	off(event: string, listener: CdpListener): this {
		this.#listeners.get(event)?.delete(listener);
		return this;
	}

	emit(event: string, value: Record<string, unknown>): void {
		for (const listener of [...(this.#listeners.get(event) ?? [])]) listener(value);
	}

	async detach(): Promise<void> {
		this.detachCount++;
		this.detached.resolve();
	}
}

function pathOutcome(promise: Promise<string | null>): Promise<PathOutcome> {
	return promise.then(
		value => ({ status: "fulfilled", value }),
		error => ({ status: "rejected", message: error instanceof Error ? error.message : String(error) }),
	);
}

async function flushMicrotasks(): Promise<void> {
	for (let index = 0; index < 8; index++) await Promise.resolve();
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("Puppeteer Codex log capture", () => {
	it("captures uncaught page exceptions and detaches the exception listener", async () => {
		const session = new DownloadSessionDouble();
		const state = createPuppeteerCodexSessionState();
		const page = { target: () => ({ createCDPSession: async () => session }) } as never;

		await attachPuppeteerCodexLogCapture(page, state);
		session.emit("Runtime.exceptionThrown", {
			exceptionDetails: {
				text: "Uncaught ReferenceError: missingValue is not defined",
				exception: { type: "object", description: "ReferenceError: missingValue is not defined" },
			},
		});
		session.emit("Runtime.exceptionThrown", {
			exceptionDetails: {
				text: "",
				exception: { type: "object", description: "TypeError: detailed exception" },
			},
		});

		expect(state.logs.map(({ level, text }) => ({ level, text }))).toEqual([
			{ level: "error", text: "Uncaught ReferenceError: missingValue is not defined" },
			{ level: "error", text: "TypeError: detailed exception" },
		]);
		await detachPuppeteerCodexLogCapture(state);
		session.emit("Runtime.exceptionThrown", {
			exceptionDetails: { text: "Uncaught Error: detached listener" },
		});
		expect(state.logs).toHaveLength(2);
		expect(session.detachCount).toBe(1);
	});
});

describe("Puppeteer Codex download adapter", () => {
	it("lazily establishes download readiness before exposing the first waiter", async () => {
		spyOn(fs.promises, "mkdir").mockResolvedValue(undefined);
		const enableStarted = Promise.withResolvers<void>();
		const releaseEnable = Promise.withResolvers<void>();
		const session = new DownloadSessionDouble(async (method, params) => {
			if (method === "Browser.setDownloadBehavior" && params?.behavior === "allow") {
				enableStarted.resolve();
				await releaseEnable.promise;
			}
		});
		let createSessionCount = 0;
		const adapter = new PuppeteerCodexBrowserAdapter({
			currentTabId: "1",
			page: { url: () => "https://fixture.test/download", title: async () => "Download fixture" } as never,
			browser: {
				target: () => ({
					createCDPSession: async () => {
						createSessionCount++;
						return session;
					},
				}),
			} as never,
			signal: new AbortController().signal,
			cwd: ".",
			captureScreenshot: async () => "",
		});

		try {
			await adapter.beginRun();
			expect(createSessionCount).toBe(0);
			const tab = await createCodexBrowserFacade(adapter).tabs.selected();
			if (!tab) throw new Error("Expected selected Puppeteer tab");

			const waiting = tab.playwright.waitForEvent("download", { timeoutMs: 100 });
			await enableStarted.promise;
			expect(createSessionCount).toBe(1);
			releaseEnable.resolve();
			await session.downloadListenerRegistered.promise;
			session.emit("Browser.downloadWillBegin", {
				guid: "immediate-download",
				suggestedFilename: "immediate.txt",
			});
			const download = await waiting;
			if (!("path" in download)) throw new Error("Expected an immediate download event");
			session.emit("Browser.downloadProgress", { guid: "immediate-download", state: "completed" });
			expect(path.basename((await download.path({ timeoutMs: 100 })) ?? "")).toBe("immediate.txt");
		} finally {
			releaseEnable.resolve();
			await adapter.dispose();
		}
	});
	it("shares one completed download across concurrent waitForEvent waiters", async () => {
		vi.useFakeTimers();
		spyOn(fs.promises, "mkdir").mockResolvedValue(undefined);
		const session = new DownloadSessionDouble();
		const browser = {
			target: () => ({ createCDPSession: async () => session }),
		} as never;
		const page = {
			url: () => "https://fixture.test/download",
			title: async () => "Download fixture",
		} as never;
		const adapter = new PuppeteerCodexBrowserAdapter({
			currentTabId: "1",
			page,
			browser,
			signal: new AbortController().signal,
			cwd: ".",
			captureScreenshot: async () => "",
		});

		try {
			const tab = await createCodexBrowserFacade(adapter).tabs.selected();
			if (!tab) throw new Error("Expected selected Puppeteer tab");

			const firstWaiter = tab.playwright.waitForEvent("download", { timeoutMs: 100 });
			await session.downloadListenerRegistered.promise;
			const secondWaiter = tab.playwright.waitForEvent("download", { timeoutMs: 100 });
			await flushMicrotasks();

			session.emit("Browser.downloadWillBegin", {
				guid: "shared-download",
				suggestedFilename: "fixture.txt",
			});
			const [firstDownload, secondDownload] = await Promise.all([firstWaiter, secondWaiter]);
			if (!("path" in firstDownload) || !("path" in secondDownload)) {
				throw new Error("Expected download events");
			}

			const outcomesPromise = Promise.all([
				pathOutcome(firstDownload.path({ timeoutMs: 100 })),
				pathOutcome(secondDownload.path({ timeoutMs: 100 })),
			]);
			session.emit("Browser.downloadProgress", { guid: "shared-download", state: "completed" });
			await Promise.resolve();
			vi.advanceTimersByTime(100);
			const outcomes = await outcomesPromise;

			if (outcomes[0].status !== "fulfilled" || outcomes[1].status !== "fulfilled") {
				throw new Error(`Expected both download.path() calls to fulfill, received ${JSON.stringify(outcomes)}`);
			}
			expect(outcomes[0].value).toBe(outcomes[1].value);
			expect(path.basename(outcomes[0].value ?? "")).toBe("fixture.txt");

			const configurationCalls = session.calls.filter(call => call.method === "Browser.setDownloadBehavior");
			expect(configurationCalls).toHaveLength(1);
			expect(configurationCalls[0]?.params).toMatchObject({
				behavior: "allow",
				eventsEnabled: true,
				downloadPath: path.dirname(outcomes[0].value ?? ""),
			});
		} finally {
			await adapter.dispose();
		}
	});

	it("uses one shrinking tabs.content deadline for acquisition and every content phase, then a fresh cleanup bound", async () => {
		vi.useFakeTimers();
		let now = 0;
		spyOn(Date, "now").mockImplementation(() => now);
		type Phase = "acquisition" | "title" | "snapshot" | "evaluate" | "content";
		const phases: Phase[] = ["acquisition", "title", "snapshot", "evaluate", "content"];
		const observations: Array<{
			phase: Phase;
			settledAtDeadline: boolean;
			closeCallsAtDeadline: number;
			settledAfterCleanupBound: boolean;
			gotoTimeout?: number;
			row: unknown;
		}> = [];

		for (const phase of phases) {
			now = 0;
			const pageCreated = Promise.withResolvers<Record<string, unknown>>();
			const stage = Promise.withResolvers<string>();
			const close = Promise.withResolvers<void>();
			let closeCalls = 0;
			let gotoTimeout: number | undefined;
			const contentType = phase === "snapshot" ? "domSnapshot" : phase === "evaluate" ? "text" : "html";
			const temporaryPage = {
				url: () => "https://fixture.test/deadline",
				goto: async (_url: string, options: { timeout: number }) => {
					gotoTimeout = options.timeout;
				},
				title: async () => (phase === "title" ? await stage.promise : "Deadline fixture"),
				evaluate: async () =>
					phase === "snapshot" || phase === "evaluate" ? await stage.promise : "evaluated content",
				content: async () => (phase === "content" ? await stage.promise : "<html>content</html>"),
				close: async () => {
					closeCalls++;
					await close.promise;
				},
			};
			const adapter = new PuppeteerCodexBrowserAdapter({
				currentTabId: "1",
				page: { url: () => "https://fixture.test/selected" } as never,
				browser: { newPage: () => pageCreated.promise } as never,
				signal: new AbortController().signal,
				cwd: ".",
				captureScreenshot: async () => "",
			});
			let settled = false;
			const operation = adapter.invoke<unknown[]>("tabs.content", {
				urls: ["https://fixture.test/deadline"],
				contentType,
				timeoutMs: 20,
			});
			void operation.then(
				() => {
					settled = true;
				},
				() => {
					settled = true;
				},
			);
			await flushMicrotasks();

			if (phase === "acquisition") {
				now = 20;
				vi.advanceTimersByTime(20);
			} else {
				now = 6;
				vi.advanceTimersByTime(6);
				pageCreated.resolve(temporaryPage);
				await flushMicrotasks();
				now = 20;
				vi.advanceTimersByTime(14);
			}
			await flushMicrotasks();
			vi.advanceTimersByTime(0);
			await flushMicrotasks();
			const settledAtDeadline = settled;
			const closeCallsAtDeadline = closeCalls;

			now = 30_020;
			vi.advanceTimersByTime(30_000);
			await flushMicrotasks();
			vi.advanceTimersByTime(0);
			await flushMicrotasks();
			const settledAfterCleanupBound = settled;

			if (phase === "acquisition") pageCreated.resolve(temporaryPage);
			stage.resolve(phase === "title" ? "Late title" : "late content");
			close.resolve();
			const [row] = await operation;
			await flushMicrotasks();
			await adapter.dispose();
			observations.push({
				phase,
				settledAtDeadline,
				closeCallsAtDeadline,
				settledAfterCleanupBound,
				gotoTimeout,
				row,
			});
		}

		expect(observations).toEqual([
			{
				phase: "acquisition",
				settledAtDeadline: true,
				closeCallsAtDeadline: 0,
				settledAfterCleanupBound: true,
				gotoTimeout: undefined,
				row: { url: "https://fixture.test/deadline", title: null, content: null },
			},
			...(["title", "snapshot", "evaluate", "content"] as const).map(phase => ({
				phase,
				settledAtDeadline: false,
				closeCallsAtDeadline: 1,
				settledAfterCleanupBound: true,
				gotoTimeout: 14,
				row: { url: "https://fixture.test/deadline", title: null, content: null },
			})),
		]);
	});

	it("does not await a pending late newPage during dispose but closes it when it eventually resolves", async () => {
		const controller = new AbortController();
		const pageCreated = Promise.withResolvers<{ close(): Promise<void> }>();
		let lateCloseCount = 0;
		const adapter = new PuppeteerCodexBrowserAdapter({
			currentTabId: "1",
			page: { url: () => "https://fixture.test/selected" } as never,
			browser: { newPage: () => pageCreated.promise } as never,
			signal: controller.signal,
			cwd: ".",
			captureScreenshot: async () => "",
		});
		const content = adapter.invoke("tabs.content", {
			urls: ["https://fixture.test/late-page"],
			contentType: "html",
			timeoutMs: 100,
		});
		await flushMicrotasks();
		controller.abort(new Error("cancel pending acquisition"));
		await expect(content).rejects.toBeDefined();

		let disposed = false;
		const disposal = adapter.dispose().then(() => {
			disposed = true;
		});
		await flushMicrotasks();
		const disposedBeforeLatePage = disposed;
		pageCreated.resolve({
			close: async () => {
				lateCloseCount++;
			},
		});
		await disposal;
		await flushMicrotasks();

		expect(disposedBeforeLatePage).toBe(true);
		expect(lateCloseCount).toBe(1);
	});

	it("bounds unresolved temporary-page close for both tabs.content and adapter disposal", async () => {
		vi.useFakeTimers();
		let now = 0;
		spyOn(Date, "now").mockImplementation(() => now);
		const closeStarted = Promise.withResolvers<void>();
		const lateClose = Promise.withResolvers<void>();
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		let closeCalls = 0;
		const temporaryPage = {
			url: () => "https://fixture.test/cleanup-grace",
			goto: async () => undefined,
			title: async () => "Cleanup grace fixture",
			content: async () => "<html>finished</html>",
			close: async () => {
				closeCalls++;
				closeStarted.resolve();
				await lateClose.promise;
			},
		};
		const adapter = new PuppeteerCodexBrowserAdapter({
			currentTabId: "1",
			page: { url: () => "https://fixture.test/selected" } as never,
			browser: { newPage: async () => temporaryPage } as never,
			signal: new AbortController().signal,
			cwd: ".",
			captureScreenshot: async () => "",
		});
		let contentSettled = false;
		let disposalSettled = false;
		const content = adapter
			.invoke<Array<{ url: string; title: string | null; content: string | null }>>("tabs.content", {
				urls: ["https://fixture.test/cleanup-grace"],
				contentType: "html",
				timeoutMs: 10_000,
			})
			.then(value => {
				contentSettled = true;
				return value;
			});
		await closeStarted.promise;
		const disposal = adapter.dispose().then(() => {
			disposalSettled = true;
		});
		process.on("unhandledRejection", onUnhandled);
		await flushMicrotasks();

		let closeReleased = false;
		try {
			now = 750;
			vi.advanceTimersByTime(750);
			await flushMicrotasks();
			expect({ contentSettled, disposalSettled }).toEqual({ contentSettled: true, disposalSettled: true });
			expect(await content).toEqual([
				{
					url: "https://fixture.test/cleanup-grace",
					title: "Cleanup grace fixture",
					content: "<html>finished</html>",
				},
			]);
			await disposal;
			expect(closeCalls).toBe(1);

			lateClose.reject(new Error("late close failure"));
			closeReleased = true;
			await flushMicrotasks();
			vi.advanceTimersByTime(0);
			await flushMicrotasks();
			expect(unhandled).toEqual([]);
			expect(closeCalls).toBe(1);
		} finally {
			if (!closeReleased) lateClose.reject(new Error("release late close after failed assertion"));
			await Promise.all([
				content.then(
					() => undefined,
					() => undefined,
				),
				disposal.then(
					() => undefined,
					() => undefined,
				),
			]);
			await flushMicrotasks();
			process.off("unhandledRejection", onUnhandled);
		}
	});
	it("ignores browser-wide download events from frames outside the adapter page", async () => {
		spyOn(fs.promises, "mkdir").mockResolvedValue(undefined);
		const session = new DownloadSessionDouble();
		const adapter = new PuppeteerCodexBrowserAdapter({
			currentTabId: "1",
			page: {
				url: () => "https://fixture.test/download",
				title: async () => "Download fixture",
				mainFrame: () => ({ _id: "adapter-frame" }),
				frames: () => [{ _id: "adapter-frame" }],
			} as never,
			browser: { target: () => ({ createCDPSession: async () => session }) } as never,
			signal: new AbortController().signal,
			cwd: ".",
			captureScreenshot: async () => "",
		});

		try {
			const tab = await createCodexBrowserFacade(adapter).tabs.selected();
			if (!tab) throw new Error("Expected selected Puppeteer tab");
			const waiting = tab.playwright.waitForEvent("download", { timeoutMs: 100 });
			await session.downloadListenerRegistered.promise;
			await flushMicrotasks();
			session.emit("Browser.downloadWillBegin", {
				guid: "foreign-download",
				frameId: "foreign-frame",
				suggestedFilename: "foreign.txt",
			});
			session.emit("Browser.downloadWillBegin", {
				guid: "adapter-download",
				frameId: "adapter-frame",
				suggestedFilename: "adapter.txt",
			});
			const download = await waiting;
			if (!("path" in download)) throw new Error("Expected a download event");
			session.emit("Browser.downloadProgress", { guid: "foreign-download", state: "completed" });
			session.emit("Browser.downloadProgress", { guid: "adapter-download", state: "completed" });

			expect(path.basename((await download.path({ timeoutMs: 100 })) ?? "")).toBe("adapter.txt");
		} finally {
			await adapter.dispose();
		}
	});

	it("shares browser-global download ownership while preserving page-scoped events", async () => {
		vi.useFakeTimers();
		spyOn(fs.promises, "mkdir").mockResolvedValue(undefined);
		const sessions = [new DownloadSessionDouble(), new DownloadSessionDouble()];
		let nextSession = 0;
		const context = {};
		const target = {
			createCDPSession: async () => {
				const session = sessions[nextSession++];
				if (!session) throw new Error("Unexpected extra browser CDP session");
				return session;
			},
		};
		const browser = {
			target: () => target,
			defaultBrowserContext: () => context,
		} as never;
		const makePage = (name: string) =>
			({
				url: () => `https://fixture.test/${name}`,
				title: async () => `${name} fixture`,
				mainFrame: () => ({ _id: `${name}-frame` }),
				frames: () => [{ _id: `${name}-frame` }],
				browserContext: () => context,
			}) as never;
		const makeAdapter = (name: string) =>
			new PuppeteerCodexBrowserAdapter({
				currentTabId: "1",
				page: makePage(name),
				browser,
				signal: new AbortController().signal,
				cwd: ".",
				captureScreenshot: async () => "",
			});
		const adapterA = makeAdapter("adapter-a");
		const adapterB = makeAdapter("adapter-b");
		const tabA = await createCodexBrowserFacade(adapterA).tabs.selected();
		const tabB = await createCodexBrowserFacade(adapterB).tabs.selected();
		if (!tabA || !tabB) throw new Error("Expected both selected Puppeteer tabs");
		const waitingA = tabA.playwright.waitForEvent("download", { timeoutMs: 100 });
		const waitingB = tabB.playwright.waitForEvent("download", { timeoutMs: 100 });
		await flushMicrotasks();
		const emitBrowserEvent = (event: string, value: Record<string, unknown>) => {
			for (const session of sessions) session.emit(event, value);
		};

		emitBrowserEvent("Browser.downloadWillBegin", {
			guid: "adapter-a-download",
			frameId: "adapter-a-frame",
			suggestedFilename: "adapter-a.txt",
		});
		await flushMicrotasks();
		emitBrowserEvent("Browser.downloadWillBegin", {
			guid: "adapter-b-download",
			frameId: "adapter-b-frame",
			suggestedFilename: "adapter-b.txt",
		});
		const [downloadA, downloadB] = await Promise.all([waitingA, waitingB]);
		if (!("path" in downloadA) || !("path" in downloadB)) throw new Error("Expected two download events");
		emitBrowserEvent("Browser.downloadProgress", { guid: "adapter-a-download", state: "completed" });
		emitBrowserEvent("Browser.downloadProgress", { guid: "adapter-b-download", state: "completed" });
		const [downloadPathA, downloadPathB] = await Promise.all([
			downloadA.path({ timeoutMs: 100 }),
			downloadB.path({ timeoutMs: 100 }),
		]);
		expect(path.basename(downloadPathA ?? "")).toBe("adapter-a.txt");
		expect(path.basename(downloadPathB ?? "")).toBe("adapter-b.txt");

		const behaviorCalls = () =>
			sessions.flatMap(session => session.calls).filter(call => call.method === "Browser.setDownloadBehavior");
		const allowCalls = behaviorCalls().filter(call => call.params?.behavior === "allow");
		await adapterA.dispose();
		const defaultsAfterFirstDispose = behaviorCalls().filter(call => call.params?.behavior === "default");
		await adapterB.dispose();
		const finalDefaultCalls = behaviorCalls().filter(call => call.params?.behavior === "default");

		expect(allowCalls).toHaveLength(1);
		expect(allowCalls[0]?.params).toMatchObject({ behavior: "allow", eventsEnabled: true });
		const sharedDownloadPath = allowCalls[0]?.params?.downloadPath;
		expect(typeof sharedDownloadPath).toBe("string");
		if (typeof sharedDownloadPath !== "string") throw new Error("Shared download path was not configured");
		expect(path.dirname(downloadPathA ?? "")).toBe(sharedDownloadPath);
		expect(path.dirname(downloadPathB ?? "")).toBe(sharedDownloadPath);
		expect(defaultsAfterFirstDispose).toHaveLength(0);
		expect(finalDefaultCalls).toHaveLength(1);
		expect(finalDefaultCalls[0]?.params).toEqual({ behavior: "default", eventsEnabled: false });
	});

	it("resets download behavior and disables events after normal disposal and interrupted initialization", async () => {
		spyOn(fs.promises, "mkdir").mockResolvedValue(undefined);
		const page = {
			url: () => "https://fixture.test/download",
			title: async () => "Download fixture",
			mainFrame: () => ({ _id: "adapter-frame" }),
			frames: () => [{ _id: "adapter-frame" }],
		} as never;
		const makeAdapter = (session: DownloadSessionDouble) =>
			new PuppeteerCodexBrowserAdapter({
				currentTabId: "1",
				page,
				browser: { target: () => ({ createCDPSession: async () => session }) } as never,
				signal: new AbortController().signal,
				cwd: ".",
				captureScreenshot: async () => "",
			});

		const normalSession = new DownloadSessionDouble();
		const normalAdapter = makeAdapter(normalSession);
		const normalTab = await createCodexBrowserFacade(normalAdapter).tabs.selected();
		if (!normalTab) throw new Error("Expected selected Puppeteer tab");
		const normalWait = normalTab.playwright.waitForEvent("download", { timeoutMs: 100 }).then(
			() => "fulfilled",
			() => "rejected",
		);
		await normalSession.downloadListenerRegistered.promise;
		await normalAdapter.dispose();
		expect(await normalWait).toBe("rejected");

		const enableStarted = Promise.withResolvers<void>();
		const releaseEnable = Promise.withResolvers<void>();
		const partialSession = new DownloadSessionDouble(async (method, params) => {
			if (method === "Browser.setDownloadBehavior" && params?.behavior === "allow") {
				enableStarted.resolve();
				await releaseEnable.promise;
			}
		});
		const partialAdapter = makeAdapter(partialSession);
		const partialTab = await createCodexBrowserFacade(partialAdapter).tabs.selected();
		if (!partialTab) throw new Error("Expected selected Puppeteer tab");
		const partialWait = partialTab.playwright.waitForEvent("download", { timeoutMs: 100 }).then(
			() => "fulfilled",
			() => "rejected",
		);
		await enableStarted.promise;
		const partialDisposal = partialAdapter.dispose();
		releaseEnable.resolve();
		await partialSession.detached.promise;
		await partialDisposal;
		expect(await partialWait).toBe("rejected");

		for (const session of [normalSession, partialSession]) {
			const behaviorCalls = session.calls.filter(call => call.method === "Browser.setDownloadBehavior");
			expect(behaviorCalls).toHaveLength(2);
			expect(behaviorCalls[0]?.params).toMatchObject({ behavior: "allow", eventsEnabled: true });
			expect(behaviorCalls[1]?.params).toMatchObject({ behavior: "default", eventsEnabled: false });
			expect(session.detachCount).toBe(1);
		}
	});
});

describe("Puppeteer final parity blockers", () => {
	it("uses canonical roles and excludes accessibility-hidden nodes", async () => {
		await withPuppeteerTool(async (tool, name) => {
			const result = await runBrowserCode(
				tool,
				name,
				`const t=await agent.browser.tabs.selected(); const p=t.playwright;
				 return {
				   search:await p.getByRole("searchbox",{name:"Search",exact:true}).count(),
				   number:await p.getByRole("spinbutton",{name:"Number",exact:true}).count(),
				   listed:await p.getByRole("combobox",{name:"Listed",exact:true}).count(),
				   passwordTextbox:await p.getByRole("textbox",{name:"Secret",exact:true}).count(),
				   dateTextbox:await p.getByRole("textbox",{name:"Date",exact:true}).count(),
				   images:await p.getByRole("img").count(),
				   lists:await p.getByRole("list").count(),
				   listItems:await p.getByRole("listitem",{name:"one item"}).count(),
				   imageButton:await p.getByRole("button",{name:"Save",exact:true}).count(),
				   normalizedText:await p.getByText("mixed case").count(),
				   displayHidden:await p.getByRole("button",{name:"Display Hidden",exact:true}).count(),
				   ariaHidden:await p.getByRole("button",{name:"ARIA Hidden",exact:true}).count(),
				   inertHidden:await p.getByRole("button",{name:"Inert Hidden",exact:true}).count()
				 };`,
			);
			expect(result).toEqual({
				search: 1,
				number: 1,
				listed: 1,
				passwordTextbox: 0,
				dateTextbox: 0,
				images: 2,
				lists: 1,
				listItems: 1,
				imageButton: 1,
				normalizedText: 1,
				displayHidden: 0,
				ariaHidden: 0,
				inertHidden: 0,
			});
		});
	}, 20_000);

	it("rejects covered locator and DOM-CUA clicks within their deadlines without activating the target", async () => {
		await withPuppeteerTool(async (tool, name) => {
			const result = await runBrowserCode(
				tool,
				name,
				`const t=await agent.browser.tabs.selected(); const p=t.playwright;
				 await page.evaluate(()=>{
				   const target=document.createElement("button"); target.id="covered-target"; target.textContent="Covered target";
				   Object.assign(target.style,{position:"fixed",left:"200px",top:"100px",width:"120px",height:"40px"});
				   const overlay=document.createElement("div"); overlay.id="pointer-overlay";
				   Object.assign(overlay.style,{position:"fixed",left:"200px",top:"100px",width:"120px",height:"40px",zIndex:"10",background:"rgba(0,0,0,.01)"});
				   globalThis.__coveredClicks=0; globalThis.__coveredDoubleClicks=0;
				   target.addEventListener("click",()=>globalThis.__coveredClicks++);
				   target.addEventListener("dblclick",()=>globalThis.__coveredDoubleClicks++);
				   document.body.append(target,overlay);
				 });
				 const outcomes=[]; const locator=p.locator("#covered-target");
				 for (const method of ["click","dblclick"]) {
				   const started=Date.now();
				   try { await locator[method]({timeoutMs:80}); outcomes.push({method,status:"fulfilled",elapsed:Date.now()-started}); }
				   catch(error) { outcomes.push({method,status:"rejected",elapsed:Date.now()-started,message:String(error)}); }
				 }
				 const snapshot=await t.dom_cua.get_visible_dom();
				 const node=snapshot.nodes.find(item=>item.text==="Covered target");
				 for (const method of ["click","double_click"]) {
				   const started=Date.now();
				   try { await t.dom_cua[method]({node_id:node.node_id,timeoutMs:80}); outcomes.push({method:"dom_"+method,status:"fulfilled",elapsed:Date.now()-started}); }
				   catch(error) { outcomes.push({method:"dom_"+method,status:"rejected",elapsed:Date.now()-started,message:String(error)}); }
				 }
				 const force=await locator.click({force:true,timeoutMs:200}).then(()=>"fulfilled",error=>"rejected:"+String(error));
				 const activation=await page.evaluate(()=>({clicks:globalThis.__coveredClicks,doubleClicks:globalThis.__coveredDoubleClicks}));
				 return {outcomes,force,activation};`,
				10,
			);
			expect(result).toEqual({
				outcomes: [
					expect.objectContaining({
						method: "click",
						status: "rejected",
						message: expect.stringContaining("timed out"),
					}),
					expect.objectContaining({
						method: "dblclick",
						status: "rejected",
						message: expect.stringContaining("timed out"),
					}),
					expect.objectContaining({
						method: "dom_click",
						status: "rejected",
						message: expect.stringContaining("timed out"),
					}),
					expect.objectContaining({
						method: "dom_double_click",
						status: "rejected",
						message: expect.stringContaining("timed out"),
					}),
				],
				force: "fulfilled",
				activation: { clicks: 0, doubleClicks: 0 },
			});
			if (!result || typeof result !== "object" || !("outcomes" in result) || !Array.isArray(result.outcomes)) {
				throw new Error("Expected covered click outcomes");
			}
			for (const [index, outcome] of result.outcomes.entries()) {
				if (
					!outcome ||
					typeof outcome !== "object" ||
					!("elapsed" in outcome) ||
					typeof outcome.elapsed !== "number"
				) {
					throw new Error("Expected a covered click elapsed time");
				}
				expect(outcome.elapsed).toBeLessThan(index < 2 ? 500 : 3_500);
			}
		});
	}, 20_000);

	it("rejects fill and type on non-editable elements without mutating them", async () => {
		await withPuppeteerTool(async (tool, name) => {
			const result = await runBrowserCode(
				tool,
				name,
				`const t=await agent.browser.tabs.selected(); const errors=[];
				 for (const [selector,method] of [["#go","fill"],["#go","type"],["#plain","fill"],["#plain","type"]]) {
				   try { await t.playwright.locator(selector)[method]("changed"); }
				   catch (error) { errors.push(method+":"+selector+":"+String(error)); }
				 }
				 const state=await page.evaluate(()=>({button:document.querySelector("#go").value,plain:document.querySelector("#plain").textContent}));
				 return {errors,state};`,
			);
			expect(result).toEqual({
				errors: [
					expect.stringContaining("fill:#go:"),
					expect.stringContaining("type:#go:"),
					expect.stringContaining("fill:#plain:"),
					expect.stringContaining("type:#plain:"),
				],
				state: { button: "", plain: "Plain target" },
			});
		});
	}, 20_000);

	it("keeps explicit empty nested locator and frame roots empty", async () => {
		await withPuppeteerTool(async (tool, name) => {
			const result = await runBrowserCode(
				tool,
				name,
				`const t=await agent.browser.tabs.selected();
				 const nested=t.playwright.locator("#missing-parent").locator("button");
				 const framed=t.playwright.locator("#missing-parent").frameLocator("#only-frame").locator("button");
				 const errors=[];
				 for (const locator of [nested,framed]) { try { await locator.click({timeoutMs:20}); } catch(error) { errors.push(String(error)); } }
				 return {nested:await nested.count(),framed:await framed.count(),errors};`,
			);
			expect(result).toEqual({ nested: 0, framed: 0, errors: [expect.any(String), expect.any(String)] });
		});
	}, 20_000);

	it("rejects case-normalized aria-readonly in locator, CUA, and DOM-CUA editing", async () => {
		await withPuppeteerTool(async (tool, name) => {
			const result = await runBrowserCode(
				tool,
				name,
				`const t=await agent.browser.tabs.selected(); const errors=[];
				 for (const selector of ["#aria-readonly-input","#aria-readonly-editable"]) {
				   for (const method of ["fill","type"]) try { await t.playwright.locator(selector)[method]("changed"); } catch(error) { errors.push(method+":"+selector+":"+String(error)); }
				   for (const method of ["cua","dom_cua"]) {
				     await page.evaluate(selector=>document.querySelector(selector).focus(),selector);
				     try { await t[method].type({text:"changed"}); } catch(error) { errors.push(method+":"+selector+":"+String(error)); }
				   }
				 }
				 const state=await page.evaluate(()=>({input:document.querySelector("#aria-readonly-input").value,editable:document.querySelector("#aria-readonly-editable").textContent}));
				 return {errors,state};`,
			);
			expect(result).toEqual({
				errors: [
					expect.stringContaining("fill:#aria-readonly-input:"),
					expect.stringContaining("type:#aria-readonly-input:"),
					expect.stringContaining("cua:#aria-readonly-input:"),
					expect.stringContaining("dom_cua:#aria-readonly-input:"),
					expect.stringContaining("fill:#aria-readonly-editable:"),
					expect.stringContaining("type:#aria-readonly-editable:"),
					expect.stringContaining("cua:#aria-readonly-editable:"),
					expect.stringContaining("dom_cua:#aria-readonly-editable:"),
				],
				state: { input: "locked", editable: "locked content" },
			});
		});
	}, 20_000);

	it("keeps DOM node ids bound to the snapshotted element and rejects replacement nodes", async () => {
		await withPuppeteerTool(async (tool, name) => {
			const result = await runBrowserCode(
				tool,
				name,
				`const t=await agent.browser.tabs.selected();
				 const first=await t.dom_cua.get_visible_dom();
				 const stable=first.nodes.find(node=>node.text==="Stable target");
				 await page.evaluate(()=>{
				   const row=document.querySelector("#button-row"); const target=document.querySelector("#stable");
				   const inserted=document.createElement("button"); inserted.id="inserted"; inserted.textContent="Inserted target";
				   globalThis.__clicks=[]; inserted.addEventListener("click",()=>globalThis.__clicks.push("inserted"));
				   target.addEventListener("click",()=>globalThis.__clicks.push("stable")); row.prepend(inserted);
				 });
				 await t.dom_cua.click({node_id:stable.node_id});
				 const clicks=await page.evaluate(()=>globalThis.__clicks);
				 const second=await t.dom_cua.get_visible_dom();
				 const scroll=second.nodes.find(node=>node.text.includes("Scroll content")&&node.tag==="div");
				 await t.dom_cua.scroll({node_id:scroll.node_id,x:0,y:30});
				 const scrollTop=await page.evaluate(()=>document.querySelector("#scrollbox").scrollTop);
				 await t.dom_cua.scroll({node_id:scroll.node_id,x:0,y:10000});
				 await t.dom_cua.scroll({node_id:scroll.node_id,x:0,y:10000});
				 const third=await t.dom_cua.get_visible_dom();
				 const stale=third.nodes.find(node=>node.text.includes("Scroll content")&&node.tag==="div");
				 await page.evaluate(()=>{ const old=document.querySelector("#scrollbox"); const replacement=old.cloneNode(true); old.replaceWith(replacement); });
				 let staleError=""; try { await t.dom_cua.scroll({node_id:stale.node_id,x:0,y:10}); } catch(error) { staleError=String(error); }
				 return {clicks,scrollTop,staleError};`,
			);
			expect(result).toEqual({
				clicks: ["stable"],
				scrollTop: 30,
				staleError: expect.stringContaining("stale"),
			});
		});
	}, 20_000);

	it("excludes headings and images from default elementInfo but returns opted-in metadata", async () => {
		await withPuppeteerTool(async (tool, name) => {
			const result = await runBrowserCode(
				tool,
				name,
				`const t=await agent.browser.tabs.selected(); return {
				 headingDefault:await t.playwright.elementInfo({x:5,y:15}),
				 headingOpted:await t.playwright.elementInfo({x:5,y:15,includeNonInteractable:true}),
				 imageDefault:await t.playwright.elementInfo({x:5,y:45}),
				 imageOpted:await t.playwright.elementInfo({x:5,y:45,includeNonInteractable:true})
				};`,
			);
			expect(result).toEqual({
				headingDefault: [],
				headingOpted: [expect.objectContaining({ tagName: "h1", role: "heading" })],
				imageDefault: [],
				imageOpted: [expect.objectContaining({ tagName: "img", role: "img", ariaName: "Hero" })],
			});
		});
	}, 20_000);

	it("rejects media above 32 MiB before retaining overflowing bytes", async () => {
		const mediaLimit = 32 * 1024 * 1024;
		const originalDocument = Reflect.get(globalThis, "document");
		const hadDocument = Reflect.has(globalThis, "document");
		const originalFetch = globalThis.fetch;
		Reflect.set(globalThis, "document", { baseURI: "https://fixture.test/page" });

		const element = {
			getAttribute: (name: string) => (name === "src" ? "/media.png" : null),
			querySelector: () => null,
		};
		const invokeWith = async (response: Record<string, unknown>): Promise<void> => {
			const handle: Record<string, unknown> = {
				asElement: () => handle,
				dispose: async () => undefined,
				evaluate: async (
					callback: (target: typeof element, timeoutMs: number, label: string) => Promise<unknown>,
					timeoutMs: number,
					label: string,
				) => await callback(element, timeoutMs, label),
			};
			const adapter = new PuppeteerCodexBrowserAdapter({
				currentTabId: "1",
				page: {
					url: () => "https://fixture.test/page",
					evaluateHandle: async () => handle,
				} as never,
				browser: {} as never,
				signal: new AbortController().signal,
				cwd: "/tmp",
				captureScreenshot: async () => "",
			});
			globalThis.fetch = (async () => response) as unknown as typeof fetch;
			try {
				await adapter.invoke("cua.downloadMedia", { tabId: "1", x: 1, y: 1, timeoutMs: 1_000 });
			} finally {
				await adapter.dispose();
			}
		};

		try {
			let knownBodyRead = false;
			let knownArrayBufferRead = false;
			const knownOversized = {
				ok: true,
				status: 200,
				headers: new Headers({ "content-length": String(mediaLimit + 1), "content-type": "image/png" }),
				get body() {
					knownBodyRead = true;
					throw new Error("oversized body was read");
				},
				arrayBuffer: async () => {
					knownArrayBufferRead = true;
					return new ArrayBuffer(0);
				},
			};
			await expect(invokeWith(knownOversized)).rejects.toThrow("downloadMedia response exceeds the 32 MiB limit");
			expect({ knownBodyRead, knownArrayBufferRead }).toEqual({
				knownBodyRead: false,
				knownArrayBufferRead: false,
			});

			let overflowingChunkRetained = false;
			let readerCanceled = false;
			let readCount = 0;
			const overflowingChunk = {
				byteLength: mediaLimit + 1,
				[Symbol.iterator]() {
					overflowingChunkRetained = true;
					return [][Symbol.iterator]();
				},
			} as unknown as Uint8Array;
			const streamedOversized = {
				ok: true,
				status: 200,
				headers: new Headers({ "content-type": "image/png" }),
				body: {
					getReader: () => ({
						read: async () =>
							readCount++ === 0 ? { done: false, value: overflowingChunk } : { done: true, value: undefined },
						cancel: async () => {
							readerCanceled = true;
						},
						releaseLock: () => undefined,
					}),
				},
				arrayBuffer: async () => {
					throw new Error("streaming response used arrayBuffer");
				},
			};
			await expect(invokeWith(streamedOversized)).rejects.toThrow("downloadMedia response exceeds the 32 MiB limit");
			expect(overflowingChunkRetained).toBe(false);
			expect(readerCanceled).toBe(true);

			let unknownArrayBufferRead = false;
			await expect(
				invokeWith({
					ok: true,
					status: 200,
					headers: new Headers({ "content-type": "image/png" }),
					body: null,
					arrayBuffer: async () => {
						unknownArrayBufferRead = true;
						return new ArrayBuffer(0);
					},
				}),
			).rejects.toThrow("Content-Length");
			expect(unknownArrayBufferRead).toBe(false);
		} finally {
			globalThis.fetch = originalFetch;
			if (hadDocument) Reflect.set(globalThis, "document", originalDocument);
			else Reflect.deleteProperty(globalThis, "document");
		}
	});

	it("revalidates bounded media after the Puppeteer page boundary", async () => {
		const chunk = Buffer.alloc(1024).toString("base64");
		const oversizedChunks = Array.from({ length: 32 * 1024 + 1 }, () => chunk);
		const handle: Record<string, unknown> = {
			asElement: () => handle,
			dispose: async () => undefined,
			evaluate: async () => ({ contentType: "application/octet-stream", base64Chunks: oversizedChunks }),
		};
		const openSpy = spyOn(fs.promises, "open").mockRejectedValue(new Error("oversized media reached persistence"));
		const adapter = new PuppeteerCodexBrowserAdapter({
			currentTabId: "1",
			page: {
				url: () => "https://fixture.test/page",
				evaluateHandle: async () => handle,
			} as never,
			browser: {} as never,
			signal: new AbortController().signal,
			cwd: "/tmp",
			captureScreenshot: async () => "",
		});

		await expect(adapter.invoke("cua.downloadMedia", { tabId: "1", x: 1, y: 1, timeoutMs: 1_000 })).rejects.toThrow(
			"downloadMedia response exceeds the 32 MiB limit",
		);
		expect(openSpy).not.toHaveBeenCalled();
		await adapter.dispose();
	});

	it("bounds selector resolution, read, action, media, and file chooser bodies", async () => {
		const never = new Promise<never>(() => undefined);
		const optionsFor = (page: Record<string, unknown>) => ({
			currentTabId: "1",
			page: { url: () => "https://fixture.test/current", ...page } as never,
			browser: {} as never,
			signal: new AbortController().signal,
			cwd: "/tmp/browser-contract",
			captureScreenshot: async () => "",
		});
		const outcome = async (promise: Promise<unknown>): Promise<string> =>
			await Promise.race([
				promise.then(
					() => "fulfilled",
					error => (error instanceof Error ? error.message : String(error)),
				),
				Bun.sleep(150).then(() => "operation remained pending"),
			]);
		const locator = { kind: "css", selector: "#target" } as const;
		const collectionFor = (handle: Record<string, unknown>) => ({
			async getProperties() {
				return new Map([["0", handle]]);
			},
			async dispose() {},
		});
		const handleFor = (overrides: Record<string, unknown>) => {
			const handle = {
				asElement: () => handle,
				async dispose() {},
				...overrides,
			};
			return handle;
		};

		const resolving = new PuppeteerCodexBrowserAdapter(optionsFor({ evaluateHandle: async () => await never }));
		const readHandle = handleFor({ evaluate: async () => await never });
		const reading = new PuppeteerCodexBrowserAdapter(
			optionsFor({ evaluateHandle: async () => collectionFor(readHandle) }),
		);
		let actionChecks = 0;
		const actionHandle = handleFor({
			evaluate: async () => {
				actionChecks++;
				return true;
			},
			click: async () => await never,
		});
		const acting = new PuppeteerCodexBrowserAdapter(
			optionsFor({
				evaluateHandle: async () => collectionFor(actionHandle),
				keyboard: { down: async () => undefined, up: async () => undefined },
			}),
		);
		const mediaHandle = handleFor({ evaluate: async () => await never });
		const media = new PuppeteerCodexBrowserAdapter(
			optionsFor({ evaluateHandle: async () => collectionFor(mediaHandle) }),
		);
		const chooser = { isMultiple: () => false, accept: async () => await never, cancel: async () => undefined };
		const choosing = new PuppeteerCodexBrowserAdapter(optionsFor({ waitForFileChooser: async () => chooser }));
		const chooserEvent = await choosing.invoke<{ token: string }>("playwright.waitForEvent", {
			tabId: "1",
			event: "filechooser",
			timeoutMs: 20,
		});

		const outcomes = await Promise.all([
			outcome(resolving.invoke("locator.count", { tabId: "1", locator, timeoutMs: 20 })),
			outcome(reading.invoke("locator.allTextContents", { tabId: "1", locator, timeoutMs: 20 })),
			outcome(acting.invoke("locator.click", { tabId: "1", locator, timeoutMs: 20 })),
			outcome(media.invoke("locator.downloadMedia", { tabId: "1", locator, timeoutMs: 20 })),
			outcome(
				choosing.invoke("playwright.fileChooser.setFiles", {
					tabId: "1",
					token: chooserEvent.token,
					files: ["fixture.txt"],
					timeoutMs: 20,
				}),
			),
		]);
		expect(actionChecks).toBeGreaterThanOrEqual(2);
		for (const result of outcomes) {
			expect(result).toContain("timed out");
			expect(result).not.toBe("operation remained pending");
		}
	});

	it("releases pressed click modifiers as soon as the action deadline expires", async () => {
		const click = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		const handle: Record<string, unknown> = {
			asElement: () => handle,
			dispose: async () => undefined,
			evaluate: async () => true,
			click: async () => await click.promise,
		};
		const collection = {
			getProperties: async () => new Map([["0", handle]]),
			dispose: async () => undefined,
		};
		const pressed: string[] = [];
		const adapter = new PuppeteerCodexBrowserAdapter({
			currentTabId: "1",
			page: {
				url: () => "https://fixture.test/current",
				evaluateHandle: async () => collection,
				keyboard: {
					down: async (key: string) => pressed.push(key),
					up: async (key: string) => {
						pressed.splice(pressed.indexOf(key), 1);
						released.resolve();
					},
				},
			} as never,
			browser: {} as never,
			signal: new AbortController().signal,
			cwd: "/tmp/browser-contract",
			captureScreenshot: async () => "",
		});

		try {
			await expect(
				adapter.invoke("locator.click", {
					tabId: "1",
					locator: { kind: "css", selector: "#target" },
					modifiers: ["Shift"],
					timeoutMs: 20,
				}),
			).rejects.toThrow("timed out");
			await expect(
				Promise.race([released.promise.then(() => "released"), Bun.sleep(100).then(() => "stuck")]),
			).resolves.toBe("released");
			expect(pressed).toEqual([]);
		} finally {
			click.resolve();
			await adapter.dispose();
		}
	});

	it("passes the run signal to file chooser waits and cancels ignored late choosers", async () => {
		const firstRun = new AbortController();
		const firstChooser = Promise.withResolvers<Record<string, unknown>>();
		const secondChooser = { isMultiple: () => false, cancel: async () => undefined };
		let calls = 0;
		let firstOptions: { signal?: AbortSignal } | undefined;
		let lateCancelCount = 0;
		const page = {
			url: () => "https://fixture.test/current",
			waitForFileChooser: async (options: { signal?: AbortSignal }) => {
				calls++;
				if (calls === 1) {
					firstOptions = options;
					return await firstChooser.promise;
				}
				return secondChooser;
			},
		};
		const makeAdapter = (signal: AbortSignal) =>
			new PuppeteerCodexBrowserAdapter({
				currentTabId: "1",
				page: page as never,
				browser: {} as never,
				signal,
				cwd: "/tmp/browser-contract",
				captureScreenshot: async () => "",
			});
		const first = makeAdapter(firstRun.signal);
		const waiting = first.invoke("playwright.waitForEvent", { tabId: "1", event: "filechooser", timeoutMs: 1_000 });
		await flushMicrotasks();
		firstRun.abort(new Error("run aborted"));
		await expect(waiting).rejects.toThrow("run aborted");
		expect(firstOptions?.signal).toBe(firstRun.signal);
		firstChooser.resolve({
			isMultiple: () => false,
			cancel: async () => {
				lateCancelCount++;
			},
		});
		await flushMicrotasks();
		expect(lateCancelCount).toBe(1);

		const second = makeAdapter(new AbortController().signal);
		await expect(
			second.invoke("playwright.waitForEvent", { tabId: "1", event: "filechooser", timeoutMs: 20 }),
		).resolves.toMatchObject({ multiple: false });
		await Promise.all([first.dispose(), second.dispose()]);
	});

	it("bounds visible DOM construction, disposes every created handle, and cannot publish after disposal", async () => {
		const never = new Promise<never>(() => undefined);
		let collectionDisposals = 0;
		let elementDisposals = 0;
		let scalarDisposals = 0;
		const element = {
			asElement: () => element,
			evaluate: async () => await never,
			dispose: async () => {
				elementDisposals++;
			},
		};
		const scalar = {
			asElement: () => null,
			dispose: async () => {
				scalarDisposals++;
			},
		};
		const collection = {
			getProperties: async () =>
				new Map<string, typeof element | typeof scalar>([
					["0", element],
					["meta", scalar],
				]),
			dispose: async () => {
				collectionDisposals++;
			},
		};
		const adapter = new PuppeteerCodexBrowserAdapter({
			currentTabId: "1",
			page: { url: () => "https://fixture.test/current", evaluateHandle: async () => collection } as never,
			browser: {} as never,
			signal: new AbortController().signal,
			cwd: "/tmp/browser-contract",
			captureScreenshot: async () => "",
		});
		// Intentional real deadline: this regression exercises the adapter's wall-clock operation bound.
		const result = await adapter.invoke("dom_cua.get_visible_dom", { tabId: "1", timeoutMs: 20 }).then(
			() => "fulfilled",
			error => String(error),
		);
		expect(result).toContain("timed out");
		expect({ collectionDisposals, elementDisposals, scalarDisposals }).toEqual({
			collectionDisposals: 1,
			elementDisposals: 1,
			scalarDisposals: 1,
		});

		const properties = Promise.withResolvers<Map<string, Record<string, unknown>>>();
		let lateHandleDisposals = 0;
		const lateHandle: Record<string, unknown> = {
			asElement: () => lateHandle,
			evaluate: async () => ({ tag: "button", role: "button", text: "Late", x: 0, y: 0, width: 1, height: 1 }),
			dispose: async () => {
				lateHandleDisposals++;
			},
		};
		const lateAdapter = new PuppeteerCodexBrowserAdapter({
			currentTabId: "1",
			page: {
				url: () => "https://fixture.test/current",
				evaluateHandle: async () => ({
					getProperties: async () => await properties.promise,
					dispose: async () => undefined,
				}),
			} as never,
			browser: {} as never,
			signal: new AbortController().signal,
			cwd: "/tmp/browser-contract",
			captureScreenshot: async () => "",
		});
		const snapshot = lateAdapter.invoke("dom_cua.get_visible_dom", { tabId: "1", timeoutMs: 1_000 });
		await flushMicrotasks();
		await lateAdapter.dispose();
		properties.resolve(new Map([["0", lateHandle]]));
		await expect(snapshot).rejects.toThrow("disposed");
		expect(lateHandleDisposals).toBe(1);
		await expect(lateAdapter.invoke("dom_cua.click", { tabId: "1", nodeId: "1:1", timeoutMs: 20 })).rejects.toThrow(
			"Unknown DOM CUA node_id",
		);
	});
	it("disposes a visible DOM collection that resolves after run abort without publishing nodes", async () => {
		const controller = new AbortController();
		const collectionResolution = Promise.withResolvers<Record<string, unknown>>();
		let collectionDisposals = 0;
		let propertyReads = 0;
		const collection = {
			getProperties: async () => {
				propertyReads++;
				return new Map();
			},
			dispose: async () => {
				collectionDisposals++;
			},
		};
		const adapter = new PuppeteerCodexBrowserAdapter({
			currentTabId: "1",
			page: {
				url: () => "https://fixture.test/current",
				evaluateHandle: async () => await collectionResolution.promise,
			} as never,
			browser: {} as never,
			signal: controller.signal,
			cwd: "/tmp/browser-contract",
			captureScreenshot: async () => "",
		});
		const snapshot = adapter.invoke("dom_cua.get_visible_dom", { tabId: "1", timeoutMs: 1_000 });
		const settled = snapshot.then(
			() => "fulfilled",
			error => (error instanceof Error ? error.message : String(error)),
		);
		await flushMicrotasks();
		controller.abort(new Error("run aborted during collection"));
		expect(await settled).toContain("run aborted during collection");

		collectionResolution.resolve(collection);
		await flushMicrotasks();
		await adapter.dispose();
		expect({ collectionDisposals, propertyReads }).toEqual({ collectionDisposals: 1, propertyReads: 0 });
	});

	it("disposes every visible DOM property handle that resolves after run abort without publishing nodes", async () => {
		const controller = new AbortController();
		const propertiesRequested = Promise.withResolvers<void>();
		const propertiesResolution = Promise.withResolvers<Map<string, Record<string, unknown>>>();
		let collectionDisposals = 0;
		let elementDisposals = 0;
		let scalarDisposals = 0;
		let elementEvaluations = 0;
		const element: Record<string, unknown> = {
			asElement: () => element,
			evaluate: async () => {
				elementEvaluations++;
				return { tag: "button", role: "button", text: "Late", x: 0, y: 0, width: 1, height: 1 };
			},
			dispose: async () => {
				elementDisposals++;
			},
		};
		const scalar = {
			asElement: () => null,
			dispose: async () => {
				scalarDisposals++;
			},
		};
		const collection = {
			getProperties: async () => {
				propertiesRequested.resolve();
				return await propertiesResolution.promise;
			},
			dispose: async () => {
				collectionDisposals++;
			},
		};
		const adapter = new PuppeteerCodexBrowserAdapter({
			currentTabId: "1",
			page: { url: () => "https://fixture.test/current", evaluateHandle: async () => collection } as never,
			browser: {} as never,
			signal: controller.signal,
			cwd: "/tmp/browser-contract",
			captureScreenshot: async () => "",
		});
		const snapshot = adapter.invoke("dom_cua.get_visible_dom", { tabId: "1", timeoutMs: 1_000 });
		const settled = snapshot.then(
			() => "fulfilled",
			error => (error instanceof Error ? error.message : String(error)),
		);
		await propertiesRequested.promise;
		controller.abort(new Error("run aborted during properties"));
		expect(await settled).toContain("run aborted during properties");

		propertiesResolution.resolve(
			new Map<string, Record<string, unknown>>([
				["0", element],
				["metadata", scalar],
			]),
		);
		await flushMicrotasks();
		await adapter.dispose();
		expect({ collectionDisposals, elementDisposals, scalarDisposals, elementEvaluations }).toEqual({
			collectionDisposals: 1,
			elementDisposals: 1,
			scalarDisposals: 1,
			elementEvaluations: 0,
		});
	});

	it("uses one bounded deadline for DOM-CUA lookup and every node action", async () => {
		const never = new Promise<never>(() => undefined);
		const metadata = { tag: "button", role: "button", text: "Target", x: 0, y: 0, width: 1, height: 1 };
		let mode = "snapshot";
		let evaluationCount = 0;
		const handle: Record<string, unknown> = {
			asElement: () => handle,
			dispose: async () => undefined,
			evaluate: async () => {
				if (mode === "snapshot") return metadata;
				if (mode === "lookup") return await never;
				if (mode === "connected") return true;
				if (mode === "scroll" || mode === "media") return ++evaluationCount === 1 ? true : await never;
				return await never;
			},
			click: async () => await never,
		};
		const adapter = new PuppeteerCodexBrowserAdapter({
			currentTabId: "1",
			page: {
				url: () => "https://fixture.test/current",
				evaluateHandle: async () => ({
					getProperties: async () => new Map([["0", handle]]),
					dispose: async () => undefined,
				}),
			} as never,
			browser: {} as never,
			signal: new AbortController().signal,
			cwd: "/tmp/browser-contract",
			captureScreenshot: async () => "",
		});
		const snapshot = await adapter.invoke<{ nodes: Array<{ node_id: string }> }>("dom_cua.get_visible_dom", {
			tabId: "1",
			timeoutMs: 20,
		});
		const nodeId = snapshot.nodes[0]?.node_id;
		if (!nodeId) throw new Error("Expected snapshotted node");
		const bounded = async (
			operation: "dom_cua.click" | "dom_cua.double_click" | "dom_cua.scroll" | "dom_cua.downloadMedia",
			actionMode: string,
		): Promise<string> => {
			mode = actionMode;
			evaluationCount = 0;
			return await adapter.invoke(operation, { tabId: "1", nodeId, x: 1, y: 1, timeoutMs: 20 }).then(
				() => "fulfilled",
				error => String(error),
			);
		};
		const outcomes = [
			await bounded("dom_cua.click", "lookup"),
			await bounded("dom_cua.click", "connected"),
			await bounded("dom_cua.double_click", "connected"),
			await bounded("dom_cua.scroll", "scroll"),
			await bounded("dom_cua.downloadMedia", "media"),
		];
		for (const result of outcomes) expect(result).toContain("timed out");
		await adapter.dispose();
	});

	it("does not let deferred download setup block run cleanup and releases late setup", async () => {
		spyOn(fs.promises, "mkdir").mockResolvedValue(undefined);
		const controller = new AbortController();
		const enableStarted = Promise.withResolvers<void>();
		const releaseEnable = Promise.withResolvers<void>();
		const session = new DownloadSessionDouble(async (method, params) => {
			if (method === "Browser.setDownloadBehavior" && params?.behavior === "allow") {
				enableStarted.resolve();
				await releaseEnable.promise;
			}
		});
		const adapter = new PuppeteerCodexBrowserAdapter({
			currentTabId: "1",
			page: { url: () => "https://fixture.test/current" } as never,
			browser: { target: () => ({ createCDPSession: async () => session }) } as never,
			signal: controller.signal,
			cwd: "/tmp/browser-contract",
			captureScreenshot: async () => "",
		});
		const waiting = adapter.invoke("playwright.waitForEvent", { tabId: "1", event: "download", timeoutMs: 1_000 });
		await enableStarted.promise;
		controller.abort(new Error("short run ended"));
		await expect(waiting).rejects.toThrow("short run ended");
		await adapter.dispose();
		releaseEnable.resolve();
		await session.detached.promise;
		expect(session.calls.at(-1)).toMatchObject({
			method: "Browser.setDownloadBehavior",
			params: { behavior: "default", eventsEnabled: false },
		});
		expect(session.detachCount).toBe(1);
	});
	it("defers unsupported download capability errors until download wait invocation", async () => {
		const adapter = new PuppeteerCodexBrowserAdapter({
			currentTabId: "1",
			page: {
				title: async () => "Fixture",
				url: () => "https://fixture.test/current",
			} as never,
			browser: {} as never,
			signal: new AbortController().signal,
			cwd: "/tmp/browser-contract",
			captureScreenshot: async () => "",
		});

		await expect(adapter.beginRun()).resolves.toBeUndefined();
		await expect(adapter.invoke("tab.title", { tabId: "1" })).resolves.toBe("Fixture");
		await expect(
			adapter.invoke("playwright.waitForEvent", {
				tabId: "1",
				event: "download",
				timeoutMs: 20,
			}),
		).rejects.toMatchObject({
			name: "BrowserCapabilityError",
			message: "Browser capability is unavailable: playwright.waitForEvent",
		});
		await adapter.dispose();
	});
});
