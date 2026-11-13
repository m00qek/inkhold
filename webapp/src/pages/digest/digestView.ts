// The Digest page's markup, painted whole from a snapshot and a place by
// `digestPage.ts`, in To-Do's grammar: an overview of cards (the categories,
// or the sources), or one category's or source's digests in a column with the
// open digest's panel beside it. Everything that goes somewhere is a link to
// its place, so a digest can be opened in a new tab or sent to someone. The
// open digest's typed comment and its category are what can be changed here.

import { el } from "../../ui/dom";
import { ICONS, svg, type IconName } from "../../ui/icons";
import { onPlainClick } from "../../ui/link";
import { createMenu, type MenuItemSpec } from "../../ui/menu";
import { appCard, appCards } from "../../ui/appCard";
import { digestHref, noteHref, notePageHref } from "../../router";
import { absoluteDate, relativeTime } from "../../ui/relativeTime";
import { MAX_COMMENT, trimComment, type Digest, type DigestSnapshot, type DigestSourceKind } from "../../api/digestTypes";
import type { DigestInk } from "./digestInk";
import type { DigestThumbs } from "./digestThumbs";
import { ALL, categoryName, categoryRows, changedLine, digestsIn, opensAtPage, placePath, sourceGroups, sourceLine, viewSummary, viewTitle, type DigestPlace, type DigestView } from "./digestModel";
import { oneLine, shorten } from "../../core/passage";

export interface DigestActions {
  /** Go to a place (its URL). */
  go(p: DigestPlace): void;
  /** Open the digest's source at its page. */
  openSource(d: Digest): void;
  editComment(d: Digest): void;
  /** What is typed so far, kept across repaints. */
  draftComment(text: string): void;
  saveComment(d: Digest): void;
  cancelComment(): void;
  /** The digest's ⋯, from `trigger`: Move to…, Copy text, Move to bin. */
  digestMenu(d: Digest, trigger: HTMLElement): void;
  renameCategory(uid: string): void;
  deleteCategory(uid: string): void;
}

export interface DigestPaint {
  snap: DigestSnapshot;
  place: DigestPlace;
  ink: DigestInk;
  thumbs: DigestThumbs;
  /** The comment being edited: its digest and the text so far; null: none. */
  editing: { id: string; draft: string } | null;
  /** A save in flight. */
  busy: boolean;
}

/** A link to a place that the app follows itself. */
function placeLink(p: DigestPlace, a: DigestActions, attrs: Record<string, unknown>, ...kids: (Node | string | null)[]): HTMLAnchorElement {
  const link = el("a", { ...attrs, href: digestHref(placePath(p)) }, ...kids);
  onPlainClick(link, () => a.go(p));
  return link;
}

/** Where the person is, as the top bar names it: the view, and how many digests. */
export function placeTitle(snap: DigestSnapshot | null, view: DigestView): HTMLElement {
  const on = snap?.enabled === true;
  return el(
    "div",
    { class: "digest-place" },
    el("b", { class: "digest-place__name", text: on ? (viewTitle(snap, view) ?? "Digest") : "Digest" }),
    el("span", { class: "digest-place__sum", text: on ? viewSummary(snap, view) : "Digest" }),
  );
}

/** A category's actions, the same on its card's ⋯ and the top bar's inside it. */
export function categoryActions(uid: string, a: Pick<DigestActions, "renameCategory" | "deleteCategory">): MenuItemSpec[] {
  return [
    { label: "Rename category", icon: "edit", onSelect: () => a.renameCategory(uid) },
    { label: "Delete category", icon: "trash", danger: true, onSelect: () => a.deleteCategory(uid) },
  ];
}

const digestCount = (n: number) => (n === 0 ? "No digests" : n === 1 ? "1 digest" : `${n} digests`);

