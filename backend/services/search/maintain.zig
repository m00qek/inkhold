//! The search package's WRITES: every mutation of segment_search + segment_fts,
//! all inside the caller's transaction. The format adapters call in at ingest
//! (note_index / txt_index) and files.zig calls in at the blob/account
//! lifecycle; the reads live next door in `query.zig`. Imports `fuzzy.zig` only
//! for the shared tokenizer fold (`fold_ddl`), and never imports `query.zig`.
//!
//! The lifecycle has exactly three paths (the in-doc-search plan's terms):
//!   - a new VERSION is a new blob (`flipOwnerBlob`): the owner's whole segment
//!     band is re-minted to follow the new content, contiguous in page order;
//!   - a re-parse of the SAME blob (the adapters' reconcile loop) preserves ids
//!     and masked rowids, refreshing postings in place where text changed
//!     (`deletePagePostings`/`insertPagePostings`, `mintPageForHolders`,
//!     `dropTailSearch`);
//!   - purge / account deletion (`dropOwnerBlobSearch`, `dropUserSearch`).
//!
//! Wherever postings are subtracted the FTS 'delete' runs FIRST, while the text
//! it was indexed from still resolves — an external-content delete subtracts
//! whatever the content says right now, so deleting the rows first would corrupt
//! the index.

const std = @import("std");
const sqlite = @import("../../db/sqlite.zig");
const partition = @import("../search_partition.zig");
const fuzzy = @import("fuzzy.zig");
// The per-document term set (entry 8b) is folded through the index's own
// tokenizer, which fuzzy.zig owns as `fold_ddl` — aliased so `writeDocTerms`
// reads unchanged.
const fold_ddl = fuzzy.fold_ddl;

/// Which page rows carry searchable text. Shared by both sync statements below,
/// and repeated verbatim by the v15 backfill in `schema.zig` (which cannot import
/// this module without inverting the db/services layering). An insert and a
/// delete that disagreed here would leave orphan postings behind, so it is one
/// constant rather than three literals.
pub const fts_predicate = "text IS NOT NULL AND text <> ''";

// ---------------------------------------------------------------------------
// Sync — inside the caller's transaction
// ---------------------------------------------------------------------------

// Every posting subtraction below is the same statement shape: an FTS5
// external-content 'delete' fed the text the postings were built from, per
// SEGMENT rowid — one per partition holding the content — read out of the
// still-unmodified `note_page_index` row. The insert shapes mirror them.

const unindex_sql =
    "INSERT INTO segment_fts(segment_fts, rowid, txt) " ++
    "SELECT 'delete', s.id, p.text FROM note_page_index p " ++
    "JOIN segment_search s ON s.segment_id = p.id " ++
    "WHERE p.blob_md5 = ?1 AND " ++ fts_predicate ++ ";";

const index_sql =
    "INSERT INTO segment_fts(rowid, txt) " ++
    "SELECT s.id, p.text FROM note_page_index p " ++
    "JOIN segment_search s ON s.segment_id = p.id " ++
    "WHERE p.blob_md5 = ?1 AND " ++ fts_predicate ++ ";";

/// Removes every posting derived from a blob's pages — at every segment rowid,
/// in every partition holding it. The masked rowids themselves are untouched,
/// so pairing this with `indexBlob` refreshes postings IN PLACE (the same-blob
/// re-parse discipline).
///
/// MUST be called while the `note_page_index` rows still hold the text they
/// were indexed from — i.e. *before* re-writing them and *before* deleting
/// them (blob GC at refcount 0, where this is also the structural backstop for
/// segment rows a bug might have left behind). See the module docs.
pub fn unindexBlob(db: sqlite.Db, blob_md5: []const u8) !void {
    var s = try db.prepare(unindex_sql);
    defer s.finalize();
    s.bindText(1, blob_md5);
    _ = try s.step();
}

/// Re-adds a blob's postings from the page rows as they now stand, at each
/// existing segment rowid. Pairs with `unindexBlob`; call it *after* the rows
/// are written.
pub fn indexBlob(db: sqlite.Db, blob_md5: []const u8) !void {
    var s = try db.prepare(index_sql);
    defer s.finalize();
    s.bindText(1, blob_md5);
    _ = try s.step();
}

const delete_page_postings_sql =
    "INSERT INTO segment_fts(segment_fts, rowid, txt) " ++
    "SELECT 'delete', s.id, p.text FROM note_page_index p " ++
    "JOIN segment_search s ON s.segment_id = p.id " ++
    "WHERE p.blob_md5 = ?1 AND p.page_index = ?2 AND " ++ fts_predicate ++ ";";

const insert_page_postings_sql =
    "INSERT INTO segment_fts(rowid, txt) " ++
    "SELECT s.id, p.text FROM note_page_index p " ++
    "JOIN segment_search s ON s.segment_id = p.id " ++
    "WHERE p.blob_md5 = ?1 AND p.page_index = ?2 AND " ++ fts_predicate ++ ";";

