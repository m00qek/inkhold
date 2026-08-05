// The shared viewer chrome. The three viewers — the `.note` reader, the `.spd`
// viewer, the `.txt` viewer — re-implemented the same toolbar surface four times
// over: the icon table, the `svg()` wrapper, the back+title header, the zoom
// stepper, the download/export menu, the placeholder body, and the find debounce.
// This module owns the INVARIANT parts of that surface; each viewer parameterises
// only what legitimately differs (its readout class, its value model, its menu
// content). See docs/design/viewer-chrome-refactor.md.
//
// `svg()` is NOT re-implemented here — it is the ONE impl in `ui/icons.ts`, which
// this file re-exports so a viewer takes both the glyphs and the wrapper from a
// single import.

import { ICONS, svg } from "../ui/icons";
import { el } from "../ui/dom";
import { relativeTime, absoluteTime } from "../ui/relativeTime";
import type { ReaderOrigin } from "./viewer";

export { svg };

/**
 * Quiet period, ms, before a find query is sent / the URL settles — one value so
 * the whole app debounces search-as-you-type identically, and the address bar
 * lands with the results rather than a beat behind them. The reader's URL sync,
 * the `.txt` viewer's find, and the find controller's own default all read it.
 */
export const VIEWER_DEBOUNCE_MS = 220;

/**
 * The word Back carries — where the file was opened FROM. `search`/`bin` are
 * fixed labels; a folder resolves to its DEEPEST segment (`Note / Projects` →
 * `Projects`), and the empty/absent path is the whole `Library`. Shared because
 * spd + txt were byte-identical and the reader re-derived the same answer inline.
 */
export function backWord(origin: ReaderOrigin): string {
  if (origin.kind === "search") return "Search";
  if (origin.kind === "bin") return "Recycle bin";
  const parts = (origin.folderPath ?? "").split("/").map((s) => s.trim()).filter(Boolean);
  return parts.length === 0 ? "Library" : parts[parts.length - 1]!;
}

/**
 * The header's SUBTITLE, prefixed with where the file lives.
 *
 * `rest` is whatever the viewer knows that the screen does not already say — the
 * reader uses a page count for a note and `TYPE · size` for everything else. The
 * folder path is the part no other control carries: the toolbar's Back button
 * names only the DEEPEST segment (see {@link backWord}), so `Note / Projects`
 * reads as "Projects" there and the full path appears nowhere else.
 *
 * Lifted out of `reader.ts`, where it was module-private, when the PDF viewer
 * turned out to be showing a bare `"PDF"` — a fact the library, the file icon and
 * the pager's `/ 77` all already carry — and no path at all.
 */
export function originSubtitle(origin: ReaderOrigin, rest: string): string {
  if (origin.kind === "folder" || origin.folderPath === null) return rest;
  return `${origin.folderPath} · ${rest}`;
}

/**
 * The `− [readout] +` stepper every viewer's zoom (and the `.txt` font/width)
 * controls share: a `.pager` holding two `.icon-btn`s around a readout `<span>`.
 *
 * ONLY the skeleton and the clamp-silently plumbing are shared; the VALUE MODEL
 * stays with the viewer. `onStep(dir)` performs the step — clamp, apply, persist
 * — and RETURNS the value now shown; the stepper renders it through `format`, so
 * a step that clamped at a bound returns the unchanged value and the readout does
 * not flicker. `set(v)` repaints the readout for an external reset (a new file).
 *
 * The readout keeps its PER-VIEWER class (`.zoom` / `.spd-zoom` / `.txt-zoom`):
 * every viewer is mounted at once, so a shared class would make a bare `.zoom`
 * Playwright locator resolve to several elements. It is a parameter here, never a
 * constant.
 */
export interface ZoomStepper<V> {
  /** The `.pager` element — a toolbar `view` slot (also the thing a viewer hides). */
  el: HTMLElement;
  /** The two stepper buttons in order, for the toolbar's roving-tabindex `focus`. */
  focus: HTMLButtonElement[];
  /** Repaint the readout to show `value` (via `format`) — for external resets. */
  set(value: V): void;
}

export function createZoomStepper<V>(opts: {
  /** The readout `<span>`'s class — kept per-viewer (see the interface docs). */
  readoutClass: string;
  /** The value the readout shows before any step. */
  initial: V;
  /** Render a value as the readout's text. */
  format: (value: V) => string;
  /** Perform a step in `dir` (clamp/apply/persist) and return the value now shown. */
  onStep: (dir: 1 | -1) => V;
  /** The stepper buttons' `aria-label`s. Default "Zoom out"/"Zoom in". */
  labels?: { out: string; in: string };
}): ZoomStepper<V> {
  const out = el("button", {
    class: "icon-btn",
    type: "button",
    "aria-label": opts.labels?.out ?? "Zoom out",
    html: svg(VIEWER_IC.minus, 1.8),
  }) as HTMLButtonElement;
  const plus = el("button", {
    class: "icon-btn",
    type: "button",
    "aria-label": opts.labels?.in ?? "Zoom in",
    html: svg(VIEWER_IC.plus, 1.8),
  }) as HTMLButtonElement;
  const readout = el("span", { class: opts.readoutClass, text: opts.format(opts.initial) });
  const pager = el("div", { class: "pager" }, out, readout, plus);
  const set = (value: V): void => void (readout.textContent = opts.format(value));
  out.addEventListener("click", () => set(opts.onStep(-1)));
  plus.addEventListener("click", () => set(opts.onStep(1)));
  return { el: pager, focus: [out, plus], set };
}