/** The landing page: Uncategorized, then a card per category the person made, its newest passage whole. */
export function categoryCards(p: DigestPaint, a: DigestActions): HTMLElement {
  const now = Date.now();
  const cards = categoryRows(p.snap)
    .filter((r): r is typeof r & { uid: string } => r.uid !== null)
    .map((r) => {
      const view: DigestView = { kind: "category", uid: r.uid };
      // Newest first: the first is the newest.
      const inside = digestsIn(p.snap, view);
      const newest = inside[0];
      const inked = inside.filter((d) => d.note !== null).length;
      const own = r.uid !== "";
      // Every card has its ⋯; Uncategorized's is there but disabled, as To-Do's Inbox.
      const menu = createMenu({
        triggerLabel: own ? `Actions for ${r.name}` : `${r.name} can't be renamed or deleted`,
        wrapClass: "card__menu",
        disabled: !own,
        items: own ? categoryActions(r.uid, a) : [],
      });
      return appCard({
        kind: "digest-card-overview",
        name: r.name,
        icon: own ? "category" : "inbox",
        href: digestHref(placePath({ view, digest: null })),
        onOpen: () => a.go({ view, digest: null }),
        counts: [
          el("span", { text: digestCount(r.count) }),
          inked > 0 ? el("span", { text: `${inked} handwritten` }) : null,
        ],
        peek: [],
        quote: newest ? { text: oneLine(newest.text), from: `${sourceLine(newest)} · added ${relativeTime(newest.createdAt, now)}` } : null,
        more: Math.max(0, inside.length - 1),
        menu,
      });
    });
  return el("div", { class: "digest-overview" }, appCards("Categories", cards));
}

const SOURCE_ICONS: Record<DigestSourceKind, IconName> = { document: "doc", note: "note", manual: "edit", other: "doc" };

/** "page 2", "pages 1–3"; null when the tablet named no page. */
function pagesOf(digests: readonly Digest[]): string | null {
  const pages = digests.map((d) => d.source.page).filter((n): n is number => n !== null);
  if (pages.length === 0) return null;
  const lo = Math.min(...pages);
  const hi = Math.max(...pages);
  return lo === hi ? `page ${lo}` : `pages ${lo}–${hi}`;
}

/**
 * The sources' page: each document or notebook as the library draws a file,
 * its first marked page as a sheet, its name under it; what was typed on the
 * tablet has a pencil for a page. The passages are inside.
 */
export function sourceCards(p: DigestPaint, a: DigestActions): HTMLElement {
  const tiles = sourceGroups(p.snap).map((g) => {
    const view: DigestView = { kind: "source", key: g.key };
    const first = g.digests[0]!;
    const page = opensAtPage(first) ? p.thumbs.holder(first, "digest-source__page") : null;
    const ext = first.source.path?.match(/\.([^./]+)$/)?.[1]?.toLowerCase();
    const n = g.digests.length;
    const meta = [ext ? `.${ext}` : null, digestCount(n), pagesOf(g.digests)].filter((x): x is string => x !== null);
    const link = placeLink(
      { view, digest: null },
      a,
      { class: "digest-source" },
      el(
        "span",
        { class: "digest-source__sheet" },
        page ?? el("span", { class: "digest-source__glyph", "aria-hidden": "true", html: svg(ICONS[SOURCE_ICONS[g.kind]]) }),
        el("span", { class: "digest-source__badge", "aria-hidden": "true", text: String(n) }),
      ),
      el("span", { class: "digest-source__name", text: g.name }),
      el("span", { class: "digest-source__meta" }, ...meta.map((m) => el("span", { text: m }))),
    );
    return el("li", {}, link);
  });
  return el("div", { class: "digest-overview" }, el("ul", { class: "digest-sources", "aria-label": "Sources" }, ...tiles));
}

