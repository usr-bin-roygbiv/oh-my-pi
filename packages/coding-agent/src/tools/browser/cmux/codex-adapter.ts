import { ToolError } from "../../tool-errors";
import { buildAriaRuntimeInstallerSource } from "../aria/aria-snapshot";
import {
	BrowserCapabilityError,
	CODEX_BROWSER_CAPABILITIES,
	type CodexBrowserAdapter,
	type CodexBrowserOperation,
	type CodexElementInfo,
	type CodexLocatorDescriptor,
	type CodexTabSummary,
	type CodexTextPattern,
	type CodexVisibleDom,
} from "../codex-facade";
import type { CmuxTab } from "./cmux-tab";

const CMUX_DEV_LOGS_CAPABILITY = CODEX_BROWSER_CAPABILITIES.DEV_LOGS;

function isUnavailableRpc(error: unknown, methods: string | readonly string[]): boolean {
	const message = error instanceof Error ? error.message : String(error);
	const unavailable =
		/^(?:method_not_found|unknown_method|unsupported_method|not_implemented):\s*([A-Za-z0-9_.-]+)\s*$/i.exec(
			message,
		) ?? /^(?:unknown|unsupported) (?:command|method):?\s+([A-Za-z0-9_.-]+)\s*$/i.exec(message);
	if (!unavailable) return false;
	const unavailableMethod = unavailable[1]?.toLowerCase();
	return typeof methods === "string"
		? methods.toLowerCase() === unavailableMethod
		: methods.some(method => method.toLowerCase() === unavailableMethod);
}

const SELECTOR_TIMEOUT_MS = 3_000;
const NAVIGATION_TIMEOUT_MS = 10_000;

const INSTALL_ARIA_RUNTIME_SOURCE = buildAriaRuntimeInstallerSource();
const LOCATOR_EVALUATOR_SOURCE = `(descriptor, command, payload) => {
	const normalizeText = value => String(value ?? "").replace(/\\s+/g, " ").trim();
	const canonicalState = element => typeof globalThis.__ompCodexAriaState === "function" ? globalThis.__ompCodexAriaState(element) : null;
	const textOf = element => normalizeText(element.innerText ?? element.textContent ?? "");
	const patternMatches = (pattern, value) => {
		if (!pattern) return true;
		const normalized = normalizeText(value);
		if (pattern.kind === "regexp") return new RegExp(pattern.source, pattern.flags).test(normalized);
		const expected = normalizeText(pattern.value);
		return pattern.exact ? normalized === expected : normalized.toLocaleLowerCase().includes(expected.toLocaleLowerCase());
	};
	const viewOf = element => element?.ownerDocument?.defaultView || window;
	const accessibilityHidden = element => {
		if (canonicalState(element)?.hidden === true) return true;
		for (let current = element; current; current = current.parentElement) {
			if (current.hidden || current.inert === true || current.hasAttribute?.("inert") || current.getAttribute?.("aria-hidden") === "true") return true;
			const style = viewOf(current).getComputedStyle?.(current);
			if (style && (style.display === "none" || style.visibility === "hidden")) return true;
		}
		return false;
	};
	const visible = element => {
		if (!element || typeof element.getBoundingClientRect !== "function" || accessibilityHidden(element)) return false;
		const style = viewOf(element).getComputedStyle(element);
		const rect = element.getBoundingClientRect();
		return Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
	};
	const implicitRole = element => {
		const canonicalRole = canonicalState(element)?.role;
		if (typeof canonicalRole === "string") return canonicalRole;
		const explicit = String(element.getAttribute("role") || "").trim().split(/\\s+/)[0];
		if (explicit) return explicit;
		const tag = element.tagName.toLowerCase();
		if (tag === "button") return "button";
		if (tag === "a" && element.hasAttribute("href")) return "link";
		if (/^h[1-6]$/.test(tag)) return "heading";
		if (tag === "textarea") return "textbox";
		if (tag === "select") return element.multiple || element.hasAttribute?.("multiple") || Number(element.size ?? element.getAttribute?.("size")) > 1 ? "listbox" : "combobox";
		if (tag === "option") return "option";
		if (tag === "img") return element.getAttribute("alt") === "" ? null : "img";
		if (tag === "ul" || tag === "ol") return "list";
		if (tag === "li") return "listitem";
		if (tag !== "input") return null;
		const type = String(element.type || element.getAttribute("type") || "text").toLowerCase();
		if (["button", "submit", "reset", "image"].includes(type)) return "button";
		if (type === "checkbox") return "checkbox";
		if (type === "radio") return "radio";
		if (type === "range") return "slider";
		if (type === "number") return "spinbutton";
		if (["search", "text", "email", "tel", "url"].includes(type)) {
			if (element.hasAttribute?.("list")) return "combobox";
			return type === "search" ? "searchbox" : "textbox";
		}
		return null;
	};
	const labelledByText = element => {
		const labelledBy = element.getAttribute("aria-labelledby");
		return labelledBy
			? normalizeText(labelledBy.split(/\\s+/).map(id => element.ownerDocument?.getElementById(id)?.textContent || "").join(" "))
			: "";
	};
	const associatedLabelText = element => element.labels?.length ? normalizeText(Array.from(element.labels).map(label => textOf(label)).join(" ")) : "";
	const labelCandidates = element => [
		...Array.from(element.labels || [], label => textOf(label)),
		normalizeText(element.getAttribute("aria-label") || ""),
		labelledByText(element),
	].filter(Boolean);
	const valueName = element => String(element.tagName || "").toLowerCase() === "input" && ["button", "submit", "reset", "image"].includes(String(element.type || "text").toLowerCase()) ? normalizeText(element.value || "") : "";
	const descendantAlternative = element => normalizeText(Array.from(element.children || []).map(child => child.getAttribute?.("alt") || child.getAttribute?.("title") || "").filter(Boolean).join(" "));
	const accessibleName = element =>
		canonicalState(element)?.name ||
		labelledByText(element) ||
		normalizeText(element.getAttribute("aria-label") || "") ||
		associatedLabelText(element) ||
		normalizeText(element.getAttribute("alt") || element.getAttribute("title") || valueName(element) || textOf(element) || descendantAlternative(element));
	const isFrame = element => String(element?.tagName || "").toLowerCase() === "iframe" && "contentDocument" in element;
	const rootsFor = roots => roots.flatMap(root => {
		if (isFrame(root)) {
			try {
				if (!root.contentDocument) throw new Error("cross-origin frame is inaccessible");
				return [root.contentDocument];
			} catch { throw new Error("cross-origin frame is inaccessible"); }
		}
		return [root];
	});
	const descendants = roots => rootsFor(roots).flatMap(root => Array.from(root.querySelectorAll("*")));
	const unique = values => [...new Set(values)];
	const query = (value, roots = [document]) => {
		switch (value.kind) {
			case "css": return unique(rootsFor(roots).flatMap(root => Array.from(root.querySelectorAll(value.selector))));
			case "role": return descendants(roots).filter(element => !accessibilityHidden(element) && implicitRole(element) === value.role && patternMatches(value.name, accessibleName(element)));
			case "text": return descendants(roots).filter(element => !accessibilityHidden(element) && patternMatches(value.text, textOf(element)) && !Array.from(element.children).some(child => patternMatches(value.text, textOf(child))));
			case "label": return descendants(roots).filter(element => !accessibilityHidden(element) && labelCandidates(element).some(label => patternMatches(value.text, label)));
			case "placeholder": return descendants(roots).filter(element => !accessibilityHidden(element) && patternMatches(value.text, String(element.getAttribute("placeholder") || "")));
			case "testId": return unique(rootsFor(roots).flatMap(root => Array.from(root.querySelectorAll('[data-testid="' + CSS.escape(value.testId) + '"]'))));
			case "frame": return unique(rootsFor(roots).flatMap(root => Array.from(root.querySelectorAll(value.selector)).filter(isFrame)));
			case "within": return query(value.child, query(value.parent, roots));
			case "and": {
				const right = new Set(query(value.right, roots));
				return query(value.left, roots).filter(element => right.has(element));
			}
			case "or": return unique([...query(value.left, roots), ...query(value.right, roots)]);
			case "filter": return query(value.locator, roots).filter(element => {
				const text = textOf(element);
				if (value.hasText && !patternMatches(value.hasText, text)) return false;
				if (value.hasNotText && patternMatches(value.hasNotText, text)) return false;
				if (value.visible !== undefined && visible(element) !== value.visible) return false;
				if (value.has && query(value.has, [element]).length === 0) return false;
				if (value.hasNot && query(value.hasNot, [element]).length > 0) return false;
				return true;
			});
			case "nth": {
				const values = query(value.locator, roots);
				const index = value.index < 0 ? values.length + value.index : value.index;
				return index >= 0 && index < values.length ? [values[index]] : [];
			}
		}
		return [];
	};
	const elements = typeof globalThis.__ompCodexAriaQuery === "function" ? globalThis.__ompCodexAriaQuery(descriptor) : query(descriptor);
	const element = elements[0];
	if (command === "status") return { attached: elements.length > 0, visible: !!element && visible(element), enabled: !!element && !element.disabled && element.getAttribute("aria-disabled") !== "true" };
	if (command === "count") return elements.length;
	if (command === "allTextContents") return elements.map(item => String(item.textContent ?? ""));
	if (command === "isVisible") return !!element && visible(element);
	if (command === "isEnabled") return !!element && !element.disabled && element.getAttribute("aria-disabled") !== "true";
	if (!element) throw new Error("Locator did not resolve to an element");
	if (command === "bindNativeSelector") {
		const token = String(payload.token || "");
		if (!/^[A-Za-z0-9-]+$/.test(token)) throw new Error("Invalid native action token");
		element.setAttribute("data-omp-codex-action-token", token);
		return '[data-omp-codex-action-token="' + token + '"]';
	}
	if (command === "armNativeFileActivation") {
		const isFileInput = String(element.tagName || "").toLowerCase() === "input" && String(element.type || element.getAttribute("type") || "").toLowerCase() === "file";
		if (!isFileInput) return false;
		const state = globalThis.__ompCodexBrowserState;
		if (!state || state.active !== true) throw new Error("Browser file chooser observer is unavailable");
		state.nativeActivationTarget = element;
		return true;
	}
	if (command === "getAttribute") return element.getAttribute(payload.name);
	if (command === "innerText") return String(element.innerText ?? "");
	if (command === "textContent") return element.textContent;
	if (command === "mediaUrl") return String(element.currentSrc || element.src || element.href || element.getAttribute("src") || element.getAttribute("href") || "");
	const dispatch = (target, type, init = {}) => {
		const EventConstructor = viewOf(target).Event;
		return target.dispatchEvent(new EventConstructor(type, { bubbles: true, cancelable: true, ...init }));
	};
	const mouse = (target, type, init = {}) => {
		const view = viewOf(target);
		return target.dispatchEvent(new view.MouseEvent(type, { bubbles: true, cancelable: true, view, ...init }));
	};
	const editable = target => {
		if (target.disabled || target.readOnly || String(target.getAttribute?.("aria-readonly") || "").trim().toLocaleLowerCase() === "true") return false;
		const tag = String(target.tagName || "").toLowerCase();
		if (tag === "textarea") return true;
		if (tag === "input") {
			const type = String(target.type || target.getAttribute("type") || "text").toLowerCase();
			return !["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"].includes(type);
		}
		return target.isContentEditable === true;
	};
	if (command === "editableValue") {
		if (!editable(element)) throw new Error("locator.type requires an editable element");
		return String(element.value ?? element.textContent ?? "");
	}
	const setValue = (target, value, append, label) => {
		if (!editable(target)) throw new Error(label + " requires an editable element");
		const next = append ? String(target.value ?? target.textContent ?? "") + value : value;
		const tag = String(target.tagName || "").toLowerCase();
		if (tag === "input" || tag === "textarea") {
			const view = viewOf(target);
			const prototype = tag === "textarea" ? view.HTMLTextAreaElement?.prototype : view.HTMLInputElement?.prototype;
			const setter = prototype ? Object.getOwnPropertyDescriptor(prototype, "value")?.set : undefined;
			if (setter) setter.call(target, next); else target.value = next;
			if (String(target.value) !== next) throw new Error(label + " could not update the editable value");
		} else {
			target.textContent = next;
			if (String(target.textContent ?? "") !== next) throw new Error(label + " could not update contenteditable text");
		}
		dispatch(target, "input");
		dispatch(target, "change");
	};
	if (command === "selectOption") {
		if (String(element.tagName || "").toLowerCase() !== "select") throw new Error("locator.selectOption requires a select element");
		const options = Array.from(element.options);
		const resolved = payload.selections.map(selection => options.find(option => selection.value !== undefined ? option.value === selection.value : selection.label !== undefined ? option.label === selection.label : option.index === selection.index));
		if (resolved.some(option => !option)) throw new Error("locator.selectOption could not resolve every requested option");
		const selected = new Set(element.multiple ? resolved : resolved.slice(0, 1));
		for (const option of options) option.selected = selected.has(option);
		dispatch(element, "input");
		dispatch(element, "change");
		return Array.from(element.selectedOptions).map(option => option.value);
	}
	if (command === "fill" || command === "type") {
		setValue(element, String(payload.value), command === "type", "locator." + command);
		return true;
	}
	element.scrollIntoView({ block: "center", inline: "center" });
	if (typeof element.focus === "function") element.focus();
	if (command === "focus") return true;
	const assertReceivesPointerAtCenter = target => {
		if (accessibilityHidden(target) || target.disabled || target.getAttribute?.("aria-disabled") === "true") throw new Error("Locator target is not actionable");
		const rect = target.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) throw new Error("Locator target is not actionable");
		const ownerDocument = target.ownerDocument || document;
		const hit = ownerDocument.elementFromPoint?.((rect.left ?? rect.x) + rect.width / 2, (rect.top ?? rect.y) + rect.height / 2);
		for (let current = hit; current; current = current.parentElement) {
			if (current === target) return;
		}
		throw new Error("Locator target does not receive pointer events at its center");
	};
	if (command === "click" || command === "dblclick") {
		assertReceivesPointerAtCenter(element);
		const button = payload.button === "middle" ? 1 : payload.button === "right" ? 2 : 0;
		const modifiers = new Set(payload.modifiers || []);
		const platform = String(navigator?.userAgentData?.platform || navigator?.platform || "");
		const applePlatform = /Mac|iPhone|iPad|iPod/i.test(platform);
		const primaryModifier = modifiers.has("ControlOrMeta");
		const init = { button, buttons: 1 << button, altKey: modifiers.has("Alt"), ctrlKey: modifiers.has("Control") || (primaryModifier && !applePlatform), metaKey: modifiers.has("Meta") || (primaryModifier && applePlatform), shiftKey: modifiers.has("Shift") };
		const clicks = command === "dblclick" ? 2 : 1;
		for (let index = 0; index < clicks; index++) {
			mouse(element, "mousedown", init);
			mouse(element, "mouseup", { ...init, buttons: 0 });
			mouse(element, "click", { ...init, buttons: 0, detail: index + 1 });
		}
		if (command === "dblclick") mouse(element, "dblclick", { ...init, buttons: 0, detail: 2 });
		return true;
	}
	if (command === "setChecked") {
		if (String(element.tagName || "").toLowerCase() !== "input" || !["checkbox", "radio"].includes(element.type)) throw new Error("locator.setChecked requires a checkbox or radio element");
		element.checked = !!payload.checked; dispatch(element, "input"); dispatch(element, "change"); return true;
	}
	throw new Error("Unsupported locator command " + command);
}`;

