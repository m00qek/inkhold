// The browse/read surface of the server API, as an interface so the UI can run
// against a fake (dev + tests) and the real HTTP client interchangeably. Auth
// lives in client.ts (login/me/logout/changePassword) and is intentionally NOT
// here — this is only the file-browser + reader data path.
//
// Backing endpoints (control-plane, `.controlplane` scope — to be built in P4):
//   listFolder   → GET  /api/controlplane/tree?parent={id}
//   getNoteMeta  → GET  /api/controlplane/file/metadata/{id}  (generic per-item meta)
//   getPageBytes → GET  /note/{id}/page/{n}?v={hash}        (immutable, HTTP-cached)
//   getPageText  → GET  /note/{id}/page/{n}/text?v={textHash} (immutable, HTTP-cached)
//   searchText   → GET  /api/controlplane/search?q={terms}&limit={n}&cursor={c}
//   searchInNote → GET  /api/controlplane/note/{id}/search?q={terms}

import type {
  Hash,
  Id,
  Listing,
  NoteMeta,
  NoteSearchBatch,
  NoteSearchResults,
  PageRef,
  PageText,
  SearchResults,
  TxtSearchBatch,
  TxtSearchResults,
} from "../core/types";

export interface Api {
  /** List one folder's immediate children. `null` = the user's root. */
  listFolder(parentId: Id | null): Promise<Listing>;

  /** The full page list for a note (opened in the reader). */
  getNoteMeta(id: Id): Promise<NoteMeta>;

  /**
   * The raw `.note` byte-range for a single page — the input the renderer
   * decodes. The versioned URL (`?v={page.hash}`) makes the response immutable,
   * so the browser HTTP cache is layer L2 and this call is free on a repeat
   * view. Returns bytes, never pixels: rasterization is the renderer's job.
   */
  getPageBytes(id: Id, page: PageRef): Promise<ArrayBuffer>;

  /**
   * A page's custom IMAGE template (`GET /note/{id}/template/{hash}`) as a Blob
   * for `createImageBitmap`. `hash` is the asset hash the SNPG payload carries
   * on a `raster image` background record; the URL is content-addressed so the
   * response is `immutable` (HTTP cache is the byte layer, and the reader
   * memoizes the DECODED bitmap once per hash — see render/template.ts). Only
   * pages with a custom image background reference this; a built-in RATTA_RLE
   * template never does.
   */
  getTemplate(id: Id, hash: Hash): Promise<Blob>;

  /**
   * The handwriting-recognition for a single page: the flat transcript the OCR
   * panel shows, plus the same words POSITIONED (`words`, in millimetres) for the
   * searchable-PDF export.
   *
   * LAZY BY CONTRACT: call this only when the "Recognized text" panel is actually
   * showing the page. It is deliberately NOT bundled into {@link getNoteMeta} —
   * that would make every note-open pay for text almost nobody reads, on top of a
   * backend whose `readBlob` already re-parses whole notes per listing.
   *
   * ONE CALL, NOT TWO: text and boxes come out of the same RECOGNTEXT block and
   * are versioned by the same hash, so the server carries them on one endpoint
   * and this seam mirrors that. Splitting them here would mean two round-trips
   * and two chances for a panel and an export to disagree about a page.
   *
   * Keyed by page index + `page.textHash` (NOT `page.hash`): the versioned URL
   * must change exactly when the recognition changes, so it can be served
   * `immutable` without a stale empty transcript outliving the recognition run
   * that replaced it. Returns an empty result — without any request — when
   * `page.textHash` is null, so a caller that checks the hash first simply never
   * round-trips.
   */
  getPageText(id: Id, page: PageRef): Promise<PageText>;