/** The view's digests as cards; a source's in page order, with the page beside each. */
export function list(p: DigestPaint, a: DigestActions): HTMLElement {
  const v = p.place.view;
  if (viewTitle(p.snap, v) === null) {
    const gone = v.kind === "category" ? "This category is gone" : "No digest comes from this file any more";
    return el(
      "section",
      { class: "digest-list", "aria-label": "Digests" },
      notice(gone, v.kind === "category" ? "It was deleted, here or on the tablet." : "Its digests were deleted or moved, here or on the tablet.", null, placeLink({ view: ALL, digest: null }, a, { class: "btn" }, "See all digests")),
    );
  }
  const digests = digestsIn(p.snap, v);
  // A source's digests by page, the page beside each; what has no page (typed on the tablet) needs no page column.
  const byPage = v.kind === "source" && digests.some((d) => d.source.page !== null);
  const items = digests.map((d) => el("li", {}, card(d, p, a, byPage)));
  return el(
    "section",
    { class: "digest-list", "aria-label": "Digests" },
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
  return notice(
    v.kind === "category" && v.uid !== null ? "Nothing in this category" : "Nothing here",
    "Move a digest here with its ⋯, or put one here on the tablet: it shows up after the tablet syncs.",
    null,
  );
}

function card(d: Digest, p: DigestPaint, a: DigestActions, byPage: boolean): HTMLElement {
  const open = p.place.digest === d.id;
  const meta = [byPage ? null : sourceLine(d), absoluteDate(d.createdAt)].filter((x): x is string => x !== null);
  // The note itself, framed as To-Do's handwriting chip; said for screen readers once, here.
  const ink = p.ink.holder(d, "digest-card__ink");
  ink?.setAttribute("role", "img");
  ink?.setAttribute("aria-label", "Handwritten note");
  return el(
    "article",
    { class: `digest-card${byPage ? " digest-card--paged" : ""}${open ? " is-open" : ""}` },
    byPage ? el("span", { class: "digest-card__page", text: d.source.page === null ? "" : `p. ${d.source.page}` }) : null,
    // The text is the link, stretched over the card; the card draws its focus.
    // The open digest's card closes it, as Escape does.
    placeLink(
      { view: p.place.view, digest: open ? null : d.id },
      a,
      { class: "digest-card__link", "data-digest": d.id, "aria-current": open ? "true" : null },
      el("q", { class: "digest-card__text", text: shorten(d.text) }),
    ),
    d.comment ? el("p", { class: "digest-card__comment", text: shorten(d.comment) }) : null,
    el(
      "p",
      { class: "digest-card__meta" },
      ...meta.map((m) => el("span", { text: m })),
      d.waiting ? el("span", { class: "digest-card__tag", text: "Waiting for the tablet" }) : null,
    ),
    ink,
  );
}

/** The digest open beside the list: all of it, and where it came from. */
export function panel(p: DigestPaint, a: DigestActions): HTMLElement | null {
  const d = p.place.digest === null ? null : p.snap.digests.find((x) => x.id === p.place.digest);
  if (!d) return null;
  const note = p.ink.holder(d, "digest-panel__ink");
  note?.setAttribute("role", "img");
  note?.setAttribute("aria-label", "Handwritten note");
  // Its actions in one ⋯, a card's: no close, since the list beside it, or the
  // top bar's ‹ where it takes the list's place, is the way on.
  const more = el("button", {
    class: "card__more digest-panel__more",
    type: "button",
    id: "digest-actions",
    "aria-haspopup": "menu",
    "aria-expanded": "false",
    "aria-label": "Actions for this digest",
    title: "Actions for this digest",
    disabled: p.busy,
    html: svg(ICONS.more, 2),
  });
  more.addEventListener("click", (e) => {
    e.stopPropagation();
    a.digestMenu(d, more);
  });
  const facts: [string, string][] = [
    ["From", sourceLine(d)],
    ["Category", categoryName(p.snap, d)],
    ...(d.author ? [["Author", d.author] as [string, string]] : []),
    ["Made", absoluteDate(d.createdAt)],
  ];
  return el(
    "section",
    { class: "digest-panel", "aria-labelledby": "digest-panel-title" },
    el("div", { class: "digest-panel__head" }, el("h2", { class: "digest-panel__title", id: "digest-panel-title", tabindex: "-1", text: "Selected digest" }), more),
    el("blockquote", { class: "digest-panel__text" }, el("p", { text: d.text })),
    // The passage, then where it is.
    sourceLink(d, p, a),
    comment(d, p, a),
    note ? el("div", { class: "digest-panel__part" }, el("h3", { text: "Handwritten note" }), note) : null,
    el("dl", { class: "digest-panel__facts" }, ...facts.flatMap(([k, v]) => [el("dt", { text: k }), el("dd", { text: v })])),
    d.source.kind !== "manual" && d.source.fileId === null
      ? el("p", { class: "digest-panel__aside", text: "That file is not in the library, so it can't be opened here." })
      : null,
  );
}

/** The typed comment, which the browser can change. */
function comment(d: Digest, p: DigestPaint, a: DigestActions): HTMLElement {
  const waiting = d.waiting ? el("p", { class: "digest-panel__aside", text: "Waiting for the tablet: it takes the change at its next sync." }) : null;
  if (p.editing?.id === d.id) return commentForm(d, p.editing.draft, p.busy, a, waiting);
  const change = d.comment
    ? el("button", { class: "btn", type: "button", id: "digest-comment-edit", "aria-label": "Edit the comment", text: "Edit" })
    : el("button", { class: "btn", type: "button", id: "digest-comment-edit", text: "Add a comment" });
  change.addEventListener("click", () => a.editComment(d));
  return el(
    "div",
    { class: "digest-panel__part" },
    el("div", { class: "digest-panel__parthead" }, el("h3", { text: "Comment" }), change),
    d.comment ? el("p", { text: d.comment }) : el("p", { class: "digest-panel__aside", text: "No comment yet." }),
    waiting,
  );
}

function commentForm(d: Digest, draft: string, busy: boolean, a: DigestActions, waiting: HTMLElement | null): HTMLElement {
  const box = el("textarea", { class: "digest-panel__comment", id: "digest-comment", rows: 4, "aria-describedby": "digest-comment-count" }) as HTMLTextAreaElement;
  box.value = draft;
  const count = el("span", { class: "digest-panel__count", id: "digest-comment-count" });
  const save = el("button", { class: "btn", type: "submit", text: busy ? "Saving…" : "Save comment" }) as HTMLButtonElement;
  const cancel = el("button", { class: "btn", type: "button", text: "Cancel" });
  const sync = () => {
    const n = [...trimComment(box.value)].length;
    const over = n > MAX_COMMENT;
    count.textContent = over ? `${n - MAX_COMMENT} characters too many` : `${n} of ${MAX_COMMENT} characters`;
    count.classList.toggle("is-over", over);
    save.disabled = busy || over;
  };
  sync();
  box.addEventListener("input", () => {
    a.draftComment(box.value);
    sync();
  });
  box.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      // Leaves the edit, not the digest.
      e.preventDefault();
      e.stopPropagation();
      a.cancelComment();
    } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !save.disabled) {
      e.preventDefault();
      a.saveComment(d);
    }
  });
  cancel.addEventListener("click", () => a.cancelComment());
  const form = el(
    "form",
    { class: "digest-panel__part digest-panel__form" },
    el("label", { class: "digest-panel__label", for: "digest-comment", text: "Comment" }),
    box,
    count,
    el("div", { class: "digest-panel__actions" }, save, cancel),
    waiting,
  );
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!save.disabled) a.saveComment(d);
  });
  return form;
}

