//! The READ face of the `search/` package: full-text search over the recognized
//! (on-device OCR) transcripts and `.txt` paragraphs the indexer stores in
//! `note_page_index.text`. The package — this file, plus `maintain.zig` (the
//! writes/lifecycle) and `fuzzy.zig` (the typo fallback + the shared tokenizer
//! primitives) — is the SOLE owner of the `segment_fts` FTS5 table and its
//! `segment_search` rows; nothing outside it may touch them.
//! (`search_partition.zig` owns the mask arithmetic and the sequence allocator;
//! docs/scratch/archive/search-architecture.md is the design.)
//!
//! ## The shape: one segment row per (owner, segment), rowid-masked
//!
//! `note_page_index` stays md5-keyed and deduplicated — one copy of the text.
//! `segment_search` holds one ~24-byte row per (owner, segment), whose rowid is
//! `(partition << 48) | seq`; the `segment_text` view resolves that masked
//! rowid back to the shared text, and `segment_fts` indexes THROUGH the view.
//! Postings therefore duplicate only for content two people genuinely share,
//! and a rowid RANGE constraint scopes a search to one owner's partition —
//! FTS5 pushes both bounds into its index (the pinned `M1><` plan), so a
//! search costs what YOUR library costs, not what the install costs.
//!
//! ## The join is the security boundary — and the package is what guards it
//!
//! MASK FOR SPEED, JOIN FOR CORRECTNESS. The partition range only scopes the
//! scan; a forged or miscomputed rowid must be stopped by the `files` join
//! (`user_id = ? AND deleted = 0`) — the mask is never the access check. Every
//! read is built on the ONE `search_from_where` clause below, so the join
//! cannot be forgotten in a second entry point; the `search/` package boundary
//! is what keeps the FTS table's reads and writes from leaking into a fourth
//! file where it could be. There are exactly THREE exported reads — `searchPages`
//! (library-wide), `searchNotePages` and `searchTxtSegments` (in-document) — and
//! a scoped read can only ADD a bound to the shared clause, never narrow it.
//!
//! The writes that mint and retire these rows live in `maintain.zig`; every one
//! runs inside the caller's transaction, and wherever postings are subtracted
//! the FTS 'delete' runs FIRST, while the text it was indexed from still
//! resolves. See that module's header for the three-path lifecycle.

const std = @import("std");
const sqlite = @import("../../db/sqlite.zig");
const partition = @import("../search_partition.zig");

// The reads name fuzzy.zig's matcher + shared tokenizer primitives, and
// maintain.zig's shared `fts_predicate`, through these aliases — so the
// production reads stay unchanged across the split. This block lists exactly
// what those reads depend on; symbols exercised ONLY by this file's tests are
// named `fuzzy.x` / `maintain.x` directly at the call site rather than aliased.
const fuzzy = @import("fuzzy.zig");
const min_prefix_len = fuzzy.min_prefix_len;
const max_fuzzy_terms = fuzzy.max_fuzzy_terms;
const fts_tokenizer = fuzzy.fts_tokenizer;
const VocabSource = fuzzy.VocabSource;
const buildFuzzyMatch = fuzzy.buildFuzzyMatch;
const appendToken = fuzzy.appendToken;
const termLen = fuzzy.termLen;
const foldRows = fuzzy.foldRows;
const foldTerms = fuzzy.foldTerms;
const maintain = @import("maintain.zig");
const fts_predicate = maintain.fts_predicate;

/// Default and maximum number of DOCUMENTS one library-wide search returns —
/// deliberately the SAME number: results are a keyset-paginated stream (see
/// `Results.cursor`), so a bigger first page buys nothing that "more" does not,
/// and the early-termination query is O(limit), so the cap is also what keeps a
/// broad term from scanning past its page.
///
/// DOCUMENTS, not pages, since the document loop (`collectDocs`): a page holds
/// one hit per matching document rather than 20 segments that can all belong to
/// one notebook. `hits.len` can still exceed this only by FANOUT — two `files`
/// rows of one blob are two real library entries and both surface.
pub const default_limit: i64 = 20;
pub const max_limit: i64 = default_limit;

/// The most library entries ONE segment rowid may contribute to a page. Fanout
/// is genuine — a user holding two copies of a notebook has two files, and a hit
/// on the shared blob belongs to both — so the document loop takes the whole
/// group at the matched rowid before it jumps past the band.
///
/// The cap is what keeps that from being unbounded: past it the group's tail is
/// dropped rather than letting one segment own the page. Only reachable by
/// holding 20+ copies of the same matching note, and bounded either way.
const max_fanout: i64 = max_limit;

/// In-document keyset batch size. The find-in-note / find-in-txt entry points
/// (`searchNotePages`, `searchTxtSegments`) return ONE batch of this many
/// matching segments plus a `cursor` to resume, exactly as `searchPages`
/// streams the library-wide search — the client auto-drains to the exact count.
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

/// The floor a LIBRARY-WIDE query must clear before it is searched at all. A one-
/// or two-character global query is broad-term cost and noise: it matches very
/// nearly the whole index, is expensive to score, and answers nothing anyone was
/// asking. The frontend gates on this too (`pages/noteSearch.ts`); this constant
/// is defense-in-depth behind that gate — the library route must not run a search
/// the box would never have sent. It applies ONLY to `searchPages` (the global
/// entry). In-document search (`searchNotePages`, `searchTxtSegments`) is EXEMPT
/// by design — once a file is open you can find a 1-char string inside it, and
/// there is no library-wide cost to pay.
pub const min_global_query_len: usize = 3;

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

/// One search result: enough to link straight to the page, plus the excerpt.
/// Field names are the JSON the browser receives.
pub const Hit = struct {
    /// The FILE id (stringified, as everywhere else on this face) — not the
    /// blob md5. Two users' hits on one shared blob are different notes.
    noteId: []const u8,
    noteName: []const u8,
    pageIndex: i64,
    /// The matching excerpt, with `<mark>…</mark>` around the matched terms
    /// (`.ocr__body mark` is already styled). SQLite escapes nothing, so the
    /// text is HTML-escaped here before the markers go in.
    snippet: []const u8,
    /// The segment KIND — what `pageIndex` counts. OMITTED for a `.note`
    /// page (kind 0: this face drops null optionals, so the kind-0 wire
    /// shape is byte-identical to what it was before other kinds existed —
    /// tolerant normalization on the client reads absent as 0); `1` for a
    /// `.txt` paragraph, whose ordinal is the paragraph index (see
    /// `txt_index.zig`; "≈line N" and the viewer deep link derive from the
    /// stored byte range client-side, with the viewer lane).
    kind: ?i64 = null,
};

/// How much of the caller's library is searchable at all. Only ever present on
/// a response with NO hits — see `coverageOf`.
pub const Coverage = struct {
    /// Notes the caller owns: undeleted files the indexer actually parsed a
    /// `.note` container out of. Not a filename rule — the same "verified, not
    /// claimed" test the file-type rule uses.
    notes: i64,
    /// How many of those carry no recognized text, and are therefore invisible
    /// to search however it is spelled.
    unsearchable: i64,
};

pub const Results = struct {
    /// The query as searched, echoed so a late response can be discarded.
    query: []const u8,
    hits: []const Hit,
    /// Whether the typo-tolerant fallback actually ran — i.e. whether these
    /// hits answer the query as typed or only approximately. The UI says so
    /// once, above the results ("nothing matches `calig` exactly"); presenting
    /// an approximate answer as an exact one is the lie this prevents.
    ///
    /// NOT optional, deliberately. This face serializes with
    /// `emit_null_optional_fields = false`, so an optional `false` would be
    /// OMITTED and the client could not tell "the search was exact" from "the
    /// server is too old to say" — which are opposite instructions about
    /// whether to show the banner. `false` has to be on the wire.
    usedFuzzy: bool = false,
    /// Present only when `hits` is empty, because that is the only state that
    /// renders it: the empty state's "only notes recognised on the device are
    /// searchable" is true but unquantified, and "12 of your 40 notes have no
    /// recognised text" is the difference between "it is not there" and "it
    /// might be there and I cannot see it".
    ///
    /// Optional — unlike `usedFuzzy` — precisely because its absence is not a
    /// claim: a client that does not receive it simply shows the unquantified
    /// sentence it shows today. Conditional so the aggregate is not paid on
    /// every keystroke of a search that IS finding things.
    coverage: ?Coverage = null,
    /// Keyset resumption token: present ONLY when more results may exist, and
    /// NEVER a total — a total would cost counting every match, the exact work
    /// early termination exists to avoid (the UI says "20+", not "20 of N").
    /// Opaque to the client (it encodes the START of the last document's band —
    /// the jump target, which is where the next scan already begins); passing it
    /// back as `?cursor=` resumes the stream exactly where it stopped, stable
    /// under concurrent ingest because new rows only ever mint HIGHER sequences.
    /// Omitted from the JSON when null (this face drops null optionals), which
    /// is exactly the "no more results" signal.
    cursor: ?[]const u8 = null,
};

/// THE query shape (decision 6 of the plan). Every clause is load-bearing:
///
///   - `segment_fts MATCH ?1` — the actual search.
///   - `segment_fts.rowid BETWEEN ?2 AND ?3` — the caller's partition range,
///     pushed INTO the FTS index by FTS5 (the `M1><` plan a test pins). This
///     is early termination's other half: with `ORDER BY rowid DESC LIMIT n`
///     the posting walk stops after n in-partition matches — O(limit), not
///     O(matches) — and DESC order correlates with per-partition recency. The
///     library-wide read rebinds `?3` in a loop to walk DOCUMENTS rather than
///     segments (`collectDocs`), and the keyset cursor folds into the SAME two
///     bounds (`?3 = min(hi, cursor - 1)`), so page 2 resumes exactly where
///     page 1 stopped and there is one plan to pin rather than two.
///   - `JOIN segment_search s` / `JOIN note_page_index p` — the masked rowid
///     back to the SHARED text row (dedup intact: one copy of the text).
///   - `JOIN files f ON f.md5 = p.blob_md5` + `f.user_id = ?4` + `f.deleted =
///     0` + `f.is_folder = 0` — MASK FOR SPEED, JOIN FOR CORRECTNESS: the
///     range only scopes the scan; a forged or miscomputed rowid must be
///     stopped HERE. The join is the access check, never the mask.
///   - `p.recogn_status = 1` — only finished recognition is searchable.
///
/// No `ORDER BY bm25`: ranking every match before LIMIT is the O(matches)
/// pathology this shape retires. The ≤limit rows that come back are sorted for
/// DISPLAY by `files.updated_at` in Zig — rowid order is used for early
/// termination, never for its meaning (a remint would quietly change it).
///
/// The FROM/WHERE every read of the FTS table is built on, written ONCE.
/// There are THREE exported reads — library-wide (`searchPages`), note-scoped
/// (`searchNotePages`) and `.txt`-scoped (`searchTxtSegments`) — and there must
/// never be two copies of this: the module docs call the `files` join a
/// security boundary and warn that "a second entry point would be a place to
/// forget it". A scoped query cannot narrow the join, it can only add to it.
///
/// `?1` MATCH, `?2`/`?3` partition bounds, `?4` the caller's user id.
const search_from_where =
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

/// `p.blob_md5` rides along for `bandStart`'s guard — it is what makes the
/// validation lookup decisive (see there). It costs nothing: `note_page_index`
/// is already joined, and the FROM/WHERE/ORDER BY/LIMIT shape is untouched, so
/// the pinned `M1><` plan is unaffected by the extra column.
const search_sql =
    \\SELECT f.id, f.name, p.page_index,
    \\       snippet(segment_fts, 0, ?6, ?7, '…', 16),
    \\       p.id, s.id, f.updated_at, p.kind, p.blob_md5
++ "\n" ++ search_from_where ++ "\n" ++
    \\ ORDER BY segment_fts.rowid DESC
    \\ LIMIT ?5;
;

/// Searches `user_id`'s recognized pages for `raw_query`. Everything returned is
/// allocated in `arena` (the handler owns it).
///
/// ## What this read ANSWERS: which DOCUMENTS match, not which pages
///
/// A page of results names up to `limit` documents, one hit each, and seeks past
/// the rest of every band it names (`collectDocs` has the mechanism and the
/// reason). The contract that replaced global↔in-doc result equality is three
/// statements, and the tests pin each:
///
///   - **Document parity.** A document appears in the drained stream IFF its
///     in-doc search for the same query is non-empty — exactly once per band,
///     never fabricated, never omitted.
///   - **Representative honesty.** The page reported for a document is a page
///     in-doc search also returns: a member of the set, not an arbitrary index.
///   - **In-doc owns completeness.** This read does not claim, and no longer
///     implies, HOW MANY pages of a document matched. `searchNotePages` is the
///     authority on that, and the only one.
///
/// The excerpt is unchanged by all of it: within a band `rowid DESC` yields the
/// document's last matching page first, which is already the page whose snippet
/// the grouped row showed.
///
/// This is the LIBRARY-WIDE exported read; `searchNotePages` and
/// `searchTxtSegments` are the two in-document ones. All THREE build on the one
/// `search_from_where` clause above — its `files` join is a security boundary,
/// and funnelling every read through the single clause is what keeps a new
/// entry point from being a place to forget it. An empty or all-punctuation
/// query returns no hits rather than matching everything.
///
/// `cursor` resumes an earlier page of the same query (see `Results.cursor`);
/// `error.InvalidCursor` for a token that does not parse. A cursor minted
/// under a partition generation that has since been reminted resumes nothing —
/// the stream is honestly over and the client starts a fresh search. The typo
/// fallback never runs on a resumed page and never hands out a cursor: it is a
/// zero-hit nicety, not a stream, and letting page 3 of an exact stream
/// suddenly widen into near-misses would change what `usedFuzzy` means
/// mid-scroll.
pub fn searchPages(
    arena: std.mem.Allocator,
    io: std.Io,
    db: sqlite.Db,
    user_id: u64,
    raw_query: []const u8,
    limit: i64,
    cursor: ?[]const u8,
) !Results {
    const query = try arena.dupe(u8, trimQuery(raw_query));
    // THE GLOBAL-SEARCH FLOOR (defense-in-depth behind the frontend gate). A 1–2
    // character library-wide query never leaves the box (`pages/noteSearch.ts`),
    // and if one reaches here anyway it returns empty — no hits, no cursor, and
    // no coverage/vocabulary scan paid for it. In-doc search (`searchNotePages`,
    // `searchTxtSegments`) does NOT do this: a short find inside an open file is
    // both cheap and wanted. See `min_global_query_len`.
    if (charLen(query) < min_global_query_len) return .{ .query = query, .hits = &.{} };
    const still_typing = isStillTyping(raw_query);
    const match = (try buildMatch(arena, query, still_typing)) orelse
        return noHits(db, user_id, query, false);

    const marks = Marks.init(io);
    const capped: usize = @intCast(std.math.clamp(limit, 0, max_limit));

    // MASK FOR SPEED: the caller's partition bounds. A user with no partition
    // yet (nothing ever ingested) scans an empty range — same answer as an
    // empty library, same code path, so the fuzzy/coverage behaviour below is
    // identical for them.
    const part = try partition.active(db, user_id);
    var lo: i64 = 0;
    var hi: i64 = -1;
    if (part) |pid| {
        lo = partition.base(pid);
        hi = partition.last(pid);
    }
    var resumed = false;
    if (cursor) |c| {
        const rid = decodeCursor(c) orelse return error.InvalidCursor;
        if (part == null or partition.partitionOf(rid) != part.?)
            return noHits(db, user_id, query, false); // the generation moved
        hi = @min(hi, rid - 1); // the keyset folds into the SAME range bounds
        resumed = true;
    }

    // The primary pass, unwidened: one hit per DOCUMENT, seeking past the rest
    // of each band (`collectDocs`). `usedFuzzy` stays false here, and the
    // vocabulary is not consulted at all — the flag is a report of what ran, not
    // a guess after the fact.
    const page = try collectDocs(arena, db, match, user_id, lo, hi, capped, marks);
    if (page.any) {
        // Minted from the JUMP TARGET, not from the last kept row: after the
        // last document the next scan bound is already known exactly.
        const cur: ?[]const u8 = if (page.more and page.kept.len > 0)
            try encodeCursor(arena, page.next)
        else
            null;
        displaySort(page.kept);
        return .{ .query = query, .hits = try hitsOf(arena, page.kept), .cursor = cur };
    }
    // A resumed stream that ran dry is simply over — no widening into a
    // different kind of answer three pages in.
    if (resumed) return noHits(db, user_id, query, false);

    // Zero rows: only now do we pay for the vocabulary scan. Library-wide search
    // keeps the WHOLE-CORPUS pool — its scope IS the whole library.
    const expansion = (try buildFuzzyMatch(arena, db, query, still_typing, max_fuzzy_terms, .corpus)) orelse
        return noHits(db, user_id, query, false);

    // The same document loop — it is capped and cursorless here, so it simply
    // stops at `capped` documents and hands out no way to resume.
    const widened = try collectDocs(arena, db, expansion.match, user_id, lo, hi, capped, marks);
    const fuzzy_rows = widened.kept;
    displaySort(fuzzy_rows);
    try rankExactFirst(arena, db, query, still_typing, lo, hi, fuzzy_rows);
    // The expansion having RUN is what the flag reports, so it is true even when
    // the widened search still found nothing.
    if (fuzzy_rows.len == 0) return noHits(db, user_id, query, true);
    return .{ .query = query, .hits = try hitsOf(arena, fuzzy_rows), .usedFuzzy = true };
}

/// One page of the DOCUMENT stream.
const DocPage = struct {
    kept: []Row,
    /// Whether the scan matched ANYTHING in range, which is not the same
    /// question as `kept.len > 0`: `limit = 0` keeps nothing and must still not
    /// widen into the typo fallback. "No room on the page" is not "no matches".
    any: bool,
    /// Whether anything remained below the last jump — decided by one `LIMIT 1`
    /// probe, never by counting.
    more: bool,
    /// The next page's exclusive upper bound: it scans `rowid <= next - 1`.
    /// Meaningless when `more` is false.
    next: i64,
};

