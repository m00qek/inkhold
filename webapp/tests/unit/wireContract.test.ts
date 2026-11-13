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
import type { BinnedDigest, Digest, DigestBin, DigestSnapshot, DigestSource } from "../../src/api/digestTypes";
import { digestBinOf, digestsOf } from "../../src/api/httpDigest";

// The server writes `tests/fixtures/wire/*.json` through its real serializer (absent
// optional = absent key). Every wire key must be decided by the client, survive the
// rebuild (that is how `hasInk` was lost), and normalize to its documented absence.
// Regenerate with `INK_UPDATE_WIRE_FIXTURES=1 zig build test` from the repo root.

const wire = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`../fixtures/wire/${name}`, import.meta.url), "utf8")) as Record<string, unknown>;

/** Every key the server may send, mapped to its domain property or `null` if dropped. */
type KeyTable<T> = Record<string, keyof T | null>;

/** The normalized form of an omitted key, for keys whose absence has a documented form. */
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
  layers: null,
  // The one that is `undefined` rather than `null`: three-state.
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
  // Never `{w:0,h:0}`, an invalid `aspect-ratio`.
  thumbAspect: undefined,
  annotationsId: null,
  // `fileType` is derived from the name, so absence is not a hole.
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
  // Unknown hardware: do not place invisible text.
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
  // Omitted for the root listing; `folderId === null` drives the breadcrumb.
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
    if (prop === null) continue;
    if (has(sent, key)) {
      // 2. A key that carried a value survived the rebuild (would have caught `hasInk`).
      expect(
        got[prop as string],
        `${where}: the server sent "${key}" and the client dropped it — ` +
          `normalized "${String(prop)}" is undefined. If the field is genuinely not wanted, map it to null in the table.`,
      ).not.toBeUndefined();
    } else if (has(absent as Record<string, unknown>, prop as string)) {
      // 3. An omitted key reads as its documented absent form.
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
  // Both optionals omitted, both with ink, both without (an erased mark page).
  it.each(["page-ref.json", "page-ref-inked.json", "page-ref-sparse-mark.json"])("%s", (name) => {
    const sent = wire(name);
    checkPageRef(name, sent, normalizePage(sent as unknown as PageRef));
  });

  it("reads an omitted hasInk as undefined and an omitted sourcePage as null — not as each other", () => {
    const bare = normalizePage(wire("page-ref.json") as unknown as PageRef);
    expect(bare.hasInk).toBeUndefined();
    expect(bare.sourcePage).toBeNull();

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
    // The mark is folded out of every folder view; the listing is the only source.
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

    expect(got.entries.some((e) => e.kind === "folder")).toBe(true);
    expect(got.entries.some((e) => e.kind === "note")).toBe(true);
  });

  it("reads an omitted folderId as null, because the root listing omits it", async () => {
    const { folderId, ...root } = wire("listing.json");
    expect(folderId).toBeDefined();
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
    serve(wire("note-meta-pdf-with-mark.json"));
    expect(await createHttpApi().getNoteMeta("2").then((m) => m.pxPerMm)).toBeNull();
  });
});

describe("wire contract: HistoryVO", () => {
  it("history.json, walked to its versions", async () => {
    const sent = wire("history.json");
    serve(sent);
    const got = await createHttpApi().noteHistory("1");

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

    expect(got.versions.map((v: FileVersion) => v.current)).toEqual([true, false]);
  });
});

describe("wire contract: PageTextVO", () => {
  it("page-text.json, walked to its word boxes", async () => {
    const sent = wire("page-text.json");
    serve(sent);
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

    // Device millimetres, unconverted.
    expect(got.words[0]).toEqual({ text: "hello", xMm: 10.5, yMm: 20.25, wMm: 15, hMm: 6.5 });
  });

  it("reads an empty body as the empty transcript, not as an error", async () => {
    // `{}` is a page with stored-but-undecodable RECOGNTEXT.
    serve({});
    const page = { index: 0, textHash: "deadbeef" } as unknown as PageRef;
    expect(await createHttpApi().getPageText("1", page)).toEqual({ text: "", words: [] });
  });
});

// --- Digest (`/api/controlplane/digests…`), read by `api/httpDigest.ts` ---

const DIGESTS_KEYS: KeyTable<DigestSnapshot> = {
  success: null, // every reply's flag; `request` reads it, not the snapshot
  enabled: "enabled",
  categories: "categories",
  digests: "digests",
  tabletSyncedAt: "tabletSyncedAt",
  waiting: "waiting",
};

const DIGESTS_ABSENT: AbsentTable<DigestSnapshot> = {
  // No tablet has asked yet.
  tabletSyncedAt: null,
  waiting: false,
};

const DIGEST_KEYS: KeyTable<Digest> = {
  id: "id",
  text: "text",
  comment: "comment",
  categoryUid: "categoryUid",
  author: "author",
  createdAt: "createdAt",
  modifiedAt: "modifiedAt",
  source: "source",
  note: "note",
  waiting: "waiting",
};

const DIGEST_ABSENT: AbsentTable<Digest> = { comment: null, author: null, note: null, waiting: false };

const SOURCE_KEYS: KeyTable<DigestSource> = { kind: "kind", path: "path", fileId: "fileId", page: "page", changed: "changed" };

const SOURCE_ABSENT: AbsentTable<DigestSource> = { path: null, fileId: null, page: null, changed: false };

const BIN_KEYS: KeyTable<DigestBin> = { success: null, enabled: "enabled", digests: "digests", retentionDays: "retentionDays" };

const BINNED_KEYS: KeyTable<BinnedDigest> = {
  id: "id",
  text: "text",
  categoryUid: "categoryUid",
  categoryName: "categoryName",
  deletedAt: "deletedAt",
  back: "back",
};

const BINNED_ABSENT: AbsentTable<BinnedDigest> = { categoryName: null, back: false };

const rec = (v: unknown): Record<string, unknown> => v as Record<string, unknown>;

describe("wire contract: Digest", () => {
  it("digests.json, walked to each digest and its source", () => {
    const sent = wire("digests.json");
    const got = digestsOf(sent);
    checkShape("digests", DIGESTS_KEYS, DIGESTS_ABSENT, sent, rec(got));
    const rows = sent.digests as Record<string, unknown>[];
    expect(got.digests).toHaveLength(rows.length);
    rows.forEach((d, i) => {
      checkShape(`digests[${i}]`, DIGEST_KEYS, DIGEST_ABSENT, d, rec(got.digests[i]));
      checkShape(`digests[${i}].source`, SOURCE_KEYS, SOURCE_ABSENT, rec(d.source), rec(got.digests[i]!.source));
    });
    // The fixture holds what the client must tell apart: a browser edit waiting, a typed entry with no file.
    expect(got.waiting).toBe(true);
    expect(got.digests.map((d) => d.waiting)).toEqual([false, true]);
    expect(got.digests[1]!.source).toMatchObject({ kind: "manual", path: null, fileId: null });
  });

  it("digest-bin.json, walked to each binned digest and its source", () => {
    const sent = wire("digest-bin.json");
    const got = digestBinOf(sent);
    checkShape("bin", BIN_KEYS, {}, sent, rec(got));
    const rows = sent.digests as Record<string, unknown>[];
    expect(got.digests).toHaveLength(rows.length);
    rows.forEach((d, i) => checkShape(`bin.digests[${i}]`, BINNED_KEYS, BINNED_ABSENT, d, rec(got.digests[i])));
    expect(got.digests[0]).toMatchObject({ categoryName: "Phonétique", back: false });
  });
});
