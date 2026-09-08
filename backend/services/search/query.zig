//! The READ face of the `search/` package: full-text search INSIDE one document
//! — find-in-note and find-in-txt over the recognized (on-device OCR)
//! transcripts and `.txt` paragraphs the indexer stores in
//! `note_page_index.text`. The package — this file, plus `maintain.zig` (the
//! writes/lifecycle) and `fuzzy.zig` (the shared tokenizer primitives) — is the
//! SOLE owner of the `segment_fts` FTS5 table and its `segment_search` rows;
//! nothing outside it may touch them. (`search_partition.zig` owns the mask
//! arithmetic and the sequence allocator; the partitioned-search design is what
//! this implements.)
//!
//! **GLOBAL SEARCH IS NOT HERE ANY MORE.** `golden-search.md` §6 step 6 deleted
//! it: the browser holds the term index and answers every library-wide query,
//! and the server interprets no query across documents at all. What survives is
//! the per-document read, and step 7 retires that too once `text/<md5>` can be
//! searched in the same wasm engine. So this file is a way station, and the
//! machinery below is sized for one document rather than for a library.
//!
//! ## The shape: one segment row per (owner, segment), rowid-masked
//!
//! `note_page_index` stays md5-keyed and deduplicated — one copy of the text.
//! `segment_search` holds one ~24-byte row per (owner, segment), whose rowid is
//! `(partition << 48) | seq`; the `segment_text` view resolves that masked
//! rowid back to the shared text, and `segment_fts` indexes THROUGH the view.
//! Postings therefore duplicate only for content two people genuinely share,
//! and a rowid RANGE constraint scopes a search to one owner's partition —
//! FTS5 pushes both bounds into its index (the pinned `M1><` plan). An in-doc
//! read narrows that bracket further, to the DOCUMENT'S own segment ranges
//! (`docSegmentRanges`), so a find costs what the open document costs.
//!
//! ## The join is the security boundary — and the package is what guards it
//!
//! MASK FOR SPEED, JOIN FOR CORRECTNESS. The rowid bracket only scopes the
//! scan; a forged or miscomputed rowid must be stopped by the `files` join
//! (`user_id = ? AND deleted = 0`) — the mask is never the access check. Both
//! exported reads — `searchNotePages` and `searchTxtSegments` — are built on the
//! ONE `scoped_from_where` clause below, so the join cannot be forgotten in a
//! second entry point; the `search/` package boundary is what keeps the FTS
//! table's reads and writes from leaking into a fourth file where it could be. A
//! scoped read can only ADD a bound to the shared clause, never narrow it.
//!
//! The writes that mint and retire these rows live in `maintain.zig`; every one
//! runs inside the caller's transaction, and wherever postings are subtracted
//! the FTS 'delete' runs FIRST, while the text it was indexed from still
//! resolves. See that module's header for the three-path lifecycle.

const std = @import("std");
const sqlite = @import("../../db/sqlite.zig");
const partition = @import("../search_partition.zig");

// The reads name fuzzy.zig's shared tokenizer primitives, and maintain.zig's
// shared `fts_predicate`, through these aliases. This block lists exactly what
// those reads depend on; symbols exercised ONLY by this file's tests are named
// `fuzzy.x` / `maintain.x` directly at the call site rather than aliased.
const fuzzy = @import("fuzzy.zig");
const min_prefix_len = fuzzy.min_prefix_len;
const appendToken = fuzzy.appendToken;
const termLen = fuzzy.termLen;
const foldRows = fuzzy.foldRows;
const foldTerms = fuzzy.foldTerms;

/// In-document keyset batch size. The find-in-note / find-in-txt entry points
/// (`searchNotePages`, `searchTxtSegments`) return ONE batch of this many
/// matching segments plus a `cursor` to resume — the client auto-drains to the
/// exact count.
/// A separate batch is a separate request and so a separate small `dbLock`
/// window, which is the fairness win: a big document is N bounded windows with
/// yield points between, never one multi-second hold. `default_batch` is the
/// client's stride; `max_batch` caps a hostile `?batch=` so one request can
/// never be asked to scan an unbounded slice.
pub const default_batch: i64 = 20;
pub const max_batch: i64 = 200;

/// Longest raw query we consider. Anything past this is dropped rather than
/// tokenized — a megabyte of `q=` must not become a megabyte of MATCH text.
pub const max_query_len: usize = 256;

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

/// THE query shape, written ONCE and shared by both exported reads. Every clause
/// is load-bearing:
///
///   - `segment_fts MATCH ?1` — the actual search.
///   - `segment_fts.rowid BETWEEN ?2 AND ?3` — a masked-rowid bracket, pushed
///     INTO the FTS index by FTS5 (the `M1><` plan a test pins). The in-document
///     reads bind the DOCUMENT'S own segment ranges here (`docSegmentRanges`),
///     one `M1><` pass per range, and the keyset cursor folds into the SAME two
///     bounds (`?2 = max(lo, cursor + 1)`) — so a resumed batch resumes exactly
///     where the last stopped and there is one plan to pin rather than two.
///   - `JOIN segment_search s` / `JOIN note_page_index p` — the masked rowid
///     back to the SHARED text row (dedup intact: one copy of the text).
///   - `JOIN files f ON f.md5 = p.blob_md5` + `f.user_id = ?4` + `f.deleted =
///     0` + `f.is_folder = 0` — MASK FOR SPEED, JOIN FOR CORRECTNESS: the
///     range only scopes the scan; a forged or miscomputed rowid must be
///     stopped HERE. The join is the access check, never the mask.
///   - `p.recogn_status = 1` — only finished recognition is searchable.
///
/// No `ORDER BY bm25`: an in-document find is unranked by contract — it drains
/// to the exact per-document count, and a rank would make the window it drained
/// the answer instead of the whole document.
///
/// **The access path is left to the planner, and that is a decision.** Both reads
/// add `f.id = ?5`, and SQLite then plans `f` FIRST, as `SEARCH f USING INTEGER
/// PRIMARY KEY (rowid=?)`: one point lookup of the one file, done ONCE, before
/// the FTS scan starts. Forcing `INDEXED BY files_md5` moves `f` to the INNER
/// loop and buys a per-row index seek that nothing asked for — MEASURED on a
/// 30-page document, 408 steps by primary key against 590 forced through
/// `files_md5`.
///
/// The bigger loss is the short-circuit. With `f` outer, a note id that is
/// someone else's, trashed or imaginary resolves to no row and the FTS scan
/// never runs — 19 steps. Forced inner, the scan runs to completion and every
/// row is discarded afterwards: 18,024 steps for the same empty answer. The
/// range derivation in `docSegmentRanges` usually spares us that, but it is
/// documented as "a mask for speed" and correctness is NOT allowed to rest on
/// it, so neither is cost.
///
/// There must never be two copies of this: the module docs call the `files` join
/// a security boundary and warn that "a second entry point would be a place to
/// forget it". A scoped query cannot narrow the join, it can only add to it.
///
/// `?1` MATCH, `?2`/`?3` rowid bounds, `?4` the caller's user id.
const scoped_from_where =
    \\  FROM segment_fts
    \\  JOIN segment_search s ON s.id = segment_fts.rowid
    \\  JOIN note_page_index p ON p.id = s.segment_id
    \\  JOIN files f ON f.md5 = p.blob_md5
    \\ WHERE segment_fts MATCH ?1
    \\   AND segment_fts.rowid BETWEEN ?2 AND ?3
    \\   AND f.user_id = ?4
    \\   AND f.deleted = 0
    \\   AND f.is_folder = 0
    \\   AND p.recogn_status = 1
;

/// The masked rowid as an opaque token: 16 lowercase hex digits. Hex on
/// purpose — the partition is the top four digits, so a cursor in a log line
/// is as readable as a rowid in an EXPLAIN dump.
fn encodeCursor(arena: std.mem.Allocator, rowid: i64) ![]const u8 {
    return std.fmt.allocPrint(arena, "{x:0>16}", .{@as(u64, @intCast(rowid))});
}

/// Validates a client-supplied cursor: hex, at most 16 digits, bit 63 clear.
/// Null for anything else — the caller answers 400, not 500. What the value
/// MEANS is still never trusted: the partition range and the `files` join
/// bound whatever rowid comes back.
pub fn decodeCursor(c: []const u8) ?i64 {
    if (c.len == 0 or c.len > 16) return null;
    const v = std.fmt.parseInt(u64, c, 16) catch return null;
    if (v > std.math.maxInt(i64)) return null; // bit 63 must be clear
    return @intCast(v);
}

/// BENCH ONLY, driven by `backend/indoc_bench.zig` (`zig build indoc-bench`).
/// **Nothing in the server reaches this**: no route, no handler and no other
/// module names it, and it changes no behaviour of anything above.
///
/// It exists to cost `client-side-search-impl.md` §7.3 — whether the two live
/// in-doc reads (`searchNotePages`, `searchTxtSegments`) could adopt
/// `searchHistoryPages`' shape and stop reading `segment_fts`, which is what
/// makes phase 2's deletion reachable without any client work. The scan shape
/// itself is `searchHistoryPages`, already public and already shipped; what is
/// here is only what that function cannot answer on its own:
///
///   * `scanTxt` — the same scan with the `kind = 1` filter the `.txt` read
///     needs. `searchHistoryPages` has none (a `.note` blob holds only kind-0
///     rows), so pointing it at a `.txt` would count the whole-document row as
///     well as the paragraphs and answer a different question.
///   * `scanStepped` — the same answer with the rows STEPPED rather than
///     accumulated, to establish whether the whole-document arena the scan
///     holds is structural or an implementation detail. The shipped comment in
///     `searchHistoryPages` asserts the rows must be collected first; this is
///     the experiment that says whether that is true.
///
/// Both report a summary rather than the rows, because the bench compares
/// COUNTS (its fidelity gate) and times, not wire shapes.
pub const indoc_bench = struct {
    /// What one scan found, in the terms both shapes can be compared on.
    pub const Scanned = struct {
        /// Rows the outer `SELECT` returned — the pages the scan READ, which is
        /// the whole document and the reason the shape is in question.
        rows_read: usize,
        /// Bytes of `text` those rows carried — the scan's input size.
        text_bytes: usize,
        /// Pages with at least one match — the answer, comparable to a drained
        /// `searchNotePages` stream's page count.
        pages: usize,
        /// Word instances matched across them — the second half of the answer.
        matches: i64,
        /// `countMatches` calls, i.e. `temp.token_fold` round trips. The scan
        /// pays one per page READ; the FTS path pays one per page MATCHED.
        folds: usize,
    };

    /// `searchHistoryPages` VERBATIM, summarised — the `.note`/PDF scan.
    pub fn scanNote(arena: std.mem.Allocator, db: sqlite.Db, md5: []const u8, raw_query: []const u8) !Scanned {
        // The row-reading half is re-stated rather than called, because
        // `searchHistoryPages` discards `rows_read`/`text_bytes` and those two
        // are the whole point of the measurement. The SQL, the order, the dupe
        // and the count are byte-identical to it; `scanFidelity` in the bench
        // asserts the answers agree.
        return scan(arena, db, md5, raw_query, false);
    }

    /// The same scan with the paragraph filter `searchTxtSegments` applies.
    pub fn scanTxt(arena: std.mem.Allocator, db: sqlite.Db, md5: []const u8, raw_query: []const u8) !Scanned {
        return scan(arena, db, md5, raw_query, true);
    }

    const scan_note_sql = "SELECT page_index, text FROM note_page_index " ++
        "WHERE blob_md5 = ?1 AND text IS NOT NULL ORDER BY page_index;";
    const scan_txt_sql = "SELECT page_index, text FROM note_page_index " ++
        "WHERE blob_md5 = ?1 AND text IS NOT NULL AND kind = 1 ORDER BY page_index;";

    /// COLLECT-then-count, exactly as `searchHistoryPages` does it: every page's
    /// transcript is duped into `arena` before any counting runs.
    fn scan(
        arena: std.mem.Allocator,
        db: sqlite.Db,
        md5: []const u8,
        raw_query: []const u8,
        comptime txt: bool,
    ) !Scanned {
        const query = try arena.dupe(u8, trimQuery(raw_query));
        const terms = try queryTerms(arena, db, query, isStillTyping(raw_query));
        if (terms.len == 0) return .{ .rows_read = 0, .text_bytes = 0, .pages = 0, .matches = 0, .folds = 0 };

        const ScanRow = struct { index: i64, text: []const u8 };
        var rows: std.ArrayList(ScanRow) = .empty;
        var text_bytes: usize = 0;
        {
            var s = try db.prepare(if (txt) scan_txt_sql else scan_note_sql);
            defer s.finalize();
            s.bindText(1, md5);
            while (try s.step()) {
                const t = try arena.dupe(u8, s.columnText(1));
                text_bytes += t.len;
                try rows.append(arena, .{ .index = s.columnInt(0), .text = t });
            }
        }

        var out: Scanned = .{
            .rows_read = rows.items.len,
            .text_bytes = text_bytes,
            .pages = 0,
            .matches = 0,
            .folds = 0,
        };
        for (rows.items) |row| {
            const counted = try countMatches(arena, db, row.text, terms);
            out.folds += 1;
            if (counted.matches > 0) {
                out.pages += 1;
                out.matches += counted.matches;
            }
        }
        return out;
    }

    /// The SAME answer with the rows STEPPED — one page's transcript alive at a
    /// time, counted inside the open cursor rather than after it closes.
    ///
    /// `searchHistoryPages` says this cannot be done, because `countMatches`
    /// runs its own statements on this connection "(and would invalidate the
    /// borrowed `columnText`)". Two claims are folded together there: the temp
    /// `token_fold` writes, and the borrow. The borrow one is answerable — a
    /// `sqlite3_column_text` pointer is invalidated by stepping, resetting or
    /// finalizing ITS OWN statement, not by traffic on other statements — so the
    /// text is passed straight to `countMatches` with no dupe. Whether the write
    /// half holds is what running this measures; the bench's fidelity gate
    /// (identical pages/matches against `scan`) is what makes it an answer
    /// rather than an assumption.
    pub fn scanStepped(
        arena: std.mem.Allocator,
        gpa: std.mem.Allocator,
        db: sqlite.Db,
        md5: []const u8,
        raw_query: []const u8,
        txt: bool,
    ) !Scanned {
        const query = try arena.dupe(u8, trimQuery(raw_query));
        const terms = try queryTerms(arena, db, query, isStillTyping(raw_query));
        if (terms.len == 0) return .{ .rows_read = 0, .text_bytes = 0, .pages = 0, .matches = 0, .folds = 0 };

        var out: Scanned = .{ .rows_read = 0, .text_bytes = 0, .pages = 0, .matches = 0, .folds = 0 };

        // The per-page scratch: `countMatches` allocates the matched terms, and
        // a scan that accumulated THOSE across a whole document would have moved
        // the unboundedness rather than removed it. Reset per page; only a
        // MATCHING page's answer is kept, and there are few of those.
        var scratch = std.heap.ArenaAllocator.init(gpa);
        defer scratch.deinit();

        var s = try db.prepare(if (txt) scan_txt_sql else scan_note_sql);
        defer s.finalize();
        s.bindText(1, md5);
        while (try s.step()) {
            const text = s.columnText(1);
            out.rows_read += 1;
            out.text_bytes += text.len;
            _ = scratch.reset(.retain_capacity);
            const counted = try countMatches(scratch.allocator(), db, text, terms);
            out.folds += 1;
            if (counted.matches > 0) {
                out.pages += 1;
                out.matches += counted.matches;
            }
        }
        return out;
    }
};