const DISPOSE_NATIVE_ACTION_TOKEN_SOURCE = `(token) => {
	for (const element of document.querySelectorAll("[data-omp-codex-action-token]")) {
		if (element.getAttribute("data-omp-codex-action-token") === token) element.removeAttribute("data-omp-codex-action-token");
	}
	return true;
}`;

const DISARM_NATIVE_FILE_ACTIVATION_SOURCE = `() => {
	const state = globalThis.__ompCodexBrowserState;
	if (state) state.nativeActivationTarget = null;
	return true;
}`;

const ELEMENT_INFO_SOURCE = `(x, y, includeNonInteractable) => {
	const textOf = element => String(element.innerText ?? element.textContent ?? "").replace(/\\s+/g, " ").trim();
	const canonicalState = element => typeof globalThis.__ompCodexAriaState === "function" ? globalThis.__ompCodexAriaState(element) : null;
	const viewOf = element => element?.ownerDocument?.defaultView || window;
	const accessibilityHidden = element => {
		if (canonicalState(element)?.hidden === true) return true;
		for (let current = element; current; current = current.parentElement) {
			if (current.hidden || current.inert === true || current.hasAttribute?.("inert") || current.getAttribute?.("aria-hidden") === "true") return true;
			const style = viewOf(current).getComputedStyle?.(current);
			if (style && (style.display === "none" || style.visibility === "hidden")) return true;
		}
		return false;
	};
	const implicitRole = element => {
		const canonicalRole = canonicalState(element)?.role;
		if (typeof canonicalRole === "string") return canonicalRole;
		const explicit = String(element.getAttribute("role") || "").trim().split(/\\s+/)[0];
		if (explicit) return explicit;
		const tag = element.tagName.toLowerCase();
		if (tag === "button") return "button";
		if (tag === "a" && element.hasAttribute("href")) return "link";
		if (/^h[1-6]$/.test(tag)) return "heading";
		if (tag === "textarea") return "textbox";
		if (tag === "select") return element.multiple || element.hasAttribute?.("multiple") || Number(element.size ?? element.getAttribute?.("size")) > 1 ? "listbox" : "combobox";
		if (tag === "option") return "option";
		if (tag === "img") return element.getAttribute("alt") === "" ? null : "img";
		if (tag === "ul" || tag === "ol") return "list";
		if (tag === "li") return "listitem";
		if (tag !== "input") return null;
		const type = String(element.type || element.getAttribute("type") || "text").toLowerCase();
		if (["button", "submit", "reset", "image"].includes(type)) return "button";
		if (type === "checkbox") return "checkbox";
		if (type === "radio") return "radio";
		if (type === "range") return "slider";
		if (type === "number") return "spinbutton";
		if (["search", "text", "email", "tel", "url"].includes(type)) {
			if (element.hasAttribute?.("list")) return "combobox";
			return type === "search" ? "searchbox" : "textbox";
		}
		return null;
	};
	const interactiveRoles = { button: true, checkbox: true, combobox: true, gridcell: true, link: true, listbox: true, menuitem: true, menuitemcheckbox: true, menuitemradio: true, option: true, radio: true, scrollbar: true, searchbox: true, slider: true, spinbutton: true, switch: true, tab: true, textbox: true, treeitem: true };
	const interactable = element => {
		const tag = element.tagName.toLowerCase();
		const role = implicitRole(element);
		return ["button", "input", "select", "textarea", "option"].includes(tag) || (tag === "a" && element.hasAttribute("href")) || interactiveRoles[role] === true || element.hasAttribute("tabindex") || element.tabIndex >= 0 || element.isContentEditable === true || element.hasAttribute("contenteditable");
	};
	const labelledByText = element => {
		const labelledBy = element.getAttribute("aria-labelledby");
		return labelledBy
			? labelledBy.split(/\\s+/).map(id => element.ownerDocument?.getElementById?.(id)?.textContent || "").join(" ").trim()
			: "";
	};
	const associatedLabelText = element => element.labels?.length
		? Array.from(element.labels).map(label => textOf(label)).join(" ").trim()
		: "";
	const valueName = element => String(element.tagName || "").toLowerCase() === "input" && ["button", "submit", "reset", "image"].includes(String(element.type || "text").toLowerCase()) ? String(element.value || "") : "";
	const descendantAlternative = element => String(Array.from(element.children || []).map(child => child.getAttribute?.("alt") || child.getAttribute?.("title") || "").filter(Boolean).join(" ")).replace(/\\s+/g, " ").trim();
	const accessibleName = element =>
		canonicalState(element)?.name ||
		labelledByText(element) ||
		String(element.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim() ||
		associatedLabelText(element) ||
		String(element.getAttribute("alt") || element.getAttribute("title") || valueName(element) || textOf(element) || descendantAlternative(element)).replace(/\\s+/g, " ").trim();
	let element = document.elementFromPoint(x, y);
	if (element && accessibilityHidden(element)) return [];
	if (!includeNonInteractable) {
		while (element && !interactable(element)) element = element.parentElement;
	}
	if (!element) return [];
	const text = textOf(element);
	const ariaName = accessibleName(element);
	const tagName = element.tagName.toLowerCase();
	const role = implicitRole(element);
	const id = element.getAttribute("id");
	const testId = element.getAttribute("data-testid");
	const primary = id ? "#" + CSS.escape(id) : testId ? '[data-testid="' + CSS.escape(testId) + '"]' : null;
	const candidates = primary ? [primary, tagName] : [tagName];
	const rect = element.getBoundingClientRect();
	return [{
		tagName,
		role,
		visibleText: text || null,
		ariaName: ariaName || null,
		testId,
		boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
		preview: element.outerHTML.slice(0, 1000),
		selector: { primary, candidates },
	}];
}`;