/// Walks the corpus DOCUMENT by document: one scan per document kept, each
/// rebinding the SAME statement's upper bound to below the band the last hit
/// belongs to.
///
/// ## Why a loop of seeks, and not one long walk
///
/// A document's segments are ONE contiguous rowid run — `maintain.flipOwnerBlob`
/// states the invariant outright, `rowid ASC == reading order` after every edit,
/// and `holderBandCanonical` heals any legacy band that isn't. So
/// `ORDER BY rowid DESC` does not interleave documents: it walks them one at a
/// time, last page to first within each. A term appearing on 300 pages of one
/// planner therefore owned fifteen consecutive pages of results — all rendering
/// as the SAME row, since the client groups hits by note — which is what "no
/// results until I click More a few times" was actually reporting. It was never
/// an empty window; it was one document owning every window.
///
/// Because the band is contiguous, "stop searching this document" is not a
/// per-row test over its remaining postings: it is MOVING THE UPPER BOUND below
/// the band's start, the keyset move the query already makes. The planner's
/// other 299 postings are never visited, they are stepped over — a page costs
/// ~`want + 1` posting seeks instead of one walk through thousands.
///
/// THE SQL NEVER CHANGES. Same clause, same `ORDER BY … DESC`, same `LIMIT`,
/// the same statement rebound with new bounds — so the pinned `M1><` pushdown
/// still holds and there is no second plan to pin.
///
/// `want` is a count of DOCUMENTS; `kept` can be longer through fanout.
fn collectDocs(
    arena: std.mem.Allocator,
    db: sqlite.Db,
    match: []const u8,
    user_id: u64,
    lo: i64,
    hi_from: i64,
    want: usize,
    marks: Marks,
) !DocPage {
    var sc = try Scan.open(db, match, user_id, marks);
    defer sc.close();

    var kept: std.ArrayList(Row) = .empty;
    var hi = hi_from;
    var any = false;
    var docs: usize = 0;
    while (docs < want) : (docs += 1) {
        // TWO rows, not one: the second is what says whether this rowid fans out
        // — and asking for two costs one spare `snippet()` per document, where a
        // `want`-sized fetch would generate (and discard) a page's worth for
        // every document on the page.
        const rows = try sc.rows(arena, lo, hi, 2);
        if (rows.len == 0) return .{ .kept = kept.items, .any = any, .more = false, .next = 0 };
        any = true;
        const head = rows[0];
        // FANOUT: every row at the matched rowid, before the jump takes the band
        // away. Re-read scoped to that ONE rowid (`[R, R]`), so completing the
        // group is a seek and not a scan.
        const group = if (rows.len > 1 and rows[1].seg_rowid == head.seg_rowid)
            try sc.rows(arena, head.seg_rowid, head.seg_rowid, max_fanout)
        else
            rows[0..1];
        try kept.appendSlice(arena, group);

        // THE JUMP.
        const band = try bandStart(&sc, lo, head);
        hi = band - 1;
        // The partition is exhausted exactly here, so there is nothing left to
        // probe and no cursor to mint.
        if (hi < lo) return .{ .kept = kept.items, .any = true, .more = false, .next = 0 };
    }
    // `more` stays a FACT rather than a guess, as this module insists: ONE seek
    // below the final jump. A count would cost every remaining match, which is
    // the work early termination exists to avoid — the UI says "20+", never
    // "20 of N".
    const probe = try sc.rows(arena, lo, hi, 1);
    return .{
        .kept = kept.items,
        .any = any or probe.len > 0,
        .more = probe.len > 0,
        .next = hi + 1,
    };
}

/// Is the candidate rowid the first page OF THIS BLOB? `segment_search.id` and
/// `note_page_index.id` are both primary keys, so this is two seeks.
const band_start_sql =
    \\SELECT 1 FROM segment_search s
    \\  JOIN note_page_index p ON p.id = s.segment_id
    \\ WHERE s.id = ?1 AND p.blob_md5 = ?2 AND p.page_index = 0;
;

/// The first masked rowid of the band `hit` belongs to — the jump target — or
/// `hit.seg_rowid` itself when that cannot be established, in which case the
/// caller steps by one instead of jumping (exactly today's behaviour).
///
/// A canonical band is laid down as `first + ROW_NUMBER() OVER (ORDER BY
/// page_index) - 1` (`maintain.mintOwnerBlobSearch`), so inside it
/// `rowid = first + page_index` and the candidate is `R - page_index`, free.
///
/// ## Why the arithmetic is CHECKED and never trusted
///
/// `maintain.mintPageForHolders` mints a fresh TAIL rowid for a page a later
/// re-parse added to a blob other holders already hold. That rowid has no
/// arithmetic relation to its `page_index`, so `R - page_index` can land far
/// below the band — and a jump to a wrong, LOW target silently skips other
/// documents' matches. That is the one failure mode here that loses results
/// without saying so, which is why correctness never rests on the invariant:
/// the invariant only buys the speed, and a band that does not hold it degrades
/// to a step.
///
/// Two conditions must BOTH hold:
///
///   - **The candidate is at or above the scan's own floor.** Sequences are
///     allocated per partition, so a canonical band lies wholly inside one and a
///     candidate below `lo` cannot be a real band start. Jumping there would end
///     the scan and discard the rest of the partition unannounced.
///   - **`segment_search` at the candidate resolves to page 0 OF THE SAME
///     BLOB.** Same-blob is what makes this decisive rather than suggestive:
///     `note_page_index` is `UNIQUE(blob_md5, page_index)` and a holder has one
///     segment row per segment, so at most ONE rowid in the partition is this
///     blob's page 0. Finding it at exactly `R - page_index` IS the canonical
///     relationship, not a coincidence shaped like one.
fn bandStart(sc: *Scan, lo: i64, hit: Row) !i64 {
    const candidate = hit.seg_rowid - hit.hit.pageIndex;
    if (hit.hit.pageIndex < 0 or candidate < lo) return hit.seg_rowid;
    // Page 0 IS the band start, whatever else is true of the band — no lookup
    // can add anything, and this is the common case (a one-page document, or a
    // term that matched the first page).
    if (candidate == hit.seg_rowid) return candidate;
    if (!try sc.isBandStart(candidate, hit.blob_md5)) return hit.seg_rowid;
    return candidate;
}

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

/// Display order for the ≤limit rows of one page: `files.updated_at` newest
/// first (the explicit field — rowid order got us here cheaply but MEANS
/// nothing after a remint), then name and page index so identical timestamps
/// are stable. Insertion sort: stable, and the slice is at most `max_limit`.
fn displaySort(rows: []Row) void {
    std.sort.insertion(Row, rows, {}, displayOrder);
}

fn displayOrder(_: void, a: Row, b: Row) bool {
    if (a.updated_at != b.updated_at) return a.updated_at > b.updated_at;
    switch (std.mem.order(u8, a.hit.noteName, b.hit.noteName)) {
        .lt => return true,
        .gt => return false,
        .eq => {},
    }
    return a.hit.pageIndex < b.hit.pageIndex;
}

/// The one empty-result shape, so every zero-hit exit carries the coverage the
/// empty state needs and none of the others pay for it.
fn noHits(db: sqlite.Db, user_id: u64, query: []const u8, used_fuzzy: bool) !Results {
    return .{
        .query = query,
        .hits = &.{},
        .usedFuzzy = used_fuzzy,
        .coverage = try coverageOf(db, user_id),
    };
}

/// "A note" is the indexer's own verdict — a file whose blob it actually parsed
/// a `.note` container out of — rather than a filename ending in `.note`. A PDF
/// or a PNG is not an unsearchable note, it is not a note.
///
/// "Unsearchable" is the exact complement of what `search_from_where` can reach:
/// a note with no page row carrying finished recognition text. Same predicate
/// constant as the index sync, so the two cannot drift into disagreeing about
/// which pages count.
const coverage_sql =
    "SELECT COUNT(*), SUM(CASE WHEN EXISTS (" ++
    "SELECT 1 FROM note_page_index WHERE blob_md5 = f.md5 AND recogn_status = 1 AND " ++ fts_predicate ++
    ") THEN 0 ELSE 1 END) " ++
    "FROM files f " ++
    "WHERE f.user_id = ?1 AND f.deleted = 0 AND f.is_folder = 0 " ++
    "AND EXISTS (SELECT 1 FROM note_index WHERE blob_md5 = f.md5 AND indexable = 1);";

fn coverageOf(db: sqlite.Db, user_id: u64) !Coverage {
    var r = (try db.row(coverage_sql, &.{.{ .int = @intCast(user_id) }})) orelse return .{ .notes = 0, .unsearchable = 0 };
    defer r.finalize();
    // `SUM` over no rows is NULL, which reads back as 0 — the right answer for
    // an empty library, and the only NULL this statement can produce.
    return .{ .notes = r.int(0), .unsearchable = r.int(1) };
}

/// One result row, plus what `Hit` does not carry: the `note_page_index.id`
/// the re-ranker needs, the masked segment rowid the keyset cursor is built
/// from, `files.updated_at` for the display sort, and the blob the document
/// loop's band guard validates against. All internal — `Hit` is the wire shape
/// and stays exactly as it was.
const Row = struct {
    hit: Hit,
    page_id: i64,
    seg_rowid: i64,
    updated_at: i64,
    blob_md5: []const u8,
};

/// The two statements the document loop runs, PREPARED ONCE and rebound per
/// iteration.
///
/// This is what makes a loop of seeks cheaper than one long walk rather than
/// merely different: re-preparing the search each time would re-parse the MATCH
/// expression and re-plan the four-way join on every document, which measured
/// several times the cost of the seek it wraps. `sqlite3_reset` leaves bindings
/// in place, so the match, the user id and the snippet markers are bound once at
/// open and only the bounds and the limit move.
const Scan = struct {
    search: sqlite.Stmt,
    band: sqlite.Stmt,
    marks: Marks,

    fn open(db: sqlite.Db, match: []const u8, user_id: u64, marks: Marks) !Scan {
        var search = try db.prepare(search_sql);
        errdefer search.finalize();
        const band = try db.prepare(band_start_sql);
        // The invariant parameters. `bindText` copies (SQLITE_TRANSIENT), so
        // neither `match` nor `marks` has to outlive this call.
        search.bindText(1, match);
        search.bindInt(4, @intCast(user_id));
        search.bindText(6, &marks.open);
        search.bindText(7, &marks.close);
        return .{ .search = search, .band = band, .marks = marks };
    }

    fn close(sc: *Scan) void {
        sc.search.finalize();
        sc.band.finalize();
    }

    /// One pass over `[lo, hi]`, newest first, at most `limit` rows.
    fn rows(sc: *Scan, arena: std.mem.Allocator, lo: i64, hi: i64, limit: i64) ![]Row {
        const s = sc.search;
        s.reset();
        s.bindInt(2, lo);
        s.bindInt(3, hi);
        s.bindInt(5, limit);

        var out: std.ArrayList(Row) = .empty;
        while (try s.step()) {
            try out.append(arena, .{
                .hit = .{
                    .noteId = try std.fmt.allocPrint(arena, "{d}", .{s.columnInt(0)}),
                    .noteName = try arena.dupe(u8, s.columnText(1)),
                    .pageIndex = s.columnInt(2),
                    .snippet = try escapeSnippet(arena, s.columnText(3), sc.marks),
                    // 0 (a note page) serializes as ABSENT — see `Hit.kind`.
                    .kind = if (s.columnInt(7) == 0) null else s.columnInt(7),
                },
                .page_id = s.columnInt(4),
                .seg_rowid = s.columnInt(5),
                .updated_at = s.columnInt(6),
                .blob_md5 = try arena.dupe(u8, s.columnText(8)),
            });
        }
        return out.items;
    }

    /// Whether `candidate` is the first page OF `blob_md5` — the band guard's
    /// one lookup, both halves of it primary-key seeks.
    fn isBandStart(sc: *Scan, candidate: i64, blob_md5: []const u8) !bool {
        const s = sc.band;
        s.reset();
        s.bindInt(1, candidate);
        s.bindText(2, blob_md5);
        return s.step();
    }
};

fn hitsOf(arena: std.mem.Allocator, rows: []const Row) ![]const Hit {
    const hits = try arena.alloc(Hit, rows.len);
    for (rows, hits) |r, *h| h.* = r.hit;
    return hits;
}

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
    /// Echoed for the same reason as `Results.query`: find searches on every
    /// keystroke, and a late response has to be discardable.
    query: []const u8,
    /// ONE keyset batch of matching pages, in `rowid ASC` order — which Phase 1
    /// makes reading order for a canonical band, so the client accumulates
    /// batches with no re-sort. NOT the whole note in one response any more (the
    /// synchronous complete scan is gone): the client auto-drains `cursor` to
    /// reach the exact "N in M pages" count. See `searchNotePages`.
    pages: []const PageMatch,
    /// Whether the typo-tolerant fallback ran, exactly as `Results.usedFuzzy`
    /// reports it for library-wide search — and NOT optional for the same
    /// reason: this face omits null optionals, so an absent `false` could not be
    /// told from a server too old to say.
    ///
    /// Global search tolerates typos and says so. Find silently not doing the
    /// same was a trap: the identical query answered in two different ways with
    /// nothing on screen to explain it.
    usedFuzzy: bool = false,
    /// Keyset resumption token, encoded EXACTLY as `Results.cursor` (16 hex of
    /// the last batch's masked segment rowid): present only when more matching
    /// pages may exist, absent (omitted from the JSON) when the document is
    /// exhausted — the "stop draining" signal. Passing it back as `?cursor=`
    /// resumes the stream where it stopped. The fuzzy fallback never hands one
    /// out (a zero-exact-hit nicety, not a stream), exactly as `searchPages`.
    cursor: ?[]const u8 = null,
};

const note_search_sql =
    \\SELECT p.page_index, p.text, s.id
++ "\n" ++ search_from_where ++ "\n" ++
    \\   AND f.id = ?5
    \\ ORDER BY p.page_index;
;

/// The note-scoped KEYSET read: the SAME clause as `note_search_sql` but ordered
/// by `segment_fts.rowid ASC` and `LIMIT`ed, so one batch resumes exactly where
/// the last stopped. The cursor folds into the `?2` lower bound (`?2 = max(range
/// lo, cursor+1)`) exactly as `searchPages` folds it into `?3` — one bracket,
/// one `M1><` pushdown to pin, no extra clause. `?6` is the batch limit (+1, to
/// learn "more may exist" as a fact rather than a guess).
const note_keyset_sql =
    \\SELECT p.page_index, p.text, s.id
++ "\n" ++ search_from_where ++ "\n" ++
    \\   AND f.id = ?5
    \\ ORDER BY segment_fts.rowid ASC
    \\ LIMIT ?6;
;

// ---------------------------------------------------------------------------
// In-document scoping — the SAME query, the DOCUMENT'S rowid bracket
// ---------------------------------------------------------------------------

// In-doc search reuses `note_search_sql`/`txt_search_sql` VERBATIM — same
// `segment_fts`, same tokenizer, same `MATCH`, same fuzzy ladder, same `files`
// join written ONCE. The ONLY thing that changes is the rowid bracket bound
// into `?2 AND ?3`: global search binds the caller's whole PARTITION range,
// in-doc binds the DOCUMENT'S own segment range. FTS5 pushes that bracket into
// its index either way (the pinned `M1><` plan), so the identical query costs
// O(document) instead of O(library) — matching is identical BY CONSTRUCTION,
// only the scan is narrower.
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
/// bracket (today's `search_from_where` behaviour, correct but O(library)).
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
/// `txt_search_sql` does — the ranges must cover the same segments the search
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
/// ## Why this is not `searchPages` with a filter
///
/// `searchPages` is ranked bm25 across the whole library. Reused as a per-note
/// counter it is SILENTLY INCOMPLETE in a way batching is not: its bm25 window
/// drops the note being read below other notes' higher-ranked hits, so the
/// count is simply wrong. This query has the note in the WHERE clause, not in a
/// post-filter, and rank plays no part — so draining every batch reaches the
/// EXACT per-note count, which a document (being finite) always can, unlike the
/// permanent floors library-wide search lives with.
///
/// ## Batched, not one monolith (the fairness win)
///
/// It used to scan the whole note in one response. On the single-core Pi that
/// was one multi-second `dbLock` hold that froze every other user. Now it is a
/// keyset stream — the SAME shape `searchPages` uses, only the rowid bracket is
/// the DOCUMENT's — returning `batch` pages and a `cursor`; the client
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
/// ## The typo fallback, and why it can run here now
///
/// It used not to. The argument was that find draws ovals on the words it
/// counted, so a count quietly including near-misses would disagree with what is
/// circled — sound, but it diagnosed the wrong thing. The client was re-deriving
/// which words to circle with its own folded substring test, independently of how
/// this query counted; the two agreed on exact queries by luck, and that
/// coincidence is what the fallback would have broken.
///
/// With `PageMatch.terms` the client circles exactly what was counted, so the
/// fallback costs nothing in agreement — and global search already tolerates
/// typos, which made find silently not doing so a trap rather than a nicety.
/// Same shape as `searchPages`: exact first, the vocabulary consulted ONLY when
/// that returned nothing, and `usedFuzzy` reporting what actually ran.
///
/// ## The boundary is the same one
///
/// It runs through `search_from_where`, so `f.user_id`/`f.deleted`/`f.is_folder`
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
    return .{ .query = b.query, .pages = pages, .usedFuzzy = b.used_fuzzy, .cursor = b.cursor };
}

/// The result of a one-document history scan (H8). Deliberately the smaller
/// shape of the two in-doc searches — `NoteResults` without `cursor` (the scan
/// is complete in one pass) — so the frontend's find-in-preview reuses its
/// find-in-note page rendering. `usedFuzzy` is always false: a frozen version
/// gets exact + accent-fold matches, never the corpus-wide fuzzy widening.
pub const HistoryResults = struct {
    query: []const u8,
    pages: []const PageMatch,
    usedFuzzy: bool = false,
};

