// @vitest-environment happy-dom
// The DOM helpers that keep a person's place when the app repaints under them.

import { afterEach, describe, expect, it } from "vitest";
import { keepingFocus } from "../../src/ui/dom";

/** A list of result links, rebuilt from scratch like the gallery. */
function results(list: HTMLElement, rows: { href: string; text: string }[]): void {
  list.replaceChildren(
    ...rows.map((r) => {
      const a = document.createElement("a");
      a.className = "card__open";
      a.href = r.href;
      a.textContent = r.text;
      return a;
    }),
  );
}

afterEach(() => document.body.replaceChildren());

describe("keepingFocus", () => {
  it("gives focus back to the same result after the list is rebuilt", () => {
    const list = document.createElement("div");
    document.body.append(list);
    results(list, [{ href: "#/note/1", text: "Aurora" }, { href: "#/note/2", text: "Beta" }]);
    (list.querySelectorAll("a")[1] as HTMLElement).focus();

    // The late answer adds a match line to each row: same links, new text, new nodes.
    keepingFocus(list, () =>
      results(list, [{ href: "#/note/1", text: "Aurora · Matches on 2 pages" }, { href: "#/note/2", text: "Beta · Matches on 1 page" }]),
    );
    expect(document.activeElement?.getAttribute("href")).toBe("#/note/2");
  });

  it("leaves focus alone when it was not in the list", () => {
    const field = document.createElement("input");
    const list = document.createElement("div");
    document.body.append(field, list);
    results(list, [{ href: "#/note/1", text: "Aurora" }]);
    field.focus();
    keepingFocus(list, () => results(list, [{ href: "#/note/1", text: "Aurora" }]));
    expect(document.activeElement).toBe(field);
  });

  it("lets go when the control is gone from the rebuilt list", () => {
    const list = document.createElement("div");
    document.body.append(list);
    results(list, [{ href: "#/note/1", text: "Aurora" }]);
    (list.querySelector("a") as HTMLElement).focus();
    keepingFocus(list, () => results(list, [{ href: "#/note/9", text: "Other" }]));
    expect(list.contains(document.activeElement)).toBe(false);
  });
});
