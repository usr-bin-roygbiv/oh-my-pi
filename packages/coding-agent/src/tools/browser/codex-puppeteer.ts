import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Snowflake, untilAborted } from "@oh-my-pi/pi-utils";
import type {
	Browser,
	CDPSession,
	ElementHandle,
	FileChooser,
	JSHandle,
	KeyInput,
	MouseButton,
	Page,
} from "puppeteer-core";
import { resolveToCwd } from "../path-utils";
import { throwIfAborted } from "../tool-errors";
import { captureAriaSnapshot, getAriaElementState, queryAriaLocatorHandle } from "./aria/aria-snapshot";
import {
	BrowserCapabilityError,
	CODEX_BROWSER_CAPABILITIES,
	type CodexBrowserAdapter,
	type CodexBrowserOperation,
	type CodexLoadState,
	type CodexLocatorDescriptor,
	type CodexTabSummary,
	type CodexTextPattern,
	type CodexVisibleDom,
} from "./codex-facade";

interface RuntimeRemoteObject {
	type: string;
	value?: unknown;
	description?: string;
}

interface RuntimeConsoleEvent {
	type: string;
	args: RuntimeRemoteObject[];
}

interface RuntimeExceptionEvent {
	exceptionDetails?: {
		text?: string;
		exception?: RuntimeRemoteObject;
	};
}

export interface BrowserLogEntry {
	level: string;
	text: string;
	timestamp: number;
}

export interface PuppeteerCodexSessionState {
	currentTabId: string;
	nextTabId: number;
	closed: boolean;
	sessionName: string;
	logs: BrowserLogEntry[];
	logPage?: Page;
	logSession?: CDPSession;
	logHandler?: (event: RuntimeConsoleEvent) => void;
	logExceptionHandler?: (event: RuntimeExceptionEvent) => void;
}

export function createPuppeteerCodexSessionState(): PuppeteerCodexSessionState {
	return { currentTabId: "1", nextTabId: 2, closed: false, sessionName: "", logs: [] };
}

interface PuppeteerAdapterOptions {
	state?: PuppeteerCodexSessionState;
	currentTabId?: string;
	page: Page;
	browser: Browser;
	signal: AbortSignal;
	cwd: string;
	captureScreenshot(options: { fullPage?: boolean }): Promise<string>;
}

interface LocatorArgs {
	tabId: string;
	locator: CodexLocatorDescriptor;
	timeoutMs?: number;
}

function runtimeValueText(value: RuntimeRemoteObject): string {
	if (typeof value.value === "string") return value.value;
	if (value.value !== undefined) {
		try {
			return JSON.stringify(value.value) ?? String(value.value);
		} catch {
			return String(value.value);
		}
	}
	return value.description ?? value.type;
}

function appendBrowserLog(state: PuppeteerCodexSessionState, level: string, text: string): void {
	state.logs.push({ level, text, timestamp: Date.now() });
	if (state.logs.length > 5_000) state.logs.splice(0, state.logs.length - 5_000);
}

function runtimeExceptionText(event: RuntimeExceptionEvent): string {
	const details = event.exceptionDetails;
	const direct = typeof details?.text === "string" ? details.text.trim() : "";
	if (direct) return direct;
	const description = typeof details?.exception?.description === "string" ? details.exception.description.trim() : "";
	if (description) return description;
	return details?.exception ? runtimeValueText(details.exception) : "Uncaught exception";
}

export async function attachPuppeteerCodexLogCapture(page: Page, state: PuppeteerCodexSessionState): Promise<void> {
	if (state.logPage === page && state.logSession && state.logHandler && state.logExceptionHandler) return;
	await detachPuppeteerCodexLogCapture(state);
	const session = await page.target().createCDPSession();
	const handler = (event: RuntimeConsoleEvent) => {
		appendBrowserLog(
			state,
			event.type === "warning" ? "warn" : event.type,
			event.args.map(runtimeValueText).join(" "),
		);
	};
	const exceptionHandler = (event: RuntimeExceptionEvent) => {
		appendBrowserLog(state, "error", runtimeExceptionText(event));
	};
	state.logPage = page;
	state.logSession = session;
	state.logHandler = handler;
	state.logExceptionHandler = exceptionHandler;
	session.on("Runtime.consoleAPICalled", handler);
	session.on("Runtime.exceptionThrown", exceptionHandler);
	try {
		await session.send("Runtime.enable");
	} catch (error) {
		await detachPuppeteerCodexLogCapture(state);
		throw error;
	}
}

export async function detachPuppeteerCodexLogCapture(state: PuppeteerCodexSessionState): Promise<void> {
	if (state.logSession && state.logHandler) state.logSession.off("Runtime.consoleAPICalled", state.logHandler);
	if (state.logSession && state.logExceptionHandler)
		state.logSession.off("Runtime.exceptionThrown", state.logExceptionHandler);
	const session = state.logSession;
	state.logPage = undefined;
	state.logSession = undefined;
	state.logHandler = undefined;
	state.logExceptionHandler = undefined;
	if (session) await session.detach().catch(() => undefined);
}

interface PageScrollableElement {
	scrollLeft: number;
	scrollTop: number;
	scrollBy(options: { left: number; top: number }): void;
}

interface PageEditableElement {
	contains(node: unknown): boolean;
	disabled?: boolean;
	getAttribute(name: string): string | null;
	isContentEditable: boolean;
	readOnly?: boolean;
	selectionEnd: number | null;
	selectionStart: number | null;
	tagName: string;
	textContent: string | null;
	value: string;
}

interface PageDocumentLike {
	activeElement: PageEditableElement | null;
	baseURI: string;
}

interface PageRangeLike {
	cloneRange(): PageRangeLike;
	endContainer: unknown;
	endOffset: number;
	selectNodeContents(node: unknown): void;
	setEnd(node: unknown, offset: number): void;
	startContainer: unknown;
	startOffset: number;
	toString(): string;
}

interface PageSelectionLike {
	anchorNode: unknown;
	getRangeAt(index: number): PageRangeLike;
	rangeCount: number;
}

interface DownloadedMedia {
	base64Chunks: string[];
	contentType: string | null;
}

const MAX_DECODED_MEDIA_BYTES = 32 * 1024 * 1024;
const CANONICAL_BASE64_CHUNK = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function decodeBoundedMediaChunks(base64Chunks: readonly string[]): Buffer[] {
	let byteLength = 0;
	for (const chunk of base64Chunks) {
		if (!CANONICAL_BASE64_CHUNK.test(chunk))
			throw new Error("downloadMedia page transfer returned invalid base64 data");
		const padding = chunk.endsWith("==") ? 2 : chunk.endsWith("=") ? 1 : 0;
		byteLength += (chunk.length / 4) * 3 - padding;
		if (byteLength > MAX_DECODED_MEDIA_BYTES) {
			throw new Error("downloadMedia response exceeds the 32 MiB limit");
		}
	}
	return base64Chunks.map(chunk => {
		const decoded = Buffer.from(chunk, "base64");
		if (decoded.toString("base64") !== chunk) {
			throw new Error("downloadMedia page transfer returned invalid base64 data");
		}
		return decoded;
	});
}

interface DownloadRecord {
	readonly filename: string;
	readonly completion: Promise<string | null>;
}

interface DownloadWillBeginEvent {
	guid: string;
	frameId?: string;
	suggestedFilename: string;
}

interface DownloadProgressEvent {
	guid: string;
	state: "inProgress" | "completed" | "canceled";
}

interface DownloadCompletionRecord {
	readonly path: string;
	readonly download: DownloadRecord;
	readonly resolve: (value: string | null) => void;
	settled: boolean;
}

interface DownloadWaiter {
	readonly resolve: (download: DownloadRecord) => void;
	readonly reject: (reason: unknown) => void;
}

interface DownloadPolicyLease {
	readonly downloadDirectory: string;
	readonly stateRoot: string;
	readonly leasePath: string;
	readonly heartbeat: NodeJS.Timeout;
}

interface DownloadPolicyLocation {
	readonly directory: string;
	readonly requiresLease: boolean;
}

interface DownloadPolicyCoordinator {
	readonly browser: Browser;
	readonly directory: string;
	readonly requiresLease: boolean;
	refs: number;
	setup?: Promise<void>;
	release?: Promise<void>;
	lease?: DownloadPolicyLease;
}

interface DownloadPolicyOwnership {
	readonly coordinator: DownloadPolicyCoordinator;
	released: boolean;
}

const downloadPolicyCoordinators = new WeakMap<Browser, DownloadPolicyCoordinator>();
const DOWNLOAD_POLICY_LEASE_HEARTBEAT_MS = 10_000;
const DOWNLOAD_POLICY_LEASE_STALE_MS = 60_000;
const DOWNLOAD_POLICY_LOCK_HEARTBEAT_MS = 5_000;
const DOWNLOAD_POLICY_LOCK_STALE_MS = 30_000;
const DOWNLOAD_POLICY_LOCK_RETRY_MS = 10;

function filesystemErrorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	return typeof error.code === "string" ? error.code : undefined;
}

async function removeEmptyDirectory(directory: string): Promise<void> {
	await fs.promises.rmdir(directory).catch(error => {
		const code = filesystemErrorCode(error);
		if (code !== "ENOENT" && code !== "ENOTEMPTY") throw error;
	});
}

async function withDownloadPolicyLock<T>(stateRoot: string, action: () => Promise<T>): Promise<T> {
	await fs.promises.mkdir(stateRoot, { recursive: true });
	const lockPath = path.join(stateRoot, "lock");
	for (;;) {
		try {
			await fs.promises.mkdir(lockPath);
			break;
		} catch (error) {
			const code = filesystemErrorCode(error);
			if (code === "ENOENT") {
				await fs.promises.mkdir(stateRoot, { recursive: true });
				continue;
			}
			if (code !== "EEXIST") throw error;
			const stale = await fs.promises
				.stat(lockPath)
				.then(stat => Date.now() - stat.mtimeMs > DOWNLOAD_POLICY_LOCK_STALE_MS)
				.catch(() => false);
			if (stale) await fs.promises.rmdir(lockPath).catch(() => undefined);
			await Bun.sleep(DOWNLOAD_POLICY_LOCK_RETRY_MS);
		}
	}
	const heartbeat = setInterval(() => {
		const now = new Date();
		void fs.promises.utimes(lockPath, now, now).catch(() => undefined);
	}, DOWNLOAD_POLICY_LOCK_HEARTBEAT_MS);
	heartbeat.unref();
	try {
		return await action();
	} finally {
		clearInterval(heartbeat);
		await fs.promises.rmdir(lockPath).catch(() => undefined);
	}
}

async function countLiveDownloadPolicyLeases(leaseDirectory: string): Promise<number> {
	const names = await fs.promises.readdir(leaseDirectory).catch(error => {
		if (filesystemErrorCode(error) === "ENOENT") return [];
		throw error;
	});
	let live = 0;
	for (const name of names) {
		if (!name.startsWith("owner-") || !name.endsWith(".lease")) continue;
		const leasePath = path.join(leaseDirectory, name);
		try {
			const stat = await fs.promises.stat(leasePath);
			if (Date.now() - stat.mtimeMs <= DOWNLOAD_POLICY_LEASE_STALE_MS) {
				live++;
				continue;
			}
			await fs.promises.unlink(leasePath).catch(() => undefined);
		} catch (error) {
			if (filesystemErrorCode(error) !== "ENOENT") live++;
		}
	}
	return live;
}

async function acquireDownloadPolicyLease(downloadDirectory: string): Promise<DownloadPolicyLease> {
	const stateRoot = `${downloadDirectory}.policy`;
	const leaseDirectory = path.join(stateRoot, "leases");
	const leasePath = path.join(leaseDirectory, `owner-${randomUUID()}.lease`);
	await withDownloadPolicyLock(stateRoot, async () => {
		await fs.promises.mkdir(leaseDirectory, { recursive: true });
		await countLiveDownloadPolicyLeases(leaseDirectory);
		const lease = await fs.promises.open(leasePath, "wx");
		await lease.close();
	});
	const heartbeat = setInterval(() => {
		const now = new Date();
		void fs.promises.utimes(leasePath, now, now).catch(() => undefined);
	}, DOWNLOAD_POLICY_LEASE_HEARTBEAT_MS);
	heartbeat.unref();
	return { downloadDirectory, stateRoot, leasePath, heartbeat };
}

async function releaseDownloadPolicyLease(lease: DownloadPolicyLease, reset?: () => Promise<void>): Promise<void> {
	const leaseDirectory = path.dirname(lease.leasePath);
	let remaining = 0;
	await withDownloadPolicyLock(lease.stateRoot, async () => {
		clearInterval(lease.heartbeat);
		await fs.promises.unlink(lease.leasePath).catch(error => {
			if (filesystemErrorCode(error) !== "ENOENT") throw error;
		});
		remaining = await countLiveDownloadPolicyLeases(leaseDirectory);
		if (remaining === 0 && reset) await reset();
		if (remaining === 0) await removeEmptyDirectory(leaseDirectory);
	});
	if (remaining === 0) {
		await removeEmptyDirectory(lease.stateRoot);
		await removeEmptyDirectory(lease.downloadDirectory);
	}
}

