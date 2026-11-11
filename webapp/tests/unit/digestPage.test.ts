// @vitest-environment happy-dom
// The Digest page's states before there are digests to show: loading, off on
// the server, a failed read that can be tried again; that an unchanged answer
// repaints nothing; editing a comment, and moving a digest to a category.

import { describe, it, expect, vi } from "vitest";
import { createDigestPage, type DigestHost } from "../../src/pages/digest/digestPage";
import type { DigestInk } from "../../src/pages/digest/digestInk";
import type { DigestEdit, DigestSnapshot } from "../../src/api/digestTypes";

const ink: DigestInk = { picture: async () => null, holder: () => null };

function host(digests: () => Promise<DigestSnapshot>, digestEdit: (id: string, c: DigestEdit) => Promise<void> = async () => {}): DigestHost & { changed: number; toasts: string[]; refreshed: number } {
  const h = {
    api: { digests, digestEdit },
    content: document.createElement("div"),
    gallery: document.createElement("div"),
    crumbs: document.createElement("div"),
    sortWrap: document.createElement("div"),
    segmented: document.createElement("div"),
    setPlace: () => {},
    setMode: () => {},
    toast: (m: string) => void h.toasts.push(m),
    handled: () => false,
    onChanged: () => void h.changed++,
    go: () => {},
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

describe("the Digest page", () => {
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
    await vi.waitFor(() => expect(h.content.querySelector("#digest-move")).not.toBeNull());
    h.content.querySelector<HTMLButtonElement>("#digest-move")!.click();
    const to = [...document.querySelectorAll<HTMLButtonElement>("[role=menuitemradio]")].find((b) => b.textContent?.includes("Grammar"));
    expect(to).toBeDefined();
    to!.click();
    await vi.waitFor(() => expect(h.toasts.at(-1)).toMatch(/Couldn't move the digest/));
    expect(h.content.querySelector(".digest-panel__category")!.textContent).toContain("Uncategorized");
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
    await vi.waitFor(() => expect(h.content.querySelector("#digest-move")).not.toBeNull());
    h.content.querySelector<HTMLButtonElement>("#digest-move")!.click();
    [...document.querySelectorAll<HTMLButtonElement>("[role=menuitemradio]")].find((b) => b.textContent?.includes("Grammar"))!.click();
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
    await vi.waitFor(() => expect(h.content.querySelector("#digest-move")).not.toBeNull());
    h.content.querySelector<HTMLButtonElement>("#digest-move")!.click();
    [...document.querySelectorAll<HTMLButtonElement>("[role=menuitemradio]")].find((b) => b.textContent?.includes("Grammar"))!.click();
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