const VISIBLE_DOM_SOURCE = `() => {
	const textOf = element => String(element.innerText ?? element.textContent ?? "").replace(/\\s+/g, " ").trim();
	const canonicalState = element => typeof globalThis.__ompCodexAriaState === "function" ? globalThis.__ompCodexAriaState(element) : null;
	const viewOf = element => element?.ownerDocument?.defaultView || window;
	const accessibilityHidden = element => {
		if (canonicalState(element)?.hidden === true) return true;
		for (let current = element; current; current = current.parentElement) {
			if (current.hidden || current.inert === true || current.hasAttribute?.("inert") || current.getAttribute?.("aria-hidden") === "true") return true;
			const style = viewOf(current).getComputedStyle?.(current);
			if (style && (style.display === "none" || style.visibility === "hidden")) return true;
		}
		return false;
	};
	const implicitRole = element => {
		const canonicalRole = canonicalState(element)?.role;
		if (typeof canonicalRole === "string") return canonicalRole;
		const explicit = String(element.getAttribute("role") || "").trim().split(/\\s+/)[0];
		if (explicit) return explicit;
		const tag = element.tagName.toLowerCase();
		if (tag === "button") return "button";
		if (tag === "a" && element.hasAttribute("href")) return "link";
		if (/^h[1-6]$/.test(tag)) return "heading";
		if (tag === "textarea") return "textbox";
		if (tag === "select") return element.multiple || element.hasAttribute?.("multiple") || Number(element.size ?? element.getAttribute?.("size")) > 1 ? "listbox" : "combobox";
		if (tag === "option") return "option";
		if (tag === "img") return element.getAttribute("alt") === "" ? null : "img";
		if (tag === "ul" || tag === "ol") return "list";
		if (tag === "li") return "listitem";
		if (tag !== "input") return null;
		const type = String(element.type || element.getAttribute("type") || "text").toLowerCase();
		if (["button", "submit", "reset", "image"].includes(type)) return "button";
		if (type === "checkbox") return "checkbox";
		if (type === "radio") return "radio";
		if (type === "range") return "slider";
		if (type === "number") return "spinbutton";
		if (["search", "text", "email", "tel", "url"].includes(type)) {
			if (element.hasAttribute?.("list")) return "combobox";
			return type === "search" ? "searchbox" : "textbox";
		}
		return null;
	};
	const interactiveRoles = { button: true, checkbox: true, combobox: true, gridcell: true, link: true, listbox: true, menuitem: true, menuitemcheckbox: true, menuitemradio: true, option: true, radio: true, scrollbar: true, searchbox: true, slider: true, spinbutton: true, switch: true, tab: true, textbox: true, treeitem: true };
	const interactable = element => {
		const tag = element.tagName.toLowerCase();
		const role = implicitRole(element);
		return ["button", "input", "select", "textarea", "option"].includes(tag) || (tag === "a" && element.hasAttribute("href")) || interactiveRoles[role] === true || element.hasAttribute("tabindex") || element.tabIndex >= 0 || element.isContentEditable === true || element.hasAttribute("contenteditable");
	};
	const labelledByText = element => {
		const labelledBy = element.getAttribute("aria-labelledby");
		return labelledBy
			? labelledBy.split(/\\s+/).map(id => element.ownerDocument?.getElementById?.(id)?.textContent || "").join(" ").trim()
			: "";
	};
	const associatedLabelText = element => element.labels?.length
		? Array.from(element.labels).map(label => textOf(label)).join(" ").trim()
		: "";
	const valueName = element => String(element.tagName || "").toLowerCase() === "input" && ["button", "submit", "reset", "image"].includes(String(element.type || "text").toLowerCase()) ? String(element.value || "") : "";
	const descendantAlternative = element => String(Array.from(element.children || []).map(child => child.getAttribute?.("alt") || child.getAttribute?.("title") || "").filter(Boolean).join(" ")).replace(/\\s+/g, " ").trim();
	const accessibleName = element =>
		canonicalState(element)?.name ||
		labelledByText(element) ||
		String(element.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim() ||
		associatedLabelText(element) ||
		String(element.getAttribute("alt") || element.getAttribute("title") || valueName(element) || textOf(element) || descendantAlternative(element)).replace(/\\s+/g, " ").trim();
	const nodes = [];
	const refs = Object.create(null);
	for (const element of document.querySelectorAll("*")) {
		const node_id = element._ariaRef?.ref;
		if (typeof node_id !== "string" || !/^e\\d+$/.test(node_id) || !interactable(element) || accessibilityHidden(element)) continue;
		const role = implicitRole(element);
		const rect = element.getBoundingClientRect();
		const style = viewOf(element).getComputedStyle(element);
		if (Number(style.opacity) === 0 || rect.width <= 0 || rect.height <= 0) continue;
		refs[node_id] = element;
		nodes.push({
			node_id,
			tag: element.tagName.toLowerCase(),
			role,
			text: accessibleName(element),
			x: rect.x,
			y: rect.y,
			width: rect.width,
			height: rect.height,
		});
	}
	globalThis.__ompCodexDomRefs = refs;
	return { nodes };
}`;

const TYPE_ACTIVE_ELEMENT_SOURCE = `(text, label) => {
	const target = document.activeElement;
	if (!target || typeof target !== "object") throw new Error(label + " requires an editable active element");
	const tag = String(target.tagName || "").toLowerCase();
	const type = String(target.type || target.getAttribute?.("type") || "text").toLowerCase();
	const readOnly = target.readOnly || target.getAttribute?.("aria-readonly") === "true";
	const editableInput = tag === "input" && !target.disabled && !readOnly && !["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"].includes(type);
	const editableControl = editableInput || (tag === "textarea" && !target.disabled && !readOnly);
	if (!editableControl && !(target.isContentEditable === true && !readOnly)) throw new Error(label + " requires an editable active element");
	const ownerDocument = target.ownerDocument;
	const view = ownerDocument?.defaultView || window;
	const EventConstructor = view.InputEvent || view.Event || globalThis.InputEvent || globalThis.Event;
	const event = (type, cancelable) => new EventConstructor(type, { bubbles: true, cancelable, data: text, inputType: "insertText" });
	if (!target.dispatchEvent(event("beforeinput", true))) throw new Error(label + " beforeinput was cancelled");
	if (editableControl) {
		const current = String(target.value ?? "");
		if (typeof target.setRangeText === "function" && typeof target.selectionStart === "number" && typeof target.selectionEnd === "number") {
			target.setRangeText(text, target.selectionStart, target.selectionEnd, "end");
		} else {
			target.value = current + text;
			if (String(target.value) !== current + text) throw new Error(label + " could not update the editable value");
		}
		target.dispatchEvent(event("input", false));
		return true;
	}
	const selection = view.getSelection();
	let range = selection?.rangeCount ? selection.getRangeAt(0) : null;
	if (!range || !target.contains(range.commonAncestorContainer)) {
		range = ownerDocument.createRange();
		range.selectNodeContents(target);
		range.collapse(false);
	}
	range.deleteContents();
	const node = ownerDocument.createTextNode(text);
	range.insertNode(node);
	range.setStartAfter(node);
	range.collapse(true);
	selection.removeAllRanges();
	selection.addRange(range);
	target.dispatchEvent(event("input", false));
	return true;
}`;

const INSERT_ACTIVE_WHITESPACE_SOURCE = `(text) => {
	const target = document.activeElement;
	if (!target || typeof target !== "object") throw new Error("locator.type requires an editable active element");
	const tag = String(target.tagName || "").toLowerCase();
	const type = String(target.type || target.getAttribute?.("type") || "text").toLowerCase();
	const readOnly = target.readOnly || target.getAttribute?.("aria-readonly") === "true";
	const editableInput = tag === "input" && !target.disabled && !readOnly && !["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"].includes(type);
	if (!editableInput && !(tag === "textarea" && !target.disabled && !readOnly) && !(target.isContentEditable === true && !readOnly)) throw new Error("locator.type requires an editable active element");
	const ownerDocument = target.ownerDocument;
	const view = ownerDocument?.defaultView || window;
	const EventConstructor = view.InputEvent || view.Event || globalThis.InputEvent || globalThis.Event;
	const event = (type, cancelable) => new EventConstructor(type, { bubbles: true, cancelable, data: text, inputType: "insertText" });
	if (!target.dispatchEvent(event("beforeinput", true))) throw new Error("locator.type beforeinput was cancelled");
	if (editableInput || tag === "textarea") {
		const current = String(target.value ?? "");
		if (typeof target.setRangeText === "function" && typeof target.selectionStart === "number" && typeof target.selectionEnd === "number") {
			target.setRangeText(text, target.selectionStart, target.selectionEnd, "end");
		} else {
			target.value = current + text;
			if (String(target.value) !== current + text) throw new Error("locator.type could not update the editable value");
		}
		target.dispatchEvent(event("input", false));
		return true;
	}
	if (target.isContentEditable) {
		const selection = view.getSelection();
		let range = selection?.rangeCount ? selection.getRangeAt(0) : null;
		if (!range || !target.contains(range.commonAncestorContainer)) {
			range = ownerDocument.createRange();
			range.selectNodeContents(target);
			range.collapse(false);
		}
		range.deleteContents();
		const node = ownerDocument.createTextNode(text);
		range.insertNode(node);
		range.setStartAfter(node);
		range.collapse(true);
		selection.removeAllRanges();
		selection.addRange(range);
		target.dispatchEvent(event("input", false));
		return true;
	}
	throw new Error("locator.type requires an editable active element");
}`;

const INSTALL_PAGE_OBSERVERS_SOURCE = `(_preparation) => {
	if (!globalThis.__ompCodexBrowserState) {
		const tokenNamespace = String(_preparation) + "-" + String(globalThis.__ompCodexBrowserTokenSequence = (Number(globalThis.__ompCodexBrowserTokenSequence) || 0) + 1);
		const state = {
			tokenNamespace,
			nextToken: 1,
			fileEventSequence: 0,
			fileEvents: [],
			clickListener: null,
			nativeActivationTarget: null,
			active: true,
		};
		state.clickListener = event => {
			const target = event.target instanceof Element ? event.target : null;
			const input = target?.closest('input[type="file"]');
			if (!input) return;
			const nativeActivation = state.nativeActivationTarget === input;
			if (nativeActivation) state.nativeActivationTarget = null;
			queueMicrotask(() => {
				if (state.active !== true || (!event.isTrusted && !nativeActivation) || event.defaultPrevented || input.disabled === true || input.isConnected === false) return;
				const token = "file-" + state.tokenNamespace + "-" + state.nextToken++;
				input.setAttribute("data-omp-codex-file-token", token);
				state.fileEvents.push({ sequence: ++state.fileEventSequence, token, multiple: input.multiple === true });
				if (state.fileEvents.length > 32) state.fileEvents.splice(0, state.fileEvents.length - 32);
			});
		};
		document.addEventListener("click", state.clickListener, true);
		globalThis.__ompCodexBrowserState = state;
	}
	return globalThis.__ompCodexBrowserState.fileEventSequence;
}`;

