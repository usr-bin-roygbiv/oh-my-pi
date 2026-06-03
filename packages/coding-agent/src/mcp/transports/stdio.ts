/**
 * MCP stdio transport.
 *
 * Implements JSON-RPC 2.0 over subprocess stdin/stdout.
 * Messages are newline-delimited JSON.
 */

import { getProjectDir, readJsonl, Snowflake } from "@oh-my-pi/pi-utils";
import { type Subprocess, spawn } from "bun";
import type {
	JsonRpcError,
	JsonRpcMessage,
	JsonRpcRequest,
	JsonRpcResponse,
	MCPRequestOptions,
	MCPStdioServerConfig,
	MCPTransport,
} from "../../mcp/types";
import { toJsonRpcError } from "../../mcp/types";
import { isMCPTimeoutEnabled, resolveMCPTimeoutMs } from "../timeout";

/** Minimal write surface of `Subprocess.stdin` we need for framed sends. */
interface FrameSink {
	write(chunk: string): unknown;
	flush(): unknown;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
	return value != null && typeof (value as { then?: unknown }).then === "function";
}

/**
 * Write a newline-delimited JSON-RPC frame to the subprocess's stdin sink,
 * swallowing both synchronous throws and asynchronous Promise rejections
 * so the caller can decide how to react.
 *
 * Bun's `FileSink` surfaces broken-pipe failures two ways: synchronously
 * (most reliably on Windows when the read end has been closed between
 * read-loop ticks), or asynchronously via a rejected Promise returned
 * from `write()` / `flush()` once Bun's streaming writer has been engaged
 * by a prior successful write. A sync `try/catch` catches only the first
 * shape, leaving the async rejection floating — which the postmortem
 * `unhandledRejection` handler turns into a fatal `process.exit(1)` (see
 * issue #1782). Awaiting the thenables here funnels both shapes into the
 * same `catch` clause so the helper returns `false` either way.
 *
 * The returned Promise itself never rejects. Callers that want
 * fire-and-forget semantics MAY `void` it; callers that want to detect
 * failure MUST `await` it and branch on the `false` return.
 */
export async function writeFrame(stdin: FrameSink, frame: string): Promise<boolean> {
	try {
		const w = stdin.write(frame);
		if (isThenable(w)) await w;
		const f = stdin.flush();
		if (isThenable(f)) await f;
		return true;
	} catch {
		return false;
	}
}

/**
 * Stdio transport for MCP servers.
 * Spawns a subprocess and communicates via stdin/stdout.
 */
export class StdioTransport implements MCPTransport {
	#process: Subprocess<"pipe", "pipe", "pipe"> | null = null;
	#pendingRequests = new Map<
		string | number,
		{
			resolve: (value: unknown) => void;
			reject: (error: Error) => void;
		}
	>();
	#connected = false;
	#readLoop: Promise<void> | null = null;

	onClose?: () => void;
	onError?: (error: Error) => void;
	onNotification?: (method: string, params: unknown) => void;
	onRequest?: (method: string, params: unknown) => Promise<unknown>;

	constructor(private config: MCPStdioServerConfig) {}

	get connected(): boolean {
		return this.#connected;
	}

	/**
	 * Start the subprocess and begin reading.
	 */
	async connect(): Promise<void> {
		if (this.#connected) return;

		const args = this.config.args ?? [];
		const env = {
			...Bun.env,
			...this.config.env,
		};

		this.#process = spawn({
			cmd: [this.config.command, ...args],
			cwd: this.config.cwd ?? getProjectDir(),
			env,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});

		this.#connected = true;

		// Start reading stdout
		this.#readLoop = this.#startReadLoop();

