// The person's digests, as the browser sees them: what the tablet's Digest app
// synced (`/api/controlplane/digests`). The browser changes two things, a
// digest's typed comment and its category, which the tablet takes at its next sync.

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
  /** The library's file is not the size it was when the passage was taken: the page may no longer hold it. */
  changed: boolean;
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
  /** Epoch ms of its last change, here or on the tablet. */
  modifiedAt: number;
  source: DigestSource;
  /** The handwritten note's md5, which names its page; null: none. */
  note: string | null;
  /** Its comment or category changed here and no tablet has fetched it yet. */
  waiting: boolean;
}

/** What an edit changes; an absent field stays. */
export interface DigestEdit {
  /** "" removes the comment. */
  comment?: string;
  /** A category's uid; "" is Uncategorized. */
  categoryUid?: string;
}

/** The app's own limit on a comment, in characters. */
export const MAX_COMMENT = 2000;

export interface DigestSnapshot {
  /** False when the server keeps no digests (`digest_sync` off); everything else is empty then. */
  enabled: boolean;
  categories: DigestCategory[];
  /** In the order the tablet made them. */
  digests: Digest[];
  /** When a tablet last asked for these digests; null: never. */
  tabletSyncedAt: number | null;
  /** Something changed here that no tablet has fetched yet. */
  waiting: boolean;
}
