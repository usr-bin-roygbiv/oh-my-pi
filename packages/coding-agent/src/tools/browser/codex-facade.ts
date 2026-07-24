import { ToolError } from "../tool-errors";

const NAVIGATION_TIMEOUT_MS = 10_000;
const SELECTOR_TIMEOUT_MS = 3_000;
/** File formats accepted when callers export Google Workspace content. */
export type CodexGsuiteFormat = "pdf" | "md" | "xlsx" | "csv" | "docx" | "pptx";
/** Content representations callers can request for multiple browser tabs. */
export type CodexContentType = "html" | "text" | "domSnapshot";
/** Navigation readiness states exposed by the Codex-compatible facade. */
export type CodexLoadState = "load" | "domcontentloaded" | "networkidle";
/** Console log levels callers can use to filter browser development logs. */
export type CodexLogLevel = "debug" | "info" | "log" | "warn" | "warning" | "error";

const GSUITE_FORMATS: Record<CodexGsuiteFormat, true> = {
	pdf: true,
	md: true,
	xlsx: true,
	csv: true,
	docx: true,
	pptx: true,
};
const CONTENT_TYPES: Record<CodexContentType, true> = { html: true, text: true, domSnapshot: true };
const CLIPBOARD_PRESENTATION_STYLES: Record<"unspecified" | "inline" | "attachment", true> = {
	unspecified: true,
	inline: true,
	attachment: true,
};
const LOG_LEVELS: Record<CodexLogLevel, true> = {
	debug: true,
	info: true,
	log: true,
	warn: true,
	warning: true,
	error: true,
};
const LOAD_STATES: Record<CodexLoadState, true> = { load: true, domcontentloaded: true, networkidle: true };

/** Canonical capability identifiers adapters use when an operation is unavailable. */
export const CODEX_BROWSER_CAPABILITIES = {
	USER_OPEN_TABS: "browser.user.openTabs",
	USER_HISTORY: "browser.user.history",
	TABS_CONTENT: "tabs.content",
	TAB_RELOAD: "tab.reload",
	CONTENT_EXPORT: "tab.content.export",
	CONTENT_EXPORT_GSUITE: "tab.content.exportGsuite",
	WAIT_FOR_EVENT: "playwright.waitForEvent",
	DOWNLOAD_PATH: "playwright.download.path",
	FRAME_LOCATOR_CROSS_ORIGIN: "playwright.frameLocator cross-origin",
	ELEMENT_SCREENSHOT: "playwright.elementScreenshot",
	SCREENSHOT_FULL_PAGE: "playwright.screenshot.fullPage",
	SCREENSHOT_CLIP: "playwright.screenshot.clip",
	WAIT_FOR_URL_NETWORKIDLE: "playwright.waitForURL networkidle",
	WAIT_FOR_LOAD_STATE_NETWORKIDLE: "playwright.waitForLoadState networkidle",
	EXPECT_NAVIGATION_NETWORKIDLE: "playwright.expectNavigation networkidle",
	CLIPBOARD_READ: "tab.clipboard.read",
	CLIPBOARD_READ_TEXT: "tab.clipboard.readText",
	CLIPBOARD_WRITE: "tab.clipboard.write",
	CLIPBOARD_WRITE_TEXT: "tab.clipboard.writeText",
	DEV_LOGS: "tab.dev.logs",
	LOCATOR_CLICK_OPTIONS: "locator.click options",
	CUA_CLICK: "cua.click",
	CUA_DOUBLE_CLICK: "cua.double_click",
	CUA_DRAG: "cua.drag",
	CUA_MOVE: "cua.move",
	CUA_SCROLL: "cua.scroll",
} as const;

/** A canonical capability identifier that adapters can report as unsupported. */
export type CodexBrowserCapability = (typeof CODEX_BROWSER_CAPABILITIES)[keyof typeof CODEX_BROWSER_CAPABILITIES];

/** Signals that an adapter cannot provide a requested public browser capability. */
export class BrowserCapabilityError extends ToolError {
	constructor(capability: CodexBrowserCapability) {
		super(`Browser capability is unavailable: ${capability}`);
		this.name = "BrowserCapabilityError";
	}
}

/** Adapter operation names used to route facade calls to a browser backend. */
export type CodexBrowserOperation =
	| "browser.nameSession"
	| "browser.user.openTabs"
	| "browser.user.history"
	| "tab.new"
	| "tab.selected"
	| "tab.list"
	| "tab.get"
	| "tabs.content"
	| "tab.goto"
	| "tab.back"
	| "tab.forward"
	| "tab.reload"
	| "tab.close"
	| "tab.title"
	| "tab.url"
	| "tab.content.export"
	| "tab.content.exportGsuite"
	| "tab.clipboard.read"
	| "tab.clipboard.readText"
	| "tab.clipboard.write"
	| "tab.clipboard.writeText"
	| "tab.dev.logs"
	| "playwright.domSnapshot"
	| "playwright.elementInfo"
	| "playwright.elementScreenshot"
	| "playwright.screenshot"
	| "playwright.waitForURL"
	| "playwright.waitForLoadState"
	| "playwright.waitForTimeout"
	| "playwright.expectNavigation"
	| "playwright.expectNavigation.cancel"
	| "playwright.waitForEvent"
	| "playwright.download.path"
	| "playwright.fileChooser.setFiles"
	| "locator.count"
	| "locator.allTextContents"
	| "locator.click"
	| "locator.dblclick"
	| "locator.downloadMedia"
	| "locator.fill"
	| "locator.type"
	| "locator.press"
	| "locator.selectOption"
	| "locator.setChecked"
	| "locator.getAttribute"
	| "locator.innerText"
	| "locator.textContent"
	| "locator.isEnabled"
	| "locator.isVisible"
	| "locator.waitFor"
	| "dom_cua.get_visible_dom"
	| "dom_cua.click"
	| "dom_cua.double_click"
	| "dom_cua.scroll"
	| "dom_cua.type"
	| "dom_cua.keypress"
	| "dom_cua.downloadMedia"
	| "cua.get_visible_screenshot"
	| "cua.click"
	| "cua.double_click"
	| "cua.drag"
	| "cua.keypress"
	| "cua.move"
	| "cua.scroll"
	| "cua.type"
	| "cua.downloadMedia";

/** Backend boundary implemented by browser adapters consumed by the public facade. */
export interface CodexBrowserAdapter {
	readonly currentTabId: string;
	invoke<T>(operation: CodexBrowserOperation, args: Readonly<Record<string, unknown>>): Promise<T>;
}

/** Stable tab metadata returned when callers enumerate or create tabs. */
export interface CodexTabSummary {
	id: string;
	url?: string;
	title?: string;
}

/** Options for fetching one content representation from multiple URLs. */
export interface CodexTabsContentOptions {
	urls: string[];
	contentType: CodexContentType;
	timeoutMs?: number;
}

/** Content and page metadata returned for one requested URL. */
export interface CodexTabsContentResult {
	url: string;
	title: string | null;
	content: string | null;
}

/** Optional date, query, and result constraints for browser history lookups. */
export interface CodexHistoryOptions {
	from?: Date | string | number;
	to?: Date | string | number;
	query?: string;
	limit?: number;
}

