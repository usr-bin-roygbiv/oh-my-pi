#!/usr/bin/env bun
/**
 * Regenerates the committed browser asset
 *
 *   src/tools/browser/aria/aria-snapshot.bundle.txt   ← bundled CJS module
 *
 * by fetching Playwright's injected ARIA-snapshot sources (pinned to
 * PLAYWRIGHT_TAG), wrapping them with a small entry, and bundling — all in a
 * throwaway temp dir. Only the bundle is committed; the upstream sources are NOT
 * vendored into the repo (no shipping both source + generated copies). This is a
 * dev-time, network-bound step, exactly like `generate-models`.
 *
 * The tab worker imports the `.txt` with `{ type: "text" }`, wraps it in a
 * `new Function` worker-side, and runs it via puppeteer's CDP evaluate (it
 * installs nothing on `window`). The committed output means binary and source
 * installs need no network or build step at runtime.
 *
 * Usage: bun scripts/generate-aria-snapshot.ts
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const PLAYWRIGHT_TAG = "v1.61.0";
const RAW_BASE = `https://raw.githubusercontent.com/microsoft/playwright/${PLAYWRIGHT_TAG}/packages`;

const OUTPUT = path.join(import.meta.dir, "..", "src", "tools", "browser", "aria", "aria-snapshot.bundle.txt");

// Upstream source path -> temp path (relative to the temp root).
const VENDOR_FILES: Array<[string, string]> = [
	["injected/src/ariaSnapshot.ts", "injected/ariaSnapshot.ts"],
	["injected/src/roleUtils.ts", "injected/roleUtils.ts"],
	["injected/src/domUtils.ts", "injected/domUtils.ts"],
	["isomorphic/ariaSnapshot.ts", "isomorphic/ariaSnapshot.ts"],
	["isomorphic/stringUtils.ts", "isomorphic/stringUtils.ts"],
	["isomorphic/cssTokenizer.ts", "isomorphic/cssTokenizer.ts"],
	["isomorphic/yaml.ts", "isomorphic/yaml.ts"],
];

// Entry wrapping the upstream modules. Always runs Playwright's `ai` mode so every
// node carries a `[ref=eN]` id; matched nodes get an `_ariaRef` expando. Existing
// expandos are cleared first so the fresh module's counter renumbers from e1
// deterministically (refs are valid until the next snapshot). Installs nothing on
// `window`.
const ENTRY_SOURCE = String.raw`
import { generateAriaTree, renderAriaTree } from "./injected/ariaSnapshot";
import { beginDOMCaches, endDOMCaches, isElementVisible } from "./injected/domUtils";
import { getAriaRole, getElementAccessibleName, isElementHiddenForAria } from "./injected/roleUtils";

export interface AriaSnapshotRequest {
	depth?: number;
	boxes?: boolean;
}

function walkElements(fn: (el: Element) => void): void {
	const walk = (root: { querySelectorAll(s: string): ArrayLike<Element> }): void => {
		for (const el of Array.from(root.querySelectorAll("*"))) {
			fn(el);
			const shadow = (el as Element & { shadowRoot?: { querySelectorAll(s: string): ArrayLike<Element> } | null }).shadowRoot;
			if (shadow) walk(shadow);
		}
	};
	walk(document as unknown as { querySelectorAll(s: string): ArrayLike<Element> });
}
type RefElement = Element & { _ariaRef?: { role: string; name: string; ref: string } };

type TextPattern =
	| { kind: "string"; value: string; exact?: boolean }
	| { kind: "regexp"; source: string; flags: string };
type LocatorDescriptor =
	| { kind: "css"; selector: string }
	| { kind: "role"; role: string; name?: TextPattern }
	| { kind: "text"; text: TextPattern }
	| { kind: "label"; text: TextPattern }
	| { kind: "placeholder"; text: TextPattern }
	| { kind: "testId"; testId: string }
	| { kind: "frame"; selector: string }
	| { kind: "within"; parent: LocatorDescriptor; child: LocatorDescriptor }
	| { kind: "and"; left: LocatorDescriptor; right: LocatorDescriptor }
	| { kind: "or"; left: LocatorDescriptor; right: LocatorDescriptor }
	| { kind: "filter"; locator: LocatorDescriptor; hasText?: TextPattern; hasNotText?: TextPattern; has?: LocatorDescriptor; hasNot?: LocatorDescriptor; visible?: boolean }
	| { kind: "nth"; locator: LocatorDescriptor; index: number };
type QueryRoot = Document | Element | ShadowRoot;

function normalizeText(value: unknown): string {
	return String(value ?? "").replace(/\s+/g, " ").trim();
}

function patternMatches(pattern: TextPattern | undefined, value: string): boolean {
	if (!pattern) return true;
	const normalized = normalizeText(value);
	if (pattern.kind === "regexp") return new RegExp(pattern.source, pattern.flags).test(normalized);
	const expected = normalizeText(pattern.value);
	return pattern.exact ? normalized === expected : normalized.toLocaleLowerCase().includes(expected.toLocaleLowerCase());
}

function textOf(element: Element): string {
	return normalizeText(element.textContent);
}

function isInertForAria(element: Element): boolean {
	for (let current: Element | null = element; current; current = current.parentElement) {
		if (current.hasAttribute("inert")) return true;
	}
	return false;
}

function locatorRole(element: Element): string | null {
	if (element.tagName.toLowerCase() === "input") {
		const type = (element.getAttribute("type") ?? "text").toLowerCase();
		if (["color", "date", "datetime-local", "file", "hidden", "month", "password", "time", "week"].includes(type)) {
			return null;
		}
	}
	return getAriaRole(element);
}

function queryAll(root: QueryRoot, selector: string): Element[] {
	const values: Element[] = [];
	const visit = (scope: QueryRoot): void => {
		for (const element of Array.from(scope.querySelectorAll(selector))) values.push(element);
		for (const element of Array.from(scope.querySelectorAll("*"))) {
			const shadow = (element as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
			if (shadow) visit(shadow);
		}
	};
	visit(root);
	return values;
}

function isFrame(element: Element): element is HTMLIFrameElement {
	return element.tagName.toLowerCase() === "iframe";
}

function rootsFor(roots: QueryRoot[]): QueryRoot[] {
	return roots.flatMap(root => {
		if (!(root instanceof Element) || !isFrame(root)) return [root];
		try {
			if (!root.contentDocument) throw new Error("CODEX_CROSS_ORIGIN_FRAME");
			return [root.contentDocument];
		} catch {
			throw new Error("CODEX_CROSS_ORIGIN_FRAME");
		}
	});
}

function descendants(roots: QueryRoot[]): Element[] {
	return [...new Set(rootsFor(roots).flatMap(root => queryAll(root, "*")))];
}

function labelCandidates(element: Element): string[] {
	const labelled = element as Element & { labels?: ArrayLike<Element> };
	const values = Array.from(labelled.labels ?? [], textOf);
	const ariaLabel = normalizeText(element.getAttribute("aria-label"));
	if (ariaLabel) values.push(ariaLabel);
	const labelledBy = element.getAttribute("aria-labelledby");
	if (labelledBy) {
		const name = normalizeText(labelledBy.split(/\s+/).map(id => element.ownerDocument.getElementById(id)?.textContent ?? "").join(" "));
		if (name) values.push(name);
	}
	return values;
}

function queryLocator(descriptor: LocatorDescriptor, roots: QueryRoot[]): Element[] {
	const unique = (elements: Element[]): Element[] => [...new Set(elements)];
	switch (descriptor.kind) {
		case "css":
			return unique(rootsFor(roots).flatMap(root => queryAll(root, descriptor.selector)));
		case "role":
			return descendants(roots).filter(element =>
				!isElementHiddenForAria(element) &&
				!isInertForAria(element) &&
				locatorRole(element) === descriptor.role &&
				patternMatches(descriptor.name, normalizeText(getElementAccessibleName(element, false) || textOf(element))),
			);
		case "text": {
			const matched = descendants(roots).filter(element => patternMatches(descriptor.text, textOf(element)));
			return matched.filter(element => !Array.from(element.children).some(child => patternMatches(descriptor.text, textOf(child))));
		}
		case "label":
			return descendants(roots).filter(element => labelCandidates(element).some(label => patternMatches(descriptor.text, label)));
		case "placeholder":
			return descendants(roots).filter(element => patternMatches(descriptor.text, element.getAttribute("placeholder") ?? ""));
		case "testId":
			return descendants(roots).filter(element => element.getAttribute("data-testid") === descriptor.testId);
		case "frame":
			return unique(rootsFor(roots).flatMap(root => queryAll(root, descriptor.selector).filter(isFrame)));
		case "within":
			return queryLocator(descriptor.child, queryLocator(descriptor.parent, roots));
		case "and": {
			const right = new Set(queryLocator(descriptor.right, roots));
			return queryLocator(descriptor.left, roots).filter(element => right.has(element));
		}
		case "or":
			return unique([...queryLocator(descriptor.left, roots), ...queryLocator(descriptor.right, roots)]);
		case "filter":
			return queryLocator(descriptor.locator, roots).filter(element => {
				const text = textOf(element);
				if (descriptor.hasText && !patternMatches(descriptor.hasText, text)) return false;
				if (descriptor.hasNotText && patternMatches(descriptor.hasNotText, text)) return false;
				if (descriptor.visible !== undefined && isElementVisible(element) !== descriptor.visible) return false;
				if (descriptor.has && queryLocator(descriptor.has, [element]).length === 0) return false;
				if (descriptor.hasNot && queryLocator(descriptor.hasNot, [element]).length > 0) return false;
				return true;
			});
		case "nth": {
			const elements = queryLocator(descriptor.locator, roots);
			const index = descriptor.index < 0 ? elements.length + descriptor.index : descriptor.index;
			return index >= 0 && index < elements.length ? [elements[index]!] : [];
		}
	}
}

export function queryAriaLocator(descriptor: LocatorDescriptor): Element[] {
	beginDOMCaches();
	try {
		return queryLocator(descriptor, [document]);
	} finally {
		endDOMCaches();
	}
}

export function ariaElementState(element: Element): { role: string | null; name: string; hidden: boolean } {
	beginDOMCaches();
	try {
		return {
			role: locatorRole(element),
			name: normalizeText(getElementAccessibleName(element, false) || textOf(element)),
			hidden: isElementHiddenForAria(element) || isInertForAria(element),
		};
	} finally {
		endDOMCaches();
	}
}

export function ariaSnapshot(root: Element | null, request: AriaSnapshotRequest = {}): string {
	walkElements(el => {
		if ((el as RefElement)._ariaRef) delete (el as RefElement)._ariaRef;
	});
	const target = root ?? document.body ?? document.documentElement;
	const options = { mode: "ai", depth: request.depth, boxes: request.boxes } as const;
	const tree = generateAriaTree(target, options);
	return renderAriaTree(tree, options).text;
}

export function resolveAriaRef(ref: string): Element | null {
	let found: Element | null = null;
	walkElements(el => {
		if (!found && (el as RefElement)._ariaRef?.ref === ref) found = el;
	});
	return found;
}
`;

async function main(): Promise<void> {
	const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-aria-"));
	try {
		// Fetch pinned upstream sources into the temp dir.
		for (const [src, dst] of VENDOR_FILES) {
			const url = `${RAW_BASE}/${src}`;
			const res = await fetch(url);
			if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
			await Bun.write(path.join(tmp, dst), await res.text());
		}
		const entry = path.join(tmp, "entry.ts");
		await Bun.write(entry, ENTRY_SOURCE);

		// The injected sources import isomorphic modules via the `@isomorphic/*`
		// alias and the `yaml` package (type-only). Resolve the alias to the fetched
		// copies and stub `yaml` (only referenced from erased `import type`).
		const aliasPlugin: Bun.BunPlugin = {
			name: "aria-vendor-alias",
			setup(build) {
				build.onResolve({ filter: /^@isomorphic\// }, args => ({
					path: path.join(tmp, "isomorphic", `${args.path.slice("@isomorphic/".length)}.ts`),
				}));
				build.onResolve({ filter: /^yaml$/ }, () => ({ path: "yaml", namespace: "aria-yaml-stub" }));
				build.onLoad({ filter: /.*/, namespace: "aria-yaml-stub" }, () => ({
					contents: "export {};",
					loader: "ts",
				}));
			},
		};

		const result = await Bun.build({
			entrypoints: [entry],
			target: "browser",
			format: "cjs",
			minify: true,
			plugins: [aliasPlugin],
		});
		if (!result.success) {
			for (const log of result.logs) console.error(log);
			throw new Error("aria snapshot bundle failed");
		}
		const code = await result.outputs[0].text();
		const header = `// @generated by scripts/generate-aria-snapshot.ts from Playwright ${PLAYWRIGHT_TAG}\n// Bundled from Playwright's injected ARIA-snapshot sources (Apache-2.0, (c) Microsoft).\n// Do not edit by hand. Regenerate with: bun scripts/generate-aria-snapshot.ts\n`;
		await Bun.write(OUTPUT, header + code);
		console.log(`bundled ${path.relative(process.cwd(), OUTPUT)} (${code.length}b)`);
	} finally {
		await fs.rm(tmp, { recursive: true, force: true });
	}
}

await main();
