// The tablet's apps as library destinations: To-Do and Digest. Their inks are
// made before the viewers (which draw a digest's note), their pages once the
// topbar is up; `appUp` is where a phone's back arrow goes from inside one.

import { digestHref, go, notePageHref, todoHref, type Route } from "../../router";
import { createTodoPage } from "../todo/todoPage";
import { createTodoInk } from "../todo/todoInk";
import { createDigestPage } from "../digest/digestPage";
import { createDigestInk } from "../digest/digestInk";
import { createDigestThumbs } from "../digest/digestThumbs";
import { parsePlace, placePath } from "../digest/digestModel";
import type { LibraryCtx } from "./libraryContext";
import { createSearchItems } from "./searchItems";
import { nameRows } from "../gallerySearch";
import { openItemStore } from "../../cache/itemStore";

/** The handwriting each app draws, kept in the persistent thumbnail store. */
export function installAppInks(ctx: LibraryCtx): void {
  const store = ctx.deps.persistentThumbs ?? null;
  ctx.todoInk = createTodoInk({ api: ctx.api, renderer: ctx.renderer, store });
  ctx.digestInk = createDigestInk({ api: ctx.api, renderer: ctx.renderer, store });
}

/** Both pages, each read once at start: the rail shows an app only when the server keeps its data. */
export function installAppPages(ctx: LibraryCtx): void {
  const { api, content, gallery, st } = ctx;
  ctx.searchItems = createSearchItems({
    service: ctx.searchService,
    store: openItemStore(),
    names: () => nameRows(ctx.folderCache, (f) => ctx.rail.labelFor(f)),
    onChanged: () => ctx.search.again(),
  });
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
    setSearchShown: (shown) => ctx.root.classList.toggle("is-todo-browse", shown),
    toast: ctx.toast,
    handled: ctx.handled,
    onChanged: () => {
      ctx.rail.build();
      // New to-dos reach an open search too: their rows change, and it asks again.
      ctx.searchItems.setTodo(ctx.todo.snapshot());
      if (st.query.trim() !== "" && st.destination === null && ctx.viewers.active() === null) ctx.render.renderGallery();
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
    setMode: (open) => ctx.modes.setDestinationMode("digest", open),
    toast: ctx.toast,
    handled: ctx.handled,
    onChanged: () => {
      ctx.rail.build();
      ctx.searchItems.setDigest(ctx.digest.snapshot());
    },
    go: (path) => go(digestHref(path)),
    ink: ctx.digestInk,
    thumbs: createDigestThumbs({ api, thumbnails: ctx.thumbnails }),
    openFile: (id, page) => go(notePageHref(id, page)),
  });
  void ctx.digest.load();
}

/** Up from inside an app: an open list or digest goes back to the top; the top is a top-level place. Undefined: not an app's route. */
export function appUp(r: Route): { href: string; label: string } | null | undefined {
  if (r.name === "todo") return r.view === "" ? null : { href: todoHref(""), label: "Lists" };
  if (r.name === "digest") {
    const p = parsePlace(r.place);
    return p.digest === null ? null : { href: digestHref(placePath({ view: p.view, digest: null })), label: "Digest" };
  }
  return undefined;
}
