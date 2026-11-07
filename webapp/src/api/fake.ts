// In-memory `Api` over a small fixture tree, for `dev` and Playwright e2e.
// Synchronous data behind async signatures plus a small latency.

import type { Api, PageLinks } from "./types";
import type { Entry, FileHistory, FileVersion, Id, Listing, NoteMeta, NoteSummary, PageRef, PageText, RestoredVersion } from "../core/types";
import { isAcceptedUpload, nextAvailableName, uploadExtension } from "../core/fileKind";
import { fakeAdminMethods } from "./fakeAdmin";
import { fakeAccountMethods } from "./fakeAccount";
import { fakeTodoMethods } from "./fakeTodo";

export { FAKE_UPLOAD_HEADROOM, MARKED_PDF_ID, PDF_MARK_ID } from "./fakeFixtures";
export { fakeFileHash } from "./fakeHash";
import { createBinFake } from "./binFake";
import { LAYERED_NOTE_ID, layeredPageLayers, layeredPagePayload, withLayeredPageLayers } from "./layeredFixture";
import { fakeFileHash } from "./fakeHash";
import { MARKED_PDF_ID, PDF_MARK_ID, PDF_MARK_SOURCE_PAGE, RECOGNIZED_FROM, fakeTextHash, pages, fakeText, fakePageLinks, note, UNSCALED_NOTE_ID, fakeWords, fakeSize, FAKE_UPLOAD_HEADROOM, uploadSteps, UPLOAD_ID_BASE, NOW, versionPageCount, baseVersions, CHILDREN, ALL_NOTES, noteSummary, pathTo, withItemCount } from "./fakeFixtures";

/** Upload ids, per module; the counter only grows. */
let uploadSeq = 0;

export const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface FakeApiOptions {
  /** Simulated latency per call, ms. Default 120. Set 0 in unit tests. */
  latencyMs?: number;
  /** Starting sync-version; a LiveChannel fake can bump the mirror separately. */
  syncVersion?: number;
}

/** The paired `.mark`'s one page is PDF page 2; its dims are the device panel, not the PDF page. */
function markMeta(): NoteMeta {
  const layers = layeredPageLayers(0);
  return {
    id: PDF_MARK_ID,
    name: "Appliance manual.pdf.mark",
    annotationsId: null,
    fileType: "mark",
    fileHash: "m".repeat(32) as NoteMeta["fileHash"],
    size: 28_349,
    pxPerMm: null,
    pages: [
      {
        index: 0,
        hash: "m".repeat(32) as PageRef["hash"],
        width: 1404,
        height: 1872,
        textHash: null,
        // A `.mark` imports no template, so no links of its own.
        linksHash: null,
        sourcePage: PDF_MARK_SOURCE_PAGE,
        hasInk: true,
        layers,
      },
    ],
  };
}

