// The Digest destination: the person's digests, as the tablet's Digest app
// synced them. Mounted in the shell's content area like To-Do; painted by
// `digestView.ts` from `digestModel.ts`, its handwritten notes drawn by
// `digestInk.ts`. Read only: the tablet is where digests are made and changed,
// so the page only keeps up with it, re-reading while someone is looking.

import { el, keepingFocus } from "../../ui/dom";
import type { Api } from "../../api/types";
import type { Digest, DigestSnapshot } from "../../api/digestTypes";
import type { DigestInk } from "./digestInk";
import { placePath, sameView, type DigestPlace } from "./digestModel";
import { groups, list, notice, panel, placeTitle, tabs, type DigestActions } from "./digestView";

export interface DigestHost {
  api: Pick<Api, "digests">;
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
  destroy(): void;
}

/** While open and in view, the tablet's new digests show up within this. */
const POLL_MS = 30_000;

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
  /** Where focus goes after the next paint: the panel just opened, or the card of the one just closed. */
  let focusNext: { panel: true } | { card: string } | null = null;

  async function load(): Promise<void> {
    const mine = ++loadToken;
    try {
      const s = await host.api.digests();
      if (mine !== loadToken) return;
      // Nothing new from the tablet: no repaint, so nothing on screen moves.
      if (snap !== null && !failed && sameSnapshot(snap, s)) return;
      snap = s;
      failed = false;
    } catch (e) {
      if (mine !== loadToken || host.handled(e)) return;
      failed = snap === null;
    }
    host.onChanged();
    if (open_) paint();
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
      if (p.digest !== null && p.digest !== place.digest) focusNext = { panel: true };
      else if (p.digest === null && place.digest !== null && sameView(p.view, place.view)) focusNext = { card: place.digest };
      host.go(placePath(p));
    },
    openSource(d: Digest) {
      if (d.source.fileId === null) return;
      host.openFile(d.source.fileId, Math.max(0, (d.source.page ?? 1) - 1));
    },
    copy(d: Digest) {
      const refused = () => host.toast("Couldn't copy the text.");
      if (!navigator.clipboard) return refused();
      navigator.clipboard.writeText(d.text).then(() => host.toast("Copied the text."), refused);
    },
  };

  function paint(): void {
    if (!open_) return;
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
      const p = { snap, place, ink: host.ink };
      const side = panel(p, actions);
      root.replaceChildren(
        tabs(place, actions),
        el("div", { class: `digest-body${side ? " has-open" : ""}` }, groups(p, actions), list(p, actions), side),
      );
    });
    const next = focusNext;
    focusNext = null;
    if (next && "panel" in next) root.querySelector<HTMLElement>(".digest-panel__close")?.focus();
    else if (next) root.querySelector<HTMLElement>(`.digest-card__link[data-digest="${CSS.escape(next.card)}"]`)?.focus();
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
      place = next;
      if (!open_) {
        open_ = true;
        root.hidden = false;
        host.gallery.hidden = true;
      }
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
    load,
    destroy() {
      clearInterval(poll);
      root.removeEventListener("keydown", onKey);
      document.removeEventListener("visibilitychange", onVisible);
      root.remove();
    },
  };
}
