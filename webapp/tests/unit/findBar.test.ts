// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { createFindBar } from "../../src/pages/viewer/findBar";

describe("the find bar's field", () => {
  // iOS autocorrect would quietly change a search for a name or an oddly recognised word.
  it("is a query, not prose: no autocorrect, capitals or spellcheck, and Enter says 'next'", () => {
    const { input } = createFindBar({ block: "findbar", label: "Find in this note" });
    expect(input.getAttribute("autocorrect")).toBe("off");
    expect(input.getAttribute("autocapitalize")).toBe("none");
    expect(input.getAttribute("spellcheck")).toBe("false");
    expect(input.getAttribute("autocomplete")).toBe("off");
    expect(input.getAttribute("enterkeyhint")).toBe("next");
    expect(input.getAttribute("aria-label")).toBe("Find in this note");
  });

  it("offers the typo-tolerant search by what it does", () => {
    const { ask } = createFindBar({ block: "findbar", label: "Find in this note" });
    expect(ask.textContent).toBe("Try similar spellings");
    expect(ask.hidden).toBe(true);
  });
});