		// Log stderr for debugging
		this.#startStderrLoop();
	}

	async #startReadLoop(): Promise<void> {
		if (!this.#process?.stdout) return;
		try {
			for await (const line of readJsonl(this.#process.stdout)) {
				if (!this.#connected) break;
				try {
					this.#handleMessage(line as JsonRpcMessage);
				} catch {
					// Skip malformed lines
				}
			}
		} catch (error) {
			if (this.#connected) {
				this.onError?.(error instanceof Error ? error : new Error(String(error)));
			}
		} finally {
			this.#handleClose();
		}
	}

	async #startStderrLoop(): Promise<void> {
		if (!this.#process?.stderr) return;

		const reader = this.#process.stderr.getReader();
		const decoder = new TextDecoder();

		try {
			while (this.#connected) {
				const { done, value } = await reader.read();
				if (done) break;
				// Log stderr but don't treat as error - servers use it for logging
				const text = decoder.decode(value, { stream: true });
				if (text.trim()) {
					// Could expose via onStderr callback if needed
					// For now, silent - MCP spec says clients MAY capture/ignore
				}
			}
		} catch {
			// Ignore stderr read errors
		} finally {
			reader.releaseLock();
		}
	}

	#handleMessage(message: JsonRpcMessage | JsonRpcMessage[]): void {
		if (Array.isArray(message)) {
			for (const m of message) this.#handleMessage(m);
			return;
		}
		// Server-to-client request: has both method and id
		if ("method" in message && "id" in message && message.id != null) {
			void this.#handleServerRequest(message as JsonRpcRequest);
			return;
		}

		// Response to our request: has id
		if ("id" in message && message.id != null) {
			const response = message as JsonRpcResponse;
			const pending = this.#pendingRequests.get(response.id);
			if (pending) {
				this.#pendingRequests.delete(response.id);
				if (response.error) {
					pending.reject(new Error(`MCP error ${response.error.code}: ${response.error.message}`));
				} else {
					pending.resolve(response.result);
				}
			}
			return;
		}

		// Notification: has method but no id
		if ("method" in message) {
			const notification = message as { method: string; params?: unknown };
			this.onNotification?.(notification.method, notification.params);
		}
	}

	async #handleServerRequest(request: JsonRpcRequest): Promise<void> {
		try {
			if (!this.onRequest) {
				this.#sendResponse(request.id, undefined, { code: -32601, message: "Method not found" });
				return;
			}
			const result = await this.onRequest(request.method, request.params);
			this.#sendResponse(request.id, result);
		} catch (error) {
			this.#sendResponse(request.id, undefined, toJsonRpcError(error));
		}
	}

	#sendResponse(id: string | number, result?: unknown, error?: JsonRpcError): void {
		if (!this.#connected || !this.#process?.stdin) return;
		const response = error
			? { jsonrpc: "2.0" as const, id, error }
			: { jsonrpc: "2.0" as const, id, result: result ?? {} };
		// Silent on failure — a dead subprocess has no use for the response,
		// and the read loop will close the transport on EOF. `writeFrame`
		// resolves to `false` instead of rejecting, so the floating promise
		// here is safe to discard.
		void writeFrame(this.#process.stdin, `${JSON.stringify(response)}\n`);
	}

	#handleClose(): void {
		if (!this.#connected) return;
		this.#connected = false;

		// Reject all pending requests
		for (const [, pending] of this.#pendingRequests) {
			pending.reject(new Error("Transport closed"));
		}
		this.#pendingRequests.clear();

		this.onClose?.();
	}

	async request<T = unknown>(
		method: string,
		params?: Record<string, unknown>,
		options?: MCPRequestOptions,
	): Promise<T> {
		if (!this.#connected || !this.#process?.stdin) {
			throw new Error("Transport not connected");
		}

		const id = Snowflake.next();
		const request = {
			jsonrpc: "2.0" as const,
			id,
			method,
			params: params ?? {},
		};

		const timeout = resolveMCPTimeoutMs(this.config.timeout);
		const signal = options?.signal;

		if (signal?.aborted) {
			const reason = signal.reason instanceof Error ? signal.reason : new Error("Aborted");
			return Promise.reject(reason);
		}

		const { promise, resolve, reject } = Promise.withResolvers<T>();
		let timer: NodeJS.Timeout | undefined;
		let settled = false;

		const cleanup = () => {
			if (settled) return;
			settled = true;
			if (timer) {
				clearTimeout(timer);
				timer = undefined;
			}
			if (signal) {
				signal.removeEventListener("abort", onAbort);
			}
			this.#pendingRequests.delete(id);
		};

		const onAbort = () => {
			cleanup();
			const reason = signal?.reason instanceof Error ? signal.reason : new Error("Aborted");
			reject(reason);
		};

		if (signal) {
			signal.addEventListener("abort", onAbort, { once: true });
		}

		this.#pendingRequests.set(id, {
			resolve: (value: unknown) => {
				cleanup();
				resolve(value as T);
			},
			reject: (error: Error) => {
				cleanup();
				reject(error);
			},
		});

		if (isMCPTimeoutEnabled(timeout)) {
			timer = setTimeout(() => {
				cleanup();
				reject(new Error(`Request timeout after ${timeout}ms`));
			}, timeout);
		}

		// Route through `writeFrame` so async EPIPE rejections from
		// Bun's streaming writer land in this caller instead of escaping as
		// an unhandled promise rejection. Sync throws are caught too. The
		// pending request is already registered, so a race with the read
		// loop closing the transport (which would reject our pending entry
		// with "Transport closed") is harmless — the duplicate reject below
		// is a no-op on an already-settled Promise.
		const message = `${JSON.stringify(request)}\n`;
		if (!(await writeFrame(this.#process.stdin, message))) {
			cleanup();
			reject(new Error(`Transport closed while sending request "${method}"`));
			this.#handleClose();
		}

		return promise;
	}

	async notify(method: string, params?: Record<string, unknown>): Promise<void> {
		if (!this.#connected || !this.#process?.stdin) {
			throw new Error("Transport not connected");
		}

		const notification = {
			jsonrpc: "2.0" as const,
			method,
			params: params ?? {},
		};

		// Bun's `FileSink` can fail in two ways when the subprocess has
		// exited between the last read-loop tick and this write: a sync
		// throw, or an asynchronously rejected Promise returned from
		// `write()`/`flush()` (engaged on Windows by Bun's streaming
		// writer once a prior successful write has been issued — the real
		// `initialize` request immediately preceding this notify). Both
		// shapes are funneled through `writeFrame` so this caller sees a
		// single `false` return. Tear the transport down so any wired
		// `onClose` (and reconnect machinery) engages, then surface the
		// failure to the caller — `initializeConnection()` runs before the
		// manager installs its `onClose` handler, so a swallowed failure
		// would yield a "connected" handle wrapping a dead transport.
		// See issues #1710 and #1782.
		if (!(await writeFrame(this.#process.stdin, `${JSON.stringify(notification)}\n`))) {
			this.#handleClose();
			throw new Error(`Transport closed while sending notification "${method}"`);
		}
	}

	async close(): Promise<void> {
		// `close()` is the authoritative resource teardown. `#handleClose()`
		// may have already run (read-loop EOF, or a notify() write failure
		// that surfaces the dead transport to the caller) and flipped
		// `#connected` to false — but the subprocess and read loop are still
		// alive in that path, so we MUST keep cleaning up regardless. Each
		// step is individually guarded so this remains idempotent across
		// repeat calls.
		if (this.#connected) {
			this.#handleClose();
		}

		if (this.#process) {
			this.#process.kill();
			this.#process = null;
		}

		if (this.#readLoop) {
			await this.#readLoop.catch(() => {});
			this.#readLoop = null;
		}
	}
}

/**
 * Create and connect a stdio transport.
 */
export async function createStdioTransport(config: MCPStdioServerConfig): Promise<StdioTransport> {
	const transport = new StdioTransport(config);
	await transport.connect();
	return transport;
}
