import type { Model } from "@oh-my-pi/pi-ai";

export type ComputerExposureMode = "native" | "function" | "unavailable";

/** Match the provider transport's effective Computer Use tool representation. */
export function computerExposureMode(model: Model | undefined): ComputerExposureMode {
	if (!model) return "unavailable";
	return model.supportsComputerUse === true ? "native" : "function";
}