// ---------------------------------------------------------------------------
// Note-scoped query — find-in-note's counter and filmstrip badges
// ---------------------------------------------------------------------------

/// One matching page of one note.
pub const PageMatch = struct {
    pageIndex: i64,
    /// How many words on the page match — the number the filmstrip badge shows
    /// and what the note-wide counter sums. Never 0: the row exists because the
    /// index matched it, so a 0 here would be a counting bug reported as an
    /// absence.
    matches: i64,
    /// WHICH terms this page matched, as the INDEX sees them — folded through
    /// `fts_tokenizer`, so lowercase and stripped of diacritics.
    ///
    /// ## Why the server has to say this
    ///
    /// Find draws an oval round each word it counted. The client cannot re-derive
    /// which words those are without re-implementing everything this query knows:
    /// the prefix `*` expansion (`interv` → the terms actually in this page's
    /// vocabulary), `remove_diacritics 2`'s exact folding, and — since the typo
    /// fallback runs here too — which vocabulary near-miss a token expanded into.
    /// It used to guess with a folded substring test, and the two agreed only by
    /// luck; that coincidence is what kept the fallback switched off on this
    /// route, because a count quietly including near-misses would have disagreed
    /// with what was circled.
    ///
    /// So the ovals are now DERIVED FROM WHAT WAS COUNTED. The client folds each
    /// word rectangle's label the same way and circles it when one of its tokens
    /// equals one of these — an equality test, not a second matching rule.
    ///
    /// THE DIRECTION OF AUTHORITY IS ONE-WAY. `matches` is never derived from
    /// this list: the count is the index's answer over the page transcript, the
    /// terms are an aid to pointing at it. Where the word rectangles tokenise
    /// differently from the transcript the two can still disagree, and when they
    /// do THE COUNT WINS — the number says how many the index found, the ovals
    /// show the ones that can be pointed at.
    terms: []const []const u8,
};

pub const NoteResults = struct {
    /// Echoed because find searches on every keystroke, and a late response has
    /// to be discardable.
    query: []const u8,
    /// ONE keyset batch of matching pages, in `rowid ASC` order — which Phase 1
    /// makes reading order for a canonical band, so the client accumulates
    /// batches with no re-sort. NOT the whole note in one response any more (the
    /// synchronous complete scan is gone): the client auto-drains `cursor` to
    /// reach the exact "N in M pages" count. See `searchNotePages`.
    pages: []const PageMatch,
    /// Keyset resumption token (16 hex of the last batch's masked segment
    /// rowid): present only when more matching pages may exist, absent (omitted
    /// from the JSON) when the document is exhausted — the "stop draining"
    /// signal. Passing it back as `?cursor=` resumes the stream where it
    /// stopped.
    cursor: ?[]const u8 = null,
};

/// The note-scoped read, ordered by `segment_fts.rowid ASC` and `LIMIT`ed, so
/// one batch resumes exactly where the last stopped. The cursor folds into the `?2` lower bound (`?2 = max(range
/// lo, cursor+1)`) — one bracket, one `M1><` pushdown to pin, no extra clause.
/// `?6` is the batch limit (+1, to learn "more may exist" as a fact rather than
/// a guess).
const note_keyset_sql =
    \\SELECT p.page_index, p.text, s.id
++ "\n" ++ scoped_from_where ++ "\n" ++
    \\   AND f.id = ?5
    \\ ORDER BY segment_fts.rowid ASC
    \\ LIMIT ?6;
;

// ---------------------------------------------------------------------------
// In-document scoping — the SAME query, the DOCUMENT'S rowid bracket
// ---------------------------------------------------------------------------

// Both in-doc reads run `scoped_from_where` VERBATIM — same `segment_fts`, same
// tokenizer, same `MATCH`, same `files` join written ONCE. The only thing that
// varies is the rowid bracket bound into `?2 AND ?3`: the DOCUMENT'S own segment
// range rather than the owner's whole partition. FTS5 pushes that bracket into
// its index (the pinned `M1><` plan), so the query costs O(document) instead of
// O(library) — matching is identical BY CONSTRUCTION, only the scan is narrower.
//
// A note's segments are CONTIGUOUS at ingest (one range); a version-flip edit
// gives changed pages fresh TAIL rowids while unchanged pages keep theirs, so
// an edited note SCATTERS into a handful of ranges. We derive the actual ranges
// (never [min,max] — a scattered note's span can cover much of the partition,
// reintroducing the over-scan) and run one `M1><` pass per range. OR-of-BETWEEN
// was rejected empirically: FTS5 does NOT push it down (the plan degrades to a
// whole-postings `M1` scan), so per-range union is the shape that keeps the
// pushdown.

/// One coalesced, inclusive masked-rowid range inside one owner partition.
const Range = struct { lo: i64, hi: i64 };

/// The most disjoint ranges an in-doc search scans as separate `M1><` passes
/// before it stops per-range scoping and falls back to a single partition-wide
/// bracket (the bare `scoped_from_where` behaviour, correct but O(library)).
/// Since the whole-doc-band re-mint (Phase 1) a note is ONE contiguous range
/// after every edit — scatter now only survives as legacy state a past
/// incremental flip left behind (retired by the `index_version` heal on first
/// view), so a handful of ranges covers every realistic note; past this the
/// note is pathologically fragmented and one partition scan is cheaper than
/// dozens of posting-list walks. This caps BOTH the scan work and the number of
/// prepared-statement executions — the SQL is never built unbounded.
const doc_range_cap: usize = 8;

const doc_ranges_base =
    \\SELECT s.id
    \\  FROM segment_search s
    \\  JOIN note_page_index p ON p.id = s.segment_id
    \\  JOIN files f ON f.md5 = p.blob_md5
    \\ WHERE f.id = ?1
    \\   AND f.user_id = ?2
    \\   AND f.deleted = 0
    \\   AND f.is_folder = 0
    \\   AND s.id BETWEEN ?3 AND ?4
;

/// `.note` pages carry no `kind` filter (a `.note` blob holds only kind-0 rows).
const doc_ranges_note_sql = doc_ranges_base ++ "\n ORDER BY s.id;";

/// The `.txt` variant selects only `kind = 1` paragraph segments, exactly as
/// `txt_keyset_sql` does — the ranges must cover the same segments the search
/// itself will scan, no more.
const doc_ranges_txt_sql = doc_ranges_base ++ "\n   AND p.kind = 1\n ORDER BY s.id;";

/// The document's own segment-rowid ranges within the owner's partition
/// (`[lo, hi]`), coalesced and sorted. Cheap and fully indexed (see the pinned
/// plan): `files` PK → `note_page_index_blob` → `segment_search_segment`, the
/// partition bracket seeking inside the last.
///
/// The `files` join here is the SAME ownership gate the search itself applies,
/// so a foreign, trashed or non-existent note derives NO ranges and the search
/// is one indistinguishable empty answer — but the derivation is only a mask for
/// speed: the search's own `files` join is what actually enforces it. `txt`
/// selects the `.txt` (`kind = 1`) variant.
fn docSegmentRanges(
    arena: std.mem.Allocator,
    db: sqlite.Db,
    note_id: u64,
    user_id: u64,
    lo: i64,
    hi: i64,
    txt: bool,
) ![]const Range {
    var s = try db.prepare(if (txt) doc_ranges_txt_sql else doc_ranges_note_sql);
    defer s.finalize();
    s.bindInt(1, @intCast(note_id));
    s.bindInt(2, @intCast(user_id));
    s.bindInt(3, lo);
    s.bindInt(4, hi);

    var ranges: std.ArrayList(Range) = .empty;
    while (try s.step()) {
        const id = s.columnInt(0);
        if (ranges.items.len > 0 and ranges.items[ranges.items.len - 1].hi + 1 == id) {
            ranges.items[ranges.items.len - 1].hi = id; // extends the run
        } else {
            try ranges.append(arena, .{ .lo = id, .hi = id });
        }
    }
    return ranges.items;
}

/// The rowid brackets an in-doc search actually scans, from the document's
/// derived `ranges`: the ranges themselves when there are 1..`doc_range_cap` of
/// them (each an O(document) `M1><` pass), a single partition-wide bracket
/// `[part_lo, part_hi]` when a pathologically-scattered note exceeds the cap
/// (today's correct-but-slower behaviour — the `f.id` filter still scopes the
/// result, it just scans the whole partition), and nothing at all when the
/// document has no segments (a foreign/trashed/empty note → empty result).
fn scopedRuns(
    arena: std.mem.Allocator,
    ranges: []const Range,
    part_lo: i64,
    part_hi: i64,
) ![]const Range {
    if (ranges.len == 0) return &.{};
    if (ranges.len <= doc_range_cap) return ranges;
    const one = try arena.alloc(Range, 1);
    one[0] = .{ .lo = part_lo, .hi = part_hi };
    return one;
}

/// ONE keyset batch of the pages of ONE note that match `raw_query`, in
/// `rowid ASC` order, with a per-page match count, plus a `cursor` to resume.
///
/// ## Why the note is in the WHERE clause and not in a post-filter
///
/// A ranked library-wide read reused as a per-note counter is SILENTLY
/// INCOMPLETE in a way batching is not: a bm25 window drops the note being read
/// below other notes' higher-ranked hits, so the count is simply wrong. This
/// query scopes the scan to the document itself and rank plays no part — so
/// draining every batch reaches the EXACT per-note count, which a document
/// (being finite) always can.
///
/// ## Batched, not one monolith (the fairness win)
///
/// It used to scan the whole note in one response. On the single-core Pi that
/// was one multi-second `dbLock` hold that froze every other user. Now it is a
/// keyset stream — the rowid bracket is the DOCUMENT's — returning `batch`
/// pages and a `cursor`; the client
/// auto-drains. Each batch is a separate request and so a separate small lock
/// window with a yield point between, so a big note is N bounded windows, never
/// one monolith. `rowid ASC` is reading order for a canonical band (Phase 1),
/// so the accumulated batches need no re-sort.
///
/// ## What it deliberately does not do
///
///   - **No snippets.** The word rectangles the ovals are drawn from come from
///     `getPageText`, lazily, for the page actually on screen. A 200-page note
///     costs one of these plus one page-text request per page looked at.
///
/// ## The boundary is the same one
///
/// It runs through `scoped_from_where`, so `f.user_id`/`f.deleted`/`f.is_folder`
/// still decide visibility; `f.id = ?3` only narrows further. A note belonging to
/// someone else, a trashed note and a note id that never existed are therefore
/// indistinguishable from each other and from a note with no matches — all four
/// are an empty `pages`.
///
/// An empty or all-punctuation query returns nothing rather than every page.
/// `cursor` resumes an earlier batch of the same query (`error.InvalidCursor`
/// for a token that does not parse); `batch` is the page stride, clamped to
/// `[1, max_batch]`.
pub fn searchNotePages(
    arena: std.mem.Allocator,
    db: sqlite.Db,
    user_id: u64,
    note_id: u64,
    raw_query: []const u8,
    cursor: ?[]const u8,
    batch: i64,
) !NoteResults {
    const b = try inDocBatch(arena, db, false, user_id, note_id, raw_query, cursor, batch);
    const pages = try arena.alloc(PageMatch, b.rows.len);
    for (b.rows, pages) |row, *page| {
        const counted = try countMatches(arena, db, row.text, b.terms);
        page.* = .{
            .pageIndex = row.page_index,
            // `@max(1, …)` and the terms are deliberately NOT tied together: the
            // row exists because the index matched it, so reporting 0 would be a
            // counting bug stated as an absence. If the fold could not name the
            // words (a phrase token, say) the count still stands and the page
            // simply carries nothing to circle — the count is the authority.
            .matches = @max(1, counted.matches),
            .terms = counted.terms,
        };
    }
    return .{ .query = b.query, .pages = pages, .cursor = b.cursor };
}

/// The result of a one-document history scan (H8). Deliberately the smaller
/// shape of the two in-doc searches — `NoteResults` without `cursor` (the scan
/// is complete in one pass) — so the frontend's find-in-preview reuses its
/// find-in-note page rendering.
pub const HistoryResults = struct {
    query: []const u8,
    pages: []const PageMatch,
};

/// In-document search over ONE retained version's recognized text (H8), for the
/// `GET …/history/{md5}/search` route.
///
/// NOT the FTS: old versions are never in the shared index (H2), by design — so
/// this scans `note_page_index.text` for `md5` directly, page by page, and counts
/// with the index's OWN tokenizer (`countMatches`), exactly as find-in-note does
/// its per-page counting. Bounded by ONE document. `md5`'s ownership +
/// retained-ness are the
/// CALLER's gate (`Files.historyVersion`); this function trusts `md5` and only
/// reads. Exact + accent-fold matches, plus a prefix on the final token while the
/// box is still being typed (the same `still_typing` rule the live find uses).
/// An empty or all-punctuation query returns no pages. Allocated in `arena`.
pub fn searchHistoryPages(
    arena: std.mem.Allocator,
    db: sqlite.Db,
    md5: []const u8,
    raw_query: []const u8,
) !HistoryResults {
    const query = try arena.dupe(u8, trimQuery(raw_query));
    const terms = try queryTerms(arena, db, query, isStillTyping(raw_query));
    if (terms.len == 0) return .{ .query = query, .pages = &.{} };

    // Collect the version's page transcripts FIRST, then count — `countMatches`
    // runs its own statements (the temp `token_fold` table) on this connection,
    // which must not interleave with an open SELECT (and would invalidate the
    // borrowed `columnText`). This is the same collect-then-count shape
    // `searchNotePages` uses over its keyset rows.
    const ScanRow = struct { index: i64, text: []const u8 };
    var rows: std.ArrayList(ScanRow) = .empty;
    {
        var s = try db.prepare(
            "SELECT page_index, text FROM note_page_index " ++
                "WHERE blob_md5 = ?1 AND text IS NOT NULL ORDER BY page_index;",
        );
        defer s.finalize();
        s.bindText(1, md5);
        while (try s.step())
            try rows.append(arena, .{ .index = s.columnInt(0), .text = try arena.dupe(u8, s.columnText(1)) });
    }

    var pages: std.ArrayList(PageMatch) = .empty;
    for (rows.items) |row| {
        const counted = try countMatches(arena, db, row.text, terms);
        if (counted.matches > 0)
            try pages.append(arena, .{ .pageIndex = row.index, .matches = counted.matches, .terms = counted.terms });
    }
    return .{ .query = query, .pages = pages.items };
}

/// One matching page as the FTS read hands it over: the page index, the masked
/// segment rowid the keyset cursor is built from, and the transcript the
/// counting pass folds. `text` is duped, because `columnText` borrows only until
/// the next step and the counting runs other statements on this connection.
const NoteRow = struct {
    page_index: i64,
    text: []const u8,
    rowid: i64,
};

// ---------------------------------------------------------------------------
// Blob-scoped `.txt` query — find-in-txt's paragraph jumps + exact count
// ---------------------------------------------------------------------------

