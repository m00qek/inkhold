// The browse/read/write surface of the server API, as an interface so the UI
// runs against a fake (dev + tests) or the real HTTP client. Auth lives in
// client.ts. No search lives here: the browser fetches `text/<md5>` indexes
// and answers every query itself (`src/search/`).
//
//   listFolder   → GET /api/controlplane/tree?parent={id}
//   getNoteMeta  → GET /api/controlplane/file/metadata/{id}
//   getPageBytes → GET /note/{id}/page/{n}?v={hash}           (immutable)
//   getPageText  → GET /note/{id}/page/{n}/text?v={textHash}  (immutable)
//   getPageLinks → GET /note/{id}/page/{n}/links?v={linksHash}

import type { PdfLink } from "../core/types";
import type { Entry, FileHistory, Hash, Id, Listing, NoteMeta, PageRef, PageText, RestoredVersion } from "../core/types";
import type { Bin, Restored, Trashed } from "../core/binTypes";
import type { AccountSecurity, MyDevice, StorageBreakdown, VersionPolicy, VersionPolicyChange } from "./accountTypes";
import type { NewTodoTask, TodoSnapshot, TodoTaskPatch } from "./todoTypes";
import type { DigestEdit, DigestSnapshot } from "./digestTypes";
import type { AdminDevice, AdminHealth, AdminQuota, AdminRetention, AdminUser, AdminBackups, BackupNotice } from "./adminTypes";
import type { UploadConflictMode } from "./client";

/** One page's links. An object, not a bare array, so the wire can gain fields. */
export interface PageLinks {
  links: readonly PdfLink[];
}

export interface Api {
  /** List one folder's immediate children. `null` = the user's root. */
  listFolder(parentId: Id | null): Promise<Listing>;

  /** The full page list for a note (opened in the reader). */
  getNoteMeta(id: Id): Promise<NoteMeta>;

  /**
   * The raw `.note` byte-range for one page, for the renderer to decode.
   * `?v={page.hash}` makes it immutable, so the HTTP cache serves repeats.
   */
  getPageBytes(id: Id, page: PageRef): Promise<ArrayBuffer>;

  /**
   * A page's custom image template (`GET /note/{id}/template/{hash}`),
   * content-addressed and immutable. Built-in RATTA_RLE templates never use it.
   */
  getTemplate(id: Id, hash: Hash): Promise<Blob>;

  /**
   * A page's recognition: transcript plus positioned words (mm). Lazy: call
   * only when the text panel shows the page. Keyed by `page.textHash`, not
   * `page.hash`; resolves empty without a request when `textHash` is null.
   */
  getPageText(id: Id, page: PageRef): Promise<PageText>;

  /**
   * The links a PDF template brought to this page (`note-format.md` §14), as
   * {@link PdfLink}; the server converts §14's 1-based page and `none` to
   * 0-based and -1. Rects are in device panel pixels (a PDF's are points).
   * Lazy and keyed by `page.linksHash`; empty without a request when null.
   */
  getPageLinks(id: Id, page: PageRef): Promise<PageLinks>;

  // ---------------------------------------------------------------------------
  // Writes. Each feature appends under its own marker so parallel edits stay
  // disjoint; vocabularies come in via inline `import(...)` types for the same
  // reason. Any write may fail with `ELEVATION_REQUIRED` (428): route it through
  // `dispatchApiFailure` to the gate, never treat it as a dead session.
  //
  // --- BIN WRITES ---
  // (Two bin-scoped reads live here too.)

  /**
   * Every trashed entry, newest deletion first, plus the retention window and
   * byte total. Flat by contract; nesting is derived client-side.
   */
  listBin(): Promise<Bin>;

  /**
   * {@link getNoteMeta} for a trashed note. A separate route because the live
   * `Files.get` hardcodes `deleted = 0` as the shared ownership check; this one
   * sees trashed rows only.
   */
  getBinNoteMeta(id: Id): Promise<NoteMeta>;

  /** {@link getPageBytes} for a trashed note. See {@link getBinNoteMeta}. */
  getBinPageBytes(id: Id, page: PageRef): Promise<ArrayBuffer>;

  /**
   * Move a live entry to the bin; a folder takes its subtree, so the response
   * states the fanout. Reversible: offer undo, not a confirm.
   */
  trashEntry(id: Id): Promise<Trashed>;

