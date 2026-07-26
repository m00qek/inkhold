import { describe, it, expect } from "vitest";
import {
  parseRoute,
  noteHref,
  notePageHref,
  noteVersionHref,
  binNotePageHref,
  folderHref,
  searchHref,
  destinationHref,
} from "../../src/router";
import { DESTINATIONS } from "../../src/pages/rail";

// EVERY PLACE HAS A URL — a folder, the recycle bin, the admin console, a
// library-wide search, a document, a page within it and the in-note search
// running there. `parseRoute` and the `*Href` builders are the two halves of
// that, and they are exercised HERE rather than through the browser because the
// interesting cases are all encoding and precedence ones: a query containing the
// very characters a hash URL is built out of, and a destination key that must
// never be able to shadow a fixed route.

describe("parseRoute", () => {
  it("reads the three shapes of a note route", () => {
    // `page` is the INTERNAL 0-based index; the URL counts from one.
    expect(parseRoute("/note/n-1")).toEqual({ name: "note", id: "n-1", page: 0, q: "" });
    expect(parseRoute("/note/n-1/page/4")).toEqual({ name: "note", id: "n-1", page: 3, q: "" });
    expect(parseRoute("/note/n-1/page/4?q=witches")).toEqual({
      name: "note",
      id: "n-1",
      page: 3,
      q: "witches",
    });
  });

  it("takes a query on the bare note route too", () => {
    // `?q=` does not imply a page: opening a note at the start with a search
    // running is an ordinary thing for a result row to link to.
    expect(parseRoute("/note/n-1?q=aurora")).toEqual({ name: "note", id: "n-1", page: 0, q: "aurora" });
  });

  // THE FAILURE MODE THE SPLIT EXISTS FOR. Before the query was cut off ahead of
  // the pattern match, `/note/n-1?q=x` failed `^\/note\/([^/]+)$` outright and
  // fell through to the library — the note opened as the wrong SCREEN, not
  // merely without its search.
  it("does not fall back to the library because a query is present", () => {
    expect(parseRoute("/note/n-1?q=x").name).toBe("note");
    expect(parseRoute("/note/n-1/page/2?q=x").name).toBe("note");
  });

  it("keeps the other routes, and everything unrecognised, where they were", () => {
    expect(parseRoute("/login")).toEqual({ name: "login" });
    expect(parseRoute("/change-password")).toEqual({ name: "change-password" });
    expect(parseRoute("/connect")).toEqual({ name: "connect" });
    expect(parseRoute("/")).toEqual({ name: "library" });
    expect(parseRoute("/nonsense")).toEqual({ name: "library" });
    expect(parseRoute("/folder")).toEqual({ name: "library" });
  });

  it("clamps every page number it cannot use to the first page", () => {
    // A hand-edited URL should land somewhere sensible rather than 404 or throw.
    // `/page/0` means nothing once the URL counts from one; `parseInt` yields a
    // non-safe number for the overflow case; and a word is not a page at all.
    // None of these is a different SCREEN — it is this note, at its start.
    for (const bad of ["0", "-3", "abc", "", "999999999999999999999", "%20"]) {
      expect(parseRoute(`/note/n-1/page/${bad}`)).toMatchObject({ name: "note", id: "n-1", page: 0 });
    }
    // `parseInt` is deliberately lenient about a trailing tail, so `/page/4x`
    // reads as the fourth page rather than as a failure. That is the right way
    // for a mistyped URL to fall — towards the page the user probably meant.
    expect(parseRoute("/note/n-1/page/4x").page).toBe(3);
  });

  it("survives a malformed escape rather than throwing the route away", () => {
    // A hand-edited URL. A bad query is a bad search, not a broken route.
    expect(parseRoute("/note/n-1?q=%E0%A4%A")).toMatchObject({ name: "note", id: "n-1" });
  });
});