/** One textual or binary clipboard representation identified by MIME type. */
export type CodexClipboardEntry =
	| { mimeType: string; text: string; base64?: never }
	| { mimeType: string; text?: never; base64: string };

/** A browser clipboard item containing one or more MIME representations. */
export interface CodexClipboardItem {
	entries: [CodexClipboardEntry, ...CodexClipboardEntry[]];
	presentationStyle?: "unspecified" | "inline" | "attachment";
}

/** Filters callers can apply when reading a tab's development logs. */
export interface CodexDevLogOptions {
	filter?: string;
	levels?: CodexLogLevel[];
	limit?: number;
}

/** Page-space rectangle used for screenshots and element metadata. */
export interface CodexBoundingBox {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** Actionable node returned by the DOM-based computer-use surface. */
export interface CodexDomNode {
	node_id: string;
	tag: string;
	role: string | null;
	text: string;
	x: number;
	y: number;
	width: number;
	height: number;
}

/** Visible DOM snapshot exposed to DOM-based computer-use callers. */
export interface CodexVisibleDom {
	nodes: CodexDomNode[];
}

/** Element metadata and selector candidates discovered at a page coordinate. */
export interface CodexElementInfo {
	tagName: string;
	role?: string | null;
	visibleText?: string | null;
	ariaName?: string | null;
	testId?: string | null;
	boundingBox?: CodexBoundingBox | null;
	preview: string;
	selector: {
		primary?: string | null;
		candidates: string[];
		frameSelectors?: string[];
	};
}

/** Keyboard modifiers supported by locator click operations. */
export type CodexLocatorModifier = "Alt" | "Control" | "ControlOrMeta" | "Meta" | "Shift";
/** Mouse buttons supported by locator click operations. */
export type CodexLocatorButton = "left" | "right" | "middle";

/** Optional input and deadline controls for locator clicks. */
export interface CodexLocatorClickOptions {
	modifiers?: CodexLocatorModifier[];
	button?: CodexLocatorButton;
	force?: boolean;
	timeoutMs?: number;
}

/** Shared deadline option for locator actions. */
export interface CodexLocatorActionOptions {
	timeoutMs?: number;
}

/** Controls for setting a locator's checked state. */
export interface CodexLocatorCheckedOptions extends CodexLocatorActionOptions {
	force?: boolean;
}

/** Value, label, or index selection accepted by select locators. */
export type CodexSelectOption = string | { value?: string; label?: string; index?: number };

/** State and deadline callers use while waiting on a locator. */
export interface CodexLocatorWaitOptions {
	state: "attached" | "detached" | "visible" | "hidden";
	timeoutMs?: number;
}

/** Matching controls for text-based locator queries. */
export interface CodexTextLocatorOptions {
	exact?: boolean;
}

/** Accessible-name matching controls for role-based locator queries. */
export interface CodexRoleLocatorOptions extends CodexTextLocatorOptions {
	name?: string | RegExp;
}

/** Predicates callers use to narrow an existing locator. */
export interface CodexLocatorFilterOptions {
	hasText?: string | RegExp;
	hasNotText?: string | RegExp;
	has?: CodexLocator;
	hasNot?: CodexLocator;
	visible?: boolean;
}

/** Navigation state and deadline controls for URL-changing operations. */
export interface CodexWaitOptions {
	waitUntil?: CodexLoadState;
	timeoutMs?: number;
}

/** Readiness state and deadline controls for page load waits. */
export interface CodexLoadStateOptions {
	state?: CodexLoadState;
	timeoutMs?: number;
}

/** Capture region controls for Playwright-compatible screenshots. */
export interface CodexScreenshotOptions {
	fullPage?: boolean;
	clip?: CodexBoundingBox;
}

/** Page-space coordinate used by computer-use and inspection operations. */
export interface CodexPoint {
	x: number;
	y: number;
}

/** Coordinate click input accepted by the computer-use surface. */
export interface CodexCoordinateClick extends CodexPoint {
	button?: 1 | 2 | 3;
	keypress?: string[];
}

/** Coordinate action with optional held keys. */
export interface CodexCoordinateAction extends CodexPoint {
	keys?: string[];
}

/** Coordinate and delta input for computer-use scrolling. */
export interface CodexCoordinateScroll extends CodexPoint {
	scrollX: number;
	scrollY: number;
	keypress?: string[];
}

/** DOM computer-use action targeting a visible node identifier. */
export interface CodexDomNodeAction {
	node_id: string;
}

/** DOM computer-use scroll input, optionally scoped to one node. */
export interface CodexDomScroll {
	node_id?: string;
	x: number;
	y: number;
}

/** Coordinate inspection input with optional non-interactable results. */
export interface CodexElementInfoOptions extends CodexPoint {
	includeNonInteractable?: boolean;
}

/** Coordinate double-click input accepted by computer use. */
export interface CodexCoordinateDoubleClick extends CodexPoint {
	keypress?: string[];
}

/** Non-empty coordinate path used for computer-use drag gestures. */
export interface CodexCoordinateDrag {
	path: [CodexPoint, ...CodexPoint[]];
	keys?: string[];
}

/** Non-empty key sequence used by keyboard computer-use actions. */
export interface CodexKeysAction {
	keys: [string, ...string[]];
}

/** Text payload used by computer-use typing actions. */
export interface CodexTypeAction {
	text: string;
}

/** DOM media-download target and optional deadline. */
export interface CodexDomDownload extends CodexDomNodeAction {
	timeoutMs?: number;
}

/** Coordinate media-download target and optional deadline. */
export interface CodexCoordinateDownload extends CodexPoint {
	timeoutMs?: number;
}

/** Serializable string or regular-expression matcher used across adapter calls. */
export type CodexTextPattern =
	| { readonly kind: "string"; readonly value: string; readonly exact?: boolean }
	| { readonly kind: "regexp"; readonly source: string; readonly flags: string };

/** Serializable locator tree shared between the facade and browser adapters. */
export type CodexLocatorDescriptor =
	| { readonly kind: "css"; readonly selector: string }
	| { readonly kind: "role"; readonly role: string; readonly name?: CodexTextPattern }
	| { readonly kind: "text"; readonly text: CodexTextPattern }
	| { readonly kind: "label"; readonly text: CodexTextPattern }
	| { readonly kind: "placeholder"; readonly text: CodexTextPattern }
	| { readonly kind: "testId"; readonly testId: string }
	| { readonly kind: "frame"; readonly selector: string }
	| { readonly kind: "within"; readonly parent: CodexLocatorDescriptor; readonly child: CodexLocatorDescriptor }
	| { readonly kind: "and"; readonly left: CodexLocatorDescriptor; readonly right: CodexLocatorDescriptor }
	| { readonly kind: "or"; readonly left: CodexLocatorDescriptor; readonly right: CodexLocatorDescriptor }
	| {
			readonly kind: "filter";
			readonly locator: CodexLocatorDescriptor;
			readonly hasText?: CodexTextPattern;
			readonly hasNotText?: CodexTextPattern;
			readonly has?: CodexLocatorDescriptor;
			readonly hasNot?: CodexLocatorDescriptor;
			readonly visible?: boolean;
	  }
	| { readonly kind: "nth"; readonly locator: CodexLocatorDescriptor; readonly index: number };

/** Browser image value callers can convert to base64 for transport or inspection. */
export interface CodexImage {
	toBase64(): string;
}

/** Download event handle callers use to resolve the downloaded file path. */
export interface CodexDownload {
	path(options?: CodexLocatorActionOptions): Promise<string | null>;
}

/** File chooser event handle callers use to inspect and populate an upload prompt. */
export interface CodexFileChooser {
	isMultiple(): boolean;
	setFiles(files: string | string[], options?: CodexLocatorActionOptions): Promise<void>;
}

/** Codex-compatible browser namespace attached to the callable agent helper. */
export interface CodexBrowserFacade {
	nameSession(name: string): Promise<void>;
	readonly tabs: {
		new: () => Promise<CodexTab>;
		selected(): Promise<CodexTab | undefined>;
		list(): Promise<CodexTabSummary[]>;
		get(id: string): Promise<CodexTab>;
		content(options: CodexTabsContentOptions): Promise<CodexTabsContentResult[]>;
	};
	readonly user: {
		openTabs(): Promise<unknown[]>;
		history(options?: CodexHistoryOptions): Promise<unknown[]>;
	};
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error(`${label} requires an options object`);
	return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string, allowEmpty = false): string {
	if (typeof value !== "string" || (!allowEmpty && value.length === 0)) throw new Error(`${label} requires a string`);
	return value;
}

function requireNumber(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} requires a number`);
	return value;
}

function positiveInteger(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		throw new Error(`${label} requires a positive integer`);
	}
	return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
		throw new Error(`${label} requires a non-negative integer`);
	}
	return value;
}

function selectorTimeout(value: unknown, label: string): number {
	return value === undefined
		? SELECTOR_TIMEOUT_MS
		: Math.min(positiveInteger(value, `${label} timeoutMs`), SELECTOR_TIMEOUT_MS);
}

function navigationTimeout(value: unknown, label: string): number {
	return value === undefined ? NAVIGATION_TIMEOUT_MS : positiveInteger(value, `${label} timeoutMs`);
}

function requireTabId(value: unknown): string {
	if (!value) throw new Error("tabs.get requires a tab id");
	if (typeof value !== "string" || !/^[1-9]\d*$/.test(value))
		throw new Error("tabs.get requires a positive-integer string tab id");
	return value;
}

function textPattern(value: unknown, label: string, exact?: unknown): CodexTextPattern {
	if (exact !== undefined && typeof exact !== "boolean") throw new Error(`${label} exact must be a boolean`);
	if (typeof value === "string") return { kind: "string", value, exact: exact === true || undefined };
	if (value instanceof RegExp) return { kind: "regexp", source: value.source, flags: value.flags };
	throw new Error(`${label} requires text or a RegExp`);
}

function optionalKeyArray(value: unknown, label: string): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length === 0 || value.some(key => typeof key !== "string" || key.length === 0)) {
		throw new Error(`${label} requires a non-empty keys array`);
	}
	return [...value] as string[];
}

function coordinates(value: unknown, label: string): { x: number; y: number } {
	const options = requireObject(value, label);
	return { x: requireNumber(options.x, `${label} x`), y: requireNumber(options.y, `${label} y`) };
}

function loadState(value: unknown, label: string): CodexLoadState {
	const state = value === undefined ? "load" : requireString(value, `${label} state`);
	if (!Object.hasOwn(LOAD_STATES, state)) throw new Error(`${label} state is invalid`);
	return state as CodexLoadState;
}

function nodeId(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`${label} requires a node_id`);
	return value;
}

class ImageValue implements CodexImage {
	readonly #base64: string;

	constructor(base64: string) {
		this.#base64 = base64;
	}

	toBase64(): string {
		return this.#base64;
	}
}

class DownloadValue implements CodexDownload {
	readonly #adapter: CodexBrowserAdapter;
	readonly #tabId: string;
	readonly #token: string;

	constructor(adapter: CodexBrowserAdapter, tabId: string, token: string) {
		this.#adapter = adapter;
		this.#tabId = tabId;
		this.#token = token;
	}

	async path(options: { timeoutMs?: number } = {}): Promise<string | null> {
		const timeoutMs = selectorTimeout(options.timeoutMs, "download.path");
		return await this.#adapter.invoke<string | null>("playwright.download.path", {
			tabId: this.#tabId,
			token: this.#token,
			timeoutMs,
		});
	}
}

class FileChooserValue implements CodexFileChooser {
	readonly #adapter: CodexBrowserAdapter;
	readonly #tabId: string;
	readonly #token: string;
	readonly #multiple: boolean;

	constructor(adapter: CodexBrowserAdapter, tabId: string, token: string, multiple: boolean) {
		this.#adapter = adapter;
		this.#tabId = tabId;
		this.#token = token;
		this.#multiple = multiple;
	}

	isMultiple(): boolean {
		return this.#multiple;
	}

	async setFiles(files: string | string[], options: CodexLocatorActionOptions = {}): Promise<void> {
		const paths = typeof files === "string" ? [files] : files;
		if (!Array.isArray(paths) || paths.length === 0 || paths.some(file => typeof file !== "string" || !file)) {
			throw new Error("filechooser.setFiles requires one or more file paths");
		}
		if (!this.#multiple && paths.length > 1) throw new Error("filechooser.setFiles only accepts one file");
		await this.#adapter.invoke<void>("playwright.fileChooser.setFiles", {
			tabId: this.#tabId,
			token: this.#token,
			files: [...paths],
			timeoutMs: selectorTimeout(options.timeoutMs, "filechooser.setFiles"),
		});
	}
}

/** Playwright-compatible locator callers compose before querying or acting on elements. */
export class CodexLocator {
	readonly #adapter: CodexBrowserAdapter;
	readonly #tabId: string;
	readonly #descriptor: CodexLocatorDescriptor;

	constructor(adapter: CodexBrowserAdapter, tabId: string, descriptor: CodexLocatorDescriptor) {
		this.#adapter = adapter;
		this.#tabId = tabId;
		this.#descriptor = descriptor;
	}

	#child(descriptor: CodexLocatorDescriptor): CodexLocator {
		return new CodexLocator(this.#adapter, this.#tabId, descriptor);
	}

	#sameTab(other: unknown, label: string): CodexLocator {
		if (!(other instanceof CodexLocator) || other.#adapter !== this.#adapter || other.#tabId !== this.#tabId) {
			throw new Error(`${label} requires a locator from the same tab`);
		}
		return other;
	}

	#args(extra: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
		return { ...extra, tabId: this.#tabId, locator: this.#descriptor };
	}

	async all(): Promise<CodexLocator[]> {
		const count = await this.count();
		return Array.from({ length: count }, (_, index) => this.nth(index));
	}

	async allTextContents(options: CodexLocatorActionOptions = {}): Promise<string[]> {
		return await this.#adapter.invoke<string[]>(
			"locator.allTextContents",
			this.#args({ timeoutMs: selectorTimeout(options.timeoutMs, "locator.allTextContents") }),
		);
	}

	and(other: CodexLocator): CodexLocator {
		const right = this.#sameTab(other, "locator.and");
		return this.#child({ kind: "and", left: this.#descriptor, right: right.#descriptor });
	}

	or(other: CodexLocator): CodexLocator {
		const right = this.#sameTab(other, "locator.or");
		return this.#child({ kind: "or", left: this.#descriptor, right: right.#descriptor });
	}

	filter(options: CodexLocatorFilterOptions): CodexLocator {
		const value = requireObject(options, "locator.filter");
		const has = value.has === undefined ? undefined : this.#sameTab(value.has, "locator.filter has").#descriptor;
		const hasNot =
			value.hasNot === undefined ? undefined : this.#sameTab(value.hasNot, "locator.filter hasNot").#descriptor;
		if (value.visible !== undefined && typeof value.visible !== "boolean") {
			throw new Error("locator.filter visible must be a boolean");
		}
		return this.#child({
			kind: "filter",
			locator: this.#descriptor,
			hasText: value.hasText === undefined ? undefined : textPattern(value.hasText, "locator.filter hasText"),
			hasNotText:
				value.hasNotText === undefined ? undefined : textPattern(value.hasNotText, "locator.filter hasNotText"),
			has,
			hasNot,
			visible: value.visible as boolean | undefined,
		});
	}

	locator(selector: string): CodexLocator {
		return this.#child({
			kind: "within",
			parent: this.#descriptor,
			child: { kind: "css", selector: requireString(selector, "locator.locator") },
		});
	}

	first(): CodexLocator {
		return this.nth(0);
	}

	last(): CodexLocator {
		return this.nth(-1);
	}

	nth(index: number): CodexLocator {
		if (typeof index !== "number" || !Number.isInteger(index))
			throw new Error("locator.nth requires an integer index");
		return this.#child({ kind: "nth", locator: this.#descriptor, index });
	}

	async count(): Promise<number> {
		return await this.#adapter.invoke<number>("locator.count", this.#args());
	}

	async click(options: CodexLocatorClickOptions = {}): Promise<void> {
		await this.#adapter.invoke<void>("locator.click", this.#args(this.#clickOptions(options, "locator.click")));
	}

	async dblclick(options: CodexLocatorClickOptions = {}): Promise<void> {
		await this.#adapter.invoke<void>("locator.dblclick", this.#args(this.#clickOptions(options, "locator.dblclick")));
	}

	#clickOptions(options: CodexLocatorClickOptions, label: string): Readonly<Record<string, unknown>> {
		const value = requireObject(options, label);
		const allowedKeys: Record<string, true> = { button: true, modifiers: true, force: true, timeoutMs: true };
		for (const key of Object.keys(value)) {
			if (!Object.hasOwn(allowedKeys, key)) throw new Error(`${label} does not accept ${key}`);
		}
		const button = value.button;
		if (button !== undefined && button !== "left" && button !== "middle" && button !== "right") {
			throw new Error(`${label} button must be 'left', 'middle', or 'right'`);
		}
		const allowedModifiers: Record<CodexLocatorModifier, true> = {
			Alt: true,
			Control: true,
			ControlOrMeta: true,
			Meta: true,
			Shift: true,
		};
		const modifiers = value.modifiers;
		if (
			modifiers !== undefined &&
			(!Array.isArray(modifiers) ||
				modifiers.some(item => typeof item !== "string" || !Object.hasOwn(allowedModifiers, item)))
		) {
			throw new Error(`${label} modifiers must contain only Alt, Control, ControlOrMeta, Meta, or Shift`);
		}
		if (value.force !== undefined && typeof value.force !== "boolean") {
			throw new Error(`${label} force must be a boolean`);
		}
		return {
			button,
			modifiers,
			force: value.force,
			timeoutMs: selectorTimeout(value.timeoutMs, label),
		};
	}

	async downloadMedia(options: CodexLocatorActionOptions = {}): Promise<void> {
		await this.#adapter.invoke<void>(
			"locator.downloadMedia",
			this.#args({ timeoutMs: selectorTimeout(options.timeoutMs, "locator.downloadMedia") }),
		);
	}

	async fill(value: string, options: CodexLocatorActionOptions = {}): Promise<void> {
		await this.#adapter.invoke<void>(
			"locator.fill",
			this.#args({
				value: requireString(value, "locator.fill", true),
				timeoutMs: selectorTimeout(options.timeoutMs, "locator.fill"),
			}),
		);
	}

	async type(value: string, options: CodexLocatorActionOptions = {}): Promise<void> {
		await this.#adapter.invoke<void>(
			"locator.type",
			this.#args({
				value: requireString(value, "locator.type", true),
				timeoutMs: selectorTimeout(options.timeoutMs, "locator.type"),
			}),
		);
	}

	async press(value: string, options: CodexLocatorActionOptions = {}): Promise<void> {
		await this.#adapter.invoke<void>(
			"locator.press",
			this.#args({
				value: requireString(value, "locator.press"),
				timeoutMs: selectorTimeout(options.timeoutMs, "locator.press"),
			}),
		);
	}

	async selectOption(
		selection: CodexSelectOption | CodexSelectOption[],
		options: CodexLocatorActionOptions = {},
	): Promise<string[]> {
		const input = Array.isArray(selection) ? selection : [selection];
		if (input.length === 0) throw new Error("locator.selectOption requires at least one selection");
		const normalized = input.map(item => {
			if (typeof item === "string") return { value: item };
			const value = requireObject(item, "locator.selectOption");
			const present = [value.value, value.label, value.index].filter(entry => entry !== undefined);
			if (present.length === 0) throw new Error("locator.selectOption requires a value, label, or index");
			if (value.value !== undefined && typeof value.value !== "string")
				throw new Error("locator.selectOption value must be a string");
			if (value.label !== undefined && typeof value.label !== "string")
				throw new Error("locator.selectOption label must be a string");
			if (
				value.index !== undefined &&
				(typeof value.index !== "number" || !Number.isInteger(value.index) || value.index < 0)
			) {
				throw new Error("locator.selectOption index must be a non-negative integer");
			}
			return { value: value.value, label: value.label, index: value.index };
		});
		return await this.#adapter.invoke<string[]>(
			"locator.selectOption",
			this.#args({ selections: normalized, timeoutMs: selectorTimeout(options.timeoutMs, "locator.selectOption") }),
		);
	}

	async setChecked(checked: boolean, options: CodexLocatorCheckedOptions = {}): Promise<void> {
		if (typeof checked !== "boolean") throw new Error("locator.setChecked requires a boolean");
		const value = requireObject(options, "locator.setChecked");
		if (value.force !== undefined && typeof value.force !== "boolean")
			throw new Error("locator.setChecked force must be a boolean");
		await this.#adapter.invoke<void>(
			"locator.setChecked",
			this.#args({ checked, force: value.force, timeoutMs: selectorTimeout(value.timeoutMs, "locator.setChecked") }),
		);
	}

	async check(options: CodexLocatorCheckedOptions = {}): Promise<void> {
		await this.setChecked(true, options);
	}

	async uncheck(options: CodexLocatorCheckedOptions = {}): Promise<void> {
		await this.setChecked(false, options);
	}

	async getAttribute(name: string, options: CodexLocatorActionOptions = {}): Promise<string | null> {
		return await this.#adapter.invoke<string | null>(
			"locator.getAttribute",
			this.#args({
				name: requireString(name, "locator.getAttribute"),
				timeoutMs: selectorTimeout(options.timeoutMs, "locator.getAttribute"),
			}),
		);
	}

	async innerText(options: CodexLocatorActionOptions = {}): Promise<string> {
		return await this.#adapter.invoke<string>(
			"locator.innerText",
			this.#args({ timeoutMs: selectorTimeout(options.timeoutMs, "locator.innerText") }),
		);
	}

	async textContent(options: CodexLocatorActionOptions = {}): Promise<string | null> {
		return await this.#adapter.invoke<string | null>(
			"locator.textContent",
			this.#args({ timeoutMs: selectorTimeout(options.timeoutMs, "locator.textContent") }),
		);
	}

	async isEnabled(): Promise<boolean> {
		return await this.#adapter.invoke<boolean>("locator.isEnabled", this.#args());
	}

	async isVisible(): Promise<boolean> {
		return await this.#adapter.invoke<boolean>("locator.isVisible", this.#args());
	}

	async waitFor(options: CodexLocatorWaitOptions): Promise<void> {
		const value = requireObject(options, "locator.waitFor");
		const state = requireString(value.state, "locator.waitFor state");
		if (state !== "attached" && state !== "detached" && state !== "visible" && state !== "hidden") {
			throw new Error("locator.waitFor state is invalid");
		}
		await this.#adapter.invoke<void>(
			"locator.waitFor",
			this.#args({ state, timeoutMs: selectorTimeout(value.timeoutMs, "locator.waitFor") }),
		);
	}

	getByRole(role: string, options: CodexRoleLocatorOptions = {}): CodexLocator {
		const value = requireObject(options, "locator.getByRole");
		const descriptor: CodexLocatorDescriptor = {
			kind: "role",
			role: requireString(role, "locator.getByRole"),
			name: value.name === undefined ? undefined : textPattern(value.name, "locator.getByRole name", value.exact),
		};
		return this.#child({ kind: "within", parent: this.#descriptor, child: descriptor });
	}

	getByText(text: string | RegExp, options: CodexTextLocatorOptions = {}): CodexLocator {
		const value = requireObject(options, "locator.getByText");
		return this.#child({
			kind: "within",
			parent: this.#descriptor,
			child: { kind: "text", text: textPattern(text, "locator.getByText", value.exact) },
		});
	}

	getByLabel(text: string | RegExp, options: CodexTextLocatorOptions = {}): CodexLocator {
		const value = requireObject(options, "locator.getByLabel");
		return this.#child({
			kind: "within",
			parent: this.#descriptor,
			child: { kind: "label", text: textPattern(text, "locator.getByLabel", value.exact) },
		});
	}

	getByPlaceholder(text: string | RegExp, options: CodexTextLocatorOptions = {}): CodexLocator {
		const value = requireObject(options, "locator.getByPlaceholder");
		return this.#child({
			kind: "within",
			parent: this.#descriptor,
			child: { kind: "placeholder", text: textPattern(text, "locator.getByPlaceholder", value.exact) },
		});
	}

	getByTestId(testId: string): CodexLocator {
		return this.#child({
			kind: "within",
			parent: this.#descriptor,
			child: { kind: "testId", testId: requireString(testId, "locator.getByTestId") },
		});
	}

	frameLocator(selector: string): CodexLocator {
		return this.#child({
			kind: "within",
			parent: this.#descriptor,
			child: { kind: "frame", selector: requireString(selector, "locator.frameLocator") },
		});
	}
}

/** Playwright-compatible tab API for selectors, screenshots, waits, and events. */
export class CodexPlaywright {
	readonly #adapter: CodexBrowserAdapter;
	readonly #tabId: string;

	constructor(adapter: CodexBrowserAdapter, tabId: string) {
		this.#adapter = adapter;
		this.#tabId = tabId;
	}

	#locator(descriptor: CodexLocatorDescriptor): CodexLocator {
		return new CodexLocator(this.#adapter, this.#tabId, descriptor);
	}

	async domSnapshot(): Promise<string> {
		return await this.#adapter.invoke<string>("playwright.domSnapshot", { tabId: this.#tabId });
	}

	async elementInfo(options: CodexElementInfoOptions): Promise<CodexElementInfo[]> {
		const point = coordinates(options, "playwright.elementInfo");
		const value = requireObject(options, "playwright.elementInfo");
		if (value.includeNonInteractable !== undefined && typeof value.includeNonInteractable !== "boolean") {
			throw new Error("playwright.elementInfo includeNonInteractable must be a boolean");
		}
		return await this.#adapter.invoke<CodexElementInfo[]>("playwright.elementInfo", {
			tabId: this.#tabId,
			...point,
			includeNonInteractable: value.includeNonInteractable,
		});
	}

	async elementScreenshot(options: CodexPoint): Promise<CodexImage> {
		const point = coordinates(options, "playwright.elementScreenshot");
		const base64 = await this.#adapter.invoke<string>("playwright.elementScreenshot", {
			tabId: this.#tabId,
			...point,
		});
		return new ImageValue(base64);
	}

	locator(selector: string): CodexLocator {
		return this.#locator({ kind: "css", selector: requireString(selector, "playwright.locator") });
	}

	getByRole(role: string, options: CodexRoleLocatorOptions = {}): CodexLocator {
		const value = requireObject(options, "playwright.getByRole");
		return this.#locator({
			kind: "role",
			role: requireString(role, "playwright.getByRole"),
			name: value.name === undefined ? undefined : textPattern(value.name, "playwright.getByRole name", value.exact),
		});
	}

	getByText(text: string | RegExp, options: CodexTextLocatorOptions = {}): CodexLocator {
		const value = requireObject(options, "playwright.getByText");
		return this.#locator({ kind: "text", text: textPattern(text, "playwright.getByText", value.exact) });
	}

	getByLabel(text: string | RegExp, options: CodexTextLocatorOptions = {}): CodexLocator {
		const value = requireObject(options, "playwright.getByLabel");
		return this.#locator({ kind: "label", text: textPattern(text, "playwright.getByLabel", value.exact) });
	}

	getByPlaceholder(text: string | RegExp, options: CodexTextLocatorOptions = {}): CodexLocator {
		const value = requireObject(options, "playwright.getByPlaceholder");
		return this.#locator({
			kind: "placeholder",
			text: textPattern(text, "playwright.getByPlaceholder", value.exact),
		});
	}

	getByTestId(testId: string): CodexLocator {
		return this.#locator({ kind: "testId", testId: requireString(testId, "playwright.getByTestId") });
	}

	frameLocator(selector: string): CodexLocator {
		return this.#locator({ kind: "frame", selector: requireString(selector, "playwright.frameLocator") });
	}

	async screenshot(options: CodexScreenshotOptions = {}): Promise<CodexImage> {
		const value = requireObject(options, "playwright.screenshot");
		if (value.fullPage !== undefined && typeof value.fullPage !== "boolean")
			throw new Error("playwright.screenshot fullPage must be a boolean");
		let clip: { x: number; y: number; width: number; height: number } | undefined;
		if (value.clip !== undefined) {
			const source = requireObject(value.clip, "playwright.screenshot clip");
			clip = {
				x: requireNumber(source.x, "playwright.screenshot clip x"),
				y: requireNumber(source.y, "playwright.screenshot clip y"),
				width: requireNumber(source.width, "playwright.screenshot clip width"),
				height: requireNumber(source.height, "playwright.screenshot clip height"),
			};
			if (clip.width <= 0 || clip.height <= 0)
				throw new Error("playwright.screenshot clip width and height must be positive");
		}
		const base64 = await this.#adapter.invoke<string>("playwright.screenshot", {
			tabId: this.#tabId,
			fullPage: value.fullPage,
			clip,
		});
		return new ImageValue(base64);
	}

	async waitForURL(url: string | RegExp, options: CodexWaitOptions = {}): Promise<void> {
		const value = requireObject(options, "playwright.waitForURL");
		const pattern = textPattern(url, "playwright.waitForURL");
		await this.#adapter.invoke<void>("playwright.waitForURL", {
			tabId: this.#tabId,
			url: pattern,
			waitUntil: loadState(value.waitUntil, "playwright.waitForURL"),
			timeoutMs: navigationTimeout(value.timeoutMs, "playwright.waitForURL"),
		});
	}

	async waitForLoadState(options: CodexLoadStateOptions = {}): Promise<void> {
		const value = requireObject(options, "playwright.waitForLoadState");
		await this.#adapter.invoke<void>("playwright.waitForLoadState", {
			tabId: this.#tabId,
			state: loadState(value.state, "playwright.waitForLoadState"),
			timeoutMs: navigationTimeout(value.timeoutMs, "playwright.waitForLoadState"),
		});
	}

	async waitForTimeout(timeoutMs: number): Promise<void> {
		await this.#adapter.invoke<void>("playwright.waitForTimeout", {
			tabId: this.#tabId,
			timeoutMs: nonNegativeInteger(timeoutMs, "playwright.waitForTimeout"),
		});
	}

	async expectNavigation<T>(
		callback: () => T | Promise<T>,
		options: CodexWaitOptions & { url?: string | RegExp } = {},
	): Promise<T> {
		if (typeof callback !== "function") throw new Error("playwright.expectNavigation requires a callback");
		const value = requireObject(options, "playwright.expectNavigation");
		const navigationId = crypto.randomUUID();
		const navigation = this.#adapter
			.invoke<void>("playwright.expectNavigation", {
				tabId: this.#tabId,
				navigationId,
				url: value.url === undefined ? undefined : textPattern(value.url, "playwright.expectNavigation url"),
				waitUntil: loadState(value.waitUntil, "playwright.expectNavigation"),
				timeoutMs: navigationTimeout(value.timeoutMs, "playwright.expectNavigation"),
			})
			.then(
				() => ({ kind: "navigation" as const }),
				error => ({ kind: "navigationError" as const, error }),
			);
		const cancelNavigation = async (): Promise<void> => {
			await this.#adapter
				.invoke<void>("playwright.expectNavigation.cancel", { tabId: this.#tabId, navigationId })
				.catch(() => undefined);
		};
		type CallbackOutcome = { kind: "callback"; result: T } | { kind: "callbackError"; error: unknown };
		let callbackSettled: CallbackOutcome | undefined;
		let callbackResult: Promise<CallbackOutcome>;
		try {
			callbackResult = Promise.resolve(callback()).then(
				result => (callbackSettled = { kind: "callback", result }),
				error => (callbackSettled = { kind: "callbackError", error }),
			);
		} catch (error) {
			await cancelNavigation();
			throw error;
		}
		const first = await Promise.race([callbackResult, navigation]);
		if (callbackSettled?.kind === "callbackError") {
			await cancelNavigation();
			throw callbackSettled.error;
		}
		if (first.kind === "callbackError") {
			await cancelNavigation();
			throw first.error;
		}
		if (first.kind === "navigationError") throw first.error;
		if (first.kind === "navigation") {
			const callbackOutcome = await callbackResult;
			if (callbackOutcome.kind === "callbackError") {
				await cancelNavigation();
				throw callbackOutcome.error;
			}
			return callbackOutcome.result;
		}
		const navigationOutcome = await navigation;
		if (navigationOutcome.kind === "navigationError") throw navigationOutcome.error;
		return first.result;
	}

	async waitForEvent(
		event: "download" | "filechooser",
		options: CodexLocatorActionOptions = {},
	): Promise<CodexDownload | CodexFileChooser> {
		if (event !== "download" && event !== "filechooser") {
			throw new Error("playwright.waitForEvent only supports 'download' and 'filechooser'");
		}
		const value = requireObject(options, "playwright.waitForEvent");
		const result = await this.#adapter.invoke<{ token: string; multiple?: boolean }>("playwright.waitForEvent", {
			tabId: this.#tabId,
			event,
			timeoutMs: selectorTimeout(value.timeoutMs, "playwright.waitForEvent"),
		});
		return event === "download"
			? new DownloadValue(this.#adapter, this.#tabId, result.token)
			: new FileChooserValue(this.#adapter, this.#tabId, result.token, result.multiple === true);
	}
}

/** DOM-backed computer-use API for acting on identifiers from visible DOM snapshots. */
export class CodexDomCua {
	readonly #adapter: CodexBrowserAdapter;
	readonly #tabId: string;

	constructor(adapter: CodexBrowserAdapter, tabId: string) {
		this.#adapter = adapter;
		this.#tabId = tabId;
	}

	async get_visible_dom(): Promise<CodexVisibleDom> {
		return await this.#adapter.invoke<CodexVisibleDom>("dom_cua.get_visible_dom", { tabId: this.#tabId });
	}

	async click(options: CodexDomNodeAction): Promise<void> {
		const value = requireObject(options, "dom_cua.click");
		await this.#adapter.invoke<void>("dom_cua.click", {
			tabId: this.#tabId,
			nodeId: nodeId(value.node_id, "dom_cua.click"),
		});
	}

	async double_click(options: CodexDomNodeAction): Promise<void> {
		const value = requireObject(options, "dom_cua.double_click");
		await this.#adapter.invoke<void>("dom_cua.double_click", {
			tabId: this.#tabId,
			nodeId: nodeId(value.node_id, "dom_cua.double_click"),
		});
	}

	async scroll(options: CodexDomScroll): Promise<void> {
		const value = requireObject(options, "dom_cua.scroll");
		if (typeof value.x !== "number" || typeof value.y !== "number")
			throw new Error("dom_cua.scroll requires x and y numbers");
		if (value.node_id !== undefined) nodeId(value.node_id, "dom_cua.scroll");
		await this.#adapter.invoke<void>("dom_cua.scroll", {
			tabId: this.#tabId,
			nodeId: value.node_id,
			x: requireNumber(value.x, "dom_cua.scroll x"),
			y: requireNumber(value.y, "dom_cua.scroll y"),
		});
	}

	async type(options: CodexTypeAction): Promise<void> {
		const value = requireObject(options, "dom_cua.type");
		if (typeof value.text !== "string" || value.text.length === 0) throw new Error("dom_cua.type requires text");
		await this.#adapter.invoke<void>("dom_cua.type", { tabId: this.#tabId, text: value.text });
	}

	async keypress(options: CodexKeysAction): Promise<void> {
		const value = requireObject(options, "dom_cua.keypress");
		const keys = optionalKeyArray(value.keys, "dom_cua.keypress");
		if (!keys) throw new Error("dom_cua.keypress requires a non-empty keys array");
		await this.#adapter.invoke<void>("dom_cua.keypress", { tabId: this.#tabId, keys });
	}

	async downloadMedia(options: CodexDomDownload): Promise<void> {
		const value = requireObject(options, "dom_cua.downloadMedia");
		await this.#adapter.invoke<void>("dom_cua.downloadMedia", {
			tabId: this.#tabId,
			nodeId: nodeId(value.node_id, "dom_cua.downloadMedia"),
			timeoutMs: selectorTimeout(value.timeoutMs, "dom_cua.downloadMedia"),
		});
	}
}

/** Coordinate-backed computer-use API for visual interaction with a tab. */
export class CodexCoordinateCua {
	readonly #adapter: CodexBrowserAdapter;
	readonly #tabId: string;

	constructor(adapter: CodexBrowserAdapter, tabId: string) {
		this.#adapter = adapter;
		this.#tabId = tabId;
	}

	async get_visible_screenshot(): Promise<CodexImage> {
		const { data } = await this.#adapter.invoke<{ data: string }>("cua.get_visible_screenshot", {
			tabId: this.#tabId,
		});
		return new ImageValue(data);
	}

	async click(options: CodexCoordinateClick): Promise<void> {
		const value = requireObject(options, "cua.click");
		const point = coordinates(value, "cua.click");
		const button = value.button === undefined ? 1 : value.button;
		if (button !== 1 && button !== 2 && button !== 3) throw new Error("cua.click button must be 1, 2, or 3");
		await this.#adapter.invoke<void>("cua.click", {
			tabId: this.#tabId,
			...point,
			button,
			keypress: optionalKeyArray(value.keypress, "cua.click keypress"),
		});
	}

	async double_click(options: CodexCoordinateDoubleClick): Promise<void> {
		const value = requireObject(options, "cua.double_click");
		await this.#adapter.invoke<void>("cua.double_click", {
			tabId: this.#tabId,
			...coordinates(value, "cua.double_click"),
			keypress: optionalKeyArray(value.keypress, "cua.double_click keypress"),
		});
	}

	async drag(options: CodexCoordinateDrag): Promise<void> {
		const value = requireObject(options, "cua.drag");
		if (!Array.isArray(value.path) || value.path.length === 0) throw new Error("cua.drag requires a non-empty path");
		const path = value.path.map(point => coordinates(point, "cua.drag path point"));
		await this.#adapter.invoke<void>("cua.drag", {
			tabId: this.#tabId,
			path,
			keys: optionalKeyArray(value.keys, "cua.drag keys"),
		});
	}

	async keypress(options: CodexKeysAction): Promise<void> {
		const value = requireObject(options, "cua.keypress");
		const keys = optionalKeyArray(value.keys, "cua.keypress");
		if (!keys) throw new Error("cua.keypress requires a non-empty keys array");
		await this.#adapter.invoke<void>("cua.keypress", { tabId: this.#tabId, keys });
	}

	async move(options: CodexCoordinateAction): Promise<void> {
		const value = requireObject(options, "cua.move");
		await this.#adapter.invoke<void>("cua.move", {
			tabId: this.#tabId,
			...coordinates(value, "cua.move"),
			keys: optionalKeyArray(value.keys, "cua.move keys"),
		});
	}

	async scroll(options: CodexCoordinateScroll): Promise<void> {
		const value = requireObject(options, "cua.scroll");
		await this.#adapter.invoke<void>("cua.scroll", {
			tabId: this.#tabId,
			...coordinates(value, "cua.scroll"),
			scrollX: requireNumber(value.scrollX, "cua.scroll scrollX"),
			scrollY: requireNumber(value.scrollY, "cua.scroll scrollY"),
			keypress: optionalKeyArray(value.keypress, "cua.scroll keypress"),
		});
	}

	async type(options: CodexTypeAction): Promise<void> {
		const value = requireObject(options, "cua.type");
		await this.#adapter.invoke<void>("cua.type", {
			tabId: this.#tabId,
			text: requireString(value.text, "cua.type", true),
		});
	}

	async downloadMedia(options: CodexCoordinateDownload): Promise<void> {
		const value = requireObject(options, "cua.downloadMedia");
		await this.#adapter.invoke<void>("cua.downloadMedia", {
			tabId: this.#tabId,
			...coordinates(value, "cua.downloadMedia"),
			timeoutMs: selectorTimeout(value.timeoutMs, "cua.downloadMedia"),
		});
	}
}

/** Stable public handle callers use to navigate and interact with one logical tab. */
export class CodexTab {
	readonly id: string;
	readonly playwright: CodexPlaywright;
	readonly dom_cua: CodexDomCua;
	readonly cua: CodexCoordinateCua;
	readonly content: {
		export(): Promise<string>;
		exportGsuite(format: CodexGsuiteFormat): Promise<string>;
	};
	readonly clipboard: {
		read(): Promise<CodexClipboardItem[]>;
		readText(): Promise<string>;
		write(items: [CodexClipboardItem, ...CodexClipboardItem[]]): Promise<void>;
		writeText(text: string): Promise<void>;
	};
	readonly dev: { logs(options?: CodexDevLogOptions): Promise<unknown[]> };
	readonly #adapter: CodexBrowserAdapter;

	constructor(adapter: CodexBrowserAdapter, id: string) {
		this.#adapter = adapter;
		this.id = id;
		this.playwright = new CodexPlaywright(adapter, id);
		this.dom_cua = new CodexDomCua(adapter, id);
		this.cua = new CodexCoordinateCua(adapter, id);
		this.content = {
			export: async () => await adapter.invoke<string>("tab.content.export", { tabId: id }),
			exportGsuite: async format => {
				if (!Object.hasOwn(GSUITE_FORMATS, format))
					throw new Error("content.exportGsuite requires a supported format");
				return await adapter.invoke<string>("tab.content.exportGsuite", { tabId: id, format });
			},
		};
		this.clipboard = {
			read: async () => await adapter.invoke<CodexClipboardItem[]>("tab.clipboard.read", { tabId: id }),
			readText: async () => await adapter.invoke<string>("tab.clipboard.readText", { tabId: id }),
			write: async items => {
				if (!Array.isArray(items) || items.length === 0)
					throw new Error("clipboard.write requires at least one item");
				for (const item of items) {
					const clipboardItem = requireObject(item, "clipboard.write item");
					if (
						clipboardItem.presentationStyle !== undefined &&
						(typeof clipboardItem.presentationStyle !== "string" ||
							!Object.hasOwn(CLIPBOARD_PRESENTATION_STYLES, clipboardItem.presentationStyle))
					) {
						throw new Error("clipboard.write presentationStyle must be unspecified, inline, or attachment");
					}
					if (!Array.isArray(clipboardItem.entries) || clipboardItem.entries.length === 0) {
						throw new Error("clipboard.write requires every item to contain entries");
					}
					const mimeTypes = new Set<string>();
					for (const entry of clipboardItem.entries) {
						const clipboardEntry = requireObject(entry, "clipboard.write entry");
						if (typeof clipboardEntry.mimeType !== "string" || clipboardEntry.mimeType.length === 0) {
							throw new Error("clipboard.write entry requires a mimeType");
						}
						if (mimeTypes.has(clipboardEntry.mimeType)) {
							throw new Error(`clipboard.write item contains duplicate mimeType ${clipboardEntry.mimeType}`);
						}
						mimeTypes.add(clipboardEntry.mimeType);
						const hasText = typeof clipboardEntry.text === "string";
						const hasBase64 = typeof clipboardEntry.base64 === "string";
						if (hasText === hasBase64)
							throw new Error("clipboard.write entry requires exactly one of text or base64");
					}
				}
				await adapter.invoke<void>("tab.clipboard.write", { tabId: id, items });
			},
			writeText: async text => {
				await adapter.invoke<void>("tab.clipboard.writeText", {
					tabId: id,
					text: requireString(text, "clipboard.writeText", true),
				});
			},
		};
		this.dev = {
			logs: async (options: CodexDevLogOptions = {}) => {
				const value = requireObject(options, "dev.logs");
				if (value.filter !== undefined && typeof value.filter !== "string")
					throw new Error("dev.logs filter must be a string");
				let levels: string[] | undefined;
				if (value.levels !== undefined) {
					if (
						!Array.isArray(value.levels) ||
						value.levels.some(level => typeof level !== "string" || !Object.hasOwn(LOG_LEVELS, level))
					) {
						throw new Error("dev.logs levels contains an invalid level");
					}
					levels = value.levels.map(level => (level === "warning" ? "warn" : level)) as string[];
				}
				const limit = value.limit === undefined ? undefined : positiveInteger(value.limit, "dev.logs limit");
				return await adapter.invoke<unknown[]>("tab.dev.logs", { tabId: id, filter: value.filter, levels, limit });
			},
		};
	}

	async goto(url: string): Promise<void> {
		await this.#adapter.invoke<void>("tab.goto", {
			tabId: this.id,
			url: requireString(url, "tab.goto"),
			timeoutMs: NAVIGATION_TIMEOUT_MS,
		});
	}

	async back(): Promise<void> {
		await this.#adapter.invoke<void>("tab.back", { tabId: this.id, timeoutMs: NAVIGATION_TIMEOUT_MS });
	}

	async forward(): Promise<void> {
		await this.#adapter.invoke<void>("tab.forward", { tabId: this.id, timeoutMs: NAVIGATION_TIMEOUT_MS });
	}

	async reload(): Promise<void> {
		await this.#adapter.invoke<void>("tab.reload", { tabId: this.id, timeoutMs: NAVIGATION_TIMEOUT_MS });
	}

	async close(): Promise<void> {
		await this.#adapter.invoke<void>("tab.close", { tabId: this.id });
	}

	async title(): Promise<string> {
		return await this.#adapter.invoke<string>("tab.title", { tabId: this.id });
	}

	async url(): Promise<string> {
		return await this.#adapter.invoke<string>("tab.url", { tabId: this.id });
	}
}

class BrowserFacade implements CodexBrowserFacade {
	readonly #adapter: CodexBrowserAdapter;
	readonly #tabsById = new Map<string, CodexTab>();
	readonly tabs: CodexBrowserFacade["tabs"];
	readonly user: CodexBrowserFacade["user"];

	constructor(adapter: CodexBrowserAdapter) {
		this.#adapter = adapter;
		requireTabId(adapter.currentTabId);
		this.tabs = {
			new: async () => {
				const summary = await adapter.invoke<CodexTabSummary>("tab.new", {});
				return this.#tab(requireTabId(summary.id));
			},
			selected: async () => {
				const summary = await adapter.invoke<CodexTabSummary | null>("tab.selected", {});
				return summary ? this.#tab(requireTabId(summary.id)) : undefined;
			},
			list: async () => {
				const summaries = await adapter.invoke<CodexTabSummary[]>("tab.list", {});
				return summaries.map(summary => ({ ...summary, id: requireTabId(summary.id) }));
			},
			get: async rawId => {
				const id = requireTabId(rawId);
				const summary = await adapter.invoke<CodexTabSummary | null>("tab.get", { id });
				if (!summary) {
					const existing = (await adapter.invoke<CodexTabSummary[]>("tab.list", {})).map(tab => tab.id);
					throw new Error(`tabs.get could not find tab id "${id}". Existing tabs: ${existing.join(", ")}`);
				}
				return this.#tab(requireTabId(summary.id));
			},
			content: async options => {
				const value = requireObject(options, "browser.tabs.content");
				if (!Array.isArray(value.urls) || value.urls.some(url => typeof url !== "string" || !url)) {
					throw new Error("browser.tabs.content requires a urls array of strings");
				}
				const contentType = requireString(value.contentType, "browser.tabs.content contentType");
				if (!Object.hasOwn(CONTENT_TYPES, contentType)) {
					throw new Error("browser.tabs.content contentType must be html, text, or domSnapshot");
				}
				const timeoutMs =
					value.timeoutMs === undefined
						? NAVIGATION_TIMEOUT_MS
						: positiveInteger(value.timeoutMs, "browser.tabs.content timeoutMs");
				if (value.urls.length === 0) return [];
				return await adapter.invoke<CodexTabsContentResult[]>("tabs.content", {
					urls: [...value.urls],
					contentType,
					timeoutMs,
				});
			},
		};
		this.user = {
			openTabs: async () => await adapter.invoke<unknown[]>("browser.user.openTabs", {}),
			history: async (options: CodexHistoryOptions = {}) => {
				const value = requireObject(options, "browser.user.history");
				for (const key of ["from", "to"] as const) {
					const date = value[key];
					if (
						date !== undefined &&
						!(date instanceof Date) &&
						typeof date !== "string" &&
						typeof date !== "number"
					) {
						throw new Error(`browser.user.history ${key} must be a Date, string, or number`);
					}
					const timestamp =
						date instanceof Date
							? date.getTime()
							: typeof date === "string" || typeof date === "number"
								? new Date(date).getTime()
								: undefined;
					if (timestamp !== undefined && Number.isNaN(timestamp)) {
						throw new Error(`browser.user.history ${key} must be a valid date`);
					}
				}
				if (value.query !== undefined && typeof value.query !== "string")
					throw new Error("browser.user.history query must be a string");
				const limit =
					value.limit === undefined ? undefined : positiveInteger(value.limit, "browser.user.history limit");
				return await adapter.invoke<unknown[]>("browser.user.history", {
					from: value.from instanceof Date ? value.from.toISOString() : value.from,
					to: value.to instanceof Date ? value.to.toISOString() : value.to,
					query: value.query,
					limit,
				});
			},
		};
	}

	async nameSession(name: string): Promise<void> {
		if (typeof name !== "string" || !name.trim()) throw new Error("browser.nameSession requires a name");
		await this.#adapter.invoke<void>("browser.nameSession", { name: name.trim() });
	}

	#tab(id: string): CodexTab {
		let tab = this.#tabsById.get(id);
		if (!tab) {
			tab = new CodexTab(this.#adapter, id);
			this.#tabsById.set(id, tab);
		}
		return tab;
	}
}

/** Creates the Codex-compatible browser namespace for a backend adapter. */
export function createCodexBrowserFacade(adapter: CodexBrowserAdapter): CodexBrowserFacade {
	return new BrowserFacade(adapter);
}

/** Attaches a Codex-compatible browser namespace while preserving a callable agent object. */
export function attachCodexBrowserToAgent<T extends object>(
	agent: T,
	adapter: CodexBrowserAdapter,
): T & { browser: CodexBrowserFacade } {
	const browser = createCodexBrowserFacade(adapter);
	Object.defineProperty(agent, "browser", {
		value: browser,
		configurable: true,
		writable: true,
		enumerable: true,
	});
	return agent as T & { browser: CodexBrowserFacade };
}
