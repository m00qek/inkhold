// @vitest-environment happy-dom
// The list naming the documents search holds no text for (`pages/searchLeftOut.ts`).

import { describe, it, expect } from "vitest";
import { createSearchLeftOut, leftOutList, LEFT_OUT_SHOWN, type LeftOutName } from "../../src/pages/searchLeftOut";
import type { Id } from "../../src/core/types";

/** A listing that names ids "1" to "n", each in its own folder; the rest it hasn't reached. */
function listing(n: number): (id: Id) => LeftOutName | null {
  return (id) => (Number(id) <= n ? { name: `Book ${id}`, folderPath: `Shelf ${id}` } : null);
}

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe("leftOutList", () => {
  it("keeps the order it is given: the budget's, most wanted first", () => {
    const list = leftOutList([3, 1, 2], listing(3));
    expect(list.shown.map((e) => e.id)).toEqual(["3", "1", "2"]);
    expect(list.shown[0]).toEqual({ id: "3", name: "Book 3", folderPath: "Shelf 3" });
  });

  it("lists each copy of a file, by its own id, name and place", () => {
    const copies = (id: Id): LeftOutName | null =>
      ({ "4": { name: "Moby-Dick", folderPath: "Books" }, "5": { name: "Moby-Dick (copy)", folderPath: "Inbox" } })[id] ?? null;
    expect(leftOutList([4, 5], copies).shown).toEqual([
      { id: "4", name: "Moby-Dick", folderPath: "Books" },
      { id: "5", name: "Moby-Dick (copy)", folderPath: "Inbox" },
    ]);
  });

  it("shows at most 50 names, counting the rest", () => {
    const list = leftOutList(range(1, 53), listing(53));
    expect(LEFT_OUT_SHOWN).toBe(50);
    expect(list.shown).toHaveLength(50);
    expect(list.shown.at(-1)?.id).toBe("50");
    expect(list.more).toBe(3);
    expect(list.unlisted).toBe(0);
  });

  it("counts a document the listing doesn't name, and never shows its id", () => {
    const list = leftOutList([1, 7, 2, 8], listing(2));
    expect(list.shown.map((e) => e.name)).toEqual(["Book 1", "Book 2"]);
    expect(list.more).toBe(0);
    expect(list.unlisted).toBe(2);
  });

  it("caps the named ones only: the nameless are counted on their own", () => {
    const list = leftOutList([...range(1, 52), 99], listing(52));
    expect(list.shown).toHaveLength(50);
    expect(list.more).toBe(2);
    expect(list.unlisted).toBe(1);
  });
});

describe("createSearchLeftOut", () => {
  it("is nothing when nothing is left out", () => {
    expect(createSearchLeftOut().block("whale", [], listing(1))).toBeNull();
  });

  it("is a closed disclosure, 'Show them', listing links that open each document", () => {
    const box = createSearchLeftOut().block("whale", [2, 1], listing(2)) as HTMLDetailsElement;
    expect(box.tagName).toBe("DETAILS");
    expect(box.open).toBe(false);
    expect(box.querySelector("summary")?.textContent).toBe("Show them");
    const links = [...box.querySelectorAll<HTMLAnchorElement>("li a")];
    expect(links.map((a) => a.textContent)).toEqual(["Book 2", "Book 1"]);
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["#/note/2", "#/note/1"]);
    expect(box.querySelector("li .left-out__where")?.textContent).toBe("Shelf 2");
    expect(box.querySelectorAll(".left-out__rest")).toHaveLength(0);
  });

  it("follows a plain click itself", () => {
    location.hash = "";
    const box = createSearchLeftOut().block("whale", [1], listing(1))!;
    box.querySelector<HTMLAnchorElement>("li a")!.click();
    expect(location.hash).toBe("#/note/1");
  });

  it("ends with 'and N more', then the count of those not listed yet", () => {
    const box = createSearchLeftOut().block("whale", [...range(1, 51), 98, 99], listing(51))!;
    expect(box.querySelectorAll("li")).toHaveLength(50);
    expect([...box.querySelectorAll(".left-out__rest")].map((p) => p.textContent)).toEqual(["and 1 more", "2 more not listed yet"]);
    // Never an id where a name should be.
    expect(box.textContent).not.toContain("98");
  });

  it("stays open across a repaint of the same search, and starts closed for another", () => {
    const names = createSearchLeftOut();
    const first = names.block("whale", [1], listing(1)) as HTMLDetailsElement;
    first.open = true;
    expect((names.block("whale", [1, 2], listing(2)) as HTMLDetailsElement).open).toBe(true);
    expect((names.block("aurora", [1, 2], listing(2)) as HTMLDetailsElement).open).toBe(false);
  });

  it("with no name known yet, only counts them", () => {
    const box = createSearchLeftOut().block("whale", [98, 99], listing(0))!;
    expect(box.querySelector("ul")).toBeNull();
    expect(box.querySelector(".left-out__rest")?.textContent).toBe("2 more not listed yet");
  });
});