  /**
   * Full-text search over the RECOGNISED transcript of every page of the
   * caller's notes, ranked best-first (bm25). This is the "handwritten" half of
   * the search box's promise; the "typed" half (matching note *names*) stays a
   * client-side filter over the listing already in hand.
   *
   * COVERAGE IS DELIBERATELY PARTIAL: only pages whose on-device recognition
   * finished are indexed, so a note the user never recognised simply does not
   * appear. That is settled — the gallery's OCR marker (`hasRecognizedText`) is
   * what tells the user which notes are findable, and a "not searchable" row per
   * missing note would be noise standing in for a signal that is already shown.
   *
   * A BLANK QUERY IS NOT AN ERROR: it resolves to zero hits without a request.
   * The box searches as you type, so an emptied box is a normal state that must
   * not round-trip and must not surface as a failure.
   *
   * Note the return is scoped by the SERVER to the caller's own, non-deleted
   * notes — the transcript index is keyed by blob md5 and blobs are
   * deduplicated across users, so that join is a security boundary, not a
   * filter the client could ever re-implement.
   *
   * PAGED BY KEYSET, NEVER BY TOTAL: a response is at most 20 hits, and when
   * more may exist it carries {@link SearchResults.cursor}. Fetching the next
   * page is this same call with that cursor handed back verbatim — the query
   * (and limit) must be the ones the cursor came from, since the cursor only
   * means anything relative to that result stream. No call on this surface
   * ever learns how many results there are in all; the server's query stops
   * at the page boundary by design (search-architecture.md decision 6).
   */
  searchText(query: string, limit?: number, cursor?: string): Promise<SearchResults>;

  /**
   * Every matching page of ONE note, with a per-page match count — what
   * find-in-note's counter and its filmstrip badges are made of.
   *
   * ONE REQUEST FOR THE WHOLE NOTEBOOK, and that is the design rather than an
   * optimisation. Asking per page would fire ~200 requests for a 200-page note;
   * the browser caps ~6 concurrent per origin and our server serialises every
   * connection on one coarse `db_lock`, so those six would contend on the same
   * mutex the reader needs for its page bitmaps — a find could starve the pages
   * being read.
   *
   * COMPLETE AND UNRANKED, unlike {@link searchText}, which is bm25-ordered and
   * clamped: reused as a per-note counter that one is silently incomplete.
   *
   * A blank query resolves to zero pages without a request, exactly as
   * {@link searchText} does — find searches as you type.
   */
  searchInNote(noteId: Id, query: string): Promise<NoteSearchResults>;

  /**
   * Every matching PARAGRAPH of ONE `.txt` file, with a per-paragraph count and
   * BYTE RANGE — what the `.txt` viewer's find highlights and jumps between.
   *
   * The `.txt` analog of {@link searchInNote}, and its exact contract: COMPLETE
   * AND UNRANKED (a clamped per-file counter is silently wrong), typo-tolerant,
   * scoped by the SAME server-side `files` join — a foreign, trashed or
   * non-existent id, and a `.note` id with no paragraph segments, are one
   * indistinguishable empty answer. It differs only in what a match is: a
   * paragraph (ordinal + byte range), not a page.
   *
   * A blank query resolves to zero segments without a request, exactly as
   * {@link searchInNote} does — the viewer searches as you type.
   */
  searchInTxt(noteId: Id, query: string): Promise<TxtSearchResults>;

  /**
   * The STREAMING twin of {@link searchInNote}: the same keyset, the same query,
   * the same matching — but every batch is surfaced to `onBatch` as it lands
   * instead of hidden behind one await. This is what lets find show first matches
   * and a "N+" floor immediately, then settle to the exact count when the last
   * batch returns (see {@link NoteSearchBatch}).
   *
   * ALONGSIDE the drain, not instead of it: {@link searchInNote} is kept for any
   * caller that just wants the whole set. The two share one keyset implementation,
   * so a term the drain finds the stream finds — batching never drops or dups a
   * match across the cursor boundary.
   *
   * `onBatch` receives the CUMULATIVE result so far (page order), so it replaces
   * rather than concatenates. `signal` aborts the drain between batches — a
   * superseded keystroke must not keep draining a giant document. A blank query
   * resolves without a request, exactly as {@link searchInNote} does.
   */
  searchInNoteStream(
    noteId: Id,
    query: string,
    onBatch: (batch: NoteSearchBatch) => void,
    signal?: AbortSignal,
  ): Promise<void>;

  /** The `.txt` twin of {@link searchInNoteStream}: streaming find-in-txt, same
   *  contract, cumulative paragraphs per batch. */
  searchInTxtStream(
    noteId: Id,
    query: string,
    onBatch: (batch: TxtSearchBatch) => void,
    signal?: AbortSignal,
  ): Promise<void>;

