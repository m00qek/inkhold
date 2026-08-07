import { describe, it, expect, vi, afterEach } from "vitest";
import { createHttpApi, ApiError, dispatchApiFailure } from "../../src/api/client";
import type { Listing, NoteMeta, PageRef } from "../../src/core/types";

// The browse `Api` over the real control-plane endpoints, with a stubbed `fetch`.
// Mirrors client.test.ts: the web JSON is RAW (no `{success}` envelope), page
// bytes are BINARY, and errors round-trip as `ApiError`.

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

function binaryResponse(bytes: Uint8Array, init: { status?: number } = {}): Response {
  return new Response(bytes, {
    status: init.status ?? 200,
    headers: { "content-type": "application/octet-stream" },
  });
}

/** A fetch stub that records the URLs it was called with. */
function recordingFetch(handler: (url: string) => Response | Promise<Response>) {
  const calls: string[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    return handler(url);
  }) as unknown as typeof fetch;
  return { fn, calls };
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

/** The one note from a listing response, for the assertions below. */
function firstNote(listing: Listing): NoteEntry {
  const entry = listing.entries.find((e) => e.kind === "note");
  if (!entry || entry.kind !== "note") throw new Error("no note entry in listing");
  return entry;
}

/** A listing whose note entry has had `keys` stripped, i.e. the real wire shape. */
function listingWithout(...keys: (keyof NoteEntry)[]): unknown {
  const wireNote: Record<string, unknown> = { ...NOTE_ENTRY };
  for (const k of keys) delete wireNote[k as string];
  for (const k of keys) expect(k in wireNote).toBe(false); // the wire shape
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

afterEach(() => vi.unstubAllGlobals());

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

    // The server serializes with `emit_null_optional_fields = false`, so a null
    // optional field is OMITTED from the JSON rather than sent as `null`. These
    // must run against the REAL client: the fake `Api` returns a well-formed
    // `null`, which is exactly why this divergence survived unnoticed.
    it("normalizes an OMITTED folderId to null for the root listing", async () => {
      const { folderId: _omitted, ...rootWithoutFolderId } = LISTING;
      expect("folderId" in rootWithoutFolderId).toBe(false); // the wire shape
      vi.stubGlobal("fetch", recordingFetch(() => jsonResponse(rootWithoutFolderId)).fn);

      const listing = await createHttpApi().listFolder(null);
      // Not just falsy — `library.ts` tests the root with `=== null`.
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

    // The gallery badge is `fileType` and the OCR marker is `hasRecognizedText`.
    // NEITHER field exists on the backend yet, so today every note arrives
    // without them — and an absent optional is `undefined`, not a default. Left
    // un-normalized the badge renders the literal "undefined" and the marker is
    // shown on every card. Like the folderId/textHash cases above these MUST run
    // against the REAL client: the fake returns both fields well-formed, which is
    // exactly why this class of divergence survives unnoticed.
    describe("fileType / hasRecognizedText (absent on today's backend)", () => {
      it("derives an OMITTED fileType from the note's filename extension", async () => {
        const wire = listingWithout("fileType");
        (wire as { entries: { name: string }[] }).entries[1]!.name = "Apartment lease.PDF";
        vi.stubGlobal("fetch", recordingFetch(() => jsonResponse(wire)).fn);

        // Lowercased, dot stripped — never the literal "undefined", never "note".
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

        // Not merely falsy — library.ts renders the marker on the raw value.
        expect(firstNote(await createHttpApi().listFolder(null)).hasRecognizedText).toBe(false);
      });

      it("passes both fields through when the backend does send them", async () => {
        vi.stubGlobal(
          "fetch",
          recordingFetch(() =>
            jsonResponse({
              ...LISTING,
              // The server VERIFIES the blob, so a name that lies loses to the
              // sniffed type — the client must not re-derive over the top of it.
              entries: [LISTING.entries[0], { ...NOTE_ENTRY, name: "Ideas.pdf", fileType: "note", hasRecognizedText: true }],
            }),
          ).fn,
        );

        const note = firstNote(await createHttpApi().listFolder(null));
        expect(note.fileType).toBe("note");
        expect(note.hasRecognizedText).toBe(true);
      });

      // `fileHash` is what makes `/file/{id}?v=…` addressable at all. The route
      // REQUIRES the version, so an entry without a hash must yield no URL —
      // `undefined` here would build `?v=undefined` and 404 every preview.
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

    // The tile-shape fact the masonry lays out from (masonry.md decision 3).
    // ABSENT for most entries by design (only `.note`/`.spd` state a shape), and
    // the layout consumes it as a RATIO — so anything that cannot be a shape
    // must normalize to `undefined` (the CSS fallback), never reach
    // `aspect-ratio` as NaN/0, which silently disables the property.
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

    // `textHash` does not exist on the backend yet, so EVERY page arrives without
    // it today. This is the test the fake cannot substitute for: the fake returns
    // a well-formed `null`, while the wire omits the field entirely. If this
    // normalization regresses, real mode hands the reader `undefined` — truthy
    // enough to enable the toggle and fetch a transcript that isn't there.
    it("normalizes an OMITTED per-page textHash to null (real mode against today's backend)", async () => {
      const wirePages = NOTE_META.pages.map(({ textHash: _omitted, ...rest }) => rest);
      expect(wirePages.every((p) => !("textHash" in p))).toBe(true); // the wire shape
      vi.stubGlobal("fetch", recordingFetch(() => jsonResponse({ ...NOTE_META, pages: wirePages })).fn);

      const meta = await createHttpApi().getNoteMeta("7");
      // Not merely falsy — the reader tests recognition with `textHash === null`.
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

    // The reader branches on these three, and it is reached by ROUTE — a reload
    // of `#/note/:id` has nothing but the id, so they have to survive this call.
    describe("fileType / fileHash / size", () => {
      it("passes the server's verified values through", async () => {
        vi.stubGlobal("fetch", recordingFetch(() => jsonResponse(NOTE_META)).fn);
        const meta = await createHttpApi().getNoteMeta("7");
        expect(meta.fileType).toBe("note");
        expect(meta.fileHash).toBe("f".repeat(32));
        expect(meta.size).toBe(240_000);
      });

      // The dangerous default. An omitted `fileType` must NOT read as "note":
      // that is precisely what opens a PNG into a blank canvas.
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
      const payload = new Uint8Array([0x53, 0x4e, 0x50, 0x47, 1, 1, 2, 3]); // "SNPG"…
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
      hash: "c".repeat(32), // the STROKE hash — deliberately constant below
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

    // The cache-poisoning regression guard. The transcript URL is served
    // `immutable`, so it MUST be versioned by the recognition hash and not the
    // page content hash: running recognition on the device adds RECOGNTEXT while
    // leaving the strokes — and therefore `hash` — identical. If the key ever
    // reverts to `page.hash`, both requests below collapse onto one URL and the
    // year-cached pre-recognition empty body wins forever.
    it("changes the fetch URL when textHash changes, even though the page hash does not", async () => {
      const { fn, calls } = recordingFetch(() => jsonResponse({ text: "hi" }));
      vi.stubGlobal("fetch", fn);

      const before = recognized("1".repeat(32));
      const after = recognized("2".repeat(32));
      expect(before.hash).toBe(after.hash); // strokes unchanged

      const client = createHttpApi();
      await client.getPageText("7", before);
      await client.getPageText("7", after);

      expect(calls[0]).not.toBe(calls[1]);
      expect(calls[0]).toContain("v=" + "1".repeat(32));
      expect(calls[1]).toContain("v=" + "2".repeat(32));
    });

    // Real mode against TODAY's backend: no `textHash` on the wire → null → the
    // panel must resolve to "no recognized text" without ever hitting the network.
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

    // The word boxes ride on this same response. They are MILLIMETRES and are
    // passed through untouched — the client must not scale them, because the
    // scale is hardware-dependent and arrives separately on the note metadata.
    it("carries word boxes through verbatim, in millimetres", async () => {
      const words = [
        { text: "alpha", xMm: 10.5, yMm: 20.25, wMm: 30.5, hMm: 8.125 },
        { text: "beta", xMm: 40, yMm: 100, wMm: 20, hMm: 9 },
      ];
      vi.stubGlobal("fetch", recordingFetch(() => jsonResponse({ text: "alpha beta", words })).fn);

      const got = await createHttpApi().getPageText("7", recognized("t".repeat(32)));
      expect(got.words).toEqual(words);
    });

    // Device-authored values reaching a PDF generator: a malformed box has to be
    // dropped here rather than become a NaN coordinate in the content stream.
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

  // A `.note`'s OWN links — the rectangles a PDF used as a page's template
  // brought with it (`note-format.md` §14). The seam matters more than usual
  // here because two consumers read it: the reader's link layer and the PDF
  // exporter, both through this one call and one record shape.
  describe("getPageLinks", () => {
    const linked = (linksHash: string | null): PageRef => ({
      index: 3,
      hash: "c".repeat(32), // the STROKE hash — deliberately constant below
      width: 1404,
      height: 1872,
      textHash: null,
      linksHash,
    });

    it("GETs /note/{id}/page/{index}/links?v={linksHash} and returns the records", async () => {
      const links = [
        { x: 819, y: 614, w: 187, h: 28, page: -1, uri: "https://onplanners.com/x?a=1,2" },
        { x: 96, y: 1680, w: 420, h: 72, page: 11, uri: "none" },
      ];
      const { fn, calls } = recordingFetch(() => jsonResponse({ links }));
      vi.stubGlobal("fetch", fn);

      const got = await createHttpApi().getPageLinks("7", linked("l".repeat(32)));
      expect(calls[0]).toBe("/note/7/page/3/links?v=" + "l".repeat(32));
      expect(got.links).toEqual(links);
    });

    // The same cache-key guard the transcript has, for the same reason: a
    // re-imported template can change a page's links while leaving every stroke —
    // and therefore `hash` — identical. Keyed by `hash`, both requests would
    // collapse onto one URL.
    it("changes the fetch URL when linksHash changes, even though the page hash does not", async () => {
      const { fn, calls } = recordingFetch(() => jsonResponse({ links: [] }));
      vi.stubGlobal("fetch", fn);

      const before = linked("1".repeat(32));
      const after = linked("2".repeat(32));
      expect(before.hash).toBe(after.hash);

      const client = createHttpApi();
      await client.getPageLinks("7", before);
      await client.getPageLinks("7", after);

      expect(calls[0]).not.toBe(calls[1]);
      expect(calls[0]).toContain("v=" + "1".repeat(32));
      expect(calls[1]).toContain("v=" + "2".repeat(32));
    });

    // THE COMMON CASE BY A WIDE MARGIN, and the whole reason the hash rides on
    // the page list: a note that was not built on a PDF template has no page
    // with links, and the reader must not ask about a single one of them.
    it("returns no links WITHOUT a request when the page has no link block", async () => {
      const { fn, calls } = recordingFetch(() => jsonResponse({ links: [{ x: 1, y: 1, w: 1, h: 1, page: 0, uri: "none" }] }));
      vi.stubGlobal("fetch", fn);

      expect(await createHttpApi().getPageLinks("7", linked(null))).toEqual({ links: [] });
      expect(calls).toHaveLength(0);
    });

    it("treats an omitted `links` field as no links", async () => {
      vi.stubGlobal("fetch", recordingFetch(() => jsonResponse({})).fn);
      expect(await createHttpApi().getPageLinks("7", linked("l".repeat(32)))).toEqual({ links: [] });
    });

    // Device-authored values reaching the DOM as `href`s and a PDF as
    // annotations: a record that is not a record is dropped at the seam, by the
    // same validator the wasm decoder's payload goes through.
    it("drops malformed records rather than passing them to the layer", async () => {
      vi.stubGlobal(
        "fetch",
        recordingFetch(() =>
          jsonResponse({
            links: [
              { x: 1, y: 2, w: 3, h: 4, page: -1, uri: "https://ok.example/" },
              { x: 1, y: 2, w: 3, h: 4, page: -1 }, // no uri
              { x: 1, y: 2, w: 0, h: 4, page: -1, uri: "https://ok.example/" }, // empty rect
              { x: 1, y: 2, w: 3, h: 4, page: 1.5, uri: "https://ok.example/" }, // fractional target
              { x: "1", y: 2, w: 3, h: 4, page: -1, uri: "https://ok.example/" }, // not a number
            ],
          }),
        ).fn,
      );

      const got = await createHttpApi().getPageLinks("7", linked("l".repeat(32)));
      expect(got.links).toEqual([{ x: 1, y: 2, w: 3, h: 4, page: -1, uri: "https://ok.example/" }]);
    });

    it("maps a stale-version 404 to a STALE_PAGE ApiError, so the reader refetches its metadata", async () => {
      vi.stubGlobal("fetch", recordingFetch(() => jsonResponse({}, { status: 404 })).fn);
      const err = await createHttpApi().getPageLinks("7", linked("l".repeat(32))).catch((e) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect(err.code).toBe("STALE_PAGE");
    });

    it("maps a 401 to UNAUTHORIZED so a dead session reaches the shell", async () => {
      vi.stubGlobal("fetch", recordingFetch(() => jsonResponse({ success: false }, { status: 401 })).fn);
      const err = await createHttpApi().getPageLinks("7", linked("l".repeat(32))).catch((e) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect(err.code).toBe("UNAUTHORIZED");
    });
  });

  // The transcript search. Two things are load-bearing beyond plain mapping:
  // the blank-query short-circuit (search-as-you-type empties the box constantly,
  // and a request per emptying is pure waste), and the `snippet` field — the one
  // string in the app that reaches innerHTML, so a missing one must default to
  // "" rather than paint the literal text "undefined" as a transcript excerpt.
  describe("searchText", () => {
    const HIT = { noteId: "7", noteName: "Weekly review", pageIndex: 4, snippet: "the <mark>roadmap</mark> for Q3" };

    it("GETs /api/controlplane/search?q= and maps the hits", async () => {
      const { fn, calls } = recordingFetch(() => jsonResponse({ query: "roadmap", hits: [HIT] }));
      vi.stubGlobal("fetch", fn);

      const results = await createHttpApi().searchText("roadmap");
      expect(calls[0]).toContain("/api/controlplane/search?q=roadmap");
      expect(results.query).toBe("roadmap");
      expect(results.hits).toEqual([HIT]);
      // The markers survive the client untouched — re-escaping here is what would
      // put a literal `&lt;mark&gt;` on screen.
      expect(results.hits[0]?.snippet).toContain("<mark>");
    });

    it("percent-encodes the query and passes an explicit limit", async () => {
      const { fn, calls } = recordingFetch(() => jsonResponse({ query: "a b&c", hits: [] }));
      vi.stubGlobal("fetch", fn);

      await createHttpApi().searchText("a b&c", 5);
      // `&` inside the term must not become a second query parameter.
      expect(calls[0]).toContain("q=a+b%26c");
      expect(calls[0]).toContain("limit=5");
    });

    it("resolves a BLANK query to no hits WITHOUT a request", async () => {
      const { fn, calls } = recordingFetch(() => jsonResponse({ query: "", hits: [HIT] }));
      vi.stubGlobal("fetch", fn);

      const client = createHttpApi();
      const nothing = { query: "", hits: [], usedFuzzy: false, coverage: null };
      expect(await client.searchText("")).toEqual(nothing);
      // Whitespace is the same nothing — a box holding a space is an empty box.
      expect(await client.searchText("   ")).toEqual(nothing);
      expect(calls).toHaveLength(0);
    });

    // `emit_null_optional_fields = false` again: an absent field is `undefined`,
    // not a default. The fake returns every field well-formed, which is exactly
    // why this class of divergence has to be pinned against the REAL client.
    it("defaults an OMITTED snippet to '' rather than the string 'undefined'", async () => {
      const { snippet: _omitted, ...wireHit } = HIT;
      expect("snippet" in wireHit).toBe(false); // the wire shape
      vi.stubGlobal("fetch", recordingFetch(() => jsonResponse({ query: "q", hits: [wireHit] })).fn);

      const results = await createHttpApi().searchText("q");
      // Not merely falsy: this value is assigned to innerHTML.
      expect(results.hits[0]?.snippet).toBe("");
    });

    it("defaults an OMITTED pageIndex to 0, so the deep link is never /page/NaN", async () => {
      const { pageIndex: _omitted, ...wireHit } = HIT;
      vi.stubGlobal("fetch", recordingFetch(() => jsonResponse({ query: "q", hits: [wireHit] })).fn);

      expect((await createHttpApi().searchText("q")).hits[0]?.pageIndex).toBe(0);
    });

    it("treats an OMITTED hits array as the empty result set", async () => {
      vi.stubGlobal("fetch", recordingFetch(() => jsonResponse({ query: "q" })).fn);
      expect((await createHttpApi().searchText("q")).hits).toEqual([]);
    });

    it("echoes the sent query when the server omits it", async () => {
      vi.stubGlobal("fetch", recordingFetch(() => jsonResponse({ hits: [] })).fn);
      expect((await createHttpApi().searchText("  roadmap  ")).query).toBe("roadmap");
    });

    // `usedFuzzy` is the ONE field on this face the server promises never to
    // omit, precisely so the client can tell "the search was exact" from "the
    // server is too old to say" — opposite instructions about whether to warn
    // that the answer is only approximate.
    it("reads usedFuzzy strictly, so an absent flag never accuses the search of guessing", async () => {
      vi.stubGlobal("fetch", recordingFetch(() => jsonResponse({ query: "q", hits: [HIT], usedFuzzy: true })).fn);
      expect((await createHttpApi().searchText("q")).usedFuzzy).toBe(true);

      vi.stubGlobal("fetch", recordingFetch(() => jsonResponse({ query: "q", hits: [HIT] })).fn);
      expect((await createHttpApi().searchText("q")).usedFuzzy).toBe(false);
    });

    // Absent is NOT zero here. A fabricated `{notes: 0, unsearchable: 0}` renders
    // as the confident sentence "0 of your 0 notes have no recognised text" over
    // a library that has plenty.
    it("passes coverage through when present and reports NULL — never zeroes — when absent", async () => {
      vi.stubGlobal(
        "fetch",
        recordingFetch(() => jsonResponse({ query: "q", hits: [], coverage: { notes: 40, unsearchable: 12 } })).fn,
      );
      expect((await createHttpApi().searchText("q")).coverage).toEqual({ notes: 40, unsearchable: 12 });

      vi.stubGlobal("fetch", recordingFetch(() => jsonResponse({ query: "q", hits: [] })).fn);
      expect((await createHttpApi().searchText("q")).coverage).toBeNull();

      // Half a claim is not a claim.
      vi.stubGlobal("fetch", recordingFetch(() => jsonResponse({ query: "q", hits: [], coverage: { notes: 40 } })).fn);
      expect((await createHttpApi().searchText("q")).coverage).toBeNull();
    });

    // The bug class this whole seam exists to prevent: a dead session must not
    // arrive at the UI looking like a query nobody wrote about.
    it("maps a 401 to UNAUTHORIZED rather than an empty result set", async () => {
      vi.stubGlobal("fetch", recordingFetch(() => jsonResponse({ success: false }, { status: 401 })).fn);
      const err = await createHttpApi().searchText("roadmap").catch((e) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect(err.code).toBe("UNAUTHORIZED");
    });

    // `kind` names what `pageIndex` counts, and the server OMITS 0 (a note page).
    it("carries kind=1 for a .txt hit and leaves a note-page hit's kind ABSENT", async () => {
      vi.stubGlobal(
        "fetch",
        recordingFetch(() =>
          jsonResponse({
            query: "q",
            hits: [HIT, { noteId: "r", noteName: "readme", pageIndex: 2, snippet: "x", kind: 1 }],
          }),
        ).fn,
      );
      const hits = (await createHttpApi().searchText("q")).hits;
      // The note-page hit is byte-identical to before kinds existed: no key.
      expect("kind" in hits[0]!).toBe(false);
      // The .txt hit carries 1.
      expect(hits[1]!.kind).toBe(1);
    });

    // Tolerant by contract: anything that is not exactly 1 is a note page, so a
    // future kind the client does not know degrades to the reader, not a blank.
    it("reads a non-1 kind tolerantly as a note page (absent kind)", async () => {
      vi.stubGlobal(
        "fetch",
        recordingFetch(() => jsonResponse({ query: "q", hits: [{ ...HIT, kind: 7 }] })).fn,
      );
      expect("kind" in (await createHttpApi().searchText("q")).hits[0]!).toBe(false);
    });

    it("maps a network throw to a NETWORK ApiError", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new TypeError("connection refused");
        }),
      );
      const err = await createHttpApi().searchText("roadmap").catch((e) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect(err.code).toBe("NETWORK");
    });
  });
});

// The client's error taxonomy used to have no consumers — every view caught with
// a bare `catch {}`. This is the seam that gives UNAUTHORIZED/STALE_PAGE somewhere
// to go, so it's the thing to pin.
describe("dispatchApiFailure", () => {
  const page: PageRef = { index: 0, hash: "d".repeat(32), width: 1404, height: 1872, textHash: null };
  const sink = () => ({ onSessionExpired: vi.fn(), onStalePage: vi.fn() });

  it("routes UNAUTHORIZED to onSessionExpired", () => {
    const s = sink();
    expect(dispatchApiFailure(s, new ApiError("UNAUTHORIZED", "gone", 401))).toBe(true);
    expect(s.onSessionExpired).toHaveBeenCalledTimes(1);
    expect(s.onStalePage).not.toHaveBeenCalled();
  });

  it("routes STALE_PAGE to onStalePage with the note + page that 404'd", () => {
    const s = sink();
    expect(dispatchApiFailure(s, new ApiError("STALE_PAGE", "stale", 404), "7", page)).toBe(true);
    expect(s.onStalePage).toHaveBeenCalledWith("7", page);
    expect(s.onSessionExpired).not.toHaveBeenCalled();
  });

  it("leaves other failures to the caller (non-fatal, nothing fires)", () => {
    const s = sink();
    expect(dispatchApiFailure(s, new ApiError("NETWORK", "offline", 0))).toBe(false);
    expect(dispatchApiFailure(s, new Error("renderer blew up"))).toBe(false);
    expect(s.onSessionExpired).not.toHaveBeenCalled();
    expect(s.onStalePage).not.toHaveBeenCalled();
  });

  it("does not fire onStalePage without a page to blame", () => {
    const s = sink();
    // A listing/metadata call has no `?v=` hash — there's nothing to refetch on
    // its behalf, so this stays the caller's non-fatal problem.
    expect(dispatchApiFailure(s, new ApiError("STALE_PAGE", "stale", 404))).toBe(false);
    expect(s.onStalePage).not.toHaveBeenCalled();
  });

  // The note-scoped search: find-in-note's counter and its filmstrip badges.
  // ONE request answers the whole notebook, and it is deliberately a DIFFERENT
  // route from `/search` because the contract is different — complete and
  // unranked, where `/search` is ranked and clamped.
  describe("searchInNote", () => {
    it("GETs the note's own search route and keeps the pages in page order", async () => {
      const { fn, calls } = recordingFetch(() =>
        jsonResponse({
          query: "attention",
          pages: [
            { pageIndex: 4, matches: 2, terms: ["attention"] },
            { pageIndex: 1, matches: 3, terms: ["attention", "attentive"] },
          ],
          usedFuzzy: false,
        }),
      );
      vi.stubGlobal("fetch", fn);

      const r = await createHttpApi().searchInNote("n-doc-attn", "attention");
      expect(calls[0]).toContain("/api/controlplane/note/n-doc-attn/search?q=attention");
      // NO `limit` — a clamp here is exactly what would make the counter
      // silently incomplete.
      expect(calls[0]).not.toContain("limit");
      expect(r.pages).toEqual([
        { pageIndex: 1, matches: 3, terms: ["attention", "attentive"] },
        { pageIndex: 4, matches: 2, terms: ["attention"] },
      ]);
    });

    it("AUTO-DRAINS the keyset: follows the cursor across batches and accumulates the exact result", async () => {
      // The server batches find-in-note now; the client drains until the cursor
      // is absent, so it still resolves the COMPLETE per-note result. Batch 1
      // carries a cursor, batch 2 (resumed) returns the tail and none — done.
      const { fn, calls } = recordingFetch((url) =>
        url.includes("cursor=c1")
          ? jsonResponse({ query: "q", pages: [{ pageIndex: 2, matches: 1, terms: ["q"] }], usedFuzzy: false })
          : jsonResponse({
              query: "q",
              pages: [
                { pageIndex: 0, matches: 1, terms: ["q"] },
                { pageIndex: 1, matches: 1, terms: ["q"] },
              ],
              usedFuzzy: false,
              cursor: "c1",
            }),
      );
      vi.stubGlobal("fetch", fn);

      const r = await createHttpApi().searchInNote("n1", "q");
      // Two requests: the first without a cursor, the second handing "c1" back.
      expect(calls).toHaveLength(2);
      expect(calls[0]).not.toContain("cursor");
      expect(calls[1]).toContain("cursor=c1");
      // The accumulated union, stable-sorted by page index — nothing dropped or
      // duplicated across the batch boundary.
      expect(r.pages.map((p) => p.pageIndex)).toEqual([0, 1, 2]);
    });

    it("reads usedFuzzy off the FIRST batch and never resumes a fuzzy (no-cursor) fallback", async () => {
      // The fuzzy fallback is a one-shot with no cursor, so a single request; the
      // flag is whatever that first (only) batch reported.
      const { fn, calls } = recordingFetch(() =>
        jsonResponse({ query: "q", pages: [{ pageIndex: 3, matches: 1, terms: ["quay"] }], usedFuzzy: true }),
      );
      vi.stubGlobal("fetch", fn);
      const r = await createHttpApi().searchInNote("n1", "q");
      expect(calls).toHaveLength(1);
      expect(r.usedFuzzy).toBe(true);
    });

    it("resolves a BLANK query to no pages WITHOUT a request", async () => {
      const { fn, calls } = recordingFetch(() => jsonResponse({ query: "", pages: [{ pageIndex: 0, matches: 1 }] }));
      vi.stubGlobal("fetch", fn);

      const client = createHttpApi();
      const nothing = { query: "", pages: [], usedFuzzy: false };
      expect(await client.searchInNote("n1", "")).toEqual(nothing);
      expect(await client.searchInNote("n1", "   ")).toEqual(nothing);
      expect(calls).toHaveLength(0);
    });

    it("percent-encodes both the note id and the query", async () => {
      const { fn, calls } = recordingFetch(() => jsonResponse({ query: "a b&c", pages: [] }));
      vi.stubGlobal("fetch", fn);

      await createHttpApi().searchInNote("a/b", "a b&c");
      expect(calls[0]).toContain("/note/a%2Fb/search");
      expect(calls[0]).toContain("q=a+b%26c");
    });

    // A row exists BECAUSE the index matched that page, so a 0 there is an
    // absence stated as a presence — a filmstrip badge reading "0 matches".
    it("never lets a match count be 0, and drops a row with no usable page", async () => {
      vi.stubGlobal(
        "fetch",
        recordingFetch(() =>
          jsonResponse({
            query: "q",
            pages: [
              { pageIndex: 0, matches: 0, terms: ["a", 7, ""] },
              { matches: 4, terms: ["dropped"] },
              { pageIndex: 2 },
            ],
          }),
        ).fn,
      );

      const r = await createHttpApi().searchInNote("n1", "q");
      // The row with no page index is DROPPED rather than defaulted to page 0:
      // a wrong page is a jump to the wrong place, a missing one is one fewer badge.
      // `terms` degrades to what is usable, and to EMPTY when it is absent: a
      // page the reader cannot circle anything on is better than one it circles
      // the wrong thing on. The count is untouched either way — it is the
      // authority, the ovals are the illustration.
      expect(r.pages).toEqual([
        { pageIndex: 0, matches: 1, terms: ["a"] },
        { pageIndex: 2, matches: 1, terms: [] },
      ]);
    });

    it("treats an OMITTED pages array as no matching pages", async () => {
      vi.stubGlobal("fetch", recordingFetch(() => jsonResponse({ query: "q" })).fn);
      expect((await createHttpApi().searchInNote("n1", "q")).pages).toEqual([]);
    });

    // Same strictness as `searchText`: find tolerates typos now, and saying so
    // is the difference between an approximate answer and one presented as exact.
    it("reads usedFuzzy strictly, so an absent flag never accuses find of guessing", async () => {
      vi.stubGlobal("fetch", recordingFetch(() => jsonResponse({ query: "q", pages: [], usedFuzzy: true })).fn);
      expect((await createHttpApi().searchInNote("n1", "q")).usedFuzzy).toBe(true);

      vi.stubGlobal("fetch", recordingFetch(() => jsonResponse({ query: "q", pages: [] })).fn);
      expect((await createHttpApi().searchInNote("n1", "q")).usedFuzzy).toBe(false);
    });

    it("maps a 401 to UNAUTHORIZED rather than an empty count", async () => {
      vi.stubGlobal("fetch", recordingFetch(() => jsonResponse({ success: false }, { status: 401 })).fn);
      const err = await createHttpApi().searchInNote("n1", "q").catch((e) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect(err.code).toBe("UNAUTHORIZED");
    });
  });

  // The `.txt`-scoped search: find-in-txt's prev/next jumps and its exact count.
  // Its OWN route (not a kind on `/search`), complete and unranked, carrying byte
  // ranges rather than page counts.
  describe("searchInTxt", () => {
    it("GETs the file's own txt-search route and keeps the segments in order", async () => {
      const { fn, calls } = recordingFetch(() =>
        jsonResponse({
          query: "zephyrine",
          segments: [
            { segment: 2, offset: 33, length: 25, matches: 1, terms: ["zephyrine"] },
            { segment: 1, offset: 13, length: 18, matches: 1, terms: ["zephyrine"] },
          ],
          usedFuzzy: false,
        }),
      );
      vi.stubGlobal("fetch", fn);

      const r = await createHttpApi().searchInTxt("n-r", "zephyrine");
      expect(calls[0]).toContain("/api/controlplane/note/n-r/txt-search?q=zephyrine");
      // NO `limit` — complete by construction, like searchInNote.
      expect(calls[0]).not.toContain("limit");
      // Sorted by segment ordinal (= byte order) regardless of wire order.
      expect(r.segments.map((s) => s.segment)).toEqual([1, 2]);
    });

    it("AUTO-DRAINS the keyset: follows the cursor across batches and accumulates every paragraph", async () => {
      const { fn, calls } = recordingFetch((url) =>
        url.includes("cursor=t1")
          ? jsonResponse({ query: "q", segments: [{ segment: 2, offset: 40, length: 9, matches: 1, terms: ["q"] }] })
          : jsonResponse({
              query: "q",
              segments: [
                { segment: 0, offset: 0, length: 9, matches: 1, terms: ["q"] },
                { segment: 1, offset: 20, length: 9, matches: 1, terms: ["q"] },
              ],
              cursor: "t1",
            }),
      );
      vi.stubGlobal("fetch", fn);

      const r = await createHttpApi().searchInTxt("n1", "q");
      expect(calls).toHaveLength(2);
      expect(calls[1]).toContain("cursor=t1");
      expect(r.segments.map((s) => s.segment)).toEqual([0, 1, 2]);
    });

    it("resolves a BLANK query to no segments WITHOUT a request", async () => {
      const { fn, calls } = recordingFetch(() =>
        jsonResponse({ query: "", segments: [{ segment: 0, offset: 0, length: 1, matches: 1, terms: ["x"] }] }),
      );
      vi.stubGlobal("fetch", fn);

      const client = createHttpApi();
      const nothing = { query: "", segments: [], usedFuzzy: false };
      expect(await client.searchInTxt("n1", "")).toEqual(nothing);
      expect(await client.searchInTxt("n1", "   ")).toEqual(nothing);
      expect(calls).toHaveLength(0);
    });

    // A byte offset is what the viewer scrolls to, so a malformed row is dropped
    // rather than defaulted to offset 0 — the wrong place is worse than one fewer.
    it("drops a row with no usable segment/offset and never lets a count be 0", async () => {
      vi.stubGlobal(
        "fetch",
        recordingFetch(() =>
          jsonResponse({
            query: "q",
            segments: [
              { segment: 0, offset: 0, length: 4, matches: 0, terms: ["a", 7, ""] },
              { offset: 10, length: 4, matches: 2 }, // no segment → dropped
              { segment: 3, length: 4, matches: 1 }, // no offset → dropped
            ],
          }),
        ).fn,
      );
      const r = await createHttpApi().searchInTxt("n1", "q");
      expect(r.segments).toEqual([{ segment: 0, offset: 0, length: 4, matches: 1, terms: ["a"] }]);
    });

    it("reads usedFuzzy strictly, like every other search on this face", async () => {
      vi.stubGlobal("fetch", recordingFetch(() => jsonResponse({ query: "q", segments: [], usedFuzzy: true })).fn);
      expect((await createHttpApi().searchInTxt("n1", "q")).usedFuzzy).toBe(true);
      vi.stubGlobal("fetch", recordingFetch(() => jsonResponse({ query: "q", segments: [] })).fn);
      expect((await createHttpApi().searchInTxt("n1", "q")).usedFuzzy).toBe(false);
    });

    it("maps a 401 to UNAUTHORIZED rather than an empty result", async () => {
      vi.stubGlobal("fetch", recordingFetch(() => jsonResponse({ success: false }, { status: 401 })).fn);
      const err = await createHttpApi().searchInTxt("n1", "q").catch((e) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect(err.code).toBe("UNAUTHORIZED");
    });
  });
});

// --- the account face (docs/scratch/user-options.md §7) ---
//
// Four routes, and the thing they have in common is what is being pinned here
// as much as the mapping: NOT ONE OF THEM TAKES A TARGET. Every verb under
// `/api/admin` names another account with an `:id`; the session is the target
// here, which is the whole difference between the two faces.
describe("createHttpApi — the account face", () => {
  const ACCOUNT = {
    email: "ana@household.lan",
    name: "ana",
    isAdmin: false,
    createdAt: 1_700_000_000,
    passwordChangedAt: 1_750_000_000,
    thisSessionSince: 1_760_000_000,
    otherBrowsers: 2,
    devices: [
      {
        equipment_no: "SN1",
        name: "Nomad",
        model: "A5X2",
        firmware: "3.20.29",
        active: true,
        created_at: 1_700_000_000,
        last_seen: 1_760_000_100,
      },
    ],
    versions: { keep: 5, maxKeep: 20, retainedPerFile: [7, 2, 1], bytes: 13_000_000 },
  };

  it("reads the sign-in facts off /account, with no user id anywhere in the URL", async () => {
    const { fn, calls } = recordingFetch(() => jsonResponse(ACCOUNT));
    vi.stubGlobal("fetch", fn);

    const s = await createHttpApi().accountSecurity();

    expect(calls[0]).toContain("/api/controlplane/account");
    expect(calls[0]).not.toMatch(/\/\d+/); // no `:id` — the session is the target
    expect(s).toEqual({ passwordChangedAt: 1_750_000_000, otherSessions: 2, thisSessionSince: 1_760_000_000 });
  });

  it("reads an ABSENT optional as 'the fact does not exist', never as 0", async () => {
    // `respond` omits null optionals, so a password that has never been
    // changed arrives as a missing key. Reading it as 0 would date the change
    // to 1970 and the screen would say "last changed 56 years ago".
    const { passwordChangedAt, thisSessionSince, ...bare } = ACCOUNT;
    void passwordChangedAt;
    void thisSessionSince;
    vi.stubGlobal("fetch", recordingFetch(() => jsonResponse(bare)).fn);

    const s = await createHttpApi().accountSecurity();
    expect(s.passwordChangedAt).toBeNull();
    expect(s.thisSessionSince).toBeNull();
  });

  it("maps a device row and drops REVOKED bindings", async () => {
    // The route is the admin console's own listing, which keeps revoked
    // bindings so an admin can audit them. On your own account they would read
    // as a tablet still attached, so the seam filters them out here.
    const withRevoked = {
      ...ACCOUNT,
      devices: [
        ...ACCOUNT.devices,
        { equipment_no: "SN2", name: "Manta", active: false, created_at: 1, last_seen: 2 },
      ],
    };
    vi.stubGlobal("fetch", recordingFetch(() => jsonResponse(withRevoked)).fn);

    const devices = await createHttpApi().myDevices();
    expect(devices).toEqual([
      {
        equipmentNo: "SN1",
        name: "Nomad",
        model: "A5X2",
        firmware: "3.20.29",
        lastSeenAt: 1_760_000_100,
        linkedAt: 1_700_000_000,
      },
    ]);
  });

  it("reads a device never seen as null, not as the epoch", async () => {
    const unseen = { ...ACCOUNT, devices: [{ ...ACCOUNT.devices[0], last_seen: undefined }] };
    vi.stubGlobal("fetch", recordingFetch(() => jsonResponse(unseen)).fn);
    expect((await createHttpApi().myDevices())[0]!.lastSeenAt).toBeNull();
  });

  it("shares ONE /account round trip between the two methods that read it", async () => {
    // The server answers identity, sign-in and devices in one response; the
    // seam keeps them separate so the page can fail each section on its own.
    // Both are right, and the join belongs in the client.
    const { fn, calls } = recordingFetch(() => jsonResponse(ACCOUNT));
    vi.stubGlobal("fetch", fn);

    const api = createHttpApi();
    await Promise.all([api.accountSecurity(), api.myDevices()]);
    expect(calls).toHaveLength(1);

    // …and it is NOT a cache: a later read re-asks, or re-entering the page
    // would silently show what was true when it was first opened.
    await api.myDevices();
    expect(calls).toHaveLength(2);
  });

  it("maps the five-way storage split, and re-derives none of it", async () => {
    const { fn, calls } = recordingFetch(() =>
      jsonResponse({
        used_bytes: 15,
        total_bytes: 100,
        notebooks: 5,
        sketches: 4,
        documents: 3,
        recycle_bin: 2,
        versions: 1,
      }),
    );
    vi.stubGlobal("fetch", fn);

    const s = await createHttpApi().storageBreakdown();
    expect(calls[0]).toContain("/api/controlplane/account/storage");
    expect(s.usedBytes).toBe(15);
    expect(s.totalBytes).toBe(100);
    expect(s.byKind).toEqual({
      notebookBytes: 5,
      sketchBytes: 4,
      documentBytes: 3,
      binBytes: 2,
      versionBytes: 1,
    });
  });

  it("reports byKind as NOT KNOWN when the split is absent, rather than as zeros", async () => {
    // A server too old to answer the split can still answer the total. Five
    // zeroes beside a full meter is the confident lie; null is the truth.
    vi.stubGlobal("fetch", recordingFetch(() => jsonResponse({ used_bytes: 15, total_bytes: 100 })).fn);
    const s = await createHttpApi().storageBreakdown();
    expect(s.usedBytes).toBe(15);
    expect(s.byKind).toBeNull();
  });

  it("unlinks by POSTing the serial, with no user id in the URL or the body", async () => {
    const bodies: unknown[] = [];
    const fn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return jsonResponse({ success: true });
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fn);

    await createHttpApi().unlinkMyDevice("SN1");
    expect(bodies).toEqual([{ equipmentNo: "SN1" }]);
  });

  it("returns how many sessions signing out everywhere ended", async () => {
    const { fn, calls } = recordingFetch(() => jsonResponse({ success: true, revoked: 3 }));
    vi.stubGlobal("fetch", fn);
    expect(await createHttpApi().signOutEverywhere()).toBe(3);
    expect(calls[0]).toContain("/api/controlplane/account/sign-out-others");
  });

  it("reads the per-file retained counts, which are what let the dial state its cost", async () => {
    // §7 makes stating the cost the CONDITION on offering the control at all:
    // discarded versions are gone, the recycle bin does not hold them. So the
    // counts are not decoration on this response, they are the reason the
    // section can render — "keeping 3 will remove 8 versions now" is
    // `Σ max(0, count − 3)` over exactly this array.
    vi.stubGlobal("fetch", recordingFetch(() => jsonResponse(ACCOUNT)).fn);

    const p = await createHttpApi().versionPolicy();

    // NOTE the fixture still SENDS `bytes` and the result does not carry it: the
    // field was dropped when the figure left the control, and reading a payload
    // that still has it must not resurrect it. `toEqual` is exact, so this fails
    // if the mapper starts passing unknown fields through.
    expect(p).toEqual({ keep: 5, maxKeep: 20, retainedPerFile: [7, 2, 1] });
  });

  it("drops a non-numeric retained count instead of letting the notice read NaN", async () => {
    // This array drives a control that DESTROYS data. One null in it makes the
    // sum `NaN`, and "Keeping 3 will remove NaN versions now" is worse than no
    // notice at all: it is the notice, broken, in front of someone whose next
    // click discards history that the bin will not hold.
    const bad = { ...ACCOUNT, versions: { keep: 1, maxKeep: 9, retainedPerFile: [3, null, -1, 4], bytes: 5 } };
    vi.stubGlobal("fetch", recordingFetch(() => jsonResponse(bad)).fn);

    const p = await createHttpApi().versionPolicy();

    expect(p.retainedPerFile).toEqual([3, 4]);
  });

  it("PUTs the dial and reports what the change ACTUALLY discarded", async () => {
    // The page predicted a number from `retainedPerFile` before the click; the
    // server answers with what it really removed. Both exist on purpose — if
    // they ever disagree, the interface promised something it did not deliver
    // and should be able to notice rather than repeat its own arithmetic back.
    const { fn, calls } = recordingFetch(() =>
      jsonResponse({
        policy: { keep: 3, maxKeep: 20, retainedPerFile: [3, 2, 1], bytes: 9_000_000 },
        removedVersions: 4,
        freedBytes: 4_000_000,
      }),
    );
    vi.stubGlobal("fetch", fn);

    const r = await createHttpApi().setVersionPolicy(3);

    expect(calls[0]).toContain("/api/controlplane/account/versions");
    expect(r.removedVersions).toBe(4);
    expect(r.freedBytes).toBe(4_000_000);
    expect(r.policy.keep).toBe(3);
  });

  it("sends the CURRENT password as well as the new one", async () => {
    // The server REQUIRES and VERIFIES it (§4): a control-plane caller that omits
    // the field is refused `INVALID_CREDENTIALS` outright, so a client that stops
    // sending it stops working entirely. This pins the CLIENT half of that
    // contract — if it ever goes red, the current-password field on the form has
    // become theatre and the endpoint will say so.
    const bodies: Record<string, unknown>[] = [];
    const fn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return jsonResponse({ success: true });
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fn);

    await createHttpApi().changePassword("old-one", "new-one");
    expect(Object.keys(bodies[0]!).sort()).toEqual(["currentPassword", "newPassword"]);
    // BOTH hashed at the seam, so an existing password is no more exposed on
    // the wire than a new one.
    expect(bodies[0]!["currentPassword"]).toMatch(/^[0-9a-f]{32}$/);
    expect(bodies[0]!["newPassword"]).toMatch(/^[0-9a-f]{32}$/);
    expect(bodies[0]!["currentPassword"]).not.toBe(bodies[0]!["newPassword"]);
  });
});