describe("the four places that used to have no URL", () => {
  it("reads a folder, whatever the device called it", () => {
    expect(parseRoute("/folder/projects")).toEqual({ name: "folder", id: "projects" });
    // Device-assigned ids are opaque. They are percent-encoded in, so nothing
    // inside one can be read as the path separator that ends the id.
    expect(parseRoute(folderHref("a/b").slice(1))).toEqual({ name: "folder", id: "a/b" });
    expect(parseRoute(folderHref("café 01").slice(1))).toEqual({ name: "folder", id: "café 01" });
  });

  it("keeps ONE spelling of the library root", () => {
    // The root is not a folder with an id. Giving it `#/folder/root` would be a
    // second URL for a place that already has one.
    expect(folderHref(null)).toBe("#/");
    expect(parseRoute("/")).toEqual({ name: "library" });
  });

  it("reads a library-wide search, and refuses to invent a place for a blank one", () => {
    expect(parseRoute("/search?q=aurora")).toEqual({ name: "search", q: "aurora" });
    expect(searchHref("aurora")).toBe("#/search?q=aurora");
    // "Search for nothing" is just the library.
    expect(searchHref("")).toBe("#/");
    expect(searchHref("   ")).toBe("#/");
    // The route still PARSES with a blank query — a hand-typed `#/search` has to
    // reach a handler that can correct it, not fall through to the library while
    // the address bar keeps saying `/search`.
    expect(parseRoute("/search")).toEqual({ name: "search", q: "" });
  });

  it("routes a destination by the rail's own key", () => {
    // Not a hardcoded "/bin"/"/admin": the router reads `DESTINATIONS`, so a key
    // and its route cannot drift apart.
    for (const dest of DESTINATIONS) {
      expect(parseRoute(destinationHref(dest.key).slice(1))).toEqual({ name: "destination", key: dest.key });
    }
    expect(DESTINATIONS.map((d) => d.key)).toEqual(["bin", "admin"]);
  });

  it("never lets a destination key shadow a fixed route", () => {
    // `DESTINATIONS` is data somebody else edits. A future key spelled `login`
    // or `search` must lose to the route that already means something, so the
    // destination arm is matched LAST.
    expect(parseRoute("/login").name).toBe("login");
    expect(parseRoute("/search").name).toBe("search");
    expect(parseRoute("/change-password").name).toBe("change-password");
  });
});

describe("the query survives the round trip", () => {
  // Every character here is one the URL is built out of. `#` is the sharp one:
  // unencoded it would truncate the hash and take the whole route with it.
  const hostile = [
    "two words",
    "a/slash",
    "a#hash",
    "a&amp",
    "a?question",
    "café",
    "avaliação do plano",
    "a+plus",
    "100%",
    "  padded  ",
  ];

  for (const q of hostile) {
    it(`round-trips ${JSON.stringify(q)}`, () => {
      expect(parseRoute(notePageHref("n-1", 4, q).slice(1)).q).toBe(q);
      expect(parseRoute(noteHref("n-1", q).slice(1)).q).toBe(q);
    });
  }

  it("round-trips an id that itself contains a slash", () => {
    const route = parseRoute(notePageHref("a/b", 2, "x").slice(1));
    expect(route).toEqual({ name: "note", id: "a/b", page: 2, q: "x" });
  });
});

describe("notePageHref", () => {
  it("has ONE spelling for each of its cases", () => {
    // The first page and an empty query both collapse, so "open this note at the
    // start" is one URL rather than three that differ only in punctuation.
    expect(notePageHref("n-1", 0)).toBe("#/note/n-1");
    expect(notePageHref("n-1", 0, "")).toBe("#/note/n-1");
    expect(noteHref("n-1")).toBe("#/note/n-1");
  });

  // THE OFF-BY-ONE, ASSERTED AGAINST LITERAL STRINGS ON BOTH SIDES.
  //
  // A test that only round-trips `parseRoute(notePageHref(...))` passes whether
  // or not the offset is applied at all — the two halves would simply agree with
  // each other about the wrong scheme. So the URL is written out by hand here,
  // and the index is written out by hand there.
  it("writes the URL counting from ONE while the index counts from zero", () => {
    expect(notePageHref("n-1", 1)).toBe("#/note/n-1/page/2");
    expect(notePageHref("n-1", 4)).toBe("#/note/n-1/page/5");
    expect(notePageHref("n-1", 4, "q")).toBe("#/note/n-1/page/5?q=q");
  });

  it("reads the URL counting from ONE, back into a zero-based index", () => {
    expect(parseRoute("/note/n-1/page/2").page).toBe(1);
    expect(parseRoute("/note/n-1/page/5").page).toBe(4);
    // `/page/1` and the bare path are the SAME place. It is accepted — people
    // type and share it — it is simply never what we emit.
    expect(parseRoute("/note/n-1/page/1").page).toBe(0);
    expect(parseRoute("/note/n-1/page/1")).toEqual(parseRoute("/note/n-1"));
  });

  it("round-trips every page index through the public spelling", () => {
    for (const index of [0, 1, 2, 7, 19, 500]) {
      expect(parseRoute(notePageHref("n-1", index).slice(1)).page).toBe(index);
    }
  });
});

