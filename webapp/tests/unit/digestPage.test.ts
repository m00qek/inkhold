// @vitest-environment happy-dom
// The Digest page's states before there are digests to show: loading, off on
// the server, a failed read that can be tried again; that an unchanged answer
// repaints nothing; how often a search may ask again; editing a comment, and
// moving a digest to a category; the overviews, and the top bar's tools for
// each place.

import { describe, it, expect, vi } from "vitest";
import { createDigestPage, type DigestHost } from "../../src/pages/digest/digestPage";
import type { DigestInk } from "../../src/pages/digest/digestInk";
import type { DigestEdit, DigestSnapshot } from "../../src/api/digestTypes";
import { ApiError } from "../../src/api/errors";

const ink: DigestInk = { picture: async () => null, holder: () => null };

function host(digests: () => Promise<DigestSnapshot>, digestEdit: (id: string, c: DigestEdit) => Promise<void> = async () => {}): DigestHost & { changed: number; toasts: string[]; refreshed: number } {
  const h = {
    api: {
      digests,
      digestEdit,
      digestCreateCategory: async (name: string) => ({ uid: "new", name }),
      digestRenameCategory: async () => {},
      digestDeleteCategory: async () => 0,
    },
    content: document.createElement("div"),
    gallery: document.createElement("div"),
    crumbs: document.createElement("div"),
    sortWrap: document.createElement("div"),
    segmented: document.createElement("div"),
    categoryBtn: document.createElement("button"),
    newCategoryBtn: document.createElement("button"),
    setPlace: () => {},
    setMode: () => {},
    setSearchShown: () => {},
    trash: async () => true,
    toast: (m: string) => void h.toasts.push(m),
    handled: () => false,
    onChanged: () => void h.changed++,
    onBinChanged: () => {},
    go: () => {},
    replace: () => {},
    wide: () => false,
    rememberClosed: () => {},
    closedHere: () => false,
    ink,
    thumbs: { holder: () => null, refresh: () => void h.refreshed++ },
    openFile: () => {},
    changed: 0,
    refreshed: 0,
    toasts: [] as string[],
  };
  return h;
}

const ALL = { view: { kind: "category", uid: null }, digest: null } as const;
const one: DigestSnapshot = {
  enabled: true,
  categories: [{ uid: "kb-1", name: "Grammar" }],
  digests: [{
    id: "1", text: "a passage", comment: null, categoryUid: "", author: null, createdAt: 1, modifiedAt: 1, note: null, waiting: false,
    source: { kind: "manual", path: null, fileId: null, page: null, changed: false },
  }],
  tabletSyncedAt: null,
  waiting: false,
};
const title = (h: DigestHost) => h.content.querySelector(".digest-empty__title")?.textContent;

/** The open digest's ⋯, then one of its rows (or a row's own menu, as Move to…). */
function pick(h: DigestHost, label: string): void {
  h.content.querySelector<HTMLButtonElement>("#digest-actions")!.click();
  [...document.querySelectorAll<HTMLButtonElement>("[role=menuitem]")].find((b) => b.textContent?.includes(label))!.click();
}

