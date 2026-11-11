// The Digest destination: the person's digests, as the tablet's Digest app
// synced them. Mounted in the shell's content area like To-Do; painted by
// `digestView.ts` from `digestModel.ts`, its handwritten notes drawn by
// `digestInk.ts`. The tablet is where digests are made; here only a digest's
// typed comment and its category change, saved to the server, then re-read,
// and taken by the tablet at its next sync. The page keeps up with the
// tablet, re-reading while someone is looking, but never repaints over a
// comment being written.

import { el, keepingFocus } from "../../ui/dom";
import { openBarMenu, type BarRow } from "../../ui/barMenu";
import type { Api } from "../../api/types";
import { trimComment, type Digest, type DigestSnapshot } from "../../api/digestTypes";
import type { DigestInk } from "./digestInk";
import type { DigestThumbs } from "./digestThumbs";
import { categoryRows, opensAtPage, placePath, sameView, type DigestPlace } from "./digestModel";
import { groups, list, notice, panel, placeTitle, tabs, type DigestActions } from "./digestView";

export interface DigestHost {
  api: Pick<Api, "digests" | "digestEdit">;
  content: HTMLElement;
  gallery: HTMLElement;
  crumbs: HTMLElement;
  /** Names the screen (the tab's title and the page's <h1>) while Digest is open; null on leaving. */
  setPlace(name: string | null): void;
  sortWrap: HTMLElement;
  segmented: HTMLElement;
  setMode(open: boolean): void;
  toast(message: string): void;
  /** Session expiry and the like; true when the shell took care of it. */
  handled(e: unknown): boolean;
  /** The snapshot changed: the rail's count repaints. */
  onChanged(): void;
  /** Go to a place (its `placePath`). */
  go(path: string): void;
  ink: DigestInk;
  /** The open digest's source page, small. */
  thumbs: DigestThumbs;
  /** Open a library file at a page (0-based). */
  openFile(id: string, page: number): void;
}

export interface DigestPage {
  open(place: DigestPlace): void;
  close(): void;
  isOpen(): boolean;
  /** The place on screen, or null when closed. */
  place(): DigestPlace | null;
  /** The last answer; null before the first. */
  snapshot(): DigestSnapshot | null;
  /** Re-reads the server (shell start, tab back in focus). */
  load(): Promise<void>;
  /** Re-reads the server only when the last answer is older than half a minute: a viewer opening a file. */
  freshen(): Promise<void>;
  destroy(): void;
}

/** While open and in view, the tablet's new digests show up within this. */
const POLL_MS = 30_000;
/** A viewer reuses an answer this young rather than asking again. */
const FRESH_MS = 30_000;