/// One page's postings out, at every segment rowid referencing it. The
/// re-parse path calls this ONLY for a page whose text actually changed, and
/// only before the row still holding the old text is rewritten.
pub fn deletePagePostings(db: sqlite.Db, blob_md5: []const u8, ordinal: i64) !void {
    var s = try db.prepare(delete_page_postings_sql);
    defer s.finalize();
    s.bindText(1, blob_md5);
    s.bindInt(2, ordinal);
    _ = try s.step();
}

/// One page's postings back in, at the SAME segment rowids `deletePagePostings`
/// subtracted them from — the in-place half of the re-parse refresh.
pub fn insertPagePostings(db: sqlite.Db, blob_md5: []const u8, ordinal: i64) !void {
    var s = try db.prepare(insert_page_postings_sql);
    defer s.finalize();
    s.bindText(1, blob_md5);
    s.bindInt(2, ordinal);
    _ = try s.step();
}

/// A re-parse yielded FEWER pages: every owner's segment rows for the dropped
/// tail go — postings first (the text still resolves), then the rows, so the
/// `note_page_index` tail delete that follows cannot orphan an FK.
///
/// **SCOPED TO `kind = 0`, and that is load-bearing.** `note_page_index` holds
/// three tenants now — note pages (0), `.txt` paragraphs (1), PDF pages (2) —
/// and this is the NOTE half's cleanup. Unscoped it reaches a blob the note
/// parser REJECTED, whose page count is therefore zero, and deletes every
/// segment another tenant wrote: a PDF's whole text index, dropped by a note
/// re-parse that had nothing to do with it. A tenant owns its own rows.
pub fn dropTailSearch(db: sqlite.Db, blob_md5: []const u8, page_count: i64) !void {
    {
        var s = try db.prepare(
            "INSERT INTO segment_fts(segment_fts, rowid, txt) " ++
                "SELECT 'delete', s.id, p.text FROM note_page_index p " ++
                "JOIN segment_search s ON s.segment_id = p.id " ++
                "WHERE p.blob_md5 = ?1 AND p.page_index >= ?2 AND p.kind = 0 AND " ++ fts_predicate ++ ";",
        );
        defer s.finalize();
        s.bindText(1, blob_md5);
        s.bindInt(2, page_count);
        _ = try s.step();
    }
    var s = try db.prepare(
        "DELETE FROM segment_search WHERE segment_id IN " ++
            "(SELECT id FROM note_page_index WHERE blob_md5 = ?1 AND page_index >= ?2 AND kind = 0);",
    );
    defer s.finalize();
    s.bindText(1, blob_md5);
    s.bindInt(2, page_count);
    _ = try s.step();
}

/// A re-parse yielded a page the blob did not have before: every CURRENT
/// holder of the blob gets a fresh masked rowid for it (a fresh sequence is
/// honest recency — the page is new to search). On first ingest nobody holds
/// the blob yet and this is a no-op; the ingesting owner's rows are minted by
/// `mintOwnerBlobSearch` once their `files` row exists.
pub fn mintPageForHolders(db: sqlite.Db, blob_md5: []const u8, ordinal: i64, now: i64) !void {
    var holders = try db.prepare("SELECT DISTINCT user_id FROM files WHERE md5 = ?1 AND is_folder = 0;");
    defer holders.finalize();
    holders.bindText(1, blob_md5);
    while (try holders.step()) {
        const uid: u64 = @intCast(holders.columnInt(0));
        const part = try partition.ensureActive(db, uid, now);
        const seq = try partition.allocSeq(db, part, 1);
        const rowid = partition.rowidOf(part, seq);
        {
            var s = try db.prepare(
                "INSERT INTO segment_search(id, segment_id) " ++
                    "SELECT ?1, id FROM note_page_index WHERE blob_md5 = ?2 AND page_index = ?3;",
            );
            defer s.finalize();
            s.bindInt(1, rowid);
            s.bindText(2, blob_md5);
            s.bindInt(3, ordinal);
            _ = try s.step();
        }
        var s = try db.prepare(
            "INSERT INTO segment_fts(rowid, txt) " ++
                "SELECT s.id, p.text FROM segment_search s " ++
                "JOIN note_page_index p ON p.id = s.segment_id " ++
                "WHERE s.id = ?1 AND " ++ fts_predicate ++ ";",
        );
        defer s.finalize();
        s.bindInt(1, rowid);
        _ = try s.step();
    }
}