/// One matching `.txt` paragraph of one file. The `.txt` analog of `PageMatch`,
/// plus the paragraph's BYTE RANGE — the address the viewer scrolls to and
/// marks inside (`kind = 1` rows carry it in `recogn_offset`/`recogn_length`;
/// see `txt_index.zig`).
pub const TxtMatch = struct {
    /// The paragraph's segment ordinal (the `kind = 1` row's `page_index`).
    /// The library-search hit's `pageIndex` is the same number, so the deep
    /// link opens the viewer straight at this paragraph.
    segment: i64,
    /// The paragraph's byte offset in the blob, and its length — what the
    /// viewer maps back to a position in the already-loaded text.
    offset: i64,
    length: i64,
    /// How many word instances in this paragraph match — the number the
    /// viewer's "N matches" sums. Never 0: the row exists because the index
    /// matched it, so a 0 would be a counting bug stated as an absence, exactly
    /// as on the note-scoped path.
    matches: i64,
    /// WHICH terms this paragraph matched, folded as the index holds them — so
    /// the viewer marks exactly what was counted rather than re-deriving it,
    /// the same one-way authority `PageMatch.terms` carries.
    terms: []const []const u8,
};

pub const TxtResults = struct {
    /// Echoed, so a late response is discardable — find searches per keystroke.
    query: []const u8,
    /// ONE keyset batch of matching paragraphs, `rowid ASC` (reading order for a
    /// canonical band, Phase 1). The synchronous complete scan is gone; the
    /// client auto-drains `cursor` to the exact "N in M paragraphs" count. The
    /// `.txt` analog of `NoteResults.pages`.
    segments: []const TxtMatch,
    /// Keyset resumption token, encoded exactly as `NoteResults.cursor`:
    /// present only when more paragraphs may exist, absent when the file is
    /// exhausted.
    cursor: ?[]const u8 = null,
};

/// The `.txt` read: the same clause narrowed to `kind = 1`, ordered by
/// `segment_fts.rowid ASC` and `LIMIT`ed, the cursor folded into the `?2` lower
/// bound — the `.txt` analog of `note_keyset_sql`.
const txt_keyset_sql =
    \\SELECT p.page_index, p.recogn_offset, p.recogn_length, p.text, s.id
++ "\n" ++ scoped_from_where ++ "\n" ++
    \\   AND f.id = ?5
    \\   AND p.kind = 1
    \\ ORDER BY segment_fts.rowid ASC
    \\ LIMIT ?6;
;

/// Every `.txt` paragraph of ONE file that matches `raw_query`, with a per-
/// paragraph match count and byte range — find-in-txt's counter and its
/// prev/next paragraph jumps.
///
/// The exact shape of `searchNotePages`, and for the exact same reasons: the
/// file is in the WHERE clause rather than in a post-filter, so draining reaches
/// the exact count, and it runs through `scoped_from_where` (so a foreign,
/// trashed or non-existent file is one indistinguishable empty answer). It
/// differs from the note-scoped read in only two ways: the rows carry the byte
/// range, and `kind = 1` selects paragraph segments rather than note pages.
///
/// An empty or all-punctuation query returns nothing rather than every
/// paragraph. `cursor`/`batch` behave exactly as on `searchNotePages`.
pub fn searchTxtSegments(
    arena: std.mem.Allocator,
    db: sqlite.Db,
    user_id: u64,
    note_id: u64,
    raw_query: []const u8,
    cursor: ?[]const u8,
    batch: i64,
) !TxtResults {
    const b = try inDocBatch(arena, db, true, user_id, note_id, raw_query, cursor, batch);
    const segs = try arena.alloc(TxtMatch, b.rows.len);
    for (b.rows, segs) |row, *seg| {
        const counted = try countMatches(arena, db, row.text, b.terms);
        seg.* = .{
            .segment = row.page_index,
            .offset = row.offset,
            .length = row.length,
            // The row matched, so `@max(1, …)` upholds "never 0" even when the
            // fold could not name the words — the count is the authority, the
            // terms are the aid to marking, exactly as on the note path.
            .matches = @max(1, counted.matches),
            .terms = counted.terms,
        };
    }
    return .{ .query = b.query, .segments = segs, .cursor = b.cursor };
}

// ---------------------------------------------------------------------------
// The scoped runners — ONE generic pass over both formats
// ---------------------------------------------------------------------------

// `searchNotePages` (`.note` pages) and `searchTxtSegments` (`.txt` paragraphs)
// are the SAME in-document keyset search — same `scoped_from_where`, per-range
// `M1><` scan and fuzzy fallback — differing only by the two SQL constants (a
// `.txt` read carries the byte range and filters `kind = 1`) and the wire shape.
// So the machinery is written ONCE, parameterised by a comptime `txt` flag; the
// two entry points below are thin wrappers that pick the flag and map `SegRow`
// onto their own `PageMatch` / `TxtMatch` (kept separate — different JSON).

/// One matching segment as a scoped read hands it over: the ordinal, the masked
/// segment rowid the keyset cursor is built from, and the transcript the
/// counting pass folds. `text` is duped, because `columnText` borrows only until
/// the next step and the counting runs other statements on this connection. The
/// `.txt` layout also carries the paragraph's byte range (`offset`/`length`,
/// from `recogn_offset`/`recogn_length`); a `.note` page leaves them 0.
const SegRow = struct {
    page_index: i64,
    text: []const u8,
    rowid: i64,
    offset: i64 = 0,
    length: i64 = 0,
};

/// Reads one `SegRow` out of a scoped read's current row. `txt` selects the
/// column layout — `.note` is (page_index, text, rowid); `.txt` carries the byte
/// range between them (page_index, offset, length, text, rowid) — matching
/// `note_keyset_sql` / `txt_keyset_sql`.
fn readSegRow(arena: std.mem.Allocator, s: sqlite.Stmt, comptime txt: bool) !SegRow {
    if (txt) return .{
        .page_index = s.columnInt(0),
        .offset = s.columnInt(1),
        .length = s.columnInt(2),
        .text = try arena.dupe(u8, s.columnText(3)),
        .rowid = s.columnInt(4),
    };
    return .{
        .page_index = s.columnInt(0),
        .text = try arena.dupe(u8, s.columnText(1)),
        .rowid = s.columnInt(2),
    };
}

fn segPageOrder(_: void, a: SegRow, b: SegRow) bool {
    return a.page_index < b.page_index;
}

fn segRowidOrder(_: void, a: SegRow, b: SegRow) bool {
    return a.rowid < b.rowid;
}

/// One KEYSET batch of the scoped read: at most `limit` matching segments in
/// `rowid ASC` order, scanning only rowids ABOVE `cursor_rid`.
///
/// Single range (the common, canonical-band case) is the fast path — one `M1><`
/// pass whose lower bound is tightened to `max(range.lo, cursor+1)`, so the
/// pushdown does the paging with no post-filter. Multiple ranges (a legacy-
/// scattered band) run one such pass EACH and merge: because the ranges are
/// disjoint and each yields the smallest `limit` rowids above the cursor within
/// it, the global smallest `limit` across the merge is the true next batch — a
/// merged cursor across ranges, no drop and no dup at the boundary.
fn runKeyset(
    arena: std.mem.Allocator,
    db: sqlite.Db,
    comptime txt: bool,
    match: []const u8,
    user_id: u64,
    note_id: u64,
    runs: []const Range,
    cursor_rid: ?i64,
    limit: i64,
) ![]SegRow {
    var s = try db.prepare(if (txt) txt_keyset_sql else note_keyset_sql);
    defer s.finalize();
    s.bindText(1, match);
    s.bindInt(4, @intCast(user_id));
    s.bindInt(5, @intCast(note_id));
    s.bindInt(6, limit);

    var rows: std.ArrayList(SegRow) = .empty;
    for (runs) |r| {
        const lo2 = if (cursor_rid) |c| @max(r.lo, c + 1) else r.lo;
        if (lo2 > r.hi) continue; // the whole range is already behind the cursor
        s.reset(); // retains the text/user/note/limit bindings; only the bracket moves
        s.bindInt(2, lo2);
        s.bindInt(3, r.hi);
        while (try s.step()) try rows.append(arena, try readSegRow(arena, s, txt));
    }
    // A single range is already `rowid ASC` and already ≤ limit (the LIMIT did
    // the work). Multiple ranges interleave, so merge by rowid and keep the
    // globally-smallest `limit` — the batch the caller pages over.
    if (runs.len > 1) {
        std.sort.pdq(SegRow, rows.items, {}, segRowidOrder);
        if (rows.items.len > limit) rows.shrinkRetainingCapacity(@intCast(limit));
    }
    return rows.items;
}

/// One in-document keyset batch, shared by both public entry points. The whole
/// algorithm — partition bounds, cursor decode, per-document range derivation
/// and the keyset scan — is identical for `.note` and `.txt`; `txt` only picks
/// the SQL / row layout. The caller maps `Batch.rows` onto its wire shape.
const Batch = struct {
    query: []const u8,
    rows: []SegRow,
    terms: []const Term,
    cursor: ?[]const u8 = null,
};

fn inDocBatch(
    arena: std.mem.Allocator,
    db: sqlite.Db,
    comptime txt: bool,
    user_id: u64,
    note_id: u64,
    raw_query: []const u8,
    cursor: ?[]const u8,
    batch: i64,
) !Batch {
    const query = try arena.dupe(u8, trimQuery(raw_query));
    const still_typing = isStillTyping(raw_query);
    const match = (try buildMatch(arena, query, still_typing)) orelse
        return .{ .query = query, .rows = &.{}, .terms = &.{} };

    // The caller's partition bounds — the outer window the document's own range
    // lives inside. A user with no partition has `[0, -1]` (empty), which answers
    // exactly like a note they do not own.
    const part = try partition.active(db, user_id);
    var lo: i64 = 0;
    var hi: i64 = -1;
    if (part) |pid| {
        lo = partition.base(pid);
        hi = partition.last(pid);
    }

    // The keyset lower bound (exclusive): a resumed batch scans only rowids ABOVE
    // the cursor. A cursor minted under a partition generation that has since been
    // reminted resumes nothing — the stream is honestly over.
    var cursor_rid: ?i64 = null;
    if (cursor) |c| {
        const rid = decodeCursor(c) orelse return error.InvalidCursor;
        if (part == null or partition.partitionOf(rid) != part.?)
            return .{ .query = query, .rows = &.{}, .terms = &.{} };
        cursor_rid = rid;
    }

    // Scope the IDENTICAL query to THIS document's own segment rowids instead of
    // the whole partition (see the in-document scoping block): O(document), not
    // O(library). The `files` join in the search itself stays the boundary — the
    // ranges are only a mask for speed.
    const ranges = try docSegmentRanges(arena, db, note_id, user_id, lo, hi, txt);
    const runs = try scopedRuns(arena, ranges, lo, hi);

    const capped: i64 = std.math.clamp(batch, 1, max_batch);
    // One batch, fetching ONE row past it so "more may exist" is a fact. The rows
    // come back `rowid ASC`, merged across ranges by the keyset runner.
    var rows = try runKeyset(arena, db, txt, match, user_id, note_id, runs, cursor_rid, capped + 1);
    const terms = try queryTerms(arena, db, query, still_typing);
    var next_cursor: ?[]const u8 = null;

    if (rows.len > capped) {
        // More segments remain below this batch: the last KEPT row's rowid is the
        // resume point.
        next_cursor = try encodeCursor(arena, rows[@intCast(capped - 1)].rowid);
        rows = rows[0..@intCast(capped)];
    }

    return .{ .query = query, .rows = rows, .terms = terms, .cursor = next_cursor };
}

/// A query token as the INDEX sees it, after the same folding the corpus got.
const Term = struct {
    term: []const u8,
    /// Whether the primary MATCH would prefix-match this term.
    prefix: bool,
};

/// The terms `buildMatch`'s expression will actually match on.
///
/// The prefix `*` is honoured only for a token that folds to a SINGLE term. A
/// token that splits (`infra-set`) becomes a phrase, whose `*` applies to its
/// last term in phrase order — an order the vocabulary read does not preserve.
/// Counting all of its terms exactly is the conservative reading, and the case
/// is a corner of a corner.
fn queryTerms(
    arena: std.mem.Allocator,
    db: sqlite.Db,
    query: []const u8,
    still_typing: bool,
) ![]const Term {
    var out: std.ArrayList(Term) = .empty;
    var it = std.mem.tokenizeAny(u8, query, " \t\r\n");
    while (it.next()) |tok| {
        const prefix = still_typing and it.peek() == null and termLen(tok) >= min_prefix_len;
        const terms = try foldTerms(arena, db, tok);
        for (terms) |t| {
            try out.append(arena, .{ .term = t, .prefix = prefix and terms.len == 1 });
        }
    }
    return out.items;
}

/// What one page contributes: how many word instances match, and WHICH of the
/// page's own terms they are.
const PageCount = struct {
    matches: i64,
    /// The page's vocabulary terms that satisfied the query — folded, because
    /// that is what the page's text folded to. See `PageMatch.terms`.
    terms: []const []const u8,
};

/// How many word instances in `text` match any of `terms`, and which terms those
/// were.
///
/// Counted through the index's OWN tokenizer rather than by scanning the string,
/// for the same reason `foldToken` exists: `remove_diacritics 2` has a specific
/// mapping and a second implementation of it here would be one more thing to
/// keep in step. `text` is `recognition.plainText()`, i.e. the device's word
/// labels, so a term instance is a word the reader can draw an oval round.
///
/// Returning the terms alongside the count is what lets the ovals be derived
/// from the counting instead of guessed at again by the client: the two answers
/// come out of ONE pass over one vocabulary, so they cannot be built on
/// different notions of what matched.
///
/// The `row` vocabulary's `cnt` is the number of instances, so a page saying
/// "target target" counts 2 — the number of ovals, not the number of pages. The
/// TERM appears once regardless, because it is a label to compare words against
/// rather than a tally.
///
/// One temp-table round trip per matching page. That is affordable under the
/// same one-household assumption documented above the fuzzy scan, and it is
/// bounded by the pages of a SINGLE note rather than by the library.
fn countMatches(
    arena: std.mem.Allocator,
    db: sqlite.Db,
    text: []const u8,
    terms: []const Term,
) !PageCount {
    if (terms.len == 0 or text.len == 0) return .{ .matches = 0, .terms = &.{} };
    const folded = try foldRows(db, text);
    defer folded.finalize();

    var n: i64 = 0;
    var matched: std.ArrayList([]const u8) = .empty;
    while (try folded.step()) {
        const term = folded.columnText(0);
        for (terms) |t| {
            const hit = if (t.prefix)
                std.mem.startsWith(u8, term, t.term)
            else
                std.mem.eql(u8, term, t.term);
            if (hit) {
                n += folded.columnInt(1);
                // Duped: the vocabulary row is borrowed until the next step.
                try matched.append(arena, try arena.dupe(u8, term));
                break; // one word is one match, however many terms it satisfies
            }
        }
    }
    return .{ .matches = n, .terms = matched.items };
}

/// The raw `q=`, trimmed and length-capped.
fn trimQuery(raw: []const u8) []const u8 {
    const t = std.mem.trim(u8, raw, " \t\r\n");
    return t[0..@min(t.len, max_query_len)];
}

