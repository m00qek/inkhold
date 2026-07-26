// @vitest-environment happy-dom
//
// The shared overflow menu (src/ui/menu.ts) as a DOM unit — the behaviour the
// gallery/bin/toolbar e2e cannot cheaply assert about the COMPONENT in isolation.
// The load-bearing new behaviour is the VIEWPORT-POSITIONED popover: on open the
// pop is portaled to a <body> root and placed with position:fixed from the
// trigger's rect, so no ancestor's overflow can clip it (the card-edge bug). We
// assert the portal seam, the placement/flip maths, and that every prior contract
// (Escape returns focus, outside-click/scroll close, roving, the is-open state)
// still holds once the pop lives outside the wrapper.

import { describe, it, expect, afterEach } from "vitest";
import { createMenu, closeOpenMenu } from "../../src/ui/menu";

/** A DOMRect-ish literal for a mocked trigger box. */
function rect(left: number, top: number, w = 28, h = 28) {
  const right = left + w;
  const bottom = top + h;
  return { left, top, right, bottom, width: w, height: h, x: left, y: top, toJSON: () => ({}) } as DOMRect;
}

const POP_W = 244;
const POP_H = 120;

/**
 * Build a two-item menu, mount its trigger inside a body-level scroll container,
 * and give the trigger a fixed rect plus the pop a fixed measured box (happy-dom
 * has no layout, so placePop's offsetWidth/Height reads need mocking).
 */
function makeMenu(triggerRect: DOMRect, onSelect: () => void = () => {}) {
  const scroller = document.createElement("div");
  document.body.appendChild(scroller);
  const menu = createMenu({
    triggerLabel: "Actions",
    items: [
      { label: "Restore", onSelect },
      { label: "Delete", danger: true, onSelect: () => {} },
    ],
  });
  scroller.appendChild(menu);

  const trigger = menu.querySelector(".card__more") as HTMLButtonElement;
  const pop = menu.querySelector(".menu__pop") as HTMLElement;
  trigger.getBoundingClientRect = () => triggerRect;
  Object.defineProperty(pop, "offsetWidth", { value: POP_W, configurable: true });
  Object.defineProperty(pop, "offsetHeight", { value: POP_H, configurable: true });

  return { menu, trigger, pop, scroller };
}

const portalRoot = () => document.querySelector(".menu-portal");

afterEach(() => {
  closeOpenMenu();
  document.body.replaceChildren();
});

describe("shared overflow menu — viewport-positioned popover", () => {
  it("portals the open pop out of the wrapper to a body-level root", () => {
    const { menu, trigger, pop } = makeMenu(rect(900, 12));
    expect(pop.parentElement).toBe(menu); // closed: nested in the wrapper
    trigger.click();
    // Open: lifted to the portal root under <body>, NOT inside the (clippable) menu.
    expect(portalRoot()).not.toBeNull();
    expect(pop.parentElement).toBe(portalRoot());
    expect(menu.contains(pop)).toBe(false);
    expect(pop.classList.contains("is-open")).toBe(true);
  });

  it("is not clipped near a scroll-container edge — stays within the viewport", () => {
    // Trigger hard against the right edge, where a right-anchored pop used to
    // overflow and get sliced by the scroller.
    const { trigger, pop } = makeMenu(rect(window.innerWidth - 30, 20));
    trigger.click();
    const left = parseFloat(pop.style.left);
    const top = parseFloat(pop.style.top);
    expect(left).toBeGreaterThanOrEqual(8);
    expect(left + POP_W).toBeLessThanOrEqual(window.innerWidth - 8);
    expect(top).toBeGreaterThanOrEqual(8);
    expect(top + POP_H).toBeLessThanOrEqual(window.innerHeight - 8);
  });

  it("default placement: dropped below, right edge aligned to the trigger", () => {
    // Roomy spot: no flip/clamp, so the raw right-align + drop maths show through.
    const r = rect(400, 100);
    const { trigger, pop } = makeMenu(r);
    trigger.click();
    expect(parseFloat(pop.style.left)).toBe(Math.round(r.right - POP_W));
    expect(parseFloat(pop.style.top)).toBe(Math.round(r.bottom + 6));
  });

  it("flips to left-align when a right-align would run off the left edge", () => {
    const r = rect(20, 100); // right-align → 20+28-244 = -196, off-screen left
    const { trigger, pop } = makeMenu(r);
    trigger.click();
    expect(parseFloat(pop.style.left)).toBe(r.left); // left-aligned to the trigger
  });

  it("opens upward when a downward drop would run off the bottom", () => {
    const r = rect(400, window.innerHeight - 40); // little room below
    const { trigger, pop } = makeMenu(r);
    trigger.click();
    // Above: trigger top − gap − pop height.
    expect(parseFloat(pop.style.top)).toBe(Math.round(r.top - 6 - POP_H));
  });
});

describe("shared overflow menu — preserved behaviour", () => {
  it("toggles the is-open state class on the wrapper (trigger styling seam)", () => {
    const { menu, trigger } = makeMenu(rect(400, 100));
    expect(menu.classList.contains("is-open")).toBe(false);
    trigger.click();
    expect(menu.classList.contains("is-open")).toBe(true);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    trigger.click();
    expect(menu.classList.contains("is-open")).toBe(false);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("Escape closes and returns focus to the trigger", () => {
    const { menu, trigger } = makeMenu(rect(400, 100));
    trigger.click();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(menu.classList.contains("is-open")).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it("an outside click closes; a click inside the (portaled) pop does not", () => {
    const { menu, pop } = makeMenu(rect(400, 100));
    const trigger = menu.querySelector(".card__more") as HTMLButtonElement;
    trigger.click();
    // A click landing inside the pop keeps it open, even though the pop is no
    // longer a descendant of the wrapper.
    const header = pop.querySelector(".menu__section") as HTMLElement;
    header.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(menu.classList.contains("is-open")).toBe(true);
    // A click anywhere outside closes it.
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(menu.classList.contains("is-open")).toBe(false);
  });

  it("an ancestor scroll closes the menu (a fixed pop must not strand)", () => {
    const { menu, trigger } = makeMenu(rect(400, 100));
    trigger.click();
    expect(menu.classList.contains("is-open")).toBe(true);
    window.dispatchEvent(new Event("scroll"));
    expect(menu.classList.contains("is-open")).toBe(false);
  });

  it("keyboard roving moves between items on the portaled pop", () => {
    const { pop } = makeMenu(rect(400, 100));
    const trigger = document.querySelector(".card__more") as HTMLButtonElement;
    const items = pop.querySelectorAll<HTMLButtonElement>(".menu__item");
    trigger.click(); // programmatic click reports detail 0 → focuses first item
    expect(document.activeElement).toBe(items[0]);
    pop.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement).toBe(items[1]);
    pop.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(document.activeElement).toBe(items[0]);
  });

  it("runs the item's action and closes on select", () => {
    let ran = false;
    const { menu, pop } = makeMenu(rect(400, 100), () => (ran = true));
    const trigger = menu.querySelector(".card__more") as HTMLButtonElement;
    trigger.click();
    (pop.querySelector(".menu__item") as HTMLButtonElement).click();
    expect(ran).toBe(true);
    expect(menu.classList.contains("is-open")).toBe(false);
    expect(pop.parentElement).toBe(menu); // returned to the wrapper on close
  });
});