/// The per-unit ingest reconcile step — the SAME re-derive discipline both the
/// `.note` and `.txt` adapters' `store` run once per segment (Axis 2: this was
/// an acknowledged copy, kept verbatim in two files). The adapter owns
/// enumeration and the one format-specific row write it hands in as
/// `ctx.upsert(db, ordinal)` (a note page vs a `.txt` paragraph — different
/// columns entirely); this owns the segment dance around it:
///
///   1. Diff the stored text through the searchable lens BEFORE the upsert
///      rewrites it — `columnText` reads NULL as "", the predicate's notion of
///      "nothing indexed".
///   2. 'delete' the old postings while the row still holds the old text (an
///      external-content delete subtracts what the content says NOW).
///   3. Upsert the one row (adapter).
///   4. Refresh postings IN PLACE where the text changed (new text at the SAME
///      masked rowids), or mint a fresh masked rowid for every CURRENT holder
///      when the unit is new. On first ingest nobody holds the blob yet, so the
///      mint is a no-op and the owner's rows are laid down by
///      `mintOwnerBlobSearch` once their `files` row exists.
///
/// Runs inside the caller's transaction, `blob_md5`'s `note_page_index` rows
/// present. `ctx` is any value exposing `pub fn upsert(self, sqlite.Db, i64)`.
pub fn reconcilePage(
    db: sqlite.Db,
    blob_md5: []const u8,
    ordinal: i64,
    new_text: []const u8,
    now: i64,
    ctx: anytype,
) !void {
    var old_exists = false;
    var text_changed = false;
    {
        if (try db.row(
            "SELECT text FROM note_page_index WHERE blob_md5 = ?1 AND page_index = ?2;",
            &.{ .{ .text = blob_md5 }, .{ .int = ordinal } },
        )) |r| {
            defer r.finalize();
            old_exists = true;
            text_changed = !std.mem.eql(u8, r.text(0), new_text);
        }
    }
    if (old_exists and text_changed) try deletePagePostings(db, blob_md5, ordinal);

    try ctx.upsert(db, ordinal);

    if (old_exists and text_changed) {
        try insertPagePostings(db, blob_md5, ordinal);
    } else if (!old_exists) {
        try mintPageForHolders(db, blob_md5, ordinal, now);
    }
}

// ---------------------------------------------------------------------------
// Per-document term set — the in-doc fuzzy candidate pool (entry 8b)
// ---------------------------------------------------------------------------

// `doc_terms` holds one row per (owner partition, blob, distinct folded term):
// the document's OWN vocabulary, so the typo ladder for a search INSIDE an open
// note draws its candidates from a primary-key SEEK over the note's few-hundred
// terms instead of a SCAN of the whole corpus (the residual Pi tail entry 8b
// closes). It is written by the SAME mint that lays down the segments and turns
// over with them — mint writes it, `dropOwnerBlobSearch` deletes it, the flip
// and the re-index heal do both — and it is folded through the SAME tokenizer
// `segment_fts` uses (`fold_ddl`'s `token_fold`), never a second tokenization.
// So a doc term is byte-identical to what the index matched, and the pool is
// EXACTLY the terms a search in this document could hit: scoping it changes the
// work, not the results.

const doc_terms_fold_sql =
    "INSERT INTO temp.token_fold(t) SELECT p.text FROM note_page_index p " ++
    "WHERE p.blob_md5 = ?1 AND " ++ fts_predicate ++ ";";

const doc_terms_insert_sql =
    "INSERT INTO doc_terms(partition_id, blob_md5, term) " ++
    "SELECT ?1, ?2, term FROM temp.token_fold_vocab;";

/// (Re)writes one document's term set for one owner partition: the blob's
/// distinct folded terms, computed through the index's own tokenizer. Idempotent
/// — it clears the (partition, blob) rows first — so a fresh mint, a flip's
/// re-mint and the heal's backfill all converge on the same set. A blob with no
/// searchable text (an unrecognised note, a `.txt` marker) folds to nothing and
/// leaves the document with an EMPTY pool, which is exactly right: an empty
/// document offers no corrections. Uses the shared `token_fold` temp table,
/// cleared before use so a prior fold cannot bleed in.
fn writeDocTerms(db: sqlite.Db, partition_id: i64, blob_md5: []const u8) !void {
    {
        var s = try db.prepare("DELETE FROM doc_terms WHERE partition_id = ?1 AND blob_md5 = ?2;");
        defer s.finalize();
        s.bindInt(1, partition_id);
        s.bindText(2, blob_md5);
        _ = try s.step();
    }
    try db.exec(fold_ddl);
    try db.exec("DELETE FROM temp.token_fold;");
    {
        var s = try db.prepare(doc_terms_fold_sql);
        defer s.finalize();
        s.bindText(1, blob_md5);
        _ = try s.step();
    }
    var s = try db.prepare(doc_terms_insert_sql);
    defer s.finalize();
    s.bindInt(1, partition_id);
    s.bindText(2, blob_md5);
    _ = try s.step();
}

/// Drops one owner's term set for a blob across every partition they hold it in
/// (one active, plus a superseded one transiently during a remint) — the
/// `doc_terms` half of `dropOwnerBlobSearch`.
fn dropDocTerms(db: sqlite.Db, user_id: u64, blob_md5: []const u8) !void {
    var s = try db.prepare(
        "DELETE FROM doc_terms WHERE blob_md5 = ?2 AND partition_id IN " ++
            "(SELECT id FROM search_partitions WHERE user_id = ?1);",
    );
    defer s.finalize();
    s.bindInt(1, @intCast(user_id));
    s.bindText(2, blob_md5);
    _ = try s.step();
}

