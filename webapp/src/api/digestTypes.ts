// The person's digests, as the browser sees them: what the tablet's Digest app
// synced (`/api/controlplane/digests`). The browser changes a digest's typed
// comment and its category, moves it to the bin and back, and makes, renames
// and deletes categories; the tablet takes each at its next sync.

/** A category the person made, on the tablet or here. Uncategorized is not one: a digest with `categoryUid` "" is in it. */
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
  /**
   * Epoch ms of its last change, here or on the tablet. Not shown: it is how
   * two answers differ when an edit changed nothing else on screen.
   */
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

/** A comment as the server keeps and lists it: without the spaces, tabs and line breaks around it (`trimmed` in `handlers/digest.zig`). */
export function trimComment(text: string): string {
  return text.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
}

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

/** The app's own limit on a category's name, in characters (`CreateKnowledgeBaseDialog`). */
export const MAX_CATEGORY_NAME = 150;

/** What a category's name may not hold: what a file's name may not (the app's own rule). */
const BAD_NAME_CHARS = /[/<>*?|\\:"]/;

/**
 * Why the app would refuse `name` as a category's name, in a sentence; null
 * when it takes it. The server's rule (`cleanName` in `handlers/digest.zig`),
 * so the dialog says it before the server has to.
 */
export function categoryNameProblem(name: string): string | null {
  const t = name.trim();
  if (t === "") return "Give the category a name.";
  if ([...t].length > MAX_CATEGORY_NAME) return `A name holds at most ${MAX_CATEGORY_NAME} characters.`;
  if (t.startsWith(".")) return "A name can't start with a dot.";
  if (/[\u0000-\u001f\u007f]/.test(t)) return "A name can't hold a tab or a line break.";
  if (BAD_NAME_CHARS.test(t)) return 'A name can\'t hold / < > * ? | \\ : or ".';
  return null;
}

/** A digest in the bin: deleted here or on the tablet, kept until the bin's retention ends. */
export interface BinnedDigest {
  id: string;
  text: string;
  /** The category it was in; "" Uncategorized. */
  categoryUid: string;
  /** That category's name, live or deleted; null: Uncategorized, or gone for good. A restore puts the digest there. */
  categoryName: string | null;
  /** Epoch ms. */
  deletedAt: number;
  /** The tablet sent it back already, as a new digest: nothing to restore. */
  back: boolean;
}

export interface DigestBin {
  /** False when the server keeps no digests (`digest_sync` off). */
  enabled: boolean;
  /** The latest deleted first. */
  digests: BinnedDigest[];
  /** How long the bin keeps a digest; the files' bin's own window. */
  retentionDays: number;
}
