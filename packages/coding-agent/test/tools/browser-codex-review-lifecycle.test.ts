import { describe, expect, it, spyOn } from "bun:test";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { CmuxTab, runCmuxCode } from "@oh-my-pi/pi-coding-agent/tools/browser/cmux/cmux-tab";
import type { CmuxSocketClient } from "@oh-my-pi/pi-coding-agent/tools/browser/cmux/socket-client";
import { PuppeteerCodexBrowserAdapter } from "@oh-my-pi/pi-coding-agent/tools/browser/codex-puppeteer";
import type {
	RunResultOk,
	SessionSnapshot,
	Transport,
	WorkerInbound,
	WorkerOutbound,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-protocol";
import { WorkerCore } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-worker";
import puppeteer, { type Browser } from "puppeteer-core";

const CONTROL_KEY = Symbol.for("omp.browser-codex-review-lifecycle");

type CallableAgent = ((...args: unknown[]) => unknown) & { browser?: unknown };

function makeSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		settings: { get: () => undefined },
		getSessionFile: () => null,
	} as unknown as ToolSession;
}

function makeClient(): CmuxSocketClient {
	return {
		request: async (method: string, params: Record<string, unknown>) => {
			if (method !== "browser.eval") throw new Error(`Unexpected cmux request: ${method}`);
			const script = typeof params.script === "string" ? params.script : "";
			return {
				value: script.includes("return globalThis.__ompCodexBrowserState.fileEventSequence") ? 0 : true,
			};
		},
	} as unknown as CmuxSocketClient;
}

function restoreProperty(target: object, key: PropertyKey, descriptor: PropertyDescriptor | undefined): void {
	if (descriptor) Object.defineProperty(target, key, descriptor);
	else Reflect.deleteProperty(target, key);
}

interface PuppeteerWorkerHarness {
	send(message: WorkerInbound): void;
	waitFor(predicate: (message: WorkerOutbound) => boolean): Promise<WorkerOutbound>;
	close(): Promise<void>;
}

interface VoidDeferred {
	promise: Promise<void>;
	resolve(): void;
	reject(reason?: unknown): void;
}

interface CleanupGate {
	entered: VoidDeferred;
	release: VoidDeferred;
}

interface PuppeteerLifecycleObservation {
	priorProperty: "descriptor" | "absent";
	concurrentFailure: string | undefined;
	callableAgentPreserved: boolean;
	activeFacadePreserved: boolean;
	activeRunFacadePreserved: unknown;
	setupDescriptorRestoredBeforeCleanup: boolean;
	priorDescriptorRestoredBeforeCleanup: boolean;
	priorDescriptorRestoredAfterCompletion: boolean;
}

function sameDescriptor(actual: PropertyDescriptor | undefined, expected: PropertyDescriptor | undefined): boolean {
	if (!actual || !expected) return actual === expected;
	return (
		Object.is(actual.value, expected.value) &&
		Object.is(actual.get, expected.get) &&
		Object.is(actual.set, expected.set) &&
		actual.configurable === expected.configurable &&
		actual.enumerable === expected.enumerable &&
		actual.writable === expected.writable
	);
}

const LIFECYCLE_STEP_TIMEOUT_MS = 2_000;

