// Version history over HTTP, live and bin-scoped.

import { historyFileUrl } from "../core/fileKind";
import { ApiError } from "./errors";
import { rawFetch, request } from "./request";
import { fileTypeFromName, normalizePage, normalizeVersion, normalizeWords } from "./normalize";
import { type FileHistory, type FileVersion, type Hash, type Id, type NoteMeta, type PageRef, type PageText, type RestoredVersion, type WordBox } from "../core/types";

export const historyMethods = {
  // --- HISTORY (hot-cache versioning) ---
  //
  // Raw VOs; `fail()` (404 no-such-version, 507 over-quota) still arrives as `ApiError`.

  async noteHistory(id: Id): Promise<FileHistory> {
    const r = await request<{ id?: string; versions?: unknown[] }>(
      "GET",
      `/api/controlplane/note/${encodeURIComponent(id)}/history`,
    );
    return {
      id: r.id ?? id,
      // Server order, never re-sorted: a `createdAt` tie could misplace the live row.
      versions: (Array.isArray(r.versions) ? r.versions : [])
        .map((v) => normalizeVersion(v as Record<string, unknown>))
        .filter((v): v is FileVersion => v !== null),
    };
  },

  async historyMeta(id: Id, md5: Hash): Promise<NoteMeta> {
    // The version's own page list (retained `note_index`), so a preview has its real geometry.
    const r = await request<NoteMeta>(
      "GET",
      `/api/controlplane/note/${encodeURIComponent(id)}/history/${encodeURIComponent(md5)}/meta`,
    );
    return {
      // Today's mark annotates the current blob, not this past one.
      annotationsId: null,
      id: r.id,
      name: r.name,
      pages: r.pages.map(normalizePage),
      fileType: r.fileType ?? fileTypeFromName(r.name),
      fileHash: r.fileHash ?? null,
      size: r.size ?? 0,
      pxPerMm: typeof r.pxPerMm === "number" && r.pxPerMm > 0 ? r.pxPerMm : null,
    };
  },

  async historyPageBytes(id: Id, md5: Hash, index: number): Promise<ArrayBuffer> {
    // No `?v=`: `:md5` already pins the immutable blob.
    const url = `/api/controlplane/note/${encodeURIComponent(id)}/history/${encodeURIComponent(md5)}/page/${index}`;
    return (await rawFetch(url)).arrayBuffer();
  },

  async historyPageText(id: Id, md5: Hash, index: number): Promise<PageText> {
    // Same `{ text, words }` VO as `getPageText`; no `?v=`, `:md5` pins the version.
    const url = `/api/controlplane/note/${encodeURIComponent(id)}/history/${encodeURIComponent(md5)}/page/${index}/text`;
    const res = await rawFetch(url);

    let body: {
      text?: string;
      words?: WordBox[];
      success?: boolean;
      errorCode?: string;
      errorMsg?: string;
    };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw new ApiError("SERVER", "The server returned an unexpected response.", res.status);
    }
    if (body && body.success === false) {
      throw new ApiError(body.errorCode ?? "ERROR", body.errorMsg ?? "Something went wrong.", res.status);
    }
    return { text: body?.text ?? "", words: normalizeWords(body?.words) };
  },

  async restoreVersion(id: Id, md5: Hash): Promise<RestoredVersion> {
    // A 507 (over quota) throws `QUOTA_EXCEEDED`; the restore changed nothing.
    const r = await request<{ md5?: string; size?: number; createdAt?: number }>(
      "POST",
      `/api/controlplane/note/${encodeURIComponent(id)}/history/${encodeURIComponent(md5)}/restore`,
    );
    return {
      // The restored md5 is the requested one; fall back to it if omitted.
      md5: typeof r.md5 === "string" && r.md5 !== "" ? r.md5 : md5,
      size: typeof r.size === "number" && Number.isFinite(r.size) && r.size > 0 ? Math.floor(r.size) : 0,
      createdAt: typeof r.createdAt === "number" && Number.isFinite(r.createdAt) && r.createdAt > 0 ? r.createdAt : 0,
      current: true,
    };
  },

  async historyRaw(id: Id, md5: Hash): Promise<ArrayBuffer> {
    // No `?v=`: `:md5` pins the version. `historyFileUrl` owns the route shape.
    const url = historyFileUrl(id, md5);
    if (url === null) throw new Error("historyRaw requires an md5");
    return (await rawFetch(url)).arrayBuffer();
  },

  // --- bin-scoped reads ---
  // The live routes under `/api/controlplane/bin`; a trashed file's transcript and
  // history are retained, so bodies match their live twins.

  async binPageText(id: Id, page: PageRef): Promise<PageText> {
    // No `?v=` and no `textHash` short-circuit: the server resolves the trashed file's md5.
    const url = `/api/controlplane/bin/note/${encodeURIComponent(id)}/page/${page.index}/text`;
    const res = await rawFetch(url);
    let body: { text?: string; words?: WordBox[]; success?: boolean; errorCode?: string; errorMsg?: string };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw new ApiError("SERVER", "The server returned an unexpected response.", res.status);
    }
    if (body && body.success === false) {
      throw new ApiError(body.errorCode ?? "ERROR", body.errorMsg ?? "Something went wrong.", res.status);
    }
    return { text: body?.text ?? "", words: normalizeWords(body?.words) };
  },

  async binNoteHistory(id: Id): Promise<FileHistory> {
    const r = await request<{ id?: string; versions?: unknown[] }>(
      "GET",
      `/api/controlplane/bin/note/${encodeURIComponent(id)}/history`,
    );
    return {
      id: r.id ?? id,
      versions: (Array.isArray(r.versions) ? r.versions : [])
        .map((v) => normalizeVersion(v as Record<string, unknown>))
        .filter((v): v is FileVersion => v !== null),
    };
  },

  async binHistoryPageBytes(id: Id, md5: Hash, index: number): Promise<ArrayBuffer> {
    const url = `/api/controlplane/bin/note/${encodeURIComponent(id)}/history/${encodeURIComponent(md5)}/page/${index}`;
    return (await rawFetch(url)).arrayBuffer();
  },

  async binHistoryPageText(id: Id, md5: Hash, index: number): Promise<PageText> {
    const url = `/api/controlplane/bin/note/${encodeURIComponent(id)}/history/${encodeURIComponent(md5)}/page/${index}/text`;
    const res = await rawFetch(url);
    let body: { text?: string; words?: WordBox[]; success?: boolean; errorCode?: string; errorMsg?: string };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw new ApiError("SERVER", "The server returned an unexpected response.", res.status);
    }
    if (body && body.success === false) {
      throw new ApiError(body.errorCode ?? "ERROR", body.errorMsg ?? "Something went wrong.", res.status);
    }
    return { text: body?.text ?? "", words: normalizeWords(body?.words) };
  },

  async binHistoryRaw(id: Id, md5: Hash): Promise<ArrayBuffer> {
    const url = historyFileUrl(id, md5, { bin: true });
    if (url === null) throw new Error("binHistoryRaw requires an md5");
    return (await rawFetch(url)).arrayBuffer();
  },
};
