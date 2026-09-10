// @vitest-environment happy-dom
//
// The shared page control (`createPager` in src/pages/viewerChrome.ts) — the
// `< 12 / 1700 >` both paged viewers use.
//
// Its readout is an INPUT, which is what makes it a go-to-page field and also
// what gives it the one hazard a read-only counter never had: two things can
// write to it. The viewer writes through `set` whenever a page lands, and the
// person writes by typing. This file is about who wins.

import { describe, it, expect, vi, afterEach } from "vitest";
import { createPager } from "../../src/pages/viewerControls";

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
    // The defect this pins, which surfaced as a flaky test rather than as a bug
    // report: `set` is called from the viewer's own render, which lands whenever
    // a raster finishes, and it repainted the field unconditionally. So someone
    // typing a page number while the previous page was still drawing had their
    // keystrokes wiped, and the Enter that followed committed the repaint's
    // number instead of theirs — the app appearing to ignore them, and likeliest
    // on the big documents where typing a number is the reason the field exists.
    const onGo = vi.fn();
    const { p, field } = pager(onGo);
    p.set(0, 20);
    field.focus();
    field.value = "14";

    // A page lands, from somewhere that is not this field.
    p.set(1, 20);
    expect(field.value).toBe("14");

    // …and Enter commits what was TYPED, not what arrived.
    press(field, "Enter");
    expect(onGo).toHaveBeenCalledWith(13);
  });

  it("still clamps against the count that arrived mid-edit", () => {
    // The state is updated even when the paint is skipped, so a total that
    // changed under the edit is the one the commit clamps to. Skipping the
    // render must not mean ignoring the news.
    const onGo = vi.fn();
    const { p, field } = pager(onGo);
    p.set(0, 500);
    field.focus();
    field.value = "400";
    p.set(0, 12); // a different document, or a count corrected downwards
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
    // Both viewers close on a document-level Escape, so an un-stopped one would
    // throw away the document along with the edit.
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