/// Ingest: the owner's FIRST reference to this content mints one segment row
/// per page — a batch of fresh sequences (ONE `next_seq` update, not one per
/// segment) — and inserts the postings. Restore needs nothing (the rows never
/// left); a second file of the same content needs nothing either (segment rows
/// are per owner×blob, and the `files` join fans the hit out).
pub fn mintOwnerBlobSearch(db: sqlite.Db, user_id: u64, blob_md5: []const u8, now: i64) !void {
    var count: i64 = 0;
    {
        var s = try db.prepare("SELECT COUNT(*) FROM note_page_index WHERE blob_md5 = ?1;");
        defer s.finalize();
        s.bindText(1, blob_md5);
        _ = try s.step();
        count = s.columnInt(0);
    }
    if (count == 0) return; // not an indexed .note: nothing to search
    const part = try partition.ensureActive(db, user_id, now);
    const first = try partition.allocSeq(db, part, count);
    const first_rowid = partition.rowidOf(part, first);
    {
        var s = try db.prepare(
            "INSERT INTO segment_search(id, segment_id) " ++
                "SELECT ?2 + (ROW_NUMBER() OVER (ORDER BY page_index) - 1), id " ++
                "FROM note_page_index WHERE blob_md5 = ?1;",
        );
        defer s.finalize();
        s.bindText(1, blob_md5);
        s.bindInt(2, first_rowid);
        _ = try s.step();
    }
    var s = try db.prepare(
        "INSERT INTO segment_fts(rowid, txt) " ++
            "SELECT s.id, p.text FROM segment_search s " ++
            "JOIN note_page_index p ON p.id = s.segment_id " ++
            "WHERE p.blob_md5 = ?1 AND s.id BETWEEN ?2 AND ?3 AND " ++ fts_predicate ++ ";",
    );
    defer s.finalize();
    s.bindText(1, blob_md5);
    s.bindInt(2, first_rowid);
    s.bindInt(3, first_rowid + count - 1);
    _ = try s.step();
    // The document's own term set, alongside the segments it belongs to (entry
    // 8b): the in-doc fuzzy pool for this note, in this owner's partition.
    try writeDocTerms(db, part, blob_md5);
}

const owner_blob_fts_delete_sql =
    "INSERT INTO segment_fts(segment_fts, rowid, txt) " ++
    "SELECT 'delete', s.id, p.text FROM search_partitions sp " ++
    "JOIN segment_search s ON s.id BETWEEN (sp.id << 48) AND ((sp.id + 1) << 48) - 1 " ++
    "JOIN note_page_index p ON p.id = s.segment_id " ++
    "WHERE sp.user_id = ?1 AND p.blob_md5 = ?2 AND " ++ fts_predicate ++ ";";

const owner_blob_rows_delete_sql =
    "DELETE FROM segment_search WHERE id IN (" ++
    "SELECT s.id FROM search_partitions sp " ++
    "JOIN segment_search s ON s.id BETWEEN (sp.id << 48) AND ((sp.id + 1) << 48) - 1 " ++
    "JOIN note_page_index p ON p.id = s.segment_id " ++
    "WHERE sp.user_id = ?1 AND p.blob_md5 = ?2);";

/// Purge: this owner no longer holds ANY file referencing the blob, so their
/// segment rows for it go — postings first. Other owners of the same content
/// are untouched (their rows live in their own partitions).
///
/// MUST run while the blob's `note_page_index` rows still exist (i.e. before
/// the decref that might GC them): the FTS 'delete' reads the text through
/// them, and the FK from `segment_search` would otherwise trip.
pub fn dropOwnerBlobSearch(db: sqlite.Db, user_id: u64, blob_md5: []const u8) !void {
    {
        var s = try db.prepare(owner_blob_fts_delete_sql);
        defer s.finalize();
        s.bindInt(1, @intCast(user_id));
        s.bindText(2, blob_md5);
        _ = try s.step();
    }
    {
        var s = try db.prepare(owner_blob_rows_delete_sql);
        defer s.finalize();
        s.bindInt(1, @intCast(user_id));
        s.bindText(2, blob_md5);
        _ = try s.step();
    }
    // The document's term set goes with its segments (entry 8b).
    try dropDocTerms(db, user_id, blob_md5);
}

/// A new VERSION of a note is a NEW BLOB (content addressing is the
/// versioning), and this is the flip: the owner's whole segment band is
/// RE-MINTED to follow the new content, contiguous and in page order.
///
/// ## Whole-doc-band re-mint — canonical document order (in-doc-search plan)
///
/// The owner's old-blob segment rows are dropped (postings first) and the
/// new blob's pages are minted afresh as ONE contiguous run of sequences in
/// `page_index` order (`dropOwnerBlobSearch` + `mintOwnerBlobSearch`). The
/// consequence is the load-bearing one: **`rowid ASC == reading order` after
/// every edit, by construction** — a changed page can never land at a TAIL
/// rowid out of page order the way the previous text_hash diff-and-repoint
/// left it, so in-doc keyset batching walks the document in page order with no
/// sort and no "settle". Across documents newest-first is preserved: the whole
/// edited note re-mints to fresh (highest) sequences, so an edit still bubbles
/// the note to the top of per-partition recency — now as a unit rather than a
/// single page.
///
/// The cost moves from O(pages edited) to O(pages) postings rewrites, paid
/// ONLY on a real content change: the caller gates this on `old_last &&
/// new_first`, and an unchanged blob (same md5) never reaches the flip at all.
/// A note is tens of pages, a big `.txt` a few thousand paragraphs, and the
/// write is dominated by the parse that precedes it — the plan's accepted
/// trade for deleting the whole class of edit-scatter ordering bugs.
///
/// Runs inside the caller's transaction (the whole point: search atomically
/// sees exactly one version), with BOTH blobs' page rows present — the old
/// blob's rows are only reaped by the decref that follows, and the FTS 'delete'
/// side of the drop reads the old blob's text through them. Other owners of the
/// old blob are untouched (their rows live in their own partitions).
pub fn flipOwnerBlob(
    db: sqlite.Db,
    user_id: u64,
    old_md5: []const u8,
    new_md5: []const u8,
    now: i64,
) !void {
    try dropOwnerBlobSearch(db, user_id, old_md5);
    try mintOwnerBlobSearch(db, user_id, new_md5, now);
}

