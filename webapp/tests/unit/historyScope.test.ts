import { describe, it, expect, vi } from "vitest";
import { createHistoryScope, rawVersionMeta, versionMeta } from "../../src/pages/historyScope";
import type { Api } from "../../src/api/types";
import type { NoteMeta, PageRef, PageText } from "../../src/core/types";

// Raw-based history viewers (.spd/.txt/image) need only identity plus the version's md5 and size.
describe("rawVersionMeta", () => {
  const file = { id: "174", name: "Kitchen sketch", fileType: "spd" };
  const version = { md5: "d".repeat(32), size: 4096, createdAt: 1_752_000_000_000 };

  it("carries the file's identity and the VERSION's md5 as fileHash", () => {
    const meta = rawVersionMeta(file, version);
    expect(meta.id).toBe("174");
    expect(meta.name).toBe("Kitchen sketch");
    expect(meta.fileType).toBe("spd");
    expect(meta.fileHash).toBe("d".repeat(32));
    expect(meta.size).toBe(4096);
  });

  it("has NO page list — a raw kind pages through nothing", () => {
    expect(rawVersionMeta(file, version).pages).toEqual([]);
  });

  it("nulls pxPerMm — there is no note geometry to place text against", () => {
    expect(rawVersionMeta(file, version).pxPerMm).toBeNull();
  });

  it("works for a .txt and an image just the same (identity + version md5)", () => {
    const txt = rawVersionMeta({ id: "177", name: "readme", fileType: "txt" }, version);
    expect(txt.fileType).toBe("txt");
    expect(txt.fileHash).toBe("d".repeat(32));
    const png = rawVersionMeta({ id: "173", name: "Screenshot", fileType: "png" }, version);
    expect(png.fileType).toBe("png");
    expect(png.pages).toEqual([]);
  });
});

// While a preview is armed, page text comes from the per-version transcript route.
describe("createHistoryScope wrap — getPageText reroute", () => {
  const page: PageRef = { index: 4, hash: "h4", width: 1404, height: 1872, textHash: "t4" };
  const versionText: PageText = { text: "the version's own transcript", words: [{ text: "v", xMm: 1, yMm: 2, wMm: 3, hMm: 4 }] };
  const liveText: PageText = { text: "the CURRENT transcript", words: [{ text: "c", xMm: 5, yMm: 6, wMm: 7, hMm: 8 }] };

  function stubApi() {
    const historyPageText = vi.fn(async (): Promise<PageText> => versionText);
    const getPageText = vi.fn(async (): Promise<PageText> => liveText);
    const api = { historyPageText, getPageText } as unknown as Api;
    return { api, historyPageText, getPageText };
  }

  it("routes to historyPageText (md5 + page index) for the previewed note, NOT the empty stub", async () => {
    const { api, historyPageText, getPageText } = stubApi();
    const scope = createHistoryScope();
    scope.setActive("n1", "ver-md5");
    const wrapped = scope.wrap(api);

    const got = await wrapped.getPageText("n1", page);
    expect(got).toEqual(versionText);
    expect(historyPageText).toHaveBeenCalledWith("n1", "ver-md5", 4);
    expect(getPageText).not.toHaveBeenCalled();
  });

  it("stays LIVE for a different note while a preview is up (a background poll)", async () => {
    const { api, historyPageText, getPageText } = stubApi();
    const scope = createHistoryScope();
    scope.setActive("n1", "ver-md5");
    const wrapped = scope.wrap(api);

    const got = await wrapped.getPageText("n2", page);
    expect(got).toEqual(liveText);
    expect(getPageText).toHaveBeenCalledWith("n2", page);
    expect(historyPageText).not.toHaveBeenCalled();
  });

  it("stays LIVE for the same note once the preview is cleared", async () => {
    const { api, historyPageText, getPageText } = stubApi();
    const scope = createHistoryScope();
    scope.setActive("n1", "ver-md5");
    const wrapped = scope.wrap(api);
    scope.clear();

    const got = await wrapped.getPageText("n1", page);
    expect(got).toEqual(liveText);
    expect(getPageText).toHaveBeenCalledWith("n1", page);
    expect(historyPageText).not.toHaveBeenCalled();
  });
});

// No search reroute: search is keyed by md5 and `versionMeta` rewrites `fileHash`.
// Stated against a hypothetical search member, so any spelling of a reroute fails.
describe("createHistoryScope — the search reroute is gone", () => {
  it("wraps NOTHING whose name is about searching", () => {
    const api = {
      searchAnything: vi.fn(),
      historySearchAnything: vi.fn(),
      getPageText: vi.fn(),
    } as unknown as Api;

    const scope = createHistoryScope();
    scope.setActive("n1", "ver-md5");
    const wrapped = scope.wrap(api);

    const source = api as unknown as Record<string, unknown>;
    const seen = wrapped as unknown as Record<string, unknown>;
    for (const name of new Set([...Object.keys(source), ...Object.keys(seen)])) {
      if (!/search/i.test(name)) continue;
      expect(seen[name]).toBe(source[name]);
    }
    expect(wrapped.getPageText).not.toBe(api.getPageText);
  });

  it("versionMeta re-keys fileHash to the version's md5, which IS the search scope", () => {
    const live: NoteMeta = {
      id: "n1",
      name: "notes",
      fileType: "note",
      fileHash: "a".repeat(32),
      annotationsId: null,
      pages: [{ index: 0, hash: "h0", width: 1404, height: 1872, textHash: "t0", linksHash: "l0", sourcePage: null, layers: null }],
      size: 1024,
      pxPerMm: 8,
    };
    const version = "e".repeat(32);
    expect(versionMeta(live, version).fileHash).toBe(version);
    expect(versionMeta(live, version).pages[0]!.textHash).toBe("t0");
  });
});
