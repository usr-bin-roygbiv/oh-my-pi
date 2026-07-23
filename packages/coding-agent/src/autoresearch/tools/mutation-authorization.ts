import type { ExtensionContext } from "../../extensibility/extensions";
import { throwIfAborted } from "../../tools/tool-errors";
import type { AutoresearchToolFactoryOptions } from "../types";

export interface ActiveAutoresearchMutation {
	readonly signal: AbortSignal | undefined;
	authorizeMutation(): Promise<void>;
	assertRuntimeCurrent(): void;
	settle(): void;
}

export function beginAutoresearchMutation(
	options: AutoresearchToolFactoryOptions,
	ctx: ExtensionContext,
	toolSignal?: AbortSignal,
): ActiveAutoresearchMutation {
	const authorization = options.captureMutationAuthorization?.(ctx) ?? null;
	const signal = authorization
		? toolSignal
			? AbortSignal.any([toolSignal, authorization.signal])
			: authorization.signal
		: toolSignal;
	return {
		signal,
		async authorizeMutation(): Promise<void> {
			throwIfAborted(signal);
			await authorization?.authorizeMutation(ctx, signal);
			throwIfAborted(signal);
		},
		assertRuntimeCurrent(): void {
			throwIfAborted(signal);
			authorization?.assertRuntimeCurrent(ctx, signal);
			throwIfAborted(signal);
		},
		settle(): void {
			authorization?.settle();
		},
	};
}
