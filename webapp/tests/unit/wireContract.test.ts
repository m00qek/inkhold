import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createHttpApi, normalizeEntry, normalizePage } from "../../src/api/client";
import type {
  Entry,
  FileVersion,
  Folder,
  Listing,
  NoteMeta,
  NoteSummary,
  PageLayer,
  PageRef,
  PageText,
} from "../../src/core/types";

// THE OTHER HALF OF §8.4's WIRE CONTRACT.
//
// `backend/services/controlplane.zig` writes `tests/fixtures/wire/*.json` from
// the real VOs through the real serializer, with the handlers' own options
// (`emit_null_optional_fields = false`, so an absent optional is an ABSENT KEY
// and not a null). This file reads those same bytes back through the real
// client normalizers and asks two questions of every one of them:
//
//   1. did the client DECIDE about every key the server sent? and
//   2. did every key it decided to keep actually survive the rebuild?
//
// Question 2 is the one that was missing. `normalizePage` rebuilds a `PageRef`
// field by field rather than spreading it, so a field the server added and the
// rebuild never listed vanished at the seam with both suites green — which is
// precisely how `hasInk` was lost. The tables below are the contract: a wire key
// with no entry fails (1), and an entry whose property comes back `undefined`
// fails (2).
//
// Question 3 rides along: for a fixture that OMITS an optional, the normalized
// property must be the absent form the type documents — and `null` and
// `undefined` are different answers here. `sourcePage`/`textHash` collapse onto
// `null` because they are two-state (a value, or nothing). `hasInk` collapses
// onto `undefined` because it is THREE-state, and folding "the server has not
// looked yet" onto `false` would tell someone their notebook is blank while the
// back-fill is still running. See the doc comments on `PageRef` in
// `core/types.ts`; this asserts what they claim.
//
// When a fixture changes, regenerate it with
// `INK_UPDATE_WIRE_FIXTURES=1 zig build test` from the repo root and read the
// `git diff` as a description of what changed on the wire.

const wire = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`../fixtures/wire/${name}`, import.meta.url), "utf8")) as Record<string, unknown>;

/**
 * A wire shape's key table: every key the server may send, mapped to the domain
 * property that carries it — or to `null` where the client DELIBERATELY drops
 * it, with the reason on the line. There is no third option, which is the point:
 * a new server field has to be given one of the two answers here before this
 * suite goes green again.
 */
type KeyTable<T> = Record<string, keyof T | null>;

/**
 * What the normalized record must show for a key the server OMITTED. Only keys
 * whose absence has a documented form appear; a key the client answers by
 * DERIVING a value (`fileType` from the name) is not an absence and is left out.
 */
type AbsentTable<T> = Partial<Record<keyof T, unknown>>;

const PAGE_REF_KEYS: KeyTable<PageRef> = {
  index: "index",
  hash: "hash",
  width: "width",
  height: "height",
  textHash: "textHash",
  linksHash: "linksHash",
  sourcePage: "sourcePage",
  layers: "layers",
  hasInk: "hasInk",
};

const PAGE_REF_ABSENT: AbsentTable<PageRef> = {
  textHash: null,
  linksHash: null,
  sourcePage: null,
  // Absent means NONE, not unknown — the server omits the key exactly when the
  // page has no layer records, so `null` is the reader's "no panel" state.
  layers: null,
  // The one that is `undefined` rather than `null`. See the header.
  hasInk: undefined,
};

const LAYER_KEYS: KeyTable<PageLayer> = {
  slot: "slot",
  name: "name",
  visible: "visible",
  isCurrent: "isCurrent",
};

const FOLDER_KEYS: KeyTable<Folder> = {
  kind: "kind",
  id: "id",
  name: "name",
  itemCount: "itemCount",
};

const FOLDER_ABSENT: AbsentTable<Folder> = {
  // Absent = "not counted here" (the breadcrumb never counts), which the row
  // renders as no meta at all. `0` would be a claim that the folder is empty.
  itemCount: undefined,
};

const NOTE_ENTRY_KEYS: KeyTable<NoteSummary> = {
  kind: "kind",
  id: "id",
  name: "name",
  pageCount: "pageCount",
  firstPage: "firstPage",
  updatedAt: "updatedAt",
  fileType: "fileType",
  fileHash: "fileHash",
  hasRecognizedText: "hasRecognizedText",
  thumbAspect: "thumbAspect",
  annotationsId: "annotationsId",
};

