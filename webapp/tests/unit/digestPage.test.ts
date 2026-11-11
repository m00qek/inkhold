// @vitest-environment happy-dom
// The Digest page's states before there are digests to show: loading, off on
// the server, a failed read that can be tried again; that an unchanged answer
// repaints nothing; and editing a comment, the one change made here.

import { describe, it, expect, vi } from "vitest";
import { createDigestPage, type DigestHost } from "../../src/pages/digest/digestPage";
import type { DigestInk } from "../../src/pages/digest/digestInk";
import type { DigestSnapshot } from "../../src/api/digestTypes";

const ink: DigestInk = { picture: async () => null, holder: () => null };

function host(digests: () => Promise<DigestSnapshot>, digestSetComment: (id: string, c: string) => Promise<void> = async () => {}): DigestHost & { changed: number; toasts: string[] } {
  const h = {
    api: { digests, digestSetComment },
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
    openFile: () => {},
    changed: 0,
    toasts: [] as string[],
  };
  return h;
}

const ALL = { view: { kind: "category", uid: null }, digest: null } as const;
const one: DigestSnapshot = {
  enabled: true,
  categories: [],
  digests: [{ id: "1", text: "a passage", comment: null, categoryUid: "", author: null, createdAt: 1, note: null, waiting: false, source: { kind: "manual", path: null, fileId: null, page: null } }],
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
        saved.push(`${id}:${c}`);
        server = { ...server, waiting: true, digests: server.digests.map((d) => (d.id === id ? { ...d, comment: c, waiting: true } : d)) };
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
