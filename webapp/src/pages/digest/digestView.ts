// The Digest page's markup, painted whole from a snapshot and a place by
// `digestPage.ts`. Three parts side by side, like the tablet's app: the
// groups (categories, or sources), the digests of the one picked, and the
// digest open in a side panel. Everything that goes somewhere is a link to
// its place, so a digest can be opened in a new tab or sent to someone.

import { el } from "../../ui/dom";
import { ICONS, svg } from "../../ui/icons";
import { onPlainClick } from "../../ui/link";
import { digestHref, notePageHref } from "../../router";
import { absoluteDate } from "../../ui/relativeTime";
import type { Digest, DigestSnapshot } from "../../api/digestTypes";
import type { DigestInk } from "./digestInk";
import {
  categoryName, categoryRows, digestsIn, placePath, sameView, sourceGroups, sourceLine, SOURCE_SECTIONS, tabOf, viewTitle,
  type DigestPlace, type DigestView,
} from "./digestModel";

export interface DigestActions {
  /** Go to a place (its URL). */
  go(p: DigestPlace): void;
  /** Open the digest's source at its page. */
  openSource(d: Digest): void;
  copy(d: Digest): void;
}

export interface DigestPaint {
  snap: DigestSnapshot;
  place: DigestPlace;
  ink: DigestInk;
}

/** A link to a place that the app follows itself. */
function placeLink(p: DigestPlace, a: DigestActions, attrs: Record<string, unknown>, ...kids: (Node | string | null)[]): HTMLAnchorElement {
  const link = el("a", { ...attrs, href: digestHref(placePath(p)) }, ...kids);
  onPlainClick(link, () => a.go(p));
  return link;
}

const icon = (name: keyof typeof ICONS) => el("span", { class: "digest-icon", html: svg(ICONS[name]) });

/** Where the person is, as the topbar names it. */
export function placeTitle(snap: DigestSnapshot | null): HTMLElement {
  const n = snap?.enabled ? snap.digests.length : null;
  return el(
    "div",
    { class: "digest-place" },
    el("b", { class: "digest-place__name", text: "Digest" }),
    el("span", { class: "digest-place__sum", text: n === null ? "Digest" : n === 1 ? "1 digest" : `${n} digests` }),
  );
}

/** Categories | Sources: the tablet's two ways in. */
export function tabs(place: DigestPlace, a: DigestActions): HTMLElement {
  const tab = (name: string, view: DigestView) => {
    const on = tabOf(place.view) === tabOf(view);
    return placeLink({ view, digest: null }, a, { class: "digest-tab", "aria-current": on ? "page" : null }, name);
  };
  return el(
    "nav",
    { class: "digest-tabs", "aria-label": "Browse digests by" },
    tab("Categories", { kind: "category", uid: null }),
    tab("Sources", { kind: "source", key: null }),
  );
}

/** The groups of the tab on screen, each with its count. */
export function groups(p: DigestPaint, a: DigestActions): HTMLElement {
  const v = p.place.view;
  const row = (view: DigestView, name: string, count: number, glyph: keyof typeof ICONS) =>
    el(
      "li",
      {},
      placeLink(
        { view, digest: null },
        a,
        { class: "digest-group", "aria-current": sameView(view, v) ? "page" : null },
        icon(glyph),
        el("span", { class: "digest-group__name", text: name }),
        el("span", { class: "digest-group__count", text: String(count) }),
      ),
    );
  if (v.kind === "category") {
    return el(
      "nav",
      { class: "digest-groups", "aria-label": "Categories" },
      el("ul", {}, ...categoryRows(p.snap).map((r) => row({ kind: "category", uid: r.uid }, r.name, r.count, r.uid === null ? "stack" : r.uid === "" ? "inbox" : "folder"))),
    );
  }
  const all = sourceGroups(p.snap);
  const glyph = { document: "doc", note: "note", manual: "edit", other: "doc" } as const;
  return el(
    "nav",
    { class: "digest-groups", "aria-label": "Sources" },
    el("ul", {}, row({ kind: "source", key: null }, "All sources", p.snap.digests.length, "stack")),
    ...SOURCE_SECTIONS.flatMap((sec) => {
      const mine = all.filter((g) => g.kind === sec.kind);
      if (mine.length === 0) return [];
      // What was typed on the tablet is one group, its row named like its section.
      if (sec.kind === "manual") return [el("ul", { class: "digest-groups__alone" }, ...mine.map((g) => row({ kind: "source", key: g.key }, g.name, g.digests.length, glyph[g.kind])))];
      return [
        el("p", { class: "digest-groups__label", text: sec.name }),
        el("ul", {}, ...mine.map((g) => row({ kind: "source", key: g.key }, g.name, g.digests.length, glyph[g.kind]))),
      ];
    }),
  );
}