  /** Bring a trashed entry back; the result reports what it actually did. */
  restoreEntry(id: Id): Promise<Restored>;

  /**
   * Permanently destroy one trashed entry and its subtree. A live id is a 404,
   * not a hard delete.
   */
  purgeEntry(id: Id): Promise<void>;

  /** Destroy everything in the bin. Returns how many rows went. */
  emptyBin(): Promise<number>;

  // --- ADMIN WRITES ---
  // All `require_admin` (is_admin and a live elevation) except elevate/lock, so
  // any may answer 428; `pages/admin/admin.ts` handles the gate and retry.

  /** Every household account. Admin-only even as a read. */
  adminListUsers(): Promise<AdminUser[]>;

  /**
   * Create an account and return the server-generated temporary password. It
   * exists only in this response (the server stores a hash), so hand-over is
   * part of the flow.
   */
  adminCreateUser(email: string, isAdmin: boolean): Promise<string>;

  /** Permanently delete an account. Refused for the last admin (`LAST_ADMIN`). */
  adminDeleteUser(id: number): Promise<void>;

  /**
   * Reset to a fresh server-generated temporary password, returned once. Signs
   * the target out everywhere.
   */
  adminResetPassword(id: number): Promise<string>;

  /**
   * Re-enter the password to elevate this session, via the login challenge
   * (`sha256(md5(pw) + randomCode)`) since deployments may be plaintext HTTP on
   * a LAN. The server takes who from the session. Rate-limited 5/300s per
   * account, not per IP (a household shares one address).
   */
  adminElevate(account: string, plaintext: string): Promise<void>;

  /** Drop this session's elevation. Idempotent; never answers with the gate. */
  adminLock(): Promise<void>;

  /** One account's tablets, revoked included. 404 `USER_NOT_FOUND`. */
  adminListDevices(userId: number): Promise<AdminDevice[]>;

  /**
   * Soft-revoke one tablet (re-pairable). 404 `DEVICE_NOT_FOUND` also covers a
   * serial owned by someone else, deliberately indistinguishable.
   */
  adminUnlinkDevice(userId: number, equipmentNo: string): Promise<void>;

  /** One person's used/allotted bytes. */
  adminGetQuota(userId: number): Promise<AdminQuota>;

  /**
   * Set one person's allotment in bytes. Below current usage is legal and
   * deletes nothing; only negative is refused (400 `INVALID_QUOTA`).
   */
  adminSetQuota(userId: number, totalBytes: number): Promise<AdminQuota>;

  /** The bin retention window, with bounds for client-side validation. */
  adminGetRetention(): Promise<AdminRetention>;

  /**
   * Change the retention window; never purges retroactively. 400
   * `INVALID_RETENTION` outside the bounds.
   */
  adminSetRetention(days: number): Promise<AdminRetention>;

  /** Server-wide health. */
  adminHealth(): Promise<AdminHealth>;

  /**
   * The library's backup notice. Answered for any signed-in caller, but only an
   * admin hears anything other than `none`; no elevation needed.
   */
  backupNotice(): Promise<BackupNotice>;

  /** Every backup directory's record, and the notice. */
  adminBackups(): Promise<AdminBackups>;

  /** "I back up another way": silences `never`, never `failed`. */
  adminSetBackupDismissed(dismissed: boolean): Promise<AdminBackups>;

  /** Forget a directory no longer used, so its last failure stops warning. 404 `NO_SUCH_BACKUP_DIR`. */
  adminForgetBackupDir(dir: string): Promise<AdminBackups>;

  // --- SEARCH COVERAGE ---
  // Only handwriting the tablet recognized is searchable. Per live note with
  // writing on it: GET /api/controlplane/search-index/coverage.

  searchCoverage(): Promise<NoteCoverage[]>;

  // --- TO-DO ---
  // The signed-in person's own lists and tasks; each change reaches the tablet
  // at its next sync. While the server keeps no To-Do, `todo()` answers
  // `enabled: false` and every edit is a 409 `TODO_SYNC_OFF`.