function browserDownloadLocation(browser: Browser, cwd: string): DownloadPolicyLocation {
	try {
		const endpoint = browser.wsEndpoint();
		if (typeof endpoint === "string" && endpoint.length > 0) {
			const identity = createHash("sha256").update(endpoint).digest("hex");
			return {
				directory: path.join(os.tmpdir(), "oh-my-pi-codex-downloads", identity),
				requiresLease: true,
			};
		}
	} catch {
		// Reduced Browser doubles may not implement a usable endpoint.
	}
	return { directory: path.join(cwd, `codex-download-${randomUUID()}`), requiresLease: false };
}

function getDownloadPolicyCoordinator(browser: Browser, cwd: string): DownloadPolicyCoordinator {
	let coordinator = downloadPolicyCoordinators.get(browser);
	if (!coordinator) {
		const location = browserDownloadLocation(browser, cwd);
		coordinator = { browser, directory: location.directory, requiresLease: location.requiresLease, refs: 0 };
		downloadPolicyCoordinators.set(browser, coordinator);
	}
	return coordinator;
}

async function acquireDownloadPolicy(
	browser: Browser,
	cwd: string,
	session: CDPSession,
): Promise<DownloadPolicyOwnership> {
	for (;;) {
		const coordinator = getDownloadPolicyCoordinator(browser, cwd);
		if (coordinator.release) {
			await coordinator.release.catch(() => undefined);
			continue;
		}
		coordinator.refs++;
		try {
			if (!coordinator.setup) {
				coordinator.setup = (async () => {
					const lease = coordinator.requiresLease
						? await acquireDownloadPolicyLease(coordinator.directory)
						: undefined;
					coordinator.lease = lease;
					try {
						await fs.promises.mkdir(coordinator.directory, { recursive: true });
						await session.send("Browser.setDownloadBehavior", {
							behavior: "allow",
							downloadPath: coordinator.directory,
							eventsEnabled: true,
						});
					} catch (error) {
						coordinator.lease = undefined;
						const reset = async () => {
							await session
								.send("Browser.setDownloadBehavior", { behavior: "default", eventsEnabled: false })
								.catch(() => undefined);
						};
						if (lease) await releaseDownloadPolicyLease(lease, reset);
						else await reset();
						throw error;
					}
				})();
			}
			await coordinator.setup;
			return { coordinator, released: false };
		} catch (error) {
			coordinator.refs--;
			if (coordinator.refs === 0 && downloadPolicyCoordinators.get(browser) === coordinator) {
				downloadPolicyCoordinators.delete(browser);
			}
			throw error;
		}
	}
}

async function releaseDownloadPolicy(ownership: DownloadPolicyOwnership, session: CDPSession): Promise<void> {
	if (ownership.released) return;
	ownership.released = true;
	const coordinator = ownership.coordinator;
	coordinator.refs--;
	if (coordinator.refs > 0) return;
	const release = (async () => {
		try {
			const lease = coordinator.lease;
			coordinator.lease = undefined;
			if (lease) {
				await releaseDownloadPolicyLease(lease, async () => {
					await session
						.send("Browser.setDownloadBehavior", { behavior: "default", eventsEnabled: false })
						.catch(() => undefined);
				});
			} else if (!coordinator.requiresLease) {
				await session
					.send("Browser.setDownloadBehavior", { behavior: "default", eventsEnabled: false })
					.catch(() => undefined);
			}
		} finally {
			if (downloadPolicyCoordinators.get(coordinator.browser) === coordinator) {
				downloadPolicyCoordinators.delete(coordinator.browser);
			}
		}
	})();
	coordinator.release = release;
	await release;
}

const TEMPORARY_PAGE_CLEANUP_TIMEOUT_MS = 500;

class TabsContentTimeoutError extends Error {}

function cancelFileChooser(chooser: FileChooser): void {
	const candidate: unknown = chooser;
	if (typeof candidate !== "object" || candidate === null || !("cancel" in candidate)) return;
	let cancel: unknown;
	try {
		cancel = candidate.cancel;
	} catch {
		return;
	}
	if (typeof cancel === "function") {
		void Promise.resolve()
			.then(() => Reflect.apply(cancel, chooser, []))
			.catch(() => undefined);
	}
}

interface ActionabilityOptions {
	visible?: boolean;
	enabled?: boolean;
	receivesPointerEvents?: boolean;
}

interface OperationDeadline {
	readonly label: string;
	readonly timeoutMs: number;
	readonly expiresAt: number;
}

function stringArg(args: Readonly<Record<string, unknown>>, key: string): string {
	const value = args[key];
	if (typeof value !== "string") throw new Error(`Puppeteer adapter expected ${key} to be a string`);
	return value;
}

function numberArg(args: Readonly<Record<string, unknown>>, key: string): number {
	const value = args[key];
	if (typeof value !== "number" || !Number.isFinite(value))
		throw new Error(`Puppeteer adapter expected ${key} to be a number`);
	return value;
}

function locatorArgs(args: Readonly<Record<string, unknown>>): LocatorArgs {
	const locator = args.locator;
	if (!locator || typeof locator !== "object") throw new Error("Puppeteer adapter requires a locator descriptor");
	return {
		tabId: stringArg(args, "tabId"),
		locator: locator as CodexLocatorDescriptor,
		timeoutMs: typeof args.timeoutMs === "number" ? args.timeoutMs : undefined,
	};
}

function patternMatches(value: string, pattern: CodexTextPattern): boolean {
	if (pattern.kind === "regexp") return new RegExp(pattern.source, pattern.flags).test(value);
	return pattern.exact ? value === pattern.value : value.includes(pattern.value);
}

function patternMatchesAccessibleText(value: string, pattern: CodexTextPattern): boolean {
	const normalizedValue = value.replace(/\s+/g, " ").trim();
	if (pattern.kind === "regexp") return new RegExp(pattern.source, pattern.flags).test(normalizedValue);
	const normalizedPattern = pattern.value.replace(/\s+/g, " ").trim();
	return pattern.exact
		? normalizedValue.toLocaleLowerCase() === normalizedPattern.toLocaleLowerCase()
		: normalizedValue.toLocaleLowerCase().includes(normalizedPattern.toLocaleLowerCase());
}

function loadState(value: unknown): CodexLoadState {
	if (value === "domcontentloaded" || value === "networkidle") return value;
	return "load";
}

function extensionForContentType(contentType: string | null): string {
	if (!contentType) return "bin";
	if (contentType.includes("png")) return "png";
	if (contentType.includes("jpeg")) return "jpg";
	if (contentType.includes("webp")) return "webp";
	if (contentType.includes("gif")) return "gif";
	if (contentType.includes("svg")) return "svg";
	if (contentType.includes("pdf")) return "pdf";
	return "bin";
}

