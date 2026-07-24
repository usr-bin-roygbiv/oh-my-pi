import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import { CmuxTab } from "@oh-my-pi/pi-coding-agent/tools/browser/cmux/cmux-tab";
import { CmuxCodexBrowserAdapter } from "@oh-my-pi/pi-coding-agent/tools/browser/cmux/codex-adapter";
import {
	type CodexBrowserFacade,
	type CodexClipboardItem,
	createCodexBrowserFacade,
} from "@oh-my-pi/pi-coding-agent/tools/browser/codex-facade";

type RpcCall = {
	method: string;
	params: Record<string, unknown>;
	timeoutMs?: number;
};

function adapterAndFacadeFor(overrides: Record<string, unknown>): {
	adapter: CmuxCodexBrowserAdapter;
	browser: CodexBrowserFacade;
} {
	const tab = {
		surfaceId: "surface-contract",
		async codexUrl() {
			return "https://fixture.test/current";
		},
		async title() {
			return "Current fixture";
		},
		async codexPersistFile(path: string, data: Uint8Array) {
			await Bun.write(path, data);
		},
		...overrides,
	} as never;
	const adapter = new CmuxCodexBrowserAdapter(tab);
	return { adapter, browser: createCodexBrowserFacade(adapter) };
}

function facadeFor(overrides: Record<string, unknown>): CodexBrowserFacade {
	return adapterAndFacadeFor(overrides).browser;
}

async function selectedTab(browser: CodexBrowserFacade) {
	const tab = await browser.tabs.selected();
	if (!tab) throw new Error("Expected a selected cmux tab");
	return tab;
}

async function caughtError(run: () => unknown | Promise<unknown>): Promise<{ name: string; message: string }> {
	try {
		await run();
		return { name: "NO_ERROR", message: "" };
	} catch (error) {
		return { name: (error as Error).name, message: (error as Error).message };
	}
}

function runPageEvaluator(
	source: string,
	args: unknown[],
	bindings: {
		document: unknown;
		window: unknown;
		navigator?: unknown;
		ClipboardItem?: unknown;
		Element?: unknown;
		Blob?: unknown;
		CSS?: unknown;
	},
): unknown {
	const evaluate = new Function(
		"document",
		"window",
		"navigator",
		"ClipboardItem",
		"Blob",
		"Element",
		"CSS",
		"args",
		`return (${source})(...args);`,
	) as (...values: unknown[]) => unknown;
	return evaluate(
		bindings.document,
		bindings.window,
		bindings.navigator ?? {},
		bindings.ClipboardItem,
		bindings.Blob,
		bindings.Element,
		bindings.CSS ?? { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "_") },
		args,
	);
}

function runCmuxEvalScript(
	script: string,
	bindings: { document: unknown; window: unknown; Event: unknown; MouseEvent: unknown },
): unknown {
	const globals = globalThis as unknown as Record<string, unknown>;
	const descriptors = new Map<string, PropertyDescriptor | undefined>();
	for (const [name, value] of Object.entries(bindings)) {
		descriptors.set(name, Object.getOwnPropertyDescriptor(globals, name));
		Object.defineProperty(globals, name, { value, configurable: true, writable: true });
	}
	try {
		return new Function(`return (${script});`)();
	} finally {
		for (const [name, descriptor] of descriptors) {
			if (descriptor) Object.defineProperty(globals, name, descriptor);
			else delete globals[name];
		}
	}
}

type SelectProbe = {
	document: unknown;
	view: unknown;
	events: string[];
	selectedValues(): string[];
};

function selectProbe(values: string[], initiallySelected: string, multiple = false, size = 1) {
	const events: string[] = [];
	const view = {
		Event: class {
			readonly type: string;
			constructor(type: string) {
				this.type = type;
			}
		},
		getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
	};
	let options: Array<Record<string, unknown>> = [];
	const document = {
		defaultView: view,
		querySelectorAll: (selector: string) => (selector === "#choice" || selector === "*" ? [select] : []),
	};
	const select = {
		tagName: "SELECT",
		multiple,
		size,
		hidden: false,
		disabled: false,
		ownerDocument: document,
		get options() {
			return options;
		},
		get selectedOptions() {
			return options.filter(option => option.selected === true);
		},
		getAttribute: () => null,
		getBoundingClientRect: () => ({ width: 120, height: 24 }),
		scrollIntoView: () => undefined,
		focus: () => undefined,
		dispatchEvent: (event: { type: string }) => {
			events.push(event.type);
			return true;
		},
	};
	options = values.map((value, index) => {
		let selected = false;
		const option: Record<string, unknown> = { value, label: value, index };
		Object.defineProperty(option, "selected", {
			get: () => selected,
			set: (next: boolean) => {
				if (next && !multiple) {
					for (const other of options) {
						if (other !== option) Reflect.set(other, "selected", false);
					}
				}
				selected = next;
			},
		});
		return option;
	});
	const initial = options.find(option => option.value === initiallySelected);
	if (initial) Reflect.set(initial, "selected", true);
	return {
		document,
		view,
		events,
		selectedValues: () => options.filter(option => option.selected === true).map(option => String(option.value)),
	};
}

function facadeForSelect(probe: SelectProbe): CodexBrowserFacade {
	return facadeFor({
		async codexEvaluate(source: string, args: unknown[]) {
			return runPageEvaluator(source, args, { document: probe.document, window: probe.view });
		},
		async codexWait() {
			throw new Error("A present select should not need to poll");
		},
	});
}

function labelProbe() {
	const view = {};
	const labelsById = new Map([
		["first-label", { innerText: "ARIA", textContent: "ARIA" }],
		["second-label", { innerText: "Labelled By", textContent: "Labelled By" }],
	]);
	let controls: Array<Record<string, unknown>> = [];
	const document = {
		defaultView: view,
		getElementById: (id: string) => labelsById.get(id),
		querySelectorAll: (selector: string) => (selector === "*" ? controls : []),
	};
	const associatedLabel = {
		tagName: "LABEL",
		children: [],
		ownerDocument: document,
		innerText: "Associated Label",
		textContent: "Associated Label",
		getAttribute: () => null,
	};
	const combinedControl = {
		tagName: "INPUT",
		type: "text",
		children: [],
		labels: [associatedLabel],
		ownerDocument: document,
		getAttribute: (name: string) =>
			({ "aria-label": "Direct ARIA Label", "aria-labelledby": "first-label second-label" })[name] ?? null,
	};
	const nativeLabel = {
		tagName: "LABEL",
		children: [],
		ownerDocument: document,
		innerText: "Native Name",
		textContent: "Native Name",
		getAttribute: () => null,
	};
	const ariaPreferredControl = {
		tagName: "INPUT",
		type: "text",
		children: [],
		labels: [nativeLabel],
		ownerDocument: document,
		getAttribute: (name: string) => (name === "aria-label" ? "Preferred ARIA" : null),
	};
	controls = [associatedLabel, combinedControl, nativeLabel, ariaPreferredControl];
	return { document, view };
}

function observerProbe(multiple = false) {
	type ClickEvent = { target: ElementProbe; defaultPrevented: boolean; isTrusted: boolean; preventDefault(): void };
	let clickListener: ((event: ClickEvent) => void) | undefined;
	let clickCapture = false;
	class ElementProbe {
		readonly attributes = new Map<string, string>();
		readonly kind: "file" | "anchor";
		readonly multiple: boolean;
		readonly tagName: "INPUT" | "A";

		constructor(kind: "file" | "anchor") {
			this.kind = kind;
			this.multiple = kind === "file" && multiple;
			this.tagName = kind === "file" ? "INPUT" : "A";
		}

		closest(selector: string): ElementProbe | null {
			if (selector === 'input[type="file"]') return this.kind === "file" ? this : null;
			if (selector === "a[href]") return this.kind === "anchor" ? this : null;
			return null;
		}

		getAttribute(name: string): string | null {
			return this.attributes.get(name) ?? null;
		}

		setAttribute(name: string, value: string): void {
			this.attributes.set(name, value);
		}

		removeAttribute(name: string): void {
			this.attributes.delete(name);
		}
	}
	const file = new ElementProbe("file");
	file.setAttribute("id", "upload");
	file.setAttribute("type", "file");
	const anchor = new ElementProbe("anchor");
	const elements = [file, anchor];
	const document = {
		addEventListener(type: string, listener: (event: ClickEvent) => void, capture = false) {
			if (type === "click") {
				clickListener = listener;
				clickCapture = capture;
			}
		},
		removeEventListener(type: string, listener: (event: ClickEvent) => void, capture = false) {
			if (type === "click" && clickListener === listener && clickCapture === capture) clickListener = undefined;
		},
		querySelectorAll(selector: string) {
			if (selector === "#upload") return [file];
			return elements.filter(element => {
				if (selector.includes("data-omp-codex-file-token") && element.getAttribute("data-omp-codex-file-token"))
					return true;
				return (
					selector.includes("data-omp-codex-download-token") &&
					!!element.getAttribute("data-omp-codex-download-token")
				);
			});
		},
	};
	const fire = (target: ElementProbe, cancelled = false, stopped = false, isTrusted = true) => {
		const event: ClickEvent = {
			target,
			defaultPrevented: cancelled,
			isTrusted,
			preventDefault() {
				this.defaultPrevented = true;
			},
		};
		if (!stopped || clickCapture) clickListener?.(event);
	};
	return { document, ElementProbe, file, anchor, fire };
}

type ObserverAdapterProbe = {
	document: unknown;
	ElementProbe: unknown;
};