  todo(): Promise<TodoSnapshot>;
  /** Returns the new list's id. 400 `BAD_TITLE` for an empty or overlong name. */
  todoCreateList(title: string): Promise<string>;
  todoRenameList(id: string, title: string): Promise<void>;
  /** The list and every task in it. */
  todoDeleteList(id: string): Promise<void>;
  /** Returns the new task's id; it goes on top of its list. 404 `NO_SUCH_LIST`. */
  todoCreateTask(task: NewTodoTask): Promise<string>;
  /** 404 `NO_SUCH_TASK` / `NO_SUCH_LIST`. A move puts the task on top of its new list. */
  todoUpdateTask(id: string, patch: TodoTaskPatch): Promise<void>;
  /** Gone from the tablet at its next sync. Deleting what is gone is fine. */
  todoDeleteTask(id: string): Promise<void>;
  /** The open tasks of one list (null: the Inbox), in this order. */
  todoReorder(listId: string | null, ids: string[]): Promise<void>;

  // --- DIGEST ---
  // The signed-in person's digests, as their tablet's Digest app synced them.
  // Only a digest's typed comment and its category change here; the tablet
  // takes them at its next sync. While the server keeps none, `digests()`
  // answers `enabled: false` and an edit is a 409 `DIGEST_SYNC_OFF`.

  digests(): Promise<DigestSnapshot>;
  /**
   * 400 `BAD_COMMENT` past `MAX_COMMENT` characters, 404 `NO_SUCH_DIGEST`,
   * 404 `NO_SUCH_CATEGORY` for a category that is not one of yours.
   */
  digestEdit(id: string, change: DigestEdit): Promise<void>;
  /** A digest's handwritten note as SNPG page bytes, for the renderer. `md5` is the digest's `note`; 404 for any other. */
  digestNoteBytes(id: string, md5: string): Promise<ArrayBuffer>;

  // --- HISTORY ---
  // Note-scoped by `:id` (the `/note/:id` ownership gate); per-version routes
  // require `:md5` to be a retained version of that file, else one
  // indistinguishable 404. Per-version URLs are content-addressed: no `?v=`.

  /**
   * A file's versions, newest-first: the current blob then every retained one.
   * `createdAt` is normalized to epoch ms.
   */
  noteHistory(id: Id): Promise<FileHistory>;

  /**
   * A retained version's own page list and geometry (from its retained
   * `note_index`), so a preview uses the version's page count, not the live
   * note's. `fileHash` is the version md5; `id`/`name` are the file's.
   */
  historyMeta(id: Id, md5: Hash): Promise<NoteMeta>;

  /** Page `n`'s SNPG bytes of a retained version; same wire shape as {@link getPageBytes}. */
  historyPageBytes(id: Id, md5: Hash, index: number): Promise<ArrayBuffer>;

  /** Page `n`'s recognized text of a retained version; same shape as {@link getPageText}. */
  historyPageText(id: Id, md5: Hash, index: number): Promise<PageText>;

  /**
   * Restore a retained version through the normal supersede path, which also
   * retains the displaced current, so restore is undoable. May fail with
   * `QUOTA_EXCEEDED` (507), changing nothing.
   */
  restoreVersion(id: Id, md5: Hash): Promise<RestoredVersion>;

  /**
   * A retained version's raw blob bytes, for the client-rendered kinds (`.spd`,
   * `.txt`, images). `/file/:id?v=` is the universal raw-bytes route, `.note`
   * included; the per-page SNPG route is only a render convenience.
   */
  historyRaw(id: Id, md5: Hash): Promise<ArrayBuffer>;

  // --- BIN-SCOPED READS ---
  // `/bin/…` twins of the reads above, for a trashed file (its blob, transcript
  // and history are retained). Separate routes because the live ones hardcode
  // `deleted = 0`. `createBinScope` (pages/bin/bin.ts) reroutes a trashed id's reads
  // onto these, so the reader never learns a bin exists.

  /** {@link getPageText} for a trashed note. */
  binPageText(id: Id, page: PageRef): Promise<PageText>;

  /**
   * {@link noteHistory} for a trashed file; history follows the file into the
   * bin. View-only: restore the file first.
   */
  binNoteHistory(id: Id): Promise<FileHistory>;

  /** {@link historyPageBytes} for a trashed file. */
  binHistoryPageBytes(id: Id, md5: Hash, index: number): Promise<ArrayBuffer>;