/// In-document search over ONE retained version's recognized text (H8), for the
/// `GET …/history/{md5}/search` route.
///
/// NOT the FTS: old versions are never in the shared index (H2), by design — so
/// this scans `note_page_index.text` for `md5` directly, page by page, and counts
/// with the index's OWN tokenizer (`countMatches`), exactly as find-in-note does
/// its per-page counting. Bounded by ONE document: no corpus scan, no
/// `fts5vocab`, no fuzzy widening. `md5`'s ownership + retained-ness are the
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
    return .{ .query = query, .pages = pages.items, .usedFuzzy = false };
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
    /// Whether the typo-tolerant fallback ran, exactly as `NoteResults`
    /// reports it and read the same strict way at the seam.
    usedFuzzy: bool = false,
    /// Keyset resumption token, encoded exactly as `NoteResults.cursor` /
    /// `Results.cursor`: present only when more paragraphs may exist, absent when
    /// the file is exhausted. The fuzzy fallback hands out none.
    cursor: ?[]const u8 = null,
};

/// The `.txt` read: `search_from_where` like every other read of this table (so
/// the `files` join it cannot narrow is the SAME security boundary), narrowed
/// to one file and to `kind = 1` chunk rows, carrying the byte range the viewer
/// needs. `f.id = ?5`, `p.kind = 1` are additions to the shared clause, never
/// relaxations of it.
const txt_search_sql =
    \\SELECT p.page_index, p.recogn_offset, p.recogn_length, p.text, s.id
++ "\n" ++ search_from_where ++ "\n" ++
    \\   AND f.id = ?5
    \\   AND p.kind = 1
    \\ ORDER BY p.page_index;
;

/// The `.txt` KEYSET read: `txt_search_sql`'s clause ordered by
/// `segment_fts.rowid ASC` and `LIMIT`ed, the cursor folded into the `?2` lower
/// bound — the `.txt` analog of `note_keyset_sql`.
const txt_keyset_sql =
    \\SELECT p.page_index, p.recogn_offset, p.recogn_length, p.text, s.id
++ "\n" ++ search_from_where ++ "\n" ++
    \\   AND f.id = ?5
    \\   AND p.kind = 1
    \\ ORDER BY segment_fts.rowid ASC
    \\ LIMIT ?6;
;

/// Every `.txt` paragraph of ONE file that matches `raw_query`, with a per-
/// paragraph match count and byte range — find-in-txt's counter and its
/// prev/next paragraph jumps.
///
/// The exact shape of `searchNotePages`, and for the exact same reasons: it is
/// NOT `searchPages` filtered (that is ranked and clamped, so a per-file
/// counter built on it is silently incomplete), it runs through
/// `search_from_where` (so a foreign, trashed or non-existent file is one
/// indistinguishable empty answer), and it tolerates typos through the same
/// two-phase fallback — exact first, the vocabulary consulted only when that
/// found nothing, `usedFuzzy` reporting what ran. It differs from the note-
/// scoped read in only two ways: the rows carry the byte range, and `kind = 1`
/// selects paragraph segments rather than note pages.
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
    return .{ .query = b.query, .segments = segs, .usedFuzzy = b.used_fuzzy, .cursor = b.cursor };
}

// ---------------------------------------------------------------------------
// The scoped runners — ONE generic pass over both formats
// ---------------------------------------------------------------------------

// `searchNotePages` (`.note` pages) and `searchTxtSegments` (`.txt` paragraphs)
// are the SAME in-document keyset search — same `search_from_where`, per-range
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
/// `note_search_sql` / `txt_search_sql`.
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