const NOTE_ENTRY_ABSENT: AbsentTable<NoteSummary> = {
  fileHash: null,
  hasRecognizedText: false,
  // Absent = "unknown shape", which the masonry answers with its 3:4 fallback.
  // Never `{w:0,h:0}`, which would reach CSS as an invalid `aspect-ratio`.
  thumbAspect: undefined,
  annotationsId: null,
  // `fileType` is deliberately NOT here: the client derives it from the name
  // (`fileTypeFromName`), so its absence produces a value rather than a hole.
};

const NOTE_META_KEYS: KeyTable<NoteMeta> = {
  id: "id",
  name: "name",
  pages: "pages",
  fileType: "fileType",
  fileHash: "fileHash",
  size: "size",
  annotationsId: "annotationsId",
  pxPerMm: "pxPerMm",
};

const NOTE_META_ABSENT: AbsentTable<NoteMeta> = {
  fileHash: null,
  annotationsId: null,
  // `null` IS the answer, and the exporter must honour it: unknown hardware
  // means "do not place invisible text", not "guess a scale".
  pxPerMm: null,
  size: 0,
};

const LISTING_KEYS: KeyTable<Listing> = {
  folderId: "folderId",
  path: "path",
  entries: "entries",
  syncVersion: "syncVersion",
};

const LISTING_ABSENT: AbsentTable<Listing> = {
  // Omitted for the ROOT listing, and `listing.folderId === null` is the test
  // that drives the breadcrumb — `undefined` there would break it silently.
  folderId: null,
};

const VERSION_KEYS: KeyTable<FileVersion> = {
  md5: "md5",
  size: "size",
  createdAt: "createdAt",
  pageCount: "pageCount",
  current: "current",
};

const VERSION_ABSENT: AbsentTable<FileVersion> = {
  current: false,
  pageCount: 0,
};

const PAGE_TEXT_KEYS: KeyTable<PageText> = {
  text: "text",
  words: "words",
};

const PAGE_TEXT_ABSENT: AbsentTable<PageText> = {
  text: "",
  words: [],
};

const WORD_KEYS: KeyTable<PageText["words"][number]> = {
  text: "text",
  xMm: "xMm",
  yMm: "yMm",
  wMm: "wMm",
  hMm: "hMm",
};

// --- the three assertions, once ---

const has = (o: Record<string, unknown>, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/**
 * Assertion 1 + 2 + 3 for one object: no unmapped wire key, no mapped key lost
 * in the rebuild, and every omitted key normalized to its documented absence.
 */
function checkShape<T>(
  where: string,
  table: KeyTable<T>,
  absent: AbsentTable<T>,
  sent: Record<string, unknown>,
  got: Record<string, unknown>,
): void {
  // 1. Every key the server sent has a decision recorded for it.
  for (const key of Object.keys(sent)) {
    expect(
      has(table as Record<string, unknown>, key),
      `${where}: the server sends "${key}" and the client has no decision for it. ` +
        `Add it to the key table in wireContract.test.ts — mapped to the domain property that carries it, ` +
        `or to null with the reason it is dropped.`,
    ).toBe(true);
  }

  for (const [key, prop] of Object.entries(table) as [string, (keyof T) | null][]) {
    if (prop === null) continue; // deliberately dropped; the table line says why
    if (has(sent, key)) {
      // 2. A key that carried a value survived the client's rebuild. THIS is the
      //    assertion that would have caught `hasInk`.
      expect(
        got[prop as string],
        `${where}: the server sent "${key}" and the client dropped it — ` +
          `normalized "${String(prop)}" is undefined. If the field is genuinely not wanted, map it to null in the table.`,
      ).not.toBeUndefined();
    } else if (has(absent as Record<string, unknown>, prop as string)) {
      // 3. An omitted key reads as the documented ABSENT form — and null,
      //    undefined and a default are three different answers.
      expect(
        got[prop as string],
        `${where}: the server OMITTED "${key}"; the client must read that as the documented absent form.`,
      ).toStrictEqual((absent as Record<string, unknown>)[prop as string]);
    }
  }
}

function checkPageRef(where: string, sent: Record<string, unknown>, got: PageRef): void {
  checkShape(where, PAGE_REF_KEYS, PAGE_REF_ABSENT, sent, got as unknown as Record<string, unknown>);
  const layers = sent.layers as Record<string, unknown>[] | undefined;
  if (layers === undefined) return;
  expect(got.layers, `${where}: layers arrived and the client produced none`).toHaveLength(layers.length);
  layers.forEach((l, i) => {
    checkShape(
      `${where}.layers[${i}]`,
      LAYER_KEYS,
      {},
      l,
      (got.layers as PageLayer[])[i] as unknown as Record<string, unknown>,
    );
  });
}

function checkEntry(where: string, sent: Record<string, unknown>, got: Entry): void {
  if (sent.kind === "folder") {
    checkShape(where, FOLDER_KEYS, FOLDER_ABSENT, sent, got as unknown as Record<string, unknown>);
    return;
  }
  checkShape(where, NOTE_ENTRY_KEYS, NOTE_ENTRY_ABSENT, sent, got as unknown as Record<string, unknown>);
  const first = sent.firstPage as Record<string, unknown> | undefined;
  if (first !== undefined) checkPageRef(`${where}.firstPage`, first, (got as NoteSummary).firstPage);
}

// --- driving the real seam ---

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A `fetch` stub that answers every request with `body`, as the server would. */
function serve(body: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }),
    ),
  );
}

