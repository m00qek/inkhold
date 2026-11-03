import { describe, it, expect, vi, afterEach } from "vitest";
import { createHttpApi, ApiError } from "../../src/api/client";
import type { Listing, NoteMeta, PageRef } from "../../src/core/types";

// The browse `Api` with a stubbed `fetch`: raw JSON, binary pages, `ApiError`.
import { jsonResponse, recordingFetch } from "./httpApi.shared";

afterEach(() => vi.unstubAllGlobals());

function binaryResponse(bytes: Uint8Array, init: { status?: number } = {}): Response {
  return new Response(bytes, {
    status: init.status ?? 200,
    headers: { "content-type": "application/octet-stream" },
  });
}

const LISTING: Listing = {
  folderId: null,
  path: [],
  entries: [
    { kind: "folder", id: "9", name: "Work" },
    {
      kind: "note",
      id: "7",
      name: "Ideas",
      pageCount: 2,
      updatedAt: 1_700_000_000_000,
      fileType: "note",
      fileHash: "f".repeat(32),
      hasRecognizedText: true,
      firstPage: { index: 0, hash: "a".repeat(32), width: 1404, height: 1872, textHash: null },
    },
  ],
  syncVersion: 4,
};

type NoteEntry = Extract<(typeof LISTING.entries)[number], { kind: "note" }>;

const NOTE_ENTRY = LISTING.entries[1] as NoteEntry;

function firstNote(listing: Listing): NoteEntry {
  const entry = listing.entries.find((e) => e.kind === "note");
  if (!entry || entry.kind !== "note") throw new Error("no note entry in listing");
  return entry;
}

/** A listing whose note entry has had `keys` stripped, i.e. the real wire shape. */
function listingWithout(...keys: (keyof NoteEntry)[]): unknown {
  const wireNote: Record<string, unknown> = { ...NOTE_ENTRY };
  for (const k of keys) delete wireNote[k as string];
  for (const k of keys) expect(k in wireNote).toBe(false);
  return { ...LISTING, entries: [LISTING.entries[0], wireNote] };
}

const NOTE_META: NoteMeta = {
  id: "7",
  name: "Ideas",
  pages: [
    { index: 0, hash: "a".repeat(32), width: 1404, height: 1872, textHash: "t".repeat(32) },
    { index: 1, hash: "b".repeat(32), width: 1404, height: 1872, textHash: null },
  ],
  fileType: "note",
  fileHash: "f".repeat(32),
  size: 240_000,
};

/** `NOTE_META` with `keys` stripped, i.e. an older/partial wire shape. */
function noteMetaWithout(...keys: (keyof NoteMeta)[]): unknown {
  const wire: Record<string, unknown> = { ...NOTE_META };
  for (const k of keys) delete wire[k as string];
  for (const k of keys) expect(k in wire).toBe(false);
  return wire;
}