describe("the Digest page", () => {
  it("is asked again by a search only half a minute after it was last asked, answered or not", async () => {
    let asked = 0;
    let fail = true;
    const h = host(async () => {
      asked++;
      if (fail) throw new Error("offline");
      return one;
    });
    const page = createDigestPage(h);
    const a = page.freshen();
    const b = page.freshen();
    expect(asked).toBe(1);
    await Promise.all([a, b]);
    fail = false;
    await page.freshen();
    expect(asked).toBe(1);
    page.destroy();
  });

  it("says it is loading, then shows what the server has", async () => {
    const h = host(async () => one);
    const page = createDigestPage(h);
    page.open(ALL);
    expect(title(h)).toBe("Loading…");
    await vi.waitFor(() => expect(h.content.querySelector(".digest-card")).not.toBeNull());
    page.destroy();
  });

  it("off on the server: says how to turn it on", async () => {
    const h = host(async () => ({ enabled: false, categories: [], digests: [], tabletSyncedAt: null, waiting: false }));
    const page = createDigestPage(h);
    page.open(ALL);
    await vi.waitFor(() => expect(title(h)).toBe("Digest sync is off on this server"));
    expect(h.content.textContent).toContain("digest_sync");
    page.destroy();
  });

  it("a failed first read can be tried again", async () => {
    let fail = true;
    const h = host(async () => {
      if (fail) throw new Error("offline");
      return one;
    });
    const page = createDigestPage(h);
    page.open(ALL);
    await vi.waitFor(() => expect(title(h)).toBe("Your digests could not be loaded"));
    fail = false;
    h.content.querySelector<HTMLButtonElement>(".digest-empty button")!.click();
    await vi.waitFor(() => expect(h.content.querySelector(".digest-card")).not.toBeNull());
    page.destroy();
  });

  it("an answer like the last one repaints nothing", async () => {
    const h = host(async () => structuredClone(one));
    const page = createDigestPage(h);
    page.open(ALL);
    await vi.waitFor(() => expect(h.content.querySelector(".digest-card")).not.toBeNull());
    const card = h.content.querySelector(".digest-card");
    const before = h.changed;
    await page.load();
    expect(h.content.querySelector(".digest-card")).toBe(card);
    expect(h.changed).toBe(before);
    page.destroy();
  });

  it("a comment: edited, saved, re-read; a re-read while typing keeps the draft; a failed save keeps it too", async () => {
    let server = structuredClone(one);
    let refuse = false;
    const saved: string[] = [];
    const h = host(
      async () => structuredClone(server),
      async (id, c) => {
        if (refuse) throw new Error("offline");
        saved.push(`${id}:${c.comment}`);
        server = { ...server, waiting: true, digests: server.digests.map((d) => (d.id === id ? { ...d, comment: c.comment ?? null, waiting: true } : d)) };
      },
    );
    const page = createDigestPage(h);
    page.open({ ...ALL, digest: "1" });
    await vi.waitFor(() => expect(h.content.querySelector("#digest-comment-edit")).not.toBeNull());
    expect(h.content.querySelector("#digest-comment-edit")!.textContent).toBe("Add a comment");

    h.content.querySelector<HTMLButtonElement>("#digest-comment-edit")!.click();
    const box = () => h.content.querySelector<HTMLTextAreaElement>("#digest-comment")!;
    box().value = "Learn it by heart";
    box().dispatchEvent(new Event("input"));
    // The tablet's news arrives while typing: the box stays as it is.
    server = { ...server, digests: [...server.digests, { ...server.digests[0]!, id: "2", text: "another" }] };
    await page.load();
    expect(box().value).toBe("Learn it by heart");

    refuse = true;
    h.content.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(h.toasts.at(-1)).toMatch(/Couldn't save the comment/));
    expect(box().value).toBe("Learn it by heart");

    refuse = false;
    h.content.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(h.content.querySelector("#digest-comment")).toBeNull());
    expect(saved).toEqual(["1:Learn it by heart"]);
    expect(h.content.querySelector(".digest-panel")!.textContent).toContain("Learn it by heart");
    expect(h.content.querySelector(".digest-panel")!.textContent).toContain("Waiting for the tablet");
    page.destroy();
  });

  it("a save that changes nothing sends nothing; one the server answers alike still closes the form", async () => {
    const server = { ...structuredClone(one), digests: [{ ...one.digests[0]!, comment: "kept" }] };
    const sent: DigestEdit[] = [];
    // The server takes the edit and answers as before: the page must not wait for a change.
    const h = host(async () => structuredClone(server), async (_id, c) => void sent.push(c));
    const page = createDigestPage(h);
    page.open({ ...ALL, digest: "1" });
    await vi.waitFor(() => expect(h.content.querySelector("#digest-comment-edit")).not.toBeNull());
    const box = () => h.content.querySelector<HTMLTextAreaElement>("#digest-comment");
    const submit = () => h.content.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));

    h.content.querySelector<HTMLButtonElement>("#digest-comment-edit")!.click();
    box()!.value = "  kept ";
    box()!.dispatchEvent(new Event("input"));
    submit();
    expect(box()).toBeNull();
    expect(sent).toEqual([]);

    h.content.querySelector<HTMLButtonElement>("#digest-comment-edit")!.click();
    box()!.value = "other";
    box()!.dispatchEvent(new Event("input"));
    submit();
    await vi.waitFor(() => expect(box()).toBeNull());
    expect(sent).toEqual([{ comment: "other" }]);
    expect(h.content.querySelector<HTMLButtonElement>("#digest-comment-edit")!.disabled).toBe(false);
    page.destroy();
  });

  it("a move the server refuses says so and leaves the digest where it was", async () => {
    const h = host(async () => structuredClone(one), async () => {
      throw new Error("offline");
    });
    const page = createDigestPage(h);
    page.open({ ...ALL, digest: "1" });
    await vi.waitFor(() => expect(h.content.querySelector("#digest-actions")).not.toBeNull());
    pick(h, "Move to…");
    const to = [...document.querySelectorAll<HTMLButtonElement>("[role=menuitem]")].find((b) => b.textContent?.includes("Grammar"));
    expect(to).toBeDefined();
    to!.click();
    await vi.waitFor(() => expect(h.toasts.at(-1)).toMatch(/Couldn't move the digest/));
    expect(h.content.querySelector(".digest-panel__facts")!.textContent).toContain("Uncategorized");
    page.destroy();
  });

  it("a save's repaint is not lost to a re-read that answers first", async () => {
    let release: () => void = () => {};
    let calls = 0;
    const h = host(
      async () => {
        calls++;
        // The save's own re-read is slow; a poll's, after it, is not.
        if (calls === 2) await new Promise<void>((r) => (release = r));
        return structuredClone(one);
      },
      async () => {},
    );
    const page = createDigestPage(h);
    page.open({ ...ALL, digest: "1" });
    await vi.waitFor(() => expect(h.content.querySelector("#digest-comment-edit")).not.toBeNull());
    h.content.querySelector<HTMLButtonElement>("#digest-comment-edit")!.click();
    const box = h.content.querySelector<HTMLTextAreaElement>("#digest-comment")!;
    box.value = "new";
    box.dispatchEvent(new Event("input"));
    h.content.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(calls).toBe(2));
    await page.load(); // answers alike, and first
    expect(h.content.querySelector("#digest-comment")).toBeNull();
    release();
    page.destroy();
  });

  it("a comment's spaces around it are the server's to drop, nothing inside", async () => {
    const server = { ...structuredClone(one), digests: [{ ...one.digests[0]!, comment: "kept" }] };
    const sent: DigestEdit[] = [];
    const h = host(async () => structuredClone(server), async (_id, c) => void sent.push(c));
    const page = createDigestPage(h);
    page.open({ ...ALL, digest: "1" });
    await vi.waitFor(() => expect(h.content.querySelector("#digest-comment-edit")).not.toBeNull());
    h.content.querySelector<HTMLButtonElement>("#digest-comment-edit")!.click();
    const box = h.content.querySelector<HTMLTextAreaElement>("#digest-comment")!;
    box.value = "kept\u00a0";
    box.dispatchEvent(new Event("input"));
    h.content.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(sent).toEqual([{ comment: "kept\u00a0" }]));
    page.destroy();
  });

  it("a tablet comment with blank space around it, saved untouched, sends nothing", async () => {
    const server = { ...structuredClone(one), digests: [{ ...one.digests[0]!, comment: "Note\n" }] };
    const sent: DigestEdit[] = [];
    const h = host(async () => structuredClone(server), async (_id, c) => void sent.push(c));
    const page = createDigestPage(h);
    page.open({ ...ALL, digest: "1" });
    await vi.waitFor(() => expect(h.content.querySelector("#digest-comment-edit")).not.toBeNull());
    h.content.querySelector<HTMLButtonElement>("#digest-comment-edit")!.click();
    h.content.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(h.content.querySelector("#digest-comment")).toBeNull();
    expect(sent).toEqual([]);
    page.destroy();
  });

  it("a move's repaint never rebuilds a comment box opened meanwhile", async () => {
    let server = structuredClone(one);
    let moved: () => void = () => {};
    const h = host(
      async () => structuredClone(server),
      () =>
        new Promise<void>((r) => {
          moved = () => {
            server = { ...server, digests: server.digests.map((d) => ({ ...d, categoryUid: "kb-1", waiting: true })) };
            r();
          };
        }),
    );
    const page = createDigestPage(h);
    page.open({ ...ALL, digest: "1" });
    await vi.waitFor(() => expect(h.content.querySelector("#digest-actions")).not.toBeNull());
    pick(h, "Move to…");
    [...document.querySelectorAll<HTMLButtonElement>("[role=menuitem]")].find((b) => b.textContent?.includes("Grammar"))!.click();
    // While the move is out, the comment is opened and typed into.
    h.content.querySelector<HTMLButtonElement>("#digest-comment-edit")!.click();
    const box = h.content.querySelector<HTMLTextAreaElement>("#digest-comment")!;
    box.value = "half a thought";
    box.dispatchEvent(new Event("input"));
    moved();
    await vi.waitFor(() => expect(h.toasts.at(-1)).toBe("Moved to Grammar."));
    await page.load(); // a poll, answering as the last
    expect(h.content.querySelector("#digest-comment")).toBe(box);
    expect(box.value).toBe("half a thought");
    page.destroy();
  });

  it("a failed move never rebuilds a comment box opened meanwhile", async () => {
    let refuse: (e: Error) => void = () => {};
    const h = host(async () => structuredClone(one), () => new Promise<void>((_ok, no) => (refuse = no)));
    const page = createDigestPage(h);
    page.open({ ...ALL, digest: "1" });
    await vi.waitFor(() => expect(h.content.querySelector("#digest-actions")).not.toBeNull());
    pick(h, "Move to…");
    [...document.querySelectorAll<HTMLButtonElement>("[role=menuitem]")].find((b) => b.textContent?.includes("Grammar"))!.click();
    h.content.querySelector<HTMLButtonElement>("#digest-comment-edit")!.click();
    const box = h.content.querySelector<HTMLTextAreaElement>("#digest-comment")!;
    refuse(new Error("offline"));
    await vi.waitFor(() => expect(h.toasts.at(-1)).toMatch(/Couldn't move the digest/));
    expect(h.content.querySelector("#digest-comment")).toBe(box);
    page.destroy();
  });

  it("opening a digest checks its file's page picture again", async () => {
    const h = host(async () => structuredClone(one));
    const page = createDigestPage(h);
    page.open(ALL);
    page.open({ ...ALL, digest: "1" });
    expect(h.refreshed).toBe(2);
    page.destroy();
  });

  it("over the app's limit, the comment can't be saved and says by how much", async () => {
    const h = host(async () => structuredClone(one));
    const page = createDigestPage(h);
    page.open({ ...ALL, digest: "1" });
    await vi.waitFor(() => expect(h.content.querySelector("#digest-comment-edit")).not.toBeNull());
    h.content.querySelector<HTMLButtonElement>("#digest-comment-edit")!.click();
    const box = h.content.querySelector<HTMLTextAreaElement>("#digest-comment")!;
    box.value = "é".repeat(2003);
    box.dispatchEvent(new Event("input"));
    expect(h.content.querySelector("#digest-comment-count")!.textContent).toBe("3 characters too many");
    expect(h.content.querySelector<HTMLButtonElement>("form button[type=submit]")!.disabled).toBe(true);
    page.destroy();
  });
});