/** The view's digests as cards; a source's in page order, with the page beside each. */
export function list(p: DigestPaint, a: DigestActions): HTMLElement {
  const v = p.place.view;
  const title = viewTitle(p.snap, v);
  const head = el("h2", { class: "digest-list__title", id: "digest-list-title", text: title ?? "Digest" });
  if (title === null) {
    const gone = v.kind === "category" ? "This category is gone" : "No digest comes from this file any more";
    return el(
      "section",
      { class: "digest-list", "aria-labelledby": "digest-list-title" },
      head,
      notice(gone, "It may have been deleted or moved on the tablet.", null, placeLink({ view: { kind: "category", uid: null }, digest: null }, a, { class: "btn" }, "See all digests")),
    );
  }
  const byPage = v.kind === "source";
  const item = (d: Digest) => el("li", {}, card(d, p, a, byPage));
  // Every source at once: each under its name.
  const items =
    v.kind === "source" && v.key === null
      ? sourceGroups(p.snap).flatMap((g) => [el("li", { class: "digest-list__source" }, el("h3", { text: g.name })), ...g.digests.map(item)])
      : digestsIn(p.snap, v).map(item);
  return el(
    "section",
    { class: "digest-list", "aria-labelledby": "digest-list-title" },
    head,
    items.length === 0 ? emptyList(p.snap, v) : el("ul", { class: "digest-cards" }, ...items),
  );
}

function emptyList(s: DigestSnapshot, v: DigestView): HTMLElement {
  if (s.digests.length === 0) {
    return notice(
      "No digests yet",
      "On the tablet, select a passage in a document or handwriting in a note and add it to Digest. It shows up here after the tablet syncs.",
      null,
    );
  }
  return notice(v.kind === "category" && v.uid !== null ? "Nothing in this category" : "Nothing here", "Digests put here on the tablet show up after it syncs.", null);
}

function card(d: Digest, p: DigestPaint, a: DigestActions, byPage: boolean): HTMLElement {
  const open = p.place.digest === d.id;
  const meta = [byPage ? null : sourceLine(d), absoluteDate(d.createdAt)].filter((x): x is string => x !== null);
  const ink = p.ink.holder(d, "digest-card__ink");
  ink?.setAttribute("aria-hidden", "true");
  return el(
    "article",
    { class: `digest-card${byPage ? " digest-card--paged" : ""}${open ? " is-open" : ""}` },
    byPage ? el("span", { class: "digest-card__page", text: d.source.page === null ? "" : `p. ${d.source.page}` }) : null,
    // The text is the link, stretched over the card; the card draws its focus.
    placeLink(
      { view: p.place.view, digest: d.id },
      a,
      { class: "digest-card__link", "data-digest": d.id, "aria-current": open ? "true" : null },
      el("q", { class: "digest-card__text", text: d.text }),
    ),
    d.comment ? el("p", { class: "digest-card__comment", text: d.comment }) : null,
    el(
      "p",
      { class: "digest-card__meta" },
      ...meta.map((m) => el("span", { text: m })),
      d.note ? el("span", { class: "digest-card__tag", text: "Handwritten note" }) : null,
    ),
    ink,
  );
}

/** The digest open beside the list: all of it, and where it came from. */
export function panel(p: DigestPaint, a: DigestActions): HTMLElement | null {
  const d = p.place.digest === null ? null : p.snap.digests.find((x) => x.id === p.place.digest);
  if (!d) return null;
  const close = placeLink({ view: p.place.view, digest: null }, a, { class: "icon-btn digest-panel__close", "aria-label": "Close the digest", title: "Close" }, el("span", { html: svg(ICONS.close) }));
  const note = p.ink.holder(d, "digest-panel__ink");
  note?.setAttribute("role", "img");
  note?.setAttribute("aria-label", "Handwritten note");
  const facts: [string, string][] = [
    ["From", sourceLine(d)],
    ["Category", categoryName(p.snap, d)],
    ...(d.author ? [["Author", d.author] as [string, string]] : []),
    ["Made", absoluteDate(d.createdAt)],
  ];
  const copy = el("button", { class: "btn", type: "button", text: "Copy text" });
  copy.addEventListener("click", () => a.copy(d));
  return el(
    "section",
    { class: "digest-panel", "aria-labelledby": "digest-panel-title" },
    el("div", { class: "digest-panel__head" }, el("h2", { class: "digest-panel__title", id: "digest-panel-title", text: "Selected digest" }), close),
    el("blockquote", { class: "digest-panel__text" }, el("p", { text: d.text })),
    d.comment ? el("div", { class: "digest-panel__part" }, el("h3", { text: "Comment" }), el("p", { text: d.comment })) : null,
    note ? el("div", { class: "digest-panel__part" }, el("h3", { text: "Handwritten note" }), note) : null,
    el("dl", { class: "digest-panel__facts" }, ...facts.flatMap(([k, v]) => [el("dt", { text: k }), el("dd", { text: v })])),
    el("div", { class: "digest-panel__actions" }, openLink(d, a), copy),
    d.source.kind !== "manual" && d.source.fileId === null
      ? el("p", { class: "digest-panel__aside", text: "That file is not in the library, so it can't be opened here." })
      : null,
  );
}

/** A link to the digest's source at its page, which the app opens itself; null when the library hasn't the file. */
function openLink(d: Digest, a: DigestActions): HTMLElement | null {
  const s = d.source;
  if (s.kind === "manual" || s.fileId === null) return null;
  const text = s.page === null ? "Open the file" : `Open at page ${s.page}`;
  const link = el("a", { class: "btn", href: notePageHref(s.fileId, Math.max(0, (s.page ?? 1) - 1)), text });
  onPlainClick(link, () => a.openSource(d));
  return link;
}

export function notice(title: string, text: string, retry: (() => void) | null, action: HTMLElement | null = null): HTMLElement {
  const b = retry ? el("button", { class: "btn", type: "button", text: "Try again" }) : null;
  b?.addEventListener("click", () => retry!());
  return el("div", { class: "digest-empty" }, el("p", { class: "digest-empty__title", text: title }), el("p", { text }), b, action);
}