  // ---------------------------------------------------------------------------
  // WRITES. Everything above this line is a read; the control-plane face was
  // GET-only until the bin and the admin console arrived.
  //
  // APPEND-ONLY, at your own marker. Two features extend this seam in parallel,
  // so add methods under the marker that names yours and touch nothing else in
  // this file — no reordering, no refactoring the reads. That keeps the two sets
  // of edits textually disjoint and mergeable without conflict.
  //
  // A write may fail with `ELEVATION_REQUIRED` (HTTP 428): the session is valid
  // but not freshly elevated. Route it through `dispatchApiFailure` to the
  // gate — never treat it as a dead session.
  //
  // --- BIN WRITES ---
  //
  // The recycle bin. Two of these are READS despite living under this banner —
  // the bin-scoped preview path — and they are here rather than above it because
  // they belong to the bin, not because they mutate.
  //
  // The vocabulary is `core/binTypes.ts`, referenced through inline `import(…)`
  // types rather than a top-of-file `import type` line: this seam is extended by
  // two features in parallel at their own markers, and an import statement is
  // the one thing that cannot live at a marker. See that file's header.

  /**
   * Every trashed entry, newest deletion first, plus the retention window and
   * the byte total the empty-bin confirmation quotes.
   *
   * FLAT and ungrouped by contract. The grouping and nesting the bin renders are
   * derived on the client from `parentId`/`isRoot`, so the server never has to
   * guess which of several presentations a client wants.
   */
  listBin(): Promise<import("../core/binTypes").Bin>;

  /**
   * {@link getNoteMeta} for a TRASHED note.
   *
   * A separate method because it is a separate ROUTE, and that split is a
   * security boundary rather than a convenience: the server's `Files.get`
   * hardcodes `deleted = 0` and is the shared ownership check behind every live
   * read, so it is not relaxed to see the bin. These read through `getTrashed`,
   * which sees trashed rows and nothing else — a live id 404s here exactly as a
   * trashed one 404s from {@link getNoteMeta}.
   *
   * Deciding whether to restore something deleted a fortnight ago means looking
   * at it first (U2b), which is the whole reason this exists. It works at all
   * only because trashing now HOLDS the blob reference; under the old behaviour
   * the bytes were gone before anyone could look.
   */
  getBinNoteMeta(id: Id): Promise<NoteMeta>;

  /** {@link getPageBytes} for a trashed note. See {@link getBinNoteMeta}. */
  getBinPageBytes(id: Id, page: PageRef): Promise<ArrayBuffer>;

  /**
   * Move a LIVE entry to the bin (U5) — the browser's only delete, and the entry
   * point that makes the bin reachable from it at all.
   *
   * A folder takes its whole subtree, so the response states the fanout: the
   * user clicked one row and the operation may have moved three. Reversible, so
   * nothing here expects a confirmation — the caller offers an undo instead.
   */
  trashEntry(id: Id): Promise<import("../core/binTypes").Trashed>;

  /** Bring a trashed entry back. The result reports what it ACTUALLY did (U3). */
  restoreEntry(id: Id): Promise<import("../core/binTypes").Restored>;

  /**
   * Destroy one trashed entry and its subtree, permanently. The only call on
   * this seam that is not reversible by another call on it — hence the confirm.
   * A LIVE id is a 404, not a hard delete.
   */
  purgeEntry(id: Id): Promise<void>;

  /** Destroy everything in the bin. Returns how many rows went. */
  emptyBin(): Promise<number>;

  // --- ADMIN WRITES ---
  //
  // The admin console (docs/scratch/admin-console.md, U1–U8). Every method below
  // is `require_admin` on the server — `is_admin` AND a live elevation — except
  // the two that manage the elevation itself, so any of them may answer 428
  // ELEVATION_REQUIRED at any moment. `pages/admin.ts` is what turns that into
  // the gate and retries the call that hit it; nothing here knows about the gate.
  //
  // The row type comes from `./adminTypes` through an inline `import(...)` type
  // rather than a top-level import, for the reason that file's header gives.

  /**
   * Every household account. Admin-only INCLUDING this read: an unattended
   * tablet must not be able to list every housemate's address.
   */
  adminListUsers(): Promise<import("./adminTypes").AdminUser[]>;

  /**
   * Create an account, and return the temporary password **the server
   * generated**.
   *
   * There is deliberately no password parameter. The client must never invent a
   * credential a housemate will keep using, and the plaintext exists only in
   * this one response — the server stores a hash and genuinely cannot produce it
   * again. A caller that drops this string has created an account nobody can
   * sign in to, so hand-over is part of the flow, not a nicety.
   */
  adminCreateUser(email: string, isAdmin: boolean): Promise<string>;