// Intentional real deadline: fake timers would also freeze WorkerCore's own AbortSignal timeout,
// hiding a missing protocol message behind the test-level timeout instead of naming the stuck phase.
async function waitForLifecycleStep<T>(
	promise: Promise<T>,
	phase: string,
	timeoutMs = LIFECYCLE_STEP_TIMEOUT_MS,
): Promise<T> {
	const { promise: timeout, reject } = Promise.withResolvers<never>();
	const timer = setTimeout(
		() => reject(new Error(`Timed out waiting for Puppeteer lifecycle phase: ${phase}`)),
		timeoutMs,
	);
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

function describeWorkerResult(message: WorkerOutbound): string {
	if (message.type !== "result") return message.type;
	return message.ok ? "successful result" : `${message.error.name}: ${message.error.message}`;
}

function makePuppeteerBrowser(targetIds: readonly string[]): Browser {
	const targets = targetIds.map(targetId => {
		const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
		const frame = {};
		const makeSession = () => ({
			async send(method: string): Promise<Record<string, unknown>> {
				if (method === "Target.getTargetInfo") return { targetInfo: { targetId } };
				return {};
			},
			on(): void {},
			off(): void {},
			async detach(): Promise<void> {},
		});
		let target: Record<string, unknown>;
		const page: Record<string, unknown> = {
			target: () => target,
			url: () => `https://fixture.test/${targetId}`,
			title: async () => `Fixture ${targetId}`,
			viewport: () => ({ width: 800, height: 600 }),
			mainFrame: () => frame,
			isClosed: () => false,
			setRequestInterception: async () => {},
			on(type: string, handler: (...args: unknown[]) => void) {
				let handlers = listeners.get(type);
				if (!handlers) {
					handlers = new Set();
					listeners.set(type, handlers);
				}
				handlers.add(handler);
				return page;
			},
			off(type: string, handler?: (...args: unknown[]) => void) {
				if (handler) listeners.get(type)?.delete(handler);
				else listeners.delete(type);
				return page;
			},
			once(type: string, handler: (...args: unknown[]) => void) {
				const wrapped = (...args: unknown[]): void => {
					(listeners.get(type) ?? new Set()).delete(wrapped);
					handler(...args);
				};
				(page.on as (event: string, listener: (...args: unknown[]) => void) => unknown)(type, wrapped);
				return page;
			},
			removeAllListeners(type?: string) {
				if (type) listeners.delete(type);
				else listeners.clear();
				return page;
			},
		};
		target = {
			createCDPSession: async () => makeSession(),
			page: async () => page,
		};
		return target;
	});
	const browserTarget = {
		createCDPSession: async () => ({
			async send(): Promise<Record<string, unknown>> {
				return {};
			},
			on(): void {},
			off(): void {},
			async detach(): Promise<void> {},
		}),
	};
	return {
		target: () => browserTarget,
		targets: () => targets,
		connected: true,
		disconnect(): void {},
	} as unknown as Browser;
}

function createPuppeteerWorkerHarness(): PuppeteerWorkerHarness {
	const hostListeners = new Set<(message: WorkerOutbound) => void>();
	const workerListeners = new Set<(message: WorkerInbound) => void>();
	const transport: Transport = {
		send: message => {
			queueMicrotask(() => {
				for (const listener of hostListeners) listener(message as WorkerOutbound);
			});
		},
		onMessage: handler => {
			const listener = handler as (message: WorkerInbound) => void;
			workerListeners.add(listener);
			return () => workerListeners.delete(listener);
		},
		close: () => {},
	};
	new WorkerCore(transport);
	const harness: PuppeteerWorkerHarness = {
		send(message) {
			queueMicrotask(() => {
				for (const listener of workerListeners) listener(message);
			});
		},
		waitFor(predicate) {
			const { promise, resolve } = Promise.withResolvers<WorkerOutbound>();
			const listener = (message: WorkerOutbound): void => {
				if (!predicate(message)) return;
				hostListeners.delete(listener);
				resolve(message);
			};
			hostListeners.add(listener);
			return promise;
		},
		async close() {
			const closed = harness.waitFor(message => message.type === "closed");
			harness.send({ type: "close" });
			await waitForLifecycleStep(closed, "worker close");
		},
	};
	return harness;
}

async function initializePuppeteerWorker(harness: PuppeteerWorkerHarness, targetId: string): Promise<void> {
	const outcome = harness.waitFor(message => message.type === "ready" || message.type === "init-failed");
	harness.send({
		type: "init",
		payload: {
			mode: "attach",
			browserWSEndpoint: "ws://fixture.test",
			safeDir: process.cwd(),
			targetId,
		},
	});
	const message = await waitForLifecycleStep(outcome, `initialization (${targetId})`);
	if (message.type === "init-failed") {
		throw new Error(`Puppeteer lifecycle initialization failed (${targetId}): ${message.error.message}`);
	}
	if (message.type !== "ready") throw new Error(`Unexpected initialization response: ${message.type}`);
}

async function warmPuppeteerWorker(harness: PuppeteerWorkerHarness, id: string): Promise<void> {
	const result = harness.waitFor(message => message.type === "result" && message.id === id);
	harness.send({
		type: "run",
		id,
		name: id,
		code: "return true;",
		timeoutMs: 5_000,
		session: { cwd: process.cwd() },
	});
	const message = await waitForLifecycleStep(result, `runtime warm-up (${id})`);
	if (message.type !== "result" || !message.ok) {
		throw new Error(`Puppeteer lifecycle warm-up failed (${id}): ${describeWorkerResult(message)}`);
	}
}

async function observePuppeteerLifecycle(
	priorProperty: "descriptor" | "absent",
): Promise<PuppeteerLifecycleObservation> {
	const firstTargetId = `lifecycle-owner-${priorProperty}`;
	const secondTargetId = `lifecycle-contender-${priorProperty}`;
	const browser = makePuppeteerBrowser([firstTargetId, secondTargetId]);
	const connectSpy = spyOn(puppeteer, "connect").mockResolvedValue(browser);
	const first = createPuppeteerWorkerHarness();
	const second = createPuppeteerWorkerHarness();
	const cleanupGates: CleanupGate[] = [
		{ entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() },
		{ entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() },
	];
	const cleanupDescriptors: Array<PropertyDescriptor | undefined> = [];
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const control: { activeBrowser?: unknown; entered: typeof entered; release: typeof release } = {
		entered,
		release,
	};
	const globals = globalThis as unknown as Record<PropertyKey, unknown>;
	globals[CONTROL_KEY] = control;
	let activeAgent: CallableAgent | undefined;
	let originalBrowserDescriptor: PropertyDescriptor | undefined;
	let priorDescriptor: PropertyDescriptor | undefined;
	let disposeSpy: { mockRestore(): void } | undefined;
	let activeResult: Promise<WorkerOutbound> | undefined;
	let concurrentResult: Promise<WorkerOutbound> | undefined;

	try {
		await initializePuppeteerWorker(first, firstTargetId);
		await initializePuppeteerWorker(second, secondTargetId);
		await warmPuppeteerWorker(first, `warm-owner-${priorProperty}`);
		const warmedAgent = globals.agent as CallableAgent | undefined;
		if (typeof warmedAgent !== "function") throw new Error("First warmed runtime did not expose callable agent");
		activeAgent = warmedAgent;
		originalBrowserDescriptor = Object.getOwnPropertyDescriptor(warmedAgent, "browser");
		await warmPuppeteerWorker(second, `warm-contender-${priorProperty}`);
		if (globals.agent !== warmedAgent) throw new Error("Warmed runtimes did not preserve the callable agent");

		if (priorProperty === "descriptor") {
			priorDescriptor = {
				value: { source: "before-puppeteer-run" },
				configurable: true,
				enumerable: false,
				writable: false,
			};
			Object.defineProperty(warmedAgent, "browser", priorDescriptor);
		} else {
			Reflect.deleteProperty(warmedAgent, "browser");
		}

		disposeSpy = spyOn(PuppeteerCodexBrowserAdapter.prototype, "dispose").mockImplementation(async () => {
			const gate = cleanupGates[cleanupDescriptors.length];
			if (!gate) throw new Error("Unexpected Puppeteer adapter cleanup");
			cleanupDescriptors.push(Object.getOwnPropertyDescriptor(warmedAgent, "browser"));
			gate.entered.resolve();
			await gate.release.promise;
		});

		activeResult = first.waitFor(message => message.type === "result" && message.id === "active-run");
		first.send({
			type: "run",
			id: "active-run",
			name: "active-run",
			code: `const control = globalThis[Symbol.for("omp.browser-codex-review-lifecycle")];
				control.activeBrowser = agent.browser;
				control.entered.resolve();
				await control.release.promise;
				return agent.browser === control.activeBrowser;`,
			timeoutMs: 5_000,
			session: { cwd: process.cwd() },
		});
		const activeEntry = await waitForLifecycleStep(
			Promise.race([
				entered.promise.then(() => ({ kind: "entered" as const })),
				activeResult.then(message => ({ kind: "result" as const, message })),
			]),
			`active run entry (${priorProperty})`,
		);
		if (activeEntry.kind === "result") {
			throw new Error(`Active run failed before entry: ${describeWorkerResult(activeEntry.message)}`);
		}
		const activeDescriptor = Object.getOwnPropertyDescriptor(warmedAgent, "browser");

		concurrentResult = second.waitFor(message => message.type === "result" && message.id === "concurrent-run");
		second.send({
			type: "run",
			id: "concurrent-run",
			name: "concurrent-run",
			code: "return true;",
			timeoutMs: 5_000,
			session: { cwd: process.cwd() },
		});
		const contenderCleanup = await waitForLifecycleStep(
			Promise.race([
				cleanupGates[0].entered.promise.then(() => ({ kind: "cleanup" as const })),
				concurrentResult.then(message => ({ kind: "result" as const, message })),
			]),
			`contender adapter cleanup (${priorProperty})`,
		);
		if (contenderCleanup.kind === "result") {
			throw new Error(
				`Contender returned before adapter cleanup: ${describeWorkerResult(contenderCleanup.message)}`,
			);
		}
		const callableAgentPreserved = globals.agent === warmedAgent;
		const activeFacadePreserved = warmedAgent.browser === control.activeBrowser;
		const setupDescriptorRestoredBeforeCleanup = sameDescriptor(cleanupDescriptors[0], activeDescriptor);
		cleanupGates[0].release.resolve();
		const concurrent = await waitForLifecycleStep(concurrentResult, `contender result (${priorProperty})`);
		const concurrentFailure = concurrent.type === "result" && !concurrent.ok ? concurrent.error.message : undefined;

		release.resolve();
		const activeCleanup = await waitForLifecycleStep(
			Promise.race([
				cleanupGates[1].entered.promise.then(() => ({ kind: "cleanup" as const })),
				activeResult.then(message => ({ kind: "result" as const, message })),
			]),
			`active adapter cleanup (${priorProperty})`,
		);
		if (activeCleanup.kind === "result") {
			throw new Error(`Active run returned before adapter cleanup: ${describeWorkerResult(activeCleanup.message)}`);
		}
		const priorDescriptorRestoredBeforeCleanup = sameDescriptor(cleanupDescriptors[1], priorDescriptor);
		cleanupGates[1].release.resolve();
		const active = await waitForLifecycleStep(activeResult, `active result (${priorProperty})`);
		const activeRunFacadePreserved = active.type === "result" && active.ok ? active.payload.returnValue : undefined;

		return {
			priorProperty,
			concurrentFailure,
			callableAgentPreserved,
			activeFacadePreserved,
			activeRunFacadePreserved,
			setupDescriptorRestoredBeforeCleanup,
			priorDescriptorRestoredBeforeCleanup,
			priorDescriptorRestoredAfterCompletion: sameDescriptor(
				Object.getOwnPropertyDescriptor(warmedAgent, "browser"),
				priorDescriptor,
			),
		};
	} finally {
		release.resolve();
		for (const gate of cleanupGates) gate.release.resolve();
		try {
			await Promise.all([
				activeResult
					? waitForLifecycleStep(
							activeResult.catch(() => undefined),
							`active result cleanup (${priorProperty})`,
						).catch(() => undefined)
					: undefined,
				concurrentResult
					? waitForLifecycleStep(
							concurrentResult.catch(() => undefined),
							`contender result cleanup (${priorProperty})`,
						).catch(() => undefined)
					: undefined,
			]);
			await Promise.all([first.close().catch(() => undefined), second.close().catch(() => undefined)]);
		} finally {
			disposeSpy?.mockRestore();
			connectSpy.mockRestore();
			if (activeAgent) restoreProperty(activeAgent, "browser", originalBrowserDescriptor);
			delete globals[CONTROL_KEY];
		}
	}
}

describe("Codex agent.browser cmux run lifecycle", () => {
	it("keeps the active facade during a rejected concurrent run and restores the prior property afterward", async () => {
		const snapshot: SessionSnapshot = { cwd: process.cwd() };
		const session = makeSession(snapshot.cwd);
		const firstTab = new CmuxTab({ client: makeClient(), surfaceId: "facade-owner" });
		const secondTab = new CmuxTab({ client: makeClient(), surfaceId: "facade-contender" });
		const firstRuntime = firstTab.ensureRuntime(snapshot);
		const secondRuntime = secondTab.ensureRuntime(snapshot);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const control: { activeBrowser?: unknown; entered: typeof entered; release: typeof release } = {
			entered,
			release,
		};
		const globals = globalThis as unknown as Record<PropertyKey, unknown>;
		globals[CONTROL_KEY] = control;
		firstRuntime.setCwd(snapshot.cwd);
		const activeAgent = globals.agent as CallableAgent | undefined;
		if (typeof activeAgent !== "function") throw new Error("Expected the JS runtime to expose callable agent");
		const originalBrowserDescriptor = Object.getOwnPropertyDescriptor(activeAgent, "browser");
		const priorBrowser = { source: "before-cmux-run" };
		const priorDescriptor: PropertyDescriptor = {
			value: priorBrowser,
			configurable: true,
			enumerable: false,
			writable: false,
		};
		Object.defineProperty(activeAgent, "browser", priorDescriptor);
		let activeRun: Promise<RunResultOk> | undefined;

		try {
			activeRun = runCmuxCode(firstTab, {
				code: `const control = globalThis[Symbol.for("omp.browser-codex-review-lifecycle")];
				control.activeBrowser = agent.browser;
				control.entered.resolve();
				await control.release.promise;
				return { sameFacade: agent.browser === control.activeBrowser };`,
				timeoutMs: 5_000,
				session,
				snapshot,
			});
			await entered.promise;

			let concurrentFailure: string | undefined;
			try {
				await runCmuxCode(secondTab, { code: "return true;", timeoutMs: 5_000, session, snapshot });
			} catch (error) {
				concurrentFailure = error instanceof Error ? error.message : String(error);
			}
			const callableAgentPreserved = globals.agent === activeAgent;
			const activeFacadePreserved = activeAgent.browser === control.activeBrowser;

			release.resolve();
			const activeResult = await activeRun;
			const restoredDescriptor = Object.getOwnPropertyDescriptor(activeAgent, "browser");
			const observation = {
				concurrentFailure,
				callableAgentPreserved,
				activeFacadePreserved,
				activeRunFacadePreserved: activeResult.returnValue,
				priorBrowserRestored: restoredDescriptor?.value === priorBrowser,
				priorDescriptorRestored:
					restoredDescriptor?.configurable === priorDescriptor.configurable &&
					restoredDescriptor?.enumerable === priorDescriptor.enumerable &&
					restoredDescriptor?.writable === priorDescriptor.writable,
			};
			expect(observation).toEqual({
				concurrentFailure: "Cannot set run scope while another same-realm JS runtime is running",
				callableAgentPreserved: true,
				activeFacadePreserved: true,
				activeRunFacadePreserved: { sameFacade: true },
				priorBrowserRestored: true,
				priorDescriptorRestored: true,
			});
		} finally {
			release.resolve();
			await activeRun?.catch(() => undefined);
			restoreProperty(activeAgent, "browser", originalBrowserDescriptor);
			firstRuntime.dispose();
			secondRuntime.dispose();
			delete globals[CONTROL_KEY];
		}
	});
});

describe("Codex agent.browser Puppeteer inline-worker lifecycle", () => {
	it("preserves the active facade and restores descriptor state before adapter cleanup", async () => {
		const descriptorObservation = await observePuppeteerLifecycle("descriptor");
		const absentObservation = await observePuppeteerLifecycle("absent");

		expect([descriptorObservation, absentObservation]).toEqual([
			{
				priorProperty: "descriptor",
				concurrentFailure: "Cannot set run scope while another same-realm JS runtime is running",
				callableAgentPreserved: true,
				activeFacadePreserved: true,
				activeRunFacadePreserved: true,
				setupDescriptorRestoredBeforeCleanup: true,
				priorDescriptorRestoredBeforeCleanup: true,
				priorDescriptorRestoredAfterCompletion: true,
			},
			{
				priorProperty: "absent",
				concurrentFailure: "Cannot set run scope while another same-realm JS runtime is running",
				callableAgentPreserved: true,
				activeFacadePreserved: true,
				activeRunFacadePreserved: true,
				setupDescriptorRestoredBeforeCleanup: true,
				priorDescriptorRestoredBeforeCleanup: true,
				priorDescriptorRestoredAfterCompletion: true,
			},
		]);
	}, 20_000);
});