export class PuppeteerCodexBrowserAdapter implements CodexBrowserAdapter {
	get currentTabId(): string {
		return this.#state.currentTabId;
	}
	readonly #state: PuppeteerCodexSessionState;
	readonly #page: Page;
	readonly #browser: Browser;
	readonly #signal: AbortSignal;
	readonly #cwd: string;
	readonly #captureScreenshot: (options: { fullPage?: boolean }) => Promise<string>;
	readonly #fileChoosers = new Map<string, FileChooser>();
	readonly #downloads = new Map<string, DownloadRecord>();
	readonly #downloadCompletions = new Map<string, DownloadCompletionRecord>();
	readonly #downloadWaiters = new Set<DownloadWaiter>();
	readonly #navigationWaiters = new Map<string, AbortController>();
	readonly #domNodes = new Map<string, ElementHandle>();
	readonly #latePageCleanups = new Set<Promise<void>>();
	#domSnapshotGeneration = 0;
	#downloadSession: CDPSession | undefined;
	#downloadSessionPromise: Promise<CDPSession> | undefined;
	#downloadWillBeginHandler: ((event: DownloadWillBeginEvent) => void) | undefined;
	#downloadProgressHandler: ((event: DownloadProgressEvent) => void) | undefined;
	#downloadPolicyOwnership: DownloadPolicyOwnership | undefined;
	#disposed = false;
	constructor(options: PuppeteerAdapterOptions) {
		this.#state = options.state ?? {
			currentTabId: options.currentTabId ?? "1",
			nextTabId: Number(options.currentTabId ?? "1") + 1,
			closed: false,
			sessionName: "",
			logs: [],
		};
		this.#page = options.page;
		this.#browser = options.browser;
		this.#signal = options.signal;
		this.#cwd = options.cwd;
		this.#captureScreenshot = options.captureScreenshot;
	}

	async beginRun(): Promise<void> {}

	async dispose(): Promise<void> {
		this.#disposed = true;
		this.#domSnapshotGeneration++;
		for (const controller of this.#navigationWaiters.values()) controller.abort();
		for (const waiter of [...this.#downloadWaiters]) waiter.reject(new Error("Puppeteer adapter was disposed"));
		void this.#downloadSessionPromise?.catch(() => undefined);
		const session = this.#downloadSession;
		if (session) {
			await this.#releaseDownloadSession(
				session,
				this.#downloadWillBeginHandler,
				this.#downloadProgressHandler,
				this.#downloadPolicyOwnership,
			);
		}
		for (const completion of this.#downloadCompletions.values()) {
			if (!completion.settled) {
				completion.settled = true;
				completion.resolve(null);
			}
		}
		this.#downloadWaiters.clear();
		this.#downloadCompletions.clear();
		this.#navigationWaiters.clear();
		for (const chooser of this.#fileChoosers.values()) cancelFileChooser(chooser);
		this.#fileChoosers.clear();
		this.#downloads.clear();
		const domHandles = [...this.#domNodes.values()];
		this.#domNodes.clear();
		await Promise.all(domHandles.map(handle => handle.dispose().catch(() => undefined)));
		const activePageCleanups = Promise.all([...this.#latePageCleanups]).then(() => undefined);
		await this.#waitForPageCleanup(activePageCleanups);
		this.#downloadSession = undefined;
		this.#downloadWillBeginHandler = undefined;
		this.#downloadProgressHandler = undefined;
		this.#downloadPolicyOwnership = undefined;
	}

	async invoke<T>(operation: CodexBrowserOperation, args: Readonly<Record<string, unknown>>): Promise<T> {
		this.#assertTab(operation, args);
		throwIfAborted(this.#signal);
		const result = await this.#dispatch(operation, args);
		throwIfAborted(this.#signal);
		return result as T;
	}

	async #dispatch(operation: CodexBrowserOperation, args: Readonly<Record<string, unknown>>): Promise<unknown> {
		switch (operation) {
			case "browser.nameSession":
				this.#state.sessionName = stringArg(args, "name");
				return undefined;
			case "browser.user.openTabs":
				return await this.#openTabs();
			case "browser.user.history":
				throw new BrowserCapabilityError(CODEX_BROWSER_CAPABILITIES.USER_HISTORY);
			case "tab.new":
				if (this.#state.closed) {
					this.#state.currentTabId = String(this.#state.nextTabId);
					this.#state.nextTabId += 1;
					this.#state.closed = false;
				}
				return await this.#summary();
			case "tab.selected":
				return this.#state.closed ? null : await this.#summary();
			case "tab.list":
				return this.#state.closed ? [] : [await this.#summary()];
			case "tab.get":
				return !this.#state.closed && args.id === this.currentTabId ? await this.#summary() : null;
			case "tabs.content":
				return await this.#tabsContent(args);
			case "tab.goto":
				await this.#navigate(() =>
					this.#page.goto(stringArg(args, "url"), { timeout: numberArg(args, "timeoutMs"), waitUntil: "load" }),
				);
				return undefined;
			case "tab.back":
				await this.#navigate(() => this.#page.goBack({ timeout: numberArg(args, "timeoutMs"), waitUntil: "load" }));
				return undefined;
			case "tab.forward":
				await this.#navigate(() =>
					this.#page.goForward({ timeout: numberArg(args, "timeoutMs"), waitUntil: "load" }),
				);
				return undefined;
			case "tab.reload":
				await this.#navigate(() => this.#page.reload({ timeout: numberArg(args, "timeoutMs"), waitUntil: "load" }));
				return undefined;
			case "tab.close":
				this.#state.closed = true;
				return undefined;
			case "tab.title":
				return await untilAborted(this.#signal, () => this.#page.title());
			case "tab.url":
				return this.#page.url();
			case "tab.content.export": {
				const destination = path.join(this.#cwd, `codex-content-${Snowflake.next()}.html`);
				await fs.promises.mkdir(path.dirname(destination), { recursive: true });
				await Bun.write(destination, await untilAborted(this.#signal, () => this.#page.content()));
				return destination;
			}
			case "tab.content.exportGsuite":
				throw new BrowserCapabilityError(CODEX_BROWSER_CAPABILITIES.CONTENT_EXPORT_GSUITE);
			case "tab.clipboard.read":
				return await this.#clipboardRead();
			case "tab.clipboard.readText":
				return await this.#clipboardReadText();
			case "tab.clipboard.write":
				await this.#clipboardWrite(args.items);
				return undefined;
			case "tab.clipboard.writeText":
				await this.#clipboardWriteText(stringArg(args, "text"));
				return undefined;
			case "tab.dev.logs":
				return this.#readLogs(args);
			case "playwright.domSnapshot":
				return await untilAborted(this.#signal, () => captureAriaSnapshot(this.#page, null));
			case "playwright.elementInfo":
				return await this.#elementInfo(args);
			case "playwright.elementScreenshot":
				return await this.#elementScreenshot(args);
			case "playwright.screenshot":
				return await this.#screenshot(args);
			case "playwright.waitForURL":
				await this.#waitForUrl(args);
				return undefined;
			case "playwright.waitForLoadState":
				await this.#waitForLoadState(args);
				return undefined;
			case "playwright.waitForTimeout":
				await untilAborted(this.#signal, () => Bun.sleep(numberArg(args, "timeoutMs")));
				return undefined;
			case "playwright.expectNavigation":
				await this.#expectNavigation(args);
				return undefined;
			case "playwright.expectNavigation.cancel":
				this.#navigationWaiters.get(stringArg(args, "navigationId"))?.abort();
				return undefined;
			case "playwright.waitForEvent":
				return await this.#waitForEvent(args);
			case "playwright.download.path":
				return await this.#downloadPath(args);
			case "playwright.fileChooser.setFiles":
				await this.#setFileChooserFiles(args);
				return undefined;
			case "locator.count":
				return await this.#withResolved(locatorArgs(args), "locator.count", handles => handles.length);
			case "locator.allTextContents":
				return await this.#withResolved(
					locatorArgs(args),
					"locator.allTextContents",
					async handles =>
						await Promise.all(handles.map(handle => handle.evaluate(element => element.textContent ?? ""))),
				);
			case "locator.click":
				await this.#locatorClick(args, false);
				return undefined;
			case "locator.dblclick":
				await this.#locatorClick(args, true);
				return undefined;
			case "locator.downloadMedia":
				await this.#downloadLocatorMedia(args);
				return undefined;
			case "locator.fill":
				await this.#withActionHandle(
					locatorArgs(args),
					"locator.fill",
					async (handle, deadline) =>
						await this.#setEditableValue(handle, stringArg(args, "value"), false, deadline),
					{ visible: true, enabled: true },
				);
				return undefined;
			case "locator.type":
				await this.#withActionHandle(
					locatorArgs(args),
					"locator.type",
					async (handle, deadline) =>
						await this.#setEditableValue(handle, stringArg(args, "value"), true, deadline),
					{ visible: true, enabled: true },
				);
				return undefined;
			case "locator.press":
				await this.#withActionHandle(
					locatorArgs(args),
					"locator.press",
					async handle => {
						await handle.focus();
						await this.#page.keyboard.press(stringArg(args, "value") as KeyInput);
					},
					{ visible: true, enabled: true },
				);
				return undefined;
			case "locator.selectOption":
				return await this.#selectOption(args);
			case "locator.setChecked":
				await this.#setChecked(args);
				return undefined;
			case "locator.getAttribute":
				return await this.#withActionHandle(
					locatorArgs(args),
					"locator.getAttribute",
					async handle =>
						await handle.evaluate((element, name) => element.getAttribute(name), stringArg(args, "name")),
				);
			case "locator.innerText":
				return await this.#withActionHandle(
					locatorArgs(args),
					"locator.innerText",
					async handle =>
						await handle.evaluate(element => {
							const readable = element as unknown as { innerText: string };
							return readable.innerText;
						}),
				);
			case "locator.textContent":
				return await this.#withActionHandle(
					locatorArgs(args),
					"locator.textContent",
					async handle => await handle.evaluate(element => element.textContent),
				);
			case "locator.isEnabled":
				return await this.#withResolved(locatorArgs(args), "locator.isEnabled", async handles => {
					const first = handles[0];
					return first ? await this.#isEnabled(first) : false;
				});
			case "locator.isVisible":
				return await this.#withResolved(locatorArgs(args), "locator.isVisible", async handles => {
					const first = handles[0];
					return first ? await this.#isVisible(first) : false;
				});
			case "locator.waitFor":
				await this.#waitForLocator(args);
				return undefined;
			case "dom_cua.get_visible_dom":
				return await this.#visibleDom(args);
			case "dom_cua.click":
				await this.#domClick(args, false);
				return undefined;
			case "dom_cua.double_click":
				await this.#domClick(args, true);
				return undefined;
			case "dom_cua.scroll":
				await this.#domScroll(args);
				return undefined;
			case "dom_cua.type":
				await this.#typeIntoActiveElement(stringArg(args, "text"), "dom_cua.type");
				return undefined;
			case "dom_cua.keypress":
				await this.#pressKeys(args.keys);
				return undefined;
			case "dom_cua.downloadMedia":
				await this.#downloadDomMedia(args);
				return undefined;
			case "cua.get_visible_screenshot":
				return { data: await this.#screenshot({ tabId: this.currentTabId }) };
			case "cua.click":
				await this.#pressKeys(args.keypress);
				await this.#page.mouse.click(numberArg(args, "x"), numberArg(args, "y"), {
					button: this.#mouseButton(args.button),
				});
				return undefined;
			case "cua.double_click":
				await this.#pressKeys(args.keypress);
				await this.#page.mouse.click(numberArg(args, "x"), numberArg(args, "y"), { count: 2 });
				return undefined;
			case "cua.drag":
				await this.#coordinateDrag(args);
				return undefined;
			case "cua.keypress":
				await this.#pressKeys(args.keys);
				return undefined;
			case "cua.move":
				await this.#pressKeys(args.keys);
				await this.#page.mouse.move(numberArg(args, "x"), numberArg(args, "y"));
				return undefined;
			case "cua.scroll":
				await this.#pressKeys(args.keypress);
				await this.#page.mouse.move(numberArg(args, "x"), numberArg(args, "y"));
				await this.#page.mouse.wheel({ deltaX: numberArg(args, "scrollX"), deltaY: numberArg(args, "scrollY") });
				return undefined;
			case "cua.type":
				await this.#typeIntoActiveElement(stringArg(args, "text"), "cua.type");
				return undefined;
			case "cua.downloadMedia":
				await this.#downloadPointMedia(args);
				return undefined;
		}
	}

	#assertTab(operation: CodexBrowserOperation, args: Readonly<Record<string, unknown>>): void {
		if (operation === "tab.get" || args.tabId === undefined) return;
		if (args.tabId !== this.currentTabId) {
			throw new Error(`Browser tab id ${String(args.tabId)} is stale; current tab id is ${this.currentTabId}`);
		}
		if (this.#state.closed) throw new Error(`Browser tab id ${this.currentTabId} is closed`);
	}

	async #summary(): Promise<CodexTabSummary> {
		return { id: this.currentTabId, url: this.#page.url(), title: await this.#page.title() };
	}

	async #openTabs(): Promise<unknown[]> {
		const pages = await this.#browser.pages();
		return await Promise.all(
			pages.map(async page => ({ url: page.url(), title: await page.title().catch(() => "") })),
		);
	}

	async #navigate<T>(action: () => Promise<T>): Promise<void> {
		await untilAborted(this.#signal, action);
	}

	async #tabsContent(args: Readonly<Record<string, unknown>>): Promise<unknown[]> {
		const urls = args.urls as string[];
		const contentType = stringArg(args, "contentType");
		const timeoutMs = numberArg(args, "timeoutMs");
		const output: Array<{ url: string; title: string | null; content: string | null }> = [];
		for (const url of urls) {
			throwIfAborted(this.#signal);
			const deadline = Date.now() + timeoutMs;
			let page = this.#page;
			let temporary = false;
			try {
				if (url !== this.#page.url()) {
					page = await this.#acquireTemporaryPage(deadline, url);
					temporary = true;
					await this.#runBeforeTabsContentDeadline(deadline, url, () =>
						page.goto(url, {
							timeout: this.#tabsContentRemaining(deadline, url),
							waitUntil: "load",
						}),
					);
				}
				let title: string | null = null;
				try {
					title = await this.#runBeforeTabsContentDeadline(deadline, url, () => page.title());
				} catch (error) {
					throwIfAborted(this.#signal);
					if (error instanceof TabsContentTimeoutError) throw error;
				}
				let content: string;
				if (contentType === "text") {
					content = await this.#runBeforeTabsContentDeadline(deadline, url, () =>
						page.evaluate(() => {
							const root = globalThis as unknown as { document: { body?: { innerText: string } } };
							return root.document.body?.innerText ?? "";
						}),
					);
				} else if (contentType === "domSnapshot") {
					content = await this.#runBeforeTabsContentDeadline(deadline, url, () => captureAriaSnapshot(page, null));
				} else {
					content = await this.#runBeforeTabsContentDeadline(deadline, url, () => page.content());
				}
				this.#tabsContentRemaining(deadline, url);
				output.push({ url: page.url(), title, content });
			} catch {
				throwIfAborted(this.#signal);
				output.push({ url, title: null, content: null });
			} finally {
				if (temporary) {
					const cleanup = this.#startPageCleanup(page);
					await this.#waitForPageCleanup(cleanup);
				}
			}
		}
		return output;
	}

	async #acquireTemporaryPage(deadline: number, url: string): Promise<Page> {
		const creation = this.#browser.newPage();
		try {
			return await this.#runBeforeTabsContentDeadline(deadline, url, () => creation);
		} catch (error) {
			void creation.then(page => this.#startPageCleanup(page)).catch(() => undefined);
			throw error;
		}
	}

	#startPageCleanup(page: Page): Promise<void> {
		const cleanup = page.close().catch(() => undefined);
		this.#latePageCleanups.add(cleanup);
		cleanup.finally(() => this.#latePageCleanups.delete(cleanup)).catch(() => undefined);
		return cleanup;
	}

	async #waitForPageCleanup(cleanup: Promise<void>): Promise<void> {
		const timeout = Promise.withResolvers<void>();
		const timer = setTimeout(timeout.resolve, TEMPORARY_PAGE_CLEANUP_TIMEOUT_MS);
		timer.unref();
		try {
			await Promise.race([cleanup, timeout.promise]);
		} finally {
			clearTimeout(timer);
		}
	}

	async #clipboardRead(): Promise<unknown[]> {
		const result = await this.#page.evaluate(async () => {
			const root = globalThis as unknown as {
				navigator: {
					clipboard?: {
						read?: () => Promise<
							Array<{
								types: string[];
								getType(
									type: string,
								): Promise<{ text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> }>;
								presentationStyle?: "unspecified" | "inline" | "attachment";
							}>
						>;
					};
				};
				btoa(value: string): string;
			};
			if (typeof root.navigator.clipboard?.read !== "function") return { supported: false as const, items: [] };
			const items = await root.navigator.clipboard.read();
			return {
				supported: true as const,
				items: await Promise.all(
					items.map(async item => ({
						entries: await Promise.all(
							item.types.map(async mimeType => {
								const blob = await item.getType(mimeType);
								if (mimeType.startsWith("text/")) return { mimeType, text: await blob.text() };
								const bytes = new Uint8Array(await blob.arrayBuffer());
								let binary = "";
								for (const byte of bytes) binary += String.fromCharCode(byte);
								return { mimeType, base64: root.btoa(binary) };
							}),
						),
						presentationStyle: item.presentationStyle,
					})),
				),
			};
		});
		if (!result.supported) throw new BrowserCapabilityError(CODEX_BROWSER_CAPABILITIES.CLIPBOARD_READ);
		return result.items;
	}

	async #clipboardReadText(): Promise<string> {
		const result = await this.#page.evaluate(async () => {
			const root = globalThis as unknown as {
				navigator: { clipboard?: { readText?: () => Promise<string> } };
			};
			if (typeof root.navigator.clipboard?.readText !== "function") return { supported: false as const };
			return { supported: true as const, value: await root.navigator.clipboard.readText() };
		});
		if (!result.supported) throw new BrowserCapabilityError(CODEX_BROWSER_CAPABILITIES.CLIPBOARD_READ_TEXT);
		return result.value;
	}

	async #clipboardWriteText(text: string): Promise<void> {
		const supported = await this.#page.evaluate(async value => {
			const root = globalThis as unknown as {
				navigator: { clipboard?: { writeText?: (text: string) => Promise<void> } };
			};
			if (typeof root.navigator.clipboard?.writeText !== "function") return false;
			await root.navigator.clipboard.writeText(value);
			return true;
		}, text);
		if (!supported) throw new BrowserCapabilityError(CODEX_BROWSER_CAPABILITIES.CLIPBOARD_WRITE_TEXT);
	}

	async #clipboardWrite(rawItems: unknown): Promise<void> {
		const supported = await this.#page.evaluate(async items => {
			const values = items as Array<{
				entries: Array<{ mimeType: string; text?: string; base64?: string }>;
				presentationStyle?: "unspecified" | "inline" | "attachment";
			}>;
			const root = globalThis as unknown as {
				navigator: { clipboard?: { write?: (items: unknown[]) => Promise<void> } };
				Blob: new (parts: unknown[], options: { type: string }) => unknown;
				ClipboardItem?: new (
					data: Record<string, unknown>,
					options: { presentationStyle?: "unspecified" | "inline" | "attachment" },
				) => unknown;
				atob(value: string): string;
			};
			const ClipboardItemCtor = root.ClipboardItem;
			if (typeof root.navigator.clipboard?.write !== "function" || !ClipboardItemCtor) return false;
			const clipboardItems = values.map(item => {
				const data: Record<string, unknown> = {};
				for (const entry of item.entries) {
					if (entry.text !== undefined)
						data[entry.mimeType] = new root.Blob([entry.text], { type: entry.mimeType });
					else if (entry.base64 !== undefined) {
						const binary = root.atob(entry.base64);
						const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
						data[entry.mimeType] = new root.Blob([bytes], { type: entry.mimeType });
					}
				}
				return new ClipboardItemCtor(data, { presentationStyle: item.presentationStyle });
			});
			await root.navigator.clipboard.write(clipboardItems);
			return true;
		}, rawItems);
		if (!supported) throw new BrowserCapabilityError(CODEX_BROWSER_CAPABILITIES.CLIPBOARD_WRITE);
	}

	#readLogs(args: Readonly<Record<string, unknown>>): BrowserLogEntry[] {
		const filter = typeof args.filter === "string" ? args.filter : undefined;
		const levels = Array.isArray(args.levels) ? new Set(args.levels as string[]) : undefined;
		const limit = typeof args.limit === "number" ? args.limit : undefined;
		let logs = this.#state.logs.filter(
			entry => (!filter || entry.text.includes(filter)) && (!levels || levels.has(entry.level)),
		);
		if (limit !== undefined) logs = logs.slice(-limit);
		return logs.map(entry => ({ ...entry }));
	}

	async #elementInfo(args: Readonly<Record<string, unknown>>): Promise<unknown> {
		return await this.#page.evaluate(
			(x, y, includeNonInteractable) => {
				interface PageElement {
					getAttribute(name: string): string | null;
					getBoundingClientRect(): { x: number; y: number; width: number; height: number };
					hasAttribute(name: string): boolean;
					isContentEditable?: boolean;
					labels?: ArrayLike<PageElement>;
					outerHTML: string;
					parentElement: PageElement | null;
					tabIndex?: number;
					tagName: string;
					textContent: string | null;
					value?: string;
				}
				const root = globalThis as unknown as {
					document: {
						elementFromPoint(x: number, y: number): PageElement | null;
						getElementById(id: string): PageElement | null;
					};
					getComputedStyle(element: PageElement): { display: string; visibility: string };
				};
				const textOf = (element: PageElement): string => (element.textContent ?? "").replace(/\s+/g, " ").trim();
				const documentRoot = root.document;
				const implicitRole = (element: PageElement): string | null => {
					const explicit = element.getAttribute("role")?.trim().split(/\s+/)[0];
					if (explicit) return explicit;
					const tag = element.tagName.toLowerCase();
					if (tag === "button") return "button";
					if ((tag === "a" || tag === "area") && element.hasAttribute("href")) return "link";
					if (/^h[1-6]$/.test(tag)) return "heading";
					if (tag === "textarea") return "textbox";
					if (tag === "select") {
						return element.hasAttribute("multiple") || Number(element.getAttribute("size") ?? "0") > 1
							? "listbox"
							: "combobox";
					}
					if (tag === "option") return "option";
					if (tag === "img") return element.getAttribute("alt") === "" ? null : "img";
					if (tag !== "input") return null;
					const rawType = (element.getAttribute("type") ?? "text").toLowerCase();
					const type = [
						"button",
						"checkbox",
						"color",
						"date",
						"datetime-local",
						"email",
						"file",
						"hidden",
						"image",
						"month",
						"number",
						"password",
						"radio",
						"range",
						"reset",
						"search",
						"submit",
						"tel",
						"text",
						"time",
						"url",
						"week",
					].includes(rawType)
						? rawType
						: "text";
					if (["button", "submit", "reset", "image"].includes(type)) return "button";
					if (type === "checkbox") return "checkbox";
					if (type === "radio") return "radio";
					if (type === "range") return "slider";
					if (type === "number") return "spinbutton";
					if (["search", "text", "email", "tel", "url"].includes(type))
						return element.hasAttribute("list") ? "combobox" : type === "search" ? "searchbox" : "textbox";
					return null;
				};
				const accessibleName = (element: PageElement): string => {
					const labelledBy = element.getAttribute("aria-labelledby");
					if (labelledBy) {
						const label = labelledBy
							.split(/\s+/)
							.map((id: string) => documentRoot.getElementById(id))
							.filter((item: PageElement | null): item is PageElement => item !== null)
							.map(textOf)
							.join(" ")
							.trim();
						if (label) return label;
					}
					const aria = element.getAttribute("aria-label")?.trim();
					if (aria) return aria;
					const labelled = element;
					if (labelled.labels?.length) {
						const nativeLabel = Array.from(labelled.labels).map(textOf).join(" ").trim();
						if (nativeLabel) return nativeLabel;
					}
					const tag = element.tagName.toLowerCase();
					const type = (element.getAttribute("type") ?? "text").toLowerCase();
					const valueName =
						tag === "input" && ["button", "submit", "reset", "image"].includes(type) ? (element.value ?? "") : "";
					const fallback = element.getAttribute("alt") ?? element.getAttribute("title") ?? valueName;
					return fallback.trim() || textOf(element);
				};
				const interactable = (element: PageElement): boolean => {
					const tag = element.tagName.toLowerCase();
					const role = implicitRole(element);
					const interactiveRoles = [
						"button",
						"checkbox",
						"combobox",
						"link",
						"listbox",
						"menuitem",
						"menuitemcheckbox",
						"menuitemradio",
						"option",
						"radio",
						"searchbox",
						"slider",
						"spinbutton",
						"switch",
						"tab",
						"textbox",
						"treeitem",
					];
					const focusable = element;
					return (
						(tag === "input" && (element.getAttribute("type") ?? "text").toLowerCase() !== "hidden") ||
						tag === "button" ||
						tag === "select" ||
						tag === "textarea" ||
						((tag === "a" || tag === "area") && element.hasAttribute("href")) ||
						(role !== null && interactiveRoles.includes(role)) ||
						element.hasAttribute("tabindex") ||
						(focusable.tabIndex ?? -1) >= 0 ||
						focusable.isContentEditable === true
					);
				};
				const accessibilityHidden = (element: PageElement): boolean => {
					for (let current: PageElement | null = element; current; current = current.parentElement) {
						const style = root.getComputedStyle(current);
						if (
							current.hasAttribute("hidden") ||
							current.hasAttribute("inert") ||
							current.getAttribute("aria-hidden")?.toLowerCase() === "true" ||
							style.display === "none" ||
							style.visibility === "hidden"
						)
							return true;
					}
					return false;
				};
				let element = documentRoot.elementFromPoint(x, y);
				if (!includeNonInteractable)
					while (element && (!interactable(element) || accessibilityHidden(element)))
						element = element.parentElement;
				if (!element || accessibilityHidden(element)) return [];
				const rect = element.getBoundingClientRect();
				const visibleText = textOf(element) || null;
				const ariaName = accessibleName(element) || null;
				const testId = element.getAttribute("data-testid");
				const id = element.getAttribute("id");
				const escapeSelector = (value: string) =>
					value.replace(/[^a-zA-Z0-9_-]/g, (character: string) => `\\${character}`);
				const primary = testId ? `[data-testid="${escapeSelector(testId)}"]` : id ? `#${escapeSelector(id)}` : null;
				const candidates = [primary, element.tagName.toLowerCase()].filter(
					(value: string | null): value is string => value !== null,
				);
				return [
					{
						tagName: element.tagName.toLowerCase(),
						role: implicitRole(element),
						visibleText,
						ariaName,
						testId,
						boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
						preview: element.outerHTML.slice(0, 500),
						selector: { primary, candidates },
					},
				];
			},
			numberArg(args, "x"),
			numberArg(args, "y"),
			args.includeNonInteractable === true,
		);
	}

	async #elementScreenshot(args: Readonly<Record<string, unknown>>): Promise<string> {
		const handle = await this.#page.evaluateHandle(
			(x, y) => document.elementFromPoint(x, y),
			numberArg(args, "x"),
			numberArg(args, "y"),
		);
		const element = handle.asElement();
		if (!element) {
			await handle.dispose();
			throw new Error("playwright.elementScreenshot found no element at the point");
		}
		try {
			const bytes = await element.screenshot({ type: "png" });
			return Buffer.from(bytes).toString("base64");
		} finally {
			await element.dispose();
		}
	}

	async #screenshot(args: Readonly<Record<string, unknown>>): Promise<string> {
		if (args.clip === undefined) {
			return await this.#captureScreenshot({
				fullPage: typeof args.fullPage === "boolean" ? args.fullPage : undefined,
			});
		}
		const options: {
			type: "png";
			encoding: "base64";
			fullPage?: boolean;
			clip?: { x: number; y: number; width: number; height: number };
		} = {
			type: "png",
			encoding: "base64",
		};
		if (typeof args.fullPage === "boolean") options.fullPage = args.fullPage;
		if (args.clip && typeof args.clip === "object")
			options.clip = args.clip as { x: number; y: number; width: number; height: number };
		const bytes = await untilAborted(this.#signal, () => this.#page.screenshot(options));
		return typeof bytes === "string" ? bytes : Buffer.from(bytes).toString("base64");
	}

	async #waitForUrl(args: Readonly<Record<string, unknown>>): Promise<void> {
		const pattern = args.url as CodexTextPattern;
		const timeoutMs = numberArg(args, "timeoutMs");
		const deadline = Date.now() + timeoutMs;
		await untilAborted(this.#signal, () =>
			this.#page.waitForFunction(
				(source, flags, value, exact) => {
					const root = globalThis as unknown as { location: { href: string } };
					const href = root.location.href;
					return source !== null
						? new RegExp(source, flags).test(href)
						: exact
							? href === value
							: href.includes(value);
				},
				{ timeout: this.#remaining(deadline, "playwright.waitForURL"), polling: 100, signal: this.#signal },
				pattern.kind === "regexp" ? pattern.source : null,
				pattern.kind === "regexp" ? pattern.flags : "",
				pattern.kind === "string" ? pattern.value : "",
				pattern.kind === "string" && pattern.exact === true,
			),
		);
		await this.#waitForLoadStateValue(loadState(args.waitUntil), deadline, "playwright.waitForURL");
	}

	async #waitForLoadState(args: Readonly<Record<string, unknown>>): Promise<void> {
		const timeoutMs = numberArg(args, "timeoutMs");
		await this.#waitForLoadStateValue(loadState(args.state), Date.now() + timeoutMs, "playwright.waitForLoadState");
	}

	async #waitForLoadStateValue(state: CodexLoadState, deadline: number, label: string): Promise<void> {
		if (state === "networkidle") {
			await untilAborted(this.#signal, () =>
				this.#page.waitForNetworkIdle({
					timeout: this.#remaining(deadline, label),
					idleTime: 500,
					concurrency: 0,
				}),
			);
			return;
		}
		const readyState = state === "domcontentloaded" ? "interactive" : "complete";
		await untilAborted(this.#signal, () =>
			this.#page.waitForFunction(
				expected => {
					const root = globalThis as unknown as { document: { readyState: string } };
					return (
						root.document.readyState === expected ||
						(expected === "interactive" && root.document.readyState === "complete")
					);
				},
				{ timeout: this.#remaining(deadline, label), polling: 100, signal: this.#signal },
				readyState,
			),
		);
	}

	#remaining(deadline: number, label: string): number {
		const remaining = deadline - Date.now();
		if (remaining <= 0) throw new Error(`${label} timed out`);
		return remaining;
	}

	#operationDeadline(timeoutMs: number | undefined, label: string): OperationDeadline {
		const boundedTimeout = timeoutMs ?? 3_000;
		return { label, timeoutMs: boundedTimeout, expiresAt: Date.now() + boundedTimeout };
	}

	#operationRemaining(deadline: OperationDeadline): number {
		const remaining = deadline.expiresAt - Date.now();
		if (remaining <= 0) throw new Error(`${deadline.label} timed out after ${deadline.timeoutMs}ms`);
		return remaining;
	}

	async #runBeforeDeadline<T>(
		deadline: OperationDeadline,
		action: () => T | Promise<T>,
		onAbandon?: () => void | Promise<void>,
	): Promise<T> {
		let abandoned = false;
		const abandon = () => {
			if (abandoned) return;
			abandoned = true;
			if (onAbandon)
				void Promise.resolve()
					.then(onAbandon)
					.catch(() => undefined);
		};
		let remaining: number;
		try {
			remaining = this.#operationRemaining(deadline);
		} catch (error) {
			abandon();
			throw error;
		}
		const operation = Promise.resolve().then(action);
		const timeout = Promise.withResolvers<never>();
		const timer = setTimeout(() => {
			abandon();
			timeout.reject(new Error(`${deadline.label} timed out after ${deadline.timeoutMs}ms`));
		}, remaining);
		timer.unref();
		try {
			return await untilAborted(this.#signal, () => Promise.race([operation, timeout.promise]));
		} catch (error) {
			if (this.#signal.aborted) abandon();
			throw error;
		} finally {
			clearTimeout(timer);
		}
	}

	async #disposeHandlesBeforeDeadline(
		handles: ReadonlyArray<{ dispose(): Promise<void> }>,
		deadline: OperationDeadline,
	): Promise<void> {
		const cleanup = Promise.all(handles.map(handle => handle.dispose().catch(() => undefined))).then(() => undefined);
		const remaining = deadline.expiresAt - Date.now();
		if (remaining <= 0) {
			void cleanup;
			return;
		}
		const elapsed = Promise.withResolvers<void>();
		const timer = setTimeout(elapsed.resolve, remaining);
		timer.unref();
		try {
			await Promise.race([cleanup, elapsed.promise]);
		} finally {
			clearTimeout(timer);
		}
	}

	#tabsContentRemaining(deadline: number, url: string): number {
		const remaining = deadline - Date.now();
		if (remaining <= 0) throw new TabsContentTimeoutError(`tabs.content timed out for ${url}`);
		return remaining;
	}

	async #runBeforeTabsContentDeadline<T>(deadline: number, url: string, action: () => Promise<T>): Promise<T> {
		const remaining = this.#tabsContentRemaining(deadline, url);
		const timeout = Promise.withResolvers<never>();
		const timer = setTimeout(
			() => timeout.reject(new TabsContentTimeoutError(`tabs.content timed out for ${url}`)),
			remaining,
		);
		timer.unref();
		try {
			return await untilAborted(this.#signal, () => Promise.race([action(), timeout.promise]));
		} finally {
			clearTimeout(timer);
		}
	}

	async #expectNavigation(args: Readonly<Record<string, unknown>>): Promise<void> {
		const navigationId = stringArg(args, "navigationId");
		const controller = new AbortController();
		this.#navigationWaiters.set(navigationId, controller);
		const signal = AbortSignal.any([this.#signal, controller.signal]);
		const timeoutMs = numberArg(args, "timeoutMs");
		const deadline = Date.now() + timeoutMs;
		const state = loadState(args.waitUntil);
		let abortListener: (() => void) | undefined;
		try {
			const navigation = this.#page.waitForNavigation({
				timeout: this.#remaining(deadline, "playwright.expectNavigation"),
				waitUntil: state === "networkidle" ? "load" : state,
				signal,
			});
			const canceled = Promise.withResolvers<never>();
			abortListener = () => canceled.reject(signal.reason ?? new Error("playwright.expectNavigation canceled"));
			signal.addEventListener("abort", abortListener, { once: true });
			if (signal.aborted) abortListener();
			await Promise.race([navigation, canceled.promise]);
			if (state === "networkidle") {
				await untilAborted(signal, () =>
					this.#page.waitForNetworkIdle({
						timeout: this.#remaining(deadline, "playwright.expectNavigation"),
						idleTime: 500,
						concurrency: 0,
					}),
				);
			}
			if (args.url !== undefined && !patternMatches(this.#page.url(), args.url as CodexTextPattern)) {
				throw new Error(`playwright.expectNavigation reached unexpected URL ${this.#page.url()}`);
			}
		} finally {
			if (abortListener) signal.removeEventListener("abort", abortListener);
			if (this.#navigationWaiters.get(navigationId) === controller) this.#navigationWaiters.delete(navigationId);
		}
	}

	async #waitForEvent(args: Readonly<Record<string, unknown>>): Promise<{ token: string; multiple?: boolean }> {
		const event = stringArg(args, "event");
		const timeoutMs = numberArg(args, "timeoutMs");
		if (event === "download") return await this.#waitForDownload(timeoutMs);
		const waiting = this.#page.waitForFileChooser({ timeout: timeoutMs, signal: this.#signal });
		let chooser: FileChooser;
		try {
			chooser = await untilAborted(this.#signal, () => waiting);
			throwIfAborted(this.#signal);
			if (this.#disposed) throw new Error("Puppeteer adapter was disposed");
		} catch (error) {
			void waiting.then(cancelFileChooser, () => undefined);
			throw error;
		}
		const token = `filechooser-${Snowflake.next()}`;
		this.#fileChoosers.set(token, chooser);
		return { token, multiple: chooser.isMultiple() };
	}

	async #waitForDownload(timeoutMs: number): Promise<{ token: string }> {
		let rejectWaiter!: (reason: unknown) => void;
		const downloadPromise = new Promise<DownloadRecord>((resolve, reject) => {
			let settled = false;
			const timer = setTimeout(
				() => finish(() => reject(new Error(`playwright.waitForEvent timed out after ${timeoutMs}ms`))),
				timeoutMs,
			);
			timer.unref();
			const aborted = () => finish(() => reject(this.#signal.reason));
			const waiter: DownloadWaiter = {
				resolve: value => finish(() => resolve(value)),
				reject: reason => finish(() => reject(reason)),
			};
			rejectWaiter = waiter.reject;
			const finish = (settle: () => void) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				this.#signal.removeEventListener("abort", aborted);
				this.#downloadWaiters.delete(waiter);
				settle();
			};
			this.#signal.addEventListener("abort", aborted, { once: true });
			this.#downloadWaiters.add(waiter);
			if (this.#signal.aborted) aborted();
		});
		void this.#ensureDownloadSession().catch(error => rejectWaiter(error));
		const download = await downloadPromise;
		const token = `download-${Snowflake.next()}`;
		this.#downloads.set(token, download);
		return { token };
	}

	async #ensureDownloadSession(): Promise<CDPSession> {
		if (this.#disposed) throw new Error("Puppeteer adapter was disposed");
		if (this.#downloadSession) return this.#downloadSession;
		let setup = this.#downloadSessionPromise;
		if (!setup) {
			setup = this.#initializeDownloadSession();
			this.#downloadSessionPromise = setup;
			setup.catch(() => {
				if (this.#downloadSessionPromise === setup) this.#downloadSessionPromise = undefined;
			});
		}
		return await setup;
	}

	#activeDownloadFrameIds(): Set<string> | undefined {
		const page = this.#page as unknown as {
			frames?: () => Array<{ _id?: unknown }>;
			mainFrame?: () => { _id?: unknown };
		};
		let frames: Array<{ _id?: unknown }>;
		try {
			if (typeof page.frames === "function") frames = page.frames();
			else if (typeof page.mainFrame === "function") frames = [page.mainFrame()];
			else return undefined;
		} catch {
			return new Set();
		}
		const ids = new Set<string>();
		for (const frame of frames) {
			if (typeof frame._id === "string") ids.add(frame._id);
		}
		return ids;
	}

	async #releaseDownloadSession(
		session: CDPSession,
		began: ((event: DownloadWillBeginEvent) => void) | undefined,
		progressed: ((event: DownloadProgressEvent) => void) | undefined,
		ownership: DownloadPolicyOwnership | undefined,
	): Promise<void> {
		if (began) session.off("Browser.downloadWillBegin", began);
		if (progressed) session.off("Browser.downloadProgress", progressed);
		if (ownership) await releaseDownloadPolicy(ownership, session).catch(() => undefined);
		await session.detach().catch(() => undefined);
	}

	async #initializeDownloadSession(): Promise<CDPSession> {
		const targetFactory = (this.#browser as unknown as { target?: () => unknown }).target;
		if (typeof targetFactory !== "function") {
			throw new BrowserCapabilityError(CODEX_BROWSER_CAPABILITIES.WAIT_FOR_EVENT);
		}
		const target = targetFactory.call(this.#browser);
		const createSession = (target as { createCDPSession?: () => Promise<CDPSession> }).createCDPSession;
		if (typeof createSession !== "function") {
			throw new BrowserCapabilityError(CODEX_BROWSER_CAPABILITIES.WAIT_FOR_EVENT);
		}
		const session = await createSession.call(target);
		let ownership: DownloadPolicyOwnership | undefined;
		let began: ((event: DownloadWillBeginEvent) => void) | undefined;
		let progressed: ((event: DownloadProgressEvent) => void) | undefined;
		try {
			ownership = await acquireDownloadPolicy(this.#browser, this.#cwd, session);
			const directory = ownership.coordinator.directory;
			began = (event: DownloadWillBeginEvent) => {
				const frameIds = this.#activeDownloadFrameIds();
				if (frameIds && (typeof event.frameId !== "string" || !frameIds.has(event.frameId))) return;
				let completion = this.#downloadCompletions.get(event.guid);
				if (!completion) {
					const filename = path.basename(event.suggestedFilename) || `download-${event.guid}`;
					const destination = path.join(directory, filename);
					let resolveCompletion!: (value: string | null) => void;
					const completionPromise = new Promise<string | null>(resolve => {
						resolveCompletion = resolve;
					});
					completion = {
						path: destination,
						download: { filename, completion: completionPromise },
						resolve: resolveCompletion,
						settled: false,
					};
					this.#downloadCompletions.set(event.guid, completion);
				}
				for (const waiter of [...this.#downloadWaiters]) waiter.resolve(completion.download);
			};
			progressed = (event: DownloadProgressEvent) => {
				if (event.state === "inProgress") return;
				const completion = this.#downloadCompletions.get(event.guid);
				if (!completion || completion.settled) return;
				completion.settled = true;
				completion.resolve(event.state === "completed" ? completion.path : null);
			};
			session.on("Browser.downloadWillBegin", began);
			session.on("Browser.downloadProgress", progressed);
			if (this.#disposed) throw new Error("Puppeteer adapter was disposed");
			this.#downloadWillBeginHandler = began;
			this.#downloadProgressHandler = progressed;
			this.#downloadPolicyOwnership = ownership;
			this.#downloadSession = session;
			return session;
		} catch (error) {
			await this.#releaseDownloadSession(session, began, progressed, ownership);
			throw error;
		}
	}

	async #downloadPath(args: Readonly<Record<string, unknown>>): Promise<string | null> {
		const token = stringArg(args, "token");
		const download = this.#downloads.get(token);
		if (!download) throw new Error("Download is no longer available");
		const timeoutMs = numberArg(args, "timeoutMs");
		return await new Promise<string | null>((resolve, reject) => {
			const timer = setTimeout(
				() => finish(() => reject(new Error(`download.path timed out after ${timeoutMs}ms`))),
				timeoutMs,
			);
			timer.unref();
			const aborted = () => finish(() => reject(this.#signal.reason));
			const finish = (settle: () => void) => {
				clearTimeout(timer);
				this.#signal.removeEventListener("abort", aborted);
				settle();
			};
			this.#signal.addEventListener("abort", aborted, { once: true });
			download.completion.then(
				value => finish(() => resolve(value)),
				error => finish(() => reject(error)),
			);
			if (this.#signal.aborted) aborted();
		});
	}

	async #setFileChooserFiles(args: Readonly<Record<string, unknown>>): Promise<void> {
		const token = stringArg(args, "token");
		const chooser = this.#fileChoosers.get(token);
		if (!chooser) throw new Error("File chooser is no longer available");
		this.#fileChoosers.delete(token);
		const files = (args.files as string[]).map(file => resolveToCwd(file, this.#cwd));
		const deadline = this.#operationDeadline(
			typeof args.timeoutMs === "number" ? args.timeoutMs : undefined,
			"playwright.fileChooser.setFiles",
		);
		await this.#runBeforeDeadline(
			deadline,
			() => chooser.accept(files),
			() => cancelFileChooser(chooser),
		);
	}

	async #withResolved<T>(
		args: LocatorArgs,
		label: string,
		fn: (handles: ElementHandle[]) => T | Promise<T>,
	): Promise<T> {
		const deadline = this.#operationDeadline(args.timeoutMs, label);
		const handles = await this.#resolve(args.locator, deadline);
		try {
			return await this.#runBeforeDeadline(deadline, () => fn(handles));
		} finally {
			await this.#disposeHandlesBeforeDeadline(handles, deadline);
		}
	}

	async #withActionHandle<T>(
		args: LocatorArgs,
		label: string,
		fn: (handle: ElementHandle, deadline: OperationDeadline) => T | Promise<T>,
		actionability: ActionabilityOptions = {},
		boundAction = true,
		onAbandon?: () => void | Promise<void>,
	): Promise<T> {
		const deadline = this.#operationDeadline(args.timeoutMs, label);
		const requiresActionability =
			actionability.visible === true ||
			actionability.enabled === true ||
			actionability.receivesPointerEvents === true;
		for (;;) {
			throwIfAborted(this.#signal);
			if (deadline.expiresAt <= Date.now() && requiresActionability) {
				throw new Error(`${label} timed out after ${deadline.timeoutMs}ms before becoming actionable`);
			}
			this.#operationRemaining(deadline);
			const handles = await this.#resolve(args.locator, deadline);
			const first = handles.shift();
			await this.#disposeHandlesBeforeDeadline(handles, deadline);
			if (first) {
				try {
					const visible =
						actionability.visible !== true ||
						(await this.#runBeforeDeadline(deadline, () => this.#isVisible(first)));
					const enabled =
						actionability.enabled !== true ||
						(await this.#runBeforeDeadline(deadline, () => this.#isEnabled(first)));
					const receivesPointerEvents =
						actionability.receivesPointerEvents !== true ||
						(await this.#runBeforeDeadline(deadline, () => this.#receivesPointerEvents(first)));
					if (visible && enabled && receivesPointerEvents) {
						const action = Promise.resolve(fn(first, deadline));
						return boundAction ? await this.#runBeforeDeadline(deadline, () => action, onAbandon) : await action;
					}
				} finally {
					await this.#disposeHandlesBeforeDeadline([first], deadline);
				}
			}
			if (deadline.expiresAt <= Date.now() && requiresActionability) {
				throw new Error(`${label} timed out after ${deadline.timeoutMs}ms before becoming actionable`);
			}
			const remainingMs = this.#operationRemaining(deadline);
			await this.#runBeforeDeadline(deadline, () => Bun.sleep(Math.min(50, remainingMs)));
		}
	}

	async #resolve(descriptor: CodexLocatorDescriptor, deadline: OperationDeadline): Promise<ElementHandle[]> {
		const resolution =
			typeof (this.#page as unknown as { evaluateHandle?: unknown }).evaluateHandle === "function"
				? this.#resolveEvaluated(descriptor, deadline)
				: this.#resolveLegacy(descriptor, deadline);
		return await this.#runBeforeDeadline(
			deadline,
			() => resolution,
			() => {
				void resolution
					.then(handles => Promise.all(handles.map(handle => handle.dispose().catch(() => undefined))))
					.catch(() => undefined);
			},
		);
	}

	async #resolveEvaluated(descriptor: CodexLocatorDescriptor, deadline: OperationDeadline): Promise<ElementHandle[]> {
		this.#operationRemaining(deadline);
		const collection = await queryAriaLocatorHandle(this.#page, descriptor);
		const handles: ElementHandle[] = [];
		const properties = new Set<JSHandle<unknown>>();
		try {
			this.#operationRemaining(deadline);
			const values = await collection.getProperties();
			for (const property of values.values()) properties.add(property);
			for (const property of properties) {
				this.#operationRemaining(deadline);
				const candidate = property.asElement();
				if (candidate) {
					handles.push(candidate as ElementHandle);
					properties.delete(property);
				}
			}
			await Promise.all([...properties].map(property => property.dispose().catch(() => undefined)));
			properties.clear();
			return handles;
		} catch (error) {
			await Promise.all([
				...handles.map(handle => handle.dispose().catch(() => undefined)),
				...[...properties].map(property => property.dispose().catch(() => undefined)),
			]);
			if (error instanceof Error && error.message.includes("CODEX_CROSS_ORIGIN_FRAME")) {
				throw new BrowserCapabilityError(CODEX_BROWSER_CAPABILITIES.FRAME_LOCATOR_CROSS_ORIGIN);
			}
			throw error;
		} finally {
			await collection.dispose().catch(() => undefined);
		}
	}

	async #resolveLegacy(descriptor: CodexLocatorDescriptor, deadline: OperationDeadline): Promise<ElementHandle[]> {
		this.#operationRemaining(deadline);
		if (descriptor.kind === "css") return await this.#page.$$(descriptor.selector);
		const handles = await this.#page.$$("*");
		const matches: ElementHandle[] = [];
		const retained = new Set(handles);
		try {
			for (const handle of handles) {
				this.#operationRemaining(deadline);
				const result = await handle.evaluate(element => {
					interface PageElement {
						getAttribute(name: string): string | null;
						hasAttribute(name: string): boolean;
						labels?: ArrayLike<PageElement>;
						ownerDocument: { getElementById(id: string): PageElement | null };
						parentElement: PageElement | null;
						querySelectorAll(selector: string): ArrayLike<PageElement>;
						tagName: string;
						textContent: string | null;
						value?: string;
					}
					const pageElement = element as unknown as PageElement;
					const root = globalThis as unknown as {
						getComputedStyle(element: PageElement): { display: string; visibility: string };
					};
					const roleOf = (target: PageElement): string | null => {
						const explicit = target.getAttribute("role")?.trim().split(/\s+/)[0];
						if (explicit) return explicit;
						const tag = target.tagName.toLowerCase();
						if (tag === "button") return "button";
						if ((tag === "a" || tag === "area") && target.hasAttribute("href")) return "link";
						if (/^h[1-6]$/.test(tag)) return "heading";
						if (tag === "ul" || tag === "ol") return "list";
						if (tag === "li") return "listitem";
						if (tag === "textarea") return "textbox";
						if (tag === "select")
							return target.hasAttribute("multiple") || Number(target.getAttribute("size") ?? "0") > 1
								? "listbox"
								: "combobox";
						if (tag === "option") return "option";
						if (tag === "img") return target.getAttribute("alt") === "" ? null : "img";
						if (tag !== "input") return null;
						const rawType = (target.getAttribute("type") ?? "text").toLowerCase();
						const type = [
							"button",
							"checkbox",
							"color",
							"date",
							"datetime-local",
							"email",
							"file",
							"hidden",
							"image",
							"month",
							"number",
							"password",
							"radio",
							"range",
							"reset",
							"search",
							"submit",
							"tel",
							"text",
							"time",
							"url",
							"week",
						].includes(rawType)
							? rawType
							: "text";
						if (["button", "submit", "reset", "image"].includes(type)) return "button";
						if (type === "checkbox") return "checkbox";
						if (type === "radio") return "radio";
						if (type === "range") return "slider";
						if (type === "number") return "spinbutton";
						if (["search", "text", "email", "tel", "url"].includes(type))
							return target.hasAttribute("list") ? "combobox" : type === "search" ? "searchbox" : "textbox";
						return null;
					};
					let hidden = false;
					for (let current: PageElement | null = pageElement; current; current = current.parentElement) {
						const style = root.getComputedStyle(current);
						if (
							current.hasAttribute("hidden") ||
							current.hasAttribute("inert") ||
							current.getAttribute("aria-hidden")?.toLowerCase() === "true" ||
							style.display === "none" ||
							style.visibility === "hidden"
						) {
							hidden = true;
							break;
						}
					}
					const labels = pageElement.labels;
					const labelledBy = pageElement.getAttribute("aria-labelledby");
					const referencedLabel = labelledBy
						? labelledBy
								.split(/\s+/)
								.map((id: string) => pageElement.ownerDocument.getElementById(id)?.textContent?.trim() ?? "")
								.join(" ")
								.trim()
						: "";
					const type = (pageElement.getAttribute("type") ?? "text").toLowerCase();
					const valueName =
						pageElement.tagName.toLowerCase() === "input" && ["button", "submit", "reset", "image"].includes(type)
							? (pageElement.value ?? "")
							: "";
					const descendantAlternatives = Array.from(pageElement.querySelectorAll("img[alt]"))
						.map(image => image.getAttribute("alt") ?? "")
						.filter(Boolean)
						.join(" ");
					const name =
						referencedLabel ||
						pageElement.getAttribute("aria-label")?.trim() ||
						(labels?.length
							? Array.from(labels)
									.map((label: PageElement) => label.textContent?.trim() ?? "")
									.join(" ")
									.trim()
							: "") ||
						pageElement.getAttribute("alt") ||
						pageElement.getAttribute("title") ||
						valueName ||
						[pageElement.textContent?.trim() ?? "", descendantAlternatives].filter(Boolean).join(" ") ||
						"";
					return { role: roleOf(pageElement), name, hidden };
				});
				const matched =
					descriptor.kind === "role" &&
					!result.hidden &&
					result.role === descriptor.role &&
					(descriptor.name === undefined || patternMatchesAccessibleText(result.name, descriptor.name));
				if (matched) {
					matches.push(handle);
					retained.delete(handle);
				}
			}
			await Promise.all([...retained].map(handle => handle.dispose().catch(() => undefined)));
			return matches;
		} catch (error) {
			await Promise.all(handles.map(handle => handle.dispose().catch(() => undefined)));
			throw error;
		}
	}

	async #isVisible(handle: ElementHandle): Promise<boolean> {
		if (typeof (handle as unknown as { evaluate?: unknown }).evaluate !== "function") return true;
		return await handle.evaluate(element => {
			const style = getComputedStyle(element);
			const rect = element.getBoundingClientRect();
			return (
				style.display !== "none" &&
				style.visibility !== "hidden" &&
				Number(style.opacity) !== 0 &&
				rect.width > 0 &&
				rect.height > 0
			);
		});
	}

	async #isEnabled(handle: ElementHandle): Promise<boolean> {
		if (typeof (handle as unknown as { evaluate?: unknown }).evaluate !== "function") return true;
		return await handle.evaluate(element => {
			const control = element as unknown as { disabled?: boolean };
			return control.disabled !== true && element.getAttribute("aria-disabled") !== "true";
		});
	}

	async #receivesPointerEvents(handle: ElementHandle): Promise<boolean> {
		if (typeof handle.evaluate !== "function") return true;
		return await handle.evaluate(element => {
			const pointerTarget = element as Element & {
				scrollIntoView(options: { block: "center"; inline: "center" }): void;
			};
			pointerTarget.scrollIntoView({ block: "center", inline: "center" });
			const rect = element.getBoundingClientRect();
			const view = element.ownerDocument.defaultView;
			if (!view || rect.width <= 0 || rect.height <= 0) return false;
			const x = rect.left + rect.width / 2;
			const y = rect.top + rect.height / 2;
			if (x < 0 || y < 0 || x >= view.innerWidth || y >= view.innerHeight) return false;
			const hit = element.ownerDocument.elementFromPoint(x, y);
			return hit !== null && (hit === element || element.contains(hit));
		});
	}

	async #locatorClick(args: Readonly<Record<string, unknown>>, double: boolean): Promise<void> {
		const force = args.force === true;
		const label = double ? "locator.dblclick" : "locator.click";
		const pressed: string[] = [];
		let releaseRequested = false;
		let releaseFailure: unknown;
		let releasePromise = Promise.resolve();
		const releasePressed = (): Promise<void> => {
			releaseRequested = true;
			const keys = pressed.splice(0).reverse();
			releasePromise = releasePromise.then(async () => {
				for (const modifier of keys) {
					try {
						await this.#page.keyboard.up(modifier as KeyInput);
					} catch (error) {
						releaseFailure ??= error;
					}
				}
			});
			return releasePromise;
		};
		await this.#withActionHandle(
			locatorArgs(args),
			label,
			async handle => {
				const modifiers = Array.isArray(args.modifiers) ? (args.modifiers as string[]) : [];
				const normalized = modifiers.map(modifier =>
					modifier === "ControlOrMeta" ? (process.platform === "darwin" ? "Meta" : "Control") : modifier,
				);
				let failure: unknown;
				try {
					for (const modifier of normalized) {
						await this.#page.keyboard.down(modifier as KeyInput);
						pressed.push(modifier);
						if (releaseRequested) {
							await releasePressed();
							throw new Error(`${label} was abandoned`);
						}
					}
					if (force && !(await this.#isVisible(handle))) {
						await handle.evaluate(
							(element, detail) => {
								const target = element as unknown as { click(): void; dispatchEvent(event: unknown): boolean };
								if (detail === 1) target.click();
								else {
									const root = globalThis as unknown as {
										MouseEvent: new (type: string, options: { bubbles: boolean; detail: number }) => unknown;
									};
									target.dispatchEvent(new root.MouseEvent("dblclick", { bubbles: true, detail }));
								}
							},
							double ? 2 : 1,
						);
					} else {
						await handle.click({ button: args.button as MouseButton | undefined, count: double ? 2 : 1 });
					}
				} catch (error) {
					failure = error;
				} finally {
					await releasePressed();
				}
				if (failure !== undefined) throw failure;
				if (releaseFailure !== undefined) throw releaseFailure;
			},
			{ visible: !force, enabled: true, receivesPointerEvents: !force },
			true,
			releasePressed,
		);
	}

	async #setEditableValue(
		handle: ElementHandle,
		value: string,
		append: boolean,
		deadline: OperationDeadline,
	): Promise<void> {
		const expected = await handle.evaluate(
			(element, payload) => {
				interface EditableElement {
					isContentEditable: boolean;
					readOnly?: boolean;
					textContent: string | null;
					type: string;
					value: string;
				}
				interface PageView {
					Event?: new (type: string, options: { bubbles: boolean }) => unknown;
					HTMLInputElement: { prototype: object };
					HTMLTextAreaElement: { prototype: object };
				}
				const root = globalThis as unknown as {
					Event: new (type: string, options: { bubbles: boolean }) => unknown;
				};
				if (Date.now() >= payload.expiresAt) throw new Error(`${payload.label} timed out before mutation`);
				const tag = element.tagName.toLowerCase();
				const control = element as unknown as EditableElement;
				const editableElement = control;
				const inputType = tag === "input" ? control.type.toLowerCase() : "";
				const editableInput =
					tag === "input" &&
					!["button", "checkbox", "file", "hidden", "image", "radio", "reset", "submit"].includes(inputType);
				const editableControl = editableInput || tag === "textarea";
				const ariaReadonly = element.getAttribute("aria-readonly")?.trim().toLowerCase() === "true";
				if (
					(!editableControl && !editableElement.isContentEditable) ||
					(editableControl && control.readOnly) ||
					ariaReadonly
				) {
					throw new Error(`${payload.label} requires an editable element`);
				}
				const before = editableControl ? control.value : (editableElement.textContent ?? "");
				const next = payload.append ? before + payload.value : payload.value;
				const view = element.ownerDocument.defaultView as unknown as PageView | null;
				if (editableControl) {
					const prototype =
						tag === "textarea" ? view?.HTMLTextAreaElement.prototype : view?.HTMLInputElement.prototype;
					const setter = prototype ? Object.getOwnPropertyDescriptor(prototype, "value")?.set : undefined;
					if (setter) setter.call(element, next);
					else control.value = next;
				} else editableElement.textContent = next;
				const EventConstructor = view?.Event ?? root.Event;
				const eventTarget = element as unknown as { dispatchEvent(event: unknown): boolean };
				eventTarget.dispatchEvent(new EventConstructor("input", { bubbles: true }));
				eventTarget.dispatchEvent(new EventConstructor("change", { bubbles: true }));
				return next;
			},
			{ value, append, label: deadline.label, expiresAt: deadline.expiresAt },
		);
		const observed = await handle.evaluate(element => {
			interface ObservedElement {
				textContent: string | null;
				value: string;
			}
			const observedElement = element as unknown as ObservedElement;
			const tag = element.tagName.toLowerCase();
			return tag === "input" || tag === "textarea" ? observedElement.value : (observedElement.textContent ?? "");
		});
		if (observed !== expected) {
			throw new Error(
				`${deadline.label} expected exact value ${JSON.stringify(expected)} but observed ${JSON.stringify(observed)}`,
			);
		}
	}

	async #selectOption(args: Readonly<Record<string, unknown>>): Promise<string[]> {
		return await this.#withActionHandle(
			locatorArgs(args),
			"locator.selectOption",
			async handle =>
				await handle.evaluate((element, rawSelections) => {
					interface SelectOptionLike {
						value: string;
						label: string;
						selected: boolean;
					}
					const select = element as unknown as {
						tagName: string;
						multiple: boolean;
						options: ArrayLike<SelectOptionLike>;
						dispatchEvent(event: unknown): boolean;
					};
					if (select.tagName !== "SELECT") throw new Error("locator.selectOption requires a select element");
					const selections = rawSelections as Array<{ value?: string; label?: string; index?: number }>;
					const matches: number[] = [];
					for (const selection of selections) {
						const index = Array.from(select.options).findIndex((option, optionIndex) =>
							selection.value !== undefined
								? option.value === selection.value
								: selection.label !== undefined
									? option.label === selection.label
									: selection.index === optionIndex,
						);
						if (index < 0) throw new Error("locator.selectOption could not find a requested option");
						if (!matches.includes(index)) matches.push(index);
					}
					const selectedIndexes = select.multiple ? matches : matches.slice(0, 1);
					for (let index = 0; index < select.options.length; index++) {
						select.options[index].selected = selectedIndexes.includes(index);
					}
					const root = globalThis as unknown as {
						Event: new (type: string, options: { bubbles: boolean }) => unknown;
					};
					select.dispatchEvent(new root.Event("input", { bubbles: true }));
					select.dispatchEvent(new root.Event("change", { bubbles: true }));
					return Array.from(select.options)
						.filter(option => option.selected)
						.map(option => option.value);
				}, args.selections),
			{ visible: true, enabled: true },
		);
	}

	async #setChecked(args: Readonly<Record<string, unknown>>): Promise<void> {
		const force = args.force === true;
		await this.#withActionHandle(
			locatorArgs(args),
			"locator.setChecked",
			async handle => {
				const desired = args.checked === true;
				const state = await handle.evaluate(element => {
					const input = element as unknown as { checked?: boolean; type?: string };
					return { tagName: element.tagName, type: input.type, checked: input.checked };
				});
				if (state.tagName !== "INPUT" || (state.type !== "checkbox" && state.type !== "radio")) {
					throw new Error("locator.setChecked requires a checkbox or radio input");
				}
				if (state.checked !== desired) {
					if (force) {
						await handle.evaluate((element, checked) => {
							const input = element as unknown as { checked: boolean; dispatchEvent(event: Event): boolean };
							const root = globalThis as unknown as {
								Event: new (type: string, options: { bubbles: boolean }) => Event;
							};
							input.checked = checked;
							input.dispatchEvent(new root.Event("input", { bubbles: true }));
							input.dispatchEvent(new root.Event("change", { bubbles: true }));
						}, desired);
					} else await handle.click();
				}
				const actual = await handle.evaluate(element => {
					const input = element as unknown as { checked?: boolean };
					return input.checked === true;
				});
				if (actual !== desired) throw new Error(`locator.setChecked could not set checked=${desired}`);
			},
			{ visible: !force, enabled: true },
		);
	}

	async #waitForLocator(args: Readonly<Record<string, unknown>>): Promise<void> {
		const parsed = locatorArgs(args);
		const state = stringArg(args, "state");
		const deadline = this.#operationDeadline(parsed.timeoutMs, "locator.waitFor");
		for (;;) {
			throwIfAborted(this.#signal);
			this.#operationRemaining(deadline);
			const handles = await this.#resolve(parsed.locator, deadline);
			let visible = false;
			const attached = handles.length > 0;
			try {
				for (const handle of handles) {
					if (await this.#runBeforeDeadline(deadline, () => this.#isVisible(handle))) visible = true;
				}
			} finally {
				await this.#disposeHandlesBeforeDeadline(handles, deadline);
			}
			if (
				(state === "attached" && attached) ||
				(state === "detached" && !attached) ||
				(state === "visible" && visible) ||
				(state === "hidden" && !visible)
			)
				return;
			const remainingMs = this.#operationRemaining(deadline);
			await this.#runBeforeDeadline(deadline, () => Bun.sleep(Math.min(50, remainingMs)));
		}
	}

	async #visibleDom(args: Readonly<Record<string, unknown>>): Promise<CodexVisibleDom> {
		const deadline = this.#operationDeadline(
			typeof args.timeoutMs === "number" ? args.timeoutMs : undefined,
			"dom_cua.get_visible_dom",
		);
		const previous = [...this.#domNodes.values()];
		this.#domNodes.clear();
		const generation = ++this.#domSnapshotGeneration;
		await this.#disposeHandlesBeforeDeadline(previous, deadline);
		if (this.#disposed) throw new Error("Puppeteer adapter was disposed");
		const collectionPromise = this.#page.evaluateHandle(() => {
			interface PageElement {
				getAttribute(name: string): string | null;
				getBoundingClientRect(): { width: number; height: number };
				hasAttribute(name: string): boolean;
				isContentEditable?: boolean;
				parentElement: PageElement | null;
				tabIndex?: number;
				tagName: string;
			}
			const root = globalThis as unknown as {
				document: { querySelectorAll(selector: string): ArrayLike<PageElement> };
				getComputedStyle(element: PageElement): { display: string; opacity: string; visibility: string };
			};
			const roleOf = (element: PageElement): string | null => {
				const explicit = element.getAttribute("role")?.trim().split(/\s+/)[0];
				if (explicit) return explicit;
				const tag = element.tagName.toLowerCase();
				if (tag === "button") return "button";
				if ((tag === "a" || tag === "area") && element.hasAttribute("href")) return "link";
				if (/^h[1-6]$/.test(tag)) return "heading";
				if (tag === "textarea") return "textbox";
				if (tag === "select")
					return element.hasAttribute("multiple") || Number(element.getAttribute("size") ?? "0") > 1
						? "listbox"
						: "combobox";
				if (tag === "option") return "option";
				if (tag === "img") return element.getAttribute("alt") === "" ? null : "img";
				if (tag !== "input") return null;
				const rawType = (element.getAttribute("type") ?? "text").toLowerCase();
				const type = [
					"button",
					"checkbox",
					"color",
					"date",
					"datetime-local",
					"email",
					"file",
					"hidden",
					"image",
					"month",
					"number",
					"password",
					"radio",
					"range",
					"reset",
					"search",
					"submit",
					"tel",
					"text",
					"time",
					"url",
					"week",
				].includes(rawType)
					? rawType
					: "text";
				if (["button", "submit", "reset", "image"].includes(type)) return "button";
				if (type === "checkbox") return "checkbox";
				if (type === "radio") return "radio";
				if (type === "range") return "slider";
				if (type === "number") return "spinbutton";
				if (["search", "text", "email", "tel", "url"].includes(type))
					return element.hasAttribute("list") ? "combobox" : type === "search" ? "searchbox" : "textbox";
				return null;
			};
			const interactiveRoles = [
				"button",
				"checkbox",
				"combobox",
				"link",
				"listbox",
				"menuitem",
				"menuitemcheckbox",
				"menuitemradio",
				"option",
				"radio",
				"searchbox",
				"slider",
				"spinbutton",
				"switch",
				"tab",
				"textbox",
				"treeitem",
			];
			const pageDocument = root.document;
			return Array.from(
				pageDocument.querySelectorAll(
					"a,area,button,input,textarea,select,option,[role],[tabindex],[contenteditable]",
				),
			).filter((element: PageElement) => {
				for (let current: PageElement | null = element; current; current = current.parentElement) {
					const style = root.getComputedStyle(current);
					if (
						current.hasAttribute("hidden") ||
						current.hasAttribute("inert") ||
						current.getAttribute("aria-hidden")?.toLowerCase() === "true" ||
						style.display === "none" ||
						style.visibility === "hidden"
					)
						return false;
				}
				const rect = element.getBoundingClientRect();
				if (rect.width <= 0 || rect.height <= 0 || Number(root.getComputedStyle(element).opacity) === 0)
					return false;
				const tag = element.tagName.toLowerCase();
				const focusable = element;
				const role = roleOf(element);
				return (
					(tag === "input" && (element.getAttribute("type") ?? "text").toLowerCase() !== "hidden") ||
					tag === "button" ||
					tag === "select" ||
					tag === "textarea" ||
					((tag === "a" || tag === "area") && element.hasAttribute("href")) ||
					(role !== null && interactiveRoles.includes(role)) ||
					element.hasAttribute("tabindex") ||
					(focusable.tabIndex ?? -1) >= 0 ||
					focusable.isContentEditable === true
				);
			});
		});
		const collection = await this.#runBeforeDeadline(
			deadline,
			() => collectionPromise,
			() => {
				void collectionPromise.then(
					value => value.dispose().catch(() => undefined),
					() => undefined,
				);
			},
		);
		const handles: ElementHandle[] = [];
		try {
			const propertiesPromise = collection.getProperties();
			const properties = await this.#runBeforeDeadline(
				deadline,
				() => propertiesPromise,
				() => {
					void propertiesPromise.then(
						values => Promise.all([...values.values()].map(value => value.dispose().catch(() => undefined))),
						() => undefined,
					);
				},
			);
			for (const property of properties.values()) {
				const element = property.asElement();
				if (element) handles.push(element as ElementHandle);
				else await this.#disposeHandlesBeforeDeadline([property], deadline);
			}
			const nodes = await this.#runBeforeDeadline(deadline, () =>
				Promise.all(
					handles.map(async handle => {
						const [node, aria] = await Promise.all([
							handle.evaluate(element => {
								const pageElement = element as unknown as {
									getBoundingClientRect(): { x: number; y: number; width: number; height: number };
									innerText?: string;
									tagName: string;
									textContent: string | null;
								};
								const rect = pageElement.getBoundingClientRect();
								return {
									tag: pageElement.tagName.toLowerCase(),
									fallbackText: String(pageElement.innerText ?? pageElement.textContent ?? "")
										.replace(/\s+/g, " ")
										.trim(),
									x: rect.x,
									y: rect.y,
									width: rect.width,
									height: rect.height,
								};
							}),
							getAriaElementState(handle),
						]);
						return {
							tag: node.tag,
							role: aria.role,
							text: aria.name || node.fallbackText,
							x: node.x,
							y: node.y,
							width: node.width,
							height: node.height,
						};
					}),
				),
			);
			if (this.#disposed || generation !== this.#domSnapshotGeneration) {
				throw new Error("Puppeteer adapter was disposed during visible DOM construction");
			}
			return {
				nodes: nodes.map((node, index) => {
					const nodeId = `${generation}:${index + 1}`;
					const handle = handles[index];
					if (handle) this.#domNodes.set(nodeId, handle);
					return { node_id: nodeId, ...node };
				}),
			};
		} catch (error) {
			await this.#disposeHandlesBeforeDeadline(handles, deadline);
			throw error;
		} finally {
			await this.#disposeHandlesBeforeDeadline([collection], deadline);
		}
	}

	async #domHandle(args: Readonly<Record<string, unknown>>, deadline: OperationDeadline): Promise<ElementHandle> {
		const nodeId = String(args.nodeId);
		const handle = this.#domNodes.get(nodeId);
		if (!handle) throw new Error(`Unknown DOM CUA node_id ${nodeId}; call get_visible_dom() again`);
		const connected = await this.#runBeforeDeadline(deadline, () =>
			handle.evaluate(element => element.isConnected && element.ownerDocument === document),
		).catch(error => {
			throwIfAborted(this.#signal);
			if (error instanceof Error && error.message.includes("timed out")) throw error;
			return false;
		});
		if (!connected) {
			this.#domNodes.delete(nodeId);
			await this.#disposeHandlesBeforeDeadline([handle], deadline);
			throw new Error("DOM CUA node is stale; call get_visible_dom() again");
		}
		return handle;
	}

	async #domClick(args: Readonly<Record<string, unknown>>, double: boolean): Promise<void> {
		const deadline = this.#operationDeadline(
			typeof args.timeoutMs === "number" ? args.timeoutMs : undefined,
			double ? "dom_cua.double_click" : "dom_cua.click",
		);
		const handle = await this.#domHandle(args, deadline);
		for (;;) {
			throwIfAborted(this.#signal);
			if (deadline.expiresAt <= Date.now()) {
				throw new Error(`${deadline.label} timed out after ${deadline.timeoutMs}ms before becoming actionable`);
			}
			const visible = await this.#runBeforeDeadline(deadline, () => this.#isVisible(handle));
			const enabled = await this.#runBeforeDeadline(deadline, () => this.#isEnabled(handle));
			const receivesPointerEvents = await this.#runBeforeDeadline(deadline, () =>
				this.#receivesPointerEvents(handle),
			);
			if (visible && enabled && receivesPointerEvents) {
				await this.#runBeforeDeadline(deadline, () => handle.click({ count: double ? 2 : 1 }));
				return;
			}
			const remainingMs = this.#operationRemaining(deadline);
			await this.#runBeforeDeadline(deadline, () => Bun.sleep(Math.min(50, remainingMs)));
		}
	}

	async #domScroll(args: Readonly<Record<string, unknown>>): Promise<void> {
		const deadline = this.#operationDeadline(
			typeof args.timeoutMs === "number" ? args.timeoutMs : undefined,
			"dom_cua.scroll",
		);
		if (args.nodeId === undefined) {
			await this.#runBeforeDeadline(deadline, () =>
				this.#page.mouse.wheel({ deltaX: numberArg(args, "x"), deltaY: numberArg(args, "y") }),
			);
			return;
		}
		const handle = await this.#domHandle(args, deadline);
		const connected = await this.#runBeforeDeadline(deadline, () =>
			handle.evaluate(
				(element, deltaX, deltaY) => {
					if (!element.isConnected || element.ownerDocument !== document) return false;
					const scrollable = element as unknown as PageScrollableElement;
					scrollable.scrollBy({ left: deltaX, top: deltaY });
					return element.isConnected && element.ownerDocument === document;
				},
				numberArg(args, "x"),
				numberArg(args, "y"),
			),
		);
		if (!connected) throw new Error("DOM CUA node is stale; call get_visible_dom() again");
	}

	async #pressKeys(rawKeys: unknown): Promise<void> {
		if (!Array.isArray(rawKeys)) return;
		for (const key of rawKeys) await this.#page.keyboard.press(key as KeyInput);
	}

	async #typeIntoActiveElement(text: string, label: "cua.type" | "dom_cua.type"): Promise<void> {
		const before = await this.#page.evaluate(() => {
			const pageDocument = document as unknown as PageDocumentLike;
			const active = pageDocument.activeElement;
			if (!active) return null;
			const tag = active.tagName.toLowerCase();
			const target = active as unknown as PageEditableElement;
			const type = tag === "input" ? (active.getAttribute("type") ?? "text").toLowerCase() : "";
			const editableInput =
				tag === "input" &&
				!["button", "checkbox", "file", "hidden", "image", "radio", "reset", "submit"].includes(type);
			const control = target;
			const contentEditable = target.isContentEditable;
			const ariaReadonly = active.getAttribute("aria-readonly")?.trim().toLowerCase() === "true";
			if (
				(!editableInput && tag !== "textarea" && !contentEditable) ||
				control.readOnly ||
				control.disabled ||
				ariaReadonly
			)
				return null;
			const value = contentEditable ? (target.textContent ?? "") : control.value;
			if (!contentEditable)
				return { value, start: control.selectionStart ?? value.length, end: control.selectionEnd ?? value.length };
			const pageGlobal = globalThis as unknown as { getSelection(): PageSelectionLike | null };
			const selection = pageGlobal.getSelection();
			if (!selection || selection.rangeCount === 0 || !target.contains(selection.anchorNode))
				return { value, start: value.length, end: value.length };
			const range = selection.getRangeAt(0);
			const startRange = range.cloneRange();
			startRange.selectNodeContents(target);
			startRange.setEnd(range.startContainer, range.startOffset);
			const endRange = range.cloneRange();
			endRange.selectNodeContents(target);
			endRange.setEnd(range.endContainer, range.endOffset);
			return { value, start: startRange.toString().length, end: endRange.toString().length };
		});
		if (before === null) throw new Error(`${label} requires an editable active element`);
		const expected = before.value.slice(0, before.start) + text + before.value.slice(before.end);
		await this.#page.keyboard.type(text);
		const after = await this.#page.evaluate(() => {
			const pageDocument = document as unknown as PageDocumentLike;
			const active = pageDocument.activeElement;
			if (!active) return null;
			const target = active as unknown as PageEditableElement;
			return target.isContentEditable ? (target.textContent ?? "") : target.value;
		});
		if (after !== expected)
			throw new Error(
				`${label} expected exact value ${JSON.stringify(expected)} but observed ${JSON.stringify(after)}`,
			);
	}
	#mouseButton(value: unknown): MouseButton {
		if (value === 2) return "middle";
		if (value === 3) return "right";
		return "left";
	}

	async #coordinateDrag(args: Readonly<Record<string, unknown>>): Promise<void> {
		await this.#pressKeys(args.keys);
		const points = args.path as Array<{ x: number; y: number }>;
		await this.#page.mouse.move(points[0].x, points[0].y);
		await this.#page.mouse.down();
		try {
			for (const point of points.slice(1)) await this.#page.mouse.move(point.x, point.y);
		} finally {
			await this.#page.mouse.up();
		}
	}

	async #downloadLocatorMedia(args: Readonly<Record<string, unknown>>): Promise<void> {
		await this.#withActionHandle(
			locatorArgs(args),
			"locator.downloadMedia",
			async (handle, deadline) => await this.#downloadHandleMedia(handle, deadline),
			{},
			false,
		);
	}

	async #downloadDomMedia(args: Readonly<Record<string, unknown>>): Promise<void> {
		const deadline = this.#operationDeadline(
			typeof args.timeoutMs === "number" ? args.timeoutMs : undefined,
			"dom_cua.downloadMedia",
		);
		const handle = await this.#domHandle(args, deadline);
		await this.#downloadHandleMedia(handle, deadline);
	}

	async #downloadPointMedia(args: Readonly<Record<string, unknown>>): Promise<void> {
		const deadline = this.#operationDeadline(
			typeof args.timeoutMs === "number" ? args.timeoutMs : undefined,
			"cua.downloadMedia",
		);
		const rawHandle = await this.#runBeforeDeadline(deadline, () =>
			this.#page.evaluateHandle(
				(x, y) => document.elementFromPoint(x, y),
				numberArg(args, "x"),
				numberArg(args, "y"),
			),
		);
		const element = rawHandle.asElement() as ElementHandle | null;
		if (!element) {
			await this.#disposeHandlesBeforeDeadline([rawHandle], deadline);
			throw new Error("cua.downloadMedia found no element at the point");
		}
		try {
			await this.#downloadHandleMedia(element, deadline);
		} finally {
			await this.#disposeHandlesBeforeDeadline([element], deadline);
		}
	}

	async #downloadHandleMedia(handle: ElementHandle, deadline: OperationDeadline): Promise<void> {
		const fetchTimeoutMs = this.#operationRemaining(deadline);
		const media = (await this.#runBeforeDeadline(deadline, () =>
			handle.evaluate(
				async (element, timeoutMs, label) => {
					const source =
						element.getAttribute("src") ??
						element.getAttribute("href") ??
						element.querySelector("img,video,audio,source")?.getAttribute("src") ??
						element.querySelector("a")?.getAttribute("href");
					if (!source) return null;
					const controller = new AbortController();
					const timer = setTimeout(() => controller.abort(new Error(`${label} media fetch timed out`)), timeoutMs);
					try {
						const pageDocument = document as unknown as PageDocumentLike;
						const response = await fetch(new URL(source, pageDocument.baseURI), { signal: controller.signal });
						if (!response.ok) throw new Error(`${label} media fetch failed with HTTP ${response.status}`);
						const maxBytes = 32 * 1024 * 1024;
						const contentLengthHeader = response.headers.get("content-length");
						const contentLength =
							contentLengthHeader !== null && /^\d+$/.test(contentLengthHeader)
								? Number(contentLengthHeader)
								: null;
						if (contentLength !== null && contentLength > maxBytes) {
							throw new Error(`${label} response exceeds the 32 MiB limit`);
						}
						const base64Chunks: string[] = [];
						const append = (bytes: Uint8Array) => {
							let binary = "";
							for (const byte of bytes) binary += String.fromCharCode(byte);
							base64Chunks.push(globalThis.btoa(binary));
						};
						if (response.body) {
							const reader = response.body.getReader();
							let received = 0;
							try {
								for (;;) {
									const chunk = await reader.read();
									if (chunk.done) break;
									if (received + chunk.value.byteLength > maxBytes) {
										try {
											await reader.cancel();
										} catch {}
										throw new Error(`${label} response exceeds the 32 MiB limit`);
									}
									received += chunk.value.byteLength;
									append(chunk.value);
								}
							} finally {
								reader.releaseLock();
							}
						} else {
							if (contentLength === null)
								throw new Error(`${label} requires Content-Length for a non-streaming response`);
							const bytes = new Uint8Array(await response.arrayBuffer());
							if (bytes.byteLength > maxBytes) throw new Error(`${label} response exceeds the 32 MiB limit`);
							append(bytes);
						}
						return { base64Chunks, contentType: response.headers.get("content-type") };
					} finally {
						clearTimeout(timer);
					}
				},
				fetchTimeoutMs,
				deadline.label,
			),
		)) as DownloadedMedia | null;
		if (!media) throw new Error(`${deadline.label} requires an element with a media source`);
		const decodedChunks = decodeBoundedMediaChunks(media.base64Chunks);
		const destination = path.join(
			this.#cwd,
			`codex-media-${Snowflake.next()}.${extensionForContentType(media.contentType)}`,
		);
		const temporary = `${destination}.partial-${Snowflake.next()}`;
		let abandoned = false;
		let committed = false;
		const abandon = () => {
			abandoned = true;
		};
		this.#signal.addEventListener("abort", abandon, { once: true });
		const persistence = (async () => {
			const output = await fs.promises.open(temporary, "w");
			try {
				for (const chunk of decodedChunks) {
					this.#operationRemaining(deadline);
					if (abandoned) throw new Error(`${deadline.label} persistence canceled`);
					await output.writeFile(chunk);
				}
				if (abandoned) throw new Error(`${deadline.label} persistence canceled`);
				this.#operationRemaining(deadline);
				await output.sync();
				await output.close();
				if (abandoned) throw new Error(`${deadline.label} persistence canceled`);
				await fs.promises.rename(temporary, destination);
				committed = true;
			} finally {
				await output.close().catch(() => undefined);
			}
		})();
		try {
			await this.#runBeforeDeadline(deadline, () => persistence, abandon);
		} catch (error) {
			abandon();
			void persistence.catch(() => undefined);
			const destinationExists =
				committed ||
				(await fs.promises.stat(destination).then(
					() => true,
					() => false,
				));
			await fs.promises.rm(destinationExists ? destination : temporary, { force: true });
			throw error;
		} finally {
			this.#signal.removeEventListener("abort", abandon);
		}
	}
}
