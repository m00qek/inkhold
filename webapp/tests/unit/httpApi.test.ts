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

    // The tile-shape fact the masonry lays out from.
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
    it("drops a record with nothing to draw or nowhere to go", async () => {
      // The two refusals `pdfWire.ts` still makes about a link, and both are
      // about CONTENT out of the document: a uri that names nowhere, and a rect
      // with no area. The shape of the record is our own shim's (§2.7) and is
      // no longer re-checked here — `{ page: 1.5 }` would need the shim to be
      // broken, which the ABI test catches first.
      vi.stubGlobal(
        "fetch",
        recordingFetch(() =>
          jsonResponse({
            links: [
              { x: 1, y: 2, w: 3, h: 4, page: -1, uri: "https://ok.example/" },
              { x: 1, y: 2, w: 3, h: 4, page: -1 }, // no uri
              { x: 1, y: 2, w: 3, h: 4, page: -1, uri: "" }, // nowhere to go
              { x: 1, y: 2, w: 0, h: 4, page: -1, uri: "https://ok.example/" }, // empty rect
              { x: 1, y: 2, w: 3, h: -4, page: -1, uri: "https://ok.example/" }, // negative
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
});

// --- the account face ---
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
