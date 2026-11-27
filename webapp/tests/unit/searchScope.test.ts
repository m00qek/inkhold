// What this browser's search reads the text of: the scope itself
// (`search/searchScope.ts`) and the scope as the browser keeps it
// (`ui/searchScope.ts`).

import { describe, expect, it, vi } from "vitest";
import { FULL_SCOPE, inScope, narrowed, scopeKindOf } from "../../src/search/searchScope";
import { createSearchScopeSetting, formatScope, parseScope, type SearchScopeSeams } from "../../src/ui/searchScope";
import { SEARCH_SCOPE_KEY, readLocal, writeLocal } from "../../src/ui/storage";

describe("the scope", () => {
  it("always searches notebooks, and counts every other tier as documents, annotated ones included", () => {
    const off = { documents: false };
    expect(scopeKindOf({ tier: "note" })).toBeNull();
    expect(scopeKindOf({ tier: "marked" })).toBe("documents");
    expect(scopeKindOf({ tier: "other" })).toBe("documents");
    expect(inScope(off, { tier: "note" })).toBe(true);
    expect(inScope(off, { tier: "marked" })).toBe(false);
    expect(inScope(off, { tier: "other" })).toBe(false);
    expect(inScope(FULL_SCOPE, { tier: "other" })).toBe(true);
  });

  it("is narrowed only when a kind is off", () => {
    expect(narrowed(FULL_SCOPE)).toBe(false);
    expect(narrowed({ documents: false })).toBe(true);
  });
});

describe("parseScope and formatScope", () => {
  it("read back what they write", () => {
    expect(parseScope(formatScope({ documents: false }))).toEqual({ documents: false });
    expect(formatScope({ documents: true })).toBe('{"documents":true}');
  });

  it("take the default for anything missing or malformed, kind by kind", () => {
    for (const raw of [null, "", "{", "null", "[]", "true", '"off"', "{}", '{"documents":"no"}', '{"books":false}']) {
      expect(parseScope(raw)).toEqual(FULL_SCOPE);
    }
  });
});

/** Storage in a map, and another tab's events on a target the test fires. */
function seams(initial: Record<string, string> = {}) {
  const held = new Map(Object.entries(initial));
  const events = new EventTarget();
  const s: SearchScopeSeams = { read: (k) => held.get(k) ?? null, write: (k, v) => void held.set(k, v), events };
  /** Another tab wrote `value` (or cleared everything, with `key` null). */
  const otherTab = (key: string | null, value?: string) => {
    if (key === null) held.clear();
    else if (value !== undefined) held.set(key, value);
    events.dispatchEvent(Object.assign(new Event("storage"), { key }));
  };
  return { held, seams: s, otherTab };
}

describe("createSearchScopeSetting", () => {
  it("is everything by default", () => {
    expect(createSearchScopeSetting(seams().seams).get()).toEqual(FULL_SCOPE);
  });

  it("is everything when the stored value is malformed", () => {
    expect(createSearchScopeSetting(seams({ [SEARCH_SCOPE_KEY]: "{oops" }).seams).get()).toEqual(FULL_SCOPE);
  });

  it("reads what was stored, and stores what is set, under sn.search-scope", () => {
    const t = seams({ [SEARCH_SCOPE_KEY]: '{"documents":false}' });
    const setting = createSearchScopeSetting(t.seams);
    expect(setting.get()).toEqual({ documents: false });
    setting.set("documents", true);
    expect(SEARCH_SCOPE_KEY).toBe("sn.search-scope");
    expect(t.held.get(SEARCH_SCOPE_KEY)).toBe('{"documents":true}');
  });

  it("tells its listeners of this tab's change, once, and not of a set that changes nothing", () => {
    const setting = createSearchScopeSetting(seams().seams);
    const heard = vi.fn();
    const stop = setting.subscribe(heard);
    setting.set("documents", false);
    setting.set("documents", false);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(heard).toHaveBeenCalledWith({ documents: false });
    stop();
    setting.set("documents", true);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("follows another tab's change through the storage event, and a clear back to the default", () => {
    const t = seams();
    const setting = createSearchScopeSetting(t.seams);
    const heard = vi.fn();
    setting.subscribe(heard);
    t.otherTab("sn.sort", "by-name");
    expect(heard).not.toHaveBeenCalled();
    t.otherTab(SEARCH_SCOPE_KEY, '{"documents":false}');
    expect(setting.get()).toEqual({ documents: false });
    t.otherTab(null);
    expect(setting.get()).toEqual(FULL_SCOPE);
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it("where storage is unavailable, is the default and still holds a change for this visit", () => {
    // Node has no window: `readLocal` and `writeLocal` degrade as in a blocked browser.
    const setting = createSearchScopeSetting({ read: readLocal, write: writeLocal, events: new EventTarget() });
    expect(setting.get()).toEqual(FULL_SCOPE);
    setting.set("documents", false);
    expect(setting.get()).toEqual({ documents: false });
  });
});