describe("the version-preview route", () => {
  // A retained version is addressed by a 7-hex-char md5 PREFIX; the `:id` scopes
  // it to that one file. The current version keeps the bare note URL — there is
  // deliberately no `/version/` form for it (see the route doc).
  it("reads the bare and paged shapes", () => {
    expect(parseRoute("/note/n-1/version/a1b2c3d")).toEqual({
      name: "note-version",
      id: "n-1",
      short: "a1b2c3d",
      page: 0,
    });
    // `page` is the INTERNAL 0-based index; the URL counts from one, exactly like
    // the note route's suffix.
    expect(parseRoute("/note/n-1/version/a1b2c3d/page/4")).toEqual({
      name: "note-version",
      id: "n-1",
      short: "a1b2c3d",
      page: 3,
    });
  });

  it("does NOT read a bare note URL as a version, and vice versa", () => {
    // The two forms must never bleed into each other: a bare note is `note`, a
    // `/version/` segment is `note-version`.
    expect(parseRoute("/note/n-1").name).toBe("note");
    expect(parseRoute("/note/n-1/page/2").name).toBe("note");
    expect(parseRoute("/note/n-1/version/abc123f").name).toBe("note-version");
  });

  it("round-trips an id containing a slash, and clamps a bad page like the note route", () => {
    const route = parseRoute(noteVersionHref("a/b", "abc123f", 2).slice(1));
    expect(route).toEqual({ name: "note-version", id: "a/b", short: "abc123f", page: 2 });
    // Same lenient page handling as the note route — a mistyped page is this
    // version at its first page, not a different screen.
    expect(parseRoute("/note/n-1/version/abc123f/page/0")).toMatchObject({ page: 0 });
    expect(parseRoute("/note/n-1/version/abc123f/page/nope")).toMatchObject({ page: 0 });
  });

  it("has ONE spelling for the first page, counting from one past it", () => {
    // The first page collapses to the bare version path, exactly as `notePageHref`
    // collapses it for the note route.
    expect(noteVersionHref("n-1", "abc123f")).toBe("#/note/n-1/version/abc123f");
    expect(noteVersionHref("n-1", "abc123f", 0)).toBe("#/note/n-1/version/abc123f");
    expect(noteVersionHref("n-1", "abc123f", 1)).toBe("#/note/n-1/version/abc123f/page/2");
    expect(noteVersionHref("n-1", "abc123f", 4)).toBe("#/note/n-1/version/abc123f/page/5");
  });

  it("round-trips every page index through the public spelling", () => {
    for (const index of [0, 1, 2, 7, 19, 500]) {
      const route = parseRoute(noteVersionHref("n-1", "abc123f", index).slice(1));
      expect(route).toMatchObject({ name: "note-version", id: "n-1", short: "abc123f", page: index });
    }
  });
});

describe("the recycle-bin open route", () => {
  // A trashed file is addressed one path deeper under `#/bin` (which stays the
  // bin LISTING, a destination). It carries no `?q=` — a bin URL pins the file +
  // page, nothing else — and its page suffix mirrors the note route exactly.
  it("reads the bare and paged shapes", () => {
    expect(parseRoute("/bin/note/n-1")).toEqual({ name: "bin-note", id: "n-1", page: 0 });
    // `page` is the INTERNAL 0-based index; the URL counts from one, as everywhere.
    expect(parseRoute("/bin/note/n-1/page/4")).toEqual({ name: "bin-note", id: "n-1", page: 3 });
    // `/page/1` and the bare path are the SAME place — accepted, never emitted.
    expect(parseRoute("/bin/note/n-1/page/1")).toEqual(parseRoute("/bin/note/n-1"));
  });

  it("keeps `#/bin` itself the bin LISTING, not a bin-note", () => {
    // The deeper path must not swallow the destination it lives under.
    expect(parseRoute("/bin")).toEqual({ name: "destination", key: "bin" });
    expect(parseRoute("/bin/note/n-1").name).toBe("bin-note");
  });

  it("does NOT bleed with the note or note-version routes", () => {
    // Three sibling forms over the same id, each landing on its own arm.
    expect(parseRoute("/note/n-1").name).toBe("note");
    expect(parseRoute("/note/n-1/version/abc123f").name).toBe("note-version");
    expect(parseRoute("/bin/note/n-1").name).toBe("bin-note");
    // A live note is never read as a bin one, and vice versa.
    expect(parseRoute("/bin/note/n-1/page/2")).toEqual({ name: "bin-note", id: "n-1", page: 1 });
    expect(parseRoute("/note/n-1/page/2").name).toBe("note");
  });

  it("has ONE spelling for the first page, counting from one past it", () => {
    expect(binNotePageHref("n-1")).toBe("#/bin/note/n-1");
    expect(binNotePageHref("n-1", 0)).toBe("#/bin/note/n-1");
    expect(binNotePageHref("n-1", 1)).toBe("#/bin/note/n-1/page/2");
    expect(binNotePageHref("n-1", 4)).toBe("#/bin/note/n-1/page/5");
  });

  it("round-trips an id containing a slash, and clamps a bad page like the note route", () => {
    const route = parseRoute(binNotePageHref("a/b", 2).slice(1));
    expect(route).toEqual({ name: "bin-note", id: "a/b", page: 2 });
    expect(parseRoute("/bin/note/n-1/page/0")).toMatchObject({ page: 0 });
    expect(parseRoute("/bin/note/n-1/page/nope")).toMatchObject({ page: 0 });
  });

  it("round-trips every page index through the public spelling", () => {
    for (const index of [0, 1, 2, 7, 19, 500]) {
      expect(parseRoute(binNotePageHref("n-1", index).slice(1))).toMatchObject({ name: "bin-note", page: index });
    }
  });
});