// ---------------------------------------------------------------------------
// Canonical-order heal — retire legacy edit-scatter on an index_version bump
// ---------------------------------------------------------------------------

/// The shape of one holder's segment band for `blob_md5`: how many rows it has,
/// and whether those rows are contiguous masked rowids in strict `page_index`
/// order (`rowid ASC == reading order`). An empty band (a blob a user does not
/// hold yet, or a first ingest whose mint has not run) is vacuously canonical —
/// nothing to re-mint.
///
/// Every band minted since the whole-doc-band re-mint landed is canonical, so
/// this is the guard that keeps the heal a NO-OP on the common path: only a
/// band a PAST incremental flip scattered (an old tail rowid out of page order)
/// answers false and pays the re-mint.
///
/// `rows` exists for the CHUNKED writer (`finishOwnerBlobBands`), where
/// contiguity is not the whole question: a band that is contiguous but SHORT is
/// a holder who arrived between two chunks, and that is not something the
/// canonical test can see.
const BandShape = struct { rows: i64, canonical: bool };

fn holderBandShape(db: sqlite.Db, user_id: u64, blob_md5: []const u8) !BandShape {
    var s = try db.prepare(
        "SELECT s.id FROM search_partitions sp " ++
            "JOIN segment_search s ON s.id BETWEEN (sp.id << 48) AND ((sp.id + 1) << 48) - 1 " ++
            "JOIN note_page_index p ON p.id = s.segment_id " ++
            "WHERE sp.user_id = ?1 AND p.blob_md5 = ?2 ORDER BY p.page_index;",
    );
    defer s.finalize();
    s.bindInt(1, @intCast(user_id));
    s.bindText(2, blob_md5);
    var out: BandShape = .{ .rows = 0, .canonical = true };
    var prev: ?i64 = null;
    while (try s.step()) {
        const id = s.columnInt(0);
        out.rows += 1;
        if (prev) |pv| {
            if (id != pv + 1) out.canonical = false; // a gap or a step down: scattered
        }
        prev = id;
    }
    return out;
}

/// The `index_version` heal's canonical-order pass: re-mint any holder's
/// segment band for `blob_md5` that a PAST incremental flip left OUT of page
/// order, so `rowid ASC == reading order` holds for legacy notes too — the
/// one-time re-index the self-heal already performs, extended to fix ordering.
/// A holder whose band is already contiguous and page-ordered is left
/// untouched, so a plain heal of an unedited note writes NOTHING to the index
/// (its `_data` fingerprint is unmoved) — no recency churn on every sync.
///
/// Runs inside the heal's transaction, AFTER `store` has refreshed the page
/// rows. Follows `mintPageForHolders`' pattern: the holder cursor is on `files`
/// while the re-mint writes `segment_search`/`segment_fts`, so the inner
/// statements never disturb it.
///
/// This is ALSO where the per-document term set backfills (entry 8b): a holder
/// whose band is already canonical keeps its segments untouched but has its
/// `doc_terms` (re)written, so a legacy note carrying no term set yet gains one
/// on its first `index_version` heal, and a re-parse that refolded the text
/// refreshes the pool. That write does not touch `segment_fts`, so the heal's
/// "no recency churn on an unedited note" property is unchanged.
pub fn recanonicalizeHolders(db: sqlite.Db, blob_md5: []const u8, now: i64) !void {
    var holders = try db.prepare("SELECT DISTINCT user_id FROM files WHERE md5 = ?1 AND is_folder = 0;");
    defer holders.finalize();
    holders.bindText(1, blob_md5);
    while (try holders.step()) {
        const uid: u64 = @intCast(holders.columnInt(0));
        if ((try holderBandShape(db, uid, blob_md5)).canonical) {
            // Segments already in reading order — leave them, but keep the
            // document's fuzzy pool current (backfill / refold).
            if (try partition.active(db, uid)) |pid| try writeDocTerms(db, pid, blob_md5);
            continue;
        }
        try dropOwnerBlobSearch(db, uid, blob_md5);
        try mintOwnerBlobSearch(db, uid, blob_md5, now);
    }
}