describe("wire contract: PageRefVO", () => {
  // The three cases the fixtures deliberately cover: both optionals omitted,
  // both present with ink, and both present WITHOUT ink (an erased mark page —
  // `false` is a fact and travels; only the unknown is omitted).
  it.each(["page-ref.json", "page-ref-inked.json", "page-ref-sparse-mark.json"])("%s", (name) => {
    const sent = wire(name);
    checkPageRef(name, sent, normalizePage(sent as unknown as PageRef));
  });

  it("reads an omitted hasInk as undefined and an omitted sourcePage as null — not as each other", () => {
    // The two absences are spelled differently ON PURPOSE, and this is the pair
    // that says so. Stated separately from the table walk because it is the
    // distinction the whole three-state design rests on.
    const bare = normalizePage(wire("page-ref.json") as unknown as PageRef);
    expect(bare.hasInk).toBeUndefined();
    expect(bare.sourcePage).toBeNull();

    // …and where the server DID look, `false` survives as `false` rather than
    // collapsing into the same silence.
    const erased = normalizePage(wire("page-ref-sparse-mark.json") as unknown as PageRef);
    expect(erased.hasInk).toBe(false);
    expect(erased.sourcePage).toBe(5);
  });
});

describe("wire contract: EntryVO", () => {
  it.each(["entry.json", "entry-annotated-pdf.json"])("%s", (name) => {
    const sent = wire(name);
    checkEntry(name, sent, normalizeEntry(sent as unknown as Entry));
  });

  it("carries the paired .mark's id off the document's row", () => {
    // The listing is the ONLY place this can come from — the mark is folded out
    // of every folder view, so it has no row of its own.
    const doc = normalizeEntry(wire("entry-annotated-pdf.json") as unknown as Entry) as NoteSummary;
    expect(doc.annotationsId).toBe("3");
    const plain = normalizeEntry(wire("entry.json") as unknown as Entry) as NoteSummary;
    expect(plain.annotationsId).toBeNull();
  });
});

describe("wire contract: ListingVO", () => {
  it("listing.json, walked to its entries and their first pages", async () => {
    const sent = wire("listing.json");
    serve(sent);
    const got = await createHttpApi().listFolder("1");

    checkShape("listing.json", LISTING_KEYS, LISTING_ABSENT, sent, got as unknown as Record<string, unknown>);

    // The breadcrumb is `FolderVO` too, and its crumbs carry no count — the
    // absent-itemCount half of the folder contract lives here.
    const path = sent.path as Record<string, unknown>[];
    expect(got.path).toHaveLength(path.length);
    path.forEach((crumb, i) => {
      checkShape(
        `listing.json.path[${i}]`,
        FOLDER_KEYS,
        FOLDER_ABSENT,
        crumb,
        got.path[i] as unknown as Record<string, unknown>,
      );
    });

    const entries = sent.entries as Record<string, unknown>[];
    expect(got.entries).toHaveLength(entries.length);
    entries.forEach((e, i) => checkEntry(`listing.json.entries[${i}]`, e, got.entries[i]));

    // Both folder spellings really are in this fixture, so the walk above is
    // not vacuously passing over one shape.
    expect(got.entries.some((e) => e.kind === "folder")).toBe(true);
    expect(got.entries.some((e) => e.kind === "note")).toBe(true);
  });

  it("reads an omitted folderId as null, because the root listing omits it", async () => {
    const { folderId, ...root } = wire("listing.json");
    expect(folderId).toBeDefined(); // the fixture is a SUBfolder listing; drop the key to make it the root's
    serve(root);
    expect((await createHttpApi().listFolder(null)).folderId).toBeNull();
  });
});