  /**
   * Permanently delete an account and everything in it. Refused for the last
   * remaining admin (`LAST_ADMIN`), which would otherwise lock administration
   * out of the server for good.
   */
  adminDeleteUser(id: number): Promise<void>;

  /**
   * Reset an account to a fresh server-generated temporary password, returned
   * once — same inversion, same reason, as {@link Api.adminCreateUser}. Signs
   * the target out everywhere.
   */
  adminResetPassword(id: number): Promise<string>;

  /**
   * Re-enter the password to elevate THIS session.
   *
   * Runs the same challenge flow login does (`sha256(md5(pw) + randomCode)`) —
   * a plain password POST would be a real regression on a deployment that is
   * plaintext HTTP across a LAN. Takes the account because the challenge is
   * issued per account; the server still reads WHO from the session, so this
   * can never re-authenticate as somebody else.
   *
   * Rate-limited 5 per 300s **by account, not by IP**: a household shares one
   * address, and IP-keying would let one person's fumbling lock out everyone.
   */
  adminElevate(account: string, plaintext: string): Promise<void>;

  /** Drop this session's elevation ("Lock console"). Idempotent, and always
   *  allowed — an already-lapsed caller gets a 200, never the gate. */
  adminLock(): Promise<void>;

  /**
   * Every tablet bound to one account, revoked bindings INCLUDED — see
   * {@link AdminDevice.active}. 404 `USER_NOT_FOUND` for an unknown id.
   */
  adminListDevices(userId: number): Promise<import("./adminTypes").AdminDevice[]>;

  /**
   * Cut one tablet off from syncing. A soft status flip, not a row delete, so
   * re-pairing stays possible — with the device in hand.
   *
   * 404 `DEVICE_NOT_FOUND` covers both "no such serial" and "that serial belongs
   * to a different housemate", deliberately indistinguishable: a distinct status
   * would leak exactly the fact the shared error is hiding.
   */
  adminUnlinkDevice(userId: number, equipmentNo: string): Promise<void>;

  /** One person's used/allotted bytes — the two numbers the meter is drawn from. */
  adminGetQuota(userId: number): Promise<import("./adminTypes").AdminQuota>;

  /**
   * Set one person's allotment, in bytes, and get the accounting back.
   *
   * **Below current usage is legal and destroys nothing.** The response then
   * reports `usedBytes` above `totalBytes`, which the meter must be able to draw
   * — see {@link AdminQuota}. Only a negative value is refused (400
   * `INVALID_QUOTA`).
   */
  adminSetQuota(userId: number, totalBytes: number): Promise<import("./adminTypes").AdminQuota>;

  /** The recycle bin's retention window, with the bounds a field can validate
   *  against before it ever posts. */
  adminGetRetention(): Promise<import("./adminTypes").AdminRetention>;

  /**
   * Change the retention window. **Never purges retroactively** — the new
   * window's clock starts at this write, so nothing already in the bin becomes
   * due because the number went down. 400 `INVALID_RETENTION` outside the
   * bounds the read returns.
   */
  adminSetRetention(days: number): Promise<import("./adminTypes").AdminRetention>;

  /** Server-wide health: version, memory against its budget, blob store size. */
  adminHealth(): Promise<import("./adminTypes").AdminHealth>;

  // --- HISTORY (hot-cache versioning — "history of this file") ---
  //
  // The read + restore face of the version history (docs/scratch/hot-cache-
  // versioning.md, phases 3-6). All note-scoped by `:id` (the same ownership gate
  // the sibling `/note/:id` routes use); the per-version routes are gated on
  // `:md5` being a RETAINED version of THAT file, so a stranger's md5 — or one not
  // in this file's history — is one indistinguishable 404.
  //
  // The vocabulary (`FileHistory`, `RestoredVersion`) lives in `core/types.ts`,
  // referenced inline like the bin/admin markers so this seam stays extensible at
  // its own marker.

  /**
   * A file's versions, newest-first (`GET /api/controlplane/note/:id/history`):
   * the current blob (flagged {@link import("../core/types").FileVersion.current})
   * then every retained one. `createdAt` is normalized to epoch ms at the seam.
   */
  noteHistory(id: Id): Promise<import("../core/types").FileHistory>;

