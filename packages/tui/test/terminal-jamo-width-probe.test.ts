import { describe, expect, it } from "bun:test";
import { resolveHangulCompatibilityJamoWidthFromTerminalIdentity } from "@oh-my-pi/pi-tui/terminal";

describe("Hangul Compatibility Jamo width terminal-identity resolution", () => {
	it("forces wide for Ghostty, narrow for Warp, and the platform default otherwise", () => {
		// Ghostty follows UAX#11 and renders Hangul Compatibility Jamo at 2 cells;
		// Warp renders them at 1 cell. Every other terminal keeps the platform
		// default (macOS narrow, otherwise UAX#11).
		expect(
			resolveHangulCompatibilityJamoWidthFromTerminalIdentity({
				GHOSTTY_RESOURCES_DIR: "/Applications/Ghostty.app",
			}),
		).toBe(2);
		expect(resolveHangulCompatibilityJamoWidthFromTerminalIdentity({ TERM_PROGRAM: "ghostty" })).toBe(2);
		// Ghostty identified only via TERM (env-filtered shells that drop
		// GHOSTTY_RESOURCES_DIR / TERM_PROGRAM) must still resolve wide — mirrors
		// the Ghostty detection in terminal-capabilities.ts.
		expect(resolveHangulCompatibilityJamoWidthFromTerminalIdentity({ TERM: "xterm-ghostty" })).toBe(2);
		expect(resolveHangulCompatibilityJamoWidthFromTerminalIdentity({ TERM_PROGRAM: "WarpTerminal" })).toBe(1);
		expect(resolveHangulCompatibilityJamoWidthFromTerminalIdentity({ TERM_PROGRAM: "iTerm.app" })).toBe("platform");
		expect(resolveHangulCompatibilityJamoWidthFromTerminalIdentity({ TERM_PROGRAM: "Apple_Terminal" })).toBe(
			"platform",
		);
		expect(resolveHangulCompatibilityJamoWidthFromTerminalIdentity({})).toBe("platform");
	});
});