const INSTALL_PAGE_RUNTIME_SOURCE = `(_preparation) => {
	(${INSTALL_ARIA_RUNTIME_SOURCE})();
	return (${INSTALL_PAGE_OBSERVERS_SOURCE})(_preparation);
}`;
const CLEANUP_PAGE_OBSERVERS_SOURCE = `() => {
	const state = globalThis.__ompCodexBrowserState;
	if (state) {
		state.active = false;
		if (state.clickListener) document.removeEventListener("click", state.clickListener, true);
	}
	for (const element of document.querySelectorAll("[data-omp-codex-file-token]")) {
		element.removeAttribute("data-omp-codex-file-token");
	}
	for (const element of document.querySelectorAll("[data-omp-codex-action-token]")) {
		element.removeAttribute("data-omp-codex-action-token");
	}
	const transfers = globalThis.__ompCodexMediaTransfers;
	if (transfers) for (const transfer of Object.values(transfers)) transfer?.controller?.abort();
	delete globalThis.__ompCodexMediaTransfers;
	delete globalThis.__ompCodexDomRefs;
	delete globalThis.__ompCodexBrowserState;
	delete globalThis.__ompCodexClipboardWrites;
	delete globalThis.__ompCodexBrowserTokenSequence;
	delete globalThis.__ompCodexAriaQuery;
	delete globalThis.__ompCodexAriaState;
	return true;
}`;

const READ_FILE_EVENT_AFTER_SOURCE = `(baseline) => {
	const event = globalThis.__ompCodexBrowserState?.fileEvents.find(event => event.sequence > baseline);
	return event ? { token: event.token, multiple: event.multiple } : null;
}`;

const DISPOSE_FILE_TOKEN_SOURCE = `(token) => {
	for (const element of document.querySelectorAll("[data-omp-codex-file-token]")) {
		if (element.getAttribute("data-omp-codex-file-token") === token) element.removeAttribute("data-omp-codex-file-token");
	}
	const state = globalThis.__ompCodexBrowserState;
	if (state) state.fileEvents = state.fileEvents.filter(event => event.token !== token);
	return true;
}`;

const START_PAGE_MEDIA_TRANSFER_SOURCE = `(url, token) => {
	const transfers = globalThis.__ompCodexMediaTransfers ||= Object.create(null);
	const controller = new AbortController();
	const transfer = transfers[token] = { done: false, error: null, result: null, controller };
	Promise.resolve().then(async () => {
		const absoluteUrl = new URL(url, document.baseURI).href;
		const response = await fetch(absoluteUrl, { credentials: "include", signal: controller.signal });
		if (!response.ok) throw new Error("downloadMedia failed with HTTP " + response.status);
		const maxBytes = 32 * 1024 * 1024;
		const contentLengthHeader = response.headers.get("content-length");
		const contentLength = contentLengthHeader !== null && /^\\d+$/.test(contentLengthHeader) ? Number(contentLengthHeader) : null;
		if (contentLength !== null && contentLength > maxBytes) throw new Error("downloadMedia response exceeds the 32 MiB limit");
		const base64Chunks = [];
		const append = bytes => {
			let binary = "";
			for (let inner = 0; inner < bytes.length; inner += 32768) binary += String.fromCharCode(...bytes.subarray(inner, Math.min(inner + 32768, bytes.length)));
			base64Chunks.push(btoa(binary));
		};
		if (response.body) {
			const reader = response.body.getReader();
			let received = 0;
			try {
				for (;;) {
					const chunk = await reader.read();
					if (chunk.done) break;
					if (received + chunk.value.byteLength > maxBytes) {
						try { await reader.cancel(); } catch {}
						throw new Error("downloadMedia response exceeds the 32 MiB limit");
					}
					received += chunk.value.byteLength;
					append(chunk.value);
				}
			} finally {
				reader.releaseLock();
			}
		} else {
			if (contentLength === null) throw new Error("downloadMedia requires Content-Length for a non-streaming response");
			const bytes = new Uint8Array(await response.arrayBuffer());
			if (bytes.byteLength > maxBytes) throw new Error("downloadMedia response exceeds the 32 MiB limit");
			append(bytes);
		}
		transfer.result = { url: response.url || absoluteUrl, contentType: response.headers.get("content-type"), base64Chunks };
	}, error => { throw error; }).catch(error => {
		transfer.error = (error && (error.stack || error.message)) || String(error);
	}).finally(() => { transfer.done = true; });
	return true;
}`;

const READ_PAGE_MEDIA_TRANSFER_SOURCE = `(token) => {
	const transfers = globalThis.__ompCodexMediaTransfers;
	const transfer = transfers?.[token];
	if (!transfer) throw new Error("downloadMedia page transfer state is unavailable");
	if (!transfer.done) return null;
	delete transfers[token];
	if (transfer.error) throw new Error(transfer.error);
	return transfer.result;
}`;

const DISPOSE_PAGE_MEDIA_TRANSFER_SOURCE = `(token) => {
	const transfers = globalThis.__ompCodexMediaTransfers;
	const transfer = transfers?.[token];
	if (transfer?.controller) transfer.controller.abort();
	if (transfers) delete transfers[token];
	return true;
}`;
const WRITE_TEXT_SOURCE = `(text) => {
	const textarea = document.createElement("textarea");
	textarea.value = text;
	textarea.setAttribute("readonly", "");
	textarea.style.position = "fixed";
	textarea.style.opacity = "0";
	document.body.appendChild(textarea);
	textarea.select();
	let copied = false;
	try { copied = typeof document.execCommand === "function" && document.execCommand("copy"); } catch {}
	textarea.remove();
	return copied;
}`;

const WRITE_CLIPBOARD_ITEMS_SOURCE = `(items, token) => {
	if (typeof navigator?.clipboard?.write !== "function" || typeof ClipboardItem !== "function" || typeof Blob !== "function") return false;
	if (items.some(item => item.entries.some(entry => entry.base64 !== undefined)) && typeof atob !== "function") return false;
	let clipboardItems;
	try {
		clipboardItems = items.map(item => {
			const data = Object.create(null);
			for (const entry of item.entries) {
				if (Object.prototype.hasOwnProperty.call(data, entry.mimeType)) throw new Error("duplicate clipboard MIME entry");
				if (entry.text !== undefined) data[entry.mimeType] = new Blob([entry.text], { type: entry.mimeType });
				else {
					const binary = atob(entry.base64);
					const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
					data[entry.mimeType] = new Blob([bytes], { type: entry.mimeType });
				}
			}
			return new ClipboardItem(data, { presentationStyle: item.presentationStyle });
		});
	} catch { return false; }
	const writes = globalThis.__ompCodexClipboardWrites ||= Object.create(null);
	const outcome = writes[token] = { done: false, error: null };
	let write;
	try { write = navigator.clipboard.write(clipboardItems); }
	catch (error) { delete writes[token]; throw error; }
	Promise.resolve(write).then(
		() => { outcome.done = true; },
		error => { outcome.error = (error && (error.stack || error.message)) || String(error); outcome.done = true; },
	);
	return true;
}`;

const CLIPBOARD_WRITE_STATUS_SOURCE = `(token) => {
	const writes = globalThis.__ompCodexClipboardWrites;
	const outcome = writes?.[token];
	if (!outcome) throw new Error("clipboard write state is unavailable");
	if (!outcome.done) return false;
	delete writes[token];
	if (outcome.error) throw new Error(outcome.error);
	return true;
}`;

const DISPOSE_CLIPBOARD_WRITE_SOURCE = `(token) => {
	const writes = globalThis.__ompCodexClipboardWrites;
	if (writes) delete writes[token];
	return true;
}`;

interface LocatorStatus {
	attached: boolean;
	visible: boolean;
	enabled: boolean;
}

interface FileEvent {
	token: string;
	multiple: boolean;
}

interface PageMediaTransferResult {
	url: string;
	contentType: string | null;
	base64Chunks: string[];
}

const MAX_DECODED_MEDIA_BYTES = 32 * 1024 * 1024;
const CANONICAL_BASE64_CHUNK = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function decodeBoundedMediaChunks(base64Chunks: readonly string[]): { chunks: Buffer[]; byteLength: number } {
	let byteLength = 0;
	for (const chunk of base64Chunks) {
		if (!CANONICAL_BASE64_CHUNK.test(chunk))
			throw new ToolError("downloadMedia page transfer returned invalid base64 data");
		const padding = chunk.endsWith("==") ? 2 : chunk.endsWith("=") ? 1 : 0;
		byteLength += (chunk.length / 4) * 3 - padding;
		if (byteLength > MAX_DECODED_MEDIA_BYTES) throw new ToolError("downloadMedia response exceeds the 32 MiB limit");
	}
	const chunks = base64Chunks.map(chunk => {
		const decoded = Buffer.from(chunk, "base64");
		if (decoded.toString("base64") !== chunk)
			throw new ToolError("downloadMedia page transfer returned invalid base64 data");
		return decoded;
	});
	return { chunks, byteLength };
}

interface NativeTabEntry {
	id: string;
	url?: string;
	title?: string;
	focused: boolean;
}

function remainingMs(deadline: number, operation: string): number {
	const remaining = Math.ceil(deadline - Date.now());
	if (remaining <= 0) throw new ToolError(`${operation} timed out`);
	return remaining;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function pageMediaTransferResult(value: unknown): PageMediaTransferResult {
	if (
		!isRecord(value) ||
		typeof value.url !== "string" ||
		(value.contentType !== null && typeof value.contentType !== "string") ||
		!Array.isArray(value.base64Chunks) ||
		value.base64Chunks.some(chunk => typeof chunk !== "string")
	) {
		throw new ToolError("downloadMedia page transfer returned an invalid result");
	}
	return value as unknown as PageMediaTransferResult;
}

function locatorStatus(value: unknown): LocatorStatus {
	if (value === true) return { attached: true, visible: true, enabled: true };
	if (!value || typeof value !== "object") return { attached: false, visible: false, enabled: false };
	return {
		attached: "attached" in value && value.attached === true,
		visible: "visible" in value && value.visible === true,
		enabled: "enabled" in value && value.enabled === true,
	};
}

function stringArg(args: Readonly<Record<string, unknown>>, key: string): string {
	const value = args[key];
	if (typeof value !== "string") throw new ToolError(`cmux agent.browser adapter expected ${key} to be a string`);
	return value;
}

function numberArg(args: Readonly<Record<string, unknown>>, key: string, fallback?: number): number {
	const value = args[key];
	if (value === undefined && fallback !== undefined) return fallback;
	if (typeof value !== "number" || !Number.isFinite(value))
		throw new ToolError(`cmux agent.browser adapter expected ${key} to be a number`);
	return value;
}

function selectorTimeoutArg(args: Readonly<Record<string, unknown>>): number {
	return Math.min(numberArg(args, "timeoutMs", SELECTOR_TIMEOUT_MS), SELECTOR_TIMEOUT_MS);
}

function stringArrayArg(args: Readonly<Record<string, unknown>>, key: string): string[] {
	const value = args[key];
	if (!Array.isArray(value) || value.some(item => typeof item !== "string")) {
		throw new ToolError(`cmux agent.browser adapter expected ${key} to be a string array`);
	}
	return value;
}

function locatorArg(args: Readonly<Record<string, unknown>>): CodexLocatorDescriptor {
	const value = args.locator;
	if (!value || typeof value !== "object" || !("kind" in value)) {
		throw new ToolError("cmux agent.browser adapter expected a locator descriptor");
	}
	return value as CodexLocatorDescriptor;
}

function textPatternArg(value: unknown): CodexTextPattern | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || !("kind" in value))
		throw new ToolError("cmux agent.browser adapter expected a text pattern");
	return value as CodexTextPattern;
}