describe("wire contract: NoteMetaVO", () => {
  it.each(["note-meta.json", "note-meta-pdf-with-mark.json"])("%s, walked to its page list", async (name) => {
    const sent = wire(name);
    serve(sent);
    const got: NoteMeta = await createHttpApi().getNoteMeta("1");

    checkShape(name, NOTE_META_KEYS, NOTE_META_ABSENT, sent, got as unknown as Record<string, unknown>);

    const pages = sent.pages as Record<string, unknown>[];
    expect(got.pages).toHaveLength(pages.length);
    pages.forEach((p, i) => checkPageRef(`${name}.pages[${i}]`, p, got.pages[i]));
  });

  it("keeps pxPerMm where the server measured the hardware, and null where it did not", async () => {
    serve(wire("note-meta.json"));
    expect(await createHttpApi().getNoteMeta("1").then((m) => m.pxPerMm)).toBeCloseTo(11.834, 3);
    // The PDF has no equipment to measure, so the key is absent — and absent is
    // a real answer ("raster-only export"), not a number to guess at.
    serve(wire("note-meta-pdf-with-mark.json"));
    expect(await createHttpApi().getNoteMeta("2").then((m) => m.pxPerMm)).toBeNull();
  });
});

describe("wire contract: HistoryVO", () => {
  it("history.json, walked to its versions", async () => {
    const sent = wire("history.json");
    serve(sent);
    const got = await createHttpApi().noteHistory("1");

    // `HistoryVO` itself is two keys, so it gets its table inline rather than a
    // named one nothing else would reuse.
    checkShape("history.json", { id: "id", versions: "versions" }, {}, sent, got as unknown as Record<string, unknown>);

    const versions = sent.versions as Record<string, unknown>[];
    expect(got.versions).toHaveLength(versions.length);
    versions.forEach((v, i) => {
      checkShape(
        `history.json.versions[${i}]`,
        VERSION_KEYS,
        VERSION_ABSENT,
        v,
        got.versions[i] as unknown as Record<string, unknown>,
      );
    });

    // Newest first, exactly one live row. The order is the server's and the
    // client never re-sorts it.
    expect(got.versions.map((v: FileVersion) => v.current)).toEqual([true, false]);
  });
});

describe("wire contract: PageTextVO", () => {
  it("page-text.json, walked to its word boxes", async () => {
    const sent = wire("page-text.json");
    serve(sent);
    // `textHash` non-null is what makes the client actually ask — a null one
    // short-circuits to the empty transcript without a request.
    const page = { index: 0, textHash: "deadbeef" } as unknown as PageRef;
    const got: PageText = await createHttpApi().getPageText("1", page);

    checkShape("page-text.json", PAGE_TEXT_KEYS, PAGE_TEXT_ABSENT, sent, got as unknown as Record<string, unknown>);

    const words = sent.words as Record<string, unknown>[];
    expect(got.words).toHaveLength(words.length);
    words.forEach((w, i) => {
      checkShape(
        `page-text.json.words[${i}]`,
        WORD_KEYS,
        {},
        w,
        got.words[i] as unknown as Record<string, unknown>,
      );
    });

    // The units are the device's own millimetres, carried through unconverted —
    // the field names are the contract and there is no scale in this object.
    expect(got.words[0]).toEqual({ text: "hello", xMm: 10.5, yMm: 20.25, wMm: 15, hMm: 6.5 });
  });

  it("reads an empty body as the empty transcript, not as an error", async () => {
    // `{}` is what a page with a stored-but-undecodable RECOGNTEXT serializes
    // to; the panel renders its honest "no recognized text" state.
    serve({});
    const page = { index: 0, textHash: "deadbeef" } as unknown as PageRef;
    expect(await createHttpApi().getPageText("1", page)).toEqual({ text: "", words: [] });
  });
});