  /**
   * A retained version's OWN page list + geometry
   * (`GET /api/controlplane/note/:id/history/:md5/meta`) — the same
   * {@link NoteMeta} shape as {@link getNoteMeta}, read from the version's retained
   * `note_index` (H7). This is what lets a preview render the version's REAL page
   * count and dims: a version whose page count differs from the current note (the
   * "I added pages since" case) previews with its own geometry, not the live
   * note's slots. `fileHash` is the version md5; `id`/`name` are the file's. An md5
   * not in this file's history — like the other per-version routes — is a 404.
   */
  historyMeta(id: Id, md5: Hash): Promise<NoteMeta>;

  /**
   * Page `n`'s SNPG bytes of a RETAINED version
   * (`GET /api/controlplane/note/:id/history/:md5/page/:n`) — the same wire shape
   * as {@link getPageBytes}, decoded by the same renderer. NO `?v=`: the `:md5`
   * already pins the immutable blob, so the URL is content-addressed on its own.
   * This is what parameterizes the reader's page source for a preview.
   */
  historyPageBytes(id: Id, md5: Hash, index: number): Promise<ArrayBuffer>;

  /**
   * Page `n`'s recognized TEXT of a RETAINED version
   * (`GET /api/controlplane/note/:id/history/:md5/page/:n/text`) — the same
   * {@link PageText} shape as {@link getPageText}: the flat transcript plus the
   * positioned `words` (millimetres). This is what lets a preview draw the
   * version's on-page recognized-text ovals, mark find-in-preview's word
   * rectangles, and carry an invisible text layer into a version's PDF export —
   * all three read `getPageText`, which the history scope reroutes here. NO `?v=`:
   * the `:md5` already pins the immutable version, so the transcript is
   * content-addressed with it. An md5 not in this file's history — like every
   * per-version route — is a 404.
   */
  historyPageText(id: Id, md5: Hash, index: number): Promise<PageText>;

  /**
   * Find within ONE retained version
   * (`GET /api/controlplane/note/:id/history/:md5/search?q=`). The response is
   * {@link NoteSearchResults} MINUS the cursor: a one-document scan of the
   * version's own recognized text (H8), complete in one shot, exact + accent-fold,
   * with NO corpus-wide fuzzy widening — `usedFuzzy` is always false. A blank
   * query resolves to zero pages without a request, exactly as
   * {@link searchInNote} does.
   */
  searchHistory(id: Id, md5: Hash, query: string): Promise<NoteSearchResults>;

  /**
   * Restore a retained version (`POST …/history/:md5/restore`): re-point the file
   * at that blob through the normal supersede path, which re-derives it as the new
   * current version AND retains the displaced current as a new history row — so
   * restore is inherently UNDOABLE (undo == restore the displaced version). May
   * fail with `QUOTA_EXCEEDED` (HTTP 507), which changes nothing.
   */
  restoreVersion(id: Id, md5: Hash): Promise<import("../core/types").RestoredVersion>;

  /**
   * A retained version's RAW blob bytes
   * (`GET /api/controlplane/note/:id/history/:md5/raw`) — the version-scoped twin
   * of the live `/file/:id?v=` raw route (and of the bin's
   * `/api/controlplane/bin/file/:id`). This is what unlocks history preview for
   * the CLIENT-SIDE-rendered kinds: `.spd` (`spd_decode`), `.txt` (`.text()`) and
   * images each decode a version from these bytes, exactly as they decode the live
   * file from `/file/:id?v=`.
   *
   * `/file/:id?v={hash}` is the ONE universal raw-bytes primitive: it returns the
   * exact stored bytes of ANY file, `.note` included (it is the `.note` download
   * path — `rawFileUrl(..., {download:true})`). The per-page SNPG route
   * (`getPageBytes`, `/note/:id/page/:n`) is a `.note` RENDER convenience layered
   * on top, NEVER the way to fetch a `.note`'s bytes. NO `?v=`: the `:md5` already
   * pins the immutable
   * version. An md5 not in this file's history is a 404, like every per-version
   * route. The viewers fetch by URL (`historyFileUrl`) for their `<img>`/`fetch`
   * paths; this seam method is the same bytes for any caller that wants them
   * through the `Api`.
   */
  historyRaw(id: Id, md5: Hash): Promise<ArrayBuffer>;