function textPatternMatches(pattern: CodexTextPattern, value: string): boolean {
	if (pattern.kind === "regexp") return new RegExp(pattern.source, pattern.flags).test(value);
	return pattern.exact ? value === pattern.value : value.includes(pattern.value);
}

function waitUntilArg(value: unknown): "load" | "domcontentloaded" | "networkidle" | undefined {
	return value === "load" || value === "domcontentloaded" || value === "networkidle" ? value : undefined;
}

export class CmuxCodexBrowserAdapter implements CodexBrowserAdapter {
	readonly #tab: CmuxTab;
	#currentTabNumber = 1;
	#active = true;
	readonly #navigationCancels = new Map<string, () => void>();
	readonly #tokenNamespace = crypto.randomUUID();
	#sessionName: string;

	constructor(tab: CmuxTab) {
		this.#tab = tab;
		this.#sessionName = tab.surfaceId;
	}

	get currentTabId(): string {
		return String(this.#currentTabNumber);
	}

	async beginRun(): Promise<void> {
		await this.prepare();
	}

	async endRun(): Promise<void> {
		for (const cancel of this.#navigationCancels.values()) cancel();
		this.#navigationCancels.clear();
		await this.#cleanupPageState();
	}

	async dispose(): Promise<void> {
		await this.endRun();
	}

	async prepare(timeoutMs = SELECTOR_TIMEOUT_MS): Promise<number> {
		const fileEventSequence = await this.#tab.codexEvaluate<unknown>(
			INSTALL_PAGE_RUNTIME_SOURCE,
			[this.#tokenNamespace],
			timeoutMs,
		);
		if (typeof fileEventSequence !== "number" || !Number.isSafeInteger(fileEventSequence) || fileEventSequence < 0) {
			throw new ToolError("cmux browser observer returned an invalid file event sequence");
		}
		return fileEventSequence;
	}

	async #cleanupPageState(timeoutMs = SELECTOR_TIMEOUT_MS): Promise<void> {
		try {
			await this.#tab.codexEvaluateCleanup<boolean>(CLEANUP_PAGE_OBSERVERS_SOURCE, [], timeoutMs);
		} catch {
			await this.#tab.codexEvaluate<boolean>(CLEANUP_PAGE_OBSERVERS_SOURCE, [], timeoutMs).catch(() => undefined);
		}
	}

	async #disarmNativeFileActivation(): Promise<void> {
		try {
			await this.#tab.codexEvaluateCleanup<boolean>(DISARM_NATIVE_FILE_ACTIVATION_SOURCE, [], SELECTOR_TIMEOUT_MS);
		} catch {
			try {
				await this.#tab.codexEvaluate<boolean>(DISARM_NATIVE_FILE_ACTIVATION_SOURCE, [], SELECTOR_TIMEOUT_MS);
			} catch {
				// The page may have navigated before cleanup can run.
			}
		}
	}

	#assertCurrentTab(args: Readonly<Record<string, unknown>>): void {
		if (typeof args.tabId !== "string") return;
		if (this.#active && args.tabId === this.currentTabId) return;
		const current = this.#active ? this.currentTabId : "none";
		throw new Error(`Browser tab id ${args.tabId} is stale; current tab id is ${current}`);
	}