describe("the Digest page's places", () => {
  const two: DigestSnapshot = {
    ...one,
    digests: [...one.digests, { ...one.digests[0]!, id: "2", text: "a grammar rule", categoryUid: "kb-1" }],
  };

  it("lands on the categories' overview: Uncategorized, then each category with its passages; New category in the top bar", async () => {
    const h = host(async () => structuredClone(two));
    const page = createDigestPage(h);
    page.open({ view: { kind: "categories" }, digest: null });
    await page.load();
    const names = [...h.content.querySelectorAll(".app-card__name")].map((n) => n.textContent);
    expect(names).toEqual(["Uncategorized", "Grammar"]);
    expect(h.content.querySelector(".app-card__name a")?.getAttribute("href")).toBe("#/digest/uncategorized");
    // Uncategorized's ⋯ is there, disabled; a category's offers Rename and Delete.
    const menus = [...h.content.querySelectorAll<HTMLButtonElement>(".card__more")];
    expect(menus.map((m) => m.disabled)).toEqual([true, false]);
    expect(h.newCategoryBtn.hidden).toBe(false);
    expect(h.categoryBtn.hidden).toBe(true);
    expect(h.crumbs.textContent).toContain("Categories");
    expect(h.crumbs.textContent).toContain("1 category · 2 digests");
  });

  it("inside a category: its name in the top bar, its menu there, its digests listed", async () => {
    const places: string[] = [];
    const h = host(async () => structuredClone(two));
    h.setPlace = (n) => void (n !== null && places.push(n));
    const page = createDigestPage(h);
    page.open({ view: { kind: "category", uid: "kb-1" }, digest: null });
    await page.load();
    expect(places.at(-1)).toBe("Grammar");
    expect(h.crumbs.textContent).toContain("1 digest");
    expect(h.newCategoryBtn.hidden).toBe(true);
    expect(h.categoryBtn.hidden).toBe(false);
    expect(h.categoryBtn.getAttribute("aria-label")).toBe("Category options for Grammar");
    expect([...h.content.querySelectorAll(".digest-card__text")].map((n) => n.textContent)).toEqual(["a grammar rule"]);
    // Uncategorized and All have no menu of their own.
    page.open({ view: { kind: "category", uid: "" }, digest: null });
    expect(h.categoryBtn.hidden).toBe(true);
  });

  it("the sources' overview: a tile per source, as the library draws a file", async () => {
    const h = host(async () => structuredClone(two));
    const page = createDigestPage(h);
    page.open({ view: { kind: "sources" }, digest: null });
    await page.load();
    expect([...h.content.querySelectorAll(".digest-source__name")].map((n) => n.textContent)).toEqual(["Typed on the tablet"]);
    expect([...h.content.querySelectorAll(".digest-source__meta span")].map((n) => n.textContent)).toEqual(["2 digests"]);
    expect(h.content.querySelector(".digest-source")?.getAttribute("href")).toBe("#/digest/sources/manual");
  });

  it("a category's card: its newest passage whole, where it came from, and how many more", async () => {
    const h = host(async () => structuredClone(two));
    const page = createDigestPage(h);
    page.open({ view: { kind: "categories" }, digest: null });
    await page.load();
    const grammar = [...h.content.querySelectorAll(".app-card")][1]!;
    expect(grammar.querySelector(".app-card__quote p")?.textContent).toBe("“a grammar rule”");
    expect(grammar.querySelector(".app-card__from")?.textContent).toMatch(/^Typed on the tablet · added /);
    expect(grammar.querySelector(".app-card__more")).toBeNull();
  });

  it("Move to bin: gone at once, its place closes in place of its entry, focus on its neighbour", async () => {
    const d = (id: string, at: number) => ({ ...one.digests[0]!, id, text: `passage ${id}`, createdAt: at });
    let server: DigestSnapshot = { ...one, digests: [d("a", 3), d("b", 2), d("c", 1)] };
    const replaced: string[] = [];
    let closed = 0;
    const h = host(async () => structuredClone(server));
    // The real router: a replace re-enters the page at once, before any fresh read.
    const list = { view: { kind: "category", uid: "" }, digest: null } as const;
    h.replace = (path) => {
      replaced.push(path);
      page.open(list);
    };
    // The real bin: the digest leaves the server's answer.
    h.trash = async (x) => {
      server = { ...server, digests: server.digests.filter((y) => y.id !== x.id) };
      return true;
    };
    h.rememberClosed = () => void closed++;
    const page = createDigestPage(h);
    document.body.append(h.content);
    page.open({ view: { kind: "category", uid: "" }, digest: "b" });
    await page.load();
    pick(h, "Move to bin");
    await vi.waitFor(() => expect(replaced).toEqual(["uncategorized"]));
    expect(closed).toBe(1);
    // No paint showed it again; focus is on the next card, the one after it.
    expect([...h.content.querySelectorAll(".digest-card__text")].map((n) => n.textContent)).toEqual(["passage a", "passage c"]);
    await page.load();
    expect(document.activeElement?.getAttribute("data-digest")).toBe("c");
    h.content.remove();
  });

  it("Move to bin leaves the person where they are when they moved on before it answered", async () => {
    const replaced: string[] = [];
    let answer: (went: boolean) => void = () => {};
    const h = host(async () => structuredClone(two));
    h.trash = () => new Promise<boolean>((r) => (answer = r));
    h.replace = (path) => void replaced.push(path);
    const page = createDigestPage(h);
    page.open({ view: { kind: "category", uid: "kb-1" }, digest: "2" });
    await page.load();
    pick(h, "Move to bin");
    // Meanwhile: another place.
    page.open({ view: { kind: "categories" }, digest: null });
    answer(true);
    await page.load();
    expect(replaced).toEqual([]);
  });

  it("the search box shows on the overviews, as on To-Do's lists, and not inside a list", async () => {
    const shown: boolean[] = [];
    const h = host(async () => structuredClone(two));
    h.setSearchShown = (s) => void shown.push(s);
    const page = createDigestPage(h);
    page.open({ view: { kind: "categories" }, digest: null });
    expect(shown.at(-1)).toBe(true);
    page.open({ view: { kind: "category", uid: "kb-1" }, digest: null });
    expect(shown.at(-1)).toBe(false);
    page.open({ view: { kind: "sources" }, digest: null });
    expect(shown.at(-1)).toBe(true);
  });

  it("on a desktop, a list with no digest open keeps the panel's place, saying what goes there", async () => {
    const h = host(async () => structuredClone(two));
    const page = createDigestPage(h);
    page.open({ view: { kind: "category", uid: "kb-1" }, digest: null });
    await page.load();
    expect(h.content.querySelector(".digest-idle")?.textContent).toContain("Choose a digest");
    expect(h.content.querySelector(".digest-body")?.classList.contains("has-open")).toBe(false);
  });
});

