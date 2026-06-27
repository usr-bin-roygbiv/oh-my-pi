import { describe, expect, it } from "bun:test";
import { buildTerminalTitleWithState } from "@oh-my-pi/pi-coding-agent/utils/title-generator";

const BASE = "π: my-project";

describe("buildTerminalTitleWithState", () => {
	it("shows a steady dot when idle/done", () => {
		expect(buildTerminalTitleWithState(BASE, "idle", 0, true)).toBe(`● ${BASE}`);
	});

	it("shows a bracketed bang when the agent needs attention", () => {
		expect(buildTerminalTitleWithState(BASE, "attention", 0, true)).toBe(`[!] ${BASE}`);
	});

	it("animates a spinner glyph while working", () => {
		const frame0 = buildTerminalTitleWithState(BASE, "working", 0, true);
		const frame1 = buildTerminalTitleWithState(BASE, "working", 1, true);
		// A single glyph + space precedes the base, and the glyph advances per frame.
		expect(frame0.endsWith(` ${BASE}`)).toBe(true);
		expect(frame0.length).toBeGreaterThan(BASE.length + 1);
		expect(frame1).not.toBe(frame0);
		// The frame index is taken modulo the frame count, so it never throws or
		// produces an "undefined" glyph for a large counter.
		const wrapped = buildTerminalTitleWithState(BASE, "working", 9999, true);
		expect(wrapped.endsWith(` ${BASE}`)).toBe(true);
		expect(wrapped).not.toContain("undefined");
	});

	it("renders the bare title (pre-state behavior) when disabled, regardless of state", () => {
		expect(buildTerminalTitleWithState(BASE, "working", 3, false)).toBe(BASE);
		expect(buildTerminalTitleWithState(BASE, "idle", 0, false)).toBe(BASE);
		expect(buildTerminalTitleWithState(BASE, "attention", 0, false)).toBe(BASE);
	});
});
