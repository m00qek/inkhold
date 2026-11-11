// Typed wrappers over the server's HTTP API. The HttpOnly `sn_session` cookie
// carries the session, so JS never sees a token. Every body is an envelope
// `{ success, errorCode?, errorMsg? }`; auth logic failures are HTTP 200 with
// `success:false`. `request()` turns every failure into a thrown `ApiError`.

import { challengeHash, md5Hex } from "./crypto";
import { parsePageLinks } from "../render/pdfWire";
import type { Api, PageLinks } from "./types";
import { ApiError, NameTakenError, UploadRefusedError, type UploadConflictMode } from "./errors";
import { type Envelope, rawFetch, request, statusError, TIMEOUT_AMBIGUOUS, UPLOAD_RESPONSE_MS, UPLOAD_STALL_MS } from "./request";
import { fileTypeFromName, normalizeAspect, normalizeEntry, normalizePage, normalizeWords } from "./normalize";
import type { Entry, Hash, Id, Listing, NoteMeta, PageRef, PageText, WordBox } from "../core/types";
import { adminMethods } from "./httpAdmin";
import { historyMethods } from "./httpHistory";
import { accountMethods } from "./httpAccount";
import { todoMethods } from "./httpTodo";
import { digestMethods } from "./httpDigest";

export {
  ApiError,
  NameTakenError,
  RateLimitError,
  UploadRefusedError,
  dispatchApiFailure,
  type ApiFailureSink,
  type UploadConflictMode,
  type UploadRefusal,
} from "./errors";
export { bytesBudget, rawFetch } from "./request";
export { fileTypeFromName, normalizeEntry, normalizeLayers, normalizePage } from "./normalize";

export interface LoginResult {
  /** A first-login "pending" session that can only reach change-password. */
  mustChangePassword: boolean;
}

export interface Me {
  email: string;
  isAdmin: boolean;
  mustChangePassword: boolean;
}

export interface ServerInfo {
  /** The server's LAN `host:port` for the Supernote; the browser cannot know it. */
  address: string;
  /** Only the bootstrap admin exists, still on its temporary password. Pre-auth on purpose. */
  firstRun: boolean;
}

export const api = {
  /** Login step 1: a single-use challenge code. */
  async requestChallenge(account: string): Promise<string> {
    const r = await request<{ randomCode: string }>("POST", "/api/official/user/query/random/code", { account });
    return r.randomCode;
  },

  /** Sets the `sn_session` cookie. No `equipmentNo`, which would make it a device login. */
  async login(account: string, plaintext: string): Promise<LoginResult> {
    const randomCode = await this.requestChallenge(account);
    const password = await challengeHash(plaintext, randomCode);
    const r = await request<{ mustChangePassword?: boolean }>(
      "POST",
      "/api/official/user/account/login/new",
      { account, password },
    );
    return { mustChangePassword: r.mustChangePassword ?? false };
  },

  /** The server revokes every session and sets a fresh full web session cookie. */
  async changePassword(newPlaintext: string): Promise<void> {
    await request("PUT", "/api/user/password", { newPassword: md5Hex(newPlaintext) });
  },

  async logout(): Promise<void> {
    await request("POST", "/api/user/logout", {});
  },

  /** The session profile, or null with no valid session (401/403, a 200 envelope failure, or 404). */
  async me(): Promise<Me | null> {
    try {
      const r = await request<Me>("GET", "/api/user/me");
      return { email: r.email, isAdmin: r.isAdmin, mustChangePassword: r.mustChangePassword };
    } catch (e) {
      if (e instanceof ApiError && [200, 401, 403, 404].includes(e.status)) return null;
      throw e;
    }
  },

  /** LAN address and first-run flag, pre-auth. Null when unreachable; callers degrade gracefully. */
  async serverInfo(): Promise<ServerInfo | null> {
    try {
      const r = await request<ServerInfo>("GET", "/api/controlplane/server-info");
      return { address: String(r.address ?? ""), firstRun: r.firstRun === true };
    } catch {
      return null;
    }
  },

  /** Own storage usage for the rail's quota bar; null hides the bar. */
  async usage(): Promise<{ used: number; total: number } | null> {
    try {
      const r = await request<{ used_bytes?: number; total_bytes?: number }>("GET", "/api/controlplane/usage");
      if (typeof r.used_bytes !== "number" || typeof r.total_bytes !== "number") return null;
      return { used: r.used_bytes, total: r.total_bytes };
    } catch {
      return null;
    }
  },
};

