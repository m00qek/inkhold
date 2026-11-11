// The person's digests, as the browser sees them: what the tablet's Digest app
// synced (`/api/controlplane/digests`). Read only: the tablet is their writer.

/** A category the person made on the tablet. Uncategorized is not one: a digest with `categoryUid` "" is in it. */
export interface DigestCategory {
  uid: string;
  name: string;
}

/** What a digest was taken from. */
export type DigestSourceKind = "document" | "note" | "manual" | "other";

export interface DigestSource {
  kind: DigestSourceKind;
  /** The file's path under the tablet's storage (`MyStyle/Français/a.pdf`); null for a manual entry. */
  path: string | null;
  /** That file in the library; null when it is not there (not synced, or moved since). */
  fileId: string | null;
  /** 1-based; null when the tablet did not say. */
  page: number | null;
}

export interface Digest {
  id: string;
  /** The passage, or the handwriting converted to text. */
  text: string;
  /** The typed comment; null: none. */
  comment: string | null;
  /** "" is Uncategorized. */
  categoryUid: string;
  author: string | null;
  /** Epoch ms, by the tablet's clock. */
  createdAt: number;
  source: DigestSource;
  /** The handwritten note's md5, which names its page; null: none. */
  note: string | null;
}

export interface DigestSnapshot {
  /** False when the server keeps no digests (`digest_sync` off); everything else is empty then. */
  enabled: boolean;
  categories: DigestCategory[];
  /** In the order the tablet made them. */
  digests: Digest[];
}
