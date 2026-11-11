// @vitest-environment happy-dom
// The Digest page's states before there are digests to show: loading, off on
// the server, a failed read that can be tried again; and that an unchanged
// answer repaints nothing.

import { describe, it, expect, vi } from "vitest";
import { createDigestPage, type DigestHost } from "../../src/pages/digest/digestPage";
import type { DigestInk } from "../../src/pages/digest/digestInk";
import type { DigestSnapshot } from "../../src/api/digestTypes";

const ink: DigestInk = { picture: async () => null, holder: () => null };

function host(digests: () => Promise<DigestSnapshot>): DigestHost & { changed: number } {
  const h = {
    api: { digests },
    content: document.createElement("div"),
    gallery: document.createElement("div"),
    crumbs: document.createElement("div"),
    sortWrap: document.createElement("div"),
    segmented: document.createElement("div"),
    setPlace: () => {},
    setMode: () => {},
    toast: () => {},
    handled: () => false,
    onChanged: () => void h.changed++,
    go: () => {},
    ink,
    openFile: () => {},
    changed: 0,
  };
  return h;
}

const ALL = { view: { kind: "category", uid: null }, digest: null } as const;
const one: DigestSnapshot = {
  enabled: true,
  categories: [],
  digests: [{ id: "1", text: "a passage", comment: null, categoryUid: "", author: null, createdAt: 1, note: null, source: { kind: "manual", path: null, fileId: null, page: null } }],
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
    const h = host(async () => ({ enabled: false, categories: [], digests: [] }));
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
});
