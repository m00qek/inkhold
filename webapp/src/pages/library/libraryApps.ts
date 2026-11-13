// The tablet's apps as library destinations: To-Do and Digest. Their inks are
// made before the viewers (which draw a digest's note), their pages once the
// topbar is up; `appUp` is where a phone's back arrow goes from inside one.

import { digestHref, go, notePageHref, redirect, todoHref, type Route } from "../../router";
import { el } from "../../ui/dom";
import { onPlainClick } from "../../ui/link";
import { isWide, WIDE_QUERY } from "../../ui/breakpoints";
import { createTodoPage } from "../todo/todoPage";
import { createTodoInk } from "../todo/todoInk";
import { createDigestPage } from "../digest/digestPage";
import { createDigestInk } from "../digest/digestInk";
import { createDigestThumbs } from "../digest/digestThumbs";
import { parsePlace, placePath, viewTitle, type DigestView } from "../digest/digestModel";
import { ICONS, svg } from "../../ui/icons";
import type { LibraryCtx } from "./libraryContext";

/** The handwriting each app draws, kept in the persistent thumbnail store. */
export function installAppInks(ctx: LibraryCtx): void {
  const store = ctx.deps.persistentThumbs ?? null;
  ctx.todoInk = createTodoInk({ api: ctx.api, renderer: ctx.renderer, store });
  ctx.digestInk = createDigestInk({ api: ctx.api, renderer: ctx.renderer, store });
}

/** Both pages, each read once at start: the rail shows an app only when the server keeps its data. */
export function installAppPages(ctx: LibraryCtx): void {
  const { api, content, gallery } = ctx;
  ctx.todo = createTodoPage({
    api,
    content,
    gallery,
    setPlace: (name) => ctx.place.overlay(name),
    crumbs: ctx.topbar.crumbs,
    sortWrap: ctx.topbar.sortWrap,
    segmented: ctx.topbar.segmented,
    status: ctx.topbar.todoStatus,
    listBtn: ctx.topbar.todoListBtn,
    downloadBtn: ctx.topbar.todoDownloadBtn,
    newListBtn: ctx.topbar.todoNewListBtn,
    openNote: (id, page) => go(notePageHref(id, page)),
    ink: ctx.todoInk,
    setMode: (open) => ctx.modes.setDestinationMode("todo", open),
    setSearchShown: (shown) => ctx.root.classList.toggle("is-app-browse", shown),
    toast: ctx.toast,
    handled: ctx.handled,
    onChanged: () => {
      ctx.rail.build();
      // New to-dos reach search: their rows change, and an open search asks again and repaints.
      ctx.searchItems.setTodo(ctx.todo.snapshot());
    },
    go: (view) => go(todoHref(view)),
  });
  void ctx.todo.load();

  ctx.digest = createDigestPage({
    api,
    content,
    gallery,
    setPlace: (name) => ctx.place.overlay(name),
    crumbs: ctx.topbar.crumbs,
    sortWrap: ctx.topbar.sortWrap,
    segmented: ctx.topbar.segmented,
    categoryBtn: ctx.topbar.digestCategoryBtn,
    newCategoryBtn: ctx.topbar.digestNewCategoryBtn,
    setMode: (open) => ctx.modes.setDestinationMode("digest", open),
    setSearchShown: (shown) => ctx.root.classList.toggle("is-app-browse", shown),
    toast: ctx.toast,
    handled: ctx.handled,
    onChanged: () => {
      ctx.rail.build();
      ctx.searchItems.setDigest(ctx.digest.snapshot());
    },
    onBinChanged: () => ctx.bin.refresh(),
    trash: (d) => ctx.bin.trashDigest(d),
    go: (path) => go(digestHref(path)),
    replace: (path) => redirect(digestHref(path)),
    wide: isWide,
    // On the history entry itself, so Back and Forward carry it.
    rememberClosed: () => window.history.replaceState({ ...(window.history.state ?? {}), digestClosed: true }, ""),
    closedHere: () => window.history.state?.digestClosed === true,
    ink: ctx.digestInk,
    thumbs: createDigestThumbs({ api, thumbnails: ctx.thumbnails }),
    openFile: (id, page) => go(notePageHref(id, page)),
  });
  void ctx.digest.load();
}

/** What `appUp` needs to know beyond the route. */
export interface UpContext {
  /** A screen where an open digest sits beside its list, so up from it is up from the list. */
  wide?: boolean;
  /** A Digest list's name (its category's, its source's), for the way back to it; null when unknown. */
  digestTitle?: (v: DigestView) => string | null;
}

/**
 * Up from inside an app: an open list or digest goes back to the top; the top
 * is a top-level place. Undefined: not an app's route.
 */
export function appUp(r: Route, o: UpContext = {}): { href: string; label: string } | null | undefined {
  if (r.name === "todo") return r.view === "" ? null : { href: todoHref(""), label: "Lists" };
  if (r.name === "digest") {
    // As To-Do's: an open digest goes back to its list, a source to the sources, anything else to the categories.
    const p = parsePlace(r.place);
    if (p.digest !== null && !o.wide) return { href: digestHref(placePath({ view: p.view, digest: null })), label: o.digestTitle?.(p.view) ?? "Digest" };
    if (p.view.kind === "categories") return null;
    if (p.view.kind === "source") return { href: digestHref(placePath({ view: { kind: "sources" }, digest: null })), label: "Sources" };
    return { href: digestHref(""), label: "Categories" };
  }
  return undefined;
}

/**
 * The top bar's ‹ inside To-Do and Digest, on screens wider than a phone (the
 * phone has its own in ☰'s place): named for where it goes, as a viewer's is.
 * Kept in step with the place, which the crumbs repaint on every move.
 */
export function installAppBack(ctx: LibraryCtx, route: () => Route): () => void {
  const link = ctx.topbar.appBack;
  const label = el("span", { class: "topbar__app-back-label" });
  link.append(el("span", { "aria-hidden": "true", html: svg(ICONS.chevronLeft, 1.8) }), label);
  onPlainClick(link, () => go(link.getAttribute("href") ?? "#/"));
  const wide = window.matchMedia(WIDE_QUERY);
  const sync = () => {
    const up = appUp(route(), { wide: wide.matches, digestTitle: digestTitleOf(ctx) }) ?? null;
    link.hidden = up === null;
    if (up === null) return;
    link.href = up.href;
    label.textContent = up.label;
    link.setAttribute("aria-label", `Back to ${up.label}`);
  };
  const watch = new MutationObserver(sync);
  watch.observe(ctx.topbar.crumbs, { childList: true, subtree: true, characterData: true });
  window.addEventListener("hashchange", sync);
  wide.addEventListener("change", sync);
  sync();
  return () => {
    watch.disconnect();
    window.removeEventListener("hashchange", sync);
    wide.removeEventListener("change", sync);
  };
}

/** A Digest list's name from the page's last answer, for a way back named after it. */
export function digestTitleOf(ctx: LibraryCtx): (v: DigestView) => string | null {
  return (v) => {
    const snap = ctx.digest?.snapshot();
    return snap?.enabled ? viewTitle(snap, v) : null;
  };
}