  // --- BIN-SCOPED READS (recycle-bin viewer parity) ---
  //
  // The `/bin/…` twins of the current-version and version-history reads above,
  // for a file that is IN the recycle bin. A trashed file's data is fully
  // retained — its blob, its md5-keyed `note_index` transcript, and its
  // `file_history` — so the bin viewer can offer the SAME recognized-text ovals,
  // in-note find and view-only version history the live viewer does. Each is a
  // separate ROUTE (and so a separate seam method) for the same reason
  // {@link getBinNoteMeta} is: the live routes hardcode `deleted = 0` as the
  // shared ownership boundary and are deliberately not relaxed to see the bin.
  // {@link createBinScope} (pages/bin.ts) is what reroutes a trashed id's reads
  // onto these, once, at the seam — the reader never learns a bin exists.

  /**
   * {@link getPageText} for a TRASHED note
   * (`GET /api/controlplane/bin/note/:id/page/:n/text`) — the same
   * {@link PageText} shape, resolved from the trashed file's retained md5-keyed
   * transcript. This is what draws a trashed-note preview's on-page recognized-
   * text ovals and marks find-in-a-trashed-note's word rectangles.
   */
  binPageText(id: Id, page: PageRef): Promise<PageText>;

  /**
   * {@link searchInNote} for a TRASHED note
   * (`GET /api/controlplane/bin/note/:id/search?q=`) — a one-document scan of the
   * trashed file's retained transcript, COMPLETE in one response with no cursor
   * (like {@link searchHistory}), so `usedFuzzy` is always false. A blank query
   * resolves to zero pages without a request.
   */
  binSearchInNote(noteId: Id, query: string): Promise<NoteSearchResults>;

  /**
   * {@link noteHistory} for a TRASHED file
   * (`GET /api/controlplane/bin/note/:id/history`) — its retained `file_history`,
   * which follows the file into the bin (purged only when the bin purges). Same
   * {@link import("../core/types").FileHistory} shape. View-only: the bin history
   * offers preview but no per-version restore (restore the FILE first).
   */
  binNoteHistory(id: Id): Promise<import("../core/types").FileHistory>;

  /** {@link historyPageBytes} for a retained version of a TRASHED file
   *  (`GET /api/controlplane/bin/note/:id/history/:md5/page/:n`). */
  binHistoryPageBytes(id: Id, md5: Hash, index: number): Promise<ArrayBuffer>;

  /** {@link historyPageText} for a retained version of a TRASHED file
   *  (`GET /api/controlplane/bin/note/:id/history/:md5/page/:n/text`) — ovals +
   *  find rectangles on a previewed past version, from the bin. */
  binHistoryPageText(id: Id, md5: Hash, index: number): Promise<PageText>;

  /** {@link searchHistory} for a retained version of a TRASHED file
   *  (`GET /api/controlplane/bin/note/:id/history/:md5/search?q=`). */
  binSearchHistory(id: Id, md5: Hash, query: string): Promise<NoteSearchResults>;

  /** {@link historyRaw} for a retained version of a TRASHED file
   *  (`GET /api/controlplane/bin/note/:id/history/:md5/raw`) — the raw-based
   *  viewers (`.spd`/`.txt`/image) decode a trashed file's past version from
   *  these bytes, via `historyFileUrl(id, md5, { bin: true })`. */
  binHistoryRaw(id: Id, md5: Hash): Promise<ArrayBuffer>;

  // --- RENAME (control-plane) ---
  //
  // Rename a LIVE file or folder in place (docs/scratch/rename.md). A rename is a
  // `move` whose destination is the entry's current parent, so the server reuses
  // the device-sync path's name / collision / sync-version logic; this seam only
  // carries the new full name (extension included) and hands the updated entry
  // back for the caller to reconcile.
  //
  // The vocabulary (`Entry`) is referenced through an inline `import(...)` type
  // rather than a top-of-file `import` line, exactly like the bin/admin/history
  // markers above, so this seam stays extensible at its own marker.

  /**
   * Rename entry `id` to `name` — the new FULL name, extension INCLUDED. Returns
   * the updated {@link import("../core/types").Entry} so the caller can reconcile
   * the visible listing.
   *
   * Rejects with a `NameTaken` error (HTTP 409 → `NameTakenError`, see
   * `client.ts`) when a sibling in the SAME parent already holds that exact name:
   * the rename dialog catches it and stays open with the collision message rather
   * than silently autorenaming — a person who just typed a name wants to know it
   * clashed, unlike the unattended device sync, which suffixes " (2)". The server
   * also refuses to rename a fixed category-root folder; the UI hides the action
   * there, so that refusal is a backstop rather than a path the UI reaches.
   */
  rename(id: Id, name: string): Promise<import("../core/types").Entry>;
  // ---------------------------------------------------------------------------
}