// --- the `Api` seam over the control-plane endpoints ----------------------------
// JSON here is raw VOs, no `{success}` envelope, so `request()` passes it through.
// Page bytes are binary and bypass `request()`; the immutable `?v={hash}` URL
// makes them browser-HTTP-cached.

export function createHttpApi(): Api {
  return {
    async listFolder(parentId: Id | null): Promise<Listing> {
      // Root omits `parent` (the canonical root request).
      const path = parentId == null
        ? "/api/controlplane/tree"
        : `/api/controlplane/tree?parent=${encodeURIComponent(parentId)}`;
      const r = await request<Listing>("GET", path);
      // `folderId` is omitted at the root; `?? null` keeps `folderId === null` the root test.
      return {
        folderId: r.folderId ?? null,
        path: r.path,
        entries: r.entries.map(normalizeEntry),
        syncVersion: r.syncVersion,
      };
    },

    async getNoteMeta(id: Id): Promise<NoteMeta> {
      const r = await request<NoteMeta>("GET", `/api/controlplane/file/metadata/${encodeURIComponent(id)}`);
      return {
        id: r.id,
        name: r.name,
        pages: r.pages.map(normalizePage),
        // Unknown type falls back to the name, never "note" (a blank reader).
        fileType: r.fileType ?? fileTypeFromName(r.name),
        fileHash: r.fileHash ?? null,
        size: r.size ?? 0,
        annotationsId: r.annotationsId ?? null,
        // Omitted unless the server verified this device's mm scale; `null` is a real answer.
        pxPerMm: typeof r.pxPerMm === "number" && r.pxPerMm > 0 ? r.pxPerMm : null,
      };
    },

    async getPageBytes(id: Id, page: PageRef): Promise<ArrayBuffer> {
      // Immutable versioned URL, so repeat views hit the browser HTTP cache.
      const url = `/note/${encodeURIComponent(id)}/page/${page.index}?v=${encodeURIComponent(page.hash)}`;
      return (await rawFetch(url)).arrayBuffer();
    },

    async getTemplate(id: Id, hash: Hash): Promise<Blob> {
      // Content-addressed by asset hash, so immutable; Blob for `createImageBitmap`.
      const url = `/note/${encodeURIComponent(id)}/template/${encodeURIComponent(hash)}`;
      return (await rawFetch(url)).blob();
    },

    async getPageText(id: Id, page: PageRef): Promise<PageText> {
      if (page.textHash === null) return { text: "", words: [] };

      // Versioned by `textHash`, so the immutable URL turns over with the transcript;
      // `rawFetch` so a 404 is STALE_PAGE.
      const url = `/note/${encodeURIComponent(id)}/page/${page.index}/text?v=${encodeURIComponent(page.textHash)}`;
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

    async getPageLinks(id: Id, page: PageRef): Promise<PageLinks> {
      // Only pages rasterised from an imported PDF carry links.
      if (page.linksHash === null) return { links: [] };

      // Versioned by `linksHash`; `rawFetch` so a 404 is STALE_PAGE.
      const url = `/note/${encodeURIComponent(id)}/page/${page.index}/links?v=${encodeURIComponent(page.linksHash)}`;
      const res = await rawFetch(url);

      // Validated by the PDF decoder's own parser: one set of rules for what a link is.
      const text = await res.text();
      const raw: unknown = (() => {
        try {
          return JSON.parse(text) as unknown;
        } catch {
          return null;
        }
      })();
      if (raw !== null && typeof raw === "object" && (raw as { success?: boolean }).success === false) {
        const b = raw as { errorCode?: string; errorMsg?: string };
        throw new ApiError(b.errorCode ?? "ERROR", b.errorMsg ?? "Something went wrong.", res.status);
      }
      const list = (raw as { links?: unknown } | null)?.links;
      return { links: parsePageLinks(JSON.stringify(list ?? [])) };
    },

    // --- WRITES (append-only, at your own marker — see `types.ts`) ---
    // --- BIN WRITES ---
    //
    // Every field the UI treats as `X | null` is defaulted here, since the server omits nulls.

    async listBin(): Promise<import("../core/binTypes").Bin> {
      const r = await request<{
        entries?: {
          kind?: string;
          id?: string;
          name?: string;
          path?: string;
          deletedAt?: number;
          size?: number;
          parentId?: string;
          isRoot?: boolean;
          fileType?: string;
          fileHash?: string;
          firstPage?: PageRef;
          thumbAspect?: { w?: number; h?: number };
        }[];
        totalBytes?: number;
        retentionDays?: number;
        syncVersion?: number;
      }>("GET", "/api/controlplane/bin");
      return {
        entries: (r.entries ?? []).map((e) => ({
          kind: e.kind === "folder" ? ("folder" as const) : ("note" as const),
          id: String(e.id ?? ""),
          name: e.name ?? "",
          path: e.path ?? "",
          deletedAt: typeof e.deletedAt === "number" ? e.deletedAt : 0,
          // A missing size is 0, so it cannot inflate what the purge dialog promises to free.
          size: typeof e.size === "number" && Number.isFinite(e.size) ? e.size : 0,
          parentId: e.parentId ?? null,
          isRoot: e.isRoot !== false,
          fileType: e.kind === "folder" ? "" : (e.fileType ?? fileTypeFromName(e.name ?? "")),
          fileHash: e.fileHash ?? null,
          // Omitted means nothing renderable; the row draws its doc glyph.
          firstPage: e.firstPage ? normalizePage(e.firstPage) : null,
          thumbAspect: normalizeAspect(e.thumbAspect),
        })),
        totalBytes: typeof r.totalBytes === "number" ? r.totalBytes : 0,
          // A floor only; the number is the server's and quoted verbatim.
        retentionDays: typeof r.retentionDays === "number" && r.retentionDays > 0 ? r.retentionDays : 30,
        syncVersion: typeof r.syncVersion === "number" ? r.syncVersion : 0,
      };
    },

    async getBinNoteMeta(id: Id): Promise<NoteMeta> {
      // Same `NoteMetaVO` as `getNoteMeta`, so the same normalization (null `pxPerMm` = no text layer).
      const r = await request<NoteMeta>("GET", `/api/controlplane/bin/file/metadata/${encodeURIComponent(id)}`);
      return {
        // Trashing a PDF does not trash its mark, so the bin never pairs.
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

    async getBinPageBytes(id: Id, page: PageRef): Promise<ArrayBuffer> {
      // The live route under `/api/controlplane/bin`, same `?v=` contract.
      const url = `/api/controlplane/bin/note/${encodeURIComponent(id)}/page/${page.index}?v=${encodeURIComponent(page.hash)}`;
      return (await rawFetch(url)).arrayBuffer();
    },

    async trashEntry(id: Id): Promise<import("../core/binTypes").Trashed> {
      const r = await request<{ id?: string; name?: string; isFolder?: boolean; entries?: number }>(
        "DELETE",
        `/api/controlplane/entry/${encodeURIComponent(id)}`,
      );
      return {
        id: String(r.id ?? id),
        name: r.name ?? "",
        isFolder: r.isFolder === true,
        // Never below 1, or the undo toast would claim nothing happened.
        entries: typeof r.entries === "number" && r.entries > 0 ? Math.floor(r.entries) : 1,
      };
    },

    async restoreEntry(id: Id): Promise<import("../core/binTypes").Restored> {
      const r = await request<{ name?: string; renamed?: boolean; ancestors?: number; descendants?: number }>(
        "POST",
        `/api/controlplane/bin/${encodeURIComponent(id)}/restore`,
      );
      return {
        name: r.name ?? "",
        // Absent reads as "kept its name".
        renamed: r.renamed === true,
        ancestors: typeof r.ancestors === "number" && r.ancestors > 0 ? Math.floor(r.ancestors) : 0,
        descendants: typeof r.descendants === "number" && r.descendants > 0 ? Math.floor(r.descendants) : 0,
      };
    },

    async purgeEntry(id: Id): Promise<void> {
      await request("DELETE", `/api/controlplane/bin/${encodeURIComponent(id)}`);
    },

    async emptyBin(): Promise<number> {
      const r = await request<{ entries?: number }>("DELETE", "/api/controlplane/bin");
      return typeof r.entries === "number" && r.entries > 0 ? Math.floor(r.entries) : 0;
    },

    ...adminMethods,

    ...historyMethods,

    // --- RENAME (control-plane) ---
    async rename(id: Id, name: string): Promise<Entry> {
      // Answers a raw `EntryVO`, normalized like a listing entry.
      try {
        const r = await request<Entry>(
          "POST",
          `/api/controlplane/entry/${encodeURIComponent(id)}/rename`,
          { name },
        );
        return normalizeEntry(r);
      } catch (e) {
        // A sibling clash is the dialog's to handle; everything else routes as usual.
        if (e instanceof ApiError && e.status === 409) throw new NameTakenError();
        throw e;
      }
    },

    // --- UPLOAD (control-plane) ---
    upload(
      folderId: Id | null,
      file: File,
      onProgress?: (fraction: number) => void,
      signal?: AbortSignal,
      onConflict: UploadConflictMode = "rename",
    ): Promise<Entry> {
      // XHR, not fetch: only `xhr.upload` reports bytes sent. Its status handling
      // restates `request()`'s, in the same order.
      return new Promise<Entry>((resolve, reject) => {
        const form = new FormData();
        // One part named `file`; the server sanitizes the name (400 if nothing survives).
        form.append("file", file, file.name);

        const xhr = new XMLHttpRequest();
        // `root` sentinel for the library root; `onConflict` is a query param the server defaults to `rename`.
        const query = onConflict === "rename" ? "" : `?onConflict=${encodeURIComponent(onConflict)}`;
        xhr.open("POST", `/api/controlplane/folder/${encodeURIComponent(folderId ?? "root")}/upload${query}`);
        xhr.withCredentials = true;
        xhr.responseType = "text";
        // No `xhr.timeout`: a total cap fails big uploads. The budget is silence.
        let stalled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const disarm = (): void => {
          if (timer !== undefined) clearTimeout(timer);
          timer = undefined;
        };
        /** Every byte that leaves restarts the countdown. */
        const arm = (ms: number): void => {
          disarm();
          timer = setTimeout(() => {
            stalled = true;
            xhr.abort();
          }, ms);
        };

        // Cancel must stop sending: a completed abandoned upload would still create the file.
        const onAbort = (): void => xhr.abort();
        signal?.addEventListener("abort", onAbort);
        const cleanup = (): void => {
          disarm();
          signal?.removeEventListener("abort", onAbort);
        };

        // Always bound: this is the liveness signal, progress reporting is extra.
        xhr.upload.onprogress = (e: ProgressEvent): void => {
          arm(UPLOAD_STALL_MS);
          if (onProgress && e.lengthComputable && e.total > 0) onProgress(Math.min(1, e.loaded / e.total));
        };
        // After the last byte no progress arrives; switch to the answer budget.
        xhr.upload.onload = (): void => arm(UPLOAD_RESPONSE_MS);

        xhr.onerror = (): void => {
          cleanup();
          reject(new ApiError("NETWORK", "Can't reach the server. Check your connection and try again.", 0));
        };
        xhr.ontimeout = (): void => {
          cleanup();
          // Ambiguous: the file may have landed.
          reject(new ApiError("TIMEOUT", TIMEOUT_AMBIGUOUS, 0));
        };
        xhr.onabort = (): void => {
          cleanup();
          // A stall aborts like a user does; `stalled` tells them apart.
          if (stalled) return reject(new ApiError("TIMEOUT", TIMEOUT_AMBIGUOUS, 0));
          reject(new ApiError("CANCELLED", "Upload cancelled.", 0));
        };
        xhr.onload = (): void => {
          cleanup();
          const status = xhr.status;
          if (status === 413) return reject(new UploadRefusedError("quota", 413));
          if (status === 415) return reject(new UploadRefusedError("type", 415));
          if (status === 400) return reject(new UploadRefusedError("name", 400));
          // Not via `statusError`, which would read 404 as STALE_PAGE.
          if (status === 404) {
            return reject(new ApiError("NOT_FOUND", "That folder isn't there any more.", 404));
          }
          const known = statusError(status);
          if (known) return reject(known);
          let body: (Entry & Envelope) | null = null;
          try {
            body = JSON.parse(xhr.responseText) as Entry & Envelope;
          } catch {
            body = null;
          }
          if (body && (body as Envelope).success === false) {
            const env = body as Envelope;
            return reject(new ApiError(env.errorCode ?? "ERROR", env.errorMsg ?? "Something went wrong.", status));
          }
          if (status < 200 || status >= 300 || body === null) {
            return reject(new ApiError("SERVER", "The server returned an unexpected response.", status));
          }
          // A raw `EntryVO`, like `rename`.
          resolve(normalizeEntry(body));
        };

        // Aborting before `send` makes `send` throw, so answer directly.
        if (signal?.aborted) {
          cleanup();
          reject(new ApiError("CANCELLED", "Upload cancelled.", 0));
          return;
        }
        arm(UPLOAD_STALL_MS); // a connection that never sends a byte still ends
        xhr.send(form);
      });
    },

    async searchCoverage() {
      const r = await request<{ notes?: { id: string; recognition: boolean; written: number; recognized: number; running: number }[] }>(
        "GET",
        "/api/controlplane/search-index/coverage",
      );
      return (r.notes ?? []).map((n) => ({ id: String(n.id), recognition: n.recognition, written: n.written, recognized: n.recognized, running: n.running }));
    },

    ...accountMethods,
    ...todoMethods,
    ...digestMethods,
  };
}