/// Rewrites a user's words into an FTS5 MATCH expression: every whitespace-
/// separated token becomes a double-quoted FTS5 string, which makes each
/// character a literal. That is what keeps arbitrary typing (`"`, `*`, `AND`,
/// `(`, `NEAR`) from being either a syntax error or an unintended operator, and
/// it needs no blocklist. Multiple tokens are implicitly AND-ed.
///
/// ## Prefix matching, and why it does not weaken the quoting
///
/// The box searches on every keystroke, so the word being typed is by definition
/// half-written: `calig` has to find "Caligrafia" or the box looks broken until
/// the user finishes a word (accents and all). `still_typing` turns the FINAL
/// token into an FTS5 prefix query, which composes with the quoting as:
///
///     "calig"*        — the `*` OUTSIDE the closing quote, an FTS5 prefix
///     "calig*"        — the `*` INSIDE is just another literal: matches nothing
///
/// So the escaping is untouched and operators stay neutralised: `"OR"*` and
/// `"NEAR"*` are a prefix search for the literal words, returning no rows and,
/// crucially, no syntax error.
///
/// Only the last token is prefixed. Earlier tokens are words the user finished
/// typing; making them prefixes too would match far more than asked and skew
/// bm25 towards documents matching the broadened early terms.
///
/// Null when there is nothing to search for. Allocated in `arena`.
pub fn buildMatch(arena: std.mem.Allocator, query: []const u8, still_typing: bool) !?[]const u8 {
    var out: std.ArrayList(u8) = .empty;
    var it = std.mem.tokenizeAny(u8, query, " \t\r\n");
    var any = false;
    while (it.next()) |tok| {
        if (out.items.len != 0) try out.append(arena, ' ');
        const prefix = still_typing and it.peek() == null and termLen(tok) >= min_prefix_len;
        try appendToken(arena, &out, tok, prefix);
        any = true;
    }
    // A token of pure punctuation quotes to a string the tokenizer yields no
    // terms for; FTS5 rejects a MATCH with no terms at all, so treat it as empty.
    if (!any or !hasTerm(query)) return null;
    return out.items;
}

/// Whether the final word of the raw `q=` is one the user is still typing.
///
/// A trailing space is the user saying the word is finished, so `cal ` searches
/// for the whole word "cal" and stops matching the "calig…" they have moved on
/// from. Read from the RAW query deliberately — `trimQuery` has to strip that
/// space before tokenizing, which destroys the signal.
///
/// ## THE SIGNAL NEVER ARRIVES: this is ALWAYS true for library-wide search
///
/// VERIFIED — the SPA trims the query on BOTH sides of its own boundary before
/// it reaches the wire: `Api.searchText` does `query.trim()`
/// (`webapp/src/api/client.ts`) and `setQuery` does `raw.trim()`
/// (`webapp/src/pages/noteSearch.ts`); both sites carry a comment saying so.
/// There is no keystroke, no pause and no Enter that makes the browser send a
/// completed term, so **every library-wide search on the wire is a PREFIX
/// query** and the completed-term path below is reachable only from tests, the
/// bench and a hand-made request.
///
/// What that costs, MEASURED on the Pi (`docs/scratch/search-baseline.md`): the
/// same page is **810.3 ms p50 as a prefix against 80.6 ms completed, 10.0×**,
/// while `DocPage.vm_steps` is IDENTICAL (1,129) either way — so no test and no
/// pin in this file can see the difference. The prefix penalty is linear in the
/// term's WHOLE-INDEX posting count at ~30 µs per posting, which is why it is
/// also the one thing the partition mask does not scope (see the module header).
///
/// NOT changed here, deliberately. Whether the fix is to stop trimming once the
/// box settles, to declare `prefix=` on `segment_fts`, or to do neither is an
/// open decision with a UX half — `docs/scratch/backlog.md` carries it.
fn isStillTyping(raw: []const u8) bool {
    if (raw.len == 0) return false;
    return switch (raw[raw.len - 1]) {
        ' ', '\t', '\r', '\n' => false,
        else => true,
    };
}