// ---------------------------------------------------------------------------
// Reserved bands — a document written in CHUNKS, still one contiguous run
// ---------------------------------------------------------------------------

// `mintOwnerBlobSearch` gets contiguity by laying the whole band down in ONE
// statement, inside one transaction. For a `.note` or a `.txt` that is right;
// for a 1,450-page PDF it is a **13.9-24.4 s hold of the global `db_lock`**
// (`mupdf.md` §9.8, measured on the Pi), which is the whole machine for half a
// minute. The write has to be chunked, and `nice` cannot help with a lock.
//
// **But chunking must not become "mint per chunk".** A document's segments are
// ONE CONTIGUOUS ROWID RUN IN PAGE ORDER — `flipOwnerBlob` states the invariant
// outright and the library-wide search now DEPENDS on the arithmetic behind it
// (`query.bandStart` jumps to `R - page_index`). Separate `allocSeq` calls per
// chunk would interleave a concurrent ingest's band into the middle of this
// one, and the invariant would be gone.
//
// So: **reserve the range once, fill it in chunks.** Contiguity comes from the
// reservation, not from doing it in one statement, and every chunk boundary
// becomes a safe place to be interrupted. What that costs, stated plainly:
//
//   - **A partial band is visible to search.** By design — eventually
//     consistent, and a half-indexed book beats an unindexed one.
//   - **A crash mid-document leaves allocated-but-unfilled rowids.** They are
//     holes, not corruption: `segment_search` simply has no row there, and the
//     jump guard already refuses to jump when the candidate is not this blob's
//     page 0, so it degrades to a step.
//   - **A re-run never patches holes.** `reserveOwnerBlobBands` drops the old
//     band first and reserves afresh, the way `flipOwnerBlob` does.
//
// These functions exist HERE, rather than as a caller writing `segment_search`
// itself, because this module is declared the sole owner of those rows (see the
// header, and `query.zig`'s). A reservation-shaped entry point keeps that true.

/// One owner's reserved band: `count` masked rowids from `first_rowid`, to be
/// filled as `first_rowid + page_index`.
pub const Band = struct {
    partition_id: i64,
    first_rowid: i64,
    count: i64,
};

/// Reserves a contiguous run of `page_count` masked rowids for EVERY current
/// holder of `blob_md5`, dropping whatever band they had first.
///
/// The drop is not optional and not separable: a reservation that landed on top
/// of a previous partial run would leave two overlapping notions of where this
/// document's pages live. It runs while the blob's `note_page_index` rows still
/// hold the text their postings were built from (`dropOwnerBlobSearch`'s
/// contract), so the caller must reserve BEFORE rewriting any page row.
///
/// Returns one `Band` per holder, allocated in `gpa` and owned by the caller.
/// An empty slice means nobody holds the blob — a legitimate state (an orphaned
/// blob, or a `files` row deleted mid-pass) in which there is nothing to fill.
///
/// MUST run inside the caller's transaction: `allocSeq` reads and bumps
/// `next_seq`, and two writers reading the same value would hand out the same
/// band twice.
pub fn reserveOwnerBlobBands(
    gpa: std.mem.Allocator,
    db: sqlite.Db,
    blob_md5: []const u8,
    page_count: i64,
    now: i64,
) ![]Band {
    std.debug.assert(page_count > 0);
    var out: std.ArrayList(Band) = .empty;
    errdefer out.deinit(gpa);

    // Follows `mintPageForHolders`' pattern: the cursor is on `files` while the
    // inner statements write `segment_search`/`search_partitions`, so nothing
    // disturbs it.
    var holders = try db.prepare("SELECT DISTINCT user_id FROM files WHERE md5 = ?1 AND is_folder = 0;");
    defer holders.finalize();
    holders.bindText(1, blob_md5);
    while (try holders.step()) {
        const uid: u64 = @intCast(holders.columnInt(0));
        try dropOwnerBlobSearch(db, uid, blob_md5);
        const part = try partition.ensureActive(db, uid, now);
        const first = try partition.allocSeq(db, part, page_count);
        try out.append(gpa, .{
            .partition_id = part,
            .first_rowid = partition.rowidOf(part, first),
            .count = page_count,
        });
    }
    return out.toOwnedSlice(gpa);
}

