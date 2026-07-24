import { parentPort } from "node:worker_threads";
import { consumeWorkerInbox } from "@oh-my-pi/pi-utils/worker-host";
import { COMPUTER_WORKER_ARG, type ComputerWorkerInbound, type ComputerWorkerTransport } from "./protocol";
import { ComputerWorkerCore } from "./worker";

export function startComputerWorker(): void {
	if (!parentPort) throw new Error("computer-worker-entry: missing parentPort");

	const port = parentPort;
	const inbox = consumeWorkerInbox();
	const transport: ComputerWorkerTransport = {
		send(message, transfer) {
			port.postMessage(message, transfer ?? []);
		},
		onMessage(handler) {
			if (inbox) return inbox.bind(message => handler(message as ComputerWorkerInbound));
			const listener = (message: unknown): void => handler(message as ComputerWorkerInbound);
			port.on("message", listener);
			return () => port.off("message", listener);
		},
		close() {
			port.close();
		},
	};

	new ComputerWorkerCore(transport);
}

// Bun workers report `import.meta.main === false`. The source fallback still
// enters this file directly, while the bundled CLI carries the selector and
// starts the named entry only after installing its inbox.
if (!Bun.isMainThread && !process.argv.includes(COMPUTER_WORKER_ARG) && import.meta.path === Bun.main) {
	startComputerWorker();
}
