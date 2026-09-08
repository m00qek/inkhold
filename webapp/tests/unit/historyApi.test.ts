import { describe, it, expect, vi, afterEach } from "vitest";
import { createHttpApi, ApiError } from "../../src/api/client";

// The history read + restore endpoints over the real control-plane, with a
// stubbed `fetch`. Same discipline as httpApi.test.ts: raw VOs (no `{success}`
// envelope), binary page bytes, errors round-trip as `ApiError`, and the seam
// normalizes the `emit_null_optional_fields = false` omissions.

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

function recordingFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: string[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

afterEach(() => vi.restoreAllMocks());

describe("noteHistory", () => {
  it("maps versions newest-first, flags current, carries pageCount, and DROPS a row with no md5", async () => {
    const { fn, calls } = recordingFetch(() =>
      jsonResponse({
        id: "n1",
        versions: [
          { md5: "aaa", size: 900, createdAt: 1_752_800_000_000, current: true, pageCount: 17 },
          { md5: "bbb", size: 800, createdAt: 1_752_600_000_000 }, // current + pageCount omitted → retained, 0
          { size: 700, createdAt: 1 }, // no md5 → dropped (addresses nothing)
        ],
      }),
    );
    vi.stubGlobal("fetch", fn);
    const api = createHttpApi();
    const h = await api.noteHistory("n1");
    expect(calls[0]).toContain("/api/controlplane/note/n1/history");
    expect(h.id).toBe("n1");
    // An omitted `pageCount` normalizes to 0 (the "no pages to count" reading the
    // content signal falls back to byte size for).
    expect(h.versions).toEqual([
      { md5: "aaa", size: 900, createdAt: 1_752_800_000_000, current: true, pageCount: 17 },
      { md5: "bbb", size: 800, createdAt: 1_752_600_000_000, current: false, pageCount: 0 },
    ]);
  });

  it("does NOT re-sort — the server's newest-first order is preserved verbatim", async () => {
    const { fn } = recordingFetch(() =>
      jsonResponse({
        id: "n1",
        // A restored version can tie the displaced one on createdAt; re-sorting
        // would reorder them and lie about which is live.
        versions: [
          { md5: "restored", size: 1, createdAt: 100, current: true },
          { md5: "displaced", size: 1, createdAt: 100 },
        ],
      }),
    );
    vi.stubGlobal("fetch", fn);
    const h = await createHttpApi().noteHistory("n1");
    expect(h.versions.map((v) => v.md5)).toEqual(["restored", "displaced"]);
  });
});

describe("historyMeta", () => {
  it("hits the per-version meta route and returns the VERSION's own page list", async () => {
    // The version has THREE pages — a DIFFERENT count than a current note might
    // have — proving the seam carries the version's real geometry, not the live
    // note's. `fileHash` is the version md5.
    const { fn, calls } = recordingFetch(() =>
      jsonResponse({
        id: "n1",
        name: "Notebook",
        fileType: "note",
        fileHash: "ver-md5",
        size: 4242,
        pages: [
          { index: 0, hash: "h0", width: 1404, height: 1872, textHash: "t0" },
          { index: 1, hash: "h1", width: 1404, height: 1872 },
          { index: 2, hash: "h2", width: 1404, height: 1872 },
        ],
      }),
    );
    vi.stubGlobal("fetch", fn);
    const meta = await createHttpApi().historyMeta("n1", "ver-md5");
    expect(calls[0]).toBe("/api/controlplane/note/n1/history/ver-md5/meta");
    expect(meta.fileHash).toBe("ver-md5");
    expect(meta.pages).toHaveLength(3);
    expect(meta.pages.map((p) => p.index)).toEqual([0, 1, 2]);
    // Normalized like `getNoteMeta`: an omitted `textHash` becomes null.
    expect(meta.pages[0]!.textHash).toBe("t0");
    expect(meta.pages[1]!.textHash).toBeNull();
  });

  it("normalizes an omitted pxPerMm / fileHash to null, like getNoteMeta", async () => {
    const { fn } = recordingFetch(() =>
      jsonResponse({ id: "n1", name: "N", pages: [{ index: 0, hash: "h", width: 1, height: 1 }] }),
    );
    vi.stubGlobal("fetch", fn);
    const meta = await createHttpApi().historyMeta("n1", "md5");
    expect(meta.pxPerMm).toBeNull();
    expect(meta.fileHash).toBeNull();
  });
});

describe("historyPageBytes", () => {
  it("hits the per-version page route with NO ?v= (the md5 pins the blob)", async () => {
    const { fn, calls } = recordingFetch(() => new Response(new Uint8Array([1, 2, 3])));
    vi.stubGlobal("fetch", fn);
    const buf = await createHttpApi().historyPageBytes("n1", "abc123", 4);
    expect(new Uint8Array(buf)).toEqual(new Uint8Array([1, 2, 3]));
    expect(calls[0]).toBe("/api/controlplane/note/n1/history/abc123/page/4");
    expect(calls[0]).not.toContain("?v=");
  });
});

describe("historyPageText", () => {
  it("GETs the per-version text route with NO ?v= and returns the transcript + words", async () => {
    const words = [{ text: "alpha", xMm: 1, yMm: 2, wMm: 3, hMm: 4 }];
    const { fn, calls } = recordingFetch(() => jsonResponse({ text: "alpha beta", words }));
    vi.stubGlobal("fetch", fn);
    const got = await createHttpApi().historyPageText("n1", "abc123", 4);
    // The `:md5` pins the immutable version, so — unlike the live text route — the
    // URL carries no `?v={textHash}`.
    expect(calls[0]).toBe("/api/controlplane/note/n1/history/abc123/page/4/text");
    expect(calls[0]).not.toContain("?v=");
    expect(got).toEqual({ text: "alpha beta", words });
  });

  it("normalizes exactly like getPageText: absent text/words → empty, malformed words dropped", async () => {
    const { fn } = recordingFetch(() =>
      jsonResponse({
        words: [
          { text: "good", xMm: 1, yMm: 2, wMm: 3, hMm: 4 },
          { text: "bad", xMm: Number.NaN, yMm: 2, wMm: 3, hMm: 4 }, // NaN coord → dropped
        ],
      }),
    );
    vi.stubGlobal("fetch", fn);
    const got = await createHttpApi().historyPageText("n1", "abc123", 0);
    expect(got.text).toBe("");
    expect(got.words).toEqual([{ text: "good", xMm: 1, yMm: 2, wMm: 3, hMm: 4 }]);
  });

  it("surfaces a 404 as STALE_PAGE (rawFetch, like getPageText)", async () => {
    const { fn } = recordingFetch(() => new Response("nope", { status: 404 }));
    vi.stubGlobal("fetch", fn);
    const err = await createHttpApi().historyPageText("n1", "abc123", 0).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("STALE_PAGE");
  });
});

describe("historyRaw", () => {
  it("hits the per-version RAW route with NO ?v= (the md5 pins the blob)", async () => {
    const { fn, calls } = recordingFetch(() => new Response(new Uint8Array([9, 8, 7])));
    vi.stubGlobal("fetch", fn);
    const buf = await createHttpApi().historyRaw("n1", "abc123");
    expect(new Uint8Array(buf)).toEqual(new Uint8Array([9, 8, 7]));
    expect(calls[0]).toBe("/api/controlplane/note/n1/history/abc123/raw");
    expect(calls[0]).not.toContain("?v=");
  });
});

describe("restoreVersion", () => {
  it("POSTs the restore route and returns the new current version", async () => {
    const { fn, calls } = recordingFetch((_url, init) => {
      expect(init?.method).toBe("POST");
      return jsonResponse({ md5: "abc", size: 1234, createdAt: 1_752_900_000_000, current: true });
    });
    vi.stubGlobal("fetch", fn);
    const r = await createHttpApi().restoreVersion("n1", "abc");
    expect(calls[0]).toBe("/api/controlplane/note/n1/history/abc/restore");
    expect(r).toEqual({ md5: "abc", size: 1234, createdAt: 1_752_900_000_000, current: true });
  });

  it("surfaces a 507 (over quota) as a QUOTA_EXCEEDED ApiError", async () => {
    const { fn } = recordingFetch(() =>
      jsonResponse({ success: false, errorCode: "QUOTA_EXCEEDED", errorMsg: "over quota" }, { status: 507 }),
    );
    vi.stubGlobal("fetch", fn);
    await expect(createHttpApi().restoreVersion("n1", "abc")).rejects.toMatchObject({
      name: "ApiError",
      status: 507,
    });
  });

  it("falls back to the requested md5 when the server omits it", async () => {
    const { fn } = recordingFetch(() => jsonResponse({ size: 1, createdAt: 2, current: true }));
    vi.stubGlobal("fetch", fn);
    const r = await createHttpApi().restoreVersion("n1", "req-md5");
    expect(r.md5).toBe("req-md5");
    // Belt-and-braces: the error class is importable for callers that switch on it.
    expect(ApiError).toBeTypeOf("function");
  });
});