/// Lays down the segment rows and postings for pages `[from_page, to_page)` of
/// a reserved band — one chunk's worth, in the caller's transaction.
///
/// The adapter has ALREADY written those pages' `note_page_index` rows in this
/// same transaction (the FK requires it, and the postings are read through
/// them). This adds the masked rowid at exactly `first_rowid + page_index`,
/// which is what makes the band contiguous across however many transactions it
/// took to fill.
///
/// Idempotent it is NOT: the reservation is fresh, so a page filled twice would
/// collide on `segment_search`'s primary key — which is the loud failure the
/// alternative (a silent duplicate posting) does not give you.
pub fn fillBandChunk(
    db: sqlite.Db,
    bands: []const Band,
    blob_md5: []const u8,
    from_page: i64,
    to_page: i64,
) !void {
    std.debug.assert(to_page > from_page);
    for (bands) |b| {
        std.debug.assert(to_page <= b.count);
        {
            var s = try db.prepare(
                "INSERT INTO segment_search(id, segment_id) " ++
                    "SELECT ?2 + p.page_index, p.id FROM note_page_index p " ++
                    "WHERE p.blob_md5 = ?1 AND p.page_index >= ?3 AND p.page_index < ?4;",
            );
            defer s.finalize();
            s.bindText(1, blob_md5);
            s.bindInt(2, b.first_rowid);
            s.bindInt(3, from_page);
            s.bindInt(4, to_page);
            _ = try s.step();
        }
        // The postings, bounded by the chunk's OWN rowid range. The band is
        // reserved exclusively to this blob, so the range cannot reach a row
        // that is not part of this chunk.
        var s = try db.prepare(
            "INSERT INTO segment_fts(rowid, txt) " ++
                "SELECT s.id, p.text FROM segment_search s " ++
                "JOIN note_page_index p ON p.id = s.segment_id " ++
                "WHERE s.id BETWEEN ?1 AND ?2 AND " ++ fts_predicate ++ ";",
        );
        defer s.finalize();
        s.bindInt(1, b.first_rowid + from_page);
        s.bindInt(2, b.first_rowid + to_page - 1);
        _ = try s.step();
    }
}

/// Closes a chunked write: the per-document term sets, and the repair for a
/// holder the reservation could not have known about.
///
/// Runs in its OWN transaction, LAST — after every chunk has committed — so
/// "this document is indexed" becomes true only when it is. `writeDocTerms` is
/// the same call `mintOwnerBlobSearch` makes; it is here rather than exported
/// because filling a reserved band is the only other way a band comes into
/// existence, and both live in this module.
///
/// ## The late holder
///
/// A chunked write is not atomic, so a SECOND user can upload the same content
/// between two chunks. Their `files` row runs `mintOwnerBlobSearch`, which
/// counts the `note_page_index` rows that exist AT THAT MOMENT and mints a band
/// for the pages written so far — contiguous, and short. Contiguity alone
/// cannot detect that, which is why `holderBandShape` also counts.
///
/// The repair is the whole-band path (`dropOwnerBlobSearch` + a fresh
/// `mintOwnerBlobSearch`), and it pays the multi-second hold this file exists
/// to avoid. That is the right trade for a race this narrow: it is correct, it
/// is the code that already exists, and the common case — the holder set did
/// not move — is one indexed count per holder and nothing else.
pub fn finishOwnerBlobBands(
    db: sqlite.Db,
    bands: []const Band,
    blob_md5: []const u8,
    page_count: i64,
    now: i64,
) !void {
    for (bands) |b| try writeDocTerms(db, b.partition_id, blob_md5);

    var holders = try db.prepare("SELECT DISTINCT user_id FROM files WHERE md5 = ?1 AND is_folder = 0;");
    defer holders.finalize();
    holders.bindText(1, blob_md5);
    while (try holders.step()) {
        const uid: u64 = @intCast(holders.columnInt(0));
        const shape = try holderBandShape(db, uid, blob_md5);
        if (shape.canonical and shape.rows == page_count) continue;
        try dropOwnerBlobSearch(db, uid, blob_md5);
        try mintOwnerBlobSearch(db, uid, blob_md5, now);
    }
}

/// Account deletion: every posting in the user's partitions, every segment
/// row (one exact range delete per partition), and the mapping rows. Runs
/// inside the caller's transaction, BEFORE the decrefs that may reap the
/// md5-keyed text the FTS deletes read through.
pub fn dropUserSearch(db: sqlite.Db, user_id: u64) !void {
    {
        var s = try db.prepare(
            "INSERT INTO segment_fts(segment_fts, rowid, txt) " ++
                "SELECT 'delete', s.id, p.text FROM search_partitions sp " ++
                "JOIN segment_search s ON s.id BETWEEN (sp.id << 48) AND ((sp.id + 1) << 48) - 1 " ++
                "JOIN note_page_index p ON p.id = s.segment_id " ++
                "WHERE sp.user_id = ?1 AND " ++ fts_predicate ++ ";",
        );
        defer s.finalize();
        s.bindInt(1, @intCast(user_id));
        _ = try s.step();
    }
    {
        var s = try db.prepare(
            "DELETE FROM segment_search WHERE id IN (" ++
                "SELECT s.id FROM search_partitions sp " ++
                "JOIN segment_search s ON s.id BETWEEN (sp.id << 48) AND ((sp.id + 1) << 48) - 1 " ++
                "WHERE sp.user_id = ?1);",
        );
        defer s.finalize();
        s.bindInt(1, @intCast(user_id));
        _ = try s.step();
    }
    {
        // The user's per-document term sets, by partition (entry 8b) — before
        // the mapping rows the subquery reads go.
        var s = try db.prepare(
            "DELETE FROM doc_terms WHERE partition_id IN " ++
                "(SELECT id FROM search_partitions WHERE user_id = ?1);",
        );
        defer s.finalize();
        s.bindInt(1, @intCast(user_id));
        _ = try s.step();
    }
    var s = try db.prepare("DELETE FROM search_partitions WHERE user_id = ?1;");
    defer s.finalize();
    s.bindInt(1, @intCast(user_id));
    _ = try s.step();
}