describe("a list on a wide screen", () => {
  const three: DigestSnapshot = {
    ...one,
    digests: [
      { ...one.digests[0]!, id: "1", createdAt: 1 },
      { ...one.digests[0]!, id: "2", createdAt: 2 },
    ],
  };

  it("entering a list opens its first digest, in place of the list's history entry; closing it stays closed", async () => {
    const replaced: string[] = [];
    const h = host(async () => structuredClone(three));
    h.wide = () => true;
    h.replace = (path) => void replaced.push(path);
    const page = createDigestPage(h);
    page.open({ view: { kind: "category", uid: "" }, digest: null });
    await page.load();
    // Newest first: the first is the newest.
    expect(replaced).toEqual(["uncategorized/d/2"]);

    page.open({ view: { kind: "category", uid: "" }, digest: "2" });
    page.open({ view: { kind: "category", uid: "" }, digest: null });
    await page.load();
    expect(replaced).toEqual(["uncategorized/d/2"]);
  });

  it("an entry the person closed a digest on stays closed when they come back to it (Back)", async () => {
    const replaced: string[] = [];
    let closedHere = false;
    const h = host(async () => structuredClone(three));
    h.wide = () => true;
    h.replace = (path) => void replaced.push(path);
    h.rememberClosed = () => void (closedHere = true);
    h.closedHere = () => closedHere;
    const page = createDigestPage(h);
    page.open({ view: { kind: "category", uid: "" }, digest: "2" });
    await page.load();
    // Escape: the digest's place closes, marked on the entry.
    h.content.querySelector(".digest-card__link")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(closedHere).toBe(true);
    // Away and Back to that entry: a fresh open, nothing opens by itself.
    page.close();
    page.open({ view: { kind: "category", uid: "" }, digest: null });
    await page.load();
    expect(replaced).toEqual([]);
  });

  it("not on a narrower screen, where the open digest takes the list's place; not on an overview", async () => {
    const replaced: string[] = [];
    const h = host(async () => structuredClone(three));
    h.replace = (path) => void replaced.push(path);
    const page = createDigestPage(h);
    page.open({ view: { kind: "category", uid: "" }, digest: null });
    await page.load();
    h.wide = () => true;
    page.open({ view: { kind: "categories" }, digest: null });
    await page.load();
    expect(replaced).toEqual([]);
  });
});