describe("createHttpApi", () => {
  describe("listFolder", () => {
    it("GETs /api/controlplane/tree with no parent for the root and returns the raw Listing", async () => {
      const { fn, calls } = recordingFetch(() => jsonResponse(LISTING));
      vi.stubGlobal("fetch", fn);

      const listing = await createHttpApi().listFolder(null);
      expect(calls[0]).toContain("/api/controlplane/tree");
      expect(calls[0]).not.toContain("parent=");
      expect(listing.syncVersion).toBe(4);
      expect(listing.entries).toHaveLength(2);
      expect(listing.entries[1]).toMatchObject({ kind: "note", id: "7" });
    });

    // The server omits null optionals (`emit_null_optional_fields = false`); the fake
    // `Api` returns `null`, so these must run against the real client.
    it("normalizes an OMITTED folderId to null for the root listing", async () => {
      const { folderId: _omitted, ...rootWithoutFolderId } = LISTING;
      expect("folderId" in rootWithoutFolderId).toBe(false);
      vi.stubGlobal("fetch", recordingFetch(() => jsonResponse(rootWithoutFolderId)).fn);

      const listing = await createHttpApi().listFolder(null);
      // Not just falsy: `library.ts` tests the root with `=== null`.
      expect(listing.folderId).toBeNull();
    });

    it("preserves a present folderId", async () => {
      vi.stubGlobal("fetch", recordingFetch(() => jsonResponse({ ...LISTING, folderId: "9" })).fn);
      expect((await createHttpApi().listFolder("9")).folderId).toBe("9");
    });

    it("passes ?parent={id} for a subfolder", async () => {
      const { fn, calls } = recordingFetch(() => jsonResponse({ ...LISTING, folderId: "9" }));
      vi.stubGlobal("fetch", fn);

      await createHttpApi().listFolder("9");
      expect(calls[0]).toContain("/api/controlplane/tree?parent=9");
    });

    // Absent optionals arrive `undefined`; un-normalized, the badge prints "undefined".
    describe("fileType / hasRecognizedText (absent on today's backend)", () => {
      it("derives an OMITTED fileType from the note's filename extension", async () => {
        const wire = listingWithout("fileType");
        (wire as { entries: { name: string }[] }).entries[1]!.name = "Apartment lease.PDF";
        vi.stubGlobal("fetch", recordingFetch(() => jsonResponse(wire)).fn);

        expect(firstNote(await createHttpApi().listFolder(null)).fileType).toBe("pdf");
      });

      it("falls back to the neutral 'file' for a name with no extension", async () => {
        const wire = listingWithout("fileType");
        (wire as { entries: { name: string }[] }).entries[1]!.name = "Weekly review";
        vi.stubGlobal("fetch", recordingFetch(() => jsonResponse(wire)).fn);

        expect(firstNote(await createHttpApi().listFolder(null)).fileType).toBe("file");
      });

      it("falls back to 'file' for a dotfile — the dot is not an extension there", async () => {
        const wire = listingWithout("fileType");
        (wire as { entries: { name: string }[] }).entries[1]!.name = ".hidden";
        vi.stubGlobal("fetch", recordingFetch(() => jsonResponse(wire)).fn);

        expect(firstNote(await createHttpApi().listFolder(null)).fileType).toBe("file");
      });

      it("normalizes an OMITTED hasRecognizedText to false, so no marker rather than a wrong one", async () => {
        vi.stubGlobal("fetch", recordingFetch(() => jsonResponse(listingWithout("hasRecognizedText"))).fn);

        expect(firstNote(await createHttpApi().listFolder(null)).hasRecognizedText).toBe(false);
      });

      it("passes both fields through when the backend does send them", async () => {
        vi.stubGlobal(
          "fetch",
          recordingFetch(() =>
            jsonResponse({
              ...LISTING,
              // The server verifies the blob, so the sniffed type beats the name.
              entries: [LISTING.entries[0], { ...NOTE_ENTRY, name: "Ideas.pdf", fileType: "note", hasRecognizedText: true }],
            }),
          ).fn,
        );

        const note = firstNote(await createHttpApi().listFolder(null));
        expect(note.fileType).toBe("note");
        expect(note.hasRecognizedText).toBe(true);
      });

      // The route requires `?v=`; `undefined` would build `?v=undefined` and 404.
      it("normalizes an OMITTED fileHash to null", async () => {
        vi.stubGlobal("fetch", recordingFetch(() => jsonResponse(listingWithout("fileHash"))).fn);
        expect(firstNote(await createHttpApi().listFolder(null)).fileHash).toBeNull();
      });

      it("passes a present fileHash through untouched", async () => {
        vi.stubGlobal("fetch", recordingFetch(() => jsonResponse(LISTING)).fn);
        expect(firstNote(await createHttpApi().listFolder(null)).fileHash).toBe("f".repeat(32));
      });

      it("preserves a present hasRecognizedText:false against the same default", async () => {
        vi.stubGlobal(
          "fetch",
          recordingFetch(() => jsonResponse({ ...LISTING, entries: [LISTING.entries[0], { ...NOTE_ENTRY, hasRecognizedText: false }] })).fn,
        );
        expect(firstNote(await createHttpApi().listFolder(null)).hasRecognizedText).toBe(false);
      });
    });

    // Consumed as a CSS `aspect-ratio`, where NaN/0 silently disables the property.
    describe("thumbAspect (absent on most entries)", () => {
      const withAspect = (thumbAspect: unknown): unknown => ({
        ...LISTING,
        entries: [LISTING.entries[0], { ...NOTE_ENTRY, thumbAspect }],
      });

      it("passes a valid pair through untouched", async () => {
        vi.stubGlobal("fetch", recordingFetch(() => jsonResponse(withAspect({ w: 1872, h: 1404 }))).fn);
        expect(firstNote(await createHttpApi().listFolder(null)).thumbAspect).toEqual({ w: 1872, h: 1404 });
      });

      it("normalizes an OMITTED thumbAspect to undefined (unknown, not square)", async () => {
        vi.stubGlobal("fetch", recordingFetch(() => jsonResponse(listingWithout("thumbAspect"))).fn);
        expect(firstNote(await createHttpApi().listFolder(null)).thumbAspect).toBeUndefined();
      });

      for (const [label, bad] of [
        ["a zero dimension", { w: 0, h: 160 }],
        ["a negative dimension", { w: 120, h: -160 }],
        ["a non-numeric dimension", { w: "120", h: 160 }],
        ["a half-missing pair", { w: 120 }],
        ["a non-finite dimension", { w: Infinity, h: 160 }],
        ["a null", null],
      ] as const) {
        it(`degrades ${label} to undefined rather than to a broken ratio`, async () => {
          vi.stubGlobal("fetch", recordingFetch(() => jsonResponse(withAspect(bad))).fn);
          expect(firstNote(await createHttpApi().listFolder(null)).thumbAspect).toBeUndefined();
        });
      }
    });

    it("maps a router 401 to an UNAUTHORIZED ApiError", async () => {
      vi.stubGlobal("fetch", recordingFetch(() => jsonResponse({ success: false }, { status: 401 })).fn);
      const err = await createHttpApi().listFolder(null).catch((e) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect(err.code).toBe("UNAUTHORIZED");
    });
  });

  describe("getNoteMeta", () => {
    it("GETs /api/controlplane/file/metadata/{id} and returns the raw NoteMeta", async () => {
      const { fn, calls } = recordingFetch(() => jsonResponse(NOTE_META));
      vi.stubGlobal("fetch", fn);

      const meta = await createHttpApi().getNoteMeta("7");
      expect(calls[0]).toContain("/api/controlplane/file/metadata/7");
      expect(meta.pages).toHaveLength(2);
      expect(meta.pages[1]?.hash).toBe("b".repeat(32));
    });

    // The wire omits `textHash`; `undefined` would enable the toggle and fetch nothing.
    it("normalizes an OMITTED per-page textHash to null (real mode against today's backend)", async () => {
      const wirePages = NOTE_META.pages.map(({ textHash: _omitted, ...rest }) => rest);
      expect(wirePages.every((p) => !("textHash" in p))).toBe(true);
      vi.stubGlobal("fetch", recordingFetch(() => jsonResponse({ ...NOTE_META, pages: wirePages })).fn);

      const meta = await createHttpApi().getNoteMeta("7");
      expect(meta.pages.map((p) => p.textHash)).toEqual([null, null]);
    });

    it("preserves a present textHash", async () => {
      vi.stubGlobal("fetch", recordingFetch(() => jsonResponse(NOTE_META)).fn);
      const meta = await createHttpApi().getNoteMeta("7");
      expect(meta.pages[0]?.textHash).toBe("t".repeat(32));
      expect(meta.pages[1]?.textHash).toBeNull();
    });

    it("normalizes an omitted textHash on a listing's firstPage too", async () => {
      const noteEntry = LISTING.entries[1] as Extract<(typeof LISTING.entries)[number], { kind: "note" }>;
      const { textHash: _omitted, ...wireFirstPage } = noteEntry.firstPage;
      const wire = { ...LISTING, entries: [LISTING.entries[0], { ...noteEntry, firstPage: wireFirstPage }] };
      vi.stubGlobal("fetch", recordingFetch(() => jsonResponse(wire)).fn);

      const listing = await createHttpApi().listFolder(null);
      const entry = listing.entries[1];
      expect(entry?.kind).toBe("note");
      if (entry?.kind === "note") expect(entry.firstPage.textHash).toBeNull();
    });

    describe("fileType / fileHash / size", () => {
      it("passes the server's verified values through", async () => {
        vi.stubGlobal("fetch", recordingFetch(() => jsonResponse(NOTE_META)).fn);
        const meta = await createHttpApi().getNoteMeta("7");
        expect(meta.fileType).toBe("note");
        expect(meta.fileHash).toBe("f".repeat(32));
        expect(meta.size).toBe(240_000);
      });

      it("derives an omitted fileType from the name instead of assuming 'note'", async () => {
        const wire = noteMetaWithout("fileType") as { name: string };
        wire.name = "20260719_165902_Page_1.PNG";
        vi.stubGlobal("fetch", recordingFetch(() => jsonResponse(wire)).fn);

        const meta = await createHttpApi().getNoteMeta("7");
        expect(meta.fileType).toBe("png");
      });

      it("normalizes an omitted fileHash to null and an omitted size to 0", async () => {
        vi.stubGlobal("fetch", recordingFetch(() => jsonResponse(noteMetaWithout("fileHash", "size"))).fn);
        const meta = await createHttpApi().getNoteMeta("7");
        expect(meta.fileHash).toBeNull();
        expect(meta.size).toBe(0);
      });
    });

    it("maps the server's not-found envelope to an ApiError", async () => {
      vi.stubGlobal(
        "fetch",
        recordingFetch(() => jsonResponse({ success: false, errorCode: "NOT_FOUND", errorMsg: "no such note" }, { status: 404 })).fn,
      );
      const err = await createHttpApi().getNoteMeta("999").catch((e) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect(err.code).toBe("NOT_FOUND");
      expect(err.status).toBe(404);
    });
  });

  describe("getPageBytes", () => {
    const page: PageRef = { index: 3, hash: "c".repeat(32), width: 1404, height: 1872, textHash: null };

    it("GETs the versioned /note/{id}/page/{index}?v={hash} URL and returns bytes", async () => {
      const payload = new Uint8Array([0x53, 0x4e, 0x50, 0x47, 1, 1, 2, 3]);
      const { fn, calls } = recordingFetch(() => binaryResponse(payload));
      vi.stubGlobal("fetch", fn);

      const buf = await createHttpApi().getPageBytes("7", page);
      expect(calls[0]).toContain("/note/7/page/3?v=" + "c".repeat(32));
      expect(new Uint8Array(buf)).toEqual(payload);
    });

    it("maps a stale-version 404 to a STALE_PAGE ApiError", async () => {
      vi.stubGlobal("fetch", recordingFetch(() => binaryResponse(new Uint8Array(), { status: 404 })).fn);
      const err = await createHttpApi().getPageBytes("7", page).catch((e) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect(err.code).toBe("STALE_PAGE");
      expect(err.status).toBe(404);
    });

    it("maps a network throw to a NETWORK ApiError", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new TypeError("connection refused");
        }),
      );
      const err = await createHttpApi().getPageBytes("7", page).catch((e) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect(err.code).toBe("NETWORK");
    });
  });

  describe("getPageText", () => {
    const recognized = (textHash: string | null): PageRef => ({
      index: 3,
      hash: "c".repeat(32),
      width: 1404,
      height: 1872,
      textHash,
    });

    it("GETs /note/{id}/page/{index}/text?v={textHash} and returns the transcript", async () => {
      const { fn, calls } = recordingFetch(() => jsonResponse({ text: "first line\nsecond line" }));
      vi.stubGlobal("fetch", fn);

      const got = await createHttpApi().getPageText("7", recognized("t".repeat(32)));
      expect(calls[0]).toBe("/note/7/page/3/text?v=" + "t".repeat(32));
      expect(got.text).toBe("first line\nsecond line");
    });

    // Regression guard: the transcript URL is immutable, so it must key on the
    // recognition hash; recognition adds RECOGNTEXT without changing the stroke `hash`.
    it("changes the fetch URL when textHash changes, even though the page hash does not", async () => {
      const { fn, calls } = recordingFetch(() => jsonResponse({ text: "hi" }));
      vi.stubGlobal("fetch", fn);

      const before = recognized("1".repeat(32));
      const after = recognized("2".repeat(32));
      expect(before.hash).toBe(after.hash);

      const client = createHttpApi();
      await client.getPageText("7", before);
      await client.getPageText("7", after);

      expect(calls[0]).not.toBe(calls[1]);
      expect(calls[0]).toContain("v=" + "1".repeat(32));
      expect(calls[1]).toContain("v=" + "2".repeat(32));
    });

    it("returns '' WITHOUT a request when the page has no recognition", async () => {
      const { fn, calls } = recordingFetch(() => jsonResponse({ text: "should never be read" }));
      vi.stubGlobal("fetch", fn);

      expect(await createHttpApi().getPageText("7", recognized(null))).toEqual({ text: "", words: [] });
      expect(calls).toHaveLength(0);
    });

    it("treats an omitted `text` field as the empty transcript", async () => {
      vi.stubGlobal("fetch", recordingFetch(() => jsonResponse({})).fn);
      expect(await createHttpApi().getPageText("7", recognized("t".repeat(32)))).toEqual({
        text: "",
        words: [],
      });
    });

    // Word boxes are millimetres, passed through unscaled (the scale is per device).
    it("carries word boxes through verbatim, in millimetres", async () => {
      const words = [
        { text: "alpha", xMm: 10.5, yMm: 20.25, wMm: 30.5, hMm: 8.125 },
        { text: "beta", xMm: 40, yMm: 100, wMm: 20, hMm: 9 },
      ];
      vi.stubGlobal("fetch", recordingFetch(() => jsonResponse({ text: "alpha beta", words })).fn);

      const got = await createHttpApi().getPageText("7", recognized("t".repeat(32)));
      expect(got.words).toEqual(words);
    });

    // Device-authored: a malformed box is dropped rather than become a NaN in a PDF.
    it("drops malformed word boxes instead of emitting NaN coordinates", async () => {
      vi.stubGlobal(
        "fetch",
        recordingFetch(() =>
          jsonResponse({
            text: "ok",
            words: [
              { text: "good", xMm: 1, yMm: 2, wMm: 3, hMm: 4 },
              { text: "bad", xMm: "1", yMm: 2, wMm: 3, hMm: 4 },
              { text: "nan", xMm: 1, yMm: Number.NaN, wMm: 3, hMm: 4 },
              { xMm: 1, yMm: 2, wMm: 3, hMm: 4 },
            ],
          }),
        ).fn,
      );

      const got = await createHttpApi().getPageText("7", recognized("t".repeat(32)));
      expect(got.words).toEqual([{ text: "good", xMm: 1, yMm: 2, wMm: 3, hMm: 4 }]);
    });

    it("maps a stale-version 404 to a STALE_PAGE ApiError", async () => {
      vi.stubGlobal("fetch", recordingFetch(() => jsonResponse({}, { status: 404 })).fn);
      const err = await createHttpApi().getPageText("7", recognized("t".repeat(32))).catch((e) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect(err.code).toBe("STALE_PAGE");
    });

    it("maps a 401 to UNAUTHORIZED so a dead session reaches the shell", async () => {
      vi.stubGlobal("fetch", recordingFetch(() => jsonResponse({ success: false }, { status: 401 })).fn);
      const err = await createHttpApi().getPageText("7", recognized("t".repeat(32))).catch((e) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect(err.code).toBe("UNAUTHORIZED");
    });

    it("maps a network throw to a NETWORK ApiError", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new TypeError("connection refused");
        }),
      );
      const err = await createHttpApi().getPageText("7", recognized("t".repeat(32))).catch((e) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect(err.code).toBe("NETWORK");
    });
  });
});
