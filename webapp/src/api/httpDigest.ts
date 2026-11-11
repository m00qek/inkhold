// The person's digests over HTTP (`/api/controlplane/digests…`).

import { rawFetch, request } from "./request";
import type { Digest, DigestSnapshot, DigestSourceKind } from "./digestTypes";

type Raw = Partial<{
  enabled: boolean;
  categories: { uid?: string; name?: string }[];
  digests: {
    id?: number | string; text?: string; comment?: string; categoryUid?: string; author?: string; createdAt?: number;
    source?: { kind?: string; path?: string; fileId?: number | string; page?: number };
    note?: string;
    waiting?: boolean;
  }[];
  tabletSyncedAt: number;
  waiting: boolean;
}>;

const KINDS: readonly DigestSourceKind[] = ["document", "note", "manual", "other"];

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const id = (v: unknown): string | null => (typeof v === "number" || (typeof v === "string" && v !== "") ? String(v) : null);

/** The server omits null optionals: absent is "none". */
export function digestsOf(r: Raw): DigestSnapshot {
  return {
    enabled: r.enabled === true,
    categories: (r.categories ?? []).flatMap((c) => (str(c.uid) ? [{ uid: c.uid!, name: c.name ?? "" }] : [])),
    digests: (r.digests ?? []).flatMap((d): Digest[] => {
      const key = id(d.id);
      if (key === null) return [];
      const s = d.source ?? {};
      const kind = KINDS.find((k) => k === s.kind) ?? "other";
      const page = num(s.page);
      return [{
        id: key,
        text: d.text ?? "",
        comment: str(d.comment),
        categoryUid: d.categoryUid ?? "",
        author: str(d.author),
        createdAt: num(d.createdAt) ?? 0,
        source: { kind, path: kind === "manual" ? null : str(s.path), fileId: id(s.fileId), page: page !== null && page >= 1 ? page : null },
        note: str(d.note),
        waiting: d.waiting === true,
      }];
    }),
    tabletSyncedAt: num(r.tabletSyncedAt),
    waiting: r.waiting === true,
  };
}

const enc = encodeURIComponent;

export const digestMethods = {
  // --- DIGEST ---
  async digests(): Promise<DigestSnapshot> {
    return digestsOf(await request<Raw>("GET", "/api/controlplane/digests"));
  },
  async digestSetComment(id: string, comment: string): Promise<void> {
    await request("PUT", `/api/controlplane/digests/${enc(id)}`, { comment });
  },
  async digestNoteBytes(id: string, md5: string): Promise<ArrayBuffer> {
    // No `?v=`: `:md5` already pins the note.
    return (await rawFetch(`/api/controlplane/digests/${enc(id)}/note/${enc(md5)}`)).arrayBuffer();
  },
};