export interface ViewerBody {
  /** The `.viewer__main` element — mounted in the viewer's root. */
  main: HTMLElement;
  /** The `.viewer__placeholder` — the centred loading/error card. */
  placeholder: HTMLElement;
  /**
   * Paint the centred placeholder (a type MARK over a title over a body line) and
   * show it in `main`. Device-authored strings go in as text, never markup.
   */
  showPlaceholder(title: string, body: string): void;
}

/**
 * The `.viewer__main` + `.viewer__placeholder` body the `.spd` and `.txt` viewers
 * share: a centred card of `mark` / title / body for the loading and error
 * states. The RENDERED content is the viewer's own (spd swaps to a separate
 * `.spd-body`, txt swaps `main`'s children to the text `<pre>`), so this owns only
 * the placeholder — the parallel half the two had byte-for-byte in common.
 *
 * The reader keeps its OWN `fileStage`/`.empty` path and does not use this.
 */
export function createViewerBody(opts: { mark: string }): ViewerBody {
  const placeholder = el("div", { class: "viewer__placeholder" });
  const main = el("div", { class: "viewer__main" }, placeholder);
  function showPlaceholder(title: string, body: string): void {
    placeholder.replaceChildren(
      el("div", { class: "viewer__mark", text: opts.mark }),
      el("h3", { text: title }),
      el("p", { text: body }),
    );
    main.replaceChildren(placeholder);
  }
  return { main, placeholder, showPlaceholder };
}

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
 * The download/export dropdown every viewer's file zone carries: the trigger,
 * the popover, the `menuItem`/`guard`/`setOpen` mechanics, and the outside-click
 * + Escape close — ~80% byte-identical between the reader and the `.spd` viewer
 * before this, and a re-implementation of `ui/menu.ts` besides.
 *
 * Deliberately IN-FLOW / non-portaled — NOT routed through `ui/menu.ts`, which
 * explicitly carves these page-scoped viewer menus out (`ui/menu.ts:14,264`).
 *
 * Only the MECHANICS are shared; the CONTENT differs (spd: PNG/ORA × view + raw;
 * reader: +PDF, whole-notebook, raw `.note`) and the viewer builds it into `pop`.
 *
 * Escape closes the menu via a self-contained document handler that
 * `stopImmediatePropagation()`s, so a host keydown listener (the reader's `onKey`)
 * does not ALSO act on the same Escape — the reader gains this self-contained
 * handler and drops its inline menu-Escape special case.
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
    } catch {
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

/** The "previewing an older version" banner every raw-based viewer shows in a
 *  history preview. See {@link createVersionBanner}. */
export interface VersionBanner {
  /** The `.version-banner` strip — mounted under the toolbar. */
  el: HTMLElement;
  /**
   * Show the banner for the version created at `version.createdAt` (epoch ms, its
   * absolute stamp on hover), or hide it with `null`. Toggling it is the whole of
   * a viewer's history-mode chrome switch — a live/bin open passes `null`.
   *
   * `viewOnly` (a TRASHED file's version preview) SUPPRESSES the Restore button:
   * the bin's version history is browse + preview, not restore-a-version (restore
   * the file first — bin-parity.md). The WHEN line stays either way.
   */
  setVersion(version: { createdAt: number } | null, viewOnly?: boolean): void;
}

/**
 * The full-width "you're viewing an older version — this is not the current note"
 * strip, with the one action safe on a read-only preview: Restore. Extracted so
 * the `.spd` and `.txt` viewers get the SAME banner the note reader's history
 * mode has — same markup, same `.version-banner` styling — rather than each
 * hand-rolling a second one. The restore click is handed out (`onRestore`); the
 * viewer routes it to `deps.onRestoreVersion`, the shared confirm+restore path
 * (`runRestore`/`confirmRestore`) the reader and the history list already share,
 * so no viewer reaches restore around that machinery.
 */
export function createVersionBanner(opts: { onRestore: () => void }): VersionBanner {
  const text = el("span", { class: "version-banner__text" });
  const restore = el("button", {
    class: "btn version-banner__restore",
    type: "button",
    text: "Restore this version",
  }) as HTMLButtonElement;
  restore.addEventListener("click", () => opts.onRestore());
  const banner = el(
    "div",
    { class: "version-banner", role: "status", hidden: true },
    el("span", { class: "version-banner__badge", "aria-hidden": "true", html: svg(VIEWER_IC.restore, 1.6) }),
    text,
    restore,
  );
  return {
    el: banner,
    setVersion(version, viewOnly = false) {
      banner.hidden = version === null;
      // View-only (trashed) previews drop Restore; the row stays a WHEN report.
      restore.hidden = viewOnly;
      if (version) {
        text.textContent = `You're viewing a version from ${relativeTime(version.createdAt)} — this is not the current note.`;
        text.title = absoluteTime(version.createdAt);
      }
    },
  };
}

/** The class names a viewer stamps on its header parts. The reader keeps its
 *  legacy `.backbtn`/`.reader__title` names; spd/txt use the `.viewer__*` family.
 *  Parameterised rather than unified so migrating the reader is not pure CSS/e2e
 *  churn. */
export interface ViewerHeaderClasses {
  back: string;
  backLabel: string;
  title: string;
}

export interface ViewerHeader {
  /** The Back button (its onBack already wired) — a leading toolbar item. */
  back: HTMLButtonElement;
  /** The `name` + `subtitle` block — the second leading toolbar item. */
  title: HTMLElement;
  setName(name: string): void;
  setSubtitle(sub: string): void;
  /** The Back label word (see {@link backWord}). */
  setBackWord(word: string): void;
}

/**
 * The back+title header every viewer leads its toolbar with: a Back button whose
 * label is its destination word (chevron kept when the word is rewritten), and a
 * two-line title (name over subtitle). `back` and `title` are handed to the
 * toolbar's `leading` array as separate items — this factory owns their DOM and
 * the Back click, nothing more.
 */
export function createViewerHeader(opts: {
  classes: ViewerHeaderClasses;
  onBack: () => void;
}): ViewerHeader {
  const backLabel = el("span", { class: opts.classes.backLabel, text: "Library" });
  // The label is its own node so a caller can rewrite the WORD without touching
  // the chevron beside it — `innerHTML =` on the button would drop the icon.
  const back = el(
    "button",
    { class: opts.classes.back, type: "button", html: svg(VIEWER_IC.back, 1.8) },
    backLabel,
  ) as HTMLButtonElement;
  back.addEventListener("click", () => opts.onBack());
  const titleName = el("b", { text: "—" });
  const titleSub = el("span", { text: "—" });
  const title = el("div", { class: opts.classes.title }, titleName, titleSub);
  return {
    back,
    title,
    setName: (name) => void (titleName.textContent = name),
    setSubtitle: (sub) => void (titleSub.textContent = sub),
    setBackWord: (word) => void (backLabel.textContent = word),
  };
}

/**
 * The viewer toolbars' glyph set — the chevrons, steppers, download, close and
 * panel glyphs the reader / `.spd` / `.txt` bars (and the shared layers panel)
 * all draw, so a glyph defined once here stops being defined four times.
 *
 * Four entries are byte-identical to an app-shell glyph and RE-POINT at it, so
 * "search" / "OCR" / "trash" / "restore" are one mark across every surface that
 * offers them. The rest stay distinct on purpose:
 *
 *  - `layers` is a **3-path** stack — deliberately NOT `ICONS.layers` (a 2-path
 *    glyph): the viewer's Layers control and the gallery's Layers marker are
 *    different ideas at 16px.
 *  - `down` is the download-into-tray glyph — NOT `ICONS.export` (an up-and-out
 *    arrow): "download onto my machine" reads differently from "export/share".
 */
export const VIEWER_IC = {
  back: '<path d="m15 18-6-6 6-6"/>',
  prev: '<path d="m15 18-6-6 6-6"/>',
  next: '<path d="m9 18 6-6-6-6"/>',
  minus: '<path d="M5 12h14"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  // The download glyph — a distinct 3-path down-into-tray, NOT `ICONS.export`.
  down: '<path d="M12 3v12"/><path d="m8 11 4 4 4-4"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
  // The viewer LAYERS glyph — a 3-path stack, distinct from `ICONS.layers` (2-path).
  layers: '<path d="m12 2 9 5-9 5-9-5 9-5z"/><path d="m3 12 9 5 9-5"/><path d="m3 17 9 5 9-5"/>',
  // The page-index glyph — the reader's "Pages" panel mark (a page split into a
  // filmstrip of thumbnails), distinct from the layers stack.
  pages: '<rect x="5" y="3" width="14" height="18" rx="1.5"/><path d="M5 9h14M5 15h14"/>',
  // The layers panel's per-row eye / eye-off.
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><path d="M1 1l22 22"/><path d="M6.61 6.61A18.5 18.5 0 0 0 1 12s4 8 11 8a9.12 9.12 0 0 0 5.39-1.61"/>',
  // Byte-identical to an app-shell glyph — re-pointed so it is ONE mark everywhere.
  find: ICONS.search,
  text: ICONS.ocr,
  trash: ICONS.trash,
  restore: ICONS.restore,
};
