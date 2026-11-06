// @vitest-environment happy-dom

import { describe, it, expect, afterEach, vi } from "vitest";
import { createToolbar, type ToolbarButton, type ToolbarControl } from "../../src/pages/toolbar";
import { el } from "../../src/ui/dom";

afterEach(() => document.body.replaceChildren());

/** A minimal declarative button spec. */
function btn(key: string, label: string, extra: Partial<ToolbarButton> = {}): ToolbarButton {
  return { kind: "button", key, label, ...extra };
}

/** Build a bar, mount it (focus needs an attached tree), and hand it back. */
function mount(spec: Parameters<typeof createToolbar>[0]) {
  const bar = createToolbar(spec);
  document.body.append(bar.el);
  return bar;
}

/** A basic reader-shaped spec: a leading control, two view controls, one file. */
function basicSpec(over: Partial<Parameters<typeof createToolbar>[0]> = {}) {
  const back = el("button", { text: "Back" });
  return {
    label: "Bar",
    viewLabel: "View zone",
    fileLabel: "File zone",
    leading: [{ el: back, focus: [back] }],
    view: [btn("a", "A"), btn("b", "B")] as ToolbarControl[],
    file: [btn("d", "Download")] as ToolbarControl[],
    ...over,
  };
}

const groups = (bar: { el: HTMLElement }) => [...bar.el.querySelectorAll('[role="group"]')] as HTMLElement[];
const key = (e: HTMLElement, k: string) => e.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));