/**
 * The page the digest was taken from, small, with its caption: one link to
 * that page, which the app opens itself. A file the app can't open at a page
 * (an EPUB) is a plain link to the file; null when the library hasn't it.
 */
function sourceLink(d: Digest, p: DigestPaint, a: DigestActions): HTMLElement | null {
  const s = d.source;
  if (s.kind === "manual" || s.fileId === null) return null;
  const atPage = opensAtPage(d) && s.page !== null;
  const link = el(
    "a",
    { class: "digest-panel__source", href: atPage ? notePageHref(s.fileId, s.page! - 1) : noteHref(s.fileId) },
    atPage ? p.thumbs.holder(d, "digest-panel__thumb") : null,
    el("span", { class: "digest-panel__caption", text: atPage ? `Open at page ${s.page}` : "Open the file" }),
  );
  onPlainClick(link, () => a.openSource(d));
  if (!s.changed) return link;
  const note = el("p", { class: "digest-panel__aside", text: changedLine(d) });
  return el("div", { class: "digest-panel__sourcebox" }, link, note);
}

/** The panel's place with no digest open, on a desktop: what opening one shows. */
export function idlePanel(): HTMLElement {
  return el("div", { class: "digest-idle" }, el("p", { text: "Choose a digest to read it whole, with its comment, its handwritten note and where it came from." }));
}

export function notice(title: string, text: string, retry: (() => void) | null, action: HTMLElement | null = null): HTMLElement {
  const b = retry ? el("button", { class: "btn", type: "button", text: "Try again" }) : null;
  b?.addEventListener("click", () => retry!());
  return el("div", { class: "digest-empty" }, el("p", { class: "digest-empty__title", text: title }), el("p", { text }), b, action);
}