/// True when the query holds at least one character `unicode61` would keep as
/// part of a term (it splits on everything that is not a letter or a digit).
fn hasTerm(query: []const u8) bool {
    for (query) |ch| {
        if (std.ascii.isAlphanumeric(ch) or ch >= 0x80) return true;
    }
    return false;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const testing = std.testing;
const schema = @import("../../db/schema.zig");
const maintain = @import("maintain.zig");
const blobstore = @import("../../store/blobs.zig");
const thumbstore = @import("../../store/thumbs.zig");
const filesvc = @import("../files.zig");
const noteindex = @import("../note_index.zig");
const sn = @import("supernote");
const nb = @import("note_builder");
const deferred = @import("../deferred.zig");

const Fixture = struct {
    db: sqlite.Db,
    files: filesvc.Files,
    tmp: testing.TmpDir,
    arena: std.heap.ArenaAllocator,
    path: [128]u8 = undefined,
    path_len: usize = 0,
    /// Stands in for the server's global `db_lock` — only the deferred worker
    /// wants one, and only in the tests that drain it.
    db_lock: std.Io.Mutex = .init,

    fn init() !Fixture {
        return initAt(false);
    }

    fn initAt(on_disk: bool) !Fixture {
        const tmp0 = testing.tmpDir(.{});
        var path_buf: [128]u8 = undefined;
        var db = if (on_disk)
            try sqlite.Db.open(try std.fmt.bufPrintZ(&path_buf, ".zig-cache/tmp/{s}/bench.db", .{tmp0.sub_path}))
        else
            try sqlite.Db.openMemory();
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
        const tmp = tmp0;
        const store = try blobstore.BlobStore.init(testing.io, tmp.dir);
        const thumbs_dir = try tmp.dir.createDirPathOpen(testing.io, "thumbs", .{});
        const thumbs = try thumbstore.ThumbStore.init(testing.io, thumbs_dir);
        var f: Fixture = .{
            .db = db,
            .files = filesvc.Files.init(testing.allocator, testing.io, db, store, thumbs),
            .tmp = tmp,
            .arena = std.heap.ArenaAllocator.init(testing.allocator),
        };
        if (on_disk) {
            f.path_len = (try std.fmt.bufPrint(&f.path, ".zig-cache/tmp/{s}/bench.db", .{tmp.sub_path})).len;
        }
        return f;
    }

    /// The on-disk fixture's database path, for a SECOND connection (the reader
    /// pool's shape). Empty on the in-memory default.
    fn dbPath(f: *Fixture) [:0]const u8 {
        f.path[f.path_len] = 0;
        return f.path[0..f.path_len :0];
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

    /// Any file at all — bytes the indexer cannot parse as a `.note`.
    fn putBytes(f: *Fixture, user_id: u64, name: []const u8, bytes: []const u8) !u64 {
        var r = std.Io.Reader.fixed(bytes);
        const e = try f.files.putFile(user_id, null, name, &r, null);
        defer testing.allocator.free(e.name);
        if (e.md5) |m| testing.allocator.free(m);
        return e.id;
    }

    /// Find-in-note DRAINED to completion: auto-continues the keyset (default
    /// batch) until the cursor is absent, accumulating every page — the client's
    /// auto-drain, so the many existing "complete result" assertions read the
    /// whole note through the batched entry point exactly as the browser will.
    /// Uses a fresh child arena per batch so a giant drain does not retain every
    /// batch's scratch, then dupes the kept pages into the test arena.
    fn searchNote(f: *Fixture, user_id: u64, note_id: u64, q: []const u8) !NoteResults {
        return f.searchNoteBatched(user_id, note_id, q, default_batch);
    }

    /// The drainer with an explicit batch stride — lets a test force many small
    /// batches (the fairness / no-drop-across-boundary shape).
    fn searchNoteBatched(f: *Fixture, user_id: u64, note_id: u64, q: []const u8, batch: i64) !NoteResults {
        const arena = f.a();
        var pages: std.ArrayList(PageMatch) = .empty;
        var query: []const u8 = q;
        var cursor: ?[]const u8 = null;
        var first = true;
        while (true) {
            const r = try searchNotePages(arena, f.db, user_id, note_id, q, cursor, batch);
            if (first) {
                query = r.query;
                first = false;
            }
            try pages.appendSlice(arena, r.pages);
            cursor = r.cursor orelse break;
        }
        return .{ .query = query, .pages = pages.items };
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

    /// `n` SEPARATE single-page notes, each matching `term`, ids returned in
    /// mint order (so ascending masked rowid, and the stream walks them
    /// backwards). This is the fixture for paginating DOCUMENTS — `putPages`
    /// makes one document with many pages, which is now ONE result.
    ///
    /// Each page's text is made DISTINCT deliberately: identical bytes are
    /// identical content, so they would deduplicate to one blob and fan a single
    /// band out across `n` files — a different arrangement, tested separately.
    fn putNotes(f: *Fixture, user_id: u64, prefix: []const u8, n: usize, term: []const u8) ![]u64 {
        const ids = try f.a().alloc(u64, n);
        for (ids, 0..) |*id, i| {
            id.* = try f.putNote(
                user_id,
                try std.fmt.allocPrint(f.a(), "{s}{d:0>2}.note", .{ prefix, i }),
                &.{try std.fmt.allocPrint(f.a(), "{s} {s}{d}", .{ term, prefix, i })},
            );
        }
        return ids;
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
    /// oracle the in-doc scoping tests check the derived ranges against.
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
    /// the multi-range union path (and the `index_version` heal that retires it)
    /// are tested against a band scattered by hand rather than by an edit.
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

    /// The blob a file is backed by — what `maintain`'s writers are keyed on.
    fn noteMd5(f: *Fixture, note_id: u64) ![]const u8 {
        var r = (try f.db.row("SELECT md5 FROM files WHERE id = ?1;", &.{.{ .int = @intCast(note_id) }})) orelse
            return error.NoFile;
        defer r.finalize();
        return f.a().dupe(u8, r.text(0));
    }
};

test "THE LEAK TEST: two users sharing one deduplicated blob see only their own file" {
    var f = try Fixture.init();
    defer f.deinit();

    // IDENTICAL content, so the blob store dedups: one blob, one index row, ONE
    // copy of the OCR text — shared by both users' files. This is precisely the
    // arrangement in which a search that forgot the `files` join leaks.
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

    // The one shared row is reachable from both accounts — as each account's own
    // file, and never as the other's. The `files` join is what says so, and it is
    // the join every surviving read is built on (`scoped_from_where`).
    try testing.expectEqual(@as(usize, 1), (try f.searchNote(1, a_id, "salary")).pages.len);
    try testing.expectEqual(@as(usize, 1), (try f.searchNote(2, b_id, "salary")).pages.len);
    try testing.expectEqual(@as(usize, 0), (try f.searchNote(1, b_id, "salary")).pages.len);
    try testing.expectEqual(@as(usize, 0), (try f.searchNote(2, a_id, "salary")).pages.len);

    // A user with no files at all sees nothing, though the text is right there.
    try testing.expectEqual(@as(i64, 2), try f.count(
        "SELECT COUNT(*) FROM segment_fts WHERE segment_fts MATCH 'salary';",
    ));
    try testing.expectEqual(@as(usize, 0), (try f.searchNote(3, a_id, "salary")).pages.len);

    // Purge by one owner leaves the other's row (and hit) untouched.
    try f.files.trash(1, a_id);
    try f.files.purge(1, a_id);
    try testing.expectEqual(@as(i64, 1), try f.count("SELECT COUNT(*) FROM segment_search;"));
    try testing.expectEqual(@as(i64, 1), try f.count("SELECT COUNT(*) FROM note_page_index;"));
    try testing.expectEqual(@as(usize, 0), (try f.searchNote(1, a_id, "salary")).pages.len);
    try testing.expectEqual(@as(usize, 1), (try f.searchNote(2, b_id, "salary")).pages.len);
    try f.db.exec("INSERT INTO segment_fts(segment_fts) VALUES('integrity-check');");
}

test "a trashed note stops appearing, even though the blob and its text survive" {
    var f = try Fixture.init();
    defer f.deinit();

    const keep = try f.putNote(1, "keep.note", &.{"quarterly roadmap"});
    const drop = try f.putNote(1, "drop.note", &.{"quarterly roadmap"});
    try testing.expectEqual(@as(usize, 1), (try f.searchNote(1, keep, "roadmap")).pages.len);
    try testing.expectEqual(@as(usize, 1), (try f.searchNote(1, drop, "roadmap")).pages.len);

    try f.files.trash(1, drop);

    // The tombstone hides the file; the blob is still referenced by keep.note, so
    // the md5-keyed text is untouched. Only the join makes the hit disappear —
    // one owner, one blob, so ONE posting doc however many files point at it.
    try testing.expectEqual(@as(i64, 1), try f.count("SELECT COUNT(*) FROM blobs;"));
    try testing.expectEqual(@as(i64, 1), try f.count(
        "SELECT COUNT(*) FROM segment_fts WHERE segment_fts MATCH 'roadmap';",
    ));
    try testing.expectEqual(@as(usize, 0), (try f.searchNote(1, drop, "roadmap")).pages.len);
    try testing.expectEqual(@as(usize, 1), (try f.searchNote(1, keep, "roadmap")).pages.len);

    // Restoring puts it straight back into the results — a flag flip, no
    // re-parse: the md5-keyed index never went anywhere.
    const restored = try f.files.restore(1, drop);
    defer restored.deinit(testing.allocator);
    try testing.expectEqualStrings("drop.note", restored.name);
    try testing.expectEqual(@as(usize, 1), (try f.searchNote(1, drop, "roadmap")).pages.len);

    // Purge both for real: now the last reference goes and the text with it.
    try f.files.trash(1, drop);
    try f.files.purge(1, drop);
    try f.files.trash(1, keep);
    try f.files.purge(1, keep);
    try testing.expectEqual(@as(i64, 0), try f.count("SELECT COUNT(*) FROM blobs;"));
    try testing.expectEqual(@as(usize, 0), (try f.searchNote(1, keep, "roadmap")).pages.len);
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
    const alice = try f.putNote(1, "alice.note", labels);
    const bob = try f.putNote(2, "bob.note", labels);
    try testing.expectEqual(@as(i64, 2), try f.count("SELECT refcount FROM blobs;"));

    try f.files.purgeUser(1);

    // Decremented, not deleted. The bytes are still on disk, so bob's note opens.
    try testing.expectEqual(@as(i64, 1), try f.count("SELECT COUNT(*) FROM blobs;"));
    try testing.expectEqual(@as(i64, 1), try f.count("SELECT refcount FROM blobs;"));
    const md5 = try f.blobMd5();
    try testing.expect(f.files.blobs.has(&md5));

    // The index and its FTS entry survive with the blob, so bob can still search.
    try testing.expectEqual(@as(i64, 1), try f.count("SELECT COUNT(*) FROM note_index;"));
    try testing.expectEqual(@as(i64, 1), try f.ftsRows());
    try testing.expectEqual(@as(usize, 1), (try f.searchNote(2, bob, "expedition")).pages.len);

    // Alice is gone: her row, and with it any route back to that text.
    try testing.expectEqual(@as(i64, 0), try f.count("SELECT COUNT(*) FROM files WHERE user_id = 1;"));
    try testing.expectEqual(@as(usize, 0), (try f.searchNote(1, alice, "expedition")).pages.len);

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
    const bob = try f.putNote(2, "bob.note", &.{"duplicated body text"});
    try testing.expectEqual(@as(i64, 3), try f.count("SELECT refcount FROM blobs;"));

    try f.files.purgeUser(1);

    // BOTH of user 1's references came back — the live one and the binned one.
    // A purgeUser that still filtered on `deleted = 0` would leave refcount at 2,
    // and the blob (with its index and its searchable OCR text) would outlive the
    // account with nothing left that could ever decrement it.
    try testing.expectEqual(@as(i64, 1), try f.count("SELECT refcount FROM blobs;"));
    try testing.expectEqual(@as(usize, 1), (try f.searchNote(2, bob, "duplicated")).pages.len);

    // And user 2 dropping their last reference really does reap it.
    try f.files.purgeUser(2);
    try testing.expectEqual(@as(i64, 0), try f.count("SELECT COUNT(*) FROM blobs;"));
}

test "only finished recognition is searchable: unrecognised and still-running pages never appear" {
    var f = try Fixture.init();
    defer f.deinit();

    const mixed = try f.putSpec(1, "mixed.note", .{
        .pages = &.{
            // Page 0: finished.
            .{ .layers = &.{.{ .slot = .main, .bitmap = "AAAA" }}, .recogn_status = 1, .recogn_labels = &.{"findable alpha"} },
            // Page 1: still recognising — the device wrote a status but no text.
            .{ .layers = &.{.{ .slot = .main, .bitmap = "BBBB" }}, .recogn_status = 2 },
            // Page 2: recognition never enabled.
            .{ .layers = &.{.{ .slot = .main, .bitmap = "CCCC" }} },
        },
    });
    // A note with no recognition at all is not a placeholder row — it is absent.
    const plain = try f.putSpec(1, "plain.note", .{ .pages = &.{
        .{ .layers = &.{.{ .slot = .main, .bitmap = "DDDD" }} },
    } });

    try testing.expectEqual(@as(i64, 4), try f.count("SELECT COUNT(*) FROM note_page_index;"));
    try testing.expectEqual(@as(i64, 1), try f.ftsRows()); // only the finished page

    const found = (try f.searchNote(1, mixed, "findable")).pages;
    try testing.expectEqual(@as(usize, 1), found.len);
    try testing.expectEqual(@as(i64, 0), found[0].pageIndex);

    // The un-recognised pages carry no text at all, so a note made only of them
    // answers nothing — an absent row, not an empty one.
    try testing.expectEqual(@as(usize, 0), (try f.searchNote(1, plain, "findable")).pages.len);
    try testing.expectEqual(@as(usize, 0), (try f.searchNote(1, mixed, "unrecognised")).pages.len);
}

test "diacritics fold both ways, and multiple words are AND-ed" {
    var f = try Fixture.init();
    defer f.deinit();

    const pt = try f.putNote(1, "pt.note", &.{"a reunião de avaliação está marcada"});

    // The whole point of `remove_diacritics 2`: unaccented typing finds accented
    // text, and accented typing finds it too.
    for ([_][]const u8{ "avaliacao", "avaliação", "AVALIACAO", "reuniao" }) |q| {
        try testing.expectEqual(@as(usize, 1), (try f.searchNote(1, pt, q)).pages.len);
    }

    // And the terms reported back are the INDEX'S — folded — which is what the
    // client compares its word labels against.
    const folded = try f.searchNote(1, pt, "avaliacao ");
    try testing.expectEqual(@as(usize, 1), folded.pages[0].terms.len);
    try testing.expectEqualStrings("avaliacao", folded.pages[0].terms[0]);

    // Multiple words are AND-ed: both present matches, one absent does not.
    try testing.expectEqual(@as(usize, 1), (try f.searchNote(1, pt, "reuniao marcada")).pages.len);
    try testing.expectEqual(@as(usize, 0), (try f.searchNote(1, pt, "reuniao cancelada")).pages.len);
}

test "re-indexing a page replaces its FTS entry instead of duplicating it" {
    var f = try Fixture.init();
    defer f.deinit();

    const id = try f.putNote(1, "n.note", &.{"stable transcript"});
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
    try testing.expectEqual(@as(usize, 1), (try f.searchNote(1, id, "transcript")).pages.len);
    try f.db.exec("INSERT INTO segment_fts(segment_fts) VALUES('integrity-check');");
}

test "a page whose text CHANGES under re-index drops the old terms and gains the new" {
    var f = try Fixture.init();
    defer f.deinit();

    const id = try f.putNote(1, "n.note", &.{"before"});
    try testing.expectEqual(@as(usize, 1), (try f.searchNote(1, id, "before")).pages.len);

    // Rewrite the stored transcript the way an `index_version` bump with a
    // different derivation would, then re-sync through the two explicit calls.
    var md5: [blobstore.md5_hex_len]u8 = undefined;
    {
        var s = try f.db.prepare("SELECT blob_md5 FROM note_index;");
        defer s.finalize();
        try testing.expect(try s.step());
        @memcpy(&md5, s.columnText(0)[0..blobstore.md5_hex_len]);
    }
    try maintain.unindexBlob(f.db, &md5); // BEFORE: the row still says "before"
    try f.db.exec("UPDATE note_page_index SET text = 'after';");
    try maintain.indexBlob(f.db, &md5);

    try testing.expectEqual(@as(usize, 0), (try f.searchNote(1, id, "before")).pages.len);
    try testing.expectEqual(@as(usize, 1), (try f.searchNote(1, id, "after")).pages.len);
    try f.db.exec("INSERT INTO segment_fts(segment_fts) VALUES('integrity-check');");
}

test "hostile and empty queries are inert, never syntax errors" {
    var f = try Fixture.init();
    defer f.deinit();
    const id = try f.putNote(1, "n.note", &.{"alpha beta gamma"});

    // Empty / whitespace / punctuation-only → no pages, no error, no match-all.
    for ([_][]const u8{ "", "   ", "\t\n", "!!!", "*", "-" }) |q| {
        try testing.expectEqual(@as(usize, 0), (try f.searchNote(1, id, q)).pages.len);
    }

    // FTS5 operators and quotes are literals, not syntax: none of these blow up,
    // and none of them match-all either.
    for ([_][]const u8{ "\"", "alpha OR zeta", "alpha AND zeta", "NEAR(alpha zeta)", "(alpha", "alpha*" }) |q| {
        const r = try f.searchNote(1, id, q);
        _ = r; // reaching here at all is the assertion: no error was raised
    }
    // `OR` really is a literal — "alpha OR zeta" needs the word "or" and "zeta".
    try testing.expectEqual(@as(usize, 0), (try f.searchNote(1, id, "alpha OR zeta")).pages.len);
    try testing.expectEqual(@as(usize, 1), (try f.searchNote(1, id, "alpha")).pages.len);

    // An over-long query is truncated rather than passed through.
    const long = try testing.allocator.alloc(u8, max_query_len * 4);
    defer testing.allocator.free(long);
    @memset(long, 'z');
    const r = try f.searchNote(1, id, long);
    try testing.expectEqual(max_query_len, r.query.len);
}

test "buildMatch quotes every token, so nothing the user types is an operator" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    try testing.expectEqualStrings("\"acao\"", (try buildMatch(a, "acao", false)).?);
    try testing.expectEqualStrings("\"one\" \"two\"", (try buildMatch(a, "  one   two ", false)).?);
    try testing.expectEqualStrings("\"a\"\"b\"", (try buildMatch(a, "a\"b", false)).?);
    try testing.expectEqualStrings("\"OR\"", (try buildMatch(a, "OR", false)).?);
    try testing.expect((try buildMatch(a, "", false)) == null);
    try testing.expect((try buildMatch(a, "  ", false)) == null);
    try testing.expect((try buildMatch(a, "!!", false)) == null);
}

test "buildMatch prefixes only the last token, and only past the minimum length" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    // The `*` goes OUTSIDE the closing quote — inside it is a literal.
    try testing.expectEqualStrings("\"calig\"*", (try buildMatch(a, "calig", true)).?);
    // Earlier tokens stay exact; only the word being typed is broadened.
    try testing.expectEqualStrings("\"test\" \"cal\"*", (try buildMatch(a, "test cal", true)).?);
    try testing.expectEqualStrings("\"a\" \"b\" \"cal\"*", (try buildMatch(a, "a b cal", true)).?);
    // Under the floor: searched, but as an exact term.
    try testing.expectEqualStrings("\"c\"", (try buildMatch(a, "c", true)).?);
    try testing.expectEqualStrings("\"ca\"*", (try buildMatch(a, "ca", true)).?);
    // Punctuation is not typing: `c.` is one term character, not two.
    try testing.expectEqualStrings("\"c.\"", (try buildMatch(a, "c.", true)).?);
    // Accents are counted as characters, not bytes: `sé` clears the floor.
    try testing.expectEqualStrings("\"sé\"*", (try buildMatch(a, "sé", true)).?);
    // The operator words stay quoted, and the prefix rides outside the quotes.
    try testing.expectEqualStrings("\"OR\"*", (try buildMatch(a, "OR", true)).?);
    try testing.expectEqualStrings("\"NEAR\"*", (try buildMatch(a, "NEAR", true)).?);
    try testing.expectEqualStrings("\"a\"\"b\"*", (try buildMatch(a, "a\"b", true)).?);
    // Nothing to search for is still nothing, prefix or not.
    try testing.expect((try buildMatch(a, "!!", true)) == null);
}

test "search-as-you-type: a half-typed word finds the page, a finished one does not over-match" {
    var f = try Fixture.init();
    defer f.deinit();

    // The live-session case, verbatim: an accented transcript, typed unaccented,
    // one word per page so the assertions read as page counts.
    const cal = try f.putLabeled(1, "cal.note", &.{
        "Test Caligrafia Será que isso funciona?",
        "calendar entry for Serão",
    });

    // Every keystroke on the way to the whole word must find page 0.
    for ([_][]const u8{ "ca", "cal", "calig", "caligraf", "caligrafia" }) |q| {
        const pages = (try f.searchNote(1, cal, q)).pages;
        try testing.expect(pages.len >= 1);
        try testing.expectEqual(@as(i64, 0), pages[0].pageIndex);
    }
    // `calig` discriminates; `cal` is a prefix of a word on both pages.
    try testing.expectEqual(@as(usize, 1), (try f.searchNote(1, cal, "calig")).pages.len);
    try testing.expectEqual(@as(usize, 2), (try f.searchNote(1, cal, "cal")).pages.len);

    // Accented typing behaves identically — `remove_diacritics 2` folds a
    // prefix exactly as it folds a whole word, in both directions.
    try testing.expectEqual(@as(usize, 2), (try f.searchNote(1, cal, "ser")).pages.len); // Será + Serão
    try testing.expectEqual(@as(usize, 2), (try f.searchNote(1, cal, "sér")).pages.len); // same, accented
    try testing.expectEqual(@as(usize, 1), (try f.searchNote(1, cal, "sera ")).pages.len); // exact word
    try testing.expectEqual(@as(usize, 1), (try f.searchNote(1, cal, "será ")).pages.len); // same, accented
    try testing.expectEqual(@as(usize, 1), (try f.searchNote(1, cal, "calí")).pages.len); // accented prefix

    // A TRAILING SPACE means the word is finished: no prefix, so a half-word
    // that is not itself a term stops matching.
    try testing.expectEqual(@as(usize, 0), (try f.searchNote(1, cal, "calig ")).pages.len);
    try testing.expectEqual(@as(usize, 0), (try f.searchNote(1, cal, "cal ")).pages.len);
    // …while a word that IS a term still matches with the space.
    try testing.expectEqual(@as(usize, 1), (try f.searchNote(1, cal, "caligrafia ")).pages.len);

    // Only the LAST token is a prefix: "funciona" is exact, "cal" is open.
    try testing.expectEqual(@as(usize, 1), (try f.searchNote(1, cal, "funciona cal")).pages.len);
    // "func" as a non-final token is exact, so it matches nothing.
    try testing.expectEqual(@as(usize, 0), (try f.searchNote(1, cal, "func caligrafia")).pages.len);

    // A SINGLE CHARACTER IS SEARCHED, EXACTLY, and is not expanded into a
    // prefix: `min_prefix_len` gates the `*` and nothing else, so "c" finds no
    // page here rather than dragging in every word starting with c.
    try testing.expectEqual(@as(usize, 0), (try f.searchNote(1, cal, "c")).pages.len);

    // AND THERE IS NO MINIMUM QUERY LENGTH IN A DOCUMENT. The library-wide floor
    // that used to gate this went with library-wide search; once a file is open a
    // two-character find is both cheap and wanted.
    const ok = try f.putNote(1, "ok.note", &.{"ok the plan is set"});
    try testing.expectEqual(@as(usize, 1), (try f.searchNote(1, ok, "ok")).pages.len);
}

test "a prefixed operator word is inert too: no rows, and no syntax error" {
    var f = try Fixture.init();
    defer f.deinit();
    const id = try f.putNote(1, "n.note", &.{"alpha beta gamma"});

    // The prefix rides OUTSIDE the quotes, so the quoting still neutralises
    // everything: each of these is a prefix search for a literal word.
    for ([_][]const u8{ "OR", "AND", "NOT", "NEAR", "NEAR(alpha", "alpha OR", "alpha NEAR", "\"\"", "**" }) |q| {
        const r = try f.searchNote(1, id, q); // reaching here at all is the assertion
        try testing.expectEqual(@as(usize, 0), r.pages.len);
    }
    // A `*` the user typed is punctuation to `unicode61`, so `alpha*` searches
    // for the word "alpha" — it never becomes the operator itself.
    try testing.expectEqual(@as(usize, 1), (try f.searchNote(1, id, "alpha*")).pages.len);
    try testing.expectEqual(@as(usize, 0), (try f.searchNote(1, id, "zeta*")).pages.len);
    // And the same words with the prefix suppressed by a trailing space.
    for ([_][]const u8{ "OR ", "NEAR ", "alpha OR " }) |q| {
        try testing.expectEqual(@as(usize, 0), (try f.searchNote(1, id, q)).pages.len);
    }
    // `alph` is a real prefix of a real term, proving the above are inert
    // because the words are absent rather than because prefixing is broken.
    try testing.expectEqual(@as(usize, 1), (try f.searchNote(1, id, "alph")).pages.len);
}

// ---------------------------------------------------------------------------
// Tests — the plan the in-document reads are pinned to
// ---------------------------------------------------------------------------

test "PLAN PIN (in-doc): the scoped reads reach `files` by PRIMARY KEY, and must NOT be forced onto files_md5" {
    var f = try Fixture.init();
    defer f.deinit();
    _ = try f.putNote(1, "n.note", &.{"alpha"});

    // The reason `scoped_from_where` leaves the access path to the planner. Both
    // statements add `f.id = ?5`, so SQLite plans `f` FIRST as a rowid lookup:
    // ONE probe of the one file, before the FTS scan starts — and when that probe
    // finds nothing (a foreign, trashed or imaginary note id) the scan never runs
    // at all.
    //
    // `INDEXED BY files_md5` would forbid exactly that plan, moving `f` to the
    // inner loop: a per-row index seek in the ordinary case (measured 408 → 590
    // steps on a 30-page document) and a FULL partition scan in the empty one
    // (19 → 18,024). Same rows out, an order of magnitude more work to say no.
    inline for (.{ note_keyset_sql, txt_keyset_sql }) |sql| {
        var s = try f.db.prepare("EXPLAIN QUERY PLAN " ++ sql);
        defer s.finalize();
        var by_pk = false;
        while (try s.step()) {
            const detail = s.columnText(3);
            if (std.mem.indexOf(u8, detail, "SEARCH f ") != null and
                std.mem.indexOf(u8, detail, "INTEGER PRIMARY KEY") != null) by_pk = true;
        }
        try testing.expect(by_pk);
    }
}

// ---------------------------------------------------------------------------
// Tests — the band lifecycle: the join is the boundary, and a re-mint keeps order
// ---------------------------------------------------------------------------

test "MASK FOR SPEED, JOIN FOR CORRECTNESS: a forged segment row cannot cross users" {
    var f = try Fixture.init();
    defer f.deinit();

    const secret = try f.putNote(2, "secret.note", &.{"classified dossier"});
    const mine = try f.putNote(1, "mine.note", &.{"my own words"});

    // Forge what a miscomputed mask would produce: a row in user 1's ACTIVE
    // partition pointing at user 2's page, postings included, so the FTS scan
    // genuinely reaches it.
    try f.db.exec(
        "INSERT INTO segment_search(id, segment_id) " ++
            "SELECT (sp.id << 48) + 999, p.id FROM search_partitions sp, note_page_index p " ++
            "WHERE sp.user_id = 1 AND sp.active = 1 AND p.text = 'classified dossier';",
    );
    try f.db.exec(
        "INSERT INTO segment_fts(rowid, txt) " ++
            "SELECT s.id, p.text FROM segment_search s JOIN note_page_index p ON p.id = s.segment_id " ++
            "WHERE (s.id & 4095) = 999;",
    );

    // The scan finds the posting; the `files` join refuses the row — user 1
    // owns no file with that blob, so the mask never became the access check.
    // Asked about their OWN note, which is what an in-document read can ask.
    try testing.expectEqual(@as(usize, 0), (try f.searchNote(1, mine, "classified")).pages.len);
    try testing.expectEqual(@as(usize, 0), (try f.searchNote(1, secret, "classified")).pages.len);

    // The rightful owner still finds it, and their own search is untouched.
    try testing.expectEqual(@as(usize, 1), (try f.searchNote(2, secret, "classified")).pages.len);
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

    // Search atomically sees exactly one version: the old page's postings are
    // gone from the index itself, the new text is present, and the shared term
    // matches 100 docs — not 199.
    try testing.expectEqual(@as(i64, 0), try f.count(
        "SELECT COUNT(*) FROM segment_fts WHERE segment_fts MATCH '\"word5\"';",
    ));
    const hit = try f.searchNote(1, big, "edited ");
    try testing.expectEqual(@as(usize, 1), hit.pages.len);
    try testing.expectEqual(@as(i64, 5), hit.pages[0].pageIndex);
    try testing.expectEqual(@as(i64, 100), try f.count(
        "SELECT COUNT(*) FROM segment_fts WHERE segment_fts MATCH 'common';",
    ));
    try testing.expectEqual(@as(i64, 100), try f.ftsRows());
    try f.db.exec("INSERT INTO segment_fts(segment_fts) VALUES('integrity-check');");
}

test "THE REORDER PIN: a reordered flip re-mints so rowid ASC follows the NEW page order" {
    var f = try Fixture.init();
    defer f.deinit();

    const id = try f.putLabeled(1, "n.note", &.{ "alpha", "beta", "gamma" });

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

    const gamma = try f.searchNote(1, id, "gamma");
    try testing.expectEqual(@as(usize, 1), gamma.pages.len);
    try testing.expectEqual(@as(i64, 0), gamma.pages[0].pageIndex);
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
    const omega = try f.searchNote(1, id, "omega");
    try testing.expectEqual(@as(i64, 2), omega.pages[0].pageIndex);
    try f.db.exec("INSERT INTO segment_fts(segment_fts) VALUES('integrity-check');");
}

test "re-parse of the SAME blob preserves masked rowids: a heal writes nothing, arriving text refreshes in place" {
    var f = try Fixture.init();
    defer f.deinit();

    const id = try f.putNote(1, "n.note", &.{"stable words"});
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
    try maintain.deletePagePostings(f.db, &md5, 0);
    try f.db.exec("UPDATE note_page_index SET text = 'arrived transcript';");
    try maintain.insertPagePostings(f.db, &md5, 0);
    try testing.expectEqual(seg, try f.segRowid(1, 0));
    try testing.expectEqual(@as(usize, 0), (try f.searchNote(1, id, "stable ")).pages.len);
    try testing.expectEqual(@as(usize, 1), (try f.searchNote(1, id, "arrived ")).pages.len);
    try f.db.exec("INSERT INTO segment_fts(segment_fts) VALUES('integrity-check');");
}

test "generation remint preserves results byte-for-byte, burns a fresh partition, and leaves the housemate alone" {
    var f = try Fixture.init();
    defer f.deinit();

    const a_id = try f.putNote(1, "a.note", &.{"orçamento anual"});
    const b_id = try f.putNote(1, "b.note", &.{"reunião marcada"});
    const theirs = try f.putNote(2, "theirs.note", &.{"orçamento deles"});

    const Ask = struct { id: u64, q: []const u8 };
    const asks = [_]Ask{
        .{ .id = a_id, .q = "orcamento " },
        .{ .id = b_id, .q = "reuniao " },
        .{ .id = a_id, .q = "anual " },
    };
    var golden: [asks.len]NoteResults = undefined;
    for (asks, 0..) |k, i| golden[i] = try f.searchNote(1, k.id, k.q);
    const p_old = (try partition.active(f.db, 1)).?;
    const p2 = (try partition.active(f.db, 2)).?;

    try maintain.remintUserSearch(f.db, 1, 42);

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

    // The same answers — the reads are page-ordered, never mask-ordered, so
    // reissuing every rowid must move nothing a caller can see.
    for (asks, 0..) |k, i| {
        const again = try f.searchNote(1, k.id, k.q);
        try testing.expectEqual(golden[i].pages.len, again.pages.len);
        try testing.expect(golden[i].pages.len > 0);
        for (golden[i].pages, again.pages) |w, g| {
            try testing.expectEqual(w.pageIndex, g.pageIndex);
            try testing.expectEqual(w.matches, g.matches);
        }
    }
    // The housemate's world did not move.
    try testing.expectEqual(@as(usize, 1), (try f.searchNote(2, theirs, "orcamento ")).pages.len);
    try f.db.exec("INSERT INTO segment_fts(segment_fts) VALUES('integrity-check');");
}

// ---------------------------------------------------------------------------
// Tests — note-scoped search (find in note)
// ---------------------------------------------------------------------------

test "the note-scoped query keeps the ownership boundary: someone else's note is indistinguishable from no note" {
    var f = try Fixture.init();
    defer f.deinit();

    // Identical content, so one deduplicated blob holds the ONE copy of the OCR
    // text both files reference — the arrangement that leaks if the `files` join
    // is skipped.
    const labels = &[_][]const u8{"confidential salary review"};
    const alice = try f.putNote(1, "alice.note", labels);
    const bob = try f.putNote(2, "bob.note", labels);

    // Own note: found.
    try testing.expectEqual(@as(usize, 1), (try f.searchNote(1, alice, "salary ")).pages.len);
    try testing.expectEqual(@as(usize, 1), (try f.searchNote(2, bob, "salary ")).pages.len);

    // Someone else's note id, a note id that never existed, and a note id
    // belonging to nobody are all the same answer: nothing. The text is right
    // there in the index — once per owner, that is the partition mechanism —
    // reachable by the row both files share.
    try testing.expectEqual(@as(i64, 2), try f.count(
        "SELECT COUNT(*) FROM segment_fts WHERE segment_fts MATCH 'salary';",
    ));
    try testing.expectEqual(@as(usize, 0), (try f.searchNote(1, bob, "salary ")).pages.len);
    try testing.expectEqual(@as(usize, 0), (try f.searchNote(2, alice, "salary ")).pages.len);
    try testing.expectEqual(@as(usize, 0), (try f.searchNote(1, 987654, "salary ")).pages.len);
    try testing.expectEqual(@as(usize, 0), (try f.searchNote(3, alice, "salary ")).pages.len);

    // And the tombstone boundary holds too: trashing hides the note from find
    // while the blob (and its text) survives for the other owner.
    try f.files.trash(1, alice);
    try testing.expectEqual(@as(usize, 0), (try f.searchNote(1, alice, "salary ")).pages.len);
    try testing.expectEqual(@as(usize, 1), (try f.searchNote(2, bob, "salary ")).pages.len);
}

test "note-scoped: empty and all-punctuation queries match nothing, not every page" {
    var f = try Fixture.init();
    defer f.deinit();

    const id = try f.putPages(1, "n.note", 4, &.{"alpha beta gamma"});

    for ([_][]const u8{ "", "   ", "\t\n", "!!!", "*", "-" }) |q| {
        const r = try f.searchNote(1, id, q);
        try testing.expectEqual(@as(usize, 0), r.pages.len);
    }
    // The same note DOES answer a real query, so the above is emptiness rather
    // than a broken scope.
    try testing.expectEqual(@as(usize, 4), (try f.searchNote(1, id, "alpha ")).pages.len);

    // FTS5 syntax stays literal here as it does on the library-wide path.
    for ([_][]const u8{ "\"", "alpha OR zeta", "NEAR(alpha zeta)", "(alpha" }) |q| {
        _ = try f.searchNote(1, id, q); // reaching here is the assertion
    }
    try testing.expectEqual(@as(usize, 0), (try f.searchNote(1, id, "alpha OR zeta")).pages.len);

    // Search-as-you-type: a half-typed word prefix-matches, and the count follows
    // the same rule, so the badge agrees with the words the reader will circle.
    const typing = try f.searchNote(1, id, "alph");
    try testing.expectEqual(@as(usize, 4), typing.pages.len);

    // Finished, the `*` is gone and the match is EXACT — "alph" is not a term in
    // this document, so nothing is found. There is no typo ladder behind an
    // in-document find any more: it moved into the browser's engine with global
    // search (`golden-search.md` §6 step 6), and step 7 is what brings it back
    // here by moving find onto that engine.
    try testing.expectEqual(@as(usize, 0), (try f.searchNote(1, id, "alph ")).pages.len);
    try testing.expectEqual(@as(usize, 4), (try f.searchNote(1, id, "alpha ")).pages.len);

    // Diacritics fold exactly as they do in the index, because the count runs
    // through the index's own tokenizer rather than a second copy of the rule.
    const pt = try f.putNote(1, "pt.note", &.{"a reunião de avaliação está marcada"});
    const folded = try f.searchNote(1, pt, "avaliacao ");
    try testing.expectEqual(@as(usize, 1), folded.pages.len);
    try testing.expectEqual(@as(i64, 1), folded.pages[0].matches);

    // A word repeated on the page is counted per OCCURRENCE, not per page.
    const rep = try f.putNote(1, "rep.note", &.{"echo echo echo once"});
    const counted = try f.searchNote(1, rep, "echo ");
    try testing.expectEqual(@as(usize, 1), counted.pages.len);
    try testing.expectEqual(@as(i64, 3), counted.pages[0].matches);
}

/// The user's ACTIVE partition rowid bounds, for tests that contrast a note's
/// own span against the whole partition the old query used to scan.
fn partitionBounds(f: *Fixture, user_id: u64) !struct { lo: i64, hi: i64 } {
    const p = (try partition.active(f.db, user_id)).?;
    return .{ .lo = partition.base(p), .hi = partition.last(p) };
}

/// Total masked rowids covered by `ranges` — the width of the scan the in-doc
/// search will do.
fn rangeSpan(ranges: []const Range) i64 {
    var n: i64 = 0;
    for (ranges) |r| n += r.hi - r.lo + 1;
    return n;
}

/// The pages `searchNotePages` returns for `q`, sorted, as a bare index list.
/// Sorted rather than left in `rowid ASC` order because a HAND-SCATTERED band
/// (the legacy multi-range shape) makes rowid order and page order differ, and
/// these are set comparisons.
fn inDocPages(f: *Fixture, user_id: u64, note_id: u64, q: []const u8) ![]i64 {
    const r = try f.searchNote(user_id, note_id, q);
    const out = try f.a().alloc(i64, r.pages.len);
    for (r.pages, out) |p, *o| o.* = p.pageIndex;
    std.sort.pdq(i64, out, {}, std.sort.asc(i64));
    return out;
}

test "IN-DOC SCOPE: the derived ranges ARE the document's segment span, far narrower than the partition" {
    var f = try Fixture.init();
    defer f.deinit();

    // Fill the partition with OTHER notes first, so the note we care about is a
    // tiny island in a wide partition — exactly the arrangement in which the old
    // partition-bracket scan did O(library) work.
    _ = try f.putPages(1, "noise-a.note", 40, &.{"filler common"});
    _ = try f.putPages(1, "noise-b.note", 40, &.{"more common"});
    const doc = try f.putLabeled(1, "doc.note", &.{ "alpha here", "beta here", "gamma here" });

    const b = try partitionBounds(&f, 1);
    const ranges = try docSegmentRanges(f.a(), f.db, doc, 1, b.lo, b.hi, false);

    // Contiguous at ingest: ONE range, spanning exactly the note's three own
    // segment rowids (the oracle is file-scoped, so the 80 noise segments do not
    // confuse it) — not the partition's ~83.
    const ids = try f.noteSegIds(doc);
    try testing.expectEqual(@as(usize, 3), ids.len);
    try testing.expectEqual(@as(usize, 1), ranges.len);
    try testing.expectEqual(@as(i64, 3), rangeSpan(ranges));
    try testing.expectEqual(ids[0], ranges[0].lo);
    try testing.expectEqual(ids[ids.len - 1], ranges[0].hi);

    // The partition the old query scanned is DRAMATICALLY wider — the whole
    // point of the fix: same query, a bracket two orders of magnitude smaller.
    try testing.expect((b.hi - b.lo + 1) > rangeSpan(ranges) * 20);

    // scopedRuns hands that single range straight through as the fast path.
    const runs = try scopedRuns(f.a(), ranges, b.lo, b.hi);
    try testing.expectEqual(@as(usize, 1), runs.len);
    try testing.expectEqual(ranges[0].lo, runs[0].lo);
    try testing.expectEqual(ranges[0].hi, runs[0].hi);
}

test "EXPLAIN PIN (in-doc): the note-scoped query still pushes its rowid bracket into FTS (M1><)" {
    var f = try Fixture.init();
    defer f.deinit();
    _ = try f.putNote(1, "n.note", &.{"alpha"});

    // The trailing `><` proves the bracket bound into ?2/?3 is claimed BY the FTS
    // index, not filtered after the scan. In-doc binds the DOCUMENT'S range
    // there, so this plan is what makes a find O(document). BOTH in-doc reads —
    // find-in-note and find-in-txt — must show it.
    for ([_][]const u8{ "EXPLAIN QUERY PLAN " ++ note_keyset_sql, "EXPLAIN QUERY PLAN " ++ txt_keyset_sql }) |sql| {
        var s = try f.db.prepare(sql);
        defer s.finalize();
        var pinned = false;
        while (try s.step()) {
            const detail = s.columnText(3);
            if (std.mem.indexOf(u8, detail, "segment_fts") != null and
                std.mem.indexOf(u8, detail, "M1><") != null) pinned = true;
        }
        try testing.expect(pinned);
    }
}

/// The UNION of every SMALL batch of an in-doc search, sorted, with a duplicate
/// check across the cursor boundary: draining with `batch` forces many batches,
/// and a page appearing twice (a boundary dup) or missing (a boundary drop)
/// shows up as a length/content mismatch against the sorted set.
fn batchedInDocPages(f: *Fixture, user_id: u64, note_id: u64, q: []const u8, batch: i64) ![]i64 {
    const a = f.a();
    var seen: std.AutoHashMapUnmanaged(i64, void) = .empty;
    var pages: std.ArrayList(i64) = .empty;
    var cursor: ?[]const u8 = null;
    while (true) {
        const r = try searchNotePages(a, f.db, user_id, note_id, q, cursor, batch);
        try testing.expect(r.pages.len <= @as(usize, @intCast(batch))); // BOUNDED per batch
        for (r.pages) |p| {
            const gop = try seen.getOrPut(a, p.pageIndex);
            try testing.expect(!gop.found_existing); // NO dup across the cursor boundary
            try pages.append(a, p.pageIndex);
        }
        cursor = r.cursor orelse break;
    }
    std.sort.pdq(i64, pages.items, {}, std.sort.asc(i64));
    return pages.items;
}

test "BATCHED IDENTICAL RESULTS (the non-negotiable): the UNION of small batches is the whole document, single- AND multi-range" {
    var f = try Fixture.init();
    defer f.deinit();

    // Other notes widen the partition the ranges sit inside; a doc with many
    // matching pages so a small batch takes SEVERAL round-trips (the cursor
    // boundary is crossed repeatedly).
    _ = try f.putPages(1, "noisy.note", 30, &.{"common"});
    var labels: [12][]const u8 = undefined;
    for (&labels, 0..) |*l, i| l.* = try std.fmt.allocPrint(f.a(), "p{d} common alpha{d}", .{ i, i });
    const doc = try f.putLabeled(1, "doc.note", &labels);

    // SINGLE-RANGE (canonical band): for a common term (12 pages, batch 3 ⇒ 4+
    // batches), a rare per-page term, and a term the doc lacks, the batched union
    // equals the result of ONE large batch — no drop or dup at any boundary, and
    // the stride is not allowed to change the answer.
    for ([_][]const u8{ "common ", "alpha3 ", "zzzptl " }) |q| {
        const d = try inDocPages(&f, 1, doc, q);
        try testing.expectEqualSlices(i64, d, try batchedInDocPages(&f, 1, doc, q, 3));
        try testing.expectEqualSlices(i64, d, try batchedInDocPages(&f, 1, doc, q, 1));
    }
    try testing.expectEqual(@as(usize, 12), (try inDocPages(&f, 1, doc, "common ")).len);

    // MULTI-RANGE (hand-scattered band): scatter pages 1,4,7,10 to tail rowids so
    // the keyset merges several disjoint ranges with one cursor across them. The
    // union must STILL be the whole document, boundary-clean, at a tiny batch —
    // this is the case where a per-range cursor would silently lose a range.
    try f.scatterPages(1, doc, &.{ 1, 4, 7, 10 });
    try testing.expect((try docSegmentRanges(f.a(), f.db, doc, 1, (try partitionBounds(&f, 1)).lo, (try partitionBounds(&f, 1)).hi, false)).len > 1);
    for ([_][]const u8{ "common ", "alpha7 " }) |q| {
        const d = try inDocPages(&f, 1, doc, q);
        try testing.expectEqualSlices(i64, d, try batchedInDocPages(&f, 1, doc, q, 2));
    }
    try testing.expectEqual(@as(usize, 12), (try inDocPages(&f, 1, doc, "common ")).len);
}

test "EXPLAIN PIN (batched in-doc): the keyset query keeps SCAN segment_fts M1>< over the doc bracket + cursor, no sort" {
    var f = try Fixture.init();
    defer f.deinit();
    _ = try f.putNote(1, "n.note", &.{"alpha"});

    // The cursor folds into the ?2 lower bound, so the batched plan is the SAME
    // `M1><` pushdown the unbatched in-doc query pins — the bracket is claimed BY
    // the FTS index, not filtered after. And FTS5 walks its postings in rowid
    // order, so `ORDER BY segment_fts.rowid ASC` needs NO temp b-tree — the
    // proof the keyset is O(batch), never O(matches)-then-sort.
    for ([_][]const u8{ "EXPLAIN QUERY PLAN " ++ note_keyset_sql, "EXPLAIN QUERY PLAN " ++ txt_keyset_sql }) |sql| {
        var s = try f.db.prepare(sql);
        defer s.finalize();
        var pinned = false;
        var sorted = false;
        while (try s.step()) {
            const detail = s.columnText(3);
            if (std.mem.indexOf(u8, detail, "segment_fts") != null and
                std.mem.indexOf(u8, detail, "M1><") != null) pinned = true;
            if (std.mem.indexOf(u8, detail, "USE TEMP B-TREE FOR ORDER BY") != null) sorted = true;
        }
        try testing.expect(pinned);
        try testing.expect(!sorted); // rowid-order scan, no materialize-then-sort
    }
}

test "FAIRNESS: a big note drains in bounded batches (small lock windows), the count settles exact, prev/next crosses a boundary" {
    var f = try Fixture.init();
    defer f.deinit();

    // 50 matching pages; a batch of 8 ⇒ 7 requests. Each request is a separate
    // small `dbLock` window (the fairness win — no 50-page monolith), and its
    // work is BOUNDED to ≤ batch pages, asserted inside `batchedInDocPages`.
    var labels: [50][]const u8 = undefined;
    for (&labels, 0..) |*l, i| l.* = try std.fmt.allocPrint(f.a(), "line{d} common", .{i});
    const doc = try f.putLabeled(1, "big.note", &labels);

    // Draining SETTLES to the exact brute-force count (a finite doc always
    // reaches it), page-complete, no drop or dup across any of the 7 boundaries.
    const bd = try batchedInDocPages(&f, 1, doc, "common ", 8);
    try testing.expectEqual(@as(usize, 50), bd.len);
    for (bd, 0..) |pi, i| try testing.expectEqual(@as(i64, @intCast(i)), pi);

    // prev/next across a batch boundary: page 8 (start of the 2nd batch) resumes
    // exactly after page 7 (end of the 1st) — no gap, no repeat at the seam.
    const first = try searchNotePages(f.a(), f.db, 1, doc, "common ", null, 8);
    try testing.expectEqual(@as(usize, 8), first.pages.len);
    try testing.expectEqual(@as(i64, 7), first.pages[7].pageIndex);
    const second = try searchNotePages(f.a(), f.db, 1, doc, "common ", first.cursor.?, 8);
    try testing.expectEqual(@as(i64, 8), second.pages[0].pageIndex);
}

test "BATCH CURSOR: the last batch drops the cursor, and that absence is the only exhaustion signal" {
    var f = try Fixture.init();
    defer f.deinit();

    const doc = try f.putLabeled(1, "n.note", &.{ "alpha common", "beta common", "gamma common" });

    // Three matching pages, batch 2 ⇒ two batches: the first carries a cursor,
    // the second returns the last page and NO cursor (the "stop draining" signal).
    const b1 = try searchNotePages(f.a(), f.db, 1, doc, "common ", null, 2);
    try testing.expectEqual(@as(usize, 2), b1.pages.len);
    try testing.expect(b1.cursor != null);
    const b2 = try searchNotePages(f.a(), f.db, 1, doc, "common ", b1.cursor.?, 2);
    try testing.expectEqual(@as(usize, 1), b2.pages.len);
    try testing.expectEqual(@as(?[]const u8, null), b2.cursor);

    // A batch that finds NOTHING says so the same way — an empty page with no
    // cursor — so a client draining a query that never matched stops on the
    // first round trip rather than on a special case.
    const none = try searchNotePages(f.a(), f.db, 1, doc, "absent ", null, 2);
    try testing.expectEqual(@as(usize, 0), none.pages.len);
    try testing.expectEqual(@as(?[]const u8, null), none.cursor);
}

test "EDITED-DOC ORDER: a version-flip edit keeps the band CONTIGUOUS and streams in page order" {
    var f = try Fixture.init();
    defer f.deinit();

    // Other notes widen the partition; our note is contiguous at ingest.
    _ = try f.putPages(1, "noise.note", 20, &.{"filler common"});
    const doc = try f.putLabeled(1, "doc.note", &.{
        "p0 common", "p1 common", "p2 common", "p3 common", "p4 common", "p5 common",
    });
    const b = try partitionBounds(&f, 1);
    try testing.expectEqual(@as(usize, 1), (try docSegmentRanges(f.a(), f.db, doc, 1, b.lo, b.hi, false)).len);

    // Edit pages 1 and 3, and REORDER by editing text. Under the whole-doc-band
    // re-mint (in-doc-search plan Phase 1) the note re-mints CONTIGUOUS in page
    // order every time — the old text_hash diff would have scattered the two
    // edited pages to tail rowids; now the band stays one range.
    const doc2 = try f.putLabeled(1, "doc.note", &.{
        "p0 common", "p1 EDITED common", "p2 common", "p3 EDITED common", "p4 common", "p5 common",
    });
    try testing.expectEqual(doc, doc2); // a version replace keeps the file id

    const ranges = try docSegmentRanges(f.a(), f.db, doc, 1, b.lo, b.hi, false);
    try testing.expectEqual(@as(usize, 1), ranges.len); // STILL one contiguous range after the edit

    // The band covers exactly the note's six current segment rowids, contiguous,
    // and `rowid ASC == page order` — the property in-doc batching relies on.
    const ids = try f.noteSegIds(doc);
    try testing.expectEqual(@as(usize, 6), ids.len);
    try testing.expectEqual(@as(i64, 6), rangeSpan(ranges));
    for (ids, 0..) |rid, i| {
        try testing.expectEqual(ranges[0].lo + @as(i64, @intCast(i)), rid); // page i at lo+i
        try testing.expectEqual(rid, try f.noteSegRowid(doc, @intCast(i)));
    }

    // The search is COMPLETE and note-scoped: all six pages, in page order.
    const res = try f.searchNote(1, doc, "common ");
    try testing.expectEqual(@as(usize, 6), res.pages.len);
    for (res.pages, 0..) |p, i| try testing.expectEqual(@as(i64, @intCast(i)), p.pageIndex);
    try testing.expectEqual(@as(usize, 2), (try f.searchNote(1, doc, "edited ")).pages.len);
}

test "MULTI-RANGE UNION: a hand-scattered band (legacy edit-scatter) still searches complete and note-scoped" {
    var f = try Fixture.init();
    defer f.deinit();

    _ = try f.putPages(1, "noise.note", 20, &.{"filler common"});
    const doc = try f.putLabeled(1, "doc.note", &.{
        "p0 common", "p1 common", "p2 common", "p3 common", "p4 common", "p5 common",
    });
    const b = try partitionBounds(&f, 1);
    try testing.expectEqual(@as(usize, 1), (try docSegmentRanges(f.a(), f.db, doc, 1, b.lo, b.hi, false)).len);

    // Reproduce the legacy scatter a pre-re-mint flip left behind: move pages 1
    // and 3 to fresh tail rowids, fragmenting the band into several runs.
    try f.scatterPages(1, doc, &.{ 1, 3 });

    const ranges = try docSegmentRanges(f.a(), f.db, doc, 1, b.lo, b.hi, false);
    try testing.expect(ranges.len > 1); // genuinely scattered
    try testing.expect(ranges.len <= doc_range_cap); // still the per-range path

    // The ranges cover EXACTLY the note's six current segment rowids — not the
    // [min,max] span (which would swallow much of the partition), and nothing
    // outside the note.
    const ids = try f.noteSegIds(doc);
    try testing.expectEqual(@as(usize, 6), ids.len);
    try testing.expectEqual(@as(i64, 6), rangeSpan(ranges));
    for (ids) |rid| {
        var inside = false;
        for (ranges) |r| inside = inside or (rid >= r.lo and rid <= r.hi);
        try testing.expect(inside);
        try testing.expect(rid >= b.lo and rid <= b.hi);
    }

    // The multi-range union search is COMPLETE and note-scoped: all six pages,
    // none of the noise note's. A scattered band streams in rowid order, so the
    // completeness is the SET — sorted pageIndexes are exactly 0..5.
    const res = try f.searchNote(1, doc, "common ");
    try testing.expectEqual(@as(usize, 6), res.pages.len);
    const idxs = try sortedPageIndexes(f.a(), res.pages);
    for (idxs, 0..) |pi, i| try testing.expectEqual(@as(i64, @intCast(i)), pi);
}

test "SCATTERED FALLBACK: past the range cap the search degrades to the partition bracket, still correct" {
    var f = try Fixture.init();
    defer f.deinit();

    // 20 pages, then hand-scatter every ODD page to a fresh tail rowid (the
    // legacy edit-scatter shape): the ten unchanged even pages become ten
    // isolated single runs, the ten moved land in one contiguous tail run —
    // eleven ranges, past the cap.
    var v1: [20][]const u8 = undefined;
    for (0..20) |i| v1[i] = try std.fmt.allocPrint(f.a(), "p{d} common", .{i});
    const doc = try f.putLabeled(1, "doc.note", &v1);
    var odds: [10]i64 = undefined;
    for (0..10) |k| odds[k] = @intCast(k * 2 + 1);
    try f.scatterPages(1, doc, &odds);

    const b = try partitionBounds(&f, 1);
    const ranges = try docSegmentRanges(f.a(), f.db, doc, 1, b.lo, b.hi, false);
    try testing.expect(ranges.len > doc_range_cap); // pathologically fragmented

    // scopedRuns gives up on per-range scoping and falls back to ONE
    // partition-wide bracket — today's correct-but-slower behaviour.
    const runs = try scopedRuns(f.a(), ranges, b.lo, b.hi);
    try testing.expectEqual(@as(usize, 1), runs.len);
    try testing.expectEqual(b.lo, runs[0].lo);
    try testing.expectEqual(b.hi, runs[0].hi);

    // The result is still COMPLETE (the `f.id` filter, not the mask, is what
    // keeps it correct) and still note-scoped: twenty pages, none of them noise.
    // A scattered band STREAMS in rowid order (not page order), so completeness
    // is the SET — the drained pageIndexes, sorted, are exactly 0..19.
    const res = try f.searchNote(1, doc, "common ");
    try testing.expectEqual(@as(usize, 20), res.pages.len);
    const idxs = try sortedPageIndexes(f.a(), res.pages);
    for (idxs, 0..) |pi, i| try testing.expectEqual(@as(i64, @intCast(i)), pi);
}

/// The pageIndexes of `pages`, sorted — for asserting the COMPLETE set a
/// scattered band streams (in rowid, not page, order).
fn sortedPageIndexes(a: std.mem.Allocator, pages: []const PageMatch) ![]i64 {
    const out = try a.alloc(i64, pages.len);
    for (pages, out) |p, *o| o.* = p.pageIndex;
    std.sort.pdq(i64, out, {}, std.sort.asc(i64));
    return out;
}

test "HEAL RE-CANONICALIZES: an index_version bump re-mints a legacy-scattered band into page order" {
    var f = try Fixture.init();
    defer f.deinit();

    _ = try f.putPages(1, "noise.note", 8, &.{"filler common"});
    const doc = try f.putLabeled(1, "doc.note", &.{
        "p0 common", "p1 common", "p2 common", "p3 common", "p4 common",
    });
    const b = try partitionBounds(&f, 1);

    // Reproduce a band a PAST incremental flip scattered (pages 1 and 3 at tail
    // rowids) — the shape the heal exists to retire.
    try f.scatterPages(1, doc, &.{ 1, 3 });
    try testing.expect((try docSegmentRanges(f.a(), f.db, doc, 1, b.lo, b.hi, false)).len > 1);

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

    // The band is CANONICAL again: one contiguous range, `rowid ASC == page
    // order`, and search stays complete.
    const ranges = try docSegmentRanges(f.a(), f.db, doc, 1, b.lo, b.hi, false);
    try testing.expectEqual(@as(usize, 1), ranges.len);
    const ids = try f.noteSegIds(doc);
    try testing.expectEqual(@as(usize, 5), ids.len);
    for (ids, 0..) |rid, i| try testing.expectEqual(ranges[0].lo + @as(i64, @intCast(i)), rid);
    const res = try f.searchNote(1, doc, "common ");
    try testing.expectEqual(@as(usize, 5), res.pages.len);
    for (res.pages, 0..) |p, i| try testing.expectEqual(@as(i64, @intCast(i)), p.pageIndex);

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

/// Whether `page` reports `term` as one of the words it counted.
fn hasTermNamed(page: PageMatch, term: []const u8) bool {
    for (page.terms) |t| {
        if (std.mem.eql(u8, t, term)) return true;
    }
    return false;
}

test "THE AGREEMENT TEST: the terms reported are the ones the count counted" {
    var f = try Fixture.init();
    defer f.deinit();

    // Accented, so the fold is doing real work, and with a second word sharing a
    // prefix so the `*` expansion has something to be wrong about.
    const id = try f.putNote(1, "pt.note", &.{"a reunião de avaliação está marcada avaliar"});

    // A whole word, typed unaccented: the term named is the term as the INDEX
    // holds it (folded), which is what the client can compare a word label to.
    const exact = try f.searchNote(1, id, "avaliacao ");
    try testing.expectEqual(@as(usize, 1), exact.pages.len);
    try testing.expectEqual(@as(i64, 1), exact.pages[0].matches);
    try testing.expectEqual(@as(usize, 1), exact.pages[0].terms.len);
    try testing.expectEqualStrings("avaliacao", exact.pages[0].terms[0]);

    // THE PREFIX CASE, which no client-side substring test can reproduce: `aval`
    // matches two different words, and both are named — one term per matched
    // word, and the count is the number of word instances.
    const prefix = try f.searchNote(1, id, "aval");
    try testing.expectEqual(@as(usize, 1), prefix.pages.len);
    try testing.expectEqual(@as(i64, 2), prefix.pages[0].matches);
    try testing.expectEqual(@as(usize, 2), prefix.pages[0].terms.len);
    try testing.expect(hasTermNamed(prefix.pages[0], "avaliacao"));
    try testing.expect(hasTermNamed(prefix.pages[0], "avaliar"));

    // Multi-term: both words are named, and neither drags in the other's page.
    const both = try f.searchNote(1, id, "reuniao marcada ");
    try testing.expectEqual(@as(usize, 1), both.pages.len);
    try testing.expectEqual(@as(i64, 2), both.pages[0].matches);
    try testing.expect(hasTermNamed(both.pages[0], "reuniao"));
    try testing.expect(hasTermNamed(both.pages[0], "marcada"));

    // A repeated word is ONE term and several matches: the terms are labels to
    // compare words against, the count is the tally.
    const rep = try f.putNote(1, "rep.note", &.{"echo echo echo once"});
    const counted = try f.searchNote(1, rep, "echo ");
    try testing.expectEqual(@as(i64, 3), counted.pages[0].matches);
    try testing.expectEqual(@as(usize, 1), counted.pages[0].terms.len);
    try testing.expectEqualStrings("echo", counted.pages[0].terms[0]);
}

// ---------------------------------------------------------------------------
// Tests — the shared fold table does not accumulate (optimizations.md 11b)
// ---------------------------------------------------------------------------

/// How much INDEX STORAGE `temp.token_fold` is currently carrying, counted in
/// rows of its `%_data` shadow table — one per segment b-tree node, plus the
/// structure and averages records FTS5 always keeps.
///
/// A count rather than a stopwatch on purpose: the defect below is a TIME
/// regression, and a timing assertion is exactly the kind that fails on a loaded
/// CI box for reasons that have nothing to do with the bug. Segment rows are what
/// the vocabulary scan walks, so counting them measures the same thing
/// deterministically.
fn foldStorageRows(f: *Fixture) !i64 {
    var r = (try f.db.row("SELECT COUNT(*) FROM temp.token_fold_data;", &.{})).?;
    defer r.finalize();
    return r.int(0);
}

test "a huge fold leaves the shared fold table EMPTY rather than emptied, so in-document search cannot decay with uptime" {
    var f = try Fixture.init();
    defer f.deinit();

    // What one small fold costs on a connection that has folded nothing else.
    // This is the number find-in-note pays per matching page, and it must not
    // depend on anything that happened earlier on the connection.
    _ = try fuzzy.foldTerms(f.a(), f.db, "caligrafia");
    const virgin = try foldStorageRows(&f);
    try testing.expect(virgin > 0); // the fold really did index something

    // A far larger fold through the SAME table. The poison used to be the
    // mint's `writeDocTerms`, which folded a WHOLE DOCUMENT here; that write
    // retired with `doc_terms` in §6 step 6, and the hazard did not — a find over
    // a long `.txt` paragraph or a dense PDF page folds a lot of text through
    // this table on a connection that lives for the process. 4,800 distinct
    // terms is a vocabulary far larger than any ordinary page fold's.
    {
        var big: std.ArrayList(u8) = .empty;
        for (0..60) |i| for (0..80) |w| try big.print(f.a(), "termo{d}x{d} ", .{ i, w });
        _ = try fuzzy.foldTerms(f.a(), f.db, big.items);
    }

    // The very next fold must find the table as clean as the first one did.
    // Under `DELETE FROM` it did not: FTS5 keeps a deleted entry in a new
    // segment, so the whole document stayed in the index — and stayed in the
    // scan — until some later merge happened to reclaim it. Measured at the time,
    // that took a 300-word page fold from 0.15 ms to 13.9 ms PERMANENTLY, with
    // 160-194 ms on the first search after the fold.
    _ = try fuzzy.foldTerms(f.a(), f.db, "caligrafia");
    try testing.expectEqual(virgin, try foldStorageRows(&f));

    // And it is still the same tokenizer over the same string: the reset is not
    // allowed to have cost the fold its meaning.
    const terms = try fuzzy.foldTerms(f.a(), f.db, "calígrafa reunião");
    try testing.expectEqual(@as(usize, 2), terms.len);
    try testing.expectEqualStrings("caligrafa", terms[0]);
    try testing.expectEqualStrings("reuniao", terms[1]);
}

test "the counting pass still counts with the index's own tokenizer after a document has been folded on the same connection" {
    var f = try Fixture.init();
    defer f.deinit();

    // The whole reason `countMatches` folds at all (rather than scanning the
    // string) is that it must see a page exactly as `segment_fts` saw it. Pin
    // that ACROSS another document's fold on the same connection, because the
    // truncating reset is the thing standing between the two.
    const note = try f.putNote(1, "n.note", &.{"a calígrafa escreveu à mão, calígrafa outra vez"});
    _ = try f.putNote(1, "other.note", &.{"palavras completamente diferentes aqui"});

    const r = try f.searchNote(1, note, "caligrafa ");
    try testing.expectEqual(@as(usize, 1), r.pages.len);
    // Two instances, both reached through `remove_diacritics 2` — an ASCII query
    // counting an accented transcript is the case a hand-rolled folding table
    // would get wrong.
    try testing.expectEqual(@as(i64, 2), r.pages[0].matches);
}

// ---------------------------------------------------------------------------
// The bench — what a long-lived connection was doing to find-in-note
// ---------------------------------------------------------------------------

// The defect entry 11b closes is a TIME defect that only a long-lived connection
// shows, so the pin above counts segments (deterministic, cheap, CI-safe) and
// this reports the milliseconds. It runs BOTH shapes side by side rather than
// citing the old one: `temp.token_fold` as it is now (contentless, truncated by
// `'delete-all'`) against a twin that is an ordinary content table emptied by
// `DELETE FROM`, each fed the same whole document and then the same page fold on
// the same connection.
//
// `std.log.INFO` and a REAL database file at the production pragma set, for the
// reasons `txt_index.zig`'s benches state: above Debug `std.log.debug` is
// compiled out, `testing.log_level` starts at `.warn` so this is silent in the
// suite, and the figures have to be taken in ReleaseSafe because a Debug build is
// 6-10x slower under the same statements.
//
// TAKEN 2026-08-09, x86 Ryzen 7840U, NVMe, ReleaseSafe, three runs. The subject
// is entry 11a's: ~120,000 distinct terms, the vocabulary of a 15.7 MB `.txt`.
// One fold of a ~300-word page transcript, i.e. ONE `countMatches` call:
//
// | fold table | first call after the document | steady | worst |
// |---|---:|---:|---:|
// | writer, `DELETE FROM` a content table | **92.9-94.0 ms** | **16.3-16.4 ms** | 94.0 ms |
// | writer, `'delete-all'` a contentless one | 0.38-0.57 ms | **0.24 ms** | 0.96 ms |
// | reader, `DELETE FROM`, NEVER poisoned | 0.20-0.21 ms | **0.39-0.40 ms** | 0.67 ms |
// | reader, `'delete-all'`, never poisoned | 0.21-0.28 ms | **0.15 ms** | 0.28 ms |
//
// Three things to read off it. **The first call after an ingest was ~94 ms** —
// one `countMatches`, and a find-in-note batch makes up to 20 of them. **The
// steady state after it was 16 ms and did not come back**: 68x the 0.24 ms this
// same connection now pays, and the whole of that difference is the vocabulary
// scan walking a document nobody deleted so much as tombstoned. **And the last
// two rows are the surprise** — a reader that never folds a document, only its
// own one-row page folds, was still paying 2.6x, because a one-row `DELETE` is a
// tombstone too and `countMatches` writes one per page it counts.
//
// FTS5's automerge does reclaim it, eventually and unpredictably: at 200 reps
// instead of 40 the "before" steady state reads 2.7 ms, because the merge landed
// somewhere past the 120th fold and dragged the mean down with it. That is what
// "bounded" would have meant here, and it is not a bound a lock hold can be
// built on.

const bench_decay_fold_ddl =
    "CREATE VIRTUAL TABLE IF NOT EXISTS temp.decay_fold USING fts5(t, tokenize='" ++ fuzzy.fts_tokenizer ++ "');" ++
    "CREATE VIRTUAL TABLE IF NOT EXISTS temp.decay_fold_vocab USING fts5vocab('temp','decay_fold','row');";

/// One fold of `text` through `table`, emptied by `reset` first — the shape
/// `fuzzy.foldRows` has, parameterised by the two things the bench varies.
fn benchFold(db: sqlite.Db, comptime table: []const u8, reset: [:0]const u8, text: []const u8) !u64 {
    const t0 = std.Io.Clock.awake.now(testing.io);
    try db.exec(reset);
    {
        var s = try db.prepare("INSERT INTO temp." ++ table ++ "(rowid, t) VALUES(1, ?1);");
        defer s.finalize();
        s.bindText(1, text);
        _ = try s.step();
    }
    var s = try db.prepare("SELECT term, cnt FROM temp." ++ table ++ "_vocab;");
    defer s.finalize();
    var terms: usize = 0;
    while (try s.step()) terms += 1;
    const t1 = std.Io.Clock.awake.now(testing.io);
    std.mem.doNotOptimizeAway(terms);
    return @intCast(t0.durationTo(t1).toNanoseconds());
}

/// `reps` folds of `text`, reported as first / steady / worst — the FIRST is
/// reported apart because it is the one that pays for whatever the whole-document
/// fold left in the table, and a mean would hide it.
fn benchFoldSeries(
    db: sqlite.Db,
    comptime table: []const u8,
    reset: [:0]const u8,
    text: []const u8,
    reps: usize,
    label: []const u8,
) !void {
    const first = try benchFold(db, table, reset, text);
    var total: u64 = 0;
    var worst: u64 = first;
    for (1..reps) |_| {
        const ns = try benchFold(db, table, reset, text);
        total += ns;
        worst = @max(worst, ns);
    }
    std.log.info("[bench] fold {s}: first {d} us, steady {d} us over {d}, worst {d} us", .{
        label, first / std.time.ns_per_us, total / (reps - 1) / std.time.ns_per_us, reps - 1, worst / std.time.ns_per_us,
    });
}

/// Puts a whole document's worth of text into `table`, one row per page — and
/// LEAVES IT THERE, which is what every caller of a non-truncating fold table
/// does, and what the next caller of it inherits.
fn benchPoison(a: std.mem.Allocator, db: sqlite.Db, comptime table: []const u8, pages: usize, words: usize) !void {
    var s = try db.prepare("INSERT INTO temp." ++ table ++ "(t) VALUES(?1);");
    defer s.finalize();
    for (0..pages) |p| {
        var out: std.ArrayList(u8) = .empty;
        defer out.deinit(a);
        for (0..words) |w| try out.print(a, "termo{d}x{d} ", .{ p, w });
        s.reset();
        s.bindText(1, out.items);
        _ = try s.step();
    }
}

test "BENCH note: a page fold on a connection that has folded a whole document, truncated against merely deleted (figures printed)" {
    var f = try Fixture.initAt(true); // a real file: the temp store has to be real
    defer f.deinit();

    // The subject is entry 11a's: ~150,000 distinct terms, the vocabulary of the
    // 15.7 MB `.txt` at `max_file_bytes`. Written straight into the fold table
    // rather than ingested, because what poisons the table is the fold, not the
    // document — the pinning test above drives the same hazard through
    // `fuzzy.foldTerms`, which is the entry point that still exists.
    const poison_pages = 120;
    const poison_words = 1000;

    // A page transcript to fold afterwards, ~300 words, as `countMatches` folds
    // one per matching page.
    var page: std.ArrayList(u8) = .empty;
    for (0..300) |w| try page.print(f.a(), "palavra{d} ", .{w});

    const reps = 40;

    // SHIPPED: contentless, truncated by `'delete-all'`.
    try f.db.exec(fuzzy.fold_ddl);
    try benchPoison(f.a(), f.db, "token_fold", poison_pages, poison_words);
    try benchFoldSeries(f.db, "token_fold", fuzzy.fold_reset_sql, page.items, reps, "SHIPPED (truncated), writer");

    // BEFORE: an ordinary content table emptied with `DELETE FROM`, fed the same
    // document — so the comparison is a measurement rather than a memory.
    try f.db.exec(bench_decay_fold_ddl);
    try benchPoison(f.a(), f.db, "decay_fold", poison_pages, poison_words);
    try benchFoldSeries(f.db, "decay_fold", "DELETE FROM temp.decay_fold;", page.items, reps, "BEFORE (deleted), writer");

    // A reader-pool connection: its own temp schema, and it never folds a whole
    // document — so this is the floor, and it is what every in-doc search on a
    // pooled reader should already have been getting.
    var ro = try sqlite.Db.openReadOnly(f.dbPath());
    defer ro.close();
    try ro.exec(fuzzy.fold_ddl);
    try benchFoldSeries(ro, "token_fold", fuzzy.fold_reset_sql, page.items, reps, "SHIPPED (truncated), reader — never poisoned");

    // The same reader under the old shape, with nothing large ever folded through
    // it — the part of the cost that was never about a whole-document fold at
    // all. A one-row DELETE still leaves a tombstone, and a fold-per-matching-page
    // loop leaves one per page it counted.
    try ro.exec(bench_decay_fold_ddl);
    try benchFoldSeries(ro, "decay_fold", "DELETE FROM temp.decay_fold;", page.items, reps, "BEFORE (deleted), reader — never poisoned");
}
