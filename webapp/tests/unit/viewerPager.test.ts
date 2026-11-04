// @vitest-environment happy-dom
// The readout is an input written by both the viewer (`set`) and the person typing.

import { describe, it, expect, vi, afterEach } from "vitest";
import { createPager } from "../../src/pages/viewer/viewerControls";

let mounted: HTMLElement | null = null;

afterEach(() => {
  mounted?.remove();
  mounted = null;
  document.body.replaceChildren();
});

function pager(onGo: (i: number) => void = () => {}) {
  const p = createPager({ readoutClass: "test-count", onGo });
  document.body.append(p.el);
  mounted = p.el;
  const field = p.el.querySelector<HTMLInputElement>("input")!;
  return { p, field };
}

function press(field: HTMLInputElement, key: string): void {
  field.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

describe("the page field", () => {
  it("shows the page and the total", () => {
    const { p, field } = pager();
    p.set(11, 1700);
    expect(field.value).toBe("12 / 1700");
  });

  it("commits a typed page, and clamps one past the end", () => {
    const onGo = vi.fn();
    const { p, field } = pager(onGo);
    p.set(0, 20);
    field.focus();
    field.value = "7";
    press(field, "Enter");
    expect(onGo).toHaveBeenCalledWith(6);
    field.focus();
    field.value = "9999";
    press(field, "Enter");
    expect(onGo).toHaveBeenLastCalledWith(19);
  });

  it("AN EDIT IN PROGRESS SURVIVES A PAGE LANDING", () => {
    // Regression: `set` from a finishing render wiped what the person was typing.
    const onGo = vi.fn();
    const { p, field } = pager(onGo);
    p.set(0, 20);
    field.focus();
    field.value = "14";

    p.set(1, 20);
    expect(field.value).toBe("14");

    press(field, "Enter");
    expect(onGo).toHaveBeenCalledWith(13);
  });

  it("still clamps against the count that arrived mid-edit", () => {
    // State is updated even when the paint is skipped, so the commit clamps correctly.
    const onGo = vi.fn();
    const { p, field } = pager(onGo);
    p.set(0, 500);
    field.focus();
    field.value = "400";
    p.set(0, 12);
    press(field, "Enter");
    expect(onGo).toHaveBeenCalledWith(11);
  });

  it("repaints as soon as the edit ends, so the field is never left stale", () => {
    const { p, field } = pager();
    p.set(0, 20);
    field.focus();
    field.value = "14";
    p.set(5, 20);
    expect(field.value).toBe("14");
    field.blur();
    expect(field.value).toBe("6 / 20");
  });

  it("Escape reverts the edit and does not let the key travel", () => {
    // Both viewers close on a document-level Escape.
    const { p, field } = pager();
    p.set(1, 20);
    field.focus();
    field.value = "9";
    const ev = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    const seen = vi.fn();
    document.addEventListener("keydown", seen);
    field.dispatchEvent(ev);
    document.removeEventListener("keydown", seen);
    expect(field.value).toBe("2 / 20");
    expect(seen).not.toHaveBeenCalled();
  });

  it("says nothing rather than lying when there are no pages", () => {
    const { p, field } = pager();
    p.set(0, 0);
    expect(field.value).toBe("—");
  });
});