describe("createToolbar", () => {
  it("renders a role=toolbar landmark carrying its aria-label", () => {
    const bar = mount(basicSpec({ label: "Reader controls" }));
    expect(bar.el.getAttribute("role")).toBe("toolbar");
    expect(bar.el.getAttribute("aria-label")).toBe("Reader controls");
    expect(bar.el.classList.contains("toolbar")).toBe(true);
  });

  it("adds a consumer's className to the container for its own placement", () => {
    const bar = mount(basicSpec({ className: "reader__bar" }));
    expect(bar.el.classList.contains("reader__bar")).toBe(true);
    expect(bar.el.classList.contains("toolbar")).toBe(true);
  });

  it("splits into two role=group zones, each with its aria-label", () => {
    const bar = mount(basicSpec());
    const [view, file] = groups(bar);
    expect(view!.getAttribute("aria-label")).toBe("View zone");
    expect(file!.getAttribute("aria-label")).toBe("File zone");
  });

  it("renders the contextual controls into the left zone, in the given order", () => {
    const bar = mount(basicSpec());
    const [view] = groups(bar);
    const labels = [...view!.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"));
    expect(labels).toEqual(["A", "B"]);
  });

  it("renders the universal controls into the right zone, fixed and ordered", () => {
    const bar = mount(
      basicSpec({ file: [btn("dl", "Download"), btn("bin", "Move to bin")] as ToolbarControl[] }),
    );
    const [, file] = groups(bar);
    const labels = [...file!.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"));
    expect(labels).toEqual(["Download", "Move to bin"]);
  });

  it("does not render a contextual control that is absent from the spec", () => {
    const bar = mount(basicSpec({ view: [btn("a", "A")] as ToolbarControl[] }));
    expect(bar.control("b")).toBeUndefined();
    expect(bar.el.querySelector('[aria-label="B"]')).toBeNull();
  });

  it("places a decorative divider between the zones — aria-hidden, never a glyph", () => {
    const bar = mount(basicSpec());
    const sep = bar.el.querySelector(".toolbar__sep")!;
    expect(sep).not.toBeNull();
    expect(sep.getAttribute("aria-hidden")).toBe("true");
    // No text: a `|` would be read aloud.
    expect(sep.textContent).toBe("");
    expect(bar.el.textContent).not.toContain("|");
    const [view, file] = groups(bar);
    const order = [...bar.el.children];
    expect(order.indexOf(view!)).toBeLessThan(order.indexOf(sep));
    expect(order.indexOf(sep)).toBeLessThan(order.indexOf(file!));
  });

  it("builds a declarative button with its glyph, label, and accessible name", () => {
    const bar = mount(basicSpec({ view: [btn("z", "Zoom in", { icon: "<svg></svg>" })] as ToolbarControl[] }));
    const b = bar.control("z")!;
    expect(b.tagName).toBe("BUTTON");
    expect(b.querySelector("svg")).not.toBeNull();
    expect(b.textContent).toBe("Zoom in");
    expect(b.getAttribute("aria-label")).toBe("Zoom in");
  });

  it("drops the visible label for an icon-only control but keeps the aria-label", () => {
    const bar = mount(
      basicSpec({ view: [btn("z", "Zoom in", { icon: "<svg></svg>", iconOnly: true })] as ToolbarControl[] }),
    );
    const b = bar.control("z")!;
    expect(b.textContent).toBe("");
    expect(b.getAttribute("aria-label")).toBe("Zoom in");
    expect(b.querySelector("svg")).not.toBeNull();
  });

  it("renders a toggle's aria-pressed from the spec", () => {
    const bar = mount(
      basicSpec({
        view: [btn("f", "Find", { pressed: false }), btn("o", "Text", { pressed: true })] as ToolbarControl[],
      }),
    );
    expect(bar.control("f")!.getAttribute("aria-pressed")).toBe("false");
    expect(bar.control("o")!.getAttribute("aria-pressed")).toBe("true");
    expect(bar.control("a")).toBeUndefined();
  });

  it("renders a disabled button as genuinely disabled", () => {
    const bar = mount(basicSpec({ view: [btn("a", "A", { disabled: true })] as ToolbarControl[] }));
    expect((bar.control("a") as HTMLButtonElement).disabled).toBe(true);
  });

  it("fires onClick with the built button", () => {
    const spy = vi.fn();
    const bar = mount(basicSpec({ view: [btn("a", "A", { onClick: spy })] as ToolbarControl[] }));
    (bar.control("a") as HTMLButtonElement).click();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(bar.control("a"));
  });

  it("exposes each control by key, and returns undefined for an unknown key", () => {
    const bar = mount(basicSpec());
    expect(bar.control("a")).not.toBeUndefined();
    expect(bar.control("d")).not.toBeUndefined();
    expect(bar.control("nope")).toBeUndefined();
  });

  it("places a pre-built custom control and returns its element by key", () => {
    const cluster = el("div", { class: "pager" }, el("button", { text: "−" }), el("button", { text: "+" }));
    const bar = mount(basicSpec({ view: [{ kind: "custom", key: "zoom", el: cluster }] as ToolbarControl[] }));
    expect(bar.control("zoom")).toBe(cluster);
    const [view] = groups(bar);
    expect(view!.contains(cluster)).toBe(true);
  });

  it("renders leading elements outside both zones, ahead of the spacer", () => {
    const bar = mount(basicSpec());
    const back = bar.el.querySelector("button")!;
    const spacer = bar.el.querySelector(".toolbar__spacer")!;
    for (const g of groups(bar)) expect(g.contains(back)).toBe(false);
    const order = [...bar.el.children];
    expect(order.indexOf(back)).toBeLessThan(order.indexOf(spacer));
  });

  it("makes the whole bar one tab stop: exactly one focusable at tabindex 0", () => {
    const bar = mount(basicSpec());
    const zeros = [...bar.el.querySelectorAll('[tabindex="0"]')];
    const minus = [...bar.el.querySelectorAll('[tabindex="-1"]')];
    expect(zeros).toHaveLength(1);
    expect((zeros[0] as HTMLElement).textContent).toBe("Back");
    // The three controls and the phone's ⋯ (hidden wider, and skipped then).
    expect(minus).toHaveLength(4);
  });

  it("moves the tab stop to the next control on ArrowRight, and focuses it", () => {
    const bar = mount(basicSpec());
    const back = bar.el.querySelector("button")!;
    back.focus();
    key(back, "ArrowRight");
    const a = bar.control("a")!;
    expect(a.getAttribute("tabindex")).toBe("0");
    expect(back.getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(a);
  });

  it("wraps from the first control to the last on ArrowLeft", () => {
    const bar = mount(basicSpec());
    const back = bar.el.querySelector("button")!;
    back.focus();
    key(back, "ArrowLeft");
    expect(document.activeElement).toBe(bar.control("d"));
  });

  it("jumps to the ends with Home and End", () => {
    const bar = mount(basicSpec());
    const back = bar.el.querySelector("button")!;
    back.focus();
    key(back, "End");
    expect(document.activeElement).toBe(bar.control("d"));
    key(bar.control("d")!, "Home");
    expect(document.activeElement).toBe(back);
  });

  it("skips hidden controls while roving, and ignores keys from unregistered descendants", () => {
    // A custom control's inner button not declared focusable stays out of the roving set.
    const stray = el("button", { text: "menu item" });
    const bar = mount(
      basicSpec({ file: [btn("d", "Download"), { kind: "custom", key: "menu", el: stray }] as ToolbarControl[] }),
    );
    const back = bar.el.querySelector("button")!;
    back.focus();
    key(back, "ArrowRight");
    (bar.control("b") as HTMLButtonElement).hidden = true;
    key(bar.control("a")!, "ArrowRight");
    expect(document.activeElement).toBe(bar.control("d"));

    const before = bar.control("d")!.getAttribute("tabindex");
    key(stray, "ArrowLeft");
    expect(bar.control("d")!.getAttribute("tabindex")).toBe(before);
  });
});