/// Generation reminting — the safe re-index story (decision 4): mint a FRESH
/// partition, repopulate it from `files`⨝`note_page_index`, flip `active`,
/// range-delete the old generation. Atomic from search's point of view (its
/// own transaction); no in-place mask rewriting, no scramble risk. Sequences
/// restart at 0 in the fresh partition — recency becomes ingest order of the
/// rebuild, which is why results are display-sorted by `files.updated_at`
/// rather than by anything the mask means.
pub fn remintUserSearch(db: sqlite.Db, user_id: u64, now: i64) !void {
    try db.exec("BEGIN IMMEDIATE;");
    errdefer db.exec("ROLLBACK;") catch {};

    const fresh = try partition.mint(db, user_id, false, now);
    {
        var s = try db.prepare(
            "INSERT INTO segment_search(id, segment_id) " ++
                "SELECT ?2 + (ROW_NUMBER() OVER (ORDER BY d.pid) - 1), d.pid " ++
                "FROM (SELECT DISTINCT p.id AS pid FROM files f " ++
                "JOIN note_page_index p ON p.blob_md5 = f.md5 " ++
                "WHERE f.user_id = ?1 AND f.is_folder = 0) d;",
        );
        defer s.finalize();
        s.bindInt(1, @intCast(user_id));
        s.bindInt(2, partition.base(fresh));
        _ = try s.step();
    }
    const populated = db.changes();
    if (populated > 0) _ = try partition.allocSeq(db, fresh, populated);
    {
        var s = try db.prepare(
            "INSERT INTO segment_fts(rowid, txt) " ++
                "SELECT s.id, p.text FROM segment_search s " ++
                "JOIN note_page_index p ON p.id = s.segment_id " ++
                "WHERE s.id BETWEEN ?1 AND ?2 AND " ++ fts_predicate ++ ";",
        );
        defer s.finalize();
        s.bindInt(1, partition.base(fresh));
        s.bindInt(2, partition.last(fresh));
        _ = try s.step();
    }
    // The fresh generation's per-document term sets (entry 8b): one term set per
    // distinct indexed blob the user holds, folded into the fresh partition. A
    // per-blob loop rather than one bulk INSERT because each set is derived
    // through the tokenizer (`writeDocTerms`), and the rebuild is off the hot
    // path.
    {
        var blobs = try db.prepare(
            "SELECT DISTINCT f.md5 FROM files f " ++
                "JOIN note_page_index p ON p.blob_md5 = f.md5 " ++
                "WHERE f.user_id = ?1 AND f.is_folder = 0;",
        );
        defer blobs.finalize();
        blobs.bindInt(1, @intCast(user_id));
        while (try blobs.step()) {
            // Copied: `writeDocTerms` steps other statements on this connection,
            // and the md5 is borrowed only until the cursor's next step.
            var md5: [32]u8 = undefined;
            const m = blobs.columnText(0);
            @memcpy(md5[0..m.len], m);
            try writeDocTerms(db, fresh, md5[0..m.len]);
        }
    }
    {
        // The old generations' term sets, alongside their segments below.
        var s = try db.prepare(
            "DELETE FROM doc_terms WHERE partition_id IN " ++
                "(SELECT id FROM search_partitions WHERE user_id = ?1 AND id <> ?2);",
        );
        defer s.finalize();
        s.bindInt(1, @intCast(user_id));
        s.bindInt(2, fresh);
        _ = try s.step();
    }
    // The old generation goes: postings first, then the rows; `activate`
    // deletes the superseded mapping rows and flips the fresh one live.
    {
        var s = try db.prepare(
            "INSERT INTO segment_fts(segment_fts, rowid, txt) " ++
                "SELECT 'delete', s.id, p.text FROM search_partitions sp " ++
                "JOIN segment_search s ON s.id BETWEEN (sp.id << 48) AND ((sp.id + 1) << 48) - 1 " ++
                "JOIN note_page_index p ON p.id = s.segment_id " ++
                "WHERE sp.user_id = ?1 AND sp.id <> ?2 AND " ++ fts_predicate ++ ";",
        );
        defer s.finalize();
        s.bindInt(1, @intCast(user_id));
        s.bindInt(2, fresh);
        _ = try s.step();
    }
    {
        var s = try db.prepare(
            "DELETE FROM segment_search WHERE id IN (" ++
                "SELECT s.id FROM search_partitions sp " ++
                "JOIN segment_search s ON s.id BETWEEN (sp.id << 48) AND ((sp.id + 1) << 48) - 1 " ++
                "WHERE sp.user_id = ?1 AND sp.id <> ?2);",
        );
        defer s.finalize();
        s.bindInt(1, @intCast(user_id));
        s.bindInt(2, fresh);
        _ = try s.step();
    }
    try partition.activate(db, user_id, fresh);
    try db.exec("COMMIT;");
}