/// The COMPLETE scoped read (fuzzy fallback path only): `note_search_sql` /
/// `txt_search_sql` VERBATIM, one `M1><` pass per document range in `runs`, all
/// rows in ordinal order. The exact path is batched by `runKeyset`; this stays
/// complete because the fuzzy fallback is a one-shot nicety, not a stream. Built
/// on `search_from_where` like every other read, so the `files` join it cannot
/// narrow is the same one; rows from disjoint ranges are re-ordered by ordinal
/// at the end so the caller still gets reading order.
fn runScoped(
    arena: std.mem.Allocator,
    db: sqlite.Db,
    comptime txt: bool,
    match: []const u8,
    user_id: u64,
    note_id: u64,
    runs: []const Range,
) ![]SegRow {
    var s = try db.prepare(if (txt) txt_search_sql else note_search_sql);
    defer s.finalize();
    s.bindText(1, match);
    s.bindInt(4, @intCast(user_id));
    s.bindInt(5, @intCast(note_id));

    var rows: std.ArrayList(SegRow) = .empty;
    for (runs) |r| {
        s.reset(); // retains the text/user/note bindings; only the bracket moves
        s.bindInt(2, r.lo);
        s.bindInt(3, r.hi);
        while (try s.step()) try rows.append(arena, try readSegRow(arena, s, txt));
    }
    // Each range came out ordinal-sorted; across ranges they interleave, so one
    // sort restores the single reading order the caller expects.
    if (runs.len > 1) std.sort.pdq(SegRow, rows.items, {}, segPageOrder);
    return rows.items;
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
/// algorithm — partition bounds, cursor decode, per-document range derivation,
/// the keyset scan, and the exact-then-fuzzy two-phase fallback (the doc's own
/// term pool, entry 8b) — is identical for `.note` and `.txt`; `txt` only picks
/// the SQL / row layout. The caller maps `Batch.rows` onto its wire shape.
const Batch = struct {
    query: []const u8,
    rows: []SegRow,
    terms: []const Term,
    used_fuzzy: bool = false,
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
    // reminted resumes nothing — the stream is honestly over, exactly as
    // `searchPages` treats it.
    var cursor_rid: ?i64 = null;
    const resumed = cursor != null;
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
    var terms = try queryTerms(arena, db, query, still_typing);
    var used_fuzzy = false;
    var next_cursor: ?[]const u8 = null;

    if (rows.len == 0 and !resumed) {
        // The exact term matches NOTHING anywhere in the document (the first
        // batch, scanning every range from the low bound, came back empty): only
        // now is the vocabulary scan paid for, exactly as on the library-wide
        // path. The fallback is a zero-hit nicety, not a stream — it returns the
        // document's fuzzy matches COMPLETE, in reading order, and hands out NO
        // cursor (letting a resumed page widen into near-misses would change what
        // `usedFuzzy` means mid-drain, as `searchPages` also refuses).
        //
        // The candidate pool is THIS DOCUMENT'S own terms (entry 8b), not the
        // corpus's: a correction absent from the document cannot match inside it,
        // so the doc pool is result-identical to the corpus pool for a scoped
        // search, at O(doc-terms) index seek instead of the O(corpus) scan. No
        // partition ⇒ no documents ⇒ nothing to expand against.
        if (part) |pid| {
            const src: VocabSource = .{ .doc = .{ .note_id = note_id, .user_id = user_id, .partition_id = pid } };
            if (try buildFuzzyMatch(arena, db, query, still_typing, max_fuzzy_terms, src)) |expansion| {
                used_fuzzy = true;
                rows = try runScoped(arena, db, txt, expansion.match, user_id, note_id, runs);
                terms = try withAlts(arena, terms, expansion.alts);
            }
        }
    } else if (rows.len > capped) {
        // More exact segments remain below this batch: the last KEPT row's rowid
        // is the resume point (encoded exactly as `searchPages`' cursor).
        next_cursor = try encodeCursor(arena, rows[@intCast(capped - 1)].rowid);
        rows = rows[0..@intCast(capped)];
    }

    return .{ .query = query, .rows = rows, .terms = terms, .used_fuzzy = used_fuzzy, .cursor = next_cursor };
}

/// `terms` widened by the vocabulary terms the fuzzy expansion spliced in.
///
/// The alternatives are EXACT, never prefixes: they are whole terms the index
/// already holds, so a `*` on them would widen past what the MATCH expression
/// itself accepted and circle words the count never counted.
fn withAlts(
    arena: std.mem.Allocator,
    terms: []const Term,
    alts: []const []const u8,
) ![]const Term {
    const out = try arena.alloc(Term, terms.len + alts.len);
    @memcpy(out[0..terms.len], terms);
    for (alts, out[terms.len..]) |alt, *t| t.* = .{ .term = alt, .prefix = false };
    return out;
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

/// Re-orders `rows` so that pages matching the user's terms EXACTLY come first.
///
/// Necessary because the expansion ORs the near-misses in alongside the original
/// term, and bm25 then scores them identically — it has no notion that one of
/// those terms is what the user actually typed. With a single-token query the
/// question cannot arise (the primary pass returned nothing, so nothing here
/// matched exactly), but a multi-token query reaches this path whenever ONE of
/// its words is misspelt, and then a page carrying the correctly-spelt words
/// must outrank one that only carries near-misses of them.
///
/// So the ordering is imposed rather than hoped for: each token is re-run on its
/// own, exactly as the primary pass would have written it, and rows are sorted
/// by how many tokens they matched exactly. The sort is STABLE, so bm25's order
/// survives inside each tier.
///
/// One extra query per token, each a bare index scan — acceptable under the same
/// small-library assumption documented above, and only on the zero-hit path.
fn rankExactFirst(
    arena: std.mem.Allocator,
    db: sqlite.Db,
    query: []const u8,
    still_typing: bool,
    lo: i64,
    hi: i64,
    rows: []Row,
) !void {
    if (rows.len < 2) return;
    const scores = try arena.alloc(u16, rows.len);
    @memset(scores, 0);

    var it = std.mem.tokenizeAny(u8, query, " \t\r\n");
    while (it.next()) |tok| {
        const prefix = still_typing and it.peek() == null and termLen(tok) >= min_prefix_len;
        // A token the tokenizer yields no terms for is not a MATCH expression at
        // all; it contributes no exactness either way.
        if (!hasTerm(tok)) continue;

        var expr: std.ArrayList(u8) = .empty;
        try appendToken(arena, &expr, tok, prefix);

        var s = try db.prepare(exact_rowids_sql);
        defer s.finalize();
        s.bindText(1, expr.items);
        s.bindInt(2, lo);
        s.bindInt(3, hi);
        var set: std.AutoHashMapUnmanaged(i64, void) = .empty;
        while (try s.step()) try set.put(arena, s.columnInt(0), {});
        for (rows, scores) |r, *sc| {
            if (set.contains(r.page_id)) sc.* += 1;
        }
    }

    // Insertion sort: stable by construction, and `rows.len <= max_limit`.
    var i: usize = 1;
    while (i < rows.len) : (i += 1) {
        const row = rows[i];
        const score = scores[i];
        var j = i;
        while (j > 0 and scores[j - 1] < score) : (j -= 1) {
            rows[j] = rows[j - 1];
            scores[j] = scores[j - 1];
        }
        rows[j] = row;
        scores[j] = score;
    }
}

/// Which SHARED text rows match one token exactly, scoped to the caller's
/// partition — the re-ranker compares against `Row.page_id`, so the segment
/// rowid is resolved back to its `note_page_index` row here.
const exact_rowids_sql =
    "SELECT s.segment_id FROM segment_fts " ++
    "JOIN segment_search s ON s.id = segment_fts.rowid " ++
    "WHERE segment_fts MATCH ?1 AND segment_fts.rowid BETWEEN ?2 AND ?3;";

/// The raw `q=`, trimmed and length-capped.
fn trimQuery(raw: []const u8) []const u8 {
    const t = std.mem.trim(u8, raw, " \t\r\n");
    return t[0..@min(t.len, max_query_len)];
}

/// Unicode codepoint count of `s`, tolerant of invalid UTF-8 (a bad lead byte
/// counts as one character). Used to measure a query against
/// `min_global_query_len` — "characters", so two CJK ideographs count as two,
/// not their six bytes.
fn charLen(s: []const u8) usize {
    var n: usize = 0;
    var i: usize = 0;
    while (i < s.len) {
        const l = std.unicode.utf8ByteSequenceLength(s[i]) catch 1;
        i += if (i + l > s.len) 1 else l;
        n += 1;
    }
    return n;
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

/// The delimiters `snippet()` is told to splice around each matched term, and
/// which `escapeSnippet` converts into real `<mark>` tags after escaping.
///
/// They are a per-search RANDOM nonce rather than a fixed marker, because the
/// text `snippet()` is quoting is device-authored: any fixed sentinel — `<mark>`
/// itself, a control character, a private-use codepoint — is something a
/// transcript could contain, and then the device chooses where the tags in its
/// own excerpt go. A value drawn after the text was stored cannot appear in it,
/// so "every tag in the output is one FTS5 inserted" is true by construction
/// instead of by assumption.
///
/// Plain lowercase hex: inert in SQL, inert in HTML, and nothing the `unicode61`
/// tokenizer or the snippet truncation can turn into markup if it is ever
/// truncated mid-sentinel.
const Marks = struct {
    /// Long enough that a collision with stored text is not worth reasoning
    /// about (64 bits per delimiter).
    open: [16]u8,
    close: [16]u8,

    fn init(io: std.Io) Marks {
        var raw: [16]u8 = undefined;
        var src: std.Random.IoSource = .{ .io = io };
        src.interface().bytes(&raw);
        const hex = std.fmt.bytesToHex(raw, .lower);
        return .{ .open = hex[0..16].*, .close = hex[16..32].* };
    }
};

/// HTML-escapes SQLite's snippet, then turns the sentinels into `<mark>` tags.
///
/// `snippet()` splices its delimiters into the raw stored transcript, which is
/// device-supplied text that may itself contain `<`, `&`, a whole `<script>` —
/// or the literal text `<mark>`. The frontend renders the excerpt as HTML (that
/// is the point of `<mark>`), so escaping has to happen somewhere; doing it here
/// means the value handed to the browser is safe by construction rather than by
/// the caller remembering.
///
/// The ORDER is what closes the gap: everything is escaped first, so any markup
/// the transcript carries is already inert text by the time the sentinels — the
/// only things in the string the device could not have written — are replaced.
fn escapeSnippet(arena: std.mem.Allocator, raw: []const u8, marks: Marks) ![]const u8 {
    var out: std.ArrayList(u8) = .empty;
    var i: usize = 0;
    while (i < raw.len) {
        if (std.mem.startsWith(u8, raw[i..], &marks.open)) {
            try out.appendSlice(arena, "<mark>");
            i += marks.open.len;
        } else if (std.mem.startsWith(u8, raw[i..], &marks.close)) {
            try out.appendSlice(arena, "</mark>");
            i += marks.close.len;
        } else {
            switch (raw[i]) {
                '<' => try out.appendSlice(arena, "&lt;"),
                '>' => try out.appendSlice(arena, "&gt;"),
                '&' => try out.appendSlice(arena, "&amp;"),
                '"' => try out.appendSlice(arena, "&quot;"),
                else => try out.append(arena, raw[i]),
            }
            i += 1;
        }
    }
    return out.items;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const testing = std.testing;
const schema = @import("../../db/schema.zig");
const blobstore = @import("../../store/blobs.zig");
const thumbstore = @import("../../store/thumbs.zig");
const filesvc = @import("../files.zig");
const noteindex = @import("../note_index.zig");
const sn = @import("supernote");
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

    /// Any file at all — bytes the indexer cannot parse as a `.note`.
    fn putBytes(f: *Fixture, user_id: u64, name: []const u8, bytes: []const u8) !u64 {
        var r = std.Io.Reader.fixed(bytes);
        const e = try f.files.putFile(user_id, null, name, &r, null);
        defer testing.allocator.free(e.name);
        if (e.md5) |m| testing.allocator.free(m);
        return e.id;
    }

    fn search(f: *Fixture, user_id: u64, q: []const u8) !Results {
        return searchPages(f.a(), testing.io, f.db, user_id, q, default_limit, null);
    }

    /// Page 2+ of a search: the same query resumed from a cursor.
    fn searchFrom(f: *Fixture, user_id: u64, q: []const u8, cursor: []const u8) !Results {
        return searchPages(f.a(), testing.io, f.db, user_id, q, default_limit, cursor);
    }

    /// A search that also reports whether the typo fallback ran. The report is
    /// now part of the response itself (`Results.usedFuzzy`); this stays as the
    /// out-param spelling the fallback tests read best in.
    fn searchTraced(f: *Fixture, user_id: u64, q: []const u8, used_fuzzy: *bool) !Results {
        const r = try f.search(user_id, q);
        used_fuzzy.* = r.usedFuzzy;
        return r;
    }

    /// Find-in-note DRAINED to completion: auto-continues the keyset (default
    /// batch) until the cursor is absent, accumulating every page — the client's
    /// auto-drain, so the many existing "complete result" assertions read the
    /// whole note through the batched entry point exactly as the browser will.
    /// `usedFuzzy` rides the first batch (the fuzzy fallback is a one-shot, no
    /// cursor). Uses a fresh child arena per batch so a giant drain does not
    /// retain every batch's scratch, then dupes the kept pages into the test
    /// arena.
    fn searchNote(f: *Fixture, user_id: u64, note_id: u64, q: []const u8) !NoteResults {
        return f.searchNoteBatched(user_id, note_id, q, default_batch);
    }

    /// The drainer with an explicit batch stride — lets a test force many small
    /// batches (the fairness / no-drop-across-boundary shape).
    fn searchNoteBatched(f: *Fixture, user_id: u64, note_id: u64, q: []const u8, batch: i64) !NoteResults {
        const arena = f.a();
        var pages: std.ArrayList(PageMatch) = .empty;
        var used_fuzzy = false;
        var query: []const u8 = q;
        var cursor: ?[]const u8 = null;
        var first = true;
        while (true) {
            const r = try searchNotePages(arena, f.db, user_id, note_id, q, cursor, batch);
            if (first) {
                used_fuzzy = r.usedFuzzy;
                query = r.query;
                first = false;
            }
            try pages.appendSlice(arena, r.pages);
            cursor = r.cursor orelse break;
        }
        return .{ .query = query, .pages = pages.items, .usedFuzzy = used_fuzzy };
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
    // file, and never as the other's.
    const alice = try f.search(1, "salary");
    try testing.expectEqual(@as(usize, 1), alice.hits.len);
    try testing.expectEqualStrings("alice.note", alice.hits[0].noteName);

    const bob = try f.search(2, "salary");
    try testing.expectEqual(@as(usize, 1), bob.hits.len);
    try testing.expectEqualStrings("bob.note", bob.hits[0].noteName);

    // A user with no files at all sees nothing, though the text is right there.
    try testing.expectEqual(@as(i64, 2), try f.count(
        "SELECT COUNT(*) FROM segment_fts WHERE segment_fts MATCH 'salary';",
    ));
    const nobody = try f.search(3, "salary");
    try testing.expectEqual(@as(usize, 0), nobody.hits.len);

    // Purge by one owner leaves the other's row (and hit) untouched.
    try f.files.trash(1, a_id);
    try f.files.purge(1, a_id);
    try testing.expectEqual(@as(i64, 1), try f.count("SELECT COUNT(*) FROM segment_search;"));
    try testing.expectEqual(@as(i64, 1), try f.count("SELECT COUNT(*) FROM note_page_index;"));
    try testing.expectEqual(@as(usize, 0), (try f.search(1, "salary")).hits.len);
    try testing.expectEqual(@as(usize, 1), (try f.search(2, "salary")).hits.len);
    try f.db.exec("INSERT INTO segment_fts(segment_fts) VALUES('integrity-check');");
}

test "a trashed note stops appearing, even though the blob and its text survive" {
    var f = try Fixture.init();
    defer f.deinit();

    const keep = try f.putNote(1, "keep.note", &.{"quarterly roadmap"});
    const drop = try f.putNote(1, "drop.note", &.{"quarterly roadmap"});
    _ = keep;
    try testing.expectEqual(@as(usize, 2), (try f.search(1, "roadmap")).hits.len);

    try f.files.trash(1, drop);

    // The tombstone hides the file; the blob is still referenced by keep.note, so
    // the md5-keyed text is untouched. Only the join makes the hit disappear —
    // one owner, one blob, so ONE posting doc however many files point at it.
    try testing.expectEqual(@as(i64, 1), try f.count("SELECT COUNT(*) FROM blobs;"));
    try testing.expectEqual(@as(i64, 1), try f.count(
        "SELECT COUNT(*) FROM segment_fts WHERE segment_fts MATCH 'roadmap';",
    ));
    const after = try f.search(1, "roadmap");
    try testing.expectEqual(@as(usize, 1), after.hits.len);
    try testing.expectEqualStrings("keep.note", after.hits[0].noteName);

    // Restoring puts it straight back into the results — a flag flip, no
    // re-parse: the md5-keyed index never went anywhere.
    const restored = try f.files.restore(1, drop);
    defer restored.deinit(testing.allocator);
    try testing.expectEqualStrings("drop.note", restored.name);
    try testing.expectEqual(@as(usize, 2), (try f.search(1, "roadmap")).hits.len);

    // Purge both for real: now the last reference goes and the text with it.
    try f.files.trash(1, drop);
    try f.files.purge(1, drop);
    try f.files.trash(1, 1);
    try f.files.purge(1, 1);
    try testing.expectEqual(@as(i64, 0), try f.count("SELECT COUNT(*) FROM blobs;"));
    try testing.expectEqual(@as(usize, 0), (try f.search(1, "roadmap")).hits.len);
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

    // The index and its FTS entry survive with the blob, so bob can still search.
    try testing.expectEqual(@as(i64, 1), try f.count("SELECT COUNT(*) FROM note_index;"));
    try testing.expectEqual(@as(i64, 1), try f.ftsRows());
    const bob = try f.search(2, "expedition");
    try testing.expectEqual(@as(usize, 1), bob.hits.len);
    try testing.expectEqualStrings("bob.note", bob.hits[0].noteName);

    // Alice is gone: her row, and with it any route back to that text.
    try testing.expectEqual(@as(i64, 0), try f.count("SELECT COUNT(*) FROM files WHERE user_id = 1;"));
    try testing.expectEqual(@as(usize, 0), (try f.search(1, "expedition")).hits.len);

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
    try testing.expectEqual(@as(usize, 1), (try f.search(2, "duplicated")).hits.len);

    // And user 2 dropping their last reference really does reap it.
    try f.files.purgeUser(2);
    try testing.expectEqual(@as(i64, 0), try f.count("SELECT COUNT(*) FROM blobs;"));
}

test "only finished recognition is searchable: unrecognised and still-running pages never appear" {
    var f = try Fixture.init();
    defer f.deinit();

    _ = try f.putSpec(1, "mixed.note", .{
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
    _ = try f.putSpec(1, "plain.note", .{ .pages = &.{
        .{ .layers = &.{.{ .slot = .main, .bitmap = "DDDD" }} },
    } });

    try testing.expectEqual(@as(i64, 4), try f.count("SELECT COUNT(*) FROM note_page_index;"));
    try testing.expectEqual(@as(i64, 1), try f.ftsRows()); // only the finished page

    const hits = (try f.search(1, "findable")).hits;
    try testing.expectEqual(@as(usize, 1), hits.len);
    try testing.expectEqualStrings("mixed.note", hits[0].noteName);
    try testing.expectEqual(@as(i64, 0), hits[0].pageIndex);

    // Nothing matches the un-recognised pages' names, and a term nobody wrote
    // matches nothing at all.
    try testing.expectEqual(@as(usize, 0), (try f.search(1, "plain")).hits.len);
}

test "snippet marks the match, and diacritics fold both ways" {
    var f = try Fixture.init();
    defer f.deinit();

    _ = try f.putNote(1, "pt.note", &.{"a reunião de avaliação está marcada"});

    // The whole point of `remove_diacritics 2`: unaccented typing finds accented text.
    for ([_][]const u8{ "avaliacao", "avaliação", "AVALIACAO", "reuniao" }) |q| {
        const hits = (try f.search(1, q)).hits;
        try testing.expectEqual(@as(usize, 1), hits.len);
        try testing.expect(std.mem.indexOf(u8, hits[0].snippet, "<mark>") != null);
        try testing.expect(std.mem.indexOf(u8, hits[0].snippet, "</mark>") != null);
    }

    // The marked term is the one that matched, and the surrounding text survives.
    const hits = (try f.search(1, "avaliacao")).hits;
    try testing.expect(std.mem.indexOf(u8, hits[0].snippet, "<mark>avaliação</mark>") != null);
    try testing.expect(std.mem.indexOf(u8, hits[0].snippet, "reunião") != null);

    // Multiple words are AND-ed: both present matches, one absent does not.
    try testing.expectEqual(@as(usize, 1), (try f.search(1, "reuniao marcada")).hits.len);
    try testing.expectEqual(@as(usize, 0), (try f.search(1, "reuniao cancelada")).hits.len);
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
    try testing.expectEqual(@as(usize, 1), (try f.search(1, "transcript")).hits.len);
    try f.db.exec("INSERT INTO segment_fts(segment_fts) VALUES('integrity-check');");
}

test "a page whose text CHANGES under re-index drops the old terms and gains the new" {
    var f = try Fixture.init();
    defer f.deinit();

    _ = try f.putNote(1, "n.note", &.{"before"});
    try testing.expectEqual(@as(usize, 1), (try f.search(1, "before")).hits.len);

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

    try testing.expectEqual(@as(usize, 0), (try f.search(1, "before")).hits.len);
    try testing.expectEqual(@as(usize, 1), (try f.search(1, "after")).hits.len);
    try f.db.exec("INSERT INTO segment_fts(segment_fts) VALUES('integrity-check');");
}

test "hostile and empty queries are inert, never syntax errors" {
    var f = try Fixture.init();
    defer f.deinit();
    _ = try f.putNote(1, "n.note", &.{"alpha beta gamma"});

    // Empty / whitespace / punctuation-only → no hits, no error, no match-all.
    for ([_][]const u8{ "", "   ", "\t\n", "!!!", "*", "-" }) |q| {
        try testing.expectEqual(@as(usize, 0), (try f.search(1, q)).hits.len);
    }

    // FTS5 operators and quotes are literals, not syntax: none of these blow up,
    // and none of them match-all either.
    for ([_][]const u8{ "\"", "alpha OR zeta", "alpha AND zeta", "NEAR(alpha zeta)", "(alpha", "alpha*" }) |q| {
        const r = try f.search(1, q);
        _ = r; // reaching here at all is the assertion: no error was raised
    }
    // `OR` really is a literal — "alpha OR zeta" needs the word "or" and "zeta".
    try testing.expectEqual(@as(usize, 0), (try f.search(1, "alpha OR zeta")).hits.len);
    try testing.expectEqual(@as(usize, 1), (try f.search(1, "alpha")).hits.len);

    // An over-long query is truncated rather than passed through.
    const long = try testing.allocator.alloc(u8, max_query_len * 4);
    defer testing.allocator.free(long);
    @memset(long, 'z');
    const r = try f.search(1, long);
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

    // The live-session case, verbatim: an accented transcript, typed unaccented.
    _ = try f.putNote(1, "cal.note", &.{"Test Caligrafia Será que isso funciona?"});
    _ = try f.putNote(1, "other.note", &.{"calendar entry for Serão"});

    // The bug: every keystroke on the way to the whole word must find the page.
    // "ca" is BELOW the global floor (`min_global_query_len`), so the walk starts
    // at the first keystroke the library route actually searches — three chars.
    for ([_][]const u8{ "cal", "calig", "caligraf", "caligrafia" }) |q| {
        const hits = (try f.search(1, q)).hits;
        try testing.expect(hits.len >= 1);
        var found = false;
        for (hits) |h| found = found or std.mem.eql(u8, h.noteName, "cal.note");
        try testing.expect(found);
    }
    // `calig` discriminates; `cal` is a prefix of both notes' words.
    try testing.expectEqual(@as(usize, 1), (try f.search(1, "calig")).hits.len);
    try testing.expectEqual(@as(usize, 2), (try f.search(1, "cal")).hits.len);

    // Accented typing behaves identically — `remove_diacritics 2` folds a
    // prefix exactly as it folds a whole word, in both directions.
    try testing.expectEqual(@as(usize, 2), (try f.search(1, "ser")).hits.len); // Será + Serão
    try testing.expectEqual(@as(usize, 2), (try f.search(1, "sér")).hits.len); // same, accented
    try testing.expectEqual(@as(usize, 1), (try f.search(1, "sera ")).hits.len); // exact word
    try testing.expectEqual(@as(usize, 1), (try f.search(1, "será ")).hits.len); // same, accented
    try testing.expectEqual(@as(usize, 1), (try f.search(1, "calí")).hits.len); // accented prefix

    // A TRAILING SPACE means the word is finished: no prefix, so a half-word
    // that is not itself a term stops matching.
    try testing.expectEqual(@as(usize, 0), (try f.search(1, "calig ")).hits.len);
    try testing.expectEqual(@as(usize, 0), (try f.search(1, "cal ")).hits.len);
    // …while a word that IS a term still matches with the space.
    try testing.expectEqual(@as(usize, 1), (try f.search(1, "caligrafia ")).hits.len);

    // Only the LAST token is a prefix: "funciona" is exact, "cal" is open.
    try testing.expectEqual(@as(usize, 1), (try f.search(1, "funciona cal")).hits.len);
    // "func" as a non-final token is exact, so it matches nothing.
    try testing.expectEqual(@as(usize, 0), (try f.search(1, "func caligrafia")).hits.len);

    // Below the floor, a single character is not expanded: it does not drag in
    // the whole index.
    try testing.expectEqual(@as(usize, 0), (try f.search(1, "c")).hits.len);

    // Ranking stays sensible on a mixed exact+prefix query: the note matching
    // both terms outranks the one matching only the prefix.
    _ = try f.putNote(1, "both.note", &.{"funciona caligrafia twice funciona"});
    const mixed = (try f.search(1, "funciona calig")).hits;
    try testing.expectEqual(@as(usize, 2), mixed.len);
    try testing.expectEqualStrings("both.note", mixed[0].noteName);
}

test "the global-search floor is defense-in-depth: gated library-wide, exempt in-doc" {
    var f = try Fixture.init();
    defer f.deinit();
    const id = try f.putNote(1, "n.note", &.{"ok the plan is set"});

    // BELOW THE FLOOR, LIBRARY-WIDE: a 2-char global query returns empty — no
    // hits and no cursor — without paying for the vocabulary/coverage scan. This
    // mirrors the frontend gate; the route must not run a search the box would
    // never have sent (`min_global_query_len`).
    const global = try f.search(1, "ok");
    try testing.expectEqual(@as(usize, 0), global.hits.len);
    try testing.expect(global.cursor == null);

    // THE SAME 2-CHAR STRING, IN A DOCUMENT: find-in-note is EXEMPT and finds the
    // word. Once a file is open you can search a short string inside it, and there
    // is no library-wide cost to gate against — so the floor stops here, at the
    // one library-wide entry, and never at the in-doc ones.
    const indoc = try f.searchNote(1, id, "ok");
    try testing.expectEqual(@as(usize, 1), indoc.pages.len);
}

test "a prefixed operator word is inert too: no rows, and no syntax error" {
    var f = try Fixture.init();
    defer f.deinit();
    _ = try f.putNote(1, "n.note", &.{"alpha beta gamma"});

    // The prefix rides OUTSIDE the quotes, so the quoting still neutralises
    // everything: each of these is a prefix search for a literal word.
    for ([_][]const u8{ "OR", "AND", "NOT", "NEAR", "NEAR(alpha", "alpha OR", "alpha NEAR", "\"\"", "**" }) |q| {
        const r = try f.search(1, q); // reaching here at all is the assertion
        try testing.expectEqual(@as(usize, 0), r.hits.len);
    }
    // A `*` the user typed is punctuation to `unicode61`, so `alpha*` searches
    // for the word "alpha" — it never becomes the operator itself.
    try testing.expectEqual(@as(usize, 1), (try f.search(1, "alpha*")).hits.len);
    // `omega` has no near neighbour in this corpus, so it stays empty even with
    // the typo fallback behind it. (`zeta*` deliberately does NOT belong here any
    // more: "zeta" is one edit from the indexed "beta", so the fallback finding
    // it is the feature working, not the `*` leaking through as an operator.)
    try testing.expectEqual(@as(usize, 0), (try f.search(1, "omega*")).hits.len);
    // And the same words with the prefix suppressed by a trailing space.
    for ([_][]const u8{ "OR ", "NEAR ", "alpha OR " }) |q| {
        try testing.expectEqual(@as(usize, 0), (try f.search(1, q)).hits.len);
    }
    // `alph` is a real prefix of a real term, proving the above are inert
    // because the words are absent rather than because prefixing is broken.
    try testing.expectEqual(@as(usize, 1), (try f.search(1, "alph")).hits.len);
}

test "the snippet is HTML-escaped apart from its own <mark> markers" {
    var f = try Fixture.init();
    defer f.deinit();

    // Device-supplied transcript containing markup. The frontend renders the
    // excerpt as HTML, so this must come back inert.
    _ = try f.putNote(1, "xss.note", &.{"needle <script>alert(1)</script> & co"});

    const hits = (try f.search(1, "needle")).hits;
    try testing.expectEqual(@as(usize, 1), hits.len);
    try testing.expect(std.mem.indexOf(u8, hits[0].snippet, "<mark>needle</mark>") != null);
    try testing.expect(std.mem.indexOf(u8, hits[0].snippet, "<script>") == null);
    try testing.expect(std.mem.indexOf(u8, hits[0].snippet, "&lt;script&gt;") != null);
    try testing.expect(std.mem.indexOf(u8, hits[0].snippet, "&amp; co") != null);
}

test "a transcript containing <mark> cannot inject a tag into its own snippet" {
    var f = try Fixture.init();
    defer f.deinit();

    // Device-authored text that impersonates the highlight delimiters. The
    // frontend renders this field with innerHTML, so only the tags FTS5 itself
    // inserted may survive as markup.
    _ = try f.putNote(1, "inject.note", &.{"needle <mark>forged</mark> tail"});

    const hits = (try f.search(1, "needle")).hits;
    try testing.expectEqual(@as(usize, 1), hits.len);
    const s = hits[0].snippet;

    // The genuine highlight is a real tag…
    try testing.expect(std.mem.indexOf(u8, s, "<mark>needle</mark>") != null);
    // …and the transcript's own is ordinary escaped text.
    try testing.expect(std.mem.indexOf(u8, s, "&lt;mark&gt;forged&lt;/mark&gt;") != null);
    // Exactly one real pair survives: the one `snippet()` put there.
    try testing.expectEqual(@as(usize, 1), std.mem.count(u8, s, "<mark>"));
    try testing.expectEqual(@as(usize, 1), std.mem.count(u8, s, "</mark>"));
}

test "results carry the file id and page index needed to open the hit, ranked and capped" {
    var f = try Fixture.init();
    defer f.deinit();

    // TWO documents, not two pages of one: a page of results names documents,
    // so "two hits" has to come from two files. The match sits on page 2 of the
    // first, so `pageIndex` is a real coordinate here and not always 0.
    _ = try f.putSpec(1, "many.note", .{ .pages = &.{
        .{ .layers = &.{.{ .slot = .main, .bitmap = "AAAA" }}, .recogn_status = 1, .recogn_labels = &.{"nothing here"} },
        .{ .layers = &.{.{ .slot = .main, .bitmap = "BBBB" }}, .recogn_status = 1, .recogn_labels = &.{"still nothing"} },
        .{ .layers = &.{.{ .slot = .main, .bitmap = "CCCC" }}, .recogn_status = 1, .recogn_labels = &.{"target three"} },
    } });
    _ = try f.putNote(1, "other.note", &.{"target one"});

    const r = try f.search(1, "target");
    try testing.expectEqualStrings("target", r.query);
    try testing.expectEqual(@as(usize, 2), r.hits.len);
    // Two documents, two rows — and each carries the page that opens it.
    try testing.expect(!std.mem.eql(u8, r.hits[0].noteId, r.hits[1].noteId));
    const many = hitNamed(r.hits, "many.note").?;
    try testing.expectEqual(@as(i64, 2), many.pageIndex);
    try testing.expectEqual(@as(i64, 0), hitNamed(r.hits, "other.note").?.pageIndex);

    // The id is the FILE id, resolvable through the normal note endpoints.
    const id = try std.fmt.parseInt(u64, many.noteId, 10);
    const entry = (try f.files.get(1, id)).?;
    defer testing.allocator.free(entry.name);
    defer if (entry.md5) |m| testing.allocator.free(m);
    try testing.expectEqualStrings("many.note", entry.name);

    // The limit is honoured and clamped — counting DOCUMENTS.
    try testing.expectEqual(@as(usize, 1), (try searchPages(f.a(), testing.io, f.db, 1, "target", 1, null)).hits.len);
    try testing.expectEqual(@as(usize, 0), (try searchPages(f.a(), testing.io, f.db, 1, "target", 0, null)).hits.len);
    try testing.expectEqual(@as(usize, 2), (try searchPages(f.a(), testing.io, f.db, 1, "target", 1_000_000, null)).hits.len);
}

// ---------------------------------------------------------------------------
// Tests — partitioning, keyset pagination, and the version-flip lifecycle
// ---------------------------------------------------------------------------

test "PLAN PIN: both partition bounds are pushed into the FTS index (M1><)" {
    var f = try Fixture.init();
    defer f.deinit();
    _ = try f.putNote(1, "n.note", &.{"alpha"});

    // The trailing `><` in FTS5's virtual-table index string is both range
    // bounds claimed BY the FTS index — the partition pushed into the scan,
    // not filtered after it. If this string ever changes, early termination
    // has silently regressed to an install-wide scan.
    var s = try f.db.prepare("EXPLAIN QUERY PLAN " ++ search_sql);
    defer s.finalize();
    var pinned = false;
    while (try s.step()) {
        const detail = s.columnText(3);
        if (std.mem.indexOf(u8, detail, "segment_fts") != null and
            std.mem.indexOf(u8, detail, "M1><") != null) pinned = true;
    }
    try testing.expect(pinned);
}

test "keyset: page 2 resumes exactly, stable under concurrent ingest, and the stream ends without a cursor" {
    var f = try Fixture.init();
    defer f.deinit();

    // THIRTY NOTES, one matching page each. The stream pages DOCUMENTS, so 30
    // results means 30 documents — where this fixture used to be one 30-page
    // note, which conflated "many pages" with "many results". That conflation is
    // exactly what the document loop removes; what the test is about (a keyset
    // resuming exactly across 30 results) is unchanged.
    const ids = try f.putNotes(1, "n", 30, "target");

    const p1 = try f.search(1, "target ");
    try testing.expectEqual(@as(usize, 20), p1.hits.len);
    try testing.expect(p1.cursor != null);

    // Concurrent ingest between the pages: the new note mints HIGHER
    // sequences, so the open cursor's window cannot shift under the reader.
    _ = try f.putNote(1, "mid-stream.note", &.{"target arrives late"});

    const p2 = try f.searchFrom(1, "target ", p1.cursor.?);
    try testing.expectEqual(@as(usize, 10), p2.hits.len);
    try testing.expect(p2.cursor == null); // the stream is over — said by absence
    for (p2.hits) |h| try testing.expect(!std.mem.eql(u8, h.noteName, "mid-stream.note"));

    // Exact resumption: the two pages partition the 30 matching documents — no
    // overlap, nothing skipped.
    var found = [_]bool{false} ** 30;
    for ([_][]const Hit{ p1.hits, p2.hits }) |hits| {
        for (hits) |h| {
            const at = std.mem.indexOfScalar(u64, ids, try std.fmt.parseInt(u64, h.noteId, 10)).?;
            try testing.expect(!found[at]);
            found[at] = true;
        }
    }
    for (found) |seen| try testing.expect(seen);

    // A FRESH page 1 does see the mid-stream note — recency selection.
    const fresh = try f.search(1, "target ");
    var has_new = false;
    for (fresh.hits) |h| has_new = has_new or std.mem.eql(u8, h.noteName, "mid-stream.note");
    try testing.expect(has_new);

    // Resuming past the end answers emptiness, never an error and never fuzz.
    const drained = try f.searchFrom(1, "target ", try encodeCursor(f.a(), partition.base((try partition.active(f.db, 1)).?)));
    try testing.expectEqual(@as(usize, 0), drained.hits.len);
    try testing.expect(!drained.usedFuzzy);
}

test "the cursor rides the wire only when more may exist, is validated on the way in, and cannot cross partitions" {
    var f = try Fixture.init();
    defer f.deinit();
    // 25 DOCUMENTS — the stream's unit (see the keyset test above).
    _ = try f.putNotes(1, "n", 25, "target");
    _ = try f.putNote(2, "theirs.note", &.{"target secret"});

    // More exists → cursor present on the wire; NO total anywhere.
    const r = try f.search(1, "target ");
    try testing.expectEqual(@as(usize, 20), r.hits.len);
    const body = try std.json.Stringify.valueAlloc(testing.allocator, r, .{ .emit_null_optional_fields = false });
    defer testing.allocator.free(body);
    try testing.expect(std.mem.indexOf(u8, body, "\"cursor\":\"") != null);
    try testing.expect(std.mem.indexOf(u8, body, "total") == null);

    // The stream's last page omits the field entirely — absence IS the signal.
    const done = try f.searchFrom(1, "target ", r.cursor.?);
    try testing.expectEqual(@as(usize, 5), done.hits.len);
    try testing.expect(done.cursor == null);
    const done_body = try std.json.Stringify.valueAlloc(testing.allocator, done, .{ .emit_null_optional_fields = false });
    defer testing.allocator.free(done_body);
    try testing.expect(std.mem.indexOf(u8, done_body, "cursor") == null);

    // Garbage is refused loudly (the handler answers 400)…
    try testing.expectError(error.InvalidCursor, f.searchFrom(1, "target ", "not-hex!"));
    try testing.expectError(error.InvalidCursor, f.searchFrom(1, "target ", "00010001000100010001"));

    // …and a syntactically valid cursor pointing at SOMEONE ELSE'S partition
    // resumes nothing: the partition check ends the stream, and even without
    // it the range/join could return only the caller's own rows.
    const p2 = (try partition.active(f.db, 2)).?;
    const forged = try encodeCursor(f.a(), partition.rowidOf(p2, 999));
    const crossed = try f.searchFrom(1, "target ", forged);
    try testing.expectEqual(@as(usize, 0), crossed.hits.len);
}

// ---------------------------------------------------------------------------
// Tests — the document loop: one hit per band, and the guarded jump past it
// ---------------------------------------------------------------------------

test "THE OWNING-DOCUMENT TEST: a 40-page match is ONE row, and the notes it used to bury are on the same page" {
    var f = try Fixture.init();
    defer f.deinit();

    // The reported bug, reproduced exactly. Five small notes go in FIRST, then
    // the planner — so the planner owns the newest (highest) rowids and the
    // recency-ordered scan reaches its band before anything else. Its 40
    // matching pages used to fill the whole 20-row page twice over, and the
    // client groups hits by note, so the user saw ONE row, clicked "More", and
    // got the same one row again: "no results yet" meant "no OTHER documents".
    const small = try f.putNotes(1, "small", 5, "target");
    const planner = try f.putPages(1, "planner.note", 40, &.{"target"});

    const r = try f.search(1, "target ");

    // Six documents, six rows — the planner contributes exactly one.
    try testing.expectEqual(@as(usize, 6), r.hits.len);
    var planner_hits: usize = 0;
    for (r.hits) |h| {
        if (std.mem.eql(u8, h.noteName, "planner.note")) planner_hits += 1;
    }
    try testing.expectEqual(@as(usize, 1), planner_hits);

    // And every note the planner used to bury is on the SAME page, not pages
    // deep behind a "More results" control.
    for (0..small.len) |i| {
        const name = try std.fmt.allocPrint(f.a(), "small{d:0>2}.note", .{i});
        try testing.expect(hitNamed(r.hits, name) != null);
    }
    // Six is everything there is, so the stream is over and says so.
    try testing.expect(r.cursor == null);

    // Completeness did not vanish, it MOVED: in-doc still has all 40 pages, and
    // is now the only thing claiming to know that number.
    try testing.expectEqual(@as(usize, 40), (try f.searchNote(1, planner, "target ")).pages.len);
}

test "THE JUMP NEVER SKIPS A NEIGHBOUR: the band below an emitted one is still reached" {
    var f = try Fixture.init();
    defer f.deinit();

    // Two multi-page bands laid down back to back, so the second band's LAST
    // rowid is exactly one below the first band's start: there is no gap for a
    // sloppy jump to land in harmlessly. An off-by-one in `bandStart` swallows
    // `first.note` whole and says nothing.
    const first = try f.putLabeled(1, "first.note", &.{ "target a0", "target a1", "target a2" });
    const second = try f.putLabeled(1, "second.note", &.{ "target b0", "target b1", "target b2" });

    const fi = try f.noteSegIds(first);
    const si = try f.noteSegIds(second);
    try testing.expectEqual(fi[fi.len - 1] + 1, si[0]); // genuinely adjacent

    const r = try f.search(1, "target ");
    try testing.expectEqual(@as(usize, 2), r.hits.len);
    // Each named once, each on its own last matching page (rowid DESC within
    // the band), and the older band is NOT swallowed by the newer one's jump.
    try testing.expectEqual(@as(i64, 2), hitNamed(r.hits, "first.note").?.pageIndex);
    try testing.expectEqual(@as(i64, 2), hitNamed(r.hits, "second.note").?.pageIndex);
}

test "A NON-CANONICAL BAND DEGRADES TO A STEP: an appended page's fresh tail rowid never skips its neighbours" {
    var f = try Fixture.init();
    defer f.deinit();

    // `doc.note` (6 matching pages), then three separate notes ABOVE its band.
    const doc = try f.putLabeled(1, "doc.note", &.{
        "target p0", "target p1", "target p2", "target p3", "target p4", "target p5",
    });
    _ = try f.putNotes(1, "mid", 3, "target");
    const md5 = try f.noteMd5(doc);

    // A later re-parse finds a SEVENTH page. `mintPageForHolders` gives it a
    // FRESH TAIL rowid — above everything, with no arithmetic relation to its
    // `page_index` of 6. Unguarded, `R - page_index` would land inside the
    // original band and the jump would step over all three `mid` notes AND the
    // rest of `doc`'s own band, losing four results without a word.
    {
        var s = try f.db.prepare(
            "INSERT INTO note_page_index(blob_md5, page_index, content_hash, width, height, layers, recogn_status, text) " ++
                "VALUES(?1, 6, 'appended', 0, 0, x'', 1, ?2);",
        );
        defer s.finalize();
        s.bindText(1, md5);
        s.bindText(2, "target appended later");
        _ = try s.step();
    }
    try maintain.mintPageForHolders(f.db, md5, 6, 0);

    const appended = try f.noteSegRowid(doc, 6);
    const band = try f.noteSegIds(doc);
    try testing.expect(appended > band[0] + 6); // genuinely out of band

    const r = try f.search(1, "target ");

    // The guard refused the jump and stepped by one instead, so nothing below
    // the appended page was skipped: all three `mid` notes are here.
    for (0..3) |i| {
        const name = try std.fmt.allocPrint(f.a(), "mid{d:0>2}.note", .{i});
        try testing.expect(hitNamed(r.hits, name) != null);
    }
    // `doc.note` surfaces twice — the appended page is its own one-page run, and
    // the original band is a second. That is the documented cost of the
    // degraded path (the client merges by note id), never a lost result.
    var doc_hits: usize = 0;
    for (r.hits) |h| {
        if (std.mem.eql(u8, h.noteName, "doc.note")) doc_hits += 1;
    }
    try testing.expectEqual(@as(usize, 2), doc_hits);
    try testing.expectEqual(@as(usize, 5), r.hits.len);
}

test "KEYSET ACROSS THE JUMP: page 2 resumes below the last band, with no repeat and no gap" {
    var f = try Fixture.init();
    defer f.deinit();

    const a = try f.putLabeled(1, "a.note", &.{ "target a0", "target a1", "target a2" });
    const b = try f.putLabeled(1, "b.note", &.{ "target b0", "target b1", "target b2" });
    const c = try f.putLabeled(1, "c.note", &.{ "target c0", "target c1", "target c2" });
    _ = a;
    _ = c;

    // Two DOCUMENTS per page, so the boundary falls in the middle of the stream
    // rather than at its end.
    const p1 = try searchPages(f.a(), testing.io, f.db, 1, "target ", 2, null);
    try testing.expectEqual(@as(usize, 2), p1.hits.len);
    try testing.expect(p1.cursor != null);

    // The cursor is the JUMP TARGET — the start of the last emitted band — not
    // the last kept row. That is what makes page 2 resume below the whole band
    // instead of walking back through its remaining pages.
    try testing.expectEqual((try f.noteSegIds(b))[0], decodeCursor(p1.cursor.?).?);

    const p2 = try searchPages(f.a(), testing.io, f.db, 1, "target ", 2, p1.cursor.?);
    try testing.expectEqual(@as(usize, 1), p2.hits.len);
    try testing.expect(p2.cursor == null); // exhausted, said by absence

    // The two pages partition the three documents: nothing twice, nothing lost.
    for ([_][]const u8{ "a.note", "b.note", "c.note" }) |name| {
        const in_p1 = hitNamed(p1.hits, name) != null;
        const in_p2 = hitNamed(p2.hits, name) != null;
        try testing.expect(in_p1 != in_p2);
    }
}

test "FANOUT: two files of one blob both surface from the single band they share" {
    var f = try Fixture.init();
    defer f.deinit();

    // A copy of a notebook is the SAME content, so it deduplicates to one blob
    // and one segment band — but it is a second library entry, and a hit on the
    // shared page belongs to both. The loop therefore takes every row at the
    // matched rowid BEFORE it jumps; taking only the first would drop a real
    // file, and jumping first would drop it silently.
    const spec: nb.Spec = .{ .pages = &.{
        .{ .layers = &.{.{ .slot = .main, .bitmap = "AAAA" }}, .recogn_status = 1, .recogn_labels = &.{"target one"} },
        .{ .layers = &.{.{ .slot = .main, .bitmap = "BBBB" }}, .recogn_status = 1, .recogn_labels = &.{"target two"} },
    } };
    _ = try f.putSpec(1, "original.note", spec);
    _ = try f.putSpec(1, "copy.note", spec);
    _ = try f.putNote(1, "other.note", &.{"target elsewhere"});

    // One band for the shared blob (segment rows are per owner×segment), plus
    // the single page of `other.note`.
    try testing.expectEqual(@as(i64, 3), try f.count("SELECT COUNT(*) FROM segment_search;"));

    const r = try f.search(1, "target ");
    try testing.expectEqual(@as(usize, 3), r.hits.len);
    const original = hitNamed(r.hits, "original.note").?;
    const copy = hitNamed(r.hits, "copy.note").?;
    // Both files, at the SAME page — one segment, fanned out by the `files`
    // join — and they are different library entries.
    try testing.expectEqual(original.pageIndex, copy.pageIndex);
    try testing.expect(!std.mem.eql(u8, original.noteId, copy.noteId));
    // And the jump past the shared band still left the next document reachable.
    try testing.expect(hitNamed(r.hits, "other.note") != null);
}

test "MASK FOR SPEED, JOIN FOR CORRECTNESS: a forged segment row cannot cross users" {
    var f = try Fixture.init();
    defer f.deinit();

    _ = try f.putNote(2, "secret.note", &.{"classified dossier"});
    _ = try f.putNote(1, "mine.note", &.{"my own words"});

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
    const leak = try f.search(1, "classified");
    try testing.expectEqual(@as(usize, 0), leak.hits.len);
    // (usedFuzzy may be true — the fallback ran and found nothing extra —
    // exactly the pre-partition behaviour for a term in someone else's notes.)

    // The rightful owner still finds it, and their own search is untouched.
    const theirs = try f.search(2, "classified");
    try testing.expectEqual(@as(usize, 1), theirs.hits.len);
    try testing.expectEqualStrings("secret.note", theirs.hits[0].noteName);
}

test "THE RE-MINT TEST: a 100-page flip with one edited page re-mints the whole band CONTIGUOUS in page order" {
    var f = try Fixture.init();
    defer f.deinit();

    var labels: [100][]const u8 = undefined;
    for (&labels, 0..) |*l, i| l.* = try std.fmt.allocPrint(f.a(), "word{d} common", .{i});
    _ = try f.putLabeled(1, "big.note", &labels);

    var max_before: i64 = 0;
    for (0..100) |i| max_before = @max(max_before, try f.segRowid(1, @intCast(i)));

    // The new VERSION: same note, page 5 edited. Content addressing makes it a
    // new blob; the whole-doc-band re-mint drops the owner's old band and mints
    // the new pages afresh in page order — `rowid ASC == page order` by
    // construction, so no edited page can land at a tail rowid out of order.
    labels[5] = try std.fmt.allocPrint(f.a(), "edited fresh common", .{});
    _ = try f.putLabeled(1, "big.note", &labels);

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
    const hit = try f.search(1, "edited ");
    try testing.expectEqual(@as(usize, 1), hit.hits.len);
    try testing.expectEqual(@as(i64, 5), hit.hits[0].pageIndex);
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

    const gamma = try f.search(1, "gamma");
    try testing.expectEqual(@as(usize, 1), gamma.hits.len);
    try testing.expectEqual(@as(i64, 0), gamma.hits[0].pageIndex);
    try f.db.exec("INSERT INTO segment_fts(segment_fts) VALUES('integrity-check');");
}

test "an inserted page re-mints the whole band so rowid ASC stays page order" {
    var f = try Fixture.init();
    defer f.deinit();

    _ = try f.putLabeled(1, "n.note", &.{ "alpha", "omega" });
    _ = try f.putLabeled(1, "n.note", &.{ "alpha", "inserted", "omega" });

    // The insert shifts omega from page 1 to page 2; the whole band re-mints in
    // page order, so the inserted page lands BETWEEN alpha and omega (not at a
    // tail rowid) — the coordinate follows position, not arrival.
    const a_row = try f.segRowidByText(1, "alpha");
    const i_row = try f.segRowidByText(1, "inserted");
    const o_row = try f.segRowidByText(1, "omega");
    try testing.expectEqual(a_row + 1, i_row);
    try testing.expectEqual(i_row + 1, o_row);
    const omega = try f.search(1, "omega");
    try testing.expectEqual(@as(i64, 2), omega.hits[0].pageIndex);
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
    try maintain.deletePagePostings(f.db, &md5, 0);
    try f.db.exec("UPDATE note_page_index SET text = 'arrived transcript';");
    try maintain.insertPagePostings(f.db, &md5, 0);
    try testing.expectEqual(seg, try f.segRowid(1, 0));
    try testing.expectEqual(@as(usize, 0), (try f.search(1, "stable ")).hits.len);
    try testing.expectEqual(@as(usize, 1), (try f.search(1, "arrived ")).hits.len);
    try f.db.exec("INSERT INTO segment_fts(segment_fts) VALUES('integrity-check');");
}

test "generation remint preserves results byte-for-byte, burns a fresh partition, and leaves the housemate alone" {
    var f = try Fixture.init();
    defer f.deinit();

    _ = try f.putNote(1, "a.note", &.{"orçamento anual"});
    _ = try f.putNote(1, "b.note", &.{"reunião marcada"});
    _ = try f.putNote(2, "theirs.note", &.{"orçamento deles"});

    const queries = [_][]const u8{ "orcamento ", "reuniao ", "marcada anual" };
    var golden: [queries.len]Results = undefined;
    for (queries, 0..) |q, i| golden[i] = try f.search(1, q);
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

    // Byte-for-byte the same answers — display order comes from updated_at,
    // never from the masks the remint just reissued.
    for (queries, 0..) |q, i| {
        const again = try f.search(1, q);
        try testing.expectEqual(golden[i].hits.len, again.hits.len);
        for (golden[i].hits, again.hits) |w, g| {
            try testing.expectEqualStrings(w.noteId, g.noteId);
            try testing.expectEqualStrings(w.noteName, g.noteName);
            try testing.expectEqual(w.pageIndex, g.pageIndex);
            try testing.expectEqualStrings(w.snippet, g.snippet);
        }
    }
    // The housemate's world did not move.
    try testing.expectEqual(@as(usize, 1), (try f.search(2, "orcamento ")).hits.len);
    try f.db.exec("INSERT INTO segment_fts(segment_fts) VALUES('integrity-check');");
}

// ---------------------------------------------------------------------------
// Tests — typo tolerance
// ---------------------------------------------------------------------------

test "the fallback is INERT whenever the exact/prefix search already works" {
    var f = try Fixture.init();
    defer f.deinit();

    // Deliberately a corpus with near neighbours in it ("carta"/"cartaz"), so a
    // fallback that ran unconditionally would visibly widen these results.
    _ = try f.putNote(1, "cal.note", &.{"Test Caligrafia Será que isso funciona?"});
    _ = try f.putNote(1, "other.note", &.{"carta cartaz calendar entry"});

    // Every one of these is a search that already worked before typo tolerance
    // existed: whole words, prefixes mid-typing, multi-token, accented.
    const working = [_][]const u8{
        "caligrafia", "calig",   "cal",            "caligrafia ",
        "funciona",   "sera ",
        "será ",
        "calí",
        "carta ",     "cartaz ", "funciona calig",
    };
    for (working) |q| {
        var used_fuzzy = true;
        const r = try f.searchTraced(1, q, &used_fuzzy);
        try testing.expect(r.hits.len > 0);
        // THE assertion: not "the same rows anyway", but the vocabulary was
        // never consulted. The fallback is invisible when it is not needed.
        try testing.expect(!used_fuzzy);
    }

    // `calig` must still PREFIX-match "caligrafia" rather than fuzzing out to
    // unrelated words — one note, not two.
    try testing.expectEqual(@as(usize, 1), (try f.search(1, "calig")).hits.len);
    try testing.expectEqual(@as(usize, 2), (try f.search(1, "cal")).hits.len);

    // And the fallback does run when — and only when — the primary found nothing.
    var used_fuzzy = false;
    const typo = try f.searchTraced(1, "caligrafa ", &used_fuzzy);
    try testing.expect(used_fuzzy);
    try testing.expectEqual(@as(usize, 1), typo.hits.len);
}

test "a misspelling still finds the page, whether the slip is the user's or the device's" {
    var f = try Fixture.init();
    defer f.deinit();

    _ = try f.putNote(1, "cal.note", &.{"Test Caligrafia Será que isso funciona?"});
    _ = try f.putNote(1, "doc.note", &.{"documentacao interna do equipamento"});

    // The user's slip: one edit short of the indexed word, typed and finished.
    for ([_][]const u8{ "caligrafa ", "calegrafia ", "caligrafia " }) |q| {
        const hits = (try f.search(1, q)).hits;
        try testing.expectEqual(@as(usize, 1), hits.len);
        try testing.expectEqualStrings("cal.note", hits[0].noteName);
    }

    // Mid-typing, too: the vocabulary term is truncated to what has been typed,
    // so a typo inside a half-written word is still reachable.
    const half = (try f.search(1, "calugraf")).hits;
    try testing.expectEqual(@as(usize, 1), half.len);
    try testing.expectEqualStrings("cal.note", half[0].noteName);

    // A one-edit slip on a longer word.
    const long = (try f.search(1, "documemtacao ")).hits;
    try testing.expectEqual(@as(usize, 1), long.len);
    try testing.expectEqualStrings("doc.note", long[0].noteName);

    // The snippet still marks the term that actually matched, so the fallback
    // does not break the highlight the frontend renders.
    try testing.expect(std.mem.indexOf(u8, long[0].snippet, "<mark>documentacao</mark>") != null);

    // The corpus being the noisy side is the same mechanism: here the DEVICE
    // wrote the typo, and the user types the word correctly.
    _ = try f.putNote(1, "ocr.note", &.{"usar infra-set dá trabalho"});
    const ocr = (try f.search(1, "trabalhos ")).hits;
    try testing.expectEqual(@as(usize, 1), ocr.len);
    try testing.expectEqualStrings("ocr.note", ocr[0].noteName);
}

test "the distance ladder scales with token length" {
    // The rungs themselves: short tokens get nothing, because at three
    // characters one edit is a different word rather than a typo.
    try testing.expectEqual(@as(usize, 0), fuzzy.maxEdits(0));
    try testing.expectEqual(@as(usize, 0), fuzzy.maxEdits(3));
    try testing.expectEqual(@as(usize, 1), fuzzy.maxEdits(4));
    try testing.expectEqual(@as(usize, 1), fuzzy.maxEdits(7));
    try testing.expectEqual(@as(usize, 2), fuzzy.maxEdits(8));
    try testing.expectEqual(@as(usize, 2), fuzzy.maxEdits(40));

    var f = try Fixture.init();
    defer f.deinit();
    _ = try f.putNote(1, "n.note", &.{"sol carta documentacao"});

    // Three characters: NO expansion. "sal" is one edit from the indexed "sol"
    // and still finds nothing.
    var used_fuzzy = true;
    const short = try f.searchTraced(1, "sal ", &used_fuzzy);
    try testing.expectEqual(@as(usize, 0), short.hits.len);
    try testing.expect(!used_fuzzy); // not even attempted

    // Five characters: one edit yes, two edits no.
    try testing.expectEqual(@as(usize, 1), (try f.search(1, "carto ")).hits.len);
    try testing.expectEqual(@as(usize, 0), (try f.search(1, "corto ")).hits.len);

    // Twelve characters: two edits are tolerated, three are not.
    try testing.expectEqual(@as(usize, 1), (try f.search(1, "documemtacoo ")).hits.len);
    try testing.expectEqual(@as(usize, 0), (try f.search(1, "documemtqcoo ")).hits.len);
}

test "distance is counted in codepoints, so accents cost one edit and not two" {
    var f = try Fixture.init();
    defer f.deinit();
    _ = try f.putNote(1, "pt.note", &.{"a reunião de avaliação está marcada"});

    // `remove_diacritics 2` folds the vocabulary, and the token is folded through
    // the SAME tokenizer before the distance is taken — so an accented and an
    // unaccented misspelling are literally the same comparison.
    for ([_][]const u8{ "avaliacoo ", "avaliação ", "avaliacão ", "avaliaçao " }) |q| {
        try testing.expectEqual(@as(usize, 1), (try f.search(1, q)).hits.len);
    }

    // The point of counting codepoints: on BYTES "reuniao" and "reunião" differ
    // by two, which would eat the whole budget of a seven-character word and let
    // a genuine typo slip past. Here one further edit still fits.
    try testing.expectEqual(@as(usize, 1), (try f.search(1, "reuniuo ")).hits.len);
    try testing.expectEqual(@as(usize, 1), (try f.search(1, "reuniõo ")).hits.len);

    // And the fold is not a second implementation that could drift: it is the
    // index's own tokenizer.
    var s = try f.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'segment_fts';");
    defer s.finalize();
    try testing.expect(try s.step());
    try testing.expect(std.mem.indexOf(u8, s.columnText(0), fts_tokenizer) != null);
}

test "an exact match outranks a fuzzy one, which bm25 alone cannot do" {
    var f = try Fixture.init();
    defer f.deinit();

    // `exact.note` carries the first token verbatim; `fuzzy.note` carries only a
    // near-miss of it. It is also much SHORTER, which is precisely what bm25
    // rewards — so without an imposed ordering it would come first.
    _ = try f.putNote(1, "exact.note", &.{
        "carta caligrafia com muitas outras palavras escritas aqui para diluir bastante o texto desta pagina",
    });
    _ = try f.putNote(1, "fuzzy.note", &.{"cartaz caligrafla"});

    // The primary pass finds nothing: neither page has both "carta" and a word
    // beginning "caligrafa". So the fallback runs and both pages come back —
    // each matching one group exactly and the other only approximately… except
    // that "carta" is exact in one and not the other.
    var used_fuzzy = false;
    const r = try f.searchTraced(1, "carta caligrafa", &used_fuzzy);
    try testing.expect(used_fuzzy);
    try testing.expectEqual(@as(usize, 2), r.hits.len);
    try testing.expectEqualStrings("exact.note", r.hits[0].noteName);
    try testing.expectEqualStrings("fuzzy.note", r.hits[1].noteName);
}

test "operators stay neutralised through the expansion path" {
    var f = try Fixture.init();
    defer f.deinit();
    _ = try f.putNote(1, "n.note", &.{"caligrafia documentacao alpha"});

    // Every one of these drives the query through the FALLBACK (the primary pass
    // returns nothing) while carrying FTS5 syntax. Reaching the assertion at all
    // is the point: expansion must not become a route into the parser.
    // These carry an operator WORD. Quoted, it is a literal the corpus does not
    // contain, so the whole query must come back empty — the operator never
    // regains its meaning by passing through the expansion.
    const inert = [_][]const u8{
        "caligrafa OR",          "caligrafa AND",        "caligrafa NOT",
        "caligrafa NEAR",        "NEAR(caligrafa",       "caligrafa NEAR(",
        "caligrafa OR zzzzz",    "(caligrafa OR alpha)", "caligrafa \" quote",
        "documemtacao OR alpha",
    };
    for (inert) |q| {
        try testing.expectEqual(@as(usize, 0), (try f.search(1, q)).hits.len);
    }

    // These carry only PUNCTUATION, which `unicode61` drops: they are the same
    // misspelling with noise around it, so they legitimately find the page. What
    // matters is that none of them is a syntax error and none matches everything.
    for ([_][]const u8{ "caligrafa*", "\"caligrafa\"", "caligrafa)", "**caligrafa**" }) |q| {
        try testing.expectEqual(@as(usize, 1), (try f.search(1, q)).hits.len);
    }

    // `OR` really is still a literal after expansion: the query needs the words
    // "or" and "zzzzz" to be present, and they are not — while dropping the
    // operator word makes the very same misspelling match.
    try testing.expectEqual(@as(usize, 1), (try f.search(1, "caligrafa ")).hits.len);

    // A quoted vocabulary term cannot smuggle syntax either: even a corpus whose
    // OCR produced operator-shaped words expands to inert literals.
    _ = try f.putNote(1, "op.note", &.{"NEARLY ORDER"});
    for ([_][]const u8{ "nearby ", "ordez ", "NEARBY OR" }) |q| {
        _ = try f.search(1, q); // no syntax error
    }
    try testing.expectEqual(@as(usize, 1), (try f.search(1, "nearby ")).hits.len);
}

test "the expansion is capped, and an unexpandable query never re-queries" {
    var f = try Fixture.init();
    defer f.deinit();
    _ = try f.putNote(1, "n.note", &.{"casa cara cama caso"});

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    // "cala" is one edit from casa, cara and cama (and two from caso, which the
    // four-character rung excludes). Uncapped, all three are offered.
    const wide = (try buildFuzzyMatch(a, f.db, "cala", false, max_fuzzy_terms, .corpus)).?;
    try testing.expectEqual(@as(usize, 3), std.mem.count(u8, wide.match, " OR "));
    // The reported terms are exactly the ones spliced into the expression — not
    // a second list that could name something the search was never widened by.
    try testing.expectEqual(@as(usize, 3), wide.alts.len);
    for (wide.alts) |alt| {
        try testing.expect(std.mem.indexOf(u8, wide.match, alt) != null);
    }

    // Capped, the budget is spent and the rest are dropped — the expression is
    // still well-formed, and still AND-ed against the original token.
    const one = (try buildFuzzyMatch(a, f.db, "cala", false, 1, .corpus)).?;
    try testing.expectEqual(@as(usize, 1), std.mem.count(u8, one.match, " OR "));
    try testing.expectEqual(@as(usize, 1), one.alts.len);
    try testing.expect(std.mem.startsWith(u8, one.match, "(\"cala\" OR \""));
    try testing.expect((try buildFuzzyMatch(a, f.db, "cala", false, 0, .corpus)) == null);

    // The cap holds end to end, and a capped search is still a valid query.
    try testing.expect((try f.search(1, "cala ")).hits.len <= 1);

    // Null — not an empty string and not a re-run of the primary — whenever
    // there is nothing to expand: every token too short, or no term near enough.
    try testing.expect((try buildFuzzyMatch(a, f.db, "sol", false, max_fuzzy_terms, .corpus)) == null);
    try testing.expect((try buildFuzzyMatch(a, f.db, "a b c", false, max_fuzzy_terms, .corpus)) == null);
    try testing.expect((try buildFuzzyMatch(a, f.db, "zzzzzzzz", false, max_fuzzy_terms, .corpus)) == null);

    // An absurdly long "word" is not a typo: it is left exact rather than
    // dragged through the distance function.
    const long = try testing.allocator.alloc(u8, fuzzy.max_fuzzy_term_cp + 10);
    defer testing.allocator.free(long);
    @memset(long, 'z');
    try testing.expect((try buildFuzzyMatch(a, f.db, long, false, max_fuzzy_terms, .corpus)) == null);
}

test "a swapped pair of letters is ONE edit, not two" {
    // The unit the ladder is spent in. Under plain Levenshtein every one of
    // these swaps costs 2 and the four-character rung (budget 1) rejects it.
    try testing.expectEqual(@as(?usize, 1), fuzzy.editDistance("wtiches", "witches", 1));
    try testing.expectEqual(@as(?usize, 1), fuzzy.editDistance("tset", "test", 1));
    try testing.expectEqual(@as(?usize, 1), fuzzy.editDistance("teh", "the", 1));
    try testing.expectEqual(@as(?usize, 1), fuzzy.editDistance("caligrafia", "caligrafai", 1));
    // Accented, to prove the swap is counted in CODEPOINTS like everything else:
    // on bytes, swapping `ã` past `o` moves three units and reads as several
    // edits, which would eat a seven-character word's whole budget.
    try testing.expectEqual(@as(?usize, 1), fuzzy.editDistance("reunioã", "reunião", 1));
    try testing.expectEqual(@as(?usize, 1), fuzzy.editDistance("avaliaçoa", "avaliaçao", 1));

    // A swap PLUS a substitution is two, and the ladder's one-edit rung says no.
    try testing.expectEqual(@as(?usize, null), fuzzy.editDistance("tsit", "test", 1));
    try testing.expectEqual(@as(?usize, 2), fuzzy.editDistance("tsit", "test", 2));

    // Non-adjacent swaps are NOT one edit — "transposition" means NEIGHBOURS,
    // and swapping the ends of a word is two substitutions like it always was.
    try testing.expectEqual(@as(?usize, null), fuzzy.editDistance("lesta", "tesla", 1));
    try testing.expectEqual(@as(?usize, 2), fuzzy.editDistance("lesta", "tesla", 2));

    // Optimal string alignment, stated: a substring is never edited twice, so
    // `ca`→`abc` is 3 here and 2 under unrestricted Damerau-Levenshtein. The
    // ladder never spends more than 2, so the two agree everywhere it can reach.
    try testing.expectEqual(@as(?usize, 3), fuzzy.editDistance("ca", "abc", 3));

    // The plain operations are untouched.
    try testing.expectEqual(@as(?usize, 0), fuzzy.editDistance("test", "test", 0));
    try testing.expectEqual(@as(?usize, 1), fuzzy.editDistance("intervew", "interview", 1));
    try testing.expectEqual(@as(?usize, 1), fuzzy.editDistance("testt", "test", 1));
    try testing.expectEqual(@as(?usize, 1), fuzzy.editDistance("tost", "test", 1));
}

test "THE TRANSPOSITION TEST: a swap reaches the word, and PREFERS it to a nearer-looking stranger" {
    var f = try Fixture.init();
    defer f.deinit();

    // The live library's own shape: the transcript the probe ran against, plus
    // the `set` that "infra-set" puts in the vocabulary. `set` is the whole
    // point — it is one DELETION from "tset", exactly as "test" is one SWAP, so
    // a fallback that only widens will happily answer with the wrong word.
    const iv = try f.putNote(1, "interview.note", &.{"Danie Witches. Arch Interview Test Teste"});
    _ = try f.putNote(1, "infra.note", &.{"usar infra-set dá trabalho"});

    // Today's miss: two edits under plain Levenshtein, so the seven-character
    // rung (budget 1) rejected it outright and the search came back empty.
    var used_fuzzy = false;
    const w = try f.searchTraced(1, "wtiches ", &used_fuzzy);
    try testing.expect(used_fuzzy);
    try testing.expectEqual(@as(usize, 1), w.hits.len);
    try testing.expectEqualStrings("interview.note", w.hits[0].noteName);

    // Today's WRONG answer, which is the worse of the two: `set` was reachable
    // in one deletion and got returned as though it were the reading meant.
    const t = try f.searchTraced(1, "tset ", &used_fuzzy);
    try testing.expect(used_fuzzy);
    try testing.expectEqual(@as(usize, 1), t.hits.len);
    try testing.expectEqualStrings("interview.note", t.hits[0].noteName);
    // Not merely "test ranks first" — `infra.note` is not in the answer at all,
    // because `set` never entered the OR-group. Same distance, worse length.
    for (t.hits) |h| try testing.expect(!std.mem.eql(u8, h.noteName, "infra.note"));

    // The ranking rule as the expansion sees it: one alternative, and it is the
    // transposed word rather than the shorter one at the same distance.
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const x = (try buildFuzzyMatch(arena.allocator(), f.db, "tset", false, max_fuzzy_terms, .corpus)).?;
    try testing.expectEqual(@as(usize, 1), x.alts.len);
    try testing.expectEqualStrings("test", x.alts[0]);

    // THE OVALS: whatever the ladder newly matches has to be nameable, or find
    // counts a page it cannot mark. The term reported is the word ON THE PAGE.
    const found = try f.searchNote(1, iv, "wtiches ");
    try testing.expect(found.usedFuzzy);
    try testing.expectEqual(@as(usize, 1), found.pages.len);
    try testing.expectEqual(@as(i64, 1), found.pages[0].matches);
    try testing.expectEqual(@as(usize, 1), found.pages[0].terms.len);
    try testing.expectEqualStrings("witches", found.pages[0].terms[0]);

    // And the swap does not buy short tokens an expansion the ladder denies
    // them: "tes"/"set" is a swap away from "set" but three characters get 0.
    var floor_fuzzy = true;
    const floor = try f.searchTraced(1, "ste ", &floor_fuzzy);
    try testing.expectEqual(@as(usize, 0), floor.hits.len);
    try testing.expect(!floor_fuzzy); // not even attempted
}

test "ranking is by distance then length, and ties do not depend on upload order" {
    var f = try Fixture.init();
    defer f.deinit();

    // `fuzzy.betterCandidate` on its own, since it is the rule everything else obeys.
    const near: fuzzy.Candidate = .{ .term = "test", .dist = 1, .delta = 0 };
    const far: fuzzy.Candidate = .{ .term = "aaaa", .dist = 2, .delta = 0 };
    const longer: fuzzy.Candidate = .{ .term = "set", .dist = 1, .delta = 1 };
    try testing.expect(fuzzy.betterCandidate(near, far)); // distance first
    try testing.expect(!fuzzy.betterCandidate(far, near));
    try testing.expect(fuzzy.betterCandidate(near, longer)); // then length
    try testing.expect(!fuzzy.betterCandidate(longer, near));
    // Neither rule separates these, so the term itself does — and it does so the
    // same way whichever order they are offered in.
    const a: fuzzy.Candidate = .{ .term = "casa", .dist = 1, .delta = 0 };
    const b: fuzzy.Candidate = .{ .term = "cara", .dist = 1, .delta = 0 };
    try testing.expect(fuzzy.betterCandidate(b, a));
    try testing.expect(!fuzzy.betterCandidate(a, b));

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();

    // Genuinely indistinguishable candidates all survive: "cala" is one edit
    // from casa, cara and cama, and none of them is a better guess than another.
    _ = try f.putNote(1, "n.note", &.{"casa cara cama caso"});
    const wide = (try buildFuzzyMatch(arena.allocator(), f.db, "cala", false, max_fuzzy_terms, .corpus)).?;
    try testing.expectEqual(@as(usize, 3), wide.alts.len);
    // In rank order, which for a three-way tie is byte order — NOT the order the
    // words appear in the transcript ("casa cara cama").
    try testing.expectEqualStrings("cama", wide.alts[0]);
    try testing.expectEqualStrings("cara", wide.alts[1]);
    try testing.expectEqualStrings("casa", wide.alts[2]);

    // The same three words uploaded in a different order rank identically. This
    // is what the byte-order tiebreak buys: before it, a capped expansion picked
    // whichever notes happened to be synced first.
    var g = try Fixture.init();
    defer g.deinit();
    _ = try g.putNote(1, "n.note", &.{"cama caso cara casa"});
    const same = (try buildFuzzyMatch(arena.allocator(), g.db, "cala", false, max_fuzzy_terms, .corpus)).?;
    try testing.expectEqualStrings("cama", same.alts[0]);
    try testing.expectEqualStrings("cara", same.alts[1]);
    try testing.expectEqualStrings("casa", same.alts[2]);
    // …and a cap that admits only one admits the SAME one from both libraries.
    const one = (try buildFuzzyMatch(arena.allocator(), f.db, "cala", false, 1, .corpus)).?;
    const one_g = (try buildFuzzyMatch(arena.allocator(), g.db, "cala", false, 1, .corpus)).?;
    try testing.expectEqualStrings("cama", one.alts[0]);
    try testing.expectEqualStrings("cama", one_g.alts[0]);

    // A strictly worse candidate is DROPPED rather than ranked below the winner:
    // "carto" is one edit from "carta" and two from "cartaz", and only the first
    // is offered. Widening to everything inside the budget is what let `tset`
    // answer with `set`.
    var h = try Fixture.init();
    defer h.deinit();
    _ = try h.putNote(1, "n.note", &.{"carta cartaz cartao"});
    const best = (try buildFuzzyMatch(arena.allocator(), h.db, "cartu", false, max_fuzzy_terms, .corpus)).?;
    try testing.expectEqual(@as(usize, 1), best.alts.len);
    try testing.expectEqualStrings("carta", best.alts[0]);
}

test "transposition changes what is REACHED, not when the fallback runs" {
    var f = try Fixture.init();
    defer f.deinit();

    _ = try f.putNote(1, "n.note", &.{"witches interview test teste"});

    // Still inert on an exact or prefix hit — the swap rule lives entirely
    // inside the vocabulary scan, and the scan still happens only after the
    // primary pass returned nothing.
    for ([_][]const u8{ "witches ", "witch", "interview ", "test ", "teste " }) |q| {
        var used_fuzzy = true;
        const r = try f.searchTraced(1, q, &used_fuzzy);
        try testing.expect(r.hits.len > 0);
        try testing.expect(!used_fuzzy);
    }

    // Below the distance floor: nothing back, and `usedFuzzy` false because the
    // expansion never ran. A three-character token gets no budget, swap or no.
    var short_fuzzy = true;
    const short = try f.searchTraced(1, "tsi ", &short_fuzzy);
    try testing.expectEqual(@as(usize, 0), short.hits.len);
    try testing.expect(!short_fuzzy);

    // Ran and still found nothing: `usedFuzzy` is a report of what EXECUTED, so
    // it stays true. The vocabulary is global, so user 2's swap does expand into
    // "witches" — and the `files` join then returns them nothing at all.
    var miss_fuzzy = false;
    const miss = try f.searchTraced(2, "wtiches ", &miss_fuzzy);
    try testing.expectEqual(@as(usize, 0), miss.hits.len);
    try testing.expect(miss_fuzzy);
    try testing.expect(miss.coverage != null);

    // Whereas a swap of a word nobody wrote produces no candidate at all, so
    // there is nothing to re-run and the flag stays false — unchanged from
    // before, and the reason it is not simply "the query was not exact".
    var nothing_fuzzy = true;
    const nothing = try f.searchTraced(1, "qwretyu ", &nothing_fuzzy);
    try testing.expectEqual(@as(usize, 0), nothing.hits.len);
    try testing.expect(!nothing_fuzzy);
}

test "the response SAYS it guessed, and says so as a real `false` when it did not" {
    var f = try Fixture.init();
    defer f.deinit();

    _ = try f.putNote(1, "cal.note", &.{"Test Caligrafia Será que isso funciona?"});

    // Exact and prefix hits: answered as typed, and the flag says so.
    for ([_][]const u8{ "caligrafia ", "calig", "funciona " }) |q| {
        const r = try f.search(1, q);
        try testing.expect(r.hits.len > 0);
        try testing.expect(!r.usedFuzzy);
    }

    // Only reachable through the fallback — so the UI must be told the answer is
    // approximate rather than presenting "caligrafia" as a match for "caligrafa".
    const guessed = try f.search(1, "caligrafa ");
    try testing.expectEqual(@as(usize, 1), guessed.hits.len);
    try testing.expect(guessed.usedFuzzy);

    // THE serialization assertion: `false` must be ON THE WIRE. The face emits
    // with `emit_null_optional_fields = false`, so had this been `?bool` the
    // exact case would omit the field entirely and a client could not tell it
    // from a server too old to report — opposite instructions, same bytes.
    const exact = try f.search(1, "caligrafia ");
    const body = try std.json.Stringify.valueAlloc(
        testing.allocator,
        exact,
        .{ .emit_null_optional_fields = false },
    );
    defer testing.allocator.free(body);
    try testing.expect(std.mem.indexOf(u8, body, "\"usedFuzzy\":false") != null);
    // …while `coverage` really is omitted here, because there are hits.
    try testing.expect(std.mem.indexOf(u8, body, "coverage") == null);
}

// ---------------------------------------------------------------------------
// Tests — note-scoped search (find in note)
// ---------------------------------------------------------------------------

test "THE CROWDING TEST: a note whose hits are pushed out of the library result still returns all of its own" {
    var f = try Fixture.init();
    defer f.deinit();

    // `noisy.note` matches on 30 pages, `quiet.note` on 3. This is exactly the
    // arrangement in which a per-note counter built on the library-wide search
    // reports a total that is silently wrong: 33 matches, and a page that names
    // two rows.
    //
    // (Pre-partitioning, bm25 ranked noisy's one-word pages above ALL of
    // quiet's and the page was 20×noisy. Then it was recency-ordered early
    // termination — 17 of noisy's pages plus quiet's 3. The truncation this
    // test is about is now DOCUMENT-level and total: each file contributes one
    // hit and 31 of the 33 matching pages are not in the answer, which is the
    // point — the library-wide read says WHICH documents, never how much of
    // one.)
    const noisy = try f.putPages(1, "noisy.note", 30, &.{"target"});
    const quiet = try f.putPages(1, "quiet.note", 3, &.{ "target here", "target again" });

    // The library-wide search names both documents, once each — and there is
    // nothing below them, so it says so by omitting the cursor. Never a total.
    const wide = try f.search(1, "target ");
    try testing.expectEqual(@as(usize, 2), wide.hits.len);
    try testing.expect(wide.cursor == null);
    var noisy_hits: usize = 0;
    var quiet_hits: usize = 0;
    for (wide.hits) |h| {
        if (std.mem.eql(u8, h.noteName, "noisy.note")) noisy_hits += 1;
        if (std.mem.eql(u8, h.noteName, "quiet.note")) quiet_hits += 1;
    }
    try testing.expectEqual(@as(usize, 1), noisy_hits);
    try testing.expectEqual(@as(usize, 1), quiet_hits);

    // Scoped, `quiet.note` reports every page it has, and a count per page: two
    // words per page, because that is how many ovals the reader will draw.
    const q = try f.searchNote(1, quiet, "target ");
    try testing.expectEqualStrings("target", q.query);
    try testing.expectEqual(@as(usize, 3), q.pages.len);
    for (q.pages, 0..) |p, i| {
        try testing.expectEqual(@as(i64, @intCast(i)), p.pageIndex);
        try testing.expectEqual(@as(i64, 2), p.matches);
    }

    // And the note that WON the library-wide ranking is not clamped either: 30
    // pages is more than `default_limit`, so a scoped query that reused the
    // library-wide limit would stop at 20 and under-report by a third.
    const n = try f.searchNote(1, noisy, "target ");
    try testing.expectEqual(@as(usize, 30), n.pages.len);
    try testing.expect(n.pages.len > default_limit);
    for (n.pages) |p| try testing.expectEqual(@as(i64, 1), p.matches);

    // Pages that do not match are simply absent — the filmstrip badges the
    // client draws are exactly these rows.
    const partial = try f.searchNote(1, quiet, "again ");
    try testing.expectEqual(@as(usize, 3), partial.pages.len);
    try testing.expectEqual(@as(usize, 0), (try f.searchNote(1, quiet, "absent ")).pages.len);
}

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
    try testing.expect(!typing.usedFuzzy); // the prefix was enough

    // Finished, the `*` is gone — but the typo fallback is behind it now, and
    // "alph" is one edit from the indexed "alpha", so the page is still found and
    // the response SAYS the answer is approximate.
    const guessed = try f.searchNote(1, id, "alph ");
    try testing.expectEqual(@as(usize, 4), guessed.pages.len);
    try testing.expect(guessed.usedFuzzy);

    // Below the distance ladder's floor there is no expansion at all, which is
    // what proves the line above is the fallback rather than a leaked prefix.
    const floored = try f.searchNote(1, id, "alp ");
    try testing.expectEqual(@as(usize, 0), floored.pages.len);
    try testing.expect(!floored.usedFuzzy);

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

/// Every page of `note_name` that GLOBAL search returns for `q`, drained across
/// the keyset stream so truncation cannot hide a page, sorted. The parity anchor
/// for the identical-results pin.
fn globalDocPages(f: *Fixture, user_id: u64, note_name: []const u8, q: []const u8) ![]i64 {
    var pages: std.ArrayList(i64) = .empty;
    var cursor: ?[]const u8 = null;
    while (true) {
        const r = try searchPages(f.a(), testing.io, f.db, user_id, q, default_limit, cursor);
        for (r.hits) |h| {
            if (std.mem.eql(u8, h.noteName, note_name)) try pages.append(f.a(), h.pageIndex);
        }
        if (r.cursor) |c| cursor = c else break;
    }
    std.sort.pdq(i64, pages.items, {}, std.sort.asc(i64));
    return pages.items;
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

/// The hit for `name`, or null. The per-document assertions read by name rather
/// than by index because the display sort, not the scan, decides row order.
fn hitNamed(hits: []const Hit, name: []const u8) ?Hit {
    for (hits) |h| if (std.mem.eql(u8, h.noteName, name)) return h;
    return null;
}

/// THE REPLACEMENT FOR GLOBAL↔IN-DOC SET EQUALITY, asserted wherever that
/// equality used to be. Global search names DOCUMENTS now, so it is a strict
/// subset of in-doc BY DESIGN — the properties that must survive, and do, are:
///
///   - **Document parity.** Global names the document exactly when in-doc finds
///     something. Both directions: never fabricated, never omitted.
///   - **Representative honesty.** Every page global names is a page in-doc also
///     returns — a member of the set, not an arbitrary index.
///   - **No repeats.** A page is never named twice in one drained stream.
///
/// What is deliberately NOT asserted is completeness, which is now in-doc's
/// alone: global does not claim how many pages of a document matched. The count
/// of global's entries is left to the caller, because it is "once per BAND" — a
/// canonical document is one band, a hand-scattered one is several.
fn expectDocParity(global: []const i64, in_doc: []const i64) !void {
    try testing.expectEqual(in_doc.len == 0, global.len == 0);
    for (global, 0..) |g, i| {
        try testing.expect(std.mem.indexOfScalar(i64, in_doc, g) != null);
        try testing.expect(std.mem.indexOfScalar(i64, global[i + 1 ..], g) == null);
    }
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

    // Same pin the library-wide query carries: the trailing `><` proves the
    // bracket bound into ?2/?3 is claimed BY the FTS index, not filtered after
    // the scan. In-doc now binds the DOCUMENT'S range there instead of the
    // partition's, so this plan is what makes in-doc O(document). BOTH in-doc
    // reads — find-in-note and find-in-txt — must show it.
    for ([_][]const u8{ "EXPLAIN QUERY PLAN " ++ note_search_sql, "EXPLAIN QUERY PLAN " ++ txt_search_sql }) |sql| {
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

test "DOCUMENT PARITY (the non-negotiable): global names the note iff in-doc finds it, once, on a page in-doc returns" {
    var f = try Fixture.init();
    defer f.deinit();

    // This pin used to assert global∩doc EQUALS the in-doc set. One hit per
    // document retires that equality deliberately — global is a strict subset by
    // design, and the excerpt it shows is a representative, not an inventory.
    // What replaces it is `expectDocParity` (see there): presence in both
    // directions, and every page named being a real one. Completeness within a
    // document is now in-doc's claim and nobody else's.
    //
    // A noisy note that crowds the library result, so the parity has to survive
    // global truncation (globalDocPages drains the stream to defeat it).
    _ = try f.putPages(1, "noisy.note", 30, &.{"common"});
    // The document under test: a shared common term, a rare one, an accented
    // word for the diacritic fold, and a prefix to reach it while still typing.
    const doc = try f.putLabeled(1, "doc.note", &.{
        "alpha common reuni\u{00e3}o", // page 0
        "beta common", // page 1
        "gamma avalia\u{00e7}\u{00e3}o common", // page 2
    });

    // common (frequent, crowded), alpha (rare), avaliacao (diacritic-folded),
    // "avali" (prefix, still-typing). For EACH: in-doc finds the doc, and global
    // names it exactly ONCE — the band is canonical, so one band is one hit —
    // on a page in-doc also returns.
    for ([_][]const u8{ "common ", "alpha ", "avaliacao ", "avali" }) |q| {
        const g = try globalDocPages(&f, 1, "doc.note", q);
        const d = try inDocPages(&f, 1, doc, q);
        try testing.expect(d.len > 0);
        try testing.expectEqual(@as(usize, 1), g.len);
        try expectDocParity(g, d);
    }
    // And a term the doc does NOT carry is empty on both sides — parity includes
    // the negative, which is the "iff" half a subset relation alone would lose.
    try expectDocParity(
        try globalDocPages(&f, 1, "doc.note", "zzzptl "),
        try inDocPages(&f, 1, doc, "zzzptl "),
    );
    try testing.expectEqual(@as(usize, 0), (try globalDocPages(&f, 1, "doc.note", "zzzptl ")).len);
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
        if (!r.usedFuzzy) try testing.expect(r.pages.len <= @as(usize, @intCast(batch))); // BOUNDED per batch
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

test "BATCHED IDENTICAL RESULTS (the non-negotiable): the UNION of in-doc batches == global ∩ doc, single- AND multi-range" {
    var f = try Fixture.init();
    defer f.deinit();

    // Crowd the library so global truncation is real; a doc with many matching
    // pages so a small batch takes SEVERAL round-trips (the cursor boundary is
    // crossed repeatedly).
    _ = try f.putPages(1, "noisy.note", 30, &.{"common"});
    var labels: [12][]const u8 = undefined;
    for (&labels, 0..) |*l, i| l.* = try std.fmt.allocPrint(f.a(), "p{d} common alpha{d}", .{ i, i });
    const doc = try f.putLabeled(1, "doc.note", &labels);

    // SINGLE-RANGE (canonical band): for a common term (12 pages, batch 3 ⇒ 4+
    // batches), a rare per-page term, and a term the doc lacks, the batched union
    // equals the UNBATCHED in-doc result — no drop or dup at any boundary. This
    // half is the one that matters most here and it is unchanged in substance:
    // it never depended on global, and now does not mention it.
    for ([_][]const u8{ "common ", "alpha3 ", "zzzptl " }) |q| {
        const d = try inDocPages(&f, 1, doc, q);
        const bd = try batchedInDocPages(&f, 1, doc, q, 3);
        try testing.expectEqualSlices(i64, d, bd);
        // The GLOBAL half re-anchors to document parity: one canonical band, so
        // one hit, on a page the batches also produced.
        const g = try globalDocPages(&f, 1, "doc.note", q);
        try testing.expectEqual(@as(usize, if (d.len == 0) 0 else 1), g.len);
        try expectDocParity(g, bd);
    }

    // MULTI-RANGE (hand-scattered band): scatter pages 1,4,7,10 to tail rowids so
    // the keyset merges several disjoint ranges with a global cursor across them.
    // The union must STILL equal global∩doc, boundary-clean, at a tiny batch.
    try f.scatterPages(1, doc, &.{ 1, 4, 7, 10 });
    try testing.expect((try docSegmentRanges(f.a(), f.db, doc, 1, (try partitionBounds(&f, 1)).lo, (try partitionBounds(&f, 1)).hi, false)).len > 1);
    for ([_][]const u8{ "common ", "alpha7 " }) |q| {
        const d = try inDocPages(&f, 1, doc, q);
        const bd = try batchedInDocPages(&f, 1, doc, q, 2);
        try testing.expectEqualSlices(i64, d, bd);
        // Parity holds per BAND, which is what a scattered document tests: the
        // four hand-scattered pages are their own one-page bands, so global may
        // name this document several times. Every one of them must still be a
        // page in-doc returns, and none of them twice.
        const g = try globalDocPages(&f, 1, "doc.note", q);
        try expectDocParity(g, bd);
    }
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

test "BATCH CURSOR: the last batch drops the cursor (exhaustion), a resumed batch never widens to fuzzy" {
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
    try testing.expect(!b2.usedFuzzy); // a resumed exact batch never widens

    // The fuzzy fallback fires ONLY on the first batch (exact empty) and is NOT a
    // stream: it carries no cursor, so a fuzzy result can never be resumed into
    // exactly the widening the invariant above forbids. ("caligrafa" → the doc's
    // "caligrafia" near-miss.)
    const fdoc = try f.putNote(1, "cal.note", &.{"a caligrafia bonita"});
    const fz = try searchNotePages(f.a(), f.db, 1, fdoc, "caligrafa ", null, 2);
    try testing.expect(fz.usedFuzzy);
    try testing.expectEqual(@as(?[]const u8, null), fz.cursor);
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

test "find tolerates a typo, names the word it actually counted, and says it guessed" {
    var f = try Fixture.init();
    defer f.deinit();

    // Three pages, only two of which carry the word — so the fallback has to be
    // as complete and as page-accurate as the exact pass.
    const id = try f.putSpec(1, "cal.note", .{ .pages = &.{
        .{ .layers = &.{.{ .slot = .main, .bitmap = "AAAA" }}, .recogn_status = 1, .recogn_labels = &.{"Test Caligrafia funciona"} },
        .{ .layers = &.{.{ .slot = .main, .bitmap = "BBBB" }}, .recogn_status = 1, .recogn_labels = &.{"nada aqui"} },
        .{ .layers = &.{.{ .slot = .main, .bitmap = "CCCC" }}, .recogn_status = 1, .recogn_labels = &.{"mais caligrafia caligrafia"} },
    } });

    const exact = try f.searchNote(1, id, "caligrafia ");
    try testing.expect(!exact.usedFuzzy);
    try testing.expectEqual(@as(usize, 2), exact.pages.len);

    // The user's slip. This used to be a flat zero, because the route left the
    // fallback off — while the very same typo worked in global search.
    const typo = try f.searchNote(1, id, "caligrafa ");
    try testing.expect(typo.usedFuzzy);
    // THE SAME PAGES as the exact query, with the same counts.
    try testing.expectEqual(exact.pages.len, typo.pages.len);
    for (exact.pages, typo.pages) |a, b| {
        try testing.expectEqual(a.pageIndex, b.pageIndex);
        try testing.expectEqual(a.matches, b.matches);
    }
    // …and the term named is the word that was COUNTED — "caligrafia", the thing
    // on the page — not "caligrafa", the thing that was typed. This is the whole
    // reason the fallback can be switched on here: the reader circles what the
    // count counted rather than re-deriving it from the query.
    for (typo.pages) |p| {
        try testing.expectEqual(@as(usize, 1), p.terms.len);
        try testing.expectEqualStrings("caligrafia", p.terms[0]);
    }
    try testing.expectEqual(@as(i64, 1), typo.pages[0].matches);
    try testing.expectEqual(@as(i64, 2), typo.pages[1].matches);

    // The fallback stays INERT when the exact pass already worked: no page of
    // this note names a near-miss it did not need.
    for (exact.pages) |p| try testing.expect(!hasTermNamed(p, "caligrafa"));
}

test "the note-scoped response says `usedFuzzy` on the wire, false included" {
    var f = try Fixture.init();
    defer f.deinit();

    const id = try f.putNote(1, "n.note", &.{"documentacao interna"});
    const exact = try f.searchNote(1, id, "documentacao ");
    try testing.expect(!exact.usedFuzzy);

    // Same reasoning as `Results.usedFuzzy`: the face omits null optionals, so a
    // `?bool` would drop the exact case's `false` and leave the client unable to
    // tell "answered as typed" from "server too old to say".
    const body = try std.json.Stringify.valueAlloc(
        testing.allocator,
        exact,
        .{ .emit_null_optional_fields = false },
    );
    defer testing.allocator.free(body);
    try testing.expect(std.mem.indexOf(u8, body, "\"usedFuzzy\":false") != null);
    // And the terms really are on the wire, since the ovals are drawn from them.
    try testing.expect(std.mem.indexOf(u8, body, "\"terms\":[\"documentacao\"]") != null);
}

test "the in-doc fuzzy pool is the DOCUMENT'S own (entry 8b): a cross-note correction is never even offered" {
    var f = try Fixture.init();
    defer f.deinit();

    // "caligrafia" lives only in ANOTHER user's note. Before entry 8b the in-doc
    // fuzzy pool was the whole-corpus vocabulary, so it expanded into that term
    // and relied on the `files` join to discard the (empty) result — reporting
    // usedFuzzy = true for a correction that could never have hit here. Now the
    // pool is THIS note's own terms, so the stranger word is not a candidate at
    // all: nothing to expand into, no widened search, usedFuzzy = false.
    _ = try f.putNote(2, "theirs.note", &.{"a caligrafia deles"});
    const mine = try f.putNote(1, "mine.note", &.{"nada relacionado"});

    const r = try f.searchNote(1, mine, "caligrafa ");
    // The RESULT is unchanged — still nothing found in this note (the
    // result-identity 8b preserves) — but the pool no longer secretly spans the
    // library, so the fallback correctly reports it never ran an expanded search.
    try testing.expectEqual(@as(usize, 0), r.pages.len);
    try testing.expect(!r.usedFuzzy);
    // THIS note's pool holds exactly its own words, and none of the stranger's —
    // the seek pool the ladder drew a blank against. (`caligrafia` is in the
    // OTHER owner's `doc_terms`, which is the whole point: per-document.)
    try testing.expectEqual(@as(i64, 0), try f.count(
        "SELECT COUNT(*) FROM doc_terms dt JOIN files f ON f.md5 = dt.blob_md5 " ++
            "WHERE f.name = 'mine.note' AND dt.term = 'caligrafia';",
    ));
    try testing.expect((try f.count(
        "SELECT COUNT(*) FROM doc_terms dt JOIN files f ON f.md5 = dt.blob_md5 " ++
            "WHERE f.name = 'mine.note' AND dt.term = 'relacionado';",
    )) > 0);
}

/// The page indexes an in-doc fuzzy search returns for `note_id`/`query` when
/// the ladder draws its candidates from `src` — the exact fuzzy branch of
/// `searchNotePages`, factored out so the DOC-scoped and WHOLE-CORPUS pools can
/// be run over the SAME document and their hit sets compared. Everything but the
/// source is identical, which is the whole point of the pin below.
fn inDocFuzzyPages(f: *Fixture, user_id: u64, note_id: u64, query: []const u8, src: VocabSource) ![]i64 {
    const arena = f.a();
    const part = (try partition.active(f.db, user_id)).?;
    const lo = partition.base(part);
    const hi = partition.last(part);
    const ranges = try docSegmentRanges(arena, f.db, note_id, user_id, lo, hi, false);
    const runs = try scopedRuns(arena, ranges, lo, hi);
    const exp = (try buildFuzzyMatch(arena, f.db, query, false, max_fuzzy_terms, src)) orelse
        return &.{};
    const rows = try runScoped(arena, f.db, false, exp.match, user_id, note_id, runs);
    const out = try arena.alloc(i64, rows.len);
    for (rows, out) |r, *o| o.* = r.page_index;
    std.sort.pdq(i64, out, {}, std.sort.asc(i64));
    return out;
}

test "RESULT-IDENTITY (entry 8b, the non-negotiable): the doc-scoped fuzzy pool gives the SAME in-doc hits as the whole-corpus pool" {
    var f = try Fixture.init();
    defer f.deinit();

    // The document under test carries a word correctable WITHIN it (caligrafia).
    // A SECOND document holds a word (manifesto) whose only near neighbour lives
    // OUTSIDE the first — the two cases the pin needs.
    const doc = try f.putNote(1, "doc.note", &.{"caligrafia exercicios diarios"});
    _ = try f.putNote(1, "other.note", &.{"manifesto politico extenso"});

    const corpus: VocabSource = .corpus;
    const scoped: VocabSource = .{ .doc = .{
        .note_id = doc,
        .user_id = 1,
        .partition_id = (try partition.active(f.db, 1)).?,
    } };

    // (a) A term correctable WITHIN the document. Both pools offer "caligrafia"
    // (it is in this doc, and is the globally-best neighbour too), so both find
    // the page — the doc pool skipped no candidate that could have hit here.
    {
        const with_scoped = try inDocFuzzyPages(&f, 1, doc, "caligrafa ", scoped);
        const with_corpus = try inDocFuzzyPages(&f, 1, doc, "caligrafa ", corpus);
        try testing.expectEqual(@as(usize, 1), with_corpus.len);
        try testing.expectEqualSlices(i64, with_corpus, with_scoped);
    }

    // (b) A term whose only near neighbour ("manifesto") lives in ANOTHER
    // document. The corpus pool DOES offer it — proof the two pools genuinely
    // differ — but re-searched against THIS document it matches nothing; the doc
    // pool never offers it at all. Same in-doc result: empty. Scoping the pool
    // changed the WORK, not the RESULTS.
    {
        const arena = f.a();
        try testing.expect((try buildFuzzyMatch(arena, f.db, "manifesta", false, max_fuzzy_terms, corpus)) != null);
        try testing.expect((try buildFuzzyMatch(arena, f.db, "manifesta", false, max_fuzzy_terms, scoped)) == null);

        const with_scoped = try inDocFuzzyPages(&f, 1, doc, "manifesta ", scoped);
        const with_corpus = try inDocFuzzyPages(&f, 1, doc, "manifesta ", corpus);
        try testing.expectEqual(@as(usize, 0), with_corpus.len);
        try testing.expectEqualSlices(i64, with_corpus, with_scoped);
    }
}

test "EXPLAIN PIN (entry 8b): the doc-scoped fuzzy pool read is an index SEEK, not a corpus scan" {
    var f = try Fixture.init();
    defer f.deinit();
    _ = try f.putNote(1, "n.note", &.{"alpha beta gamma"});

    // The doc term-set read must SEEK `doc_terms` by its (partition_id,
    // blob_md5) primary key — the whole reason entry 8b MAINTAINS the table
    // rather than scanning `fts5vocab(…,'instance')` (route 1, rejected for being
    // a SCAN). A regression to `SCAN doc_terms` throws away the O(doc) promise.
    // The plan prints the alias (`dt`), so the term-table step is recognised by
    // its PRIMARY KEY seek on the `(partition_id, blob_md5)` prefix — a full
    // key-prefix SEARCH, no SCAN anywhere.
    var s = try f.db.prepare("EXPLAIN QUERY PLAN " ++ fuzzy.doc_terms_select_sql);
    defer s.finalize();
    var seeks_doc_terms = false;
    while (try s.step()) {
        const detail = s.columnText(3);
        try testing.expect(std.mem.indexOf(u8, detail, "SCAN") == null); // never a scan
        if (std.mem.indexOf(u8, detail, "SEARCH") != null and
            std.mem.indexOf(u8, detail, "PRIMARY KEY") != null and
            std.mem.indexOf(u8, detail, "partition_id=") != null and
            std.mem.indexOf(u8, detail, "blob_md5=") != null) seeks_doc_terms = true;
    }
    try testing.expect(seeks_doc_terms);
}

// ---------------------------------------------------------------------------
// Tests — coverage
// ---------------------------------------------------------------------------

test "an empty result quantifies the unsearchable, and a non-empty one does not pay for it" {
    var f = try Fixture.init();
    defer f.deinit();

    _ = try f.putNote(1, "a.note", &.{"findable alpha"});
    _ = try f.putNote(1, "b.note", &.{"findable beta"});
    // A `.note` the device never recognised: present in the library, invisible
    // to search however it is spelled. This is the whole point of the number.
    _ = try f.putSpec(1, "blank.note", .{ .pages = &.{
        .{ .layers = &.{.{ .slot = .main, .bitmap = "DDDD" }} },
    } });
    // Not a note at all — the indexer could not parse it — so it is not an
    // unsearchable NOTE and must not inflate either side of the ratio.
    _ = try f.putBytes(1, "photo.png", "not a note at all");
    // Another user's library must not leak into the count.
    _ = try f.putNote(2, "theirs.note", &.{"unrelated"});

    const empty = try f.search(1, "zzzzzzzzz ");
    try testing.expectEqual(@as(usize, 0), empty.hits.len);
    const cov = empty.coverage.?;
    try testing.expectEqual(@as(i64, 3), cov.notes);
    try testing.expectEqual(@as(i64, 1), cov.unsearchable);

    // Absent whenever there ARE hits: the empty state is the only thing that
    // renders it, so an aggregate on every keystroke would be paid for nothing.
    try testing.expect((try f.search(1, "findable ")).coverage == null);

    // The other user sees their own library, not ours.
    const theirs = (try f.search(2, "zzzzzzzzz ")).coverage.?;
    try testing.expectEqual(@as(i64, 1), theirs.notes);
    try testing.expectEqual(@as(i64, 0), theirs.unsearchable);

    // Trashing takes the note out of both halves — the bin is not the library.
    try f.files.trash(1, 3);
    const after = (try f.search(1, "zzzzzzzzz ")).coverage.?;
    try testing.expectEqual(@as(i64, 2), after.notes);
    try testing.expectEqual(@as(i64, 0), after.unsearchable);

    // An account with nothing at all is 0 of 0, not an error.
    const none = (try f.search(9, "anything ")).coverage.?;
    try testing.expectEqual(@as(i64, 0), none.notes);
    try testing.expectEqual(@as(i64, 0), none.unsearchable);
}

test "the fallback cannot cross the user boundary the primary pass enforces" {
    var f = try Fixture.init();
    defer f.deinit();

    // The vocabulary is global — user 2's words are in it. Expanding into them
    // must still not return user 2's rows, because the `files` join is what
    // decides visibility, not the term list.
    _ = try f.putNote(2, "secret.note", &.{"confidential caligrafia dossier"});

    var used_fuzzy = false;
    const r = try f.searchTraced(1, "caligrafa ", &used_fuzzy);
    try testing.expect(used_fuzzy); // it really did expand into that vocabulary
    try testing.expectEqual(@as(usize, 0), r.hits.len);

    // Same term, own note: found.
    _ = try f.putNote(1, "mine.note", &.{"minha caligrafia"});
    const mine = (try f.search(1, "caligrafa ")).hits;
    try testing.expectEqual(@as(usize, 1), mine.len);
    try testing.expectEqualStrings("mine.note", mine[0].noteName);
}