	async invoke<T>(operation: CodexBrowserOperation, args: Readonly<Record<string, unknown>>): Promise<T> {
		if (
			operation !== "browser.nameSession" &&
			operation !== "browser.user.openTabs" &&
			operation !== "browser.user.history" &&
			operation !== "tab.new" &&
			operation !== "tab.selected" &&
			operation !== "tab.list" &&
			operation !== "tab.get" &&
			operation !== "tabs.content"
		) {
			this.#assertCurrentTab(args);
		}

		switch (operation) {
			case "browser.nameSession":
				if (this.#sessionName !== stringArg(args, "name")) this.#sessionName = stringArg(args, "name");
				return undefined as T;
			case "browser.user.openTabs":
				return (await this.#openTabs()) as T;
			case "browser.user.history":
				throw new BrowserCapabilityError(CODEX_BROWSER_CAPABILITIES.USER_HISTORY);
			case "tab.new": {
				const nextTabNumber = this.#currentTabNumber + 1;
				await this.prepare();
				const summary = await this.#summary(String(nextTabNumber));
				this.#currentTabNumber = nextTabNumber;
				this.#active = true;
				return summary as T;
			}
			case "tab.selected":
				return (this.#active ? await this.#summary() : null) as T;
			case "tab.get":
				return (this.#active && args.id === this.currentTabId ? await this.#summary() : null) as T;
			case "tab.list":
				return (this.#active ? [await this.#summary()] : []) as T;
			case "tabs.content":
				return (await this.#content(args)) as T;
			case "tab.goto": {
				const deadline = Date.now() + numberArg(args, "timeoutMs", NAVIGATION_TIMEOUT_MS);
				await this.#tab.goto(stringArg(args, "url"), {
					waitUntil: "load",
					timeoutMs: remainingMs(deadline, "tab.goto"),
				});
				await this.prepare(remainingMs(deadline, "tab.goto"));
				return undefined as T;
			}
			case "tab.back":
				await this.#historyNavigation(-1, numberArg(args, "timeoutMs", NAVIGATION_TIMEOUT_MS));
				return undefined as T;
			case "tab.forward":
				await this.#historyNavigation(1, numberArg(args, "timeoutMs", NAVIGATION_TIMEOUT_MS));
				return undefined as T;
			case "tab.reload": {
				const timeoutMs = numberArg(args, "timeoutMs", NAVIGATION_TIMEOUT_MS);
				const deadline = Date.now() + timeoutMs;
				try {
					await this.#tab.codexRequest("browser.reload", {}, remainingMs(deadline, "tab.reload"));
				} catch (error) {
					if (isUnavailableRpc(error, "browser.reload")) {
						throw new BrowserCapabilityError(CODEX_BROWSER_CAPABILITIES.TAB_RELOAD);
					}
					throw error;
				}
				await this.prepare(remainingMs(deadline, "tab.reload"));
				return undefined as T;
			}
			case "tab.close":
				this.#active = false;
				return undefined as T;
			case "tab.title":
				return (await this.#tab.title()) as T;
			case "tab.url":
				return (await this.#tab.codexUrl(NAVIGATION_TIMEOUT_MS)) as T;
			case "tab.content.export":
				return (await this.#exportContent()) as T;
			case "tab.content.exportGsuite":
				throw new BrowserCapabilityError(CODEX_BROWSER_CAPABILITIES.CONTENT_EXPORT_GSUITE);
			case "tab.clipboard.read":
				throw new BrowserCapabilityError(CODEX_BROWSER_CAPABILITIES.CLIPBOARD_READ);
			case "tab.clipboard.readText":
				throw new BrowserCapabilityError(CODEX_BROWSER_CAPABILITIES.CLIPBOARD_READ_TEXT);
			case "tab.clipboard.writeText": {
				const copied = await this.#tab.codexEvaluate<boolean>(
					WRITE_TEXT_SOURCE,
					[stringArg(args, "text")],
					SELECTOR_TIMEOUT_MS,
				);
				if (!copied) throw new BrowserCapabilityError(CODEX_BROWSER_CAPABILITIES.CLIPBOARD_WRITE_TEXT);
				return undefined as T;
			}
			case "tab.clipboard.write": {
				const token = crypto.randomUUID();
				const deadline = Date.now() + SELECTOR_TIMEOUT_MS;
				let settled = false;
				try {
					const supported = await this.#tab.codexEvaluate<boolean>(
						WRITE_CLIPBOARD_ITEMS_SOURCE,
						[args.items, token],
						remainingMs(deadline, "tab.clipboard.write"),
					);
					if (!supported) {
						settled = true;
						throw new BrowserCapabilityError(CODEX_BROWSER_CAPABILITIES.CLIPBOARD_WRITE);
					}
					for (;;) {
						const timeout = remainingMs(deadline, "tab.clipboard.write");
						if (await this.#tab.codexEvaluate<boolean>(CLIPBOARD_WRITE_STATUS_SOURCE, [token], timeout)) {
							settled = true;
							return undefined as T;
						}
						await this.#tab.codexWait(Math.min(25, remainingMs(deadline, "tab.clipboard.write")));
					}
				} finally {
					if (!settled) {
						await this.#tab
							.codexEvaluateCleanup<boolean>(DISPOSE_CLIPBOARD_WRITE_SOURCE, [token], SELECTOR_TIMEOUT_MS)
							.catch(() => undefined);
					}
				}
			}
			case "tab.dev.logs":
				return (await this.#logs(args)) as T;
			case "playwright.domSnapshot": {
				const deadline = Date.now() + selectorTimeoutArg(args);
				return (await this.#tab.ariaSnapshot(
					undefined,
					{ preserveRefs: true },
					remainingMs(deadline, "playwright.domSnapshot"),
				)) as T;
			}
			case "playwright.elementInfo":
				return (await this.#elementInfo(args)) as T;
			case "playwright.elementScreenshot":
				throw new BrowserCapabilityError(CODEX_BROWSER_CAPABILITIES.ELEMENT_SCREENSHOT);
			case "playwright.screenshot":
				if (args.fullPage === true)
					throw new BrowserCapabilityError(CODEX_BROWSER_CAPABILITIES.SCREENSHOT_FULL_PAGE);
				if (args.clip !== undefined) throw new BrowserCapabilityError(CODEX_BROWSER_CAPABILITIES.SCREENSHOT_CLIP);
				return (await this.#tab.codexScreenshot(NAVIGATION_TIMEOUT_MS)) as T;
			case "playwright.waitForURL": {
				const state = waitUntilArg(args.waitUntil);
				if (state === "networkidle")
					throw new BrowserCapabilityError(CODEX_BROWSER_CAPABILITIES.WAIT_FOR_URL_NETWORKIDLE);
				const pattern = textPatternArg(args.url);
				if (!pattern) throw new ToolError("cmux agent.browser adapter expected a URL pattern");
				await this.#waitForUrl(pattern, state, numberArg(args, "timeoutMs", NAVIGATION_TIMEOUT_MS));
				return undefined as T;
			}
			case "playwright.waitForLoadState": {
				const state = waitUntilArg(args.state);
				if (state === "networkidle")
					throw new BrowserCapabilityError(CODEX_BROWSER_CAPABILITIES.WAIT_FOR_LOAD_STATE_NETWORKIDLE);
				await this.#tab.codexWaitForLoadState(state, numberArg(args, "timeoutMs", NAVIGATION_TIMEOUT_MS));
				return undefined as T;
			}
			case "playwright.waitForTimeout":
				await this.#tab.codexWait(numberArg(args, "timeoutMs"));
				return undefined as T;
			case "playwright.expectNavigation": {
				const state = waitUntilArg(args.waitUntil);
				if (state === "networkidle")
					throw new BrowserCapabilityError(CODEX_BROWSER_CAPABILITIES.EXPECT_NAVIGATION_NETWORKIDLE);
				await this.#expectNavigation(args);
				return undefined as T;
			}
			case "playwright.expectNavigation.cancel": {
				const navigationId = stringArg(args, "navigationId");
				this.#navigationCancels.get(navigationId)?.();
				this.#navigationCancels.delete(navigationId);
				return undefined as T;
			}
			case "playwright.waitForEvent":
				return (await this.#waitForEvent(args)) as T;
			case "playwright.download.path":
				return (await this.#downloadPath(args)) as T;
			case "playwright.fileChooser.setFiles":
				await this.#setFiles(args);
				return undefined as T;
			case "locator.count":
				return (await this.#locator<number>(locatorArg(args), "count", {}, selectorTimeoutArg(args))) as T;
			case "locator.allTextContents":
				return (await this.#locator<string[]>(
					locatorArg(args),
					"allTextContents",
					{},
					selectorTimeoutArg(args),
				)) as T;
			case "locator.isEnabled":
				return (await this.#locator<boolean>(locatorArg(args), "isEnabled", {}, selectorTimeoutArg(args))) as T;
			case "locator.isVisible":
				return (await this.#locator<boolean>(locatorArg(args), "isVisible", {}, selectorTimeoutArg(args))) as T;
			case "locator.waitFor":
				await this.#waitForLocator(
					locatorArg(args),
					stringArg(args, "state"),
					Date.now() + selectorTimeoutArg(args),
					"locator.waitFor",
				);
				return undefined as T;
			case "locator.click":
			case "locator.dblclick":
			case "locator.fill":
			case "locator.type":
			case "locator.press":
			case "locator.setChecked":
				await this.#locatorAction(operation, args);
				return undefined as T;
			case "locator.selectOption":
				return (await this.#locatorAction(operation, args)) as T;
			case "locator.getAttribute":
			case "locator.innerText":
			case "locator.textContent":
				return (await this.#locatorRead(operation, args)) as T;
			case "locator.downloadMedia":
				await this.#locatorDownload(args);
				return undefined as T;
			case "dom_cua.get_visible_dom":
				return (await this.#visibleDom(args)) as T;
			case "dom_cua.click":
			case "dom_cua.double_click": {
				const operationDeadline = Date.now() + selectorTimeoutArg(args);
				const handle = await this.#tab.ref(String(args.nodeId), remainingMs(operationDeadline, operation));
				if (operation === "dom_cua.click") await handle.click(remainingMs(operationDeadline, operation));
				else await handle.dblclick(remainingMs(operationDeadline, operation));
				return undefined as T;
			}
			case "dom_cua.scroll": {
				const operationDeadline = Date.now() + selectorTimeoutArg(args);
				if (args.nodeId !== undefined) {
					const handle = await this.#tab.ref(
						String(args.nodeId),
						remainingMs(operationDeadline, "dom_cua.scroll"),
					);
					await handle.evaluateWithTimeout(
						(element, x, y) => {
							if (
								!element ||
								typeof element !== "object" ||
								!("scrollBy" in element) ||
								typeof element.scrollBy !== "function"
							)
								throw new Error("DOM CUA node does not support scrolling");
							element.scrollBy(x, y);
						},
						[numberArg(args, "x"), numberArg(args, "y")],
						remainingMs(operationDeadline, "dom_cua.scroll"),
					);
				} else {
					await this.#tab.scroll(
						numberArg(args, "x"),
						numberArg(args, "y"),
						remainingMs(operationDeadline, "dom_cua.scroll"),
					);
				}
				return undefined as T;
			}
			case "dom_cua.type":
			case "cua.type": {
				const operationDeadline = Date.now() + selectorTimeoutArg(args);
				await this.#tab.codexEvaluate<boolean>(
					TYPE_ACTIVE_ELEMENT_SOURCE,
					[stringArg(args, "text"), operation],
					remainingMs(operationDeadline, operation),
				);
				return undefined as T;
			}
			case "dom_cua.keypress":
			case "cua.keypress":
				await this.#pressKeys(stringArrayArg(args, "keys"), Date.now() + selectorTimeoutArg(args), operation);
				return undefined as T;
			case "dom_cua.downloadMedia":
				await this.#domDownload(args);
				return undefined as T;
			case "cua.get_visible_screenshot":
				return { data: await this.#tab.codexScreenshot(NAVIGATION_TIMEOUT_MS) } as T;
			case "cua.click":
			case "cua.double_click":
			case "cua.drag":
			case "cua.move":
			case "cua.scroll":
				await this.#coordinateAction(operation, args);
				return undefined as T;
			case "cua.downloadMedia":
				await this.#coordinateDownload(args);
				return undefined as T;
		}
		throw new ToolError(`Unsupported cmux agent.browser operation: ${operation}`);
	}

	async #summary(id = this.currentTabId): Promise<CodexTabSummary> {
		return {
			id,
			url: await this.#tab.codexUrl(NAVIGATION_TIMEOUT_MS),
			title: await this.#tab.title(),
		};
	}

	async #nativeTabs(timeoutMs = SELECTOR_TIMEOUT_MS): Promise<NativeTabEntry[] | undefined> {
		const result = await this.#tab.codexRequest("browser.tab.list", {}, timeoutMs);
		if (!Array.isArray(result.tabs)) return undefined;
		return result.tabs.flatMap(value => {
			if (!isRecord(value) || typeof value.id !== "string") return [];
			return [
				{
					id: value.id,
					url: typeof value.url === "string" ? value.url : undefined,
					title: typeof value.title === "string" ? value.title : undefined,
					focused: value.focused === true,
				},
			];
		});
	}

	async #openTabs(): Promise<CodexTabSummary[]> {
		let tabs: NativeTabEntry[] | undefined;
		try {
			tabs = await this.#nativeTabs();
		} catch (error) {
			if (isUnavailableRpc(error, "browser.tab.list")) {
				throw new BrowserCapabilityError(CODEX_BROWSER_CAPABILITIES.USER_OPEN_TABS);
			}
			throw error;
		}
		if (!tabs) throw new BrowserCapabilityError(CODEX_BROWSER_CAPABILITIES.USER_OPEN_TABS);
		return tabs.map((tab, index) => ({ id: String(index + 1), url: tab.url, title: tab.title }));
	}

	async #exportContent(): Promise<string> {
		const html = await this.#tab.pageContent();
		const cwd = this.#tab.codexCwd().replace(/\/$/, "");
		const path = `${cwd}/agent-browser-export-${crypto.randomUUID()}.html`;
		await Bun.write(path, html);
		return path;
	}

	async #content(
		args: Readonly<Record<string, unknown>>,
	): Promise<Array<{ url: string; title: string | null; content: string | null }>> {
		const urls = stringArrayArg(args, "urls");
		const contentType = stringArg(args, "contentType");
		const timeoutMs = numberArg(args, "timeoutMs", NAVIGATION_TIMEOUT_MS);
		const results: Array<{ url: string; title: string | null; content: string | null }> = [];
		for (const url of urls) {
			const deadline = Date.now() + timeoutMs;
			const remainingTimeoutMs = (): number => {
				const remainingMs = Math.ceil(deadline - Date.now());
				if (remainingMs > 0) return remainingMs;
				throw new ToolError(`tabs.content timed out after ${timeoutMs}ms for ${url}`);
			};
			let focusedTabId: string | undefined;
			let temporarySurface: string | undefined;
			let distinctSplitSurface: string | undefined;
			let temporaryTabId: string | undefined;
			try {
				let before: NativeTabEntry[] | undefined;
				let nativeTabListingAvailable = true;
				try {
					before = await this.#nativeTabs(remainingTimeoutMs());
				} catch (error) {
					if (!isUnavailableRpc(error, "browser.tab.list")) throw error;
					nativeTabListingAvailable = false;
				}
				if (nativeTabListingAvailable) {
					if (!before) throw new ToolError("browser.tab.list returned an invalid tab list");
					focusedTabId = before.find(tab => tab.focused)?.id;
					const openedTab = await this.#tab.codexRequest("browser.tab.new", { url }, remainingTimeoutMs());
					temporarySurface = typeof openedTab.surface_id === "string" ? openedTab.surface_id : undefined;
					distinctSplitSurface = temporarySurface;
					const after = await this.#nativeTabs(remainingTimeoutMs());
					if (!after) throw new ToolError("browser.tab.list returned an invalid tab list");
					temporaryTabId = after.find(tab => !before.some(previous => previous.id === tab.id))?.id;
					if (temporaryTabId) distinctSplitSurface = undefined;
				}
				if (!temporarySurface) {
					const openedSurface = await this.#tab.codexRequest("browser.open_split", { url }, remainingTimeoutMs());
					temporarySurface = typeof openedSurface.surface_id === "string" ? openedSurface.surface_id : undefined;
					distinctSplitSurface = temporarySurface;
				}
				if (!temporarySurface) throw new BrowserCapabilityError(CODEX_BROWSER_CAPABILITIES.TABS_CONTENT);
				const waitTimeoutMs = remainingTimeoutMs();
				await this.#tab.codexRequest(
					"browser.wait",
					{ surface_id: temporarySurface, load_state: "complete", timeout_ms: waitTimeoutMs },
					waitTimeoutMs,
				);
				const snapshot = await this.#tab.codexRequest(
					"browser.snapshot",
					{ surface_id: temporarySurface, interactive: false, max_depth: 12 },
					remainingTimeoutMs(),
				);
				const page = isRecord(snapshot.page) ? snapshot.page : {};
				const title = typeof page.title === "string" ? page.title : null;
				let content: string | null;
				if (contentType === "domSnapshot") {
					content = typeof snapshot.snapshot === "string" ? snapshot.snapshot : null;
				} else {
					const script =
						contentType === "text"
							? "document.body?.innerText || ''"
							: "document.documentElement?.outerHTML || ''";
					const evaluated = await this.#tab.codexRequest(
						"browser.eval",
						{ surface_id: temporarySurface, script },
						remainingTimeoutMs(),
					);
					content = typeof evaluated.value === "string" ? evaluated.value : null;
				}
				results.push({ url, title, content });
			} catch (error) {
				if (
					isUnavailableRpc(error, [
						"browser.tab.new",
						"browser.open_split",
						"browser.wait",
						"browser.snapshot",
						"browser.eval",
					])
				) {
					throw new BrowserCapabilityError(CODEX_BROWSER_CAPABILITIES.TABS_CONTENT);
				}
				if (error instanceof BrowserCapabilityError) throw error;
				results.push({ url, title: null, content: null });
			} finally {
				if (temporaryTabId) {
					await this.#tab
						.codexCleanupRequest("browser.tab.close", { tab_id: temporaryTabId }, SELECTOR_TIMEOUT_MS)
						.catch(() => undefined);
				}
				if (distinctSplitSurface) {
					await this.#tab
						.codexCleanupRequest("surface.close", { surface_id: distinctSplitSurface }, SELECTOR_TIMEOUT_MS)
						.catch(() => undefined);
				}
				if (temporaryTabId && focusedTabId) {
					await this.#tab
						.codexCleanupRequest("browser.tab.switch", { tab_id: focusedTabId }, SELECTOR_TIMEOUT_MS)
						.catch(() => undefined);
				}
			}
		}
		return results;
	}

	async #logs(args: Readonly<Record<string, unknown>>): Promise<unknown[]> {
		let consoleResult: Record<string, unknown>;
		let errorResult: Record<string, unknown>;
		try {
			[consoleResult, errorResult] = await Promise.all([
				this.#tab.codexRequest("browser.console.list", {}, SELECTOR_TIMEOUT_MS),
				this.#tab.codexRequest("browser.errors.list", {}, SELECTOR_TIMEOUT_MS),
			]);
		} catch (error) {
			if (isUnavailableRpc(error, ["browser.console.list", "browser.errors.list"])) {
				throw new BrowserCapabilityError(CMUX_DEV_LOGS_CAPABILITY);
			}
			throw error;
		}
		if (
			!Array.isArray(consoleResult.entries) ||
			(!Array.isArray(errorResult.entries) && !Array.isArray(errorResult.errors))
		) {
			throw new BrowserCapabilityError(CMUX_DEV_LOGS_CAPABILITY);
		}
		const values = [consoleResult.entries, errorResult.entries, errorResult.errors].flatMap(value =>
			Array.isArray(value) ? value : [],
		);
		const filter = typeof args.filter === "string" ? args.filter : undefined;
		const levels = Array.isArray(args.levels)
			? new Set(args.levels.filter((value): value is string => typeof value === "string"))
			: undefined;
		const limit = Math.min(typeof args.limit === "number" ? args.limit : 1000, 1000);
		return values
			.filter(value => {
				if (!isRecord(value)) return false;
				const text =
					typeof value.text === "string" ? value.text : typeof value.message === "string" ? value.message : "";
				const level = typeof value.level === "string" ? value.level : "error";
				return (!filter || text.includes(filter)) && (!levels || levels.has(level));
			})
			.slice(-limit);
	}

	async #elementInfo(args: Readonly<Record<string, unknown>>): Promise<CodexElementInfo[]> {
		const value = await this.#tab.codexEvaluate<unknown>(
			ELEMENT_INFO_SOURCE,
			[numberArg(args, "x"), numberArg(args, "y"), args.includeNonInteractable === true],
			SELECTOR_TIMEOUT_MS,
		);
		if (Array.isArray(value)) return value as CodexElementInfo[];
		if (!isRecord(value)) return [];
		const attributes = isRecord(value.attributes) ? value.attributes : {};
		const id = typeof attributes.id === "string" ? attributes.id : undefined;
		const testId = typeof attributes["data-testid"] === "string" ? attributes["data-testid"] : null;
		const primary = id ? `#${id}` : testId ? `[data-testid="${testId}"]` : null;
		const box = value.boundingBox;
		const boundingBox =
			isRecord(box) &&
			typeof box.x === "number" &&
			typeof box.y === "number" &&
			typeof box.width === "number" &&
			typeof box.height === "number"
				? { x: box.x, y: box.y, width: box.width, height: box.height }
				: null;
		return [
			{
				tagName: typeof value.tagName === "string" ? value.tagName : "",
				role: typeof value.role === "string" ? value.role : null,
				visibleText: typeof value.text === "string" ? value.text : null,
				ariaName: typeof value.text === "string" ? value.text : null,
				testId,
				boundingBox,
				preview:
					typeof value.preview === "string"
						? value.preview
						: `<${typeof value.tagName === "string" ? value.tagName : "element"}>`,
				selector: { primary, candidates: primary ? [primary] : [] },
			},
		];
	}

