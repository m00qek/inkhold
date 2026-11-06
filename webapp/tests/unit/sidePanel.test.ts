// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeWith, createSidePanel } from "../../src/ui/sidePanel";

afterEach(() => document.body.replaceChildren());

describe("a side panel's ×", () => {
  it("is there only when the panel can be closed from it, and named after the panel", () => {
    const open = createSidePanel({ ariaLabel: "Pages", icon: "", label: "Pages", onClose: () => {} });
    expect(open.el.querySelector(".side-panel__close")?.getAttribute("aria-label")).toBe("Close pages");
    const fixed = createSidePanel({ ariaLabel: "Pages", icon: "", label: "Pages" });
    expect(fixed.el.querySelector(".side-panel__close")).toBeNull();
  });

  it("closes through the panel's switch, then gives focus to the switch, or to ⋯ where the switch is folded away", () => {
    const bar = document.createElement("div");
    bar.className = "toolbar";
    const toggle = document.createElement("button");
    const more = document.createElement("button");
    more.className = "toolbar__more";
    bar.append(toggle, more);
    document.body.append(bar);
    const clicked = vi.fn();
    toggle.addEventListener("click", clicked);

    Object.defineProperty(toggle, "offsetParent", { configurable: true, get: () => bar });
    closeWith(toggle)();
    expect(clicked).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(toggle);

    Object.defineProperty(toggle, "offsetParent", { configurable: true, get: () => null });
    closeWith(toggle)();
    expect(clicked).toHaveBeenCalledTimes(2);
    expect(document.activeElement).toBe(more);
  });
});