export function createFakeApi(opts: FakeApiOptions = {}): Api {
  const latency = opts.latencyMs ?? 120;
  const syncVersion = opts.syncVersion ?? 1;

  // Per-instance, seeded lazily; a restore rewrites the entry as the real supersede path does.
  const historyState = new Map<Id, FileVersion[]>();
  const historyFor = (id: Id): FileVersion[] => {
    let v = historyState.get(id);
    if (!v) {
      v = baseVersions(id);
      historyState.set(id, v);
    }
    return v;
  };

  return {
    async listFolder(parentId: Id | null): Promise<Listing> {
      await delay(latency);
      const key = parentId ?? "root";
      const entries = (CHILDREN[key] ?? []).map(withItemCount);
      return {
        folderId: parentId,
        // No counts on the breadcrumb, as the real control plane.
        path: pathTo(parentId),
        entries,
        syncVersion,
      };
    },

    async getNoteMeta(id: Id): Promise<NoteMeta> {
      await delay(latency);
      if (id === PDF_MARK_ID) return markMeta();
      const summary = ALL_NOTES[id];
      if (!summary) throw new Error(`no such note: ${id}`);
      return {
        annotationsId: id === MARKED_PDF_ID ? PDF_MARK_ID : null,
        id,
        name: summary.name,
        // Layers per note (same helper as the listing's `firstPage`); dims from the summary so a landscape meta agrees.
        pages: pages(
          id,
          summary.pageCount,
          summary.hasRecognizedText,
          { w: summary.firstPage.width, h: summary.firstPage.height },
          RECOGNIZED_FROM[String(id)],
        ).map((p) => (id === LAYERED_NOTE_ID ? withLayeredPageLayers(p) : p)),
        // A route reload lands here with only the id, and the reader branches on these.
        fileType: summary.fileType,
        fileHash: summary.fileHash,
        size: fakeSize(id, summary.pageCount),
        // N6-class (1404 px over 118.64 mm); `144` has recognition but no scale.
        pxPerMm: summary.id === UNSCALED_NOTE_ID ? null : 1404 / 118.64,
      };
    },

    async getPageBytes(_id: Id, page: PageRef): Promise<ArrayBuffer> {
      await delay(latency);
      if (_id === PDF_MARK_ID) {
        const payload = layeredPagePayload(0);
        if (payload) return payload.slice().buffer as ArrayBuffer;
      }
      if (_id === LAYERED_NOTE_ID) {
        const payload = layeredPagePayload(page.index);
        if (payload) return payload.slice().buffer as ArrayBuffer;
      }
      // The fake renderer paints from page.hash; these bytes are only stable and page-shaped.
      const seed = page.hash;
      const buf = new Uint8Array(16);
      for (let i = 0; i < buf.length; i++) buf[i] = seed.charCodeAt(i) & 0xff;
      return buf.buffer;
    },

    async getTemplate(_id: Id, _hash: string): Promise<Blob> {
      // No custom image templates in the fake; a call would be a fixture bug.
      await delay(latency);
      throw new Error("fake api has no custom image templates");
    },

    async getPageText(id: Id, page: PageRef): Promise<PageText> {
      await delay(latency);
      const summary = ALL_NOTES[id];
      if (!summary) throw new Error(`no such note: ${id}`);
      // Unrecognized page: empty result, not an error, as the real endpoint.
      if (page.textHash === null) return { text: "", words: [] };
      const text = fakeText(summary.name, page.index);
      return { text, words: fakeWords(text) };
    },

    async getPageLinks(id: Id, page: PageRef): Promise<PageLinks> {
      await delay(latency);
      const summary = noteSummary(id);
      if (!summary) throw new Error(`no such note: ${id}`);
      // No link block: empty, not an error, as the real endpoint.
      if (page.linksHash === null) return { links: [] };
      return { links: fakePageLinks(page, summary.pageCount) };
    },

    // --- history ---
    // `restoreVersion` re-points and retains the displaced current, so it is undoable.

    async noteHistory(id: Id): Promise<FileHistory> {
      await delay(latency);
      return { id, versions: historyFor(id).map((v) => ({ ...v })) };
    },

    async historyMeta(id: Id, md5: string): Promise<NoteMeta> {
      await delay(latency);
      const summary = ALL_NOTES[id];
      if (!summary) throw new Error(`no such note: ${id}`);
      // The version's own geometry (fewer pages); `fileHash` is the version md5; layers omitted.
      const count = versionPageCount(summary, md5);
      return {
        // Today's mark annotates the current blob, not this past one.
        annotationsId: null,
        id,
        name: summary.name,
        // No per-version links route, so no links in a preview.
        pages: pages(
          id,
          count,
          summary.hasRecognizedText,
          { w: summary.firstPage.width, h: summary.firstPage.height },
          RECOGNIZED_FROM[String(id)],
        ).map((p) => ({ ...p, linksHash: null })),
        fileType: summary.fileType,
        fileHash: md5,
        size: fakeSize(id, count),
        pxPerMm: summary.id === UNSCALED_NOTE_ID ? null : 1404 / 118.64,
      };
    },

    async historyPageBytes(_id: Id, md5: string, index: number): Promise<ArrayBuffer> {
      await delay(latency);
      // The PDF annotation preview decodes this for real, so serve the live mark payload rather than junk.
      if (_id === PDF_MARK_ID) {
        const payload = layeredPagePayload(0);
        if (payload) return payload.slice().buffer as ArrayBuffer;
      }
      const seed = `${md5}:${index}`;
      const buf = new Uint8Array(16);
      for (let i = 0; i < buf.length; i++) buf[i] = seed.charCodeAt(i % seed.length) & 0xff;
      return buf.buffer;
    },

    async historyPageText(id: Id, md5: string, index: number): Promise<PageText> {
      await delay(latency);
      const summary = ALL_NOTES[id];
      if (!summary) throw new Error(`no such note: ${id}`);
      // Same recognition spread as live, version-flavoured text so tests can tell the two apart.
      if (!summary.hasRecognizedText || fakeTextHash(id, index, true) === null) {
        return { text: "", words: [] };
      }
      const text = `Version ${md5.slice(0, 6)} — ${fakeText(summary.name, index)}`;
      return { text, words: fakeWords(text) };
    },

    async restoreVersion(id: Id, md5: string): Promise<RestoredVersion> {
      await delay(latency);
      const versions = historyFor(id);
      const target = versions.find((v) => v.md5 === md5);
      if (!target) throw new Error(`no such version: ${md5}`);
      // The displaced current is retained (undoable). Newest-first: restored, displaced, rest.
      const now = NOW;
      const restored: FileVersion = { md5, size: target.size, createdAt: now, current: true, pageCount: target.pageCount };
      const displaced = versions.filter((v) => v.current).map((v) => ({ ...v, current: false }));
      const rest = versions.filter((v) => !v.current && v.md5 !== md5).map((v) => ({ ...v, current: false }));
      historyState.set(id, [restored, ...displaced, ...rest]);
      return { md5, size: target.size, createdAt: now, current: true };
    },

    async historyRaw(id: Id, md5: string): Promise<ArrayBuffer> {
      await delay(latency);
      // Shape-only; e2e serves real bytes off the mocked route.
      const seed = `${id}:${md5}:raw`;
      const buf = new Uint8Array(16);
      for (let i = 0; i < buf.length; i++) buf[i] = seed.charCodeAt(i % seed.length) & 0xff;
      return buf.buffer;
    },

    // --- bin-scoped reads ---
    // The same generators as the live routes, keyed on the trashed id.

    async binPageText(id: Id, page: PageRef): Promise<PageText> {
      await delay(latency);
      const summary = noteSummary(id);
      if (!summary) throw new Error(`no such trashed note: ${id}`);
      if (page.textHash === null) return { text: "", words: [] };
      const text = fakeText(summary.name, page.index);
      return { text, words: fakeWords(text) };
    },

    async binNoteHistory(id: Id): Promise<FileHistory> {
      await delay(latency);
      return { id, versions: historyFor(id).map((v) => ({ ...v })) };
    },

    async binHistoryPageBytes(_id: Id, md5: string, index: number): Promise<ArrayBuffer> {
      await delay(latency);
      const seed = `${md5}:${index}`;
      const buf = new Uint8Array(16);
      for (let i = 0; i < buf.length; i++) buf[i] = seed.charCodeAt(i % seed.length) & 0xff;
      return buf.buffer;
    },

    async binHistoryPageText(id: Id, md5: string, index: number): Promise<PageText> {
      await delay(latency);
      const summary = noteSummary(id);
      if (!summary) throw new Error(`no such trashed note: ${id}`);
      if (!summary.hasRecognizedText || fakeTextHash(id, index, true) === null) {
        return { text: "", words: [] };
      }
      const text = `Version ${md5.slice(0, 6)} — ${fakeText(summary.name, index)}`;
      return { text, words: fakeWords(text) };
    },

    async binHistoryRaw(id: Id, md5: string): Promise<ArrayBuffer> {
      await delay(latency);
      const seed = `${id}:${md5}:raw`;
      const buf = new Uint8Array(16);
      for (let i = 0; i < buf.length; i++) buf[i] = seed.charCodeAt(i % seed.length) & 0xff;
      return buf.buffer;
    },

    // --- rename ---
    // In place: the entry objects are shared with `listFolder` and `ALL_NOTES`. A
    // same-name sibling is the real 409. Imported dynamically: no top-level
    // import of `client.ts` here.
    async rename(id: Id, name: string): Promise<Entry> {
      await delay(latency);
      for (const entries of Object.values(CHILDREN)) {
        const entry = entries.find((e) => e.id === id);
        if (!entry) continue;
        if (entries.some((e) => e !== entry && e.name === name)) {
          const { NameTakenError } = await import("./client");
          throw new NameTakenError();
        }
        entry.name = name;
        return { ...entry };
      }
      throw new Error(`no such entry: ${id}`);
    },

    // --- upload ---
    // Mutates the fixture tree and enforces the real refusals (415 type, 413
    // quota). Progress comes in size-scaled steps so Cancel is observable.
    async upload(
      folderId: Id | null,
      file: File,
      onProgress?: (fraction: number) => void,
      signal?: AbortSignal,
      onConflict: "rename" | "replace" = "rename",
    ): Promise<Entry> {
      const { UploadRefusedError, ApiError } = await import("./client");
      const destKey = folderId === null ? "root" : String(folderId);
      const siblings = CHILDREN[destKey];
      // Missing, foreign and trashed are one answer, as on the real route.
      if (!siblings) throw new ApiError("NOT_FOUND", "That folder isn't there any more.", 404);

      const name = file.name.trim();
      if (name === "" || name.includes("/") || name === "." || name === "..") {
        throw new UploadRefusedError("name", 400);
      }
      if (!isAcceptedUpload(name)) throw new UploadRefusedError("type", 415);
      if (file.size > FAKE_UPLOAD_HEADROOM) throw new UploadRefusedError("quota", 413);

      const steps = uploadSteps(file.size);
      for (let i = 1; i <= steps; i++) {
        await delay(latency);
        // Checked between steps, so a cancel lands mid-transfer like `xhr.abort()`.
        if (signal?.aborted) throw new ApiError("CANCELLED", "Upload cancelled.", 0);
        onProgress?.(i / steps);
      }

      // Replace supersedes in place: same id, new timestamp (the displaced blob becomes a version).
      const occupant =
        onConflict === "replace"
          ? siblings.find((e): e is NoteSummary => e.kind === "note" && e.name === name)
          : undefined;
      if (occupant) {
        occupant.updatedAt = Date.now();
        return { ...occupant };
      }
      // Otherwise a free name, from the same helper the conflict prompt previews with.
      const final = nextAvailableName(
        name,
        siblings.map((e) => e.name),
      );
      const id = String(UPLOAD_ID_BASE + ++uploadSeq) as Id;
      const entry = note(id, final, 1, Date.now(), { fileType: uploadExtension(final) || "note" });
      siblings.push(entry);
      ALL_NOTES[String(id)] = entry;
      return { ...entry };
    },

    // --- WRITES (append-only, at your own marker — see `types.ts`) ---
    // --- BIN WRITES ---
    // Separate module: a fixture cannot be declared inside this object literal.
    ...createBinFake(
      delay,
      latency,
      (id) => {
        const n = ALL_NOTES[id];
        return n
          ? {
              name: n.name,
              fileType: n.fileType,
              size: fakeSize(id, n.pageCount),
              pageCount: n.pageCount,
              // Recognition and shape survive trashing (blob-keyed index).
              recognized: n.hasRecognizedText,
              thumbAspect: n.thumbAspect,
            }
          : null;
      },
      // Trashing does not rewrite a blob, so the same md5 as the live listing.
      fakeFileHash,
    ),
    // --- ADMIN WRITES ---
    ...fakeAdminMethods(latency),

    // --- account (self-service) ---
    ...fakeAccountMethods(latency),
    ...fakeTodoMethods(latency),

    // Every `.note` is written on every page; a recognized one has text from
    // its first recognized page on, an unrecognized one has recognition off.
    async searchCoverage() {
      await delay(latency);
      return Object.values(ALL_NOTES)
        .filter((n) => n.fileType === "note")
        .map((n) => {
          const from = RECOGNIZED_FROM[n.id] ?? 0;
          const recognized = n.hasRecognizedText ? Math.max(0, n.pageCount - from) : 0;
          return { id: n.id, recognition: n.hasRecognizedText, written: n.pageCount, recognized, running: 0 };
        });
    },
  };
}
