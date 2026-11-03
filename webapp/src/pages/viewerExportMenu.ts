// The shared viewer download/export menu: trigger, popover and row mechanics.
// Each viewer builds its own content into `pop`.

import { el } from "../ui/dom";
import { svg, VIEWER_IC } from "./viewerIcons";

/** A raw-file download row; `setHref(null)` disables it. */
export interface ViewerRawItem {
  el: HTMLButtonElement;
  setHref(href: string | null): void;
}

export interface ViewerExportMenu {
  el: HTMLElement;
  trigger: HTMLButtonElement;
  pop: HTMLElement;
  item(label: string, ext: string, run: () => Promise<void>): HTMLButtonElement;
  rawItem(label: string, ext: string): ViewerRawItem;
  isOpen(): boolean;
  setOpen(open: boolean): void;
  destroy(): void;
}

/**
 * In-flow, not portaled through `ui/menu.ts`. Escape is handled by a document
 * listener that calls `stopImmediatePropagation()` so the host's keydown handler
 * does not also act on it.
 */
export function createViewerExportMenu(opts: {
  toast: (message: string) => void;
  className?: string;
  haspopup?: string;
}): ViewerExportMenu {
  const trigger = el("button", {
    class: "btn",
    type: "button",
    "aria-haspopup": opts.haspopup ?? "menu",
    "aria-expanded": "false",
    "aria-label": "Download",
    title: "Download",
    html: svg(VIEWER_IC.down, 1.8),
  }) as HTMLButtonElement;
  const pop = el("div", { class: "menu__pop", role: "menu" });
  const menu = el("div", { class: `menu${opts.className ? ` ${opts.className}` : ""}` }, trigger, pop);

  let open = false;
  function setOpen(next: boolean): void {
    open = next;
    menu.classList.toggle("is-open", next);
    trigger.setAttribute("aria-expanded", String(next));
  }

  async function guard(btn: HTMLButtonElement, run: () => Promise<void>): Promise<void> {
    btn.disabled = true;
    try {
      await run();
    } catch (e) {
      console.error("Export failed", e);
      opts.toast("Couldn't build that export. Try again.");
    } finally {
      btn.disabled = false;
    }
  }

  function item(label: string, ext: string, run: () => Promise<void>): HTMLButtonElement {
    const btn = el("button", {
      class: "menu__item",
      type: "button",
      role: "menuitem",
      html: `<span>${label}</span><kbd>${ext}</kbd>`,
    }) as HTMLButtonElement;
    btn.addEventListener("click", () => {
      setOpen(false);
      void guard(btn, run);
    });
    return btn;
  }

  function rawItem(label: string, ext: string): ViewerRawItem {
    let href: string | null = null;
    const btn = el("button", {
      class: "menu__item",
      type: "button",
      role: "menuitem",
      html: `<span>${label}</span><kbd>${ext}</kbd>`,
    }) as HTMLButtonElement;
    btn.addEventListener("click", () => {
      setOpen(false);
      if (href === null) return;
      const a = document.createElement("a");
      a.href = href;
      a.download = "";
      a.rel = "noopener";
      document.body.append(a);
      a.click();
      a.remove();
    });
    return {
      el: btn,
      setHref(next) {
        href = next;
        btn.disabled = next === null;
      },
    };
  }

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    setOpen(!open);
  });
  function onDocClick(e: MouseEvent): void {
    if (!open) return;
    if (e.target instanceof Node && menu.contains(e.target)) return;
    setOpen(false);
  }
  function onDocKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape" && open) {
      setOpen(false);
      e.stopImmediatePropagation();
    }
  }
  document.addEventListener("click", onDocClick);
  document.addEventListener("keydown", onDocKeydown);

  return {
    el: menu,
    trigger,
    pop,
    item,
    rawItem,
    isOpen: () => open,
    setOpen,
    destroy() {
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onDocKeydown);
    },
  };
}
