// The person's digests over HTTP (`/api/controlplane/digests…`).

import { rawFetch, request } from "./request";
import type { BinnedDigest, Digest, DigestBin, DigestCategory, DigestEdit, DigestSnapshot, DigestSource, DigestSourceKind } from "./digestTypes";

type RawSource = { kind?: string; path?: string; fileId?: number | string; page?: number; changed?: boolean };

type Raw = Partial<{
  enabled: boolean;
  categories: { uid?: string; name?: string }[];
  digests: {
    id?: number | string; text?: string; comment?: string; categoryUid?: string; author?: string; createdAt?: number; modifiedAt?: number;
    source?: RawSource;
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
  const categories = (r.categories ?? []).flatMap((c) => (str(c.uid) ? [{ uid: c.uid!, name: c.name ?? "" }] : []));
  const known = new Set(categories.map((c) => c.uid));
  return {
    enabled: r.enabled === true,
    categories,
    digests: (r.digests ?? []).flatMap((d): Digest[] => {
      const key = id(d.id);
      if (key === null) return [];
      return [{
        id: key,
        text: d.text ?? "",
        comment: str(d.comment),
        // A category the listing doesn't name is no place to show: Uncategorized, as the tablet does.
        // The server may still hold the gone uid; Move to… Uncategorized then reads as done, as on the tablet.
        categoryUid: d.categoryUid && known.has(d.categoryUid) ? d.categoryUid : "",
        author: str(d.author),
        createdAt: num(d.createdAt) ?? 0,
        modifiedAt: num(d.modifiedAt) ?? num(d.createdAt) ?? 0,
        source: sourceOf(d.source),
        note: str(d.note),
        waiting: d.waiting === true,
      }];
    }),
    tabletSyncedAt: num(r.tabletSyncedAt),
    waiting: r.waiting === true,
  };
}

function sourceOf(s: RawSource = {}): DigestSource {
  const kind = KINDS.find((k) => k === s.kind) ?? "other";
  const page = num(s.page);
  return { kind, path: kind === "manual" ? null : str(s.path), fileId: id(s.fileId), page: page !== null && page >= 1 ? page : null, changed: s.changed === true };
}

type RawBin = Partial<{
  enabled: boolean;
  retentionDays: number;
  digests: {
    id?: number | string; text?: string; categoryUid?: string; categoryName?: string; deletedAt?: number; back?: boolean;
  }[];
}>;

export function digestBinOf(r: RawBin): DigestBin {
  return {
    enabled: r.enabled === true,
    retentionDays: num(r.retentionDays) ?? 0,
    digests: (r.digests ?? []).flatMap((d): BinnedDigest[] => {
      const key = id(d.id);
      if (key === null) return [];
      return [{
        id: key,
        text: d.text ?? "",
        categoryUid: d.categoryUid ?? "",
        categoryName: str(d.categoryName),
        deletedAt: num(d.deletedAt) ?? 0,
        back: d.back === true,
      }];
    }),
  };
}

const enc = encodeURIComponent;

export const digestMethods = {
  // --- DIGEST ---
  async digests(): Promise<DigestSnapshot> {
    return digestsOf(await request<Raw>("GET", "/api/controlplane/digests"));
  },
  async digestEdit(id: string, change: DigestEdit): Promise<void> {
    await request("PUT", `/api/controlplane/digests/${enc(id)}`, change);
  },
  async digestNoteBytes(id: string, md5: string): Promise<ArrayBuffer> {
    // No `?v=`: `:md5` already pins the note.
    return (await rawFetch(`/api/controlplane/digests/${enc(id)}/note/${enc(md5)}`)).arrayBuffer();
  },
  async digestDelete(id: string): Promise<void> {
    await request("DELETE", `/api/controlplane/digests/${enc(id)}`);
  },
  async digestCreateCategory(name: string): Promise<DigestCategory> {
    const r = await request<{ uid?: string; name?: string }>("POST", "/api/controlplane/digests/categories", { name });
    return { uid: r.uid ?? "", name: r.name ?? name };
  },
  async digestRenameCategory(uid: string, name: string): Promise<void> {
    await request("PUT", `/api/controlplane/digests/categories/${enc(uid)}`, { name });
  },
  async digestDeleteCategory(uid: string): Promise<number> {
    return num((await request<{ digests?: number }>("DELETE", `/api/controlplane/digests/categories/${enc(uid)}`)).digests) ?? 0;
  },
  async digestBin(): Promise<DigestBin> {
    return digestBinOf(await request<RawBin>("GET", "/api/controlplane/digests/bin"));
  },
  async digestRestore(id: string): Promise<void> {
    await request("POST", `/api/controlplane/digests/bin/${enc(id)}/restore`);
  },
  async digestPurge(id: string): Promise<void> {
    await request("DELETE", `/api/controlplane/digests/bin/${enc(id)}`);
  },
};
