Drives real Chromium tab; full puppeteer access via JS.

<instruction>
- Static content? `read` the URL. Browser only for JS execution, auth, interactive actions.
- `open` → `run` — tabs survive calls and subagents, open once reuse.
- `run` scope: `page`, `browser`, `tab`, `display`, `assert`, `wait` available. `wait(fn)` polls until truthy — use instead of polling inside `tab.evaluate`.
- `agent.browser` is a Codex-compatible facade available inside `browser` `run` cells. It preserves the callable `agent(prompt, options)` helper and the existing `page`, `browser`, and `tab` globals.
- Lifecycle remains `browser({ action: "open" })` → `browser({ action: "run", code: "…" })` → `browser({ action: "close" })`; open the browser before using the facade.
- The facade uses one current tab per browser session. `agent.browser.tabs.new()`, `selected()`, `list()`, and `get(id)` follow that session's tab semantics; tab IDs are public strings. `nameSession(name)` trims input and rejects an empty name.
- Public families include tabs (`new`, `selected`, `list`, `get`, `content`), user records (`openTabs`, `history`), tab navigation/lifecycle (`goto`, `back`, `forward`, `reload`, `close`, `title`, `url`), content export (`export` returns a filesystem path; `exportGsuite`), clipboard (`read`, `readText`, `write`, `writeText`), development logs (`logs`), Playwright-compatible locators/actions/waits/screenshots, computer-use input (`get_visible_screenshot` returns an image wrapper with `toBase64()`, `click`, `double_click`, `drag`, `keypress`, `move`, `scroll`, `type`, `downloadMedia`), and DOM computer-use input (`get_visible_dom`, node-id `click`/`double_click`, `scroll`, `type`, `keypress`, `downloadMedia`).
- Playwright load states are `load`, `domcontentloaded`, and `networkidle`. Locator `click`/`dblclick` use string buttons `left`, `right`, or `middle`; coordinate CUA mouse actions use numeric buttons 1, 2, or 3. Playwright screenshots expose `toBase64()`, `elementInfo()` returns an array DTO, and `Download.path()` returns a filesystem path. Locator, DOM-CUA, and CUA `downloadMedia` perform their effect and resolve `void`.
- Selector actions default to a 3000 ms timeout (maximum 3000 ms); navigation defaults to 10000 ms. Actions validate observable postconditions. Supported method names, validation, and return/error shapes are consistent across backends; unsupported capabilities fail immediately with stable named `BrowserCapabilityError`, never by fake fallback or silent no-op.

Example:

```js
const tab = await agent.browser.tabs.new();
await tab.goto("https://example.test/docs");
const heading = await tab.playwright.getByRole("heading").innerText();
display({ id: tab.id, heading });
```
- `tab` helpers (drop to raw puppeteer `page` for anything uncovered):
  Element handles: `tab.ref("e5")` / `tab.id(n)` return a handle you call methods on directly — `(await tab.id(n)).click()`. Handles are NOT selectors: `tab.click`/`type`/`fill`/`waitFor*` take STRING selectors only. Snapshot refs work in any selector slot: `tab.click("e5")` ≡ `tab.click("aria-ref=e5")`.
  Simple: `tab.goto`, `tab.click`, `tab.type`, `tab.fill`, `tab.press`, `tab.scroll`, `tab.scrollIntoView`, `tab.drag`, `tab.uploadFile`, `tab.select`, `tab.screenshot`, `tab.extract`, `tab.evaluate`.
  Waits: `tab.waitFor`, `tab.waitForSelector`, `tab.waitForUrl`, `tab.waitForResponse`, `tab.waitForNavigation`.
  Snapshots: `tab.observe()` → accessibility tree; `tab.ariaSnapshot()` → ARIA YAML with `[ref=eN]`.

  Gotchas:
  - `tab.fill` NEVER works for `<select>` — use `tab.select`.
  - `tab.waitForNavigation` must start BEFORE the trigger click.
  - Navigation and re-renders (virtualized lists, SPA updates) invalidate ids/refs — re-observe or re-snapshot, then act in the same cell.
  - Stalled actions fail fast with named error, never whole-cell timeout.
  - Raw request interception is run-scoped: run end removes `request` handlers, disables interception, releases held requests.

- `app.path` → NEVER tamper with a real desktop app (no stealth patches).
- Selectors: CSS + puppeteer `aria/…`, `text/…`, `xpath/…`, `pierce/…`. Playwright-only pseudos (`:has-text()`, `:visible`) are REJECTED.
</instruction>

<critical>
- MUST `open` before `run`. Default to `tab.observe()`; screenshot only for appearance. `code` runs with full Node access — not sandboxed.
</critical>
