//! The search package's WRITES: every mutation of segment_search + segment_fts,
//! all inside the caller's transaction. The format adapters call in at ingest
//! (note_index / txt_index) and files.zig calls in at the blob/account
//! lifecycle.
//!
//! **THERE IS NO READ FACE ANY MORE.** `golden-search.md` §6 step 6 moved
//! library-wide search into the browser and step 7 moved in-document search
//! after it, deleting `query.zig` — so everything written here is written for
//! nobody, and step 8 retires the whole mechanism behind a migration. What it
//! still owes until then is CONSISTENCY: a write path that leaves the index
//! wrong is a write path whose removal cannot be measured against a working
//! baseline, which is the entire point of step 8.
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
pub fn recanonicalizeHolders(db: sqlite.Db, blob_md5: []const u8, now: i64) !void {
    var holders = try db.prepare("SELECT DISTINCT user_id FROM files WHERE md5 = ?1 AND is_folder = 0;");
    defer holders.finalize();
    holders.bindText(1, blob_md5);
    while (try holders.step()) {
        const uid: u64 = @intCast(holders.columnInt(0));
        // Segments already in reading order: nothing to do, and nothing written —
        // which is what keeps a plain heal of an unedited note off the index.
        if ((try holderBandShape(db, uid, blob_md5)).canonical) continue;
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
// outright, and the whole re-mint/heal family is defined in terms of it (the
// in-document reads depended on it too, until `golden-search.md` §6 step 7).
// Separate `allocSeq` calls per chunk would interleave a concurrent ingest's band
// into the middle of this one, and the invariant would be gone.
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
    // Nobody holds the blob, so no band will exist.
    if (bands.len == 0) return;
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

/// Closes a chunked write: the repair for a holder the reservation could not
/// have known about.
///
/// Runs in its OWN transaction, LAST — after every chunk has committed — so
/// "this document is indexed" becomes true only when it is.
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
    blob_md5: []const u8,
    page_count: i64,
    now: i64,
) !void {
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

// ---------------------------------------------------------------------------
// Tests — the write path: three-path lifecycle, whole-doc band, FTS row life
// ---------------------------------------------------------------------------

// These tests were written in `query.zig` and moved here when `golden-search.md`
// §6 step 7 deleted the read face they used to be expressed through — the five
// in-doc routes, and `searchNotePages` / `searchTxtSegments` / `docSegmentRanges`
// with them. Their SUBJECT was never that read: it is this module's three-path
// lifecycle (mint / re-parse-in-place / drop), the whole-doc-band re-mint that
// makes `rowid ASC == reading order`, and the FTS row lifecycle hanging off a
// blob's refcount. Every `searchNote(...)` line they carried has become the
// direct assertion over the surviving tables it was always standing in for: a
// `segment_fts MATCH` count, a `segment_search` masked rowid, a
// `note_page_index` row. §6.1: *a suite that shrinks during a sweep is how
// coverage leaves without anyone deciding it should.*
//
// `segment_fts` is WRITE-ONLY after step 7 — no server code reads it, and the
// MATCH counts below are the last queries anywhere that do. Step 8 retires this
// whole machinery (the band, the partition mask, `segment_search`,
// `segment_fts`) behind a migration, and takes these tests with it.

const testing = std.testing;
const schema = @import("../../db/schema.zig");
const blobstore = @import("../../store/blobs.zig");
const thumbstore = @import("../../store/thumbs.zig");
const filesvc = @import("../files.zig");
const noteindex = @import("../note_index.zig");
const nb = @import("note_builder");

const Fixture = struct {
    db: sqlite.Db,
    files: filesvc.Files,
    tmp: testing.TmpDir,
    arena: std.heap.ArenaAllocator,

    fn init() !Fixture {
        var db = try sqlite.Db.openMemory();
        try schema.migrate(db);
        for ([_]u8{ 1, 2 }) |uid| {
            var s = try db.prepare(
                "INSERT INTO users(id, email, password_md5, created_at) VALUES(?1, ?1 || '@b.c', '0123456789abcdef0123456789abcdef', 0);",
            );
            defer s.finalize();
            s.bindInt(1, uid);
            _ = try s.step();
            var c = try db.prepare("INSERT INTO capacity(user_id, used_bytes, total_bytes) VALUES(?1, 0, 1000000000);");
            defer c.finalize();
            c.bindInt(1, uid);
            _ = try c.step();
        }
        const tmp = testing.tmpDir(.{});
        const store = try blobstore.BlobStore.init(testing.io, tmp.dir);
        const thumbs_dir = try tmp.dir.createDirPathOpen(testing.io, "thumbs", .{});
        const thumbs = try thumbstore.ThumbStore.init(testing.io, thumbs_dir);
        return .{
            .db = db,
            .files = filesvc.Files.init(testing.allocator, testing.io, db, store, thumbs),
            .tmp = tmp,
            .arena = std.heap.ArenaAllocator.init(testing.allocator),
        };
    }

    fn deinit(f: *Fixture) void {
        f.arena.deinit();
        f.db.close();
        f.tmp.cleanup();
    }

    fn a(f: *Fixture) std.mem.Allocator {
        return f.arena.allocator();
    }

    /// Puts a synthetic `.note` whose single page carries `labels` as finished
    /// recognition, and returns its file id.
    fn putNote(f: *Fixture, user_id: u64, name: []const u8, labels: []const []const u8) !u64 {
        return f.putSpec(user_id, name, .{ .pages = &.{.{
            .layers = &.{.{ .slot = .main, .bitmap = "AAAA" }},
            .recogn_status = 1,
            .recogn_labels = labels,
        }} });
    }

    fn putSpec(f: *Fixture, user_id: u64, name: []const u8, spec: nb.Spec) !u64 {
        const bytes = try nb.serialize(testing.allocator, spec);
        defer testing.allocator.free(bytes);
        var r = std.Io.Reader.fixed(bytes);
        const e = try f.files.putFile(user_id, null, name, &r, null);
        defer testing.allocator.free(e.name);
        if (e.md5) |m| testing.allocator.free(m);
        return e.id;
    }

    /// A note whose page `i` carries exactly `labels[i]` as finished
    /// recognition — the flip tests' way of giving every page its own
    /// distinct `text_hash`.
    fn putLabeled(f: *Fixture, user_id: u64, name: []const u8, labels: []const []const u8) !u64 {
        const pages = try testing.allocator.alloc(nb.PageSpec, labels.len);
        defer testing.allocator.free(pages);
        for (pages, labels) |*p, label| {
            const one = try f.a().alloc([]const u8, 1);
            one[0] = label;
            p.* = .{
                .layers = &.{.{ .slot = .main, .bitmap = "AAAA" }},
                .recogn_status = 1,
                .recogn_labels = one,
            };
        }
        return f.putSpec(user_id, name, .{ .pages = pages });
    }

    /// A note whose `n` pages each carry `labels`.
    fn putPages(f: *Fixture, user_id: u64, name: []const u8, n: usize, labels: []const []const u8) !u64 {
        const pages = try testing.allocator.alloc(nb.PageSpec, n);
        defer testing.allocator.free(pages);
        for (pages) |*p| p.* = .{
            .layers = &.{.{ .slot = .main, .bitmap = "AAAA" }},
            .recogn_status = 1,
            .recogn_labels = labels,
        };
        return f.putSpec(user_id, name, .{ .pages = pages });
    }

    /// The owner's masked rowid for the segment whose stored text is `text` —
    /// identity tracked by CONTENT, because ordinals are exactly what the
    /// reorder/insert flips move around.
    fn segRowidByText(f: *Fixture, user_id: u64, text: []const u8) !i64 {
        var r = (try f.db.row(
            "SELECT s.id FROM search_partitions sp " ++
                "JOIN segment_search s ON s.id BETWEEN (sp.id << 48) AND ((sp.id + 1) << 48) - 1 " ++
                "JOIN note_page_index p ON p.id = s.segment_id " ++
                "WHERE sp.user_id = ?1 AND p.text = ?2;",
            &.{ .{ .int = @intCast(user_id) }, .{ .text = text } },
        )) orelse return error.NoSegment;
        defer r.finalize();
        return r.int(0);
    }

    /// The number of documents actually in the FTS index.
    ///
    /// NOT `SELECT COUNT(*) FROM segment_fts` — on an external-content table
    /// that reads THROUGH to the `segment_text` view and counts content rows,
    /// so it stays "right" even when the index is empty or duplicated. The
    /// `_docsize` shadow table is the index's own view of itself. Note the
    /// unit: one doc per OWNER'S segment with text, not per text row — shared
    /// content counts once per holder.
    fn ftsRows(f: *Fixture) !i64 {
        return f.count("SELECT COUNT(*) FROM segment_fts_docsize;");
    }

    /// A fingerprint of the FTS index's on-disk postings (`_data` shadow
    /// table): byte-identical shadow state before and after an operation IS
    /// the proof the operation wrote nothing to the index — the "zero FTS
    /// writes" spy the repoint tests pin the mechanism with.
    fn ftsFingerprint(f: *Fixture) !u64 {
        var s = try f.db.prepare(
            "SELECT COUNT(*), TOTAL(LENGTH(block)), TOTAL(id) FROM segment_fts_data;",
        );
        defer s.finalize();
        _ = try s.step();
        const counts = [3]i64{ s.columnInt(0), s.columnInt(1), s.columnInt(2) };
        return std.hash.Wyhash.hash(0, std.mem.asBytes(&counts));
    }

    /// The owner's masked segment rowid for one (blob, ordinal) — the identity
    /// the repoint/re-parse tests assert stability of.
    fn segRowid(f: *Fixture, user_id: u64, ordinal: i64) !i64 {
        var r = (try f.db.row(
            "SELECT s.id FROM search_partitions sp " ++
                "JOIN segment_search s ON s.id BETWEEN (sp.id << 48) AND ((sp.id + 1) << 48) - 1 " ++
                "JOIN note_page_index p ON p.id = s.segment_id " ++
                "WHERE sp.user_id = ?1 AND p.page_index = ?2;",
            &.{ .{ .int = @intCast(user_id) }, .{ .int = ordinal } },
        )) orelse return error.NoSegment;
        defer r.finalize();
        return r.int(0);
    }

    /// ONE note's own masked segment rowids, sorted — scoped by file id, so it
    /// is unambiguous even when other notes share the same page ordinals (where
    /// `segRowid` would return whichever note was minted first). The independent
    /// oracle the band-shape tests check contiguity against, now that the derived
    /// scan ranges they used to be compared with (`query.docSegmentRanges`) are
    /// deleted.
    fn noteSegIds(f: *Fixture, note_id: u64) ![]i64 {
        var s = try f.db.prepare(
            "SELECT s.id FROM segment_search s " ++
                "JOIN note_page_index p ON p.id = s.segment_id " ++
                "JOIN files fi ON fi.md5 = p.blob_md5 " ++
                "WHERE fi.id = ?1 ORDER BY s.id;",
        );
        defer s.finalize();
        s.bindInt(1, @intCast(note_id));
        var out: std.ArrayList(i64) = .empty;
        while (try s.step()) try out.append(f.a(), s.columnInt(0));
        return out.items;
    }

    /// ONE note's masked segment rowid for a given page — file-scoped, so it is
    /// unambiguous even when other notes share the ordinal.
    fn noteSegRowid(f: *Fixture, note_id: u64, page_index: i64) !i64 {
        var r = (try f.db.row(
            "SELECT s.id FROM segment_search s " ++
                "JOIN note_page_index p ON p.id = s.segment_id " ++
                "JOIN files fi ON fi.md5 = p.blob_md5 " ++
                "WHERE fi.id = ?1 AND p.page_index = ?2;",
            &.{ .{ .int = @intCast(note_id) }, .{ .int = page_index } },
        )) orelse return error.NoSegment;
        defer r.finalize();
        return r.int(0);
    }

    /// Legacy edit-scatter simulator: relocates the given `pages` of `note_id`
    /// to fresh TAIL sequences — exactly what the pre-re-mint incremental flip
    /// did to an edited page — so the note's band coalesces into MORE THAN ONE
    /// rowid range. The whole-doc-band re-mint no longer produces this shape, so
    /// the `index_version` heal that retires it is tested against a band
    /// scattered by hand rather than by an edit.
    fn scatterPages(f: *Fixture, user_id: u64, note_id: u64, pages: []const i64) !void {
        const part = (try partition.active(f.db, user_id)).?;
        var seq = try partition.allocSeq(f.db, part, @intCast(pages.len));
        for (pages) |pi| {
            const old = try f.noteSegRowid(note_id, pi);
            const new = partition.rowidOf(part, seq);
            seq += 1;
            // Move the posting: 'delete' at the old rowid while its text still
            // resolves, move the mapping row, re-insert the posting at the new.
            {
                var s = try f.db.prepare(
                    "INSERT INTO segment_fts(segment_fts, rowid, txt) " ++
                        "SELECT 'delete', s.id, p.text FROM segment_search s " ++
                        "JOIN note_page_index p ON p.id = s.segment_id WHERE s.id = ?1;",
                );
                defer s.finalize();
                s.bindInt(1, old);
                _ = try s.step();
            }
            {
                var s = try f.db.prepare("UPDATE segment_search SET id = ?1 WHERE id = ?2;");
                defer s.finalize();
                s.bindInt(1, new);
                s.bindInt(2, old);
                _ = try s.step();
            }
            var s = try f.db.prepare(
                "INSERT INTO segment_fts(rowid, txt) " ++
                    "SELECT s.id, p.text FROM segment_search s " ++
                    "JOIN note_page_index p ON p.id = s.segment_id WHERE s.id = ?1;",
            );
            defer s.finalize();
            s.bindInt(1, new);
            _ = try s.step();
        }
    }

    /// The md5 of the one and only blob (for tests that assert on-disk presence).
    fn blobMd5(f: *Fixture) ![32]u8 {
        var r = (try f.db.row("SELECT md5 FROM blobs;", &.{})) orelse return error.NoBlob;
        defer r.finalize();
        var out: [32]u8 = undefined;
        @memcpy(&out, r.text(0));
        return out;
    }

    fn count(f: *Fixture, sql: []const u8) !i64 {
        var s = try f.db.prepare(sql);
        defer s.finalize();
        _ = try s.step();
        return s.columnInt(0);
    }

    /// A `segment_fts MATCH` bracketed by a rowid range — the exact shape the
    /// deleted in-doc read gave one document's band, kept as the assertion that
    /// outlives it: how many of the band's pages carry the term, and nothing
    /// outside the band counted.
    fn matchesIn(f: *Fixture, match: []const u8, lo: i64, hi: i64) !i64 {
        var r = (try f.db.row(
            "SELECT COUNT(*) FROM segment_fts WHERE segment_fts MATCH ?1 AND rowid BETWEEN ?2 AND ?3;",
            &.{ .{ .text = match }, .{ .int = lo }, .{ .int = hi } },
        )) orelse return error.NoRow;
        defer r.finalize();
        return r.int(0);
    }

    /// The single masked rowid a term hits — WHICH page of the band carries it,
    /// which is what the deleted read's `pageIndex` used to report.
    fn matchRowid(f: *Fixture, match: []const u8) !i64 {
        var r = (try f.db.row(
            "SELECT rowid FROM segment_fts WHERE segment_fts MATCH ?1;",
            &.{.{ .text = match }},
        )) orelse return error.NoMatch;
        defer r.finalize();
        return r.int(0);
    }

    /// The SHARED page rows (`note_page_index.id`) one user's postings match,
    /// sorted. Page identity rather than masked rowid on purpose: it is the only
    /// thing a caller could ever have seen, and it is exactly what a generation
    /// re-mint — which reissues every masked rowid — must not move.
    fn matchedSegments(f: *Fixture, user_id: u64, match: []const u8) ![]i64 {
        var s = try f.db.prepare(
            "SELECT p.id FROM search_partitions sp " ++
                "JOIN segment_search s ON s.id BETWEEN (sp.id << 48) AND ((sp.id + 1) << 48) - 1 " ++
                "JOIN note_page_index p ON p.id = s.segment_id " ++
                "WHERE sp.user_id = ?1 " ++
                "AND s.id IN (SELECT rowid FROM segment_fts WHERE segment_fts MATCH ?2) " ++
                "ORDER BY p.id;",
        );
        defer s.finalize();
        s.bindInt(1, @intCast(user_id));
        s.bindText(2, match);
        var out: std.ArrayList(i64) = .empty;
        while (try s.step()) try out.append(f.a(), s.columnInt(0));
        return out.items;
    }
};

test "one deduplicated blob, two owners: single-copy text, a segment band each, and a purge that takes only one" {
    var f = try Fixture.init();
    defer f.deinit();

    // IDENTICAL content, so the blob store dedups: one blob, one index row, ONE
    // copy of the OCR text — shared by both users' files.
    const labels = &[_][]const u8{"confidential salary review"};
    const a_id = try f.putNote(1, "alice.note", labels);
    const b_id = try f.putNote(2, "bob.note", labels);
    try testing.expect(a_id != b_id);

    // Prove the sharing is real rather than assumed: one blob, one page row.
    try testing.expectEqual(@as(i64, 1), try f.count("SELECT COUNT(*) FROM blobs;"));
    try testing.expectEqual(@as(i64, 1), try f.count("SELECT COUNT(*) FROM note_index;"));
    try testing.expectEqual(@as(i64, 1), try f.count("SELECT COUNT(*) FROM note_page_index;"));
    try testing.expectEqual(@as(i64, 2), try f.count("SELECT COUNT(*) FROM files;"));
    try testing.expectEqual(@as(i64, 2), try f.count("SELECT refcount FROM blobs;"));

    // DEDUP INTACT under partitioning: the TEXT stays single-copy (the one
    // note_page_index row above); what duplicates per owner is the ~24-byte
    // segment row and its postings — that IS the partitioning mechanism, so
    // the match count is 2 where the pre-partition index held 1.
    try testing.expectEqual(@as(i64, 2), try f.count("SELECT COUNT(*) FROM segment_search;"));
    try testing.expectEqual(@as(i64, 2), try f.count(
        "SELECT COUNT(*) FROM segment_fts WHERE segment_fts MATCH 'salary';",
    ));

    // THE OWNERSHIP BOUNDARY IS NOT ASSERTED HERE ANY MORE. This test used to
    // finish by asking for alice's note as bob and getting nothing, through the
    // `files` join every scoped read was built on. `golden-search.md` §6 step 7
    // deleted those reads — the server interprets no query at all now — and the
    // boundary a household member cannot cross moved to `Files.reachesBlob` on
    // `GET /api/controlplane/text/:md5`, asserted where that route lives. What
    // is still this module's business, and stays here, is that a purge by ONE
    // owner takes exactly one band and leaves the shared text alone.
    try f.files.trash(1, a_id);
    try f.files.purge(1, a_id);
    try testing.expectEqual(@as(i64, 1), try f.count("SELECT COUNT(*) FROM segment_search;"));
    try testing.expectEqual(@as(i64, 1), try f.count("SELECT COUNT(*) FROM note_page_index;"));
    try testing.expectEqual(@as(i64, 1), try f.count(
        "SELECT COUNT(*) FROM segment_fts WHERE segment_fts MATCH 'salary';",
    ));
    try f.db.exec("INSERT INTO segment_fts(segment_fts) VALUES('integrity-check');");
}

test "blob GC at refcount 0 takes the index rows AND their FTS entries with it" {
    var f = try Fixture.init();
    defer f.deinit();

    const id = try f.putNote(1, "n.note", &.{"ephemeral note text"});
    try testing.expectEqual(@as(i64, 1), try f.ftsRows());

    // Trashing alone must NOT reap anything — it holds the reference.
    try f.files.trash(1, id);
    try testing.expectEqual(@as(i64, 1), try f.count("SELECT COUNT(*) FROM blobs;"));
    try testing.expectEqual(@as(i64, 1), try f.ftsRows());

    try f.files.purge(1, id);

    try testing.expectEqual(@as(i64, 0), try f.count("SELECT COUNT(*) FROM blobs;"));
    try testing.expectEqual(@as(i64, 0), try f.count("SELECT COUNT(*) FROM note_index;"));
    try testing.expectEqual(@as(i64, 0), try f.count("SELECT COUNT(*) FROM note_page_index;"));
    // The FTS entry is gone from the index itself, not merely hidden by the join.
    try testing.expectEqual(@as(i64, 0), try f.ftsRows());
    // And the index is internally consistent — a mis-ordered delete would fail here.
    try f.db.exec("INSERT INTO segment_fts(segment_fts) VALUES('integrity-check');");
}

test "purging a user reaps the blobs only they held, index and FTS included" {
    var f = try Fixture.init();
    defer f.deinit();

    _ = try f.putNote(1, "sole.note", &.{"private meeting minutes"});
    try testing.expectEqual(@as(i64, 1), try f.count("SELECT refcount FROM blobs;"));
    try testing.expectEqual(@as(i64, 1), try f.ftsRows());

    try f.files.purgeUser(1);

    // The account held the only reference, so the whole chain goes: file row,
    // blob, note_index, note_page_index, and the FTS entry. Before the fix the
    // `users` cascade removed the file row and left every one of the others.
    try testing.expectEqual(@as(i64, 0), try f.count("SELECT COUNT(*) FROM files;"));
    try testing.expectEqual(@as(i64, 0), try f.count("SELECT COUNT(*) FROM blobs;"));
    try testing.expectEqual(@as(i64, 0), try f.count("SELECT COUNT(*) FROM note_index;"));
    try testing.expectEqual(@as(i64, 0), try f.count("SELECT COUNT(*) FROM note_page_index;"));
    try testing.expectEqual(@as(i64, 0), try f.ftsRows());
    try f.db.exec("INSERT INTO segment_fts(segment_fts) VALUES('integrity-check');");
}

test "purging a user DECREMENTS a shared blob: the other owner keeps a working, searchable note" {
    var f = try Fixture.init();
    defer f.deinit();

    // Identical content, so dedup gives both users ONE blob at refcount 2. This
    // is the case a naive "delete the user's blobs" fix would destroy: reaping
    // here would silently take out another household member's note.
    const labels = &[_][]const u8{"shared expedition plan"};
    _ = try f.putNote(1, "alice.note", labels);
    _ = try f.putNote(2, "bob.note", labels);
    try testing.expectEqual(@as(i64, 2), try f.count("SELECT refcount FROM blobs;"));

    try f.files.purgeUser(1);

    // Decremented, not deleted. The bytes are still on disk, so bob's note opens.
    try testing.expectEqual(@as(i64, 1), try f.count("SELECT COUNT(*) FROM blobs;"));
    try testing.expectEqual(@as(i64, 1), try f.count("SELECT refcount FROM blobs;"));
    const md5 = try f.blobMd5();
    try testing.expect(f.files.blobs.has(&md5));

    // The index and its FTS entry survive with the blob, so bob's half of the
    // shared content stays indexed: one band, one posting, still matching.
    try testing.expectEqual(@as(i64, 1), try f.count("SELECT COUNT(*) FROM note_index;"));
    try testing.expectEqual(@as(i64, 1), try f.ftsRows());
    try testing.expectEqual(@as(i64, 1), try f.count("SELECT COUNT(*) FROM segment_search;"));
    try testing.expectEqual(@as(i64, 1), try f.count(
        "SELECT COUNT(*) FROM segment_fts WHERE segment_fts MATCH 'expedition';",
    ));

    // Alice is gone: her file row, and her whole partition with it.
    try testing.expectEqual(@as(i64, 0), try f.count("SELECT COUNT(*) FROM files WHERE user_id = 1;"));
    try testing.expectEqual(@as(i64, 0), try f.count("SELECT COUNT(*) FROM search_partitions WHERE user_id = 1;"));

    // Now bob goes too, and the last reference takes the blob with it.
    try f.files.purgeUser(2);
    try testing.expectEqual(@as(i64, 0), try f.count("SELECT COUNT(*) FROM blobs;"));
    try testing.expectEqual(@as(i64, 0), try f.ftsRows());
    try testing.expect(!f.files.blobs.has(&md5));
}

test "purging a user releases a TOMBSTONED file's reference too (the bin holds it, so nobody else will)" {
    var f = try Fixture.init();
    defer f.deinit();

    // One blob, refcount 2, both references owned by user 1.
    const drop = try f.putNote(1, "drop.note", &.{"duplicated body text"});
    _ = try f.putNote(1, "keep.note", &.{"duplicated body text"});
    try testing.expectEqual(@as(i64, 2), try f.count("SELECT refcount FROM blobs;"));

    // Trashing gives nothing back — that is the whole point of the bin. This
    // inverts the pre-bin invariant: `deleteEntry` used to decref here, so
    // `purgeUser` had to SKIP tombstoned rows or it would decrement twice. Now a
    // tombstone is still a live reference and skipping it would leak the blob.
    try f.files.trash(1, drop);
    try testing.expectEqual(@as(i64, 2), try f.count("SELECT refcount FROM blobs;"));

    // Hand a third reference to user 2, so the blob must survive user 1's purge.
    _ = try f.putNote(2, "bob.note", &.{"duplicated body text"});
    try testing.expectEqual(@as(i64, 3), try f.count("SELECT refcount FROM blobs;"));

    try f.files.purgeUser(1);

    // BOTH of user 1's references came back — the live one and the binned one.
    // A purgeUser that still filtered on `deleted = 0` would leave refcount at 2,
    // and the blob (with its index and its searchable OCR text) would outlive the
    // account with nothing left that could ever decrement it.
    try testing.expectEqual(@as(i64, 1), try f.count("SELECT refcount FROM blobs;"));
    // User 2's band is the only one left, and it is still indexed.
    try testing.expectEqual(@as(i64, 1), try f.count("SELECT COUNT(*) FROM segment_search;"));
    try testing.expectEqual(@as(i64, 1), try f.count(
        "SELECT COUNT(*) FROM segment_fts WHERE segment_fts MATCH 'duplicated';",
    ));

    // And user 2 dropping their last reference really does reap it.
    try f.files.purgeUser(2);
    try testing.expectEqual(@as(i64, 0), try f.count("SELECT COUNT(*) FROM blobs;"));
}

test "re-indexing a page replaces its FTS entry instead of duplicating it" {
    var f = try Fixture.init();
    defer f.deinit();

    _ = try f.putNote(1, "n.note", &.{"stable transcript"});
    const rowid = try f.count("SELECT id FROM note_page_index;");

    // Force the self-healing rebuild path (a stale `index_version`) repeatedly.
    for (0..3) |_| {
        try f.db.exec("UPDATE note_index SET index_version = 0;");
        var md5: [blobstore.md5_hex_len]u8 = undefined;
        {
            var s = try f.db.prepare("SELECT blob_md5 FROM note_index;");
            defer s.finalize();
            try testing.expect(try s.step());
            @memcpy(&md5, s.columnText(0)[0..blobstore.md5_hex_len]);
        }
        try noteindex.ensureIndexed(testing.allocator, testing.io, f.db, f.files.blobs, &md5, 1);
    }

    // The page row kept its rowid (the FTS `content_rowid`), and the FTS index
    // holds exactly one entry for it — not four.
    try testing.expectEqual(rowid, try f.count("SELECT id FROM note_page_index;"));
    try testing.expectEqual(@as(i64, 1), try f.ftsRows());
    try testing.expectEqual(@as(i64, 1), try f.count(
        "SELECT COUNT(*) FROM segment_fts WHERE segment_fts MATCH 'transcript';",
    ));
    try f.db.exec("INSERT INTO segment_fts(segment_fts) VALUES('integrity-check');");
}

test "a page whose text CHANGES under re-index drops the old terms and gains the new" {
    var f = try Fixture.init();
    defer f.deinit();

    _ = try f.putNote(1, "n.note", &.{"before"});
    try testing.expectEqual(@as(i64, 1), try f.count(
        "SELECT COUNT(*) FROM segment_fts WHERE segment_fts MATCH 'before';",
    ));

    // Rewrite the stored transcript the way an `index_version` bump with a
    // different derivation would, then re-sync through the two explicit calls.
    var md5: [blobstore.md5_hex_len]u8 = undefined;
    {
        var s = try f.db.prepare("SELECT blob_md5 FROM note_index;");
        defer s.finalize();
        try testing.expect(try s.step());
        @memcpy(&md5, s.columnText(0)[0..blobstore.md5_hex_len]);
    }
    try unindexBlob(f.db, &md5); // BEFORE: the row still says "before"
    try f.db.exec("UPDATE note_page_index SET text = 'after';");
    try indexBlob(f.db, &md5);

    try testing.expectEqual(@as(i64, 0), try f.count(
        "SELECT COUNT(*) FROM segment_fts WHERE segment_fts MATCH 'before';",
    ));
    try testing.expectEqual(@as(i64, 1), try f.count(
        "SELECT COUNT(*) FROM segment_fts WHERE segment_fts MATCH 'after';",
    ));
    try f.db.exec("INSERT INTO segment_fts(segment_fts) VALUES('integrity-check');");
}

test "THE RE-MINT TEST: a 100-page flip with one edited page re-mints the whole band CONTIGUOUS in page order" {
    var f = try Fixture.init();
    defer f.deinit();

    var labels: [100][]const u8 = undefined;
    for (&labels, 0..) |*l, i| l.* = try std.fmt.allocPrint(f.a(), "word{d} common", .{i});
    const big = try f.putLabeled(1, "big.note", &labels);

    var max_before: i64 = 0;
    for (0..100) |i| max_before = @max(max_before, try f.segRowid(1, @intCast(i)));

    // The new VERSION: same note, page 5 edited. Content addressing makes it a
    // new blob; the whole-doc-band re-mint drops the owner's old band and mints
    // the new pages afresh in page order — `rowid ASC == page order` by
    // construction, so no edited page can land at a tail rowid out of order.
    labels[5] = try std.fmt.allocPrint(f.a(), "edited fresh common", .{});
    try testing.expectEqual(big, try f.putLabeled(1, "big.note", &labels));

    // TWO blobs now: hot-cache versioning RETAINS the superseded version (its
    // blob is kept alive by a `file_history` row), so the old blob is no longer
    // GC'd on the replace. But search stays CURRENT-ONLY (the H2 invariant): the
    // whole band re-minted to exactly 100 segment rows — the retained version
    // never re-enters the FTS.
    try testing.expectEqual(@as(i64, 2), try f.count("SELECT COUNT(*) FROM blobs;"));
    try testing.expectEqual(@as(i64, 1), try f.count("SELECT COUNT(*) FROM file_history;"));
    try testing.expectEqual(@as(i64, 100), try f.count("SELECT COUNT(*) FROM segment_search;"));

    // THE CANONICAL-ORDER PIN: the band is CONTIGUOUS and strictly ascending in
    // page order — rowid(page i+1) == rowid(page i) + 1 for every page.
    var prev = try f.segRowid(1, 0);
    try testing.expect(prev > max_before); // the whole note re-minted ABOVE the old — it bubbles as a unit
    for (1..100) |i| {
        const cur = try f.segRowid(1, @intCast(i));
        try testing.expectEqual(prev + 1, cur);
        prev = cur;
    }

    // The index atomically holds exactly one version: the old page's postings
    // are gone from it, the new text is present at page 5's OWN masked rowid,
    // and the shared term matches 100 docs — not 199.
    try testing.expectEqual(@as(i64, 0), try f.count(
        "SELECT COUNT(*) FROM segment_fts WHERE segment_fts MATCH '\"word5\"';",
    ));
    try testing.expectEqual(@as(i64, 1), try f.count(
        "SELECT COUNT(*) FROM segment_fts WHERE segment_fts MATCH 'edited';",
    ));
    try testing.expectEqual(try f.segRowid(1, 5), try f.matchRowid("edited"));
    try testing.expectEqual(@as(i64, 100), try f.count(
        "SELECT COUNT(*) FROM segment_fts WHERE segment_fts MATCH 'common';",
    ));
    try testing.expectEqual(@as(i64, 100), try f.ftsRows());
    try f.db.exec("INSERT INTO segment_fts(segment_fts) VALUES('integrity-check');");
}

test "THE REORDER PIN: a reordered flip re-mints so rowid ASC follows the NEW page order" {
    var f = try Fixture.init();
    defer f.deinit();

    _ = try f.putLabeled(1, "n.note", &.{ "alpha", "beta", "gamma" });

    // Same pages, new order — a new blob. Under the whole-doc-band re-mint the
    // band is dropped and re-minted in the NEW page order, so `rowid ASC ==
    // reading order` tracks the reorder instead of the (now stale) insertion
    // order the old repoint-in-place flip would have frozen. This is the whole
    // reason in-doc keyset batching needs no re-sort.
    _ = try f.putLabeled(1, "n.note", &.{ "gamma", "alpha", "beta" });

    // rowid ASC now spells the new order: gamma (page 0) < alpha (page 1) < beta (page 2).
    const g_row = try f.segRowidByText(1, "gamma");
    const a_row = try f.segRowidByText(1, "alpha");
    const b_row = try f.segRowidByText(1, "beta");
    try testing.expectEqual(g_row + 1, a_row);
    try testing.expectEqual(a_row + 1, b_row);
    // And the segment rowid of a page equals its page-order position in the band.
    try testing.expectEqual(g_row, try f.segRowid(1, 0));
    try testing.expectEqual(a_row, try f.segRowid(1, 1));
    try testing.expectEqual(b_row, try f.segRowid(1, 2));

    // The posting followed the row: gamma is indexed at page 0's masked rowid.
    try testing.expectEqual(@as(i64, 1), try f.count(
        "SELECT COUNT(*) FROM segment_fts WHERE segment_fts MATCH 'gamma';",
    ));
    try testing.expectEqual(g_row, try f.matchRowid("gamma"));
    try f.db.exec("INSERT INTO segment_fts(segment_fts) VALUES('integrity-check');");
}

test "an inserted page re-mints the whole band so rowid ASC stays page order" {
    var f = try Fixture.init();
    defer f.deinit();

    const id = try f.putLabeled(1, "n.note", &.{ "alpha", "omega" });
    try testing.expectEqual(id, try f.putLabeled(1, "n.note", &.{ "alpha", "inserted", "omega" }));

    // The insert shifts omega from page 1 to page 2; the whole band re-mints in
    // page order, so the inserted page lands BETWEEN alpha and omega (not at a
    // tail rowid) — the coordinate follows position, not arrival.
    const a_row = try f.segRowidByText(1, "alpha");
    const i_row = try f.segRowidByText(1, "inserted");
    const o_row = try f.segRowidByText(1, "omega");
    try testing.expectEqual(a_row + 1, i_row);
    try testing.expectEqual(i_row + 1, o_row);
    // omega really is page 2 now, and its posting moved with it.
    try testing.expectEqual(o_row, try f.segRowid(1, 2));
    try testing.expectEqual(o_row, try f.matchRowid("omega"));
    try f.db.exec("INSERT INTO segment_fts(segment_fts) VALUES('integrity-check');");
}

test "re-parse of the SAME blob preserves masked rowids: a heal writes nothing, arriving text refreshes in place" {
    var f = try Fixture.init();
    defer f.deinit();

    _ = try f.putNote(1, "n.note", &.{"stable words"});
    const seg = try f.segRowid(1, 0);

    // The lazy heal (stale index_version, same bytes): ids preserved, and the
    // per-page text diff means ZERO posting writes — the fingerprint spy again.
    const fp = try f.ftsFingerprint();
    var md5: [blobstore.md5_hex_len]u8 = undefined;
    {
        var s = try f.db.prepare("SELECT blob_md5 FROM note_index;");
        defer s.finalize();
        try testing.expect(try s.step());
        @memcpy(&md5, s.columnText(0)[0..blobstore.md5_hex_len]);
    }
    try f.db.exec("UPDATE note_index SET index_version = 0;");
    try noteindex.ensureIndexed(testing.allocator, testing.io, f.db, f.files.blobs, &md5, 1);
    try testing.expectEqual(seg, try f.segRowid(1, 0));
    try testing.expectEqual(fp, try f.ftsFingerprint());

    // Text that actually changes (recognition arriving on a later re-parse,
    // simulated through the same delete-before/insert-after pair `store`
    // uses) refreshes the postings at the SAME masked rowid.
    try deletePagePostings(f.db, &md5, 0);
    try f.db.exec("UPDATE note_page_index SET text = 'arrived transcript';");
    try insertPagePostings(f.db, &md5, 0);
    try testing.expectEqual(seg, try f.segRowid(1, 0));
    try testing.expectEqual(@as(i64, 0), try f.count(
        "SELECT COUNT(*) FROM segment_fts WHERE segment_fts MATCH 'stable';",
    ));
    try testing.expectEqual(@as(i64, 1), try f.count(
        "SELECT COUNT(*) FROM segment_fts WHERE segment_fts MATCH 'arrived';",
    ));
    try testing.expectEqual(seg, try f.matchRowid("arrived"));
    try f.db.exec("INSERT INTO segment_fts(segment_fts) VALUES('integrity-check');");
}

test "generation remint preserves results byte-for-byte, burns a fresh partition, and leaves the housemate alone" {
    var f = try Fixture.init();
    defer f.deinit();

    _ = try f.putNote(1, "a.note", &.{"orçamento anual"});
    _ = try f.putNote(1, "b.note", &.{"reunião marcada"});
    _ = try f.putNote(2, "theirs.note", &.{"orçamento deles"});

    // The asks are FOLDED terms rather than raw user input: with the read path
    // deleted there is nothing left to fold a query, and `segment_fts` holds
    // exactly what `unicode61 remove_diacritics 2` made of the transcript.
    const asks = [_][]const u8{ "orcamento", "reuniao", "anual" };
    var golden: [asks.len][]i64 = undefined;
    for (asks, 0..) |q, i| golden[i] = try f.matchedSegments(1, q);
    const theirs_golden = try f.matchedSegments(2, "orcamento");
    const p_old = (try partition.active(f.db, 1)).?;
    const p2 = (try partition.active(f.db, 2)).?;

    try remintUserSearch(f.db, 1, 42);

    // A FRESH partition id (never reused), the old range empty, the flip done.
    const p_new = (try partition.active(f.db, 1)).?;
    try testing.expect(p_new > p_old);
    try testing.expect(p_new != p2);
    {
        var s = try f.db.prepare("SELECT COUNT(*) FROM segment_search WHERE id BETWEEN ?1 AND ?2;");
        defer s.finalize();
        s.bindInt(1, partition.base(p_old));
        s.bindInt(2, partition.last(p_old));
        _ = try s.step();
        try testing.expectEqual(@as(i64, 0), s.columnInt(0));
    }

    // The same answers: every masked rowid was reissued, and the shared page
    // rows reached through them are identical — nothing anyone can see is
    // derived from what the mask means.
    for (asks, 0..) |q, i| {
        try testing.expect(golden[i].len > 0);
        try testing.expectEqualSlices(i64, golden[i], try f.matchedSegments(1, q));
    }
    // The housemate's world did not move.
    try testing.expectEqual(@as(usize, 1), theirs_golden.len);
    try testing.expectEqualSlices(i64, theirs_golden, try f.matchedSegments(2, "orcamento"));
    try f.db.exec("INSERT INTO segment_fts(segment_fts) VALUES('integrity-check');");
}

test "EDITED-DOC ORDER: a version-flip edit keeps the band CONTIGUOUS and streams in page order" {
    var f = try Fixture.init();
    defer f.deinit();

    // Other notes widen the partition; our note is contiguous at ingest.
    _ = try f.putPages(1, "noise.note", 20, &.{"filler common"});
    const doc = try f.putLabeled(1, "doc.note", &.{
        "p0 common", "p1 common", "p2 common", "p3 common", "p4 common", "p5 common",
    });
    {
        const at_ingest = try f.noteSegIds(doc);
        try testing.expectEqual(@as(usize, 6), at_ingest.len);
        for (at_ingest, 0..) |rid, i| try testing.expectEqual(at_ingest[0] + @as(i64, @intCast(i)), rid);
    }

    // Edit pages 1 and 3, and REORDER by editing text. Under the whole-doc-band
    // re-mint (in-doc-search plan Phase 1) the note re-mints CONTIGUOUS in page
    // order every time — the old text_hash diff would have scattered the two
    // edited pages to tail rowids; now the band stays one range.
    const doc2 = try f.putLabeled(1, "doc.note", &.{
        "p0 common", "p1 EDITED common", "p2 common", "p3 EDITED common", "p4 common", "p5 common",
    });
    try testing.expectEqual(doc, doc2); // a version replace keeps the file id

    // The band is exactly the note's six current segment rowids, still ONE
    // contiguous run after the edit, and `rowid ASC == page order`. That is the
    // property the in-doc read leant on and that the re-mint and heal paths are
    // still defined in terms of; the derived scan ranges it used to be checked
    // against (`query.docSegmentRanges`) went with §6 step 7, so contiguity of
    // the band itself is the same statement, made directly.
    const ids = try f.noteSegIds(doc);
    try testing.expectEqual(@as(usize, 6), ids.len);
    for (ids, 0..) |rid, i| {
        try testing.expectEqual(ids[0] + @as(i64, @intCast(i)), rid); // page i at lo+i
        try testing.expectEqual(rid, try f.noteSegRowid(doc, @intCast(i)));
    }

    // And the band is COMPLETE inside its own bracket: all six pages carry the
    // shared term, both edits are in there, and the twenty noise pages — which
    // also match `common` — are outside it.
    try testing.expectEqual(@as(i64, 6), try f.matchesIn("common", ids[0], ids[5]));
    try testing.expectEqual(@as(i64, 2), try f.matchesIn("edited", ids[0], ids[5]));
    try f.db.exec("INSERT INTO segment_fts(segment_fts) VALUES('integrity-check');");
}

test "HEAL RE-CANONICALIZES: an index_version bump re-mints a legacy-scattered band into page order" {
    var f = try Fixture.init();
    defer f.deinit();

    _ = try f.putPages(1, "noise.note", 8, &.{"filler common"});
    const doc = try f.putLabeled(1, "doc.note", &.{
        "p0 common", "p1 common", "p2 common", "p3 common", "p4 common",
    });

    // Reproduce a band a PAST incremental flip scattered (pages 1 and 3 at tail
    // rowids) — the shape the heal exists to retire. Scattered means precisely
    // that the band's masked rowids are no longer one contiguous run.
    try f.scatterPages(1, doc, &.{ 1, 3 });
    {
        const scattered = try f.noteSegIds(doc);
        var contiguous = true;
        for (scattered, 0..) |rid, i| {
            if (rid != scattered[0] + @as(i64, @intCast(i))) contiguous = false;
        }
        try testing.expect(!contiguous);
    }

    // Stale the blob's index_version and run the lazy heal, exactly as a first
    // read after the 7→8 bump would. `recanonicalizeHolders` re-mints the band.
    var md5: [blobstore.md5_hex_len]u8 = undefined;
    {
        var s = try f.db.prepare("SELECT blob_md5 FROM note_index WHERE indexable = 1 AND blob_md5 IN (SELECT md5 FROM files WHERE id = ?1);");
        defer s.finalize();
        s.bindInt(1, @intCast(doc));
        try testing.expect(try s.step());
        @memcpy(&md5, s.columnText(0)[0..blobstore.md5_hex_len]);
    }
    {
        var s = try f.db.prepare("UPDATE note_index SET index_version = 0 WHERE blob_md5 = ?1;");
        defer s.finalize();
        s.bindText(1, &md5);
        _ = try s.step();
    }
    try noteindex.ensureIndexed(testing.allocator, testing.io, f.db, f.files.blobs, &md5, 999);

    // The band is CANONICAL again: one contiguous run, `rowid ASC == page
    // order`, and every one of its five pages still indexed.
    const ids = try f.noteSegIds(doc);
    try testing.expectEqual(@as(usize, 5), ids.len);
    for (ids, 0..) |rid, i| {
        try testing.expectEqual(ids[0] + @as(i64, @intCast(i)), rid);
        try testing.expectEqual(rid, try f.noteSegRowid(doc, @intCast(i)));
    }
    try testing.expectEqual(@as(i64, 5), try f.matchesIn("common", ids[0], ids[4]));

    // A SECOND heal of the now-canonical band writes nothing — no recency churn.
    const fp = try f.ftsFingerprint();
    {
        var s = try f.db.prepare("UPDATE note_index SET index_version = 0 WHERE blob_md5 = ?1;");
        defer s.finalize();
        s.bindText(1, &md5);
        _ = try s.step();
    }
    try noteindex.ensureIndexed(testing.allocator, testing.io, f.db, f.files.blobs, &md5, 1000);
    try testing.expectEqual(fp, try f.ftsFingerprint());
}