  /** {@link historyPageText} for a trashed file. */
  binHistoryPageText(id: Id, md5: Hash, index: number): Promise<PageText>;

  /** {@link historyRaw} for a trashed file. */
  binHistoryRaw(id: Id, md5: Hash): Promise<ArrayBuffer>;

  // --- RENAME ---
  // A rename is a server-side `move` to the current parent, reusing the sync
  // path's name, collision and sync-version logic.

  /**
   * Rename to `name`, the full name with extension. Returns the updated entry.
   * A sibling with that exact name rejects with `NameTakenError` (409) rather
   * than auto-suffixing as device sync does, so the dialog can say it clashed.
   */
  rename(id: Id, name: string): Promise<Entry>;

  // --- UPLOAD ---
  // web → cloud → device: a file placed in the tree is pulled by the device on
  // its next sync.

  /**
   * Upload one file into `folderId` (`null` = root) as multipart; returns the
   * entry in the same shape as `rename`. The one XHR call on this seam: only
   * `xhr.upload.onprogress` reports bytes sent. `signal` aborts the transfer
   * itself. Refusals are `UploadRefusedError` (413 quota, 415 type, 400 name);
   * a bad destination is a 404. Never send `replace` unless the user chose it:
   * the UI detects clashes from the listing before transferring.
   */
  upload(
    folderId: Id | null,
    file: File,
    onProgress?: (fraction: number) => void,
    signal?: AbortSignal,
    onConflict?: UploadConflictMode,
  ): Promise<Entry>;

  // --- ACCOUNT (self-service) ---
  // None of these take a target: the session is who this is about.
  //
  //   GET  /api/controlplane/account                 identity, sign-in, devices
  //   GET  /api/controlplane/account/storage         the meter and its five lines
  //   POST /api/controlplane/account/devices/unlink  one of your bindings
  //   POST /api/controlplane/account/sign-out-others every session but this one
  //   PUT  /api/controlplane/account/versions        how many versions to keep
  //   PUT  /api/user/password                        your own password

  /**
   * The caller's own tablets. The route also returns revoked bindings; the
   * seam keeps only active ones.
   */
  myDevices(): Promise<MyDevice[]>;

  /**
   * Soft-revoke one of your own tablets. A serial not yours is a 404, same as
   * one that doesn't exist.
   */
  unlinkMyDevice(equipmentNo: string): Promise<void>;

  /**
   * End every other session, keeping this one; returns how many ended.
   */
  signOutEverywhere(): Promise<number>;

  /**
   * Your storage split by kind. The five figures partition `usedBytes`
   * (asserted by the backend's partition audit); `byKind` null means unknown.
   */
  storageBreakdown(): Promise<StorageBreakdown>;

  /**
   * Versions kept per file, the admin ceiling, and per-file retained counts
   * (needed to state what lowering would discard).
   */
  versionPolicy(): Promise<VersionPolicy>;

  /**
   * Set versions kept per file, reporting what was discarded. Eviction is
   * immediate and skips the bin, so the UI states the count first. The server
   * clamps to `[0, maxKeep]`; 0 turns versioning off.
   */
  setVersionPolicy(keep: number): Promise<VersionPolicyChange>;

  /** Password age, other live sessions, and this browser's sign-in time; shares a request with {@link Api.myDevices}. */
  accountSecurity(): Promise<AccountSecurity>;

  /**
   * Change your own password, current password required. The handler requires
   * it of `controlplane` callers (not the forced first-login `pending` flow);
   * the service verifies it before writing or revoking anything. Rejects with
   * `INVALID_CREDENTIALS`, `SAME_PASSWORD` or `RateLimitError`. Revokes every
   * other session and mints a fresh one for this browser.
   */
  changePassword(currentPlaintext: string, newPlaintext: string): Promise<void>;
  // ---------------------------------------------------------------------------
}

/** How much of one note's handwriting search can find. */
export interface NoteCoverage {
  readonly id: Id;
  /** Recognition is switched on for the note on the tablet. */
  readonly recognition: boolean;
  /** Pages with writing on them; blank pages are not counted. */
  readonly written: number;
  /** Of those, recognized: only these are searchable. */
  readonly recognized: number;
  /** Still being recognized on the tablet when it last synced. */
  readonly running: number;
}