/** Two answers alike: plain data, so their JSON says it. */
function sameSnapshot(a: DigestSnapshot, b: DigestSnapshot): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function createDigestPage(host: DigestHost): DigestPage {
  const root = el("section", { class: "digest", "aria-label": "Digest", hidden: true });
  host.content.append(root);

  let snap: DigestSnapshot | null = null;
  let failed = false;
  let open_ = false;
  let place: DigestPlace = { view: { kind: "category", uid: null }, digest: null };
  let loadToken = 0;
  /** When the server last answered (ms); 0 before it has. */
  let answeredAt = 0;
  /** The comment being edited: its digest and the text so far. */
  let editing: { id: string; draft: string } | null = null;
  /** A comment's save in flight. */
  let busy = false;
  /**
   * The page's own change is done: the next answer repaints, even one like
   * the last, so its form or busy state goes. Whichever load answers first;
   * any paint settles it.
   */
  let repaintDue = false;
  /**
   * Where focus goes after the next paint: the panel just opened, the card of
   * the one just closed, or the comment's box or its Edit button.
   */
  let focusNext: "panel" | "comment-box" | "comment-edit" | "move" | { card: string } | null = null;

  /** Re-reads the server. An answer like the last one repaints nothing (unless one is due), so nothing on screen moves. */
  async function load(): Promise<void> {
    const mine = ++loadToken;
    try {
      const s = await host.api.digests();
      if (mine !== loadToken) return;
      answeredAt = Date.now();
      if (snap !== null && !failed && sameSnapshot(snap, s)) {
        // A comment being written is never repainted away.
        if (repaintDue && open_ && editing === null) paint();
        return;
      }
      snap = s;
      failed = false;
      // A file's pages may have changed with it.
      host.thumbs.refresh();
    } catch (e) {
      if (mine !== loadToken || host.handled(e)) return;
      failed = snap === null;
    }
    host.onChanged();
    // A comment being written is never repainted away; its save re-reads.
    if (open_ && editing === null) paint();
  }

  /** The shell's topbar dressed for Digest (`mine`), or handed back to the library. */
  function chrome(mine: boolean): void {
    host.sortWrap.hidden = mine;
    host.segmented.hidden = mine;
    host.setMode(mine);
    if (mine) host.crumbs.replaceChildren(placeTitle(snap));
  }

  const actions: DigestActions = {
    go(p) {
      if (p.digest !== null && p.digest !== place.digest) focusNext = "panel";
      else if (p.digest === null && place.digest !== null && sameView(p.view, place.view)) focusNext = { card: place.digest };
      host.go(placePath(p));
    },
    openSource(d: Digest) {
      if (d.source.fileId === null) return;
      // A file no viewer opens at a page (an EPUB) opens at its start.
      const page = opensAtPage(d) && d.source.page !== null ? d.source.page - 1 : 0;
      host.openFile(d.source.fileId, page);
    },
    copy(d: Digest) {
      const refused = () => host.toast("Couldn't copy the text.");
      if (!navigator.clipboard) return refused();
      navigator.clipboard.writeText(d.text).then(() => host.toast("Copied the text."), refused);
    },
    editComment(d: Digest) {
      editing = { id: d.id, draft: d.comment ?? "" };
      focusNext = "comment-box";
      paint();
    },
    draftComment(text: string) {
      if (editing) editing.draft = text;
    },
    cancelComment() {
      editing = null;
      focusNext = "comment-edit";
      paint();
    },
    moveTo(d: Digest, trigger: HTMLElement) {
      if (!snap || busy) return;
      // Uncategorized and the person's categories; All is a view, not a place to be.
      const rows: BarRow[] = [
        { kind: "section", title: "Move to" },
        ...categoryRows(snap)
          .filter((r): r is typeof r & { uid: string } => r.uid !== null)
          .map<BarRow>((r) => ({ kind: "item", label: r.name, checked: r.uid === d.categoryUid, onSelect: () => move(d, r.uid, r.name) })),
      ];
      openBarMenu(trigger, rows);
    },
    saveComment(d: Digest) {
      if (!editing || busy) return;
      const text = editing.draft;
      // What the server would keep is what is there: nothing to send.
      if (trimComment(text) === trimComment(d.comment ?? "")) {
        editing = null;
        focusNext = "comment-edit";
        paint();
        return;
      }
      busy = true;
      paint();
      host.api.digestEdit(d.id, { comment: text }).then(
        async () => {
          busy = false;
          editing = null;
          focusNext = "comment-edit";
          repaintDue = true;
          await load();
        },
        (e: unknown) => {
          busy = false;
          if (!host.handled(e)) host.toast("Couldn't save the comment. Check your connection and try again.");
          focusNext = "comment-box";
          paint();
        },
      );
    },
  };

  /** One move: the call, then a fresh read; the digest stays open where it is. */
  function move(d: Digest, uid: string, name: string): void {
    if (uid === d.categoryUid || busy) return;
    busy = true;
    focusNext = "move";
    host.api.digestEdit(d.id, { categoryUid: uid }).then(
      async () => {
        busy = false;
        host.toast(`Moved to ${name}.`);
        repaintDue = true;
        await load();
      },
      (e: unknown) => {
        busy = false;
        if (!host.handled(e)) host.toast("Couldn't move the digest. Check your connection and try again.");
        // A comment being written is never repainted away.
        if (editing === null) paint();
      },
    );
  }

  function paint(): void {
    if (!open_) return;
    repaintDue = false;
    chrome(true);
    host.setPlace("Digest");
    keepingFocus(root, () => {
      if (snap === null) {
        root.replaceChildren(failed ? notice("Your digests could not be loaded", "Check your connection and try again.", () => void load()) : notice("Loading…", "Reading your digests.", null));
        return;
      }
      if (!snap.enabled) {
        root.replaceChildren(notice("Digest sync is off on this server", "The tablet's digests are not kept here. An administrator can turn it on with digest_sync in the server's config.", null));
        return;
      }
      const p = { snap, place, ink: host.ink, thumbs: host.thumbs, editing, busy };
      const side = panel(p, actions);
      root.replaceChildren(
        tabs(place, actions),
        el("div", { class: `digest-body${side ? " has-open" : ""}` }, groups(p, actions), list(p, actions), side),
      );
    });
    const next = focusNext;
    focusNext = null;
    if (next === "panel") root.querySelector<HTMLElement>(".digest-panel__close")?.focus();
    else if (next === "comment-edit") root.querySelector<HTMLElement>("#digest-comment-edit")?.focus();
    else if (next === "move") root.querySelector<HTMLElement>("#digest-move")?.focus();
    else if (next === "comment-box") {
      const box = root.querySelector<HTMLTextAreaElement>("#digest-comment");
      box?.focus();
      box?.setSelectionRange(box.value.length, box.value.length);
    } else if (next) root.querySelector<HTMLElement>(`.digest-card__link[data-digest="${CSS.escape(next.card)}"]`)?.focus();
  }

  /** Escape closes the open digest, as it closes the reader's panels. */
  function onKey(e: KeyboardEvent): void {
    if (!open_ || e.key !== "Escape" || place.digest === null || e.defaultPrevented) return;
    if (!(e.target instanceof Node) || !root.contains(e.target)) return;
    e.preventDefault();
    actions.go({ view: place.view, digest: null });
  }
  root.addEventListener("keydown", onKey);

  const onVisible = () => {
    if (document.visibilityState === "visible" && open_) void load();
  };
  document.addEventListener("visibilitychange", onVisible);
  // The tablet syncs on its own: keep up while someone is looking.
  const poll = setInterval(() => {
    if (open_ && document.visibilityState === "visible") void load();
  }, POLL_MS);

  return {
    open(next) {
      // Another digest, or none: the comment being written there is let go.
      if (editing && editing.id !== next.digest) editing = null;
      place = next;
      if (!open_) {
        open_ = true;
        root.hidden = false;
        host.gallery.hidden = true;
      }
      // A file may have changed while its digests did not: its page picture is checked again.
      host.thumbs.refresh();
      paint();
      void load();
    },
    close() {
      if (!open_) return;
      open_ = false;
      root.hidden = true;
      host.gallery.hidden = false;
      host.setPlace(null);
      chrome(false);
    },
    isOpen: () => open_,
    place: () => (open_ ? place : null),
    snapshot: () => snap,
    load: () => load(),
    freshen: () => (Date.now() - answeredAt < FRESH_MS ? Promise.resolve() : load()),
    destroy() {
      clearInterval(poll);
      root.removeEventListener("keydown", onKey);
      document.removeEventListener("visibilitychange", onVisible);
      root.remove();
    },
  };
}