function adapterForObserver(
	probe: ObserverAdapterProbe,
	codexWait?: (timeoutMs: number) => void | Promise<void>,
): CmuxCodexBrowserAdapter {
	const evaluate = (source: string, args: unknown[]) =>
		runPageEvaluator(source, args, {
			document: probe.document,
			window: {},
			Element: probe.ElementProbe,
		});
	return new CmuxCodexBrowserAdapter({
		surfaceId: "surface-observer",
		codexEvaluate: evaluate,
		codexEvaluateCleanup: evaluate,
		codexWait,
	} as never);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("cmux Codex browser review regressions", () => {
	it("waits for a temporary content tab to load and spends one shrinking deadline before reading", async () => {
		let now = 0;
		spyOn(Date, "now").mockImplementation(() => now);
		const calls: RpcCall[] = [];
		let temporaryTabOpen = false;
		const browser = facadeFor({
			async codexRequest(method: string, params: Record<string, unknown>, timeoutMs?: number) {
				calls.push({ method, params, timeoutMs });
				try {
					switch (method) {
						case "browser.tab.list":
							return {
								tabs: temporaryTabOpen
									? [
											{ id: "main", focused: true },
											{ id: "temporary", focused: false },
										]
									: [{ id: "main", focused: true }],
							};
						case "browser.tab.new":
							temporaryTabOpen = true;
							return { surface_id: "surface-temporary" };
						case "browser.wait":
							return {};
						case "browser.snapshot":
							return { page: { title: "Loaded fixture" } };
						case "browser.eval":
							return { value: "loaded body text" };
						default:
							throw new Error(`Unexpected content RPC: ${method}`);
					}
				} finally {
					now += 100;
				}
			},
			async codexCleanupRequest(method: string) {
				if (method === "browser.tab.close") temporaryTabOpen = false;
				return {};
			},
		});

		const rows = await browser.tabs.content({
			urls: ["https://fixture.test/loaded"],
			contentType: "text",
			timeoutMs: 1_000,
		});
		expect(rows).toEqual([
			{ url: "https://fixture.test/loaded", title: "Loaded fixture", content: "loaded body text" },
		]);

		const waitIndex = calls.findIndex(call => call.method === "browser.wait");
		const firstReadIndex = calls.findIndex(
			call => call.method === "browser.snapshot" || call.method === "browser.eval",
		);
		expect(waitIndex).toBeGreaterThan(-1);
		expect(waitIndex).toBeLessThan(firstReadIndex);
		const timeouts = calls.map(call => call.timeoutMs);
		for (let index = 1; index < timeouts.length; index++) {
			expect(timeouts[index]).toBeLessThan(timeouts[index - 1] as number);
		}
		const wait = calls[waitIndex];
		expect(wait?.params).toMatchObject({ load_state: "complete", timeout_ms: wait.timeoutMs });
	});

	it("returns outerHTML for html content and the cmux snapshot representation for domSnapshot", async () => {
		let temporaryId: string | undefined;
		let sequence = 0;
		const urlsBySurface = new Map<string, string>();
		const browser = facadeFor({
			async codexRequest(method: string, params: Record<string, unknown>) {
				switch (method) {
					case "browser.tab.list":
						return {
							tabs: temporaryId
								? [
										{ id: "main", focused: true },
										{ id: temporaryId, focused: false },
									]
								: [{ id: "main", focused: true }],
						};
					case "browser.tab.new": {
						sequence++;
						temporaryId = `temporary-${sequence}`;
						const surface = `surface-${sequence}`;
						urlsBySurface.set(surface, String(params.url));
						return { surface_id: surface };
					}
					case "browser.wait":
						return {};
					case "browser.snapshot": {
						const url = urlsBySurface.get(String(params.surface_id));
						return {
							snapshot: `cmux snapshot for ${url}`,
							page: { title: `Title for ${url}`, html: `snapshot html for ${url}` },
						};
					}
					case "browser.eval": {
						const url = urlsBySurface.get(String(params.surface_id));
						return { value: `<html data-loaded-url="${url}"><body>outer html</body></html>` };
					}
					default:
						throw new Error(`Unexpected content RPC: ${method}`);
				}
			},
			async codexCleanupRequest(method: string) {
				if (method === "browser.tab.close") temporaryId = undefined;
				return {};
			},
		});

		const htmlUrl = "https://fixture.test/html";
		const snapshotUrl = "https://fixture.test/snapshot";
		const [html] = await browser.tabs.content({ urls: [htmlUrl], contentType: "html", timeoutMs: 1_000 });
		const [domSnapshot] = await browser.tabs.content({
			urls: [snapshotUrl],
			contentType: "domSnapshot",
			timeoutMs: 1_000,
		});

		expect(html).toEqual({
			url: htmlUrl,
			title: `Title for ${htmlUrl}`,
			content: `<html data-loaded-url="${htmlUrl}"><body>outer html</body></html>`,
		});
		expect(domSnapshot).toEqual({
			url: snapshotUrl,
			title: `Title for ${snapshotUrl}`,
			content: `cmux snapshot for ${snapshotUrl}`,
		});
	});

	it("uses an independent bounded cleanup budget after tabs.content times out", async () => {
		let now = 0;
		spyOn(Date, "now").mockImplementation(() => now);

		const runTimedOutContent = async (temporaryKind: "tab" | "surface") => {
			let temporaryOpen = false;
			let focusedTabId = temporaryKind === "tab" ? "main" : undefined;
			const cleanupCalls: Array<{ method: string; timeoutMs: number }> = [];
			const browser = facadeFor({
				async codexRequest(method: string) {
					switch (method) {
						case "browser.tab.list":
							if (temporaryKind === "surface") return { tabs: [] };
							return {
								tabs: temporaryOpen
									? [
											{ id: "main", focused: focusedTabId === "main" },
											{ id: "temporary", focused: focusedTabId === "temporary" },
										]
									: [{ id: "main", focused: true }],
							};
						case "browser.tab.new":
							temporaryOpen = true;
							if (temporaryKind === "tab") focusedTabId = "temporary";
							return { surface_id: "surface-temporary" };
						case "browser.wait":
							now += 6;
							return {};
						default:
							throw new Error(`Timed-out content should not call ${method}`);
					}
				},
				async codexCleanupRequest(method: string, params: Record<string, unknown>, timeoutMs: number) {
					cleanupCalls.push({ method, timeoutMs });
					if (timeoutMs <= 1) throw new Error("Cleanup requires more than 1 ms");
					switch (method) {
						case "browser.tab.close":
						case "surface.close":
							temporaryOpen = false;
							break;
						case "browser.tab.switch":
							focusedTabId = String(params.tab_id);
							break;
						default:
							throw new Error(`Unexpected cleanup RPC: ${method}`);
					}
					return {};
				},
			});

			const rows = await browser.tabs.content({
				urls: [`https://fixture.test/timed-out-${temporaryKind}`],
				contentType: "text",
				timeoutMs: 5,
			});
			return { rows, temporaryOpen, focusedTabId, cleanupCalls };
		};

		const nativeTab = await runTimedOutContent("tab");
		const fallbackSurface = await runTimedOutContent("surface");

		expect(nativeTab.rows).toEqual([{ url: "https://fixture.test/timed-out-tab", title: null, content: null }]);
		expect(fallbackSurface.rows).toEqual([
			{ url: "https://fixture.test/timed-out-surface", title: null, content: null },
		]);
		expect(nativeTab.cleanupCalls.map(call => call.method)).toEqual(["browser.tab.close", "browser.tab.switch"]);
		expect(fallbackSurface.cleanupCalls.map(call => call.method)).toEqual(["surface.close"]);
		expect(
			[...nativeTab.cleanupCalls, ...fallbackSurface.cleanupCalls].every(
				call => call.timeoutMs > 1 && call.timeoutMs <= 3_000,
			),
		).toBe(true);
		expect(nativeTab.temporaryOpen).toBe(false);
		expect(nativeTab.focusedTabId).toBe("main");
		expect(fallbackSurface.temporaryOpen).toBe(false);
	});

	it("closes a newly opened tabs.content surface when relisting native tabs fails", async () => {
		let listCalls = 0;
		const cleanupCalls: RpcCall[] = [];
		const browser = facadeFor({
			async codexRequest(method: string) {
				switch (method) {
					case "browser.tab.list":
						if (listCalls++ === 0) return { tabs: [{ id: "main", focused: true }] };
						throw new Error("native tab relist failed");
					case "browser.tab.new":
						return { surface_id: "opened-before-relist" };
					default:
						throw new Error(`Unexpected tabs.content RPC: ${method}`);
				}
			},
			async codexCleanupRequest(method: string, params: Record<string, unknown>, timeoutMs: number) {
				cleanupCalls.push({ method, params, timeoutMs });
				return {};
			},
		});

		expect(
			await browser.tabs.content({
				urls: ["https://fixture.test/relist-failure"],
				contentType: "text",
				timeoutMs: 1_000,
			}),
		).toEqual([{ url: "https://fixture.test/relist-failure", title: null, content: null }]);
		expect(cleanupCalls).toEqual([
			{ method: "surface.close", params: { surface_id: "opened-before-relist" }, timeoutMs: 3_000 },
		]);
	});

	it("reports missing and malformed native tab lists as the named open-tabs capability", async () => {
		const outcomes = await Promise.all(
			[{}, { tabs: "not-an-array" }].map(async response => {
				const browser = facadeFor({
					async codexRequest(method: string) {
						if (method !== "browser.tab.list") throw new Error(`Unexpected open-tabs RPC: ${method}`);
						return response;
					},
				});
				return await caughtError(() => browser.user.openTabs());
			}),
		);

		expect(outcomes).toEqual([
			{
				name: "BrowserCapabilityError",
				message: "Browser capability is unavailable: browser.user.openTabs",
			},
			{
				name: "BrowserCapabilityError",
				message: "Browser capability is unavailable: browser.user.openTabs",
			},
		]);
	});

	it("normalizes only unsupported native tab-list failures for user.openTabs", async () => {
		const openTabsOutcome = async (message: string) => {
			const browser = facadeFor({
				async codexRequest(method: string) {
					if (method !== "browser.tab.list") throw new Error(`Unexpected open-tabs RPC: ${method}`);
					throw new Error(message);
				},
			});
			return await caughtError(() => browser.user.openTabs());
		};
		const unsupported = await Promise.all(
			[
				"method_not_found: browser.tab.list",
				"unknown_method: browser.tab.list",
				"unsupported_method: browser.tab.list",
				"not_implemented: browser.tab.list",
			].map(openTabsOutcome),
		);
		const operational = await openTabsOutcome("cmux tab-list transport disconnected");

		expect({ unsupported, operational }).toEqual({
			unsupported: Array.from({ length: 4 }, () => ({
				name: "BrowserCapabilityError",
				message: "Browser capability is unavailable: browser.user.openTabs",
			})),
			operational: { name: "Error", message: "cmux tab-list transport disconnected" },
		});
	});

	it("rejects cmux download waits without invoking the unacknowledged transport", async () => {
		let waitCalls = 0;
		const current = await selectedTab(
			facadeFor({
				async codexDownloadWait() {
					waitCalls++;
					return { download: {} };
				},
			}),
		);

		expect(await caughtError(() => current.playwright.waitForEvent("download", { timeoutMs: 250 }))).toEqual({
			name: "BrowserCapabilityError",
			message: "Browser capability is unavailable: playwright.waitForEvent",
		});
		expect(waitCalls).toBe(0);
	});

	it("fully writes complex multi-item clipboards or rejects with the named capability before mutation", async () => {
		let appendedNodes = 0;
		let legacyCopies = 0;
		const nativeWrites: unknown[][] = [];
		const rpcCalls: RpcCall[] = [];
		const document = {
			body: {
				appendChild: () => {
					appendedNodes++;
				},
			},
			createElement: () => ({
				value: "",
				style: {},
				setAttribute: () => undefined,
				select: () => undefined,
				remove: () => undefined,
			}),
			execCommand: () => {
				legacyCopies++;
				return true;
			},
		};
		class BlobProbe {
			readonly parts: unknown[];
			readonly type: string;
			constructor(parts: unknown[], options: { type: string }) {
				this.parts = parts;
				this.type = options.type;
			}
		}
		class ClipboardItemProbe {
			readonly entries: Record<string, unknown>;
			constructor(entries: Record<string, unknown>) {
				this.entries = entries;
			}
		}
		const navigator = {
			clipboard: {
				write: async (items: unknown[]) => {
					nativeWrites.push(items);
				},
			},
		};
		const browser = facadeFor({
			async codexRequest(method: string, params: Record<string, unknown>, timeoutMs?: number) {
				rpcCalls.push({ method, params, timeoutMs });
				return {};
			},
			async codexEvaluate(source: string, args: unknown[]) {
				return await runPageEvaluator(source, args, {
					document,
					window: { document, navigator },
					navigator,
					ClipboardItem: ClipboardItemProbe,
					Blob: BlobProbe,
				});
			},
		});
		const current = await selectedTab(browser);
		const items: [CodexClipboardItem, ...CodexClipboardItem[]] = [
			{
				entries: [
					{ mimeType: "text/plain", text: "first plain value" },
					{ mimeType: "text/html", text: "<b>first rich value</b>" },
				],
			},
			{
				entries: [
					{ mimeType: "text/plain", text: "second plain value" },
					{ mimeType: "application/json", text: '{"item":2}' },
				],
			},
		];

		const error = await caughtError(() => current.clipboard.write(items));
		expect(appendedNodes).toBe(0);
		expect(legacyCopies).toBe(0);
		if (error.name !== "NO_ERROR") {
			expect(error).toEqual({
				name: "BrowserCapabilityError",
				message: "Browser capability is unavailable: tab.clipboard.write",
			});
			expect(nativeWrites).toEqual([]);
		} else {
			const [writtenItems] = nativeWrites as ClipboardItemProbe[][];
			expect(nativeWrites).toHaveLength(1);
			expect(
				writtenItems?.map(item =>
					Object.entries(item.entries).map(([mimeType, blob]) => ({
						mimeType,
						parts: (blob as BlobProbe).parts,
						type: (blob as BlobProbe).type,
					})),
				),
			).toEqual([
				[
					{ mimeType: "text/plain", parts: ["first plain value"], type: "text/plain" },
					{ mimeType: "text/html", parts: ["<b>first rich value</b>"], type: "text/html" },
				],
				[
					{ mimeType: "text/plain", parts: ["second plain value"], type: "text/plain" },
					{ mimeType: "application/json", parts: ['{"item":2}'], type: "application/json" },
				],
			]);
		}
	});

	it("rejects a missing select option without changing the current selection", async () => {
		const probe = selectProbe(["current", "other"], "current");
		const current = await selectedTab(facadeForSelect(probe));
		const outcome = await caughtError(() => current.playwright.locator("#choice").selectOption("missing"));

		expect(outcome.name).not.toBe("NO_ERROR");
		expect(probe.selectedValues()).toEqual(["current"]);
		expect(probe.events).toEqual([]);
	});

	it("keeps the first requested match when selecting several options on a non-multiple select", async () => {
		const probe = selectProbe(["preferred", "backup"], "backup");
		const current = await selectedTab(facadeForSelect(probe));
		const selected = await current.playwright.locator("#choice").selectOption(["preferred", "backup"]);

		expect(selected).toEqual(["preferred"]);
		expect(probe.selectedValues()).toEqual(["preferred"]);
	});

	it("propagates log RPC failures instead of fabricating an empty log history", async () => {
		const browser = facadeFor({
			async codexRequest(method: string) {
				throw new Error(`cmux log RPC failed: ${method}`);
			},
			async codexEvaluate() {
				return [];
			},
		});
		const current = await selectedTab(browser);

		await expect(current.dev.logs()).rejects.toThrow("cmux log RPC failed: browser.console.list");
	});

	it("resolves associated labels, aria-label, and space-separated aria-labelledby accessible names", async () => {
		const probe = labelProbe();
		const current = await selectedTab(
			facadeFor({
				async codexEvaluate(source: string, args: unknown[]) {
					return runPageEvaluator(source, args, { document: probe.document, window: probe.view });
				},
			}),
		);

		const counts = await Promise.all(
			["Associated Label", "Direct ARIA Label", "ARIA Labelled By"].map(label =>
				current.playwright.getByLabel(label, { exact: true }).count(),
			),
		);

		expect(counts).toEqual([1, 1, 1]);
	});

	it("uses aria-labelledby, then aria-label, before native labels for role queries", async () => {
		const probe = labelProbe();
		const current = await selectedTab(
			facadeFor({
				async codexEvaluate(source: string, args: unknown[]) {
					return runPageEvaluator(source, args, { document: probe.document, window: probe.view });
				},
			}),
		);

		expect(await current.playwright.getByRole("textbox", { name: "ARIA Labelled By", exact: true }).count()).toBe(1);
		expect(await current.playwright.getByRole("textbox", { name: "Preferred ARIA", exact: true }).count()).toBe(1);
		expect(await current.playwright.getByRole("textbox", { name: "Native Name", exact: true }).count()).toBe(0);
	});

	it("uses canonical implicit roles and accessible names in elementInfo", async () => {
		const nativeLabel = { innerText: "Native Name", textContent: "Native Name" };
		const checkbox = {
			tagName: "INPUT",
			type: "checkbox",
			labels: [nativeLabel],
			innerText: "",
			textContent: "",
			outerHTML: '<input type="checkbox" aria-label="Preferred ARIA">',
			getAttribute: (name: string) => (name === "aria-label" ? "Preferred ARIA" : null),
			hasAttribute: (name: string) => name === "type",
			closest: () => checkbox,
			getBoundingClientRect: () => ({ x: 10, y: 20, width: 30, height: 40 }),
		};
		const document = { elementFromPoint: () => checkbox, getElementById: () => null };
		const current = await selectedTab(
			facadeFor({
				async codexEvaluate(source: string, args: unknown[]) {
					return runPageEvaluator(source, args, { document, window: {} });
				},
			}),
		);

		expect(await current.playwright.elementInfo({ x: 11, y: 21 })).toEqual([
			expect.objectContaining({ tagName: "input", role: "checkbox", ariaName: "Preferred ARIA" }),
		]);
	});

	it("returns one canonical visible DOM DTO with cmux ref node ids", async () => {
		const current = await selectedTab(
			facadeFor({
				async observe() {
					throw new Error("get_visible_dom must create actionable page ARIA refs");
				},
				async ariaSnapshot(_selector: unknown, options: unknown) {
					expect(options).toEqual({ boxes: true });
					return '- generic "Parent Media Asset" [ref=e6] [box=0,0,400,300]\n- link "Media Asset" [ref=e7] [box=12,24,96,32]';
				},
				async ref() {
					throw new Error("get_visible_dom must not wait for ref resolution");
				},
				elementHandle() {
					throw new Error("get_visible_dom must not issue one RPC per ARIA ref");
				},
				async codexEvaluateCleanup() {
					return true;
				},
				async codexEvaluate(source: string, args: unknown[], timeoutMs: number) {
					expect(source).toContain("_ariaRef");
					expect(args).toEqual([]);
					expect(timeoutMs).toBeGreaterThan(0);
					expect(timeoutMs).toBeLessThanOrEqual(3_000);
					return {
						nodes: [
							{
								node_id: "e7",
								tag: "a",
								role: "link",
								text: "Media Asset",
								x: 12,
								y: 24,
								width: 96,
								height: 32,
							},
						],
					};
				},
			}),
		);

		expect(await current.dom_cua.get_visible_dom()).toEqual({
			nodes: [{ node_id: "e7", tag: "a", role: "link", text: "Media Asset", x: 12, y: 24, width: 96, height: 32 }],
		});
	});

	it("downloads media through the page context so cookies and blob URLs remain available", async () => {
		const payload = Buffer.from("page-authenticated-media");
		const writes: Buffer[] = [];
		let transferStarts = 0;
		let transferStatuses = 0;
		const hostFetch = spyOn(globalThis, "fetch").mockRejectedValue(new Error("host fetch must not run"));
		spyOn(Bun, "write").mockImplementation(async (_destination, data) => {
			writes.push(Buffer.from(data as Uint8Array));
			return writes.at(-1)?.byteLength ?? 0;
		});
		const current = await selectedTab(
			facadeFor({
				codexCwd: () => "/tmp/codex-media-contract",
				async codexEvaluate(source: string, args: unknown[]) {
					if (args[1] === "status") return { attached: true, visible: true, enabled: true };
					if (args[1] === "mediaUrl") return "blob:fixture-media";
					if (source.includes("__ompCodexMediaTransfers") && args.length === 2) {
						transferStarts++;
						return true;
					}
					if (source.includes("__ompCodexMediaTransfers") && args.length === 1) {
						transferStatuses++;
						return {
							url: "blob:fixture-media",
							contentType: "application/octet-stream",
							base64Chunks: [payload.toString("base64")],
						};
					}
					throw new Error("Unexpected page evaluation");
				},
				async codexWait() {
					throw new Error("Completed transfer must not poll");
				},
			}),
		);

		await current.playwright.locator("#media").downloadMedia({ timeoutMs: 250 });

		expect(hostFetch).not.toHaveBeenCalled();
		expect(transferStarts).toBe(1);
		expect(transferStatuses).toBe(1);
		expect(writes).toEqual([payload]);
	});

	it("rejects unknown-length media before retaining a streaming chunk beyond 32 MiB", async () => {
		let reads = 0;
		let cancellations = 0;
		let arrayBufferCalls = 0;
		const writes: Uint8Array[] = [];
		const oversizedChunk = new Uint8Array(32 * 1024 * 1024 + 1);
		const response = {
			ok: true,
			status: 200,
			url: "blob:oversized-media",
			headers: {
				get(name: string) {
					return name.toLowerCase() === "content-type" ? "application/octet-stream" : null;
				},
			},
			body: {
				getReader() {
					return {
						async read() {
							reads++;
							return { done: false, value: oversizedChunk };
						},
						async cancel() {
							cancellations++;
						},
						releaseLock() {},
					};
				},
			},
			async arrayBuffer() {
				arrayBufferCalls++;
				return new Uint8Array([1]).buffer;
			},
		};
		spyOn(globalThis, "fetch").mockResolvedValue(response as never);
		spyOn(Bun, "write").mockImplementation(async (_destination, data) => {
			writes.push(new Uint8Array(data as Uint8Array));
			return writes.at(-1)?.byteLength ?? 0;
		});
		const document = { baseURI: "https://fixture.test/" };
		const current = await selectedTab(
			facadeFor({
				codexCwd: () => "/tmp/codex-media-contract",
				async codexEvaluate(source: string, args: unknown[]) {
					if (args[1] === "status") return { attached: true, visible: true, enabled: true };
					if (args[1] === "mediaUrl") return "blob:oversized-media";
					return runPageEvaluator(source, args, { document, window: {} });
				},
				async codexEvaluateCleanup() {
					return true;
				},
				async codexWait() {
					await Promise.resolve();
				},
			}),
		);

		const error = await caughtError(() => current.playwright.locator("#media").downloadMedia({ timeoutMs: 250 }));

		expect(error.message).toContain("downloadMedia response exceeds the 32 MiB limit");
		expect(reads).toBe(1);
		expect(cancellations).toBe(1);
		expect(arrayBufferCalls).toBe(0);
		expect(writes).toEqual([]);
	});

	it("revalidates bounded media after the cmux page boundary", async () => {
		const chunk = Buffer.alloc(1024).toString("base64");
		const oversizedChunks = Array.from({ length: 32 * 1024 + 1 }, () => chunk);
		let persistenceCalls = 0;
		const current = await selectedTab(
			facadeFor({
				codexCwd: () => "/tmp/codex-media-contract",
				async codexEvaluate(source: string, args: unknown[]) {
					if (args[1] === "status") return { attached: true, visible: true, enabled: true };
					if (args[1] === "mediaUrl") return "blob:mutated-media";
					if (source.includes("__ompCodexMediaTransfers") && args.length === 2) return true;
					if (source.includes("__ompCodexMediaTransfers") && args.length === 1) {
						return {
							url: "blob:mutated-media",
							contentType: "application/octet-stream",
							base64Chunks: oversizedChunks,
						};
					}
					throw new Error("Unexpected page evaluation");
				},
				async codexPersistFile() {
					persistenceCalls++;
					throw new Error("oversized media reached persistence");
				},
				async codexWait() {
					throw new Error("Completed transfer must not poll");
				},
			}),
		);

		const error = await caughtError(() => current.playwright.locator("#media").downloadMedia({ timeoutMs: 250 }));

		expect(error.message).toContain("downloadMedia response exceeds the 32 MiB limit");
		expect(persistenceCalls).toBe(0);
	});

	it("maps select size to the same implicit listbox role as Puppeteer", async () => {
		const current = await selectedTab(facadeForSelect(selectProbe(["one", "two"], "one", false, 2)));

		expect(await current.playwright.getByRole("listbox").count()).toBe(1);
		expect(await current.playwright.getByRole("combobox").count()).toBe(0);
	});

	it("uses native key input after focusing semantic locators", async () => {
		const commands: string[] = [];
		const presses: Array<{ key: string; timeoutMs?: number }> = [];
		const current = await selectedTab(
			facadeFor({
				async codexEvaluate(_source: string, args: unknown[]) {
					const command = String(args[1]);
					commands.push(command);
					if (command === "status") return { attached: true, visible: true, enabled: true };
					return true;
				},
				async press(key: string, options?: { timeoutMs?: number }) {
					presses.push({ key, timeoutMs: options?.timeoutMs });
				},
			}),
		);

		await current.playwright.getByLabel("Name").press("a");

		expect(commands).toEqual(["status", "focus"]);
		expect(presses).toHaveLength(1);
		expect(presses[0]?.key).toBe("a");
		expect(presses[0]?.timeoutMs).toBeGreaterThan(0);
	});

	it("routes locator clicks through native input and rejects unrepresentable options", async () => {
		const commands: string[] = [];
		const nativeClicks: string[] = [];
		const nativeDoubleClicks: string[] = [];
		const disposedTokens: string[] = [];
		const current = await selectedTab(
			facadeFor({
				async codexEvaluate(_source: string, args: unknown[]) {
					const command = String(args[1]);
					commands.push(command);
					if (command === "status") return { attached: true, visible: true, enabled: true };
					if (command === "bindNativeSelector") {
						const token = String((args[2] as { token: string }).token);
						return `[data-omp-codex-action-token="${token}"]`;
					}
					if (command === "click" || command === "dblclick") throw new Error("synthetic click must not run");
					if (command === "armNativeFileActivation") return false;
					return true;
				},
				async codexEvaluateCleanup(_source: string, args: unknown[]) {
					disposedTokens.push(String(args[0]));
					return true;
				},
				async click(selector: string) {
					nativeClicks.push(selector);
				},
				async dblclick(selector: string) {
					nativeDoubleClicks.push(selector);
				},
			}),
		);

		await current.playwright.locator("#primary").click({ button: "left" });
		await current.playwright.getByRole("button", { name: "Primary" }).dblclick();
		const unsupported = await Promise.all([
			caughtError(() => current.playwright.locator("#primary").click({ button: "middle" })),
			caughtError(() => current.playwright.locator("#primary").click({ modifiers: ["ControlOrMeta"] })),
			caughtError(() => current.playwright.locator("#primary").click({ force: true })),
		]);

		expect(nativeClicks).toEqual(["#primary"]);
		expect(nativeDoubleClicks).toHaveLength(1);
		expect(nativeDoubleClicks[0]).toMatch(/^\[data-omp-codex-action-token=/);
		expect(disposedTokens).toHaveLength(1);
		expect(commands).not.toContain("click");
		expect(commands).not.toContain("dblclick");
		for (const error of unsupported) {
			expect(error).toEqual({
				name: "BrowserCapabilityError",
				message: "Browser capability is unavailable: locator.click options",
			});
		}
	});

	it("propagates native overlay rejection without synthetic locator activation", async () => {
		const commands: string[] = [];
		const nativeTimeouts: number[] = [];
		let coveredTargetActivations = 0;
		const current = await selectedTab(
			facadeFor({
				async codexEvaluate(_source: string, args: unknown[]) {
					const command = String(args[1]);
					commands.push(command);
					if (command === "status") return { attached: true, visible: true, enabled: true };
					if (command === "click" || command === "dblclick") coveredTargetActivations++;
					if (command === "armNativeFileActivation") return false;
					return true;
				},
				async click(_selector: string, timeoutMs?: number) {
					nativeTimeouts.push(timeoutMs ?? 0);
					throw new Error("covered target does not receive pointer events");
				},
				async dblclick(_selector: string, timeoutMs?: number) {
					nativeTimeouts.push(timeoutMs ?? 0);
					throw new Error("covered target does not receive pointer events");
				},
			}),
		);

		const outcomes = await Promise.all([
			caughtError(() => current.playwright.locator("#covered").click({ timeoutMs: 250 })),
			caughtError(() => current.playwright.locator("#covered").dblclick({ timeoutMs: 250 })),
		]);

		expect(outcomes).toEqual([
			{ name: "Error", message: "covered target does not receive pointer events" },
			{ name: "Error", message: "covered target does not receive pointer events" },
		]);
		expect(nativeTimeouts).toHaveLength(2);
		expect(nativeTimeouts.every(timeout => timeout > 0 && timeout <= 250)).toBe(true);
		expect(coveredTargetActivations).toBe(0);
		expect(commands).not.toContain("click");
		expect(commands).not.toContain("dblclick");
	});

	it("rejects coordinate CUA actions instead of dispatching synthetic DOM events", async () => {
		let evaluations = 0;
		const current = await selectedTab(
			facadeFor({
				async codexEvaluate() {
					evaluations++;
					return true;
				},
			}),
		);
		const outcomes = await Promise.all([
			caughtError(() => current.cua.click({ x: 1, y: 2, button: 1 })),
			caughtError(() => current.cua.double_click({ x: 1, y: 2 })),
			caughtError(() =>
				current.cua.drag({
					path: [
						{ x: 1, y: 2 },
						{ x: 3, y: 4 },
					],
				}),
			),
			caughtError(() => current.cua.move({ x: 1, y: 2 })),
			caughtError(() => current.cua.scroll({ x: 1, y: 2, scrollX: 3, scrollY: 4 })),
		]);

		expect(Array.from(outcomes)).toEqual(
			["cua.click", "cua.double_click", "cua.drag", "cua.move", "cua.scroll"].map(capability => ({
				name: "BrowserCapabilityError",
				message: `Browser capability is unavailable: ${capability}`,
			})),
		);
		expect(evaluations).toBe(0);
	});

	it("ignores canceled file-input activation", async () => {
		const probe = observerProbe();
		const adapter = adapterForObserver(probe, () => {
			throw new Error("Canceled activation must not create a file chooser");
		});
		await adapter.beginRun();

		try {
			probe.fire(probe.file, true);
			await Promise.resolve();
			expect(probe.file.getAttribute("data-omp-codex-file-token")).toBeNull();
			expect(
				await caughtError(() =>
					adapter.invoke("playwright.waitForEvent", {
						tabId: "1",
						event: "filechooser",
						timeoutMs: 250,
					}),
				),
			).toEqual({ name: "Error", message: "Canceled activation must not create a file chooser" });
		} finally {
			await adapter.dispose();
		}
	});

	it("ignores untrusted file-input activation", async () => {
		const probe = observerProbe();
		const adapter = adapterForObserver(probe);
		await adapter.beginRun();

		try {
			probe.fire(probe.file, false, false, false);
			await Promise.resolve();
			expect(probe.file.getAttribute("data-omp-codex-file-token")).toBeNull();
		} finally {
			await adapter.dispose();
		}
	});

	it("records native adapter file activation without accepting arbitrary untrusted page events", async () => {
		const probe = observerProbe(true);
		const commands: string[] = [];
		let nativeClicks = 0;
		const evaluate = (source: string, args: unknown[]) => {
			const command = args[1];
			if (typeof command === "string") commands.push(command);
			if (command === "status") return { attached: true, visible: true, enabled: true };
			return runPageEvaluator(source, args, {
				document: probe.document,
				window: {},
				Element: probe.ElementProbe,
			});
		};
		const { adapter, browser } = adapterAndFacadeFor({
			codexEvaluate: evaluate,
			codexEvaluateCleanup: async (source: string, args: unknown[]) => evaluate(source, args),
			async click() {
				nativeClicks++;
				probe.fire(probe.file, false, false, false);
			},
			async codexWait() {
				await Promise.resolve();
			},
		});
		try {
			const current = await selectedTab(browser);
			const chooserPromise = current.playwright.waitForEvent("filechooser", { timeoutMs: 250 });
			await Promise.resolve();

			await current.playwright.locator("#upload").click();
			const chooser = await chooserPromise;

			if (!("isMultiple" in chooser)) throw new Error("Expected file chooser event");
			expect(nativeClicks).toBe(1);
			expect(chooser.isMultiple()).toBe(true);
			expect(commands).not.toContain("recordFileActivation");
		} finally {
			await adapter.dispose();
		}
	});

	it("does not synthesize a chooser after a trusted native file-input click is default-prevented", async () => {
		const probe = observerProbe();
		const waiterPolling = Promise.withResolvers<void>();
		const releaseWaiter = Promise.withResolvers<void>();
		let releasedWaits = 0;
		const evaluate = (source: string, args: unknown[]) => {
			const command = args[1];
			if (command === "status") return { attached: true, visible: true, enabled: true };
			return runPageEvaluator(source, args, {
				document: probe.document,
				window: {},
				Element: probe.ElementProbe,
			});
		};
		const { adapter, browser } = adapterAndFacadeFor({
			codexEvaluate: evaluate,
			codexEvaluateCleanup: async (source: string, args: unknown[]) => evaluate(source, args),
			async click() {
				probe.fire(probe.file, true);
			},
			async codexWait() {
				waiterPolling.resolve();
				await releaseWaiter.promise;
				if (++releasedWaits > 1) throw new Error("No chooser token/event was recorded or returned");
			},
		});
		try {
			const current = await selectedTab(browser);
			const chooserPromise = current.playwright.waitForEvent("filechooser", { timeoutMs: 250 });
			await waiterPolling.promise;

			await current.playwright.locator("#upload").click();
			releaseWaiter.resolve();
			const outcome = await chooserPromise.then(
				chooser => {
					if (!("isMultiple" in chooser)) throw new Error("Expected file chooser event");
					return { status: "resolved", multiple: chooser.isMultiple() };
				},
				(error: Error) => ({ status: "rejected", name: error.name, message: error.message }),
			);

			expect(outcome).toEqual({
				status: "rejected",
				name: "Error",
				message: "No chooser token/event was recorded or returned",
			});
			expect(probe.file.getAttribute("data-omp-codex-file-token")).toBeNull();
		} finally {
			releaseWaiter.resolve();
			await adapter.dispose();
		}
	});

	it("captures file-input activation before bubble propagation is stopped", async () => {
		const probe = observerProbe();
		const adapter = adapterForObserver(probe);
		await adapter.beginRun();

		try {
			probe.fire(probe.file, false, true);
			await Promise.resolve();
			expect(probe.file.getAttribute("data-omp-codex-file-token")).toMatch(/^file-/);
		} finally {
			await adapter.dispose();
		}
	});

	it("removes file-chooser tokens on dispose and uses run-unique tokens across adapter cycles", async () => {
		const probe = observerProbe();
		const cycles: Array<{ fileToken: string | null; attributeAfterDispose: string | null }> = [];

		for (let cycle = 0; cycle < 2; cycle++) {
			const adapter = adapterForObserver(probe);
			await adapter.beginRun();
			probe.fire(probe.file);
			await Promise.resolve();
			const fileToken = probe.file.getAttribute("data-omp-codex-file-token");

			await adapter.dispose();
			cycles.push({
				fileToken,
				attributeAfterDispose: probe.file.getAttribute("data-omp-codex-file-token"),
			});
		}

		expect(cycles.map(cycle => cycle.attributeAfterDispose)).toEqual([null, null]);
		expect(cycles.every(cycle => !!cycle.fileToken)).toBe(true);
		expect(new Set(cycles.map(cycle => cycle.fileToken)).size).toBe(2);
	});

	it("removes page file tokens after chooser timeout and aborted run", async () => {
		const probe = observerProbe();
		const adapter = adapterForObserver(probe, async () => {
			throw new Error("poll timeout");
		});
		await adapter.beginRun();
		probe.fire(probe.file);
		await Promise.resolve();
		expect(probe.file.getAttribute("data-omp-codex-file-token")).toMatch(/^file-/);
		await caughtError(() =>
			adapter.invoke("playwright.waitForEvent", { tabId: "1", event: "filechooser", timeoutMs: 1 }),
		);
		await adapter.dispose();
		expect(probe.file.getAttribute("data-omp-codex-file-token")).toBeNull();
	});

	it("ignores file-chooser clicks that predate waiter registration", async () => {
		const probe = observerProbe();
		let waitCalls = 0;
		let laterToken: string | null = null;
		const adapter = adapterForObserver(probe, async () => {
			waitCalls++;
			if (waitCalls > 1) throw new Error("Expected the later chooser click to resolve the waiter");
			probe.fire(probe.file);
			await Promise.resolve();
			laterToken = probe.file.getAttribute("data-omp-codex-file-token");
		});
		await adapter.beginRun();
		probe.fire(probe.file);
		await Promise.resolve();
		const staleToken = probe.file.getAttribute("data-omp-codex-file-token");

		try {
			const event = await adapter.invoke<{ token: string; multiple?: boolean }>("playwright.waitForEvent", {
				tabId: "1",
				event: "filechooser",
				timeoutMs: 250,
			});

			if (!laterToken) throw new Error("Later file-chooser token was not captured");
			expect(event.token).not.toBe(staleToken);
			expect(event).toEqual({ token: laterToken, multiple: false });
			expect(waitCalls).toBe(1);
		} finally {
			await adapter.dispose();
		}
	});

	it("fans one new file-chooser event out to every waiter already registered", async () => {
		const probe = observerProbe();
		const releaseWaiters = Promise.withResolvers<void>();
		let pollWaiters = 0;
		let chooserToken: string | null = null;
		const adapter = adapterForObserver(probe, async () => {
			pollWaiters++;
			if (pollWaiters > 2) throw new Error("A file-chooser event must not be consumed by only one waiter");
			if (pollWaiters === 2) {
				probe.fire(probe.file);
				await Promise.resolve();
				chooserToken = probe.file.getAttribute("data-omp-codex-file-token");
				releaseWaiters.resolve();
			}
			await releaseWaiters.promise;
		});
		await adapter.beginRun();

		try {
			const wait = () =>
				adapter.invoke<{ token: string; multiple?: boolean }>("playwright.waitForEvent", {
					tabId: "1",
					event: "filechooser",
					timeoutMs: 250,
				});
			const [first, second] = await Promise.all([wait(), wait()]);

			expect(pollWaiters).toBe(2);
			expect(chooserToken).not.toBeNull();
			if (!chooserToken) throw new Error("Concurrent file-chooser token was not captured");
			expect(first).toEqual({ token: chooserToken, multiple: false });
			expect(second).toEqual(first);
		} finally {
			await adapter.dispose();
		}
	});

	it("registers a file-chooser waiter atomically with observer preparation", async () => {
		const probe = observerProbe();
		let evaluateCalls = 0;
		let chooserToken: string | null = null;
		const evaluate = (source: string, args: unknown[]) => {
			evaluateCalls++;
			const result = runPageEvaluator(source, args, {
				document: probe.document,
				window: {},
				Element: probe.ElementProbe,
			});
			if (evaluateCalls === 2) {
				probe.fire(probe.file);
				queueMicrotask(() => {
					chooserToken = probe.file.getAttribute("data-omp-codex-file-token");
				});
			}
			return result;
		};
		const adapter = new CmuxCodexBrowserAdapter({
			surfaceId: "surface-observer",
			codexEvaluate: evaluate,
			codexEvaluateCleanup: evaluate,
			codexWait: () => {
				throw new Error("Atomic registration must resolve without polling");
			},
		} as never);
		await adapter.beginRun();

		try {
			const event = await adapter.invoke<{ token: string; multiple?: boolean }>("playwright.waitForEvent", {
				tabId: "1",
				event: "filechooser",
				timeoutMs: 250,
			});

			expect(chooserToken).not.toBeNull();
			if (!chooserToken) throw new Error("File-chooser token was not captured");
			expect(event).toEqual({ token: chooserToken, multiple: false });
			expect(evaluateCalls).toBe(3);
		} finally {
			await adapter.dispose();
		}
	});

	it("falls back through browser.open_split when tabs.content cannot list native tabs", async () => {
		const calls: RpcCall[] = [];
		const cleanupCalls: RpcCall[] = [];
		const browser = facadeFor({
			async codexRequest(method: string, params: Record<string, unknown>, timeoutMs?: number) {
				calls.push({ method, params, timeoutMs });
				switch (method) {
					case "browser.tab.list":
						throw new Error("unsupported_method: browser.tab.list");
					case "browser.open_split":
						return { surface_id: "fallback-content-surface" };
					case "browser.wait":
						return {};
					case "browser.snapshot":
						return { page: { title: "Fallback content" } };
					case "browser.eval":
						return { value: "content read from fallback split" };
					default:
						throw new Error(`Unexpected fallback content RPC: ${method}`);
				}
			},
			async codexCleanupRequest(method: string, params: Record<string, unknown>, timeoutMs?: number) {
				cleanupCalls.push({ method, params, timeoutMs });
				return {};
			},
		});

		const rows = await browser.tabs.content({
			urls: ["https://fixture.test/fallback-content"],
			contentType: "text",
			timeoutMs: 1_000,
		});

		expect(rows).toEqual([
			{
				url: "https://fixture.test/fallback-content",
				title: "Fallback content",
				content: "content read from fallback split",
			},
		]);
		expect(calls.map(call => call.method)).toEqual([
			"browser.tab.list",
			"browser.open_split",
			"browser.wait",
			"browser.snapshot",
			"browser.eval",
		]);
		expect(cleanupCalls).toEqual([
			{
				method: "surface.close",
				params: { surface_id: "fallback-content-surface" },
				timeoutMs: 3_000,
			},
		]);
	});

	it("cleans up a native tab and distinct fallback surface before restoring focus", async () => {
		let nativeTabCreated = false;
		const cleanupCalls: RpcCall[] = [];
		const browser = facadeFor({
			async codexRequest(method: string) {
				switch (method) {
					case "browser.tab.list":
						return {
							tabs: nativeTabCreated
								? [
										{ id: "original-tab", focused: false },
										{ id: "native-temporary-tab", focused: true },
									]
								: [{ id: "original-tab", focused: true }],
						};
					case "browser.tab.new":
						nativeTabCreated = true;
						return {};
					case "browser.open_split":
						return { surface_id: "distinct-fallback-surface" };
					case "browser.wait":
						return {};
					case "browser.snapshot":
						return { page: { title: "Native plus fallback" } };
					case "browser.eval":
						return { value: "native plus fallback content" };
					default:
						throw new Error(`Unexpected native fallback RPC: ${method}`);
				}
			},
			async codexCleanupRequest(method: string, params: Record<string, unknown>, timeoutMs?: number) {
				cleanupCalls.push({ method, params, timeoutMs });
				return {};
			},
		});

		const rows = await browser.tabs.content({
			urls: ["https://fixture.test/native-with-fallback"],
			contentType: "text",
			timeoutMs: 1_000,
		});

		expect(rows).toEqual([
			{
				url: "https://fixture.test/native-with-fallback",
				title: "Native plus fallback",
				content: "native plus fallback content",
			},
		]);
		expect(cleanupCalls).toEqual([
			{ method: "browser.tab.close", params: { tab_id: "native-temporary-tab" }, timeoutMs: 3_000 },
			{ method: "surface.close", params: { surface_id: "distinct-fallback-surface" }, timeoutMs: 3_000 },
			{ method: "browser.tab.switch", params: { tab_id: "original-tab" }, timeoutMs: 3_000 },
		]);
	});
	it("maps unsupported reload and content RPCs to exact capability errors", async () => {
		const reloadBrowser = facadeFor({
			async codexRequest(method: string) {
				throw new Error(`unsupported_method: ${method}`);
			},
		});
		const reloadTab = await selectedTab(reloadBrowser);
		const contentBrowser = facadeFor({
			async codexRequest(method: string) {
				throw new Error(`unsupported_method: ${method}`);
			},
		});

		expect(await caughtError(() => reloadTab.reload())).toEqual({
			name: "BrowserCapabilityError",
			message: "Browser capability is unavailable: tab.reload",
		});
		expect(
			await caughtError(() =>
				contentBrowser.tabs.content({ urls: ["https://fixture.test/other"], contentType: "text" }),
			),
		).toEqual({ name: "BrowserCapabilityError", message: "Browser capability is unavailable: tabs.content" });
	});

	it("keeps session names in trusted adapter state instead of page globals", async () => {
		const evaluations: Array<{ source: string; args: unknown[] }> = [];
		const adapter = new CmuxCodexBrowserAdapter({
			surfaceId: "surface-contract",
			async codexEvaluate(source: string, args: unknown[]) {
				evaluations.push({ source, args });
				return 0;
			},
			async codexEvaluateCleanup() {
				return true;
			},
		} as never);
		await adapter.beginRun();
		await createCodexBrowserFacade(adapter).nameSession("private logical name");
		await adapter.dispose();

		for (const evaluation of evaluations) {
			expect(evaluation.source).not.toContain("__ompCodexBrowserSessionName");
			expect(evaluation.args).not.toContain("surface-contract");
			expect(evaluation.args).not.toContain("private logical name");
		}
	});

	it("rolls back logical tab state when new-tab preparation fails", async () => {
		const adapter = new CmuxCodexBrowserAdapter({
			surfaceId: "surface-contract",
			async codexEvaluate() {
				throw new Error("observer installation failed");
			},
			async codexEvaluateCleanup() {
				return true;
			},
			async codexUrl() {
				return "https://fixture.test/current";
			},
			async title() {
				return "Current fixture";
			},
		} as never);
		const browser = createCodexBrowserFacade(adapter);
		const current = await browser.tabs.selected();
		if (!current) throw new Error("Expected an initial logical tab");
		await current.close();

		try {
			await expect(browser.tabs.new()).rejects.toThrow("observer installation failed");
			expect(adapter.currentTabId).toBe(current.id);
			expect(await browser.tabs.selected()).toBeUndefined();
			expect(await browser.tabs.list()).toEqual([]);
		} finally {
			await adapter.dispose();
		}
	});

	it("uses canonical input roles and excludes accessibility-hidden role matches", async () => {
		type ProbeElement = Record<string, unknown> & {
			attributes: Record<string, string>;
			parentElement: ProbeElement | null;
		};
		let elements: ProbeElement[] = [];
		const view = {
			getComputedStyle: (element: ProbeElement) =>
				(element.style as Record<string, string> | undefined) ?? {
					display: "block",
					visibility: "visible",
					opacity: "1",
				},
		};
		const document = {
			defaultView: view,
			getElementById: () => null,
			querySelectorAll: () => elements,
		};
		const element = (
			tagName: string,
			attributes: Record<string, string>,
			parentElement: ProbeElement | null = null,
		): ProbeElement => ({
			tagName,
			attributes,
			parentElement,
			ownerDocument: document,
			children: [],
			labels: [],
			hidden: false,
			disabled: false,
			textContent: attributes["aria-label"] ?? "",
			innerText: attributes["aria-label"] ?? "",
			getAttribute(name: string) {
				return attributes[name] ?? null;
			},
			hasAttribute(name: string) {
				return Object.hasOwn(attributes, name);
			},
			getBoundingClientRect: () => ({ width: 100, height: 20 }),
		});
		const hiddenParent = element("DIV", { "aria-hidden": "true" });
		const inertParent = element("DIV", { inert: "" });
		const list = element("UL", {});
		const listItem = element("LI", {});
		listItem.textContent = "One Item";
		listItem.innerText = "One Item";
		const imageButton = element("BUTTON", {});
		const imageChild = element("IMG", { alt: "Save" }, imageButton);
		imageButton.children = [imageChild];
		const mixedText = element("DIV", {});
		mixedText.textContent = "Mixed   Case Text";
		mixedText.innerText = "Mixed   Case Text";
		elements = [
			element("INPUT", { type: "search", "aria-label": "Search" }),
			element("INPUT", { type: "number", "aria-label": "Number" }),
			element("INPUT", { type: "text", list: "items", "aria-label": "Listed" }),
			element("INPUT", { type: "password", "aria-label": "Secret" }),
			element("INPUT", { type: "date", "aria-label": "Date" }),
			element("IMG", { alt: "" }),
			element("IMG", { alt: "Hero" }),
			list,
			listItem,
			imageButton,
			imageChild,
			mixedText,
			hiddenParent,
			element("BUTTON", { "aria-label": "Hidden" }, hiddenParent),
			element("BUTTON", { "aria-label": "Inert" }, inertParent),
		];
		const current = await selectedTab(
			facadeFor({
				async codexEvaluate(source: string, args: unknown[]) {
					return runPageEvaluator(source, args, { document, window: view });
				},
			}),
		);

		expect(
			await Promise.all([
				current.playwright.getByRole("searchbox", { name: "Search", exact: true }).count(),
				current.playwright.getByRole("spinbutton", { name: "Number", exact: true }).count(),
				current.playwright.getByRole("combobox", { name: "Listed", exact: true }).count(),
				current.playwright.getByRole("textbox", { name: "Secret", exact: true }).count(),
				current.playwright.getByRole("textbox", { name: "Date", exact: true }).count(),
				current.playwright.getByRole("img").count(),
				current.playwright.getByRole("list").count(),
				current.playwright.getByRole("listitem", { name: "one item" }).count(),
				current.playwright.getByRole("button", { name: "Save", exact: true }).count(),
				current.playwright.getByText("mixed case").count(),
				current.playwright.getByRole("button", { name: "Hidden", exact: true }).count(),
				current.playwright.getByRole("button", { name: "Inert", exact: true }).count(),
			]),
		).toEqual([1, 1, 1, 0, 0, 2, 1, 1, 1, 1, 0, 0]);
	});

	it("preserves selections and appends writable non-selection inputs for CUA typing", async () => {
		type EventInitProbe = { bubbles?: boolean; cancelable?: boolean; data?: string; inputType?: string };
		class InputEventProbe {
			readonly bubbles: boolean;
			readonly cancelable: boolean;
			readonly data: string | undefined;
			readonly inputType: string | undefined;
			constructor(
				readonly type: string,
				init: EventInitProbe = {},
			) {
				this.bubbles = init.bubbles ?? false;
				this.cancelable = init.cancelable ?? false;
				this.data = init.data;
				this.inputType = init.inputType;
			}
		}
		const events: Array<{ target: "input" | "number" | "editable"; event: InputEventProbe }> = [];
		const view: Record<string, unknown> = { Event: InputEventProbe, InputEvent: InputEventProbe };
		const document: Record<string, unknown> = { defaultView: view };
		const rangeTextCalls: unknown[][] = [];
		const input: Record<string, unknown> = {
			tagName: "INPUT",
			type: "text",
			value: "abcdef",
			selectionStart: 2,
			selectionEnd: 4,
			disabled: false,
			readOnly: false,
			ownerDocument: document,
			getAttribute: () => null,
			setRangeText(text: string, start: number, end: number, mode: string) {
				rangeTextCalls.push([text, start, end, mode]);
				this.value = String(this.value).slice(0, start) + text + String(this.value).slice(end);
				this.selectionStart = start + text.length;
				this.selectionEnd = start + text.length;
			},
			dispatchEvent(event: InputEventProbe) {
				events.push({ target: "input", event });
				return true;
			},
		};
		const numberInput: Record<string, unknown> = {
			tagName: "INPUT",
			type: "number",
			value: "12",
			selectionStart: null,
			selectionEnd: null,
			disabled: false,
			readOnly: false,
			ownerDocument: document,
			getAttribute: () => null,
			setRangeText() {
				throw new Error("number inputs do not support setRangeText");
			},
			dispatchEvent(event: InputEventProbe) {
				events.push({ target: "number", event });
				return true;
			},
		};
		const textNode = { kind: "text" };
		const insertedNodes: Array<{ data: string }> = [];
		const editable: Record<string, unknown> = {
			tagName: "DIV",
			textContent: "hello world",
			isContentEditable: true,
			ownerDocument: document,
			getAttribute: () => null,
			contains: (node: unknown) => node === textNode,
			dispatchEvent(event: InputEventProbe) {
				events.push({ target: "editable", event });
				return true;
			},
		};
		let insertionOffset = 6;
		const range = {
			commonAncestorContainer: textNode,
			deleteContents() {
				editable.textContent = String(editable.textContent).slice(0, 6);
			},
			insertNode(node: { data: string }) {
				insertedNodes.push(node);
				const current = String(editable.textContent);
				editable.textContent = current.slice(0, insertionOffset) + node.data + current.slice(insertionOffset);
				insertionOffset += node.data.length;
			},
			setStartAfter() {},
			collapse() {},
		};
		const selection = {
			rangeCount: 1,
			getRangeAt: () => range,
			removeAllRanges() {},
			addRange() {},
		};
		view.getSelection = () => selection;
		document.createTextNode = (text: string) => ({ data: text });
		document.createRange = () => range;
		document.activeElement = input;
		const current = await selectedTab(
			facadeFor({
				async codexEvaluate(source: string, args: unknown[]) {
					return runPageEvaluator(source, args, { document, window: view });
				},
			}),
		);

		await current.cua.type({ text: "XY" });
		document.activeElement = numberInput;
		await current.cua.type({ text: "3" });
		document.activeElement = editable;
		await current.dom_cua.type({ text: "cmux" });

		expect(input.value).toBe("abXYef");
		expect(numberInput.value).toBe("123");
		expect(rangeTextCalls).toEqual([["XY", 2, 4, "end"]]);
		expect(editable.textContent).toBe("hello cmux");
		expect(insertedNodes).toEqual([{ data: "cmux" }]);
		expect(
			events.map(({ target, event }) => [target, event.type, event.cancelable, event.data, event.inputType]),
		).toEqual([
			["input", "beforeinput", true, "XY", "insertText"],
			["input", "input", false, "XY", "insertText"],
			["number", "beforeinput", true, "3", "insertText"],
			["number", "input", false, "3", "insertText"],
			["editable", "beforeinput", true, "cmux", "insertText"],
			["editable", "input", false, "cmux", "insertText"],
		]);
	});

	it("rejects fill and type on non-editable targets without mutating them", async () => {
		const events: string[] = [];
		const view = {
			Event: class {
				constructor(readonly type: string) {}
			},
			getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
		};
		let node: Record<string, unknown>;
		const document = {
			defaultView: view,
			getElementById: () => null,
			querySelectorAll: () => [node],
		};
		node = {
			tagName: "DIV",
			children: [],
			ownerDocument: document,
			textContent: "unchanged",
			innerText: "unchanged",
			value: undefined,
			isContentEditable: false,
			hidden: false,
			disabled: false,
			getAttribute: (name: string) => (name === "role" ? "button" : null),
			hasAttribute: () => false,
			getBoundingClientRect: () => ({ width: 100, height: 20 }),
			scrollIntoView: () => undefined,
			focus: () => undefined,
			dispatchEvent: (event: { type: string }) => {
				events.push(event.type);
				return true;
			},
		};
		const current = await selectedTab(
			facadeFor({
				async codexEvaluate(source: string, args: unknown[]) {
					return runPageEvaluator(source, args, { document, window: view });
				},
			}),
		);
		const target = current.playwright.getByRole("button");

		const fill = await caughtError(() => target.fill("changed"));
		Reflect.set(node, "value", undefined);
		const type = await caughtError(() => target.type("changed"));
		expect(fill.name).toBe("Error");
		expect(type.name).toBe("Error");
		expect(node.textContent).toBe("unchanged");
		expect(node.value).toBeUndefined();
		expect(events).toEqual([]);
	});

	it("excludes headings and images from default elementInfo and allows opt-in metadata", async () => {
		const view = { getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }) };
		for (const [tagName, attributes] of [
			["H1", { role: "heading" }],
			["IMG", { alt: "Hero" }],
		] as const) {
			let node: Record<string, unknown>;
			const document = { elementFromPoint: () => node, getElementById: () => null };
			node = {
				tagName,
				parentElement: null,
				ownerDocument: { defaultView: view },
				innerText: tagName === "H1" ? "Heading" : "",
				textContent: tagName === "H1" ? "Heading" : "",
				outerHTML: `<${tagName.toLowerCase()}>`,
				getAttribute: (name: string) => attributes[name as keyof typeof attributes] ?? null,
				hasAttribute: (name: string) => Object.hasOwn(attributes, name),
				closest: () => node,
				getBoundingClientRect: () => ({ x: 0, y: 0, width: 100, height: 20 }),
			};
			const current = await selectedTab(
				facadeFor({
					async codexEvaluate(source: string, args: unknown[]) {
						return runPageEvaluator(source, args, { document, window: view });
					},
				}),
			);
			expect(await current.playwright.elementInfo({ x: 1, y: 1 })).toEqual([]);
			expect(await current.playwright.elementInfo({ x: 1, y: 1, includeNonInteractable: true })).toEqual([
				expect.objectContaining({ tagName: tagName.toLowerCase() }),
			]);
		}
	});

	it("includes observer preparation in the file chooser deadline", async () => {
		let now = 0;
		spyOn(Date, "now").mockImplementation(() => now);
		const timeouts: number[] = [];
		const adapter = new CmuxCodexBrowserAdapter({
			surfaceId: "surface-contract",
			async codexEvaluate(_source: string, _args: unknown[], timeoutMs: number) {
				timeouts.push(timeoutMs);
				if (timeouts.length === 1) {
					now = 80;
					return 0;
				}
				return { token: "file-current", multiple: false };
			},
		} as never);
		await adapter.invoke("playwright.waitForEvent", {
			tabId: "1",
			event: "filechooser",
			timeoutMs: 100,
		});

		expect(timeouts).toEqual([100, 20]);
	});

	it("cleans pending clipboard tokens after failure and whole-run disposal", async () => {
		const globals = globalThis as unknown as Record<string, unknown>;
		delete globals.__ompCodexClipboardWrites;
		const probe = observerProbe();
		class BlobProbe {}
		class ClipboardItemProbe {}
		const navigator = { clipboard: { write: () => new Promise<void>(() => undefined) } };
		const evaluate = (source: string, args: unknown[]) =>
			runPageEvaluator(source, args, {
				document: probe.document,
				window: {},
				Element: probe.ElementProbe,
				navigator,
				Blob: BlobProbe,
				ClipboardItem: ClipboardItemProbe,
			});
		const adapter = new CmuxCodexBrowserAdapter({
			surfaceId: "surface-contract",
			async codexUrl() {
				return "https://fixture.test/current";
			},
			async title() {
				return "Current fixture";
			},
			codexEvaluate: evaluate,
			codexEvaluateCleanup: evaluate,
			async codexWait() {
				throw new Error("stop polling");
			},
		} as never);
		let pendingAfterFailure = -1;
		let writesAfterDispose: unknown = "present";
		try {
			await adapter.beginRun();
			const current = await selectedTab(createCodexBrowserFacade(adapter));
			await caughtError(() => current.clipboard.write([{ entries: [{ mimeType: "text/plain", text: "pending" }] }]));
			pendingAfterFailure = Object.keys((globals.__ompCodexClipboardWrites as object | undefined) ?? {}).length;
			globals.__ompCodexClipboardWrites = { leftover: { done: false } };
			await adapter.dispose();
			writesAfterDispose = globals.__ompCodexClipboardWrites;
		} finally {
			delete globals.__ompCodexClipboardWrites;
			delete globals.__ompCodexBrowserState;
		}
		expect(pendingAfterFailure).toBe(0);
		expect(writesAfterDispose).toBeUndefined();
	});

	it("uses deadline-aware DOM refs, evaluation, and persistence", async () => {
		let now = 0;
		spyOn(Date, "now").mockImplementation(() => now);
		const refTimeouts: Array<number | undefined> = [];
		const evaluateTimeouts: number[] = [];
		let usedUnboundedEvaluate = false;
		const write = spyOn(Bun, "write").mockResolvedValue(1);
		const adapter = new CmuxCodexBrowserAdapter({
			surfaceId: "surface-contract",
			codexCwd: () => "/tmp/codex-media-contract",
			async ref(_id: string, timeoutMs?: number) {
				refTimeouts.push(timeoutMs);
				return {
					async evaluate() {
						usedUnboundedEvaluate = true;
						return "blob:fixture";
					},
					async evaluateWithTimeout(_fn: unknown, _args: unknown[], timeoutMs: number) {
						evaluateTimeouts.push(timeoutMs);
						return "blob:fixture";
					},
				};
			},
			async codexEvaluate(_source: string, args: unknown[]) {
				if (args.length === 2) return true;
				now = 101;
				return {
					url: "blob:fixture",
					contentType: "application/octet-stream",
					base64Chunks: [Buffer.from("x").toString("base64")],
				};
			},
			async codexEvaluateCleanup() {
				return true;
			},
		} as never);

		const error = await caughtError(() =>
			adapter.invoke("dom_cua.downloadMedia", {
				tabId: "1",
				nodeId: "e1",
				timeoutMs: 100,
			}),
		);
		expect(error.message).toContain("timed out");
		expect(refTimeouts).toEqual([100]);
		expect(evaluateTimeouts).toEqual([100]);
		expect(usedUnboundedEvaluate).toBe(false);
		expect(write).not.toHaveBeenCalled();
	});

	it("shares one deadline across goto and history preparation stages", async () => {
		let now = 0;
		spyOn(Date, "now").mockImplementation(() => now);
		const gotoTimeouts: number[] = [];
		const gotoPrepareTimeouts: number[] = [];
		const gotoAdapter = new CmuxCodexBrowserAdapter({
			surfaceId: "surface-contract",
			async goto(_url: string, options: { timeoutMs: number }) {
				gotoTimeouts.push(options.timeoutMs);
				now = 90;
			},
			async codexEvaluate(_source: string, _args: unknown[], timeoutMs: number) {
				gotoPrepareTimeouts.push(timeoutMs);
				return 0;
			},
		} as never);

		await gotoAdapter.invoke("tab.goto", {
			tabId: "1",
			url: "https://fixture.test/next",
			timeoutMs: 100,
		});

		now = 0;
		const navigationTimeouts: number[] = [];
		const historyTimeouts: number[] = [];
		const historyPrepareTimeouts: number[] = [];
		const historyAdapter = new CmuxCodexBrowserAdapter({
			surfaceId: "surface-contract",
			async waitForNavigation(options: { timeout: number }) {
				navigationTimeouts.push(options.timeout);
				now = 40;
				return null;
			},
			async codexEvaluate(source: string, _args: unknown[], timeoutMs: number) {
				if (source.includes("history.go")) {
					historyTimeouts.push(timeoutMs);
					now = 90;
					return true;
				}
				historyPrepareTimeouts.push(timeoutMs);
				return 0;
			},
		} as never);

		await historyAdapter.invoke("tab.back", { tabId: "1", timeoutMs: 100 });

		expect(gotoTimeouts).toEqual([100]);
		expect(gotoPrepareTimeouts).toEqual([10]);
		expect(navigationTimeouts).toEqual([100]);
		expect(historyTimeouts).toEqual([60]);
		expect(historyPrepareTimeouts).toEqual([10]);
	});

	it("uses the ref-aware native double-click primitive", async () => {
		const events: string[] = [];
		const refTimeouts: Array<number | undefined> = [];
		const current = await selectedTab(
			facadeFor({
				async ref(_id: string, timeoutMs?: number) {
					refTimeouts.push(timeoutMs);
					return {
						async click() {
							events.push("click");
						},
						async dblclick() {
							events.push("dblclick");
						},
					};
				},
			}),
		);
		await current.dom_cua.double_click({ node_id: "e1" });

		expect(events).toEqual(["dblclick"]);
		expect(refTimeouts[0]).toBeGreaterThan(0);
	});

	it("removes every Codex page global on endRun, dispose, and timeout cleanup", async () => {
		const globals = globalThis as unknown as Record<string, unknown>;
		const names = [
			"__ompCodexBrowserState",
			"__ompCodexBrowserTokenSequence",
			"__ompCodexClipboardWrites",
			"__ompCodexDomRefs",
			"__ompCodexMediaTransfers",
		] as const;
		const cleanupModes = [
			async (adapter: CmuxCodexBrowserAdapter) => adapter.endRun(),
			async (adapter: CmuxCodexBrowserAdapter) => adapter.dispose(),
			async (adapter: CmuxCodexBrowserAdapter) => {
				await caughtError(() =>
					adapter.invoke("playwright.waitForEvent", {
						tabId: "1",
						event: "filechooser",
						timeoutMs: 1,
					}),
				);
			},
		];

		try {
			for (const cleanup of cleanupModes) {
				for (const name of names) delete globals[name];
				const adapter = adapterForObserver(observerProbe(), async () => {
					throw new Error("poll timeout");
				});
				await adapter.beginRun();
				globals.__ompCodexClipboardWrites = { pending: true };
				globals.__ompCodexDomRefs = { e1: {} };
				globals.__ompCodexMediaTransfers = {};
				await cleanup(adapter);
				expect(names.filter(name => Object.hasOwn(globals, name))).toEqual([]);
			}
		} finally {
			for (const name of names) delete globals[name];
		}
	});

	it("focuses an aria-ref fallback click target before immediate DOM CUA typing", async () => {
		const events: string[] = [];
		class EventProbe {
			constructor(readonly type: string) {}
		}
		class MouseEventProbe extends EventProbe {}
		const document = {
			activeElement: null as Record<string, unknown> | null,
			querySelectorAll: () => [input],
			elementFromPoint: () => input,
		};
		const input: Record<string, unknown> = {
			_ariaRef: { ref: "e1" },
			isConnected: true,
			tagName: "INPUT",
			type: "text",
			value: "",
			selectionStart: 0,
			selectionEnd: 0,
			disabled: false,
			readOnly: false,
			inert: false,
			parentElement: null,
			ownerDocument: document,
			getBoundingClientRect: () => ({ x: 10, y: 20, width: 120, height: 32 }),
			scrollIntoView: () => undefined,
			getAttribute: () => null,
			setRangeText(text: string, start: number, end: number) {
				this.value = String(this.value).slice(0, start) + text + String(this.value).slice(end);
				this.selectionStart = start + text.length;
				this.selectionEnd = start + text.length;
			},
			focus: () => {
				document.activeElement = input;
				events.push("focus");
			},
			dispatchEvent: (event: EventProbe) => {
				events.push(event.type);
				return true;
			},
			click: () => events.push("click"),
		};
		const window = {};
		const client = {
			async request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
				if (method === "browser.url.get") return { url: "https://fixture.test/current" };
				if (method !== "browser.eval") throw new Error(`Unexpected cmux RPC: ${method}`);
				return {
					value: runCmuxEvalScript(String(params.script), {
						document,
						window,
						Event: EventProbe,
						MouseEvent: MouseEventProbe,
					}),
				};
			},
		};
		const current = await selectedTab(
			createCodexBrowserFacade(
				new CmuxCodexBrowserAdapter(new CmuxTab({ client: client as never, surfaceId: "surface-contract" })),
			),
		);

		await current.dom_cua.click({ node_id: "e1" });
		await current.dom_cua.type({ text: "typed" });

		expect(input.value).toBe("typed");
		expect(events).toEqual(["focus", "mousedown", "mouseup", "click", "beforeinput", "input"]);
	});

	it("dispatches two complete aria-ref mouse sequences before dblclick", async () => {
		const events: string[] = [];
		class EventProbe {
			constructor(readonly type: string) {}
		}
		class MouseEventProbe extends EventProbe {}
		const document = { querySelectorAll: () => [button], elementFromPoint: () => button };
		const button = {
			_ariaRef: { ref: "e1" },
			isConnected: true,
			tagName: "BUTTON",
			scrollIntoView: () => undefined,
			inert: false,
			disabled: false,
			parentElement: null,
			ownerDocument: document,
			getAttribute: () => null,
			getBoundingClientRect: () => ({ x: 10, y: 20, width: 120, height: 32 }),
			focus: () => events.push("focus"),
			dispatchEvent: (event: EventProbe) => {
				events.push(event.type);
				return true;
			},
		};
		const window = {};
		const client = {
			async request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
				if (method === "browser.url.get") return { url: "https://fixture.test/current" };
				if (method !== "browser.eval") throw new Error(`Unexpected cmux RPC: ${method}`);
				return {
					value: runCmuxEvalScript(String(params.script), {
						document,
						window,
						Event: EventProbe,
						MouseEvent: MouseEventProbe,
					}),
				};
			},
		};
		const current = await selectedTab(
			createCodexBrowserFacade(
				new CmuxCodexBrowserAdapter(new CmuxTab({ client: client as never, surfaceId: "surface-contract" })),
			),
		);

		await current.dom_cua.double_click({ node_id: "e1" });

		expect(events).toEqual(["focus", "mousedown", "mouseup", "click", "mousedown", "mouseup", "click", "dblclick"]);
	});

	it("rejects covered aria-ref click and double-click without firing the target", async () => {
		const events: string[] = [];
		class EventProbe {
			constructor(readonly type: string) {}
		}
		class MouseEventProbe extends EventProbe {}
		const overlay = { parentElement: null };
		const document = {
			querySelectorAll: () => [button],
			elementFromPoint: () => overlay,
		};
		const button = {
			_ariaRef: { ref: "e1" },
			isConnected: true,
			tagName: "BUTTON",
			ownerDocument: document,
			parentElement: null,
			disabled: false,
			inert: false,
			getAttribute: () => null,
			getBoundingClientRect: () => ({ x: 20, y: 30, width: 100, height: 40 }),
			scrollIntoView: () => undefined,
			focus: () => events.push("focus"),
			dispatchEvent: (event: EventProbe) => {
				events.push(event.type);
				return true;
			},
		};
		const window = {};
		const client = {
			async request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
				if (method === "browser.url.get") return { url: "https://fixture.test/current" };
				if (method !== "browser.eval") throw new Error(`Unexpected cmux RPC: ${method}`);
				return {
					value: runCmuxEvalScript(String(params.script), {
						document,
						window,
						Event: EventProbe,
						MouseEvent: MouseEventProbe,
					}),
				};
			},
		};
		const current = await selectedTab(
			createCodexBrowserFacade(
				new CmuxCodexBrowserAdapter(new CmuxTab({ client: client as never, surfaceId: "surface-contract" })),
			),
		);

		const outcomes = await Promise.all([
			caughtError(() => current.dom_cua.click({ node_id: "e1" })),
			caughtError(() => current.dom_cua.double_click({ node_id: "e1" })),
		]);

		expect(outcomes.every(outcome => outcome.message.includes("does not receive pointer events"))).toBe(true);
		expect(events).toEqual([]);
	});

	it("keeps visible-DOM identities stable across playwright.domSnapshot", async () => {
		let boundNode: "original" | "replacement" | undefined = "original";
		let cleanupCalls = 0;
		let snapshotOptions: unknown;
		const clicked: string[] = [];
		const adapter = new CmuxCodexBrowserAdapter({
			surfaceId: "surface-contract",
			async codexUrl() {
				return "https://fixture.test/current";
			},
			async title() {
				return "Current fixture";
			},
			async codexEvaluateCleanup() {
				cleanupCalls++;
				boundNode = undefined;
				return true;
			},
			async ariaSnapshot(_selector: unknown, options: unknown) {
				snapshotOptions = options;
				if (!boundNode) boundNode = "replacement";
				return "snapshot";
			},
			async ref() {
				const node = boundNode;
				if (!node) throw new Error("stale DOM ref");
				return {
					async click() {
						clicked.push(node);
					},
				};
			},
		} as never);
		const current = await selectedTab(createCodexBrowserFacade(adapter));

		await current.playwright.domSnapshot();
		await current.dom_cua.click({ node_id: "e1" });

		expect(clicked).toEqual(["original"]);
		expect(cleanupCalls).toBe(0);
		expect(snapshotOptions).toEqual({ preserveRefs: true });
	});

	it("aborts and settles the underlying cmux navigation poll when expectNavigation is canceled", async () => {
		let pollSignal: AbortSignal | undefined;
		let pollSettled = false;
		const adapter = new CmuxCodexBrowserAdapter({
			surfaceId: "surface-contract",
			async waitForNavigation(options: { signal?: AbortSignal }) {
				pollSignal = options.signal;
				return await new Promise<null>((_resolve, reject) => {
					options.signal?.addEventListener(
						"abort",
						() => {
							pollSettled = true;
							reject(options.signal?.reason ?? new Error("navigation canceled"));
						},
						{ once: true },
					);
				});
			},
		} as never);
		const navigation = adapter.invoke("playwright.expectNavigation", {
			tabId: "1",
			navigationId: "cancel-me",
			timeoutMs: 1_000,
		});
		await Promise.resolve();

		await adapter.invoke("playwright.expectNavigation.cancel", { tabId: "1", navigationId: "cancel-me" });
		await navigation;

		expect(pollSignal?.aborted).toBe(true);
		expect(pollSettled).toBe(true);
	});

	it("uses one expectNavigation deadline for baseline, poll, and load settlement", async () => {
		let now = 0;
		spyOn(Date, "now").mockImplementation(() => now);
		let urlRead = 0;
		const calls: RpcCall[] = [];
		const client = {
			async request(
				method: string,
				params: Record<string, unknown>,
				options: { timeoutMs?: number } = {},
			): Promise<Record<string, unknown>> {
				calls.push({ method, params, timeoutMs: options.timeoutMs });
				now += 10;
				if (method === "browser.eval") {
					if (String(params.script).includes("setTimeout")) {
						return { value: { url: "https://fixture.test/start" } };
					}
					return { value: true };
				}
				if (method === "browser.url.get") {
					urlRead++;
					return { url: "https://fixture.test/next" };
				}
				if (method === "browser.wait") return {};
				throw new Error(`Unexpected cmux RPC: ${method}`);
			},
		};
		const adapter = new CmuxCodexBrowserAdapter(
			new CmuxTab({ client: client as never, surfaceId: "surface-contract" }),
		);

		await adapter.invoke("playwright.expectNavigation", {
			tabId: "1",
			navigationId: "deadline",
			waitUntil: "load",
			timeoutMs: 100,
		});

		expect(urlRead).toBe(1);
		expect(calls.slice(0, 3).map(call => [call.method, call.timeoutMs])).toEqual([
			["browser.eval", 100],
			["browser.url.get", 90],
			["browser.wait", 80],
		]);
	});

	it("uses one absolute deadline for history navigation, load settlement, and observer preparation", async () => {
		let now = 0;
		spyOn(Date, "now").mockImplementation(() => now);
		let navigationTimeout: number | undefined;
		let historyTimeout: number | undefined;
		let prepareTimeout: number | undefined;
		const navigationDone = Promise.withResolvers<null>();
		const adapter = new CmuxCodexBrowserAdapter({
			surfaceId: "surface-contract",
			waitForNavigation(options: { timeout?: number }) {
				navigationTimeout = options.timeout;
				return navigationDone.promise;
			},
			async codexEvaluate(source: string, _args: unknown[], timeoutMs: number) {
				if (source.includes("history.go")) {
					historyTimeout = timeoutMs;
					now = 60;
					navigationDone.resolve(null);
					return true;
				}
				prepareTimeout = timeoutMs;
				return 0;
			},
		} as never);

		await adapter.invoke("tab.back", { tabId: "1", timeoutMs: 100 });

		expect({ navigationTimeout, historyTimeout, prepareTimeout }).toEqual({
			navigationTimeout: 100,
			historyTimeout: 100,
			prepareTimeout: 40,
		});
	});
	it("arms same-URL document detection before the public trigger and spends one deadline", async () => {
		let markerPresent = false;
		const calls: RpcCall[] = [];
		const client = {
			async request(
				method: string,
				params: Record<string, unknown>,
				options: { timeoutMs?: number } = {},
			): Promise<Record<string, unknown>> {
				calls.push({ method, params, timeoutMs: options.timeoutMs });
				if (method === "browser.reload") {
					markerPresent = false;
					return {};
				}
				if (method === "browser.url.get") return { url: "https://fixture.test/same" };
				if (method === "browser.eval") {
					const script = String(params.script);
					if (script.includes("setTimeout")) {
						markerPresent = true;
						return { value: { url: "https://fixture.test/same" } };
					}
					if (script.includes("Boolean")) return { value: markerPresent };
					if (script.includes("delete globalThis")) markerPresent = false;
					return { value: true };
				}
				if (method === "browser.wait") return {};
				throw new Error(`Unexpected cmux RPC: ${method}`);
			},
		};
		const tab = new CmuxTab({ client: client as never, surfaceId: "surface-contract" });

		const navigation = tab.waitForNavigation({ waitUntil: "load", timeout: 100 });
		const reload = client.request("browser.reload", {}, {});
		await expect(Promise.all([navigation, reload])).resolves.toEqual([null, {}]);
		expect(calls[0]?.method).toBe("browser.eval");
		expect(calls[1]?.method).toBe("browser.reload");
		const wait = calls.find(call => call.method === "browser.wait");
		expect(wait?.params.timeout_ms).toBeGreaterThan(0);
		expect(wait?.params.timeout_ms).toBeLessThanOrEqual(100);
		const waitBudget = wait?.params.timeout_ms;
		if (typeof waitBudget !== "number") throw new Error("Expected numeric same-URL wait budget");
		expect(wait?.timeoutMs).toBe(waitBudget);
	});

	it("propagates only the remaining navigation budget to the load-state wait", async () => {
		let now = 0;
		spyOn(Date, "now").mockImplementation(() => now);
		let atomicBaseline = false;
		const calls: RpcCall[] = [];
		const client = {
			async request(
				method: string,
				params: Record<string, unknown>,
				options: { timeoutMs?: number } = {},
			): Promise<Record<string, unknown>> {
				calls.push({ method, params, timeoutMs: options.timeoutMs });
				if (method === "browser.eval") {
					if (String(params.script).includes("setTimeout")) {
						atomicBaseline = true;
						return { value: { url: "https://fixture.test/start" } };
					}
					return { value: true };
				}
				if (method === "browser.url.get") {
					if (!atomicBaseline) return { url: "https://fixture.test/start" };
					now = 20;
					return { url: "https://fixture.test/next" };
				}
				if (method === "browser.wait") return {};
				throw new Error(`Unexpected cmux RPC: ${method}`);
			},
		};
		const tab = new CmuxTab({ client: client as never, surfaceId: "surface-contract" });

		await tab.waitForNavigation({ waitUntil: "load", timeout: 100 });
		const wait = calls.find(call => call.method === "browser.wait");
		expect(wait?.params.timeout_ms).toBeLessThan(100);
		const remainingWaitBudget = wait?.params.timeout_ms;
		if (typeof remainingWaitBudget !== "number") throw new Error("Expected numeric remaining wait budget");
		expect(wait?.timeoutMs).toBe(remainingWaitBudget);
	});

	it("tests raw RegExp URL patterns from index zero on every poll", async () => {
		const pattern = /ready/g;
		pattern.lastIndex = 100;
		const client = {
			async request(method: string): Promise<Record<string, unknown>> {
				if (method === "browser.url.get") return { url: "https://fixture.test/ready" };
				throw new Error(`Unexpected cmux RPC: ${method}`);
			},
		};
		const tab = new CmuxTab({ client: client as never, surfaceId: "surface-contract" });

		await expect(tab.waitForUrl(pattern, { timeout: 1 })).resolves.toBe("https://fixture.test/ready");
	});
});
