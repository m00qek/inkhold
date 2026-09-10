// The shared viewer DOWNLOAD/EXPORT menu — the trigger, the popover and the row
// mechanics every viewer's file zone carries. Only the mechanics live here; the
// CONTENT is the viewer's own and goes into `pop`.

import { el } from "../ui/dom";
import { svg, VIEWER_IC } from "./viewerIcons";

/** A raw-file download row: closes the menu and navigates to the current href as
 *  an attachment. The href is minted per open; `setHref(null)` disables the row. */
export interface ViewerRawItem {
  el: HTMLButtonElement;
  setHref(href: string | null): void;
}

export interface ViewerExportMenu {
  /** The `.menu` container — a toolbar `file` slot. */
  el: HTMLElement;
  /** The Download trigger — the slot's one focusable. */
  trigger: HTMLButtonElement;
  /** The `.menu__pop`; the viewer appends its own content groups here. */
  pop: HTMLElement;
  /** An enabled export row (label + `.kbd` ext) that closes the menu, runs `run`
   *  disabled-meanwhile, and toasts on failure without wedging. */
  item(label: string, ext: string, run: () => Promise<void>): HTMLButtonElement;
  /** A raw-file row — the one non-transformed option (see {@link ViewerRawItem}). */
  rawItem(label: string, ext: string): ViewerRawItem;
  isOpen(): boolean;
  setOpen(open: boolean): void;
  /** Drop the document listeners (viewer destroy). */
  destroy(): void;
}

/**
 * The download/export dropdown every viewer's file zone carries.
 *
 * Deliberately IN-FLOW / non-portaled — NOT routed through `ui/menu.ts`, which
 * explicitly carves these page-scoped viewer menus out (`ui/menu.ts:14,264`).
 *
 * Only the MECHANICS are shared; the CONTENT differs (spd: PNG/ORA × view + raw;
 * reader: +PDF, whole-notebook, raw `.note`) and the viewer builds it into `pop`.
 *
 * Escape closes the menu via a self-contained document handler that
 * `stopImmediatePropagation()`s, so a host keydown listener (the reader's
 * `onKey`) does not ALSO act on the same Escape.
 */
export function createViewerExportMenu(opts: {
  toast: (message: string) => void;
  /** Extra class on the `.menu` container (spd: `"viewer__export"`). */
  className?: string;
  /** The trigger's `aria-haspopup`. Default `"menu"`; the reader uses `"true"`. */
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

  /** Run an export with its row disabled meanwhile; a failure tells the user, never wedges. */
  async function guard(btn: HTMLButtonElement, run: () => Promise<void>): Promise<void> {
    btn.disabled = true;
    try {
      await run();
    } catch (e) {
      // The toast is what the user can act on; this is what anyone diagnosing
      // a failed export can.
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
    // The one non-transformed option, the old `<a download>` behaviour: navigate
    // to the download URL (its Content-Disposition names it).
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
      // Consume it so a host keydown listener does not also act on this Escape.
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