	async #visibleDom(args: Readonly<Record<string, unknown>>): Promise<CodexVisibleDom> {
		const deadline = Date.now() + selectorTimeoutArg(args);
		await this.#cleanupPageState(remainingMs(deadline, "dom_cua.get_visible_dom"));
		await this.#tab.ariaSnapshot(undefined, { boxes: true }, remainingMs(deadline, "dom_cua.get_visible_dom"));
		const value = await this.#tab.codexEvaluate<unknown>(
			VISIBLE_DOM_SOURCE,
			[],
			remainingMs(deadline, "dom_cua.get_visible_dom"),
		);
		if (!isRecord(value) || !Array.isArray(value.nodes)) {
			throw new ToolError("cmux visible DOM returned an invalid result");
		}
		return value as unknown as CodexVisibleDom;
	}

	async #historyNavigation(delta: number, timeoutMs: number): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		const controller = new AbortController();
		const navigation = this.#tab
			.waitForNavigation({
				waitUntil: "load",
				timeout: remainingMs(deadline, "history navigation"),
				signal: controller.signal,
			})
			.then(
				() => ({ error: undefined }),
				(error: unknown) => ({ error }),
			);
		try {
			await this.#tab.codexEvaluate<boolean>(
				`delta => { history.go(delta); return true; }`,
				[delta],
				remainingMs(deadline, "history navigation"),
			);
			const outcome = await navigation;
			if (outcome.error !== undefined) throw outcome.error;
			await this.prepare(remainingMs(deadline, "history navigation"));
		} finally {
			controller.abort(new ToolError("history navigation settled"));
			await navigation;
		}
	}

	async #waitForUrl(
		pattern: CodexTextPattern,
		waitUntil: "load" | "domcontentloaded" | undefined,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (true) {
			const url = await this.#tab.codexUrl(remainingMs(deadline, "playwright.waitForURL"), signal);
			if (textPatternMatches(pattern, url)) {
				await this.#tab.codexWaitForLoadState(waitUntil, remainingMs(deadline, "playwright.waitForURL"), signal);
				return;
			}
			await this.#tab.codexWait(Math.min(50, remainingMs(deadline, "playwright.waitForURL")), signal);
		}
	}

	async #expectNavigation(args: Readonly<Record<string, unknown>>): Promise<void> {
		const timeoutMs = numberArg(args, "timeoutMs", NAVIGATION_TIMEOUT_MS);
		const deadline = Date.now() + timeoutMs;
		const state = waitUntilArg(args.waitUntil);
		if (state === "networkidle")
			throw new BrowserCapabilityError(CODEX_BROWSER_CAPABILITIES.EXPECT_NAVIGATION_NETWORKIDLE);
		const navigationId = stringArg(args, "navigationId");
		const controller = new AbortController();
		let cancelled = false;
		this.#navigationCancels.set(navigationId, () => {
			cancelled = true;
			controller.abort(new ToolError("playwright.expectNavigation canceled"));
		});
		try {
			await this.#tab.waitForNavigation({
				waitUntil: state,
				timeout: remainingMs(deadline, "playwright.expectNavigation"),
				signal: controller.signal,
			});
			const pattern = textPatternArg(args.url);
			if (pattern) {
				await this.#waitForUrl(
					pattern,
					state,
					remainingMs(deadline, "playwright.expectNavigation"),
					controller.signal,
				);
			}
		} catch (error) {
			if (!cancelled) throw error;
		} finally {
			this.#navigationCancels.delete(navigationId);
		}
	}

	async #waitForEvent(args: Readonly<Record<string, unknown>>): Promise<{ token: string; multiple?: boolean }> {
		const event = stringArg(args, "event");
		const timeoutMs = selectorTimeoutArg(args);
		if (event === "download") {
			throw new BrowserCapabilityError(CODEX_BROWSER_CAPABILITIES.WAIT_FOR_EVENT);
		}
		const deadline = Date.now() + timeoutMs;
		try {
			const baseline = await this.prepare(remainingMs(deadline, "playwright.waitForEvent"));
			while (true) {
				const result = await this.#tab.codexEvaluate<FileEvent | null>(
					READ_FILE_EVENT_AFTER_SOURCE,
					[baseline],
					remainingMs(deadline, "playwright.waitForEvent"),
				);
				if (result) return result;
				await this.#tab.codexWait(Math.min(50, remainingMs(deadline, "playwright.waitForEvent")));
			}
		} catch (error) {
			await this.#cleanupPageState().catch(() => undefined);
			throw error;
		}
	}

	async #downloadPath(args: Readonly<Record<string, unknown>>): Promise<string | null> {
		stringArg(args, "token");
		return null;
	}

	async #setFiles(args: Readonly<Record<string, unknown>>): Promise<void> {
		const deadline = Date.now() + selectorTimeoutArg(args);
		const token = stringArg(args, "token");
		try {
			await this.#tab.codexUploadFile(
				`input[data-omp-codex-file-token="${token}"]`,
				stringArrayArg(args, "files"),
				remainingMs(deadline, "playwright.fileChooser.setFiles"),
			);
		} finally {
			await this.#tab
				.codexEvaluateCleanup<boolean>(DISPOSE_FILE_TOKEN_SOURCE, [token], SELECTOR_TIMEOUT_MS)
				.catch(() => undefined);
		}
	}

	async #locator<TResult>(
		descriptor: CodexLocatorDescriptor,
		command: string,
		payload: Readonly<Record<string, unknown>>,
		timeoutMs: number,
	): Promise<TResult> {
		try {
			return await this.#tab.codexEvaluate<TResult>(
				LOCATOR_EVALUATOR_SOURCE,
				[descriptor, command, payload],
				timeoutMs,
			);
		} catch (error) {
			if (
				this.#containsFrame(descriptor) &&
				error instanceof Error &&
				/cross-origin|denied|inaccessible/i.test(error.message)
			) {
				throw new BrowserCapabilityError(CODEX_BROWSER_CAPABILITIES.FRAME_LOCATOR_CROSS_ORIGIN);
			}
			throw error;
		}
	}

	#containsFrame(descriptor: CodexLocatorDescriptor): boolean {
		if (descriptor.kind === "frame") return true;
		if (descriptor.kind === "within")
			return this.#containsFrame(descriptor.parent) || this.#containsFrame(descriptor.child);
		if (descriptor.kind === "and" || descriptor.kind === "or")
			return this.#containsFrame(descriptor.left) || this.#containsFrame(descriptor.right);
		if (descriptor.kind === "filter")
			return (
				this.#containsFrame(descriptor.locator) ||
				(!!descriptor.has && this.#containsFrame(descriptor.has)) ||
				(!!descriptor.hasNot && this.#containsFrame(descriptor.hasNot))
			);
		if (descriptor.kind === "nth") return this.#containsFrame(descriptor.locator);
		return false;
	}

	async #waitForLocator(
		descriptor: CodexLocatorDescriptor,
		state: string,
		deadline: number,
		operation: string,
	): Promise<LocatorStatus> {
		while (true) {
			const status = locatorStatus(
				await this.#locator<unknown>(descriptor, "status", {}, remainingMs(deadline, operation)),
			);
			if (
				(state === "attached" && status.attached) ||
				(state === "detached" && !status.attached) ||
				(state === "visible" && status.visible) ||
				(state === "actionable" && status.visible && status.enabled) ||
				(state === "hidden" && !status.visible)
			)
				return status;
			await this.#tab.codexWait(Math.min(50, remainingMs(deadline, operation)));
		}
	}

	#cssSelector(descriptor: CodexLocatorDescriptor): string | undefined {
		return descriptor.kind === "css" ? descriptor.selector : undefined;
	}

	async #locatorAction(operation: CodexBrowserOperation, args: Readonly<Record<string, unknown>>): Promise<unknown> {
		const descriptor = locatorArg(args);
		const timeoutMs = selectorTimeoutArg(args);
		const deadline = Date.now() + timeoutMs;
		const nativeClick = operation === "locator.click" || operation === "locator.dblclick";
		if (
			nativeClick &&
			(args.force === true ||
				(args.button !== undefined && args.button !== "left") ||
				(Array.isArray(args.modifiers) && args.modifiers.length > 0))
		) {
			throw new BrowserCapabilityError(CODEX_BROWSER_CAPABILITIES.LOCATOR_CLICK_OPTIONS);
		}
		await this.#waitForLocator(descriptor, args.force === true ? "attached" : "actionable", deadline, operation);
		const selector = this.#cssSelector(descriptor);
		if (nativeClick) {
			let nativeSelector = selector;
			let token: string | undefined;
			if (!nativeSelector) {
				token = crypto.randomUUID();
				nativeSelector = await this.#locator<string>(
					descriptor,
					"bindNativeSelector",
					{ token },
					remainingMs(deadline, operation),
				);
			}
			const fileActivationArmed = await this.#locator<boolean>(
				descriptor,
				"armNativeFileActivation",
				{},
				remainingMs(deadline, operation),
			);
			try {
				if (operation === "locator.click") await this.#tab.click(nativeSelector, remainingMs(deadline, operation));
				else await this.#tab.dblclick(nativeSelector, remainingMs(deadline, operation));
				return undefined;
			} finally {
				if (fileActivationArmed) await this.#disarmNativeFileActivation();
				if (token) {
					await this.#tab
						.codexEvaluateCleanup<boolean>(DISPOSE_NATIVE_ACTION_TOKEN_SOURCE, [token], SELECTOR_TIMEOUT_MS)
						.catch(() => undefined);
				}
			}
		}
		if (operation === "locator.type" && selector) {
			const value = stringArg(args, "value");
			const before = await this.#locator<unknown>(descriptor, "editableValue", {}, remainingMs(deadline, operation));
			await this.#nativeTypeExact(selector, value, deadline);
			const after = await this.#locator<unknown>(descriptor, "editableValue", {}, remainingMs(deadline, operation));
			if (typeof before === "string" && typeof after === "string" && after !== before + value) {
				throw new Error("locator.type did not update the editable value");
			}
			return undefined;
		}
		if (operation === "locator.press") {
			if (selector) await this.#tab.focus(selector, remainingMs(deadline, operation));
			else await this.#locator<boolean>(descriptor, "focus", {}, remainingMs(deadline, operation));
			await this.#tab.press(stringArg(args, "value"), { timeoutMs: remainingMs(deadline, operation) });
			return undefined;
		}
		return await this.#locator<unknown>(
			descriptor,
			operation.slice("locator.".length),
			args,
			remainingMs(deadline, operation),
		);
	}

	async #nativeTypeExact(selector: string, value: string, deadline: number): Promise<void> {
		const leading = value.match(/^[ \t\r\n]+/)?.[0] ?? "";
		const afterLeading = value.slice(leading.length);
		const trailing = afterLeading.match(/[ \t\r\n]+$/)?.[0] ?? "";
		const body = afterLeading.slice(0, afterLeading.length - trailing.length);
		if (!leading && !trailing) {
			await this.#tab.type(selector, value, remainingMs(deadline, "locator.type"));
			return;
		}
		await this.#tab.focus(selector, remainingMs(deadline, "locator.type"));
		await this.#insertTypedWhitespace(leading, deadline);
		if (body) await this.#tab.type(selector, body, remainingMs(deadline, "locator.type"));
		await this.#insertTypedWhitespace(trailing, deadline);
	}

	async #insertTypedWhitespace(value: string, deadline: number): Promise<void> {
		if (!value) return;
		await this.#tab.codexEvaluate<boolean>(
			INSERT_ACTIVE_WHITESPACE_SOURCE,
			[value],
			remainingMs(deadline, "locator.type"),
		);
	}

	async #locatorRead(operation: CodexBrowserOperation, args: Readonly<Record<string, unknown>>): Promise<unknown> {
		const descriptor = locatorArg(args);
		const deadline = Date.now() + selectorTimeoutArg(args);
		await this.#waitForLocator(descriptor, "attached", deadline, operation);
		return await this.#locator<unknown>(
			descriptor,
			operation.slice("locator.".length),
			args,
			remainingMs(deadline, operation),
		);
	}

	async #locatorDownload(args: Readonly<Record<string, unknown>>): Promise<void> {
		const descriptor = locatorArg(args);
		const deadline = Date.now() + selectorTimeoutArg(args);
		await this.#waitForLocator(descriptor, "attached", deadline, "locator.downloadMedia");
		const url = await this.#locator<string>(
			descriptor,
			"mediaUrl",
			{},
			remainingMs(deadline, "locator.downloadMedia"),
		);
		await this.#saveMedia(url, deadline, "locator.downloadMedia");
	}

	async #domDownload(args: Readonly<Record<string, unknown>>): Promise<void> {
		const deadline = Date.now() + selectorTimeoutArg(args);
		const handle = await this.#tab.ref(String(args.nodeId), remainingMs(deadline, "dom_cua.downloadMedia"));
		const url = await handle.evaluateWithTimeout(
			(element: unknown) => {
				if (!element || typeof element !== "object") return "";
				const media = element as {
					currentSrc?: unknown;
					src?: unknown;
					getAttribute?: (name: string) => string | null;
				};
				const source =
					typeof media.currentSrc === "string" && media.currentSrc.length > 0
						? media.currentSrc
						: typeof media.src === "string" && media.src.length > 0
							? media.src
							: media.getAttribute?.("href");
				return source ?? "";
			},
			[],
			remainingMs(deadline, "dom_cua.downloadMedia"),
		);
		await this.#saveMedia(url, deadline, "dom_cua.downloadMedia");
	}

	async #coordinateDownload(args: Readonly<Record<string, unknown>>): Promise<void> {
		const deadline = Date.now() + selectorTimeoutArg(args);
		const url = await this.#tab.codexEvaluate<string>(
			`(x, y) => { const element = document.elementFromPoint(x, y); return element ? String(element.currentSrc || element.src || element.href || element.getAttribute("src") || element.getAttribute("href") || "") : ""; }`,
			[numberArg(args, "x"), numberArg(args, "y")],
			remainingMs(deadline, "cua.downloadMedia"),
		);
		await this.#saveMedia(url, deadline, "cua.downloadMedia");
	}

	async #saveMedia(url: string, deadline: number, operation: string): Promise<void> {
		if (!url) throw new ToolError(`${operation} target has no downloadable URL`);
		const token = crypto.randomUUID();
		let consumed = false;
		try {
			await this.#tab.codexEvaluate<boolean>(
				START_PAGE_MEDIA_TRANSFER_SOURCE,
				[url, token],
				remainingMs(deadline, operation),
			);
			for (;;) {
				const value = await this.#tab.codexEvaluate<unknown>(
					READ_PAGE_MEDIA_TRANSFER_SOURCE,
					[token],
					remainingMs(deadline, operation),
				);
				if (value !== null) {
					consumed = true;
					const result = pageMediaTransferResult(value);
					const decoded = decodeBoundedMediaChunks(result.base64Chunks);
					const bytes = Buffer.concat(decoded.chunks, decoded.byteLength);
					let rawName = "media";
					try {
						const pathname = new URL(result.url || url).pathname;
						rawName = pathname.slice(pathname.lastIndexOf("/") + 1) || rawName;
					} catch {
						// Keep the stable fallback name for opaque URLs.
					}
					const filename = rawName.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128) || "media";
					const cwd = this.#tab.codexCwd().replace(/\/$/, "");
					const destination = `${cwd}/${crypto.randomUUID()}-${filename}`;
					const persistenceTimeoutMs = remainingMs(deadline, operation);
					if (typeof this.#tab.codexPersistFile === "function") {
						await this.#tab.codexPersistFile(destination, bytes, persistenceTimeoutMs, operation);
					} else {
						await Bun.write(destination, bytes);
						remainingMs(deadline, operation);
					}
					return;
				}
				await this.#tab.codexWait(Math.min(25, remainingMs(deadline, operation)));
			}
		} finally {
			if (!consumed) {
				await this.#tab
					.codexEvaluateCleanup<boolean>(DISPOSE_PAGE_MEDIA_TRANSFER_SOURCE, [token], SELECTOR_TIMEOUT_MS)
					.catch(() => undefined);
			}
		}
	}

	async #pressKeys(keys: string[], deadline: number, operation: string): Promise<void> {
		for (const key of keys) await this.#tab.press(key, { timeoutMs: remainingMs(deadline, operation) });
	}

	async #coordinateAction(operation: CodexBrowserOperation, _args: Readonly<Record<string, unknown>>): Promise<void> {
		switch (operation) {
			case "cua.click":
				throw new BrowserCapabilityError(CODEX_BROWSER_CAPABILITIES.CUA_CLICK);
			case "cua.double_click":
				throw new BrowserCapabilityError(CODEX_BROWSER_CAPABILITIES.CUA_DOUBLE_CLICK);
			case "cua.drag":
				throw new BrowserCapabilityError(CODEX_BROWSER_CAPABILITIES.CUA_DRAG);
			case "cua.move":
				throw new BrowserCapabilityError(CODEX_BROWSER_CAPABILITIES.CUA_MOVE);
			case "cua.scroll":
				throw new BrowserCapabilityError(CODEX_BROWSER_CAPABILITIES.CUA_SCROLL);
			default:
				throw new ToolError(`Unsupported cmux coordinate operation: ${operation}`);
		}
	}
}