describe("the open digest's panel", () => {
  it("has no ×, and its actions in one ⋯: Move to…, Copy text, then Move to bin", async () => {
    const h = host(async () => structuredClone(one));
    const page = createDigestPage(h);
    page.open({ ...ALL, digest: "1" });
    await page.load();
    expect(h.content.querySelector(".digest-panel a[aria-label='Close the digest']")).toBeNull();
    h.content.querySelector<HTMLButtonElement>("#digest-actions")!.click();
    const labels = [...document.querySelectorAll("[role=menu] [role^=menuitem]")].map((b) => b.textContent?.trim());
    expect(labels).toEqual(["Move to…", "Copy text", "Move to bin"]);
    // The category is a fact like the others, no button in it.
    expect(h.content.querySelector(".digest-panel__facts button")).toBeNull();
    page.destroy();
  });
});

describe("a refused change says why", () => {
  it("a name the server refuses is not called a connection problem", async () => {
    const h = host(async () => structuredClone(one));
    h.api.digestRenameCategory = async () => Promise.reject(new ApiError("BAD_NAME", "x", 400));
    const page = createDigestPage(h);
    page.open({ view: { kind: "category", uid: "kb-1" }, digest: null });
    await page.load();
    h.categoryBtn.click();
    [...document.querySelectorAll<HTMLButtonElement>("[role=menuitem]")].find((b) => b.textContent?.includes("Rename category"))!.click();
    const field = document.querySelector<HTMLInputElement>("#name-dialog-field")!;
    field.value = "Grammaire";
    field.dispatchEvent(new Event("input"));
    document.querySelector<HTMLButtonElement>("dialog button[value=go]")!.click();
    await vi.waitFor(() => expect(h.toasts.at(-1)).toMatch(/^The tablet can't take that name/));
    page.destroy();
  });
});

describe("a category made or deleted here, before the next answer", () => {
  /** Types a name into the open name dialog and confirms it. */
  function name(value: string): void {
    const field = document.querySelector<HTMLInputElement>("#name-dialog-field")!;
    field.value = value;
    field.dispatchEvent(new Event("input"));
    document.querySelector<HTMLButtonElement>("dialog button[value=go]")!.click();
  }

  it("New category opens it only once the page has it: never as a category that is gone", async () => {
    let server: DigestSnapshot = structuredClone(one);
    const h = host(async () => structuredClone(server));
    h.api.digestCreateCategory = async (n: string) => {
      server = { ...server, categories: [...server.categories, { uid: "new", name: n }] };
      return { uid: "new", name: n };
    };
    const page = createDigestPage(h);
    // The real router: a new place is opened at once.
    const seen: (string | null | undefined)[] = [];
    h.go = () => {
      page.open({ view: { kind: "category", uid: "new" }, digest: null });
      seen.push(title(h) ?? null);
    };
    page.open({ view: { kind: "categories" }, digest: null });
    await page.load();
    h.newCategoryBtn.click();
    name("Phrases");
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).not.toBe("This category is gone");
    page.destroy();
  });

  it("a deleted category's card leaves the overview at once, before the server's next answer", async () => {
    let answer: (s: DigestSnapshot) => void = () => {};
    let hold = false;
    const h = host(() => (hold ? new Promise((r) => (answer = r)) : Promise.resolve(structuredClone(one))));
    const page = createDigestPage(h);
    document.body.append(h.content);
    page.open({ view: { kind: "categories" }, digest: null });
    await page.load();
    const names = () => [...h.content.querySelectorAll(".app-card__name")].map((n) => n.textContent);
    expect(names()).toContain("Grammar");
    hold = true;
    h.content.querySelector<HTMLButtonElement>('[aria-label="Actions for Grammar"]')!.click();
    [...document.querySelectorAll<HTMLButtonElement>("[role=menuitem]")].find((b) => b.textContent?.includes("Delete category"))!.click();
    document.querySelector<HTMLButtonElement>("dialog button[value=go]")!.click();
    await vi.waitFor(() => expect(h.toasts.at(-1)).toBe('Deleted "Grammar".'));
    expect(names()).not.toContain("Grammar");
    answer({ ...structuredClone(one), categories: [] });
    page.destroy();
    h.content.remove();
  });

  it("the open digest's card closes it, as Escape does, and it stays closed", async () => {
    const h = host(async () => structuredClone(one));
    const went: string[] = [];
    let closed = 0;
    h.go = (path) => void went.push(path);
    h.rememberClosed = () => void closed++;
    const page = createDigestPage(h);
    page.open({ ...ALL, digest: "1" });
    await page.load();
    const link = h.content.querySelector<HTMLAnchorElement>('.digest-card__link[data-digest="1"]')!;
    expect(link.getAttribute("aria-current")).toBe("true");
    link.click();
    expect(went).toEqual(["all"]);
    expect(closed).toBe(1);
    page.destroy();
  });
});
