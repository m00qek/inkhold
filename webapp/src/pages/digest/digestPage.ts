// The Digest destination: the person's digests, as the tablet's Digest app
// synced them. Mounted in the shell's content area like To-Do, and built like
// it: an overview of cards, the rail's rows for the fixed views, the top bar
// naming the place and holding its tools. Painted by `digestView.ts` from
// `digestModel.ts`, its handwritten notes drawn by `digestInk.ts`. The tablet
// is where digests are made; here a digest's typed comment and its category
// change, a digest goes to the bin, and categories are made, renamed and
// deleted: each saved to the server, then re-read, and taken by the tablet at
// its next sync. The page keeps up with the tablet, re-reading while someone
// is looking, but never repaints over a comment being written.

import { el, keepingFocus } from "../../ui/dom";
import { rowsFromItems, setMenuRows, toggleBarMenu, type BarRow } from "../../ui/barMenu";
import { attempt } from "../../ui/attempt";
import { askName, confirmDelete } from "../../ui/nameDialog";
import { moveChoices } from "../../ui/moveTo";
import { ICONS } from "../../ui/icons";
import { DEFAULT_SECTION_TITLE } from "../../ui/menu";
import type { Api } from "../../api/types";
import { ApiError } from "../../api/errors";
import { categoryNameProblem, MAX_CATEGORY_NAME, MAX_COMMENT, trimComment, type Digest, type DigestSnapshot } from "../../api/digestTypes";
import type { DigestInk } from "./digestInk";
import type { DigestThumbs } from "./digestThumbs";
import { categoryRows, digestsIn, listsDigests, opensAtPage, placePath, sameView, viewTitle, type DigestPlace } from "./digestModel";
import { categoryActions, categoryCards, idlePanel, list, notice, panel, placeTitle, sourceCards, type DigestActions } from "./digestView";

export interface DigestHost {
  api: Pick<Api, "digests" | "digestEdit" | "digestCreateCategory" | "digestRenameCategory" | "digestDeleteCategory">;
  /** To the Recycle bin, as a file goes there: its toast and Undo are the bin's. True when it went. */
  trash(d: Digest): Promise<boolean>;
  content: HTMLElement;
  gallery: HTMLElement;
  crumbs: HTMLElement;
  /** Names the screen (the tab's title and the page's <h1>) while Digest is open; null on leaving. */
  setPlace(name: string | null): void;
  sortWrap: HTMLElement;
  segmented: HTMLElement;
  /** The top bar's menu for the category on screen, and New category on the categories' overview. */
  categoryBtn: HTMLButtonElement;
  newCategoryBtn: HTMLButtonElement;
  setMode(open: boolean): void;
  /** The search box, on the overviews as on To-Do's lists; inside a list it would only carry the person away. */
  setSearchShown(shown: boolean): void;
  toast(message: string): void;
  /** Session expiry and the like; true when the shell took care of it. */
  handled(e: unknown): boolean;
  /** The snapshot changed: the rail's count repaints. */
  onChanged(): void;
  /** Something went to the Recycle bin from here: it reads again, its count with it. */
  onBinChanged(): void;
  /** Go to a place (its `placePath`). */
  go(path: string): void;
  /** The same, in place of the current history entry: a step the page took on its own. */
  replace(path: string): void;
  /** A list and its open digest sit side by side: entering a list opens its first. */
  wide(): boolean;
  /** Marks the current history entry as a list whose digest the person closed, so Back to it keeps it closed. */
  rememberClosed(): void;
  /** Whether the current history entry is one of those. */
  closedHere(): boolean;
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
  /** Re-reads the server only when it was last asked over half a minute ago, sharing a read in flight: a viewer opening a file, a search. */
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
  let place: DigestPlace = { view: { kind: "categories" }, digest: null };
  let loadToken = 0;
  /** When the server was last asked (ms), answered or not; 0 before. */
  let askedAt = 0;
  /** The read in flight, for a viewer that waits on it rather than asking again. */
  let reading: Promise<void> | null = null;
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
   * Just entered a list (not closed a digest in it): on a wide screen, its
   * first digest opens beside it once the digests are in, as a reader opens
   * at a page. Closing it again stays closed.
   */
  let openFirst = false;
  /**
   * Where focus goes after the next paint: the panel just opened, the card of
   * the one just closed, or the comment's box or its Edit button.
   */
  let focusNext: "panel" | "comment-box" | "comment-edit" | "move" | "list" | { card: string } | null = null;

