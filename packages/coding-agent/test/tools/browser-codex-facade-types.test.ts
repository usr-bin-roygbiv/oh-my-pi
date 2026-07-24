import type {
	CodexBrowserFacade,
	CodexElementInfo,
	CodexImage,
	CodexTab,
	CodexTabSummary,
} from "@oh-my-pi/pi-coding-agent/tools/browser/codex-facade";

export function exactPublicTypeContract(browser: CodexBrowserFacade, tab: CodexTab): void {
	const selected: Promise<CodexTab | undefined> = browser.tabs.selected();
	const listed: Promise<CodexTabSummary[]> = browser.tabs.list();
	const content: Promise<Array<{ url: string; title: string | null; content: string | null }>> = browser.tabs.content({
		urls: ["https://fixture.test"],
		contentType: "domSnapshot",
		timeoutMs: 1_000,
	});
	const info: Promise<CodexElementInfo[]> = tab.playwright.elementInfo({ x: 1, y: 2, includeNonInteractable: true });
	const screenshot: Promise<CodexImage> = tab.cua.get_visible_screenshot();
	void screenshot.then(image => image.toBase64());
	const opaqueDom: Promise<unknown> = tab.dom_cua.get_visible_dom();
	void [selected, listed, content, info, opaqueDom];

	void browser.user.history({ from: new Date(), to: "2026-01-01", query: "fixture", limit: 5 });
	void tab.goto("https://fixture.test");
	void tab.content.exportGsuite("pptx");
	void tab.clipboard.write([
		{ entries: [{ mimeType: "text/plain", text: "hello" }], presentationStyle: "inline" },
		{ entries: [{ mimeType: "image/png", base64: "aQ==" }] },
	]);
	void tab.playwright.getByRole("button", { name: /save/i, exact: false }).click({
		button: "middle",
		modifiers: ["Alt", "Control", "ControlOrMeta", "Meta", "Shift"],
		force: true,
		timeoutMs: 250,
	});
	void tab.playwright.waitForURL("https://fixture.test", { waitUntil: "networkidle", timeoutMs: 1_000 });
	void tab.playwright.waitForLoadState({ state: "networkidle", timeoutMs: 1_000 });
	void tab.playwright.locator("select").selectOption([{ value: "one" }, { label: "Two" }, { index: 2 }]);
	void tab.cua.click({ x: 1, y: 2, button: 3, keypress: ["Shift"] });
	const locatorDownload: Promise<void> = tab.playwright.locator("img").downloadMedia();
	const domDownload: Promise<void> = tab.dom_cua.downloadMedia({ node_id: "node-1" });
	const cuaDownload: Promise<void> = tab.cua.downloadMedia({ x: 1, y: 2 });
	void [locatorDownload, domDownload, cuaDownload];
	void tab.dom_cua.scroll({ node_id: "node-1", x: 0, y: 10 });

	// @ts-expect-error contentType is a closed union
	void browser.tabs.content({ urls: [], contentType: "xml" });
	// @ts-expect-error history limit is numeric
	void browser.user.history({ limit: "5" });
	// @ts-expect-error goto requires a URL string
	void tab.goto({ url: "https://fixture.test" });
	// @ts-expect-error export format is a closed union
	void tab.content.exportGsuite("txt");
	// @ts-expect-error clipboard entries require exactly one of text/base64
	void tab.clipboard.write([{ entries: [{ mimeType: "text/plain", text: "x", base64: "eA==" }] }]);
	// @ts-expect-error clipboard entries require text or base64
	void tab.clipboard.write([{ entries: [{ mimeType: "text/plain" }] }]);
	// @ts-expect-error locator button names are closed
	void tab.playwright.locator("button").click({ button: "primary" });
	// @ts-expect-error locator modifiers are closed
	void tab.playwright.locator("button").dblclick({ modifiers: ["Command"] });
	// @ts-expect-error current client exposes networkidle, not Puppeteer networkidle0
	void tab.playwright.waitForLoadState({ state: "networkidle0" });
	// @ts-expect-error current client exposes networkidle, not Puppeteer networkidle2
	void tab.playwright.waitForURL("https://fixture.test", { waitUntil: "networkidle2" });
	// @ts-expect-error nth requires a number at the public boundary
	void tab.playwright.locator("button").nth("1");
	// @ts-expect-error coordinate CUA buttons are 1, 2, or 3
	void tab.cua.click({ x: 1, y: 2, button: "left" });
	// @ts-expect-error DOM CUA click requires node_id
	void tab.dom_cua.click({});
}
