// @vitest-environment happy-dom
// The account page's "Search", this browser's (`pages/account/accountSearch.ts`).

import { describe, expect, it } from "vitest";
import { createSearchScopeSection, SEARCH_SCOPE_HINT } from "../../src/pages/account/accountSearch";
import { createSearchScopeSetting } from "../../src/ui/searchScope";
import { SEARCH_SCOPE_KEY } from "../../src/ui/storage";

/** A real setting over a map, and a way to play another tab's change. */
function setting(stored?: string) {
  const held = new Map<string, string>(stored ? [[SEARCH_SCOPE_KEY, stored]] : []);
  const events = new EventTarget();
  const s = createSearchScopeSetting({ read: (k) => held.get(k) ?? null, write: (k, v) => void held.set(k, v), events });
  const otherTab = (value: string) => {
    held.set(SEARCH_SCOPE_KEY, value);
    events.dispatchEvent(Object.assign(new Event("storage"), { key: SEARCH_SCOPE_KEY }));
  };
  return { setting: s, held, otherTab };
}

describe("createSearchScopeSection", () => {
  it("says notebooks are always searched, and offers one switch, on by default, with what it covers", () => {
    const { body, hint } = createSearchScopeSection(setting().setting);
    const rows = [...body.querySelectorAll(".acct-row")];
    expect(rows[0]?.textContent).toBe("NotebooksAlways searched");
    const label = body.querySelector("label.acct-check")!;
    const box = label.querySelector<HTMLInputElement>("input[type=checkbox]")!;
    expect(box.checked).toBe(true);
    expect(label.querySelector("span > span")?.textContent).toBe("Search inside documents");
    expect(label.querySelector("small")?.textContent).toBe("PDFs, XPS documents and text files");
    expect(hint.textContent).toBe(SEARCH_SCOPE_HINT);
    // Read with the box: what turning it off costs.
    expect(box.getAttribute("aria-describedby")).toBe(hint.id);
    expect(hint.id).not.toBe("");
    expect(SEARCH_SCOPE_HINT).toContain("found by name");
    expect(SEARCH_SCOPE_HINT).toContain("Find");
  });

  it("shows what is stored, and stores what is switched", () => {
    const t = setting('{"documents":false}');
    const { body } = createSearchScopeSection(t.setting);
    const box = body.querySelector<HTMLInputElement>("input[type=checkbox]")!;
    expect(box.checked).toBe(false);
    // As a browser does on a click; happy-dom's `click()` fires no `change`.
    box.checked = true;
    box.dispatchEvent(new Event("change"));
    expect(t.setting.get()).toEqual({ documents: true });
    expect(t.held.get(SEARCH_SCOPE_KEY)).toBe('{"documents":true}');
  });

  it("follows another tab's switch while open, and stops once disposed", () => {
    const t = setting();
    const section = createSearchScopeSection(t.setting);
    const box = section.body.querySelector<HTMLInputElement>("input[type=checkbox]")!;
    t.otherTab('{"documents":false}');
    expect(box.checked).toBe(false);
    section.dispose();
    t.otherTab('{"documents":true}');
    expect(box.checked).toBe(false);
  });
});