  /** Re-reads the server. An answer like the last one repaints nothing (unless one is due), so nothing on screen moves. */
  function load(): Promise<void> {
    askedAt = Date.now();
    const p = read().finally(() => {
      if (reading === p) reading = null;
    });
    reading = p;
    return p;
  }

  async function read(): Promise<void> {
    const mine = ++loadToken;
    try {
      const s = await host.api.digests();
      if (mine !== loadToken) return;
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

  /** How the page says a refused change: the apps' words (`ui/attempt.ts`), and the server's own reasons. */
  const failure = {
    handled: host.handled,
    say: host.toast,
    explain: (e: unknown): string | null => {
      if (!(e instanceof ApiError)) return null;
      if (e.code === "NAME_TAKEN") return "A category with that name exists.";
      if (e.code === "BAD_NAME") return "The tablet can't take that name: it holds 1 to 150 characters, doesn't start with a dot, and has none of / < > * ? | \\ : \".";
      if (e.code === "BAD_COMMENT") return `A comment holds at most ${MAX_COMMENT} characters.`;
      return null;
    },
  };

  /** The category on screen, one the person made; null anywhere else. */
  const categoryHere = (): string | null => (place.view.kind === "category" && place.view.uid ? place.view.uid : null);

  /** The shell's topbar dressed for Digest (`mine`), or handed back to the library. */
  function chrome(mine: boolean): void {
    host.sortWrap.hidden = mine;
    host.segmented.hidden = mine;
    host.setMode(mine);
    host.setSearchShown(mine && !listsDigests(place.view));
    const on = mine && snap?.enabled === true;
    // Each place's own tools, as To-Do's: New category where the categories are, a category's menu inside one.
    host.newCategoryBtn.hidden = !on || place.view.kind !== "categories";
    const here = on ? categoryHere() : null;
    host.categoryBtn.hidden = here === null || !snap?.categories.some((c) => c.uid === here);
    if (!host.categoryBtn.hidden) host.categoryBtn.setAttribute("aria-label", `Category options for ${viewTitle(snap!, place.view)}`);
    if (mine) host.crumbs.replaceChildren(placeTitle(snap, place.view));
  }

  /** A category change: the apps' one way to call (`ui/attempt.ts`), then a fresh read. */
  async function run(what: string, call: () => Promise<unknown>): Promise<boolean> {
    if (!(await attempt(what, call, failure))) return false;
    repaintDue = true;
    await load();
    return true;
  }

  /** The apps' name dialog, with the tablet's rules for a category's name, said while typing. */
  function askCategoryName(title: string, goLabel: string, initial: string): Promise<string | null> {
    const taken = (name: string) => snap?.categories.some((c) => c.name === name) === true;
    return askName({
      title,
      goLabel,
      initial,
      problem: (name) => categoryNameProblem(name) ?? (name !== initial && taken(name) ? "A category with that name exists." : null),
      hint: (name) => `${[...name].length} of ${MAX_CATEGORY_NAME} characters. Your Supernote takes it at its next sync.`,
    });
  }

  /** Ask a name, make the category; with `d`, move that digest into it instead of opening it (Move to… → New category…). */
  async function newCategory(d?: Digest): Promise<void> {
    const name = await askCategoryName("New category", "Create category", "");
    if (name === null) return;
    let made = "";
    if (!(await attempt("create the category", async () => { made = (await host.api.digestCreateCategory(name)).uid; }, failure))) return;
    // Read first: a page painted before the answer names no such category, and says it is gone.
    repaintDue = true;
    await load();
    if (d) return move(d, made, name);
    host.toast(`Created "${name}".`);
    host.go(placePath({ view: { kind: "category", uid: made }, digest: null }));
  }

  function renameCategory(uid: string): void {
    const current = snap?.categories.find((c) => c.uid === uid)?.name;
    if (current === undefined) return;
    void askCategoryName("Rename category", "Rename", current).then(async (name) => {
      if (name !== null && (await run("rename the category", () => host.api.digestRenameCategory(uid, name)))) host.toast(`Renamed to "${name}".`);
    });
  }

  function deleteCategory(uid: string): void {
    const c = snap?.categories.find((x) => x.uid === uid);
    if (!snap || !c) return;
    // The count asked about is the page's; the one told after is the server's.
    const asked = snap.digests.filter((d) => d.categoryUid === uid).length;
    void confirmDelete({
      title: asked ? `Delete "${c.name}" and its ${asked} digest${asked === 1 ? "" : "s"}?` : `Delete "${c.name}"?`,
      body: asked
        ? "The digests go to the Recycle bin, where you can restore them. Your Supernote deletes them too at its next sync."
        : "Your Supernote deletes it too at its next sync.",
      goLabel: "Delete category",
    }).then(async (ok) => {
      let n = 0;
      if (!ok || !(await attempt("delete the category", async () => { n = await host.api.digestDeleteCategory(uid); }, failure))) return;
      if (n) host.onBinChanged();
      host.toast(n ? `Deleted "${c.name}". Its ${n === 1 ? "digest is" : `${n} digests are`} in the Recycle bin.` : `Deleted "${c.name}".`);
      // Gone from the page's own answer at once, so no paint shows its card; off
      // the gone category in place of its entry, so Back never lands there.
      if (snap) snap = { ...snap, categories: snap.categories.filter((x) => x.uid !== uid), digests: snap.digests.filter((x) => x.categoryUid !== uid) };
      if (categoryHere() === uid) host.replace(placePath({ view: { kind: "categories" }, digest: null }));
      else if (editing === null) paint();
      repaintDue = true;
      await load();
    });
  }

  /** The category on screen's menu: the card's ⋯, from the top bar. */
  const categoryRowsMenu = (): BarRow[] => {
    const uid = categoryHere();
    if (uid === null) return [];
    return rowsFromItems(DEFAULT_SECTION_TITLE, categoryActions(uid, { renameCategory, deleteCategory }));
  };
  const onCategoryBtn = (e: MouseEvent): void => {
    e.stopPropagation();
    toggleBarMenu(host.categoryBtn, categoryRowsMenu());
  };
  const onNewCategory = (): void => void newCategory();
  host.categoryBtn.addEventListener("click", onCategoryBtn);
  host.newCategoryBtn.addEventListener("click", onNewCategory);
  // On a phone the bar folds into ⋯ (`ui/barMenu.ts`); the category's menu hands it its rows.
  setMenuRows(host.categoryBtn, categoryRowsMenu);

  function copy(d: Digest): void {
    const refused = () => host.toast("Couldn't copy the text.");
    if (!navigator.clipboard) return refused();
    navigator.clipboard.writeText(d.text).then(() => host.toast("Copied the text."), refused);
  }

  /** To the bin; the tablet deletes it too at its next sync. */
  function moveToBin(d: Digest): void {
    if (busy) return;
    busy = true;
    void host.trash(d).then(async (went) => {
      busy = false;
      if (!went) return void (editing === null && paint());
      repaintDue = true;
      // Its place closes with it, only while it is still the one on screen: the
      // person may have moved on. In place of its entry, so Back never lands on
      // a digest in the bin; focus goes to the list it left.
      if (open_ && place.digest === d.id) {
        // Gone from the page's own answer at once, so no repaint shows it, and
        // focus goes to its neighbour in the list (the next, else the one before).
        const shown = snap ? digestsIn(snap, place.view) : [];
        const at = shown.findIndex((x) => x.id === d.id);
        const neighbour = shown[at + 1] ?? shown[at - 1];
        if (snap) snap = { ...snap, digests: snap.digests.filter((x) => x.id !== d.id) };
        focusNext = neighbour ? { card: neighbour.id } : "list";
        host.replace(placePath({ view: place.view, digest: null }));
        host.rememberClosed();
      }
      await load();
    });
  }

  const actions: DigestActions = {
    go(p) {
      const closing = p.digest === null && place.digest !== null && sameView(p.view, place.view);
      if (p.digest !== null && p.digest !== place.digest) focusNext = "panel";
      else if (closing) focusNext = { card: place.digest! };
      host.go(placePath(p));
      // Closed on purpose: coming back to this entry keeps it closed.
      if (closing) host.rememberClosed();
    },
    openSource(d: Digest) {
      if (d.source.fileId === null) return;
      // A file no viewer opens at a page (an EPUB) opens at its start.
      const page = opensAtPage(d) && d.source.page !== null ? d.source.page - 1 : 0;
      host.openFile(d.source.fileId, page);
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
    digestMenu(d: Digest, trigger: HTMLElement) {
      if (!snap || busy) return;
      // Uncategorized and the person's categories; All is a view, not a place to be.
      // To-Do's Move to… (`ui/moveTo.ts`): every category but this one's, then New category….
      const places = moveChoices({
        places: categoryRows(snap)
          .filter((r): r is typeof r & { uid: string } => r.uid !== null)
          .map((r) => ({ id: r.uid, name: r.name, icon: r.uid === "" ? "inbox" : "category" })),
        current: d.categoryUid,
        move: (p) => move(d, p.id ?? "", p.name),
        newLabel: "New category…",
        makeNew: () => void newCategory(d),
      }).map((c): BarRow => (c.kind === "sep" ? { kind: "sep" } : { kind: "item", label: c.label, icon: ICONS[c.icon], onSelect: c.onSelect }));
      // A task's ⋯ in To-Do: Move to… first, the bin last and red.
      toggleBarMenu(trigger, [
        { kind: "section", title: DEFAULT_SECTION_TITLE },
        { kind: "sub", label: "Move to…", icon: ICONS.move, rows: [{ kind: "section", title: "Move to" }, ...places] },
        { kind: "item", label: "Copy text", icon: ICONS.copy, onSelect: () => copy(d) },
        { kind: "sep" },
        { kind: "item", label: "Move to bin", icon: ICONS.trash, danger: true, onSelect: () => moveToBin(d) },
      ]);
    },
    renameCategory,
    deleteCategory,
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
      void attempt("save the comment", () => host.api.digestEdit(d.id, { comment: text }), failure).then(async (ok) => {
        busy = false;
        if (!ok) {
          focusNext = "comment-box";
          return paint();
        }
        editing = null;
        focusNext = "comment-edit";
        repaintDue = true;
        await load();
      });
    },
  };

  /** One move: the call, then a fresh read; the digest stays open where it is. */
  function move(d: Digest, uid: string, name: string): void {
    if (uid === d.categoryUid || busy) return;
    busy = true;
    focusNext = "move";
    void attempt("move the digest", () => host.api.digestEdit(d.id, { categoryUid: uid }), failure).then(async (ok) => {
      busy = false;
      if (!ok) {
        // A comment being written is never repainted away.
        if (editing === null) paint();
        return;
      }
      host.toast(`Moved to ${name}.`);
      repaintDue = true;
      await load();
    });
  }

  function paint(): void {
    if (!open_) return;
    if (openFirst && snap?.enabled) {
      openFirst = false;
      const first = host.wide() && listsDigests(place.view) && place.digest === null ? digestsIn(snap, place.view)[0] : undefined;
      // Its own entry in place of the list's: Back leaves the list, not the digest.
      if (first) return host.replace(placePath({ view: place.view, digest: first.id }));
    }
    repaintDue = false;
    chrome(true);
    host.setPlace(snap?.enabled ? (viewTitle(snap, place.view) ?? "Digest") : "Digest");
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
      if (!listsDigests(place.view)) {
        root.replaceChildren(place.view.kind === "categories" ? categoryCards(p, actions) : sourceCards(p, actions));
        return;
      }
      const side = panel(p, actions);
      root.replaceChildren(el("div", { class: `digest-body${side ? " has-open" : ""}` }, list(p, actions), side ?? idlePanel()));
    });
    const next = focusNext;
    focusNext = null;
    if (next === "panel") root.querySelector<HTMLElement>("#digest-panel-title")?.focus();
    else if (next === "comment-edit") root.querySelector<HTMLElement>("#digest-comment-edit")?.focus();
    else if (next === "move") root.querySelector<HTMLElement>("#digest-actions")?.focus();
    else if (next === "list") root.querySelector<HTMLElement>(".digest-card__link")?.focus();
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
      openFirst = listsDigests(next.view) && next.digest === null && (!open_ || !sameView(next.view, place.view)) && !host.closedHere();
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
    // Asked, not answered: a failing or slow server is not asked again on every search paint.
    freshen: () => reading ?? (Date.now() - askedAt < FRESH_MS ? Promise.resolve() : load()),
    destroy() {
      clearInterval(poll);
      host.categoryBtn.removeEventListener("click", onCategoryBtn);
      host.newCategoryBtn.removeEventListener("click", onNewCategory);
      root.removeEventListener("keydown", onKey);
      document.removeEventListener("visibilitychange", onVisible);
      root.remove();
    },
  };
}
