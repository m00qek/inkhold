import { describe, it, expect, vi } from "vitest";
import { createHistoryScope, rawVersionMeta } from "../../src/pages/historyScope";
import type { Api } from "../../src/api/types";
import type { PageRef, PageText } from "../../src/core/types";

// The minimal preview meta the RAW-based history viewers (.spd/.txt/image) open
// with. Unlike the `.note` path (versionMeta, which reroutes a page list), these
// kinds render client-side from the whole raw blob, so the meta carries no pages
// and never needs `historyMeta` — only the file's identity plus the VERSION's md5
// (as fileHash) and size, which is what the raw address is minted from.
describe("rawVersionMeta", () => {
  const file = { id: "n-files-sketch", name: "Kitchen sketch", fileType: "spd" };
  const version = { md5: "d".repeat(32), size: 4096, createdAt: 1_752_000_000_000 };

  it("carries the file's identity and the VERSION's md5 as fileHash", () => {
    const meta = rawVersionMeta(file, version);
    expect(meta.id).toBe("n-files-sketch");
    expect(meta.name).toBe("Kitchen sketch");
    expect(meta.fileType).toBe("spd");
    // The version's own content address — what `historyFileUrl` and the raw fetch
    // key on, NOT the live file's current hash.
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
    const txt = rawVersionMeta({ id: "n-files-readme", name: "readme", fileType: "txt" }, version);
    expect(txt.fileType).toBe("txt");
    expect(txt.fileHash).toBe("d".repeat(32));
    const png = rawVersionMeta({ id: "n-files-shot", name: "Screenshot", fileType: "png" }, version);
    expect(png.fileType).toBe("png");
    expect(png.pages).toEqual([]);
  });
});

// The `wrap` reroute: while a preview is armed for a note, page TEXT must come
// from the per-version transcript route (`historyPageText`), not the empty stub
// it used to answer — that one reroute is what lights up the reader's ovals,
// find-in-preview's word boxes and the exporter's PDF text layer for a version.
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
    expect(got).toEqual(versionText); // real transcript, not { text: "", words: [] }
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
