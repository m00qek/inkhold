// A document's digests, in a side panel of its viewer: the passages taken from
// it on the tablet, in page order, each one a step to its page. The rows on the
// page on screen are marked, as the outline marks its entry. Each row also
// links to the digest on the Digest page, where its comment can be changed;
// here it is read only. Shared by the PDF viewer and the notebook reader.

import { el } from "../../ui/dom";
import { onPlainClick } from "../../ui/link";
import { createSidePanel, sidePanelState } from "../../ui/sidePanel";
import { digestHref, go } from "../../router";
import { svg } from "../viewer/viewerIcons";
import { ICONS } from "../../ui/icons";
import type { Digest } from "../../api/digestTypes";
import type { DigestInk } from "./digestInk";
import { changedLine, digestPlace, placePath, shorten } from "./digestModel";

export interface DigestDocPanel {
  /** The panel, also the scroll container. */
  el: HTMLElement;
  /** (Re)build the list, in the order given (page order). */
  setDigests(digests: readonly Digest[]): void;
  /** Marks the rows on this page (0-based). */
  setCurrent(page: number): void;
  setOpen(open: boolean): void;
  clear(): void;
}

export interface DigestDocPanelOptions {
  id: string;
  ink: DigestInk;
  /** Go to a page (0-based). */
  onPick(page: number): void;
  onClose?: () => void;
}

export function createDigestDocPanel(opts: DigestDocPanelOptions): DigestDocPanel {
  const list = el("ul", { class: "digest-doc" });
  const panel = createSidePanel({
    id: opts.id,
    ariaLabel: "Digests",
    icon: svg(ICONS.digest, 1.7),
    label: "Digests",
    hookPrefix: "digests",
    onClose: opts.onClose,
  });
  panel.body.append(list);

  let digests: readonly Digest[] = [];
  let rows: HTMLElement[] = [];
  let current = -1;

  function row(d: Digest): HTMLElement {
    const page = d.source.page;
    const step = el(
      "button",
      { class: "digest-doc__go", type: "button", disabled: page === null },
      el("span", { class: "digest-doc__page", text: page === null ? "" : `p. ${page}` }),
      el("q", { class: "digest-doc__text", text: shorten(d.text) }),
    );
    if (page !== null) step.addEventListener("click", () => opts.onPick(page - 1));
    const ink = opts.ink.holder(d, "digest-doc__ink");
    ink?.setAttribute("role", "img");
    ink?.setAttribute("aria-label", "Handwritten note");
    const href = digestHref(placePath(digestPlace(d)));
    const open = el("a", { class: "digest-doc__open", href, text: "Open in Digest" });
    onPlainClick(open, () => go(href));
    return el(
      "li",
      { class: "digest-doc__row", "data-page": page === null ? "" : String(page - 1) },
      step,
      d.comment ? el("p", { class: "digest-doc__comment", text: shorten(d.comment) }) : null,
      d.source.changed ? el("p", { class: "digest-doc__changed", text: changedLine(d) }) : null,
      ink,
      open,
    );
  }

  function mark(): void {
    for (const r of rows) {
      const on = r.dataset.page === String(current);
      r.classList.toggle("is-current", on);
      r.querySelector(".digest-doc__go")?.setAttribute("aria-current", on ? "true" : "false");
    }
  }

  /** The first row on the current page, kept in view; measured, not `scrollIntoView()`, which also moves the stage. */
  function reveal(): void {
    const r = rows.find((x) => x.dataset.page === String(current));
    if (!r) return;
    const box = panel.el;
    const a = r.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    if (a.top < b.top) box.scrollTop += a.top - b.top;
    else if (a.bottom > b.bottom) box.scrollTop += a.bottom - b.bottom;
  }

  function clear(): void {
    digests = [];
    rows = [];
    current = -1;
    list.replaceChildren();
  }

  return {
    el: panel.el,
    setDigests(next) {
      clear();
      digests = next;
      rows = digests.map(row);
      if (rows.length === 0) list.replaceChildren(el("li", {}, sidePanelState("empty", "No digests from this document.")));
      else list.append(...rows);
    },
    setCurrent(page) {
      current = page;
      mark();
    },
    setOpen(open) {
      panel.setOpen(open);
      // A hidden element measures 0×0, so reveal only on open.
      if (open) reveal();
    },
    clear,
  };
}
