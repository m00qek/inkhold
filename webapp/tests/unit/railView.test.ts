// @vitest-environment happy-dom
// The rail painter: a row with an address is a link, one without is a button.

import { describe, it, expect, vi } from "vitest";
import { createRailView } from "../../src/pages/railView";
import type { RailRow } from "../../src/pages/rail";

const row = (over: Partial<Extract<RailRow, { kind: "item" }>>): RailRow => ({
  kind: "item",
  icon: "folder",
  name: "Files",
  badge: null,
  depth: 0,
  current: false,
  href: "#/folder/9",
  select: () => {},
  ...over,
});

describe("rail rows", () => {
  it("a row with an address is a link, marked current as the page", () => {
    const nav = document.createElement("div");
    createRailView(nav).render([row({ current: true })]);
    const a = nav.querySelector("a.nav__item")!;
    expect(a.getAttribute("href")).toBe("#/folder/9");
    expect(a.getAttribute("aria-current")).toBe("page");
  });

  it("a plain click runs the row's action instead of following the link; a modified one is the browser's", () => {
    const select = vi.fn();
    const nav = document.createElement("div");
    createRailView(nav).render([row({ select })]);
    const a = nav.querySelector("a.nav__item")!;
    const plain = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    a.dispatchEvent(plain);
    expect(select).toHaveBeenCalledTimes(1);
    expect(plain.defaultPrevented).toBe(true);
    const newTab = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ctrlKey: true });
    a.dispatchEvent(newTab);
    expect(select).toHaveBeenCalledTimes(1);
    expect(newTab.defaultPrevented).toBe(false);
  });

  it("a place with no address is a button, and says so", () => {
    const nav = document.createElement("div");
    createRailView(nav).render([row({ href: null })]);
    const b = nav.querySelector("button.nav__item")!;
    expect(b.hasAttribute("data-no-address")).toBe(true);
    expect(nav.querySelector("a")).toBeNull();
  });
});
