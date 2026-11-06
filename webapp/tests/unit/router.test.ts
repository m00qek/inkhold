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
  todoHref,
} from "../../src/router";
import { DESTINATIONS } from "../../src/pages/rail/railPlaces";

describe("parseRoute", () => {
  it("reads the three shapes of a note route", () => {
    // `page` is the internal 0-based index; the URL counts from one.
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
    expect(parseRoute("/note/n-1?q=aurora")).toEqual({ name: "note", id: "n-1", page: 0, q: "aurora" });
  });

  // Regression: `/note/n-1?q=x` failed the pattern and fell through to the library.
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
    for (const bad of ["0", "-3", "abc", "", "999999999999999999999", "%20"]) {
      expect(parseRoute(`/note/n-1/page/${bad}`)).toMatchObject({ name: "note", id: "n-1", page: 0 });
    }
    // `parseInt` is lenient, so `/page/4x` is the fourth page.
    expect(parseRoute("/note/n-1/page/4x").page).toBe(3);
  });

  it("survives a malformed escape rather than throwing the route away", () => {
    expect(parseRoute("/note/n-1?q=%E0%A4%A")).toMatchObject({ name: "note", id: "n-1" });
  });
});

describe("the four places that used to have no URL", () => {
  it("reads a folder, whatever the device called it", () => {
    expect(parseRoute("/folder/projects")).toEqual({ name: "folder", id: "projects" });
    // Device-assigned ids are percent-encoded, so they cannot contain the separator.
    expect(parseRoute(folderHref("a/b").slice(1))).toEqual({ name: "folder", id: "a/b" });
    expect(parseRoute(folderHref("café 01").slice(1))).toEqual({ name: "folder", id: "café 01" });
  });

  it("keeps ONE spelling of the library root", () => {
    expect(folderHref(null)).toBe("#/");
    expect(parseRoute("/")).toEqual({ name: "library" });
  });

  it("reads a library-wide search, and refuses to invent a place for a blank one", () => {
    expect(parseRoute("/search?q=aurora")).toEqual({ name: "search", q: "aurora" });
    expect(searchHref("aurora")).toBe("#/search?q=aurora");
    expect(searchHref("")).toBe("#/");
    expect(searchHref("   ")).toBe("#/");
    expect(parseRoute("/search")).toEqual({ name: "search", q: "" });
  });

  it("routes a destination by the rail's own key", () => {
    // To-Do has its own route, which carries the view (`#/todo/planned`).
    for (const dest of DESTINATIONS.filter((d) => d.key !== "todo")) {
      expect(parseRoute(destinationHref(dest.key).slice(1))).toEqual({ name: "destination", key: dest.key });
    }
    expect(DESTINATIONS.map((d) => d.key)).toEqual(["bin", "todo", "admin"]);
  });

  it("routes To-Do with its view; the rail's bare key lands on the default view", () => {
    expect(parseRoute(destinationHref("todo").slice(1))).toEqual({ name: "todo", view: "" });
    expect(parseRoute("/todo/planned")).toEqual({ name: "todo", view: "planned" });
    expect(parseRoute("/todo/list/abc")).toEqual({ name: "todo", view: "list/abc" });
    expect(todoHref("list/abc")).toBe("#/todo/list/abc");
    expect(todoHref("")).toBe("#/todo");
  });

  it("never lets a destination key shadow a fixed route", () => {
    // `DESTINATIONS` is matched last, so a key like `login` cannot shadow a route.
    expect(parseRoute("/login").name).toBe("login");
    expect(parseRoute("/search").name).toBe("search");
    expect(parseRoute("/change-password").name).toBe("change-password");
  });
});

describe("the query survives the round trip", () => {
  // `#` unencoded would truncate the hash.
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
    expect(notePageHref("n-1", 0)).toBe("#/note/n-1");
    expect(notePageHref("n-1", 0, "")).toBe("#/note/n-1");
    expect(noteHref("n-1")).toBe("#/note/n-1");
  });

  // Literal strings on both sides: a round trip alone would pass with no offset at all.
  it("writes the URL counting from ONE while the index counts from zero", () => {
    expect(notePageHref("n-1", 1)).toBe("#/note/n-1/page/2");
    expect(notePageHref("n-1", 4)).toBe("#/note/n-1/page/5");
    expect(notePageHref("n-1", 4, "q")).toBe("#/note/n-1/page/5?q=q");
  });

  it("reads the URL counting from ONE, back into a zero-based index", () => {
    expect(parseRoute("/note/n-1/page/2").page).toBe(1);
    expect(parseRoute("/note/n-1/page/5").page).toBe(4);
    // `/page/1` is accepted but never emitted.
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
  // A retained version is a 7-hex md5 prefix scoped by `:id`; the current version has
  // no `/version/` form.
  it("reads the bare and paged shapes", () => {
    expect(parseRoute("/note/n-1/version/a1b2c3d")).toEqual({
      name: "note-version",
      id: "n-1",
      short: "a1b2c3d",
      page: 0,
    });
    expect(parseRoute("/note/n-1/version/a1b2c3d/page/4")).toEqual({
      name: "note-version",
      id: "n-1",
      short: "a1b2c3d",
      page: 3,
    });
  });

  it("does NOT read a bare note URL as a version, and vice versa", () => {
    expect(parseRoute("/note/n-1").name).toBe("note");
    expect(parseRoute("/note/n-1/page/2").name).toBe("note");
    expect(parseRoute("/note/n-1/version/abc123f").name).toBe("note-version");
  });

  it("round-trips an id containing a slash, and clamps a bad page like the note route", () => {
    const route = parseRoute(noteVersionHref("a/b", "abc123f", 2).slice(1));
    expect(route).toEqual({ name: "note-version", id: "a/b", short: "abc123f", page: 2 });
    expect(parseRoute("/note/n-1/version/abc123f/page/0")).toMatchObject({ page: 0 });
    expect(parseRoute("/note/n-1/version/abc123f/page/nope")).toMatchObject({ page: 0 });
  });

  it("has ONE spelling for the first page, counting from one past it", () => {
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
  // A trashed file lives one path under `#/bin`, with no `?q=`.
  it("reads the bare and paged shapes", () => {
    expect(parseRoute("/bin/note/n-1")).toEqual({ name: "bin-note", id: "n-1", page: 0 });
    expect(parseRoute("/bin/note/n-1/page/4")).toEqual({ name: "bin-note", id: "n-1", page: 3 });
    expect(parseRoute("/bin/note/n-1/page/1")).toEqual(parseRoute("/bin/note/n-1"));
  });

  it("keeps `#/bin` itself the bin LISTING, not a bin-note", () => {
    expect(parseRoute("/bin")).toEqual({ name: "destination", key: "bin" });
    expect(parseRoute("/bin/note/n-1").name).toBe("bin-note");
  });

  it("does NOT bleed with the note or note-version routes", () => {
    expect(parseRoute("/note/n-1").name).toBe("note");
    expect(parseRoute("/note/n-1/version/abc123f").name).toBe("note-version");
    expect(parseRoute("/bin/note/n-1").name).toBe("bin-note");
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
