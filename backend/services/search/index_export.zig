//! The SERVER SIDE of the client's search index — `client-side-search-impl.md`
//! §2. Two things, in this order:
//!
//!   1. **The wire encoder** for the inverted `term -> documents` payload
//!      `docs/scratch/client-side-search.md` §2.1 measured and §2.3 settled.
//!   2. **The manifest and its tiering** (§2.2, and the design's §3) — the
//!      caller's COMPLETE live document set, which is also the only mechanism by
//!      which a trashed file ever stops matching in the browser. Its own header
//!      is below, at `THE MANIFEST`.
//!
//! Still no routes and no handlers: those are §3 step 4. It sits in `search/`
//! because that package already declares itself the sole owner of `doc_terms`,
//! which is the table the term payload is the transposition of.
//!
//! The decoder is `webapp/src/search/termCodec.ts`. **The two are pinned to each
//! other by `testdata/term_index_golden.bin`, not by inspection** — one checked-in
//! payload, encoded here and decoded there, with the expected contents written out
//! by hand on BOTH sides. Regenerating the golden to make this file's test pass
//! turns the browser's test red, which is the only arrangement that catches a
//! format change made on one side only.
//!
//! ## The shape, and why it is this one
//!
//! MEASURED (§2.1), over the dev corpus — 63,578 terms, 78,646 postings, 13 blobs:
//!
//!     ASCII `term 0,3,7`                712,979 raw   205,534 gzip
//!     delta-varint postings only        697,628 raw   246,182 gzip  <- WORSE
//!     varint + front-coded terms        421,713 raw   168,750 gzip
//!
//! **The middle row is the trap and it is why this encoder does both halves at
//! once.** Varint bytes are high-entropy and gzip cannot compress them, while the
//! ASCII decimal it replaces is repetitive and compresses well; the raw saving is
//! real and the compressed one is negative. Front-coding the term dictionary is
//! where the win actually is (1.24 postings per term on this corpus — the terms
//! dominate). Build one half and measure, and you will conclude the wrong thing.
//!
//! That 1.24 ratio is corpus-dependent and §2.1 says it will INVERT for a
//! note-heavy library. Which is what the version byte below is for.
//!
//! ## The version byte is NOT `index_version`
//!
//! `format_version` says how these bytes are SPELT. `index_version` says what the
//! terms MEAN — a new parser over the same blob yields different text and
//! therefore a different term set, and every client has to re-derive its whole
//! library. They move for unrelated reasons and at wildly different costs.
//! Conflating them is how a client throws away a household's index to pick up a
//! codec change that would not have altered a single term. The decoder carries the
//! same paragraph.
//!
//! ## The ordinal table is load-bearing — §4.4 gap 1
//!
//! Postings are ordinals, and an ordinal is meaningful only inside ONE payload:
//! the next bundle covers a different document set and renumbers everything. So
//! the payload carries the ordinal -> md5 table itself, and the decoder surfaces
//! md5s. Sync keys on md5 (§4: a blob is content-addressed, so the same md5 always
//! means the same terms), and an ordinal that quietly meant something else next
//! time is a corruption with no symptom.
//!
//! ## Layout
//!
//!     "TIDX"                     magic, 4 bytes
//!     format_version             u8
//!     doc_count                  u32 LE
//!     term_count                 u32 LE       (backpatched by `finish`)
//!     doc_count x md5            16 RAW bytes each, ordinal order
//!     term_count x term record:
//!       shared                   varint  bytes shared with the PREVIOUS term
//!       suffix_len               varint
//!       suffix                   suffix_len bytes
//!       posting_count            varint  >= 1
//!       delta[0]                 varint  = the first ordinal
//!       delta[i]                 varint  = ordinal[i] - ordinal[i-1], >= 1
//!
//! Both counts are fixed-width rather than varint on purpose: `term_count` is not
//! known until the last term has been written, and a streaming encoder that had to
//! know it up front would need a second pass over `doc_terms`. Fixed width lets
//! `finish` backpatch it. It also gives the decoder something to check the stream
//! against — a truncated payload that merely ran out of terms would otherwise
//! decode as a shorter, perfectly valid index, which is silent data loss.
//!
//! ## A document with NO terms is present here, in no posting list
//!
//! §4's three states: a blob whose text folds to nothing is derived-and-EMPTY, and
//! that is a final answer the client must remember, or it re-requests it forever.
//! It appears in the ordinal table and in no term's postings. (ABSENT — the blob is
//! not in the payload at all — and PENDING are the manifest's business, §8.1.)

const std = @import("std");

/// How these bytes are SPELT. Bumped when the layout above changes; NOT
/// `index_version`, which says what the terms mean — see the header.
pub const format_version: u8 = 1;

/// Four bytes so that an error page, a proxy's courtesy HTML or a truncated
/// response fails on byte 0 instead of being read as a term dictionary. A lone
/// version byte would accept `<` as version 60.
pub const magic = "TIDX";

/// Header bytes before the ordinal table: magic + version + the two counts.
pub const header_len = magic.len + 1 + 4 + 4;

pub const EncodeError = error{
    /// Terms must arrive in ascending BYTE order — front-coding against the
    /// predecessor is only a saving if they do, and the client relies on the
    /// order to merge payloads without re-sorting 63,578 strings.
    TermsOutOfOrder,
    /// A term nothing holds is not a term. It would also make `posting_count`
    /// zero, which the decoder refuses.
    EmptyPostingList,
    /// Postings must be strictly ascending: the deltas after the first are gaps
    /// of at least 1, so a repeat would encode as 0 and read back as a duplicate.
    PostingsOutOfOrder,
    /// An ordinal with no row in the table — the decoder could not name the
    /// document it refers to.
    OrdinalOutOfRange,
    /// 32 lowercase hex characters, which is what `files.md5` holds.
    InvalidMd5,
} || std.mem.Allocator.Error;

/// Streaming encoder: one payload, appended to a caller-owned buffer.
///
/// Streaming rather than "build a model and serialise it" because the server side
/// of this (§3 step 3) walks `doc_terms` in term order out of SQLite and must not
/// hold 63,578 terms and 78,646 postings in memory to emit 421 KB — the whole
/// install has a 50 MB budget.
pub const Encoder = struct {
    gpa: std.mem.Allocator,
    out: *std.ArrayList(u8),
    /// Absolute offset of the `term_count` slot, backpatched by `finish`.
    term_count_at: usize,
    term_count: u32 = 0,
    doc_count: u32,
    /// The previous term, for the shared-prefix length. Owned.
    prev: std.ArrayList(u8) = .empty,
    finished: bool = false,

    /// Write the header and the ordinal -> md5 table. `docs` is 32-character
    /// lowercase hex, in ordinal order: `docs[i]` is ordinal `i`.
    pub fn begin(
        gpa: std.mem.Allocator,
        out: *std.ArrayList(u8),
        docs: []const []const u8,
    ) EncodeError!Encoder {
        try out.appendSlice(gpa, magic);
        try out.append(gpa, format_version);
        try appendU32(gpa, out, @intCast(docs.len));
        const term_count_at = out.items.len;
        try appendU32(gpa, out, 0); // backpatched by `finish`

        // RAW md5, not hex. 16 bytes against 32, and gzip gets nothing back from
        // hex digits — a hash is incompressible either way, so the doubling is
        // paid in full. At the ~1,200-document library `search-baseline.md` §1
        // measures that is 19 KB against 38 KB, on a 3G link.
        for (docs) |hex| {
            var raw: [16]u8 = undefined;
            try md5FromHex(hex, &raw);
            try out.appendSlice(gpa, &raw);
        }

        return .{
            .gpa = gpa,
            .out = out,
            .term_count_at = term_count_at,
            .doc_count = @intCast(docs.len),
        };
    }

    pub fn deinit(self: *Encoder) void {
        self.prev.deinit(self.gpa);
        self.* = undefined;
    }

    /// One term and the ordinals of the documents holding it. `term` must be
    /// greater than the previous one; `ordinals` must be non-empty, strictly
    /// ascending, and in range.
    pub fn addTerm(self: *Encoder, term: []const u8, ordinals: []const u32) EncodeError!void {
        std.debug.assert(!self.finished);
        if (ordinals.len == 0) return error.EmptyPostingList;
        if (self.term_count != 0 and std.mem.order(u8, self.prev.items, term) != .lt) {
            return error.TermsOutOfOrder;
        }

        // The shared prefix is counted in BYTES and may land INSIDE a multi-byte
        // codepoint — "ação" and "açúcar" share `61 C3 A7 C3`, and the suffix
        // `BA 63 61 72` is not valid UTF-8 on its own. That is correct and the
        // golden vector pins it: the decoder must concatenate the prefix and the
        // suffix and decode the RESULT. A decoder that ran the suffix through
        // TextDecoder by itself would silently substitute U+FFFD, and the term it
        // then indexed would match nothing the user could type.
        var shared: usize = 0;
        const limit = @min(self.prev.items.len, term.len);
        while (shared < limit and self.prev.items[shared] == term[shared]) shared += 1;

        try appendVarint(self.gpa, self.out, shared);
        try appendVarint(self.gpa, self.out, term.len - shared);
        try self.out.appendSlice(self.gpa, term[shared..]);

        try appendVarint(self.gpa, self.out, ordinals.len);
        var prev_ord: u32 = 0;
        for (ordinals, 0..) |ord, i| {
            if (ord >= self.doc_count) return error.OrdinalOutOfRange;
            if (i == 0) {
                try appendVarint(self.gpa, self.out, ord);
            } else {
                if (ord <= prev_ord) return error.PostingsOutOfOrder;
                try appendVarint(self.gpa, self.out, ord - prev_ord);
            }
            prev_ord = ord;
        }

        self.prev.clearRetainingCapacity();
        try self.prev.appendSlice(self.gpa, term);
        self.term_count += 1;
    }

    /// Backpatch `term_count`. Forgetting this leaves the count at 0, which the
    /// decoder rejects as a trailing-bytes error rather than serving an empty
    /// index — the loud direction.
    pub fn finish(self: *Encoder) void {
        std.debug.assert(!self.finished);
        std.mem.writeInt(u32, self.out.items[self.term_count_at..][0..4], self.term_count, .little);
        self.finished = true;
    }
};

fn appendU32(gpa: std.mem.Allocator, out: *std.ArrayList(u8), v: u32) std.mem.Allocator.Error!void {
    var buf: [4]u8 = undefined;
    std.mem.writeInt(u32, &buf, v, .little);
    try out.appendSlice(gpa, &buf);
}

/// Unsigned LEB128: 7 bits per byte, low group first, high bit set on every byte
/// but the last.
fn appendVarint(gpa: std.mem.Allocator, out: *std.ArrayList(u8), value: u64) std.mem.Allocator.Error!void {
    var v = value;
    while (true) {
        const low: u8 = @intCast(v & 0x7f);
        v >>= 7;
        if (v == 0) return out.append(gpa, low);
        try out.append(gpa, low | 0x80);
    }
}

/// 32 lowercase hex characters to 16 bytes. Lowercase only, deliberately: the md5
/// is the client's cache key, and a payload that spelt it in a different case than
/// the manifest would look like a document the client has never seen.
fn md5FromHex(hex: []const u8, out: *[16]u8) EncodeError!void {
    if (hex.len != 32) return error.InvalidMd5;
    for (out, 0..) |*byte, i| {
        const hi = try nibble(hex[i * 2]);
        const lo = try nibble(hex[i * 2 + 1]);
        byte.* = (hi << 4) | lo;
    }
}

fn nibble(c: u8) EncodeError!u8 {
    return switch (c) {
        '0'...'9' => @intCast(c - '0'),
        'a'...'f' => @intCast(c - 'a' + 10),
        else => error.InvalidMd5,
    };
}

// ---------------------------------------------------------------------------
// THE MANIFEST — `client-side-search-impl.md` §2.2, and the tiering it carries,
// `client-side-search.md` §3
// ---------------------------------------------------------------------------

// ## The manifest is COMPLETE or it is broken. There is no third option.
//
// §4's sync is ADDITIVE — "here are the md5s I hold, send the ones I am missing"
// — and an additive protocol can never remove anything. Nothing else on the wire
// removes anything either: there are no tombstones, and a trashed file's terms
// stay valid bytes for as long as any client holds them. **A trashed file stops
// matching because it is ABSENT from the next complete manifest and the client
// diffs the whole set.** That is the only removal mechanism this design has.
//
// So §2.2's sentence is load-bearing rather than emphatic: *"a manifest that is
// ever partial, paginated or filtered is a correctness bug, not a performance
// trade."* A `LIMIT`, a cursor, or a `WHERE` that skipped rows with nothing to
// say would each leave a deleted document searchable in the browser for ever,
// with no error and no symptom — the client would simply never learn it was
// gone. The only filters below are the ones that decide what a DOCUMENT is
// (`deleted = 0`, `is_folder = 0`, a blob, and the `.mark` pairing rule that
// every other listing applies), and each of those is stable: a row never leaves
// the manifest except by ceasing to be one of the caller's live documents,
// which is exactly the event the client must see.
//
// The specific filter it is most tempting to add, and must not be: *"only rows
// that actually have terms"*. That one is not stable — it flips when the
// deferred worker catches up — so a document would be absent, then present, and
// the client would read its earlier absence as a deletion of something it never
// had. It is also the filter that would hide precisely the rows the derivation
// state exists to describe.
//
// ## Cost, stated rather than discovered
//
// Complete means the query is O(the caller's live library) every time it is
// asked, and §9.2 flags the recurring cost. What the WORK PIN below holds is the
// shape of that: linear in the caller's OWN library, flat in everyone else's and
// flat in the bin. The measured per-row cost and the payload's measured size are
// in the MEASUREMENT test at the end of this file and in §9.2.

const sqlite = @import("../../db/sqlite.zig");
const filesvc = @import("../files.zig");
const maintain = @import("maintain.zig");
const pending = @import("../pending.zig");
const partition = @import("../search_partition.zig");

/// Which pass of the fill this document belongs to — `client-side-search.md` §3,
/// in its order, so `ORDER BY tier` IS the fill order and no second table maps
/// one to the other.
///
/// The tiers are a PRIORITY, not an exclusion: every live document of the
/// caller's is in exactly one of them, and `other` is the catch-all that makes
/// that true. Being wrong about a tier costs a wait, never a missing result —
/// §3 says so where it admits `.mark` measures engagement rather than content.
pub const Tier = enum(u8) {
    /// §3 pass 1 — "`.note`, the user's own handwriting". 684 B gzip on the dev
    /// corpus: one round trip and the household's own notes are searchable.
    note = 1,
    /// §3 pass 2 — "anything with a `.mark` companion", i.e. a document the
    /// household cared enough about to write on.
    marked = 2,
    /// §3 pass 3 — everything else. 91.5% of the bytes and the last to arrive.
    other = 3,
};

/// What the client is allowed to conclude from an EMPTY term set for this md5 —
/// §8.1, and the reason the manifest carries it at all.
///
/// **This is a CACHE decision, not a status line.** §4 says an empty term set is
/// a legitimate, final, immutable answer; a blob whose deferred job has not run
/// also has no terms, and on the wire the two are the same bytes. A client
/// obeying §4 caches the pending blob's emptiness for ever and that document is
/// silently unsearchable for ever — not until the worker catches up, but for
/// ever, because nothing will ever ask again.
/// **WHAT `pending` MEANS, EXACTLY — read this before building a client cache.**
///
/// `derived` here is *"no tenant of the deferred worker owes this blob work"*,
/// and that is narrower than the plain-English "its text has been extracted".
/// `pending-ness.md` §11.4 records the gap and it is deliberate: the count and
/// this column agree with the WORKER, which is the property §3 exists to keep,
/// and the worker offers a blob only once its `note_index` row is current. So a
/// blob whose note half is STALE reports `derived` while genuinely underived —
/// no tenant will touch it until the note half heals, and then it becomes
/// pending and derivable on the next pass.
///
/// **That under-report is why the client's rule is `unknown` => `pending` and
/// why an empty term set is only cacheable together with its `index_version`.**
/// `client-side-search.md` §4.1: caching a false empty loses that document for
/// ever — no error, no retry, no symptom. The `(md5, index_version)` key is what
/// makes the stale-note window survivable: the heal bumps the row to the current
/// version, and a client keyed on the old one refetches instead of trusting the
/// empty it cached. A client that keyed on md5 alone would make this window
/// permanent, which is the one way to turn a transient under-report into data
/// loss.
pub const Derivation = enum(u8) {
    /// Terms are final for this `(md5, index_version)`. Cache them, empty
    /// included.
    derived = 0,
    /// The worker still owes this blob work. Do NOT cache an empty answer; ask
    /// again.
    pending = 1,
    /// The server declined to say. **No longer produced** — `owes_derive_expr`
    /// is a real predicate now and answers 0 or 1 for every row. It stays in the
    /// vocabulary because it is what a NULL still READS as, and the reading has
    /// to stay the conservative one: a client must treat it exactly as
    /// `pending`, because refusing to cache costs a request where caching a
    /// false empty loses a document for ever.
    unknown = 2,
};

/// THE SEAM, FILLED — `docs/scratch/pending-ness.md` §3 and §4.1.
///
/// That plan is emphatic that pending-ness IS the deferred tenants' own
/// predicate, extracted and shared: *"any other definition would be a second
/// opinion about what the worker owes, free to drift from what it actually
/// does."* So this is not SQL written in this file. It is
/// `pending.owesDerive`, generated from `deferred.tenants`' `from_where`
/// clauses in the same loop the user-facing pending COUNT is generated from —
/// the count says how many documents are outstanding, this says whether THIS
/// one is, and neither can drift from the worker or from the other.
///
/// It comes from `services/pending.zig` rather than `services/deferred.zig` for
/// the reason §11.5 records: `search/` imports *the module that owns what is
/// outstanding*, never the background worker itself.
///
/// **THE ALIAS IS NOT `f`, AND THAT IS WHY THE MANIFEST'S ROW IS `d`.** Every
/// tenant's clause is `FROM files f JOIN …`, so inside the correlated `EXISTS`
/// the name `f` is the TENANT's row. An outer row also called `f` would
/// generate `AND f.md5 = f.md5` — a tautology reading as "every document is
/// pending", for ever, with no error. `owesDerive` refuses the alias `f` at
/// comptime; the manifest below renamed its row to `d` to satisfy it, and that
/// rename is the whole reason the statement's aliases moved.
const owes_derive_expr = pending.owesDerive("d");

/// "A note" is the INDEXER's verdict — a file whose blob it actually parsed a
/// `.note` container out of — and never a filename ending in `.note`. The same
/// "verified, not claimed" rule `query.zig`'s coverage count states: a PDF or a
/// PNG is not an unsearchable note, it is not a note.
///
/// This is also the tier-1 test, and the two being one expression is the point:
/// "the user's own handwriting" (§3 pass 1) and "a note, for coverage purposes"
/// are the same question, and a manifest that answered them differently would
/// report a fraction over a denominator its own tiering disagreed with.
fn isNote(comptime a: []const u8) []const u8 {
    return "EXISTS (SELECT 1 FROM note_index WHERE blob_md5 = " ++ a ++ ".md5 AND indexable = 1)";
}

/// Carries recognised text somewhere — the exact complement of `unsearchable`.
/// `maintain.fts_predicate` rather than a re-typed `text IS NOT NULL AND
/// text <> ''`, so this cannot drift from what the index sync actually indexed.
fn hasRecognisedText(comptime a: []const u8) []const u8 {
    return "EXISTS (SELECT 1 FROM note_page_index WHERE blob_md5 = " ++ a ++
        ".md5 AND recogn_status = 1 AND " ++ maintain.fts_predicate ++ ")";
}

/// `client-side-search.md` §3's three passes as one SQL expression over the row
/// aliased `a`. Exported because §9.1's cold fill is *"one bundle per tier"*, so
/// the terms route (step 4) selects by tier and must ask the same question this
/// manifest answered — one expression, or the client's tier 2 and the server's
/// tier 2 are different sets.
///
/// **Tier 2 is `Files.hasPairedMark`, and it is deliberately not spelt here.**
/// The pairing rule was made RELATIONAL — a sibling exists whose `name || '.mark'`
/// is this row's — precisely because the old `LIKE '%.pdf.mark'` was silently
/// PDF-only, and the device annotates formats this server has never heard of. An
/// annotated `book.epub` is a tier-2 document. Nothing in this file may ask what
/// the document IS; the sibling's existence is the whole answer, and
/// `files.zig` owns it (`client-side-search-impl.md` §0.2 records why there is
/// exactly one copy).
pub fn tierExpr(comptime a: []const u8) []const u8 {
    return "CASE WHEN " ++ isNote(a) ++ " THEN 1" ++
        " WHEN " ++ filesvc.Files.hasPairedMark(a) ++ " THEN 2" ++
        " ELSE 3 END";
}

/// The `.mark` fold, from `files.zig`'s own generator — the same rule the library
/// listing, `childCount`, `liveSubtreeCount`, the bin and library-wide search
/// apply. A paired mark is a LAYER of the document beside it, so it is not a
/// document of the manifest's and not a row of anybody's coverage denominator.
/// An ORPHANED mark still lists, here as everywhere: it is the only remaining
/// trace of that ink.
const hide_paired_mark = filesvc.Files.hidePairedMark("d", "0");

/// How much of the caller's library is searchable at all — the two numbers
/// `query.zig`'s `coverageOf` produces today, so that `coverageLine` keeps its
/// sentence when that function is deleted in step 9.
///
/// **Accumulated over the manifest's own rows rather than asked as a second
/// aggregate**, which is what makes the fraction and the row set structurally the
/// same population. A separate `COUNT(*)` would be a second copy of this file's
/// WHERE clause, free to disagree with it about a paired mark or a trashed row —
/// which is exactly the bug §0.2 found in the old coverage query, where a mark
/// the household had never been shown sat on the unsearchable side and made both
/// halves of the fraction wrong. It also costs nothing: the walk is happening
/// anyway, and complete is the one thing the manifest is not allowed to skimp on.
pub const Coverage = struct {
    /// Notes the caller owns, by the indexer's verdict (`isNote`).
    notes: i64 = 0,
    /// How many of those carry no recognised text, and are therefore invisible
    /// to search however it is spelled. PERMANENT, and not to be confused with
    /// `Derivation.pending`, which is transient and resolves itself
    /// (`pending-ness.md` §2 — two numbers, two sentences).
    unsearchable: i64 = 0,
};

/// One document of the caller's. Per FILE, not per blob — see `Cursor.next`.
pub const Row = struct {
    /// `files.id`. What a local hit has to name to be opened.
    file_id: i64,
    /// 32 lowercase hex. The term payload's key, and the sync diff's identity.
    /// **Borrowed from the statement** — see `Cursor.next`.
    md5: []const u8,
    /// `files.updated_at`. §3's within-tier ordering, and the client's own
    /// display order for a set of hits.
    updated_at: i64,
    /// `note_index.index_version` — the other half of §4's `(md5, index_version)`
    /// cache key. NULL when the blob has no index row at all, which is a blob
    /// nothing has looked at yet; a client cannot key a cache entry on it and
    /// must not cache one.
    index_version: ?i64,
    /// §3's fill pass.
    tier: Tier,
    /// §8.1's three states. `unknown` is no longer produced — see `Derivation`
    /// for what `derived` does and does not claim, which is what a client cache
    /// has to be built against.
    derivation: Derivation,
};

/// The whole manifest, materialised. Convenient, and honest about its cost: the
/// manifest is complete by construction, so this is O(the caller's library) in
/// memory as well as in work. At the 1,222-file corpus of `search-baseline.md`
/// §1 that is tens of kilobytes (MEASURED — see the measurement test), which is
/// inside the 50 MB budget with room to spare; a household ten times that size
/// should stream `Cursor` instead, which is why `Cursor` is the primitive and
/// this is built on it.
pub const Manifest = struct {
    rows: []const Row,
    coverage: Coverage,
};

/// EVERY live document of `user_id`'s, tier first and newest first within a tier.
///
/// ## The document row is aliased `d`, not `f`, and that is load-bearing
///
/// `owes_derive_expr` embeds the deferred tenants' own predicate, which binds
/// `f` to ITS `files` row. An outer row also called `f` would correlate
/// `f.md5 = f.md5` and report every document pending, silently and for ever.
/// `pending.owesDerive` refuses the alias `f` at comptime; this statement is
/// spelt `d` so that it can.
///
/// ## The row set, clause by clause, and why nothing else may join it
///
///   * `d.user_id = ?1` — one household member's library. Authorization is this
///     clause and nothing else; there is no md5 the caller can name to widen it.
///   * `d.deleted = 0` — the bin is not the library. This is ALSO the removal
///     channel: a trashed file's row simply stops appearing, and the client's set
///     diff is what turns that into "stop matching" (see the section header).
///   * `d.is_folder = 0 AND d.md5 IS NOT NULL` — a document is bytes. A folder
///     has none.
///   * `hide_paired_mark` — a `.mark` beside its document is a layer of it, not a
///     document. Same generator as every other listing.
///
/// ## The ORDER BY is the fill order — §3
///
/// Tier first (`.note`, then annotated, then bulk), `updated_at` DESC inside a
/// tier, `f.id` last so that two documents saved in the same second have a
/// stable order rather than SQLite's. The client fetches in the order it
/// receives, so this ordering IS `client-side-search.md` §3's
/// "download by relevance" and the client re-sorting would be a second opinion.
///
/// It costs one sort of the caller's library — the ORDER BY cannot ride an index
/// because `tier` is computed — and that is accepted rather than overlooked: the
/// manifest must materialise every row anyway, so the sort is over a set the
/// query was always going to visit in full. The PLAN PIN allows exactly one temp
/// b-tree for it and fails on a second.
///
/// ## `INDEXED BY files_live_name`, and the bin is the reason
///
/// Both candidate indexes start with `user_id`, and both give the right answer.
/// `files_live_name` is PARTIAL (`WHERE deleted = 0`), so a trashed file is not
/// in it at all; `files_user_parent` is total, so every trashed row is walked
/// and discarded. MEASURED on the fixture below: 400 files in the bin cost
/// **2,000 VM steps** through `files_user_parent` and **zero** through
/// `files_live_name`, for identical output. A household's bin is unbounded and
/// its manifest is fetched on every visit, so that difference compounds in the
/// one direction this design cannot afford.
///
/// `INDEXED BY` is a requirement rather than a hint, which is the trade
/// `schema.zig` states where the index is defined: if `files_live_name` is
/// dropped or renamed, this statement fails to PREPARE, loudly, instead of
/// quietly reverting to walking the bin.
/// The sort key is the ALIAS `tier` rather than the output ordinal `5`: an
/// ordinal is silently rebound by a column inserted before it, and the failure
/// would be a fill order that no longer matches §3 with every test still green.
const manifest_sql =
    "SELECT d.id, d.md5, d.updated_at, ni.index_version, " ++
    tierExpr("d") ++ " AS tier, " ++
    hasRecognisedText("d") ++ ", " ++
    owes_derive_expr ++ " " ++
    "FROM files d INDEXED BY files_live_name " ++
    "LEFT JOIN note_index ni ON ni.blob_md5 = d.md5 " ++
    "WHERE d.user_id = ?1 AND d.deleted = 0 AND d.is_folder = 0 AND d.md5 IS NOT NULL" ++
    hide_paired_mark ++ " " ++
    "ORDER BY tier, d.updated_at DESC, d.id;";

const col_id = 0;
const col_md5 = 1;
const col_updated_at = 2;
const col_index_version = 3;
const col_tier = 4;
const col_has_text = 5;
const col_derivation = 6;

/// The manifest, one row at a time, accumulating the coverage counts as it goes.
///
/// Streaming rather than "collect and return" because the handler that will serve
/// this (step 4) can write the response straight out of it and never hold the
/// caller's library twice. `Manifest` is the collecting convenience on top.
pub const Cursor = struct {
    stmt: sqlite.Stmt,
    tally: Coverage = .{},
    drained: bool = false,

    pub fn open(db: sqlite.Db, user_id: u64) !Cursor {
        const stmt = try db.prepare(manifest_sql);
        stmt.bindInt(1, @intCast(user_id));
        return .{ .stmt = stmt };
    }

    /// The next document, or null once the manifest is complete.
    ///
    /// **`Row.md5` borrows SQLite's own buffer** and is valid only until the next
    /// call — the same contract `sqlite.Stmt.columnText` has. A caller keeping
    /// rows must dupe it, as `manifest` below does.
    ///
    /// **One row per FILE, not per blob**, which is a sharpening of §2.2's "md5
    /// set" and is deliberate. Two files holding the same bytes are two documents
    /// to the household: they have different names, different `updated_at`, and
    /// one may carry ink while the other does not — so tier and recency are file
    /// properties, and a blob has neither. More sharply, removal is per file: if
    /// the manifest were keyed by md5, trashing one of two copies would remove no
    /// row and the client could never learn that one of them is gone, which is
    /// the one thing the manifest exists to tell it. Terms stay keyed by md5 (§4
    /// — a blob is content-addressed), so the client dedupes md5s when it decides
    /// what to FETCH; that is a client-side detail and not a reason to lose a
    /// document here.
    pub fn next(self: *Cursor) !?Row {
        if (!try self.stmt.step()) {
            self.drained = true;
            return null;
        }
        const tier: Tier = switch (self.stmt.columnInt(col_tier)) {
            1 => .note,
            2 => .marked,
            else => .other,
        };
        // COVERAGE'S DENOMINATOR IS TIER 1, and there is no second `EXISTS` for
        // it: "a note by the indexer's verdict" is the same question `tierExpr`
        // already asked, so asking it again would be a second correlated seek per
        // row (MEASURED: ~20 of the ~85 VM steps a row costs) AND a second place
        // for the answer to be spelt differently.
        if (tier == .note) {
            self.tally.notes += 1;
            if (self.stmt.columnInt(col_has_text) == 0) self.tally.unsearchable += 1;
        }
        return .{
            .file_id = self.stmt.columnInt(col_id),
            .md5 = self.stmt.columnText(col_md5),
            .updated_at = self.stmt.columnInt(col_updated_at),
            .index_version = self.stmt.columnIntOpt(col_index_version),
            .tier = tier,
            // `owes_derive_expr` is an `EXISTS`, so it answers 0 or 1 and never
            // NULL — the `unknown` arm is unreachable by construction and is
            // kept anyway, because the alternative is defaulting a NULL to
            // `derived`. That would be the one wrong answer here: `derived` is a
            // licence to cache an empty term set for ever, and a client that
            // took it on a column the server had failed to compute would lose
            // that document permanently (`client-side-search.md` §4.1).
            .derivation = if (self.stmt.columnIsNull(col_derivation))
                .unknown
            else if (self.stmt.columnInt(col_derivation) != 0) .pending else .derived,
        };
    }

    /// The coverage counts. **Only meaningful once the cursor has been drained**
    /// — they are a tally of the rows that went past, which is the whole reason
    /// they cannot disagree with the row set. A handler streaming JSON emits them
    /// after the rows for the same reason.
    pub fn coverage(self: Cursor) Coverage {
        std.debug.assert(self.drained);
        return self.tally;
    }

    pub fn finalize(self: Cursor) void {
        self.stmt.finalize();
    }
};

/// The whole manifest in `arena`. Rows own their md5s.
pub fn manifest(arena: std.mem.Allocator, db: sqlite.Db, user_id: u64) !Manifest {
    var c = try Cursor.open(db, user_id);
    defer c.finalize();
    var rows: std.ArrayList(Row) = .empty;
    while (try c.next()) |row| {
        var owned = row;
        owned.md5 = try arena.dupe(u8, row.md5);
        try rows.append(arena, owned);
    }
    return .{ .rows = rows.items, .coverage = c.coverage() };
}

// ---------------------------------------------------------------------------
// THE MANIFEST ON THE WIRE — `client-side-search-impl.md` §3 step 4, decided by
// §9.2's measurement
// ---------------------------------------------------------------------------

/// How the manifest is SPELT. Separate from `format_version` above (the term
/// payload's) on purpose: the two payloads are fetched by different code on
/// different cadences, and there is no reason a change to one should invalidate
/// the other. Neither is `index_version`, which says what the terms MEAN.
pub const manifest_format_version: u8 = 1;

/// Four bytes, for the same reason `TIDX` is four: an error page, a proxy's
/// courtesy HTML or a truncated response fails on byte 0 rather than being read
/// as a row count.
pub const manifest_magic = "SMAN";

/// magic + version + row_count.
pub const manifest_header_len = manifest_magic.len + 1 + 4;

/// The manifest as BYTES — the format §9.2's measurement chose over JSON, and
/// the numbers are the whole argument.
///
/// MEASURED, 1,222 documents (`search-baseline.md` §1's corpus size), gzip
/// level 6:
///
///     JSON             143,139 raw   38,597 gzip
///     these bytes       27,663 raw   26,937 gzip     <- 30% off the gzip figure
///
/// **This server does not compress API responses** — only precompressed static
/// assets, `http/static.zig` — so the figure that actually travels is the RAW
/// one, and there the saving is **5.2x** rather than 30%. Either way it is the
/// same trade the term codec already took for its ordinal table: md5s are 72.6%
/// of this payload and hashes do not compress, so representation is the only
/// lever with any travel in it.
///
/// ## Layout
///
///     "SMAN"                   magic, 4 bytes
///     manifest_format_version  u8
///     row_count                u32 LE
///     notes                    varint   `Coverage.notes`
///     unsearchable             varint   `Coverage.unsearchable`
///     row_count x row, in the manifest's own order:
///       md5                    16 RAW bytes
///       flags                  u8       tier in the low nibble, derivation in the high
///       file_id                varint
///       updated_at             varint   ABSOLUTE on a tier's first row, else the
///                                       gap from the row before it
///       index_version          varint   0 = absent, else version + 1
///
/// `row_count` is fixed-width and near the front so the decoder can check the
/// stream against it. A truncated body that merely ran out of rows would
/// otherwise decode as a shorter, perfectly valid manifest — and a short
/// manifest is read by the client as DELETIONS (§2.2). That is the one
/// corruption this payload can suffer that looks like a legitimate answer.
///
/// `updated_at` is a GAP because the rows are already `updated_at` DESC within a
/// tier: consecutive documents in a real household are minutes or hours apart,
/// which is two varint bytes where the absolute epoch second is five.
///
/// **The FIRST row of each tier carries its ABSOLUTE `updated_at`, not a zero
/// gap**, and that is the difference between a decodable manifest and one whose
/// timestamps are all relative to nothing. A tier boundary is the only place the
/// gap could go negative, so it is the only place a fresh anchor is needed — and
/// there are exactly three tiers, so the whole manifest pays about fifteen bytes
/// for it. An earlier draft wrote a zero there; every row of every tier then
/// decoded as an offset from an origin the client could not know, and the
/// symptom would have been a result list in a plausible but wrong order rather
/// than an error.
///
/// `index_version` is stored `+1` so that ZERO can mean ABSENT. A blob indexed
/// at version 0 and a blob with no index row at all are different facts — the
/// first is cacheable under `(md5, 0)` and the second cannot be cached at all —
/// and merging them hands the client a cache key it must not use.
///
/// **NO DOCUMENT NAMES, deliberately.** They would balloon the one response that
/// is paid on every visit, and the client does not need them: a locally-answered
/// result set names `file_id`s, and the file listing the app already holds turns
/// those into names. §2.2's per-FILE keying is what makes that work.
pub fn writeManifest(gpa: std.mem.Allocator, out: *std.ArrayList(u8), m: Manifest) EncodeError!void {
    try out.appendSlice(gpa, manifest_magic);
    try out.append(gpa, manifest_format_version);
    try appendU32(gpa, out, @intCast(m.rows.len));
    try appendVarint(gpa, out, @intCast(m.coverage.notes));
    try appendVarint(gpa, out, @intCast(m.coverage.unsearchable));

    var prev_tier: ?Tier = null;
    var prev_at: i64 = 0;
    for (m.rows) |r| {
        var raw: [16]u8 = undefined;
        try md5FromHex(r.md5, &raw);
        try out.appendSlice(gpa, &raw);
        try out.append(gpa, @as(u8, @intFromEnum(r.tier)) | (@as(u8, @intFromEnum(r.derivation)) << 4));
        try appendVarint(gpa, out, @intCast(r.file_id));
        const at = if (prev_tier != null and prev_tier.? == r.tier)
            prev_at - r.updated_at // the gap, inside a tier
        else
            r.updated_at; // the anchor, at a tier boundary
        try appendVarint(gpa, out, @intCast(at));
        try appendVarint(gpa, out, if (r.index_version) |v| @intCast(v + 1) else 0);
        prev_tier = r.tier;
        prev_at = r.updated_at;
    }
}

/// A strong validator for a body, as 32 lowercase hex characters.
///
/// **THE ANSWER TO "HOW OFTEN IS THE MANIFEST REFETCHED", and it is a validator
/// rather than a policy.** §9.2 left that question open and said the shape that
/// would settle it is a conditional request. This is that shape, and the answer
/// it gives is: **as often as the client likes**. A manifest that has not changed
/// costs one conditional request and a 304 with no body instead of 27 KB; one
/// that has changed costs what it always cost. So there is no refresh interval to
/// tune, no staleness window to reason about, and no chance of a client's cadence
/// and a household's editing rhythm disagreeing.
///
/// ## Why it is a hash of the BODY and not a version number
///
/// The tempting cheap validator is `files.syncVersion` — 0.42 ms, already read by
/// the live channel on every tick — combined with the worker's `done` counter.
/// Both were rejected, for different reasons and both fatal:
///
///   * A version pair is **a second opinion about what changes the manifest**.
///     The manifest is a projection of `files`, `note_index`, `note_page_index`,
///     the pairing rule and both deferred tenants; anything that has to enumerate
///     those in order to say "nothing moved" is a list that will be wrong the
///     first time one of them gains a case. Being wrong here is SILENT and it is
///     the worst failure this payload has: a client told 304 over a manifest that
///     lost a row goes on matching a deleted document for ever, because absence
///     from the manifest is the ONLY removal channel this design has (§2.2).
///   * `pending.Pulse.version` is **restart-relative and not persisted**
///     (`pending-ness.md` §11.3 says in as many words that it is "wrong for
///     anything that tries to store it across a reboot"). An ETag is stored
///     across reboots, by every browser, by definition.
///
/// A hash of the bytes cannot be wrong about any of that, because it is not an
/// opinion about the manifest — it IS the manifest. What it costs is that the
/// server still runs the full query (178 ms on the Pi) before it can answer 304,
/// so this saves BYTES and not WORK. That is the right half to save: the bytes
/// are the recurring cost §9.2 flagged, they are paid on a 1 Mbit/s link, and the
/// query was going to run anyway on any visit that did change something.
///
/// md5 rather than SHA-256 because this is a cache validator and not a security
/// boundary — nothing is authorized by it, and the payload it names is already
/// scoped by the session that asked for it.
pub fn bodyEtag(bytes: []const u8) [32]u8 {
    var digest: [16]u8 = undefined;
    std.crypto.hash.Md5.hash(bytes, &digest, .{});
    var hex: [32]u8 = undefined;
    _ = std.fmt.bufPrint(&hex, "{x}", .{&digest}) catch unreachable;
    return hex;
}

// ---------------------------------------------------------------------------
// THE TERM PAYLOAD FOR A BATCH OF md5s — §2.1's second route, §2.4's rule
// ---------------------------------------------------------------------------

// ## MASK FOR SPEED, JOIN FOR CORRECTNESS — and this is the second entry point
//
// §2.4 is one sentence with teeth: the response body depends on **md5 alone**,
// which is what makes it `immutable`-cacheable and byte-identical between
// housemates — and *"the right to receive it is a `files` join per request"*.
// `query.zig`'s module docs state the rule this is an instance of and name the
// hazard exactly: *"a second entry point would be a place to forget it."*
//
// So the visibility predicates are written ONCE below and both statements are
// built on them. The partition id is a MASK — it bounds which `doc_terms` rows
// are read — and is never the access check, because a `doc_terms` row is keyed
// by blob and a blob is shared between households by design.
//
// The failure this prevents is not subtle and it is not recoverable: an md5 is
// 32 characters a housemate can read off their own manifest, and without the
// join, naming one would hand over the full text vocabulary of a document they
// have never been shown.

/// The ONE clause. `?1` is the caller. Nothing below may restate it, narrow it,
/// or reach `files` by any other route.
const held_by_caller = " f.user_id = ?1 AND f.deleted = 0 AND f.is_folder = 0";

/// Which of the requested md5s the caller ACTUALLY HOLDS — the authorization
/// answer and the payload's ordinal table, in one statement.
///
/// **This is the gate.** Ordinals are assigned from these rows and nothing else,
/// so an md5 that does not survive this clause has no ordinal, and a posting for
/// it cannot be encoded even if a later statement produced one.
///
/// **`json_each` rather than a generated `IN (?,?,…)`**, so this is a STATIC
/// statement with a plan that can be pinned, in a file where every other
/// statement is comptime-built. The request's md5 list arrives as a JSON array in
/// `?2`; the alternative is SQL assembled per request, which is both a style
/// break and an unpinnable plan.
///
/// `INDEXED BY files_md5` for `query.zig`'s reason one route along: `md5` is
/// content-addressed and near-unique while `user_id` is by definition the whole
/// library, so reaching `files` by the owner would re-walk that library once per
/// requested md5. Stated rather than left to `ANALYZE`, and a requirement rather
/// than a hint — dropping the index fails the PREPARE.
///
/// `ORDER BY f.md5` IS the ordinal assignment. Ordinals are the payload's own, so
/// sorting them by md5 makes the payload a pure function of the md5 SET rather
/// than of the order the client happened to ask in — which is what lets two
/// housemates share one cache entry (§2.4), and what makes the postings below
/// come out strictly ascending for free.
const held_sql =
    "SELECT DISTINCT f.md5 FROM json_each(?2) j " ++
    "CROSS JOIN files f INDEXED BY files_md5 ON f.md5 = j.value " ++
    "WHERE" ++ held_by_caller ++ " ORDER BY f.md5;";

/// The terms themselves, for the md5s the caller holds.
///
/// **The `files` join is here TOO, and it is DEFENSE IN DEPTH rather than the
/// gate** — stated precisely, because overstating it is how the real gate gets
/// deleted by someone reasoning that one of the two must be redundant. The
/// ordinal table above already excludes anything the caller does not hold, and
/// `writeTerms` drops a row whose md5 has no ordinal. What this join adds is that
/// the reason a foreign row never ships stops depending on a Zig lookup: it is
/// the same `files` predicate, in the statement, the way `fuzzy.zig`'s
/// `doc_terms_select_sql` re-applies it for the same reason.
///
/// It is also why the STRUCTURAL test asserts over both statements rather than
/// over behaviour alone: removing this one leaves every behavioural test green,
/// and that is exactly the class of deletion `query.zig`'s "second entry point"
/// warning is about.
///
/// `ORDER BY dt.term, dt.blob_md5` is what the encoder demands — terms ascending
/// by byte, and postings within a term strictly ascending, which they are because
/// the ordinal table is sorted by md5 too. `DISTINCT` because two `files` rows of
/// one blob are two join rows and one document.
///
/// **`CROSS JOIN`, and it is a join-ORDER directive rather than a join kind.**
/// `json_each` is a table-valued function with no statistics, so the planner has
/// no way to know the request's md5 list is the small side. Left as a plain
/// `JOIN` it made `doc_terms` the OUTER loop and seeked the PARTITION PREFIX
/// alone — every term row the household owns, read once per request. MEASURED:
/// 400 unrelated notes of the caller's own took an eight-document export from
/// **1,534 to 19,539 VM steps**, for identical output. The plan pin names both
/// key columns for this reason: the bad plan is still a `SEARCH` on the primary
/// key, so "doc_terms is seeked" would have passed over it.
const terms_sql =
    "SELECT DISTINCT dt.term, dt.blob_md5 FROM json_each(?2) j " ++
    "CROSS JOIN doc_terms dt ON dt.partition_id = ?3 AND dt.blob_md5 = j.value " ++
    "CROSS JOIN files f INDEXED BY files_md5 ON f.md5 = dt.blob_md5 " ++
    "WHERE" ++ held_by_caller ++ " ORDER BY dt.term, dt.blob_md5;";

/// How many md5s one request may name.
///
/// A GET carries them in the query string, and 37 characters each (`&md5=` plus
/// 32 hex) puts 128 at ~4.7 KB — comfortably inside any request-line limit, where
/// an uncapped batch would let a client build a request the transport has to
/// refuse with no useful error.
///
/// It is also what bounds the work. The whole 1,222-document library is 10
/// requests, which on §9.1's own arithmetic (HTTP/1.1, ~6 connections, 100-250 ms
/// RTT) is ~0.3 s of round-trip against the ~10 s that per-document fetching was
/// measured to cost. §9.1's "one bundle per tier" becomes "a handful of bundles
/// per tier" — which keeps what per-document fetching lost without making any
/// single response unbounded.
pub const max_terms_md5s: usize = 128;

/// The term payload for `md5s`, restricted to the ones `user_id` holds.
///
/// **An md5 the caller does not hold is simply ABSENT from the payload** — not an
/// error, and not an empty entry. That is the same answer a caller gets for an
/// md5 nobody holds and for one that never existed, so the response says nothing
/// about anybody else's library. §4's three states survive for the md5s that ARE
/// covered: present with postings, present with none (derived-and-empty, a final
/// answer the client caches), absent (never sent — ask again).
///
/// Everything is written into `out`; `arena` holds the ordinal table.
pub fn writeTerms(
    arena: std.mem.Allocator,
    gpa: std.mem.Allocator,
    out: *std.ArrayList(u8),
    db: sqlite.Db,
    user_id: u64,
    md5s: []const []const u8,
) !void {
    // The md5 list as JSON, for `json_each`. Built here rather than by the
    // handler so the ENCODING of the bound parameter cannot drift from the
    // statement that reads it.
    var json_list: std.ArrayList(u8) = .empty;
    defer json_list.deinit(gpa);
    try json_list.append(gpa, '[');
    for (md5s, 0..) |m, i| {
        // REJECTED rather than escaped. Every value reaching this point is 32
        // characters of lowercase hex or it is not an md5, and a quoting routine
        // would be a place for that to quietly stop being true.
        if (!isMd5Hex(m)) return error.InvalidMd5;
        if (i != 0) try json_list.append(gpa, ',');
        try json_list.append(gpa, '"');
        try json_list.appendSlice(gpa, m);
        try json_list.append(gpa, '"');
    }
    try json_list.append(gpa, ']');

    var held: std.ArrayList([]const u8) = .empty;
    {
        var s = try db.prepare(held_sql);
        defer s.finalize();
        s.bindInt(1, @intCast(user_id));
        s.bindText(2, json_list.items);
        while (try s.step()) try held.append(arena, try arena.dupe(u8, s.columnText(0)));
    }

    var enc = try Encoder.begin(gpa, out, held.items);
    defer enc.deinit();
    if (held.items.len == 0) {
        // No ordinal table means no posting can be encoded at all, so running the
        // term statement would be a read whose every row had to be discarded.
        enc.finish();
        return;
    }

    // MASK FOR SPEED: the caller's own partition bounds `doc_terms`. A caller who
    // has never ingested anything has no partition and therefore no terms — the
    // same answer as an empty library — and the ordinal table still ships, so a
    // held-but-unindexed blob is derived-and-EMPTY rather than absent.
    const part = (try partition.active(db, user_id)) orelse {
        enc.finish();
        return;
    };

    var s = try db.prepare(terms_sql);
    defer s.finalize();
    s.bindInt(1, @intCast(user_id));
    s.bindText(2, json_list.items);
    s.bindInt(3, part);

    // One `addTerm` per term, accumulating its ordinals as the rows arrive. The
    // statement's ORDER BY guarantees the grouping, so nothing is buffered but
    // the current term's posting list — the same streaming discipline `Encoder`
    // exists for.
    var current: std.ArrayList(u8) = .empty;
    defer current.deinit(gpa);
    var ordinals: std.ArrayList(u32) = .empty;
    defer ordinals.deinit(gpa);
    var have_term = false;
    while (try s.step()) {
        const term = s.columnText(0);
        const blob = s.columnText(1);
        const ord = ordinalOf(held.items, blob) orelse continue;
        if (!have_term or !std.mem.eql(u8, current.items, term)) {
            if (have_term) try enc.addTerm(current.items, ordinals.items);
            current.clearRetainingCapacity();
            try current.appendSlice(gpa, term);
            ordinals.clearRetainingCapacity();
            have_term = true;
        }
        try ordinals.append(gpa, ord);
    }
    if (have_term) try enc.addTerm(current.items, ordinals.items);
    enc.finish();
}

/// The ordinal of `md5` in the sorted table, or null. Binary search: the table is
/// `ORDER BY f.md5` by construction, and a linear scan would make the export
/// quadratic in the batch size for no reason.
fn ordinalOf(table: []const []const u8, md5: []const u8) ?u32 {
    var lo: usize = 0;
    var hi: usize = table.len;
    while (lo < hi) {
        const mid = lo + (hi - lo) / 2;
        switch (std.mem.order(u8, table[mid], md5)) {
            .lt => lo = mid + 1,
            .gt => hi = mid,
            .eq => return @intCast(mid),
        }
    }
    return null;
}

/// 32 characters of lowercase hex, and nothing else — the gate on everything
/// that reaches a bound parameter or the JSON list above.
pub fn isMd5Hex(s: []const u8) bool {
    if (s.len != 32) return false;
    for (s) |c| switch (c) {
        '0'...'9', 'a'...'f' => {},
        else => return false,
    };
    return true;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/// The checked-in payload the browser decodes. See the annotated dump in the
/// golden test below; if you change either, change both.
const golden = @embedFile("testdata/term_index_golden.bin");

/// The golden vector's four documents, in ordinal order. Ordinal 3 is the md5 of
/// the EMPTY string, and it is the document with no terms — a coincidence made on
/// purpose, so that a reader of the hex dump can see which one is meant to be
/// empty without consulting anything.
const golden_docs = [_][]const u8{
    "0123456789abcdef0123456789abcdef",
    "fedcba9876543210fedcba9876543210",
    "00112233445566778899aabbccddeeff",
    "d41d8cd98f00b204e9800998ecf8427e",
};

/// The golden vector's terms, in the ascending byte order the encoder demands,
/// with the documents holding each. Portuguese because the corpus is.
///
/// What each row is here to exercise, because a golden vector nobody can read the
/// intent of stops being maintained:
///
///   agua      shared 0 (nothing precedes it); in EVERY document that has terms
///   ação      multi-byte UTF-8; postings 0 then 2, so a delta GREATER than 1
///   açúcar    shares 4 bytes with `ação` — a prefix that ENDS INSIDE `ã`/`ú`,
///             both of which begin `C3`, leaving a suffix that is not valid
///             UTF-8 by itself; in exactly one document
///   nota      shared 0 again (`a…` to `n…`); in every document that has terms
///   notas     shares its predecessor WHOLE — shared == prev.len, suffix "s"
///   notação   shares 4 with `notas`, and diverges into multi-byte
///   ágil      sorts LAST because `á` is `C3 A1`; byte order, not alphabet
///
/// Ordinal 3 appears nowhere below: that is the derived-and-empty document.
const golden_terms = [_]struct { term: []const u8, docs: []const u32 }{
    .{ .term = "agua", .docs = &.{ 0, 1, 2 } },
    .{ .term = "ação", .docs = &.{ 0, 2 } },
    .{ .term = "açúcar", .docs = &.{2} },
    .{ .term = "nota", .docs = &.{ 0, 1, 2 } },
    .{ .term = "notas", .docs = &.{0} },
    .{ .term = "notação", .docs = &.{ 1, 2 } },
    .{ .term = "ágil", .docs = &.{0} },
};

fn encodeGolden(gpa: std.mem.Allocator, out: *std.ArrayList(u8)) !void {
    var enc = try Encoder.begin(gpa, out, &golden_docs);
    defer enc.deinit();
    for (golden_terms) |row| try enc.addTerm(row.term, row.docs);
    enc.finish();
}

// The golden payload, byte for byte, 139 bytes. Written out so that a reviewer
// can check the file with `xxd` and nothing else.
//
//   54 49 44 58              "TIDX"
//   01                       format_version = 1
//   04 00 00 00              doc_count  = 4
//   07 00 00 00              term_count = 7
//   0123456789abcdef0123456789abcdef   ordinal 0
//   fedcba9876543210fedcba9876543210   ordinal 1
//   00112233445566778899aabbccddeeff   ordinal 2
//   d41d8cd98f00b204e9800998ecf8427e   ordinal 3, no terms
//
//   00 04 61 67 75 61        shared 0, "agua"
//   03 00 01 01              3 postings: 0, +1, +1        -> 0,1,2
//   01 05 c3 a7 c3 a3 6f     shared 1 ("a"), "ção"
//   02 00 02                 2 postings: 0, +2            -> 0,2
//   04 04 ba 63 61 72        shared 4 (`61 c3 a7 c3`), suffix is NOT valid UTF-8
//   01 02                    1 posting: 2
//   00 04 6e 6f 74 61        shared 0, "nota"
//   03 00 01 01              3 postings: 0, +1, +1        -> 0,1,2
//   04 01 73                 shared 4 — the WHOLE predecessor — suffix "s"
//   01 00                    1 posting: 0
//   04 05 c3 a7 c3 a3 6f     shared 4 ("nota"), "ção"
//   02 01 01                 2 postings: 1, +1            -> 1,2
//   00 05 c3 a1 67 69 6c     shared 0, "ágil"
//   01 00                    1 posting: 0

test "the golden vector encodes byte for byte" {
    const gpa = std.testing.allocator;
    var out: std.ArrayList(u8) = .empty;
    defer out.deinit(gpa);

    try encodeGolden(gpa, &out);

    // NOT a round-trip. The bytes are checked in, and the browser's vitest suite
    // decodes the same file against expectations written out by hand there. If
    // this assertion is ever "fixed" by regenerating the file, that suite goes
    // red — which is the whole point of pinning the two halves to one artifact
    // rather than to each other's code.
    try std.testing.expectEqualSlices(u8, golden, out.items);
}

test "the golden vector is the size the annotated dump claims" {
    // Header 13 + four md5s 64 + seven term records 62. A different total means
    // the dump above has drifted from the encoder and stopped being verifiable.
    try std.testing.expectEqual(@as(usize, 139), golden.len);
    try std.testing.expectEqual(@as(usize, 13), header_len);
}

test "the version byte sits where the decoder looks for it" {
    // The decoder reads byte 4 and refuses an unknown value. If the magic ever
    // changes length this test is the one that says so, rather than the browser
    // silently reporting "unsupported format version 0".
    try std.testing.expectEqualSlices(u8, magic, golden[0..4]);
    try std.testing.expectEqual(format_version, golden[4]);
}

test "a document with no terms still occupies an ordinal" {
    // §4's derived-and-EMPTY. Ordinal 3's md5 is in the table; no posting list
    // mentions it. A client that cannot see the difference between this and a
    // blob that was never sent re-requests it forever.
    const at = header_len + 3 * 16;
    const expected = [16]u8{
        0xd4, 0x1d, 0x8c, 0xd9, 0x8f, 0x00, 0xb2, 0x04,
        0xe9, 0x80, 0x09, 0x98, 0xec, 0xf8, 0x42, 0x7e,
    };
    try std.testing.expectEqualSlices(u8, &expected, golden[at..][0..16]);

    for (golden_terms) |row| {
        for (row.docs) |ord| try std.testing.expect(ord != 3);
    }
}

test "a term that shares its whole predecessor stores only the suffix" {
    // `nota` -> `notas`: shared == prev.len, which is the front-coding boundary
    // most likely to be got wrong by an off-by-one in either direction.
    const gpa = std.testing.allocator;
    var out: std.ArrayList(u8) = .empty;
    defer out.deinit(gpa);

    var enc = try Encoder.begin(gpa, &out, &.{"0123456789abcdef0123456789abcdef"});
    defer enc.deinit();
    try enc.addTerm("nota", &.{0});
    const before = out.items.len;
    try enc.addTerm("notas", &.{0});
    enc.finish();

    // shared(1) + suffix_len(1) + "s"(1) + posting_count(1) + delta(1).
    try std.testing.expectEqual(@as(usize, 5), out.items.len - before);
    try std.testing.expectEqual(@as(u8, 4), out.items[before]);
    try std.testing.expectEqual(@as(u8, 's'), out.items[before + 2]);
}

test "terms out of order are refused rather than front-coded against the wrong predecessor" {
    const gpa = std.testing.allocator;
    var out: std.ArrayList(u8) = .empty;
    defer out.deinit(gpa);

    var enc = try Encoder.begin(gpa, &out, &.{"0123456789abcdef0123456789abcdef"});
    defer enc.deinit();
    try enc.addTerm("nota", &.{0});
    try std.testing.expectError(error.TermsOutOfOrder, enc.addTerm("agua", &.{0}));
    // A repeat is also out of order: two records for one term would give the
    // client two posting lists and no rule for which wins.
    try std.testing.expectError(error.TermsOutOfOrder, enc.addTerm("nota", &.{0}));
}

test "a posting list that repeats or descends is refused, because the gap would encode as zero" {
    const gpa = std.testing.allocator;
    var out: std.ArrayList(u8) = .empty;
    defer out.deinit(gpa);

    var enc = try Encoder.begin(gpa, &out, &golden_docs);
    defer enc.deinit();
    try std.testing.expectError(error.PostingsOutOfOrder, enc.addTerm("nota", &.{ 1, 1 }));
    try std.testing.expectError(error.PostingsOutOfOrder, enc.addTerm("nota", &.{ 2, 1 }));
    try std.testing.expectError(error.EmptyPostingList, enc.addTerm("nota", &.{}));
    try std.testing.expectError(error.OrdinalOutOfRange, enc.addTerm("nota", &.{4}));
}

test "an md5 that is not 32 lowercase hex characters never reaches the wire" {
    const gpa = std.testing.allocator;
    var out: std.ArrayList(u8) = .empty;
    defer out.deinit(gpa);

    // Uppercase is rejected on purpose: the decoder emits lowercase, so a payload
    // spelling the md5 differently from the manifest would read as a document the
    // client has never seen and be fetched again on every visit.
    try std.testing.expectError(error.InvalidMd5, Encoder.begin(gpa, &out, &.{
        "0123456789ABCDEF0123456789ABCDEF",
    }));
    try std.testing.expectError(error.InvalidMd5, Encoder.begin(gpa, &out, &.{"0123"}));
}

test "varints round-trip the sizes a real library reaches" {
    const gpa = std.testing.allocator;
    var out: std.ArrayList(u8) = .empty;
    defer out.deinit(gpa);

    // 127/128 is the one-to-two byte boundary; 16,383/16,384 the two-to-three.
    // A library of 1,222 files (`search-baseline.md` §1) crosses the first on
    // ordinals and the corpus's 63,578 terms cross the second on nothing yet —
    // but a note-heavy library's posting lists will (§2.1's inverting ratio).
    for ([_]u64{ 0, 1, 127, 128, 16_383, 16_384, 78_646, 1 << 31 }) |v| {
        out.clearRetainingCapacity();
        try appendVarint(gpa, &out, v);

        var got: u64 = 0;
        var shift: u6 = 0;
        for (out.items) |b| {
            got |= @as(u64, b & 0x7f) << shift;
            shift += 7;
        }
        try std.testing.expectEqual(v, got);
    }
}

// ---------------------------------------------------------------------------
// Tests — the manifest and the tiering
// ---------------------------------------------------------------------------

const testing = std.testing;
const schema = @import("../../db/schema.zig");
const blobstore = @import("../../store/blobs.zig");
const thumbstore = @import("../../store/thumbs.zig");
const query = @import("query.zig");
const nb = @import("note_builder");
const deferred = @import("../deferred.zig");
const noteindex = @import("../note_index.zig");

/// This module, so the fixture can call the exported `manifest` without the
/// method of the same name shadowing it.
const index_export = @This();

/// The tier expression as the manifest spells it, so a test can read it.
const tier_expr_d = tierExpr("d");

/// Two users, a blob store, and the real `Files` service — so every file a test
/// makes goes through `putFile` and is indexed exactly as an upload is. Nothing
/// here inserts into `files` or `note_index` by hand: the manifest's whole job is
/// to describe what the ingest path produced, and a fixture that wrote the rows
/// itself would be asserting against its own opinion.
const Fixture = struct {
    db: sqlite.Db,
    files: filesvc.Files,
    tmp: testing.TmpDir,
    arena: std.heap.ArenaAllocator,
    /// The DB lock the deferred worker takes around its own write transaction.
    /// Single-threaded here, but `drainNow` demands a real one.
    lock: std.Io.Mutex = .init,

    fn init() !Fixture {
        const db = try sqlite.Db.openMemory();
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

    /// A real `.note` container whose single page carries `labels` as finished
    /// recognition — a note by the INDEXER's verdict, which is what tier 1 asks.
    fn putNote(f: *Fixture, user_id: u64, name: []const u8, labels: []const []const u8) !u64 {
        const bytes = try nb.serialize(testing.allocator, .{ .pages = &.{.{
            .layers = &.{.{ .slot = .main, .bitmap = "AAAA" }},
            .recogn_status = 1,
            .recogn_labels = labels,
        }} });
        defer testing.allocator.free(bytes);
        return f.putBytes(user_id, name, bytes);
    }

    /// Bytes the indexer cannot parse as a `.note` — a PDF, an EPUB, an image.
    /// The CONTENT is what makes it one, never the name.
    fn putBytes(f: *Fixture, user_id: u64, name: []const u8, bytes: []const u8) !u64 {
        var r = std.Io.Reader.fixed(bytes);
        const e = try f.files.putFile(user_id, null, name, &r, null);
        defer testing.allocator.free(e.name);
        if (e.md5) |m| testing.allocator.free(m);
        return e.id;
    }

    /// Run the deferred worker to exhaustion, exactly as the server's background
    /// thread would. The REAL worker and the real tenants: a fixture that wrote
    /// `note_index.txt_index` by hand would be asserting the manifest agrees with
    /// the fixture's opinion of what "derived" means, which is the second opinion
    /// `pending-ness.md` §3 exists to forbid.
    fn drain(f: *Fixture) void {
        deferred.drainNow(testing.allocator, f.db, f.files.blobs, &f.lock, testing.io);
    }

    /// `updated_at` comes from the clock on the ingest path, so a test about §3's
    /// within-tier recency has to state the timestamps rather than race it.
    fn touch(f: *Fixture, id: u64, at: i64) !void {
        var s = try f.db.prepare("UPDATE files SET updated_at = ?2 WHERE id = ?1;");
        defer s.finalize();
        s.bindInt(1, @intCast(id));
        s.bindInt(2, at);
        _ = try s.step();
    }

    fn manifest(f: *Fixture, user_id: u64) !Manifest {
        return index_export.manifest(f.a(), f.db, user_id);
    }

    /// The manifest's row for `file_id`, or null when it is absent. "Absent" is
    /// the assertion several tests below make, so it gets a name.
    fn rowFor(f: *Fixture, user_id: u64, file_id: u64) !?Row {
        const m = try f.manifest(user_id);
        for (m.rows) |r| if (r.file_id == @as(i64, @intCast(file_id))) return r;
        return null;
    }
};

test "the manifest arrives in the fill order: notes, then anything annotated, then everything else" {
    var f = try Fixture.init();
    defer f.deinit();

    // One document per tier, uploaded in the WRONG order and timestamped so that
    // recency alone would reverse them — the bulk file is the newest thing in the
    // library. Tier has to win, or `client-side-search.md` §3's whole argument
    // (684 bytes and the household's own handwriting is searchable) collapses
    // into "whatever was touched last".
    const bulk = try f.putBytes(1, "Don Quijote.txt", "windmills");
    const annotated = try f.putBytes(1, "Plano diretor.pdf", "%PDF-1.4 zoning");
    _ = try f.putBytes(1, "Plano diretor.pdf.mark", "ink");
    const own = try f.putNote(1, "BuJo.note", &.{"segunda-feira"});
    try f.touch(bulk, 3_000);
    try f.touch(annotated, 2_000);
    try f.touch(own, 1_000);

    const m = try f.manifest(1);
    // Three rows, not four: the `.mark` is a layer of the PDF, not a document.
    try testing.expectEqual(@as(usize, 3), m.rows.len);
    try testing.expectEqual(Tier.note, m.rows[0].tier);
    try testing.expectEqual(@as(i64, @intCast(own)), m.rows[0].file_id);
    try testing.expectEqual(Tier.marked, m.rows[1].tier);
    try testing.expectEqual(@as(i64, @intCast(annotated)), m.rows[1].file_id);
    try testing.expectEqual(Tier.other, m.rows[2].tier);
    try testing.expectEqual(@as(i64, @intCast(bulk)), m.rows[2].file_id);
}

test "within a tier the newest document comes first, and a tie is still deterministic" {
    var f = try Fixture.init();
    defer f.deinit();

    // §3: "Extension gives the coarse relevance split, recency the fine one."
    // The failure this catches is a missing ORDER BY reading as correct because
    // rowid order happened to agree — so the ids ASCEND while the timestamps
    // DESCEND, and only a real sort can produce the expected answer.
    const oldest = try f.putNote(1, "a.note", &.{"alpha"});
    const middle = try f.putNote(1, "b.note", &.{"bravo"});
    const newest = try f.putNote(1, "c.note", &.{"charlie"});
    try f.touch(oldest, 100);
    try f.touch(middle, 200);
    try f.touch(newest, 300);

    var m = try f.manifest(1);
    try testing.expectEqual(@as(i64, @intCast(newest)), m.rows[0].file_id);
    try testing.expectEqual(@as(i64, @intCast(middle)), m.rows[1].file_id);
    try testing.expectEqual(@as(i64, @intCast(oldest)), m.rows[2].file_id);

    // Same second for all three — a household importing a folder produces
    // exactly this. The order must still be total, because the client fetches in
    // the order it receives and an unstable one makes the fill non-reproducible
    // (and this test flaky, which is how it would be discovered).
    for ([_]u64{ oldest, middle, newest }) |id| try f.touch(id, 500);
    m = try f.manifest(1);
    try testing.expectEqual(@as(i64, @intCast(oldest)), m.rows[0].file_id);
    try testing.expectEqual(@as(i64, @intCast(middle)), m.rows[1].file_id);
    try testing.expectEqual(@as(i64, @intCast(newest)), m.rows[2].file_id);
}

test "an annotated EPUB is tier 2, because the rule asks for a sibling and never for a format" {
    var f = try Fixture.init();
    defer f.deinit();

    // THE BUG §0.2 FIXED, asserted from the tier side. The pairing rule used to
    // be `LIKE '%.pdf.mark'`, which quietly made it PDF-only — and the device
    // annotates formats this server does not render at all. An annotated
    // `book.epub` was un-folded, un-carried and un-hidden everywhere; here it
    // would land in tier 3 beside the novels, and the household's most-used
    // document would be the LAST thing to become searchable.
    //
    // Enumerating the extensions we happen to know about is the same bug with
    // more entries. The sibling's existence is the only fact that decides it.
    const epub = try f.putBytes(1, "Os Lusíadas.epub", "EPUB bytes");
    _ = try f.putBytes(1, "Os Lusíadas.epub.mark", "ink");
    const plain = try f.putBytes(1, "Os Lusíadas cópia.epub", "EPUB bytes, unannotated");

    try testing.expectEqual(Tier.marked, (try f.rowFor(1, epub)).?.tier);
    try testing.expectEqual(Tier.other, (try f.rowFor(1, plain)).?.tier);

    // And structurally, so the rule cannot be re-narrowed by someone who has not
    // read the paragraph above: the TIER EXPRESSION names no file format
    // anywhere. It borrows `files.zig`'s generator; a hand-written
    // `LIKE '%.pdf.mark'` — or a `.note` extension test for tier 1 — fails here
    // before any fixture is built.
    //
    // ASSERTED OVER `tierExpr`, NOT OVER THE WHOLE STATEMENT, and the narrowing
    // is deliberate rather than a retreat. `manifest_sql` now embeds the deferred
    // tenants' own predicate (`owes_derive_expr`), which is `LIKE '%_.txt'` and
    // `LIKE '%_.pdf'` — extensions, in this file's SQL, and correctly so: those
    // tenants really are format-specific, and copying their rule anywhere is what
    // §3 forbids, not naming a format at all. Asserted over the whole statement
    // this line would only ever be satisfiable by NOT sharing the predicate,
    // which is the opposite of what it is guarding.
    // `.mark` is NOT on the list and never was: `hasPairedMark` spells it, which
    // is the pairing rule itself rather than a format test.
    inline for ([_][]const u8{ ".pdf", ".epub", ".note", ".txt" }) |ext| {
        try testing.expect(std.mem.indexOf(u8, tier_expr_d, ext) == null);
    }
}

test "tier 1 is the indexer's verdict, not the file's name" {
    var f = try Fixture.init();
    defer f.deinit();

    // The same "verified, not claimed" rule the coverage count states: a PDF or a
    // PNG is not an unsearchable note, it is not a note. So bytes that do not
    // parse as a `.note` container are tier 3 however they are named, and real
    // note bytes are tier 1 however they are named. A filename test would get
    // both of these backwards, and the household would fill its index with
    // whatever happened to be called `.note`.
    const liar = try f.putBytes(1, "not-really.note", "PNG\x89 not a note at all");
    const honest = try f.putNote(1, "handwriting.bin", &.{"caligrafia"});

    try testing.expectEqual(Tier.other, (try f.rowFor(1, liar)).?.tier);
    try testing.expectEqual(Tier.note, (try f.rowFor(1, honest)).?.tier);
}

test "a paired .mark is in no tier and in no coverage denominator" {
    var f = try Fixture.init();
    defer f.deinit();

    // A `.mark` IS a `.note` container, so the indexer calls it indexable and it
    // would be tier 1 — the household's "own handwriting" tier filled with ink
    // layers of documents, each also a search result of its own for a file no
    // listing has ever shown. It was on the unsearchable side of the coverage
    // fraction for the same reason (ink carries no recognised text), which made
    // both halves wrong.
    const pdf = try f.putBytes(1, "Trip notes.pdf", "%PDF-1.4 itinerary");
    const mark_bytes = try nb.serialize(testing.allocator, .{ .pages = &.{.{
        .layers = &.{.{ .slot = .main, .bitmap = "AAAA" }},
    }} });
    defer testing.allocator.free(mark_bytes);
    const mark = try f.putBytes(1, "Trip notes.pdf.mark", mark_bytes);

    const m = try f.manifest(1);
    try testing.expectEqual(@as(usize, 1), m.rows.len);
    try testing.expectEqual(@as(i64, @intCast(pdf)), m.rows[0].file_id);
    try testing.expectEqual(Tier.marked, m.rows[0].tier);
    try testing.expect((try f.rowFor(1, mark)) == null);
    // Not a note of anybody's, so neither half of the fraction moves.
    try testing.expectEqual(@as(i64, 0), m.coverage.notes);
    try testing.expectEqual(@as(i64, 0), m.coverage.unsearchable);

    // An ORPHANED mark still lists — the same answer every other listing gives,
    // because with no document beside it the ink is the only remaining trace and
    // hiding it would make it unreachable while it went on consuming quota. It is
    // a `.note` container, so it is tier 1: the household's own handwriting,
    // which is exactly what it is.
    //
    // NOTE that the orphan has to be MADE one, not made by trashing: a pair
    // travels as one object, so trashing `Trip notes.pdf` takes its mark to the
    // bin with it and neither is in the manifest afterwards. That is the pairing
    // rule working, and it is asserted here rather than assumed because a version
    // of it that hid the mark from listings but left it behind on delete is
    // precisely the "conjuring" bug `files.zig` records.
    try f.files.trash(1, pdf);
    try testing.expectEqual(@as(usize, 0), (try f.manifest(1)).rows.len);

    const orphan = try f.putBytes(1, "Nobody's book.epub.mark", mark_bytes);
    try testing.expectEqual(Tier.note, (try f.rowFor(1, orphan)).?.tier);
}

test "the manifest is COMPLETE: a document with nothing to say is still a row" {
    var f = try Fixture.init();
    defer f.deinit();

    // THE CORRECTNESS PROPERTY, driven rather than reasoned about. §2.2: sync is
    // additive, so nothing on the wire ever removes anything; a trashed file
    // stops matching only because it is ABSENT from the next COMPLETE manifest
    // and the client diffs the whole set. Every row a filter drops is therefore
    // read by the client as a deletion — of a document that is still there.
    //
    // These four are exactly the rows the tempting filters would drop:
    const png = try f.putBytes(1, "scan.png", "\x89PNG not text at any point"); // never searchable
    const note = try f.putNote(1, "blank.note", &.{}); // a note with NO recognised text
    const pdf = try f.putBytes(1, "book.pdf", "%PDF-1.4"); // derived later, by the worker
    const dup = try f.putBytes(1, "scan copy.png", "\x89PNG not text at any point"); // same BLOB as `png`

    // And one the "only rows that have terms" filter would drop hardest: a blob
    // with no `note_index` row at all, which is what a just-uploaded file looks
    // like for as long as the derive is outstanding. Deleting the row simulates
    // that window without reaching into the worker.
    try f.db.exec("DELETE FROM note_index WHERE blob_md5 = (SELECT md5 FROM files WHERE name = 'book.pdf');");

    const m = try f.manifest(1);
    try testing.expectEqual(@as(usize, 4), m.rows.len);
    for ([_]u64{ png, note, pdf, dup }) |id| try testing.expect((try f.rowFor(1, id)) != null);

    // Two files, one blob, TWO rows — and this is not an oversight. Removal is
    // per FILE: trashing one copy must reach the client, and an md5-keyed
    // manifest could not express it, because the md5 would still be present.
    const a_row = (try f.rowFor(1, png)).?;
    const b_row = (try f.rowFor(1, dup)).?;
    try testing.expectEqualStrings(a_row.md5, b_row.md5);

    // The row with no index row at all still carries an md5 the client can key a
    // FETCH on; what it cannot carry is a cache key, and it says so with a null
    // `index_version` rather than by vanishing.
    try testing.expect((try f.rowFor(1, pdf)).?.index_version == null);

    // EXACTLY ONCE, which is the other half of complete and the one a join
    // introduces rather than a filter. Every document is in one tier and appears
    // in one row; a fan-out — a joined table with two rows for a blob — would
    // make the client's "91.5% still loading" progress line count the same
    // document twice, and its set diff would never converge.
    for (m.rows, 0..) |r, i| for (m.rows[i + 1 ..]) |other| try testing.expect(r.file_id != other.file_id);
}

test "a trashed file is absent from the manifest, which is the only way removal ever reaches the client" {
    var f = try Fixture.init();
    defer f.deinit();

    const keep = try f.putNote(1, "keep.note", &.{"fica"});
    const gone = try f.putNote(1, "gone.note", &.{"sai"});
    try testing.expectEqual(@as(usize, 2), (try f.manifest(1)).rows.len);

    try f.files.trash(1, gone);

    const m = try f.manifest(1);
    try testing.expectEqual(@as(usize, 1), m.rows.len);
    try testing.expectEqual(@as(i64, @intCast(keep)), m.rows[0].file_id);
    // The blob and its terms are untouched and still perfectly valid bytes —
    // which is the point. Nothing was tombstoned, nothing was invalidated; the
    // document left the set, and the set is the message.
    try testing.expect((try f.rowFor(1, gone)) == null);
}

test "one household member's manifest never contains another's documents" {
    var f = try Fixture.init();
    defer f.deinit();

    // The manifest is a LISTING, and a listing that leaked would hand a housemate
    // the md5s with which to request the term payloads — which are served per
    // md5 and are byte-identical between users by design (§2.4). Authorization
    // for those is a `files` join per request; this is the same rule one step
    // earlier, and the leak here is what would make the md5s guessable at all.
    const mine = try f.putNote(1, "meu.note", &.{"particular"});
    const theirs = try f.putNote(2, "dele.note", &.{"particular"});

    // IDENTICAL bytes under both users, so the two share one blob: the row set is
    // separated by `user_id` and never by content, and a query that reached the
    // library through the blob would return both.
    const shared = try f.putNote(1, "compartilhado.note", &.{"mesmo texto"});
    const shared_2 = try f.putNote(2, "compartilhado.note", &.{"mesmo texto"});

    const m1 = try f.manifest(1);
    try testing.expectEqual(@as(usize, 2), m1.rows.len);
    for (m1.rows) |r| try testing.expect(r.file_id != @as(i64, @intCast(theirs)) and
        r.file_id != @as(i64, @intCast(shared_2)));
    try testing.expect((try f.rowFor(1, mine)) != null);
    try testing.expect((try f.rowFor(1, shared)) != null);

    const m2 = try f.manifest(2);
    try testing.expectEqual(@as(usize, 2), m2.rows.len);
    try testing.expect((try f.rowFor(2, mine)) == null);

    // And the shared blob's md5 is the SAME string in both manifests — §4's
    // contract, and the reason the terms route can be user-independent.
    try testing.expectEqualStrings(
        (try f.rowFor(1, shared)).?.md5,
        (try f.rowFor(2, shared_2)).?.md5,
    );
}

test "the manifest's coverage counts are the ones `coverageOf` produces today" {
    var f = try Fixture.init();
    defer f.deinit();

    // THE BRIDGE, and it is temporary by design: §2.2 keeps these two numbers on
    // the manifest so that `coverageLine` keeps its sentence when `coverageOf` is
    // DELETED in step 9. Until then both exist, and the only way to know the
    // sentence will not change under the household is to drive them against each
    // other over a library that exercises every case they disagree about.
    //
    // DELETE THIS TEST WITH `coverageOf`. It has no other subject.
    _ = try f.putNote(1, "recognised.note", &.{"tem texto"});
    _ = try f.putNote(1, "blank-a.note", &.{});
    _ = try f.putNote(1, "blank-b.note", &.{});
    _ = try f.putBytes(1, "book.pdf", "%PDF-1.4"); // not a note: in neither half
    _ = try f.putBytes(1, "book.pdf.mark", "ink"); // paired: in neither half
    const trashed = try f.putNote(1, "trashed.note", &.{});
    try f.files.trash(1, trashed);

    // A query nothing matches, because `coverageOf` is only ever reached from the
    // zero-hit exit — which is also the only place the sentence is rendered.
    const r = try query.searchPages(f.a(), testing.io, f.db, 1, "xyzzynomatch ", 10, null);
    try testing.expectEqual(@as(usize, 0), r.hits.len);
    const server = r.coverage.?;

    const m = try f.manifest(1);
    try testing.expectEqual(server.notes, m.coverage.notes);
    try testing.expectEqual(server.unsearchable, m.coverage.unsearchable);
    // Stated absolutely as well, so that two implementations agreeing on the
    // wrong answer cannot pass: three notes, two of them without text.
    try testing.expectEqual(@as(i64, 3), m.coverage.notes);
    try testing.expectEqual(@as(i64, 2), m.coverage.unsearchable);
}

test "a just-uploaded document is PENDING, and stops being pending when the worker finishes" {
    var f = try Fixture.init();
    defer f.deinit();

    // THE SEAM, FILLED — `pending-ness.md` §8's first sentence, asked of the
    // manifest instead of the count. This replaces the tripwire that pinned
    // "every row says `unknown`"; that test existed only to make the seam
    // impossible to fill silently, and it has done its job.
    //
    // What the client does with this is the whole reason it is here: a `.txt`
    // whose derive has not run has no terms, and so does a document that folds
    // to nothing. On the wire the two are the same empty set. `derived` is a
    // licence to cache that emptiness for ever; `pending` is an instruction to
    // ask again. Getting it backwards on this row would make `notes.txt`
    // unsearchable in the browser permanently, with no error anywhere
    // (`client-side-search.md` §4.1).
    const txt = try f.putBytes(1, "notes.txt", "Primeiro parágrafo.\n\nSegundo parágrafo.\n");
    try testing.expectEqual(Derivation.pending, (try f.rowFor(1, txt)).?.derivation);

    f.drain();
    try testing.expectEqual(Derivation.derived, (try f.rowFor(1, txt)).?.derivation);
}

test "a derived blob with no text is DERIVED and stays cacheable — the other half of the trap" {
    var f = try Fixture.init();
    defer f.deinit();

    // §8's second sentence, and the fix for one must not break the other. §4 is
    // explicit that an empty term set is a legitimate FINAL answer; a manifest
    // that reported everything textless as `pending` to be safe would make every
    // blank note a fetch on every visit, for ever, and the tiering that pays for
    // itself would be paying for nothing.
    const blank = try f.putNote(1, "blank.note", &.{});
    const scan = try f.putBytes(1, "scan.png", "\x89PNG not text at any point");
    f.drain();

    try testing.expectEqual(Derivation.derived, (try f.rowFor(1, blank)).?.derivation);
    try testing.expectEqual(Derivation.derived, (try f.rowFor(1, scan)).?.derivation);
}

test "a .note is never pending, because nothing is owed for it" {
    var f = try Fixture.init();
    defer f.deinit();

    // `pending.zig`'s header states this for the count and it is inherited here
    // verbatim: the note half is indexed INSIDE the upload transaction, so no
    // tenant owes it anything the moment it lands. Reported honestly, that is
    // `derived` from the first visit — which is what makes tier 1 ("the
    // household's own handwriting", 684 B gzip) searchable after one round trip
    // instead of after a worker pass.
    const note = try f.putNote(1, "BuJo.note", &.{"segunda-feira"});
    try testing.expectEqual(Derivation.derived, (try f.rowFor(1, note)).?.derivation);
}

test "no row ever reports UNKNOWN now that the seam is filled" {
    var f = try Fixture.init();
    defer f.deinit();

    // `owes_derive_expr` is an `EXISTS`, so it answers 0 or 1 for every row and
    // the `unknown` arm in `Cursor.next` is unreachable. Driven over one document
    // of every kind the manifest can hold — including a blob with no `note_index`
    // row at all, which is the shape most likely to produce a NULL from a
    // carelessly-written predicate.
    _ = try f.putNote(1, "own.note", &.{"texto"});
    _ = try f.putBytes(1, "notes.txt", "parágrafo\n\noutro\n");
    _ = try f.putBytes(1, "book.pdf", "%PDF-1.4");
    _ = try f.putBytes(1, "book.pdf.mark", "ink");
    _ = try f.putBytes(1, "scan.png", "\x89PNG");
    try f.db.exec("DELETE FROM note_index WHERE blob_md5 = (SELECT md5 FROM files WHERE name = 'scan.png');");

    const m = try f.manifest(1);
    try testing.expectEqual(@as(usize, 4), m.rows.len);
    for (m.rows) |r| try testing.expect(r.derivation != .unknown);
}

test "CAVEAT: a stale note_index row reports DERIVED though nothing has derived it" {
    var f = try Fixture.init();
    defer f.deinit();

    // THE UNDER-REPORT, DRIVEN RATHER THAN FOOTNOTED — `pending-ness.md` §11.4.
    // Every tenant's clause requires a CURRENT `note_index` row, because the note
    // half heals first and its heal rewrites what the tenant writes into. So a
    // blob whose row is stale is not offered to the worker, is therefore not
    // "owed", and this column says `derived` about a document nothing has read.
    //
    // That is the price of §3's property — the column agrees with the WORKER, and
    // agreeing with the worker is what stops it from becoming a second opinion —
    // and it is safe for exactly one reason: `index_version` rides beside it on
    // every row, and §4's cache key is `(md5, index_version)`. A client keyed on
    // both refetches when the heal bumps the row; a client keyed on md5 alone
    // would cache this document's emptiness for ever. Whoever builds that cache
    // must read this test.
    const txt = try f.putBytes(1, "notes.txt", "parágrafo um\n\nparágrafo dois\n");
    try testing.expectEqual(Derivation.pending, (try f.rowFor(1, txt)).?.derivation);

    try f.db.exec("UPDATE note_index SET index_version = index_version - 1;");
    const stale = (try f.rowFor(1, txt)).?;
    try testing.expectEqual(Derivation.derived, stale.derivation);
    // …and the row says so, which is the escape hatch: the version the client
    // would key its cache on is not the current one.
    try testing.expect(stale.index_version.? != noteindex.index_version);
}

// ---------------------------------------------------------------------------
// Tests — the manifest on the wire, and its golden vector
// ---------------------------------------------------------------------------

/// The checked-in manifest payload the browser decodes. Pinned exactly as the
/// term payload is: encoded here, decoded in
/// `webapp/tests/unit/manifestCodec.test.ts` against expectations written out by
/// hand on BOTH sides. Regenerating it to make one side pass turns the other
/// red, which is the only arrangement that catches a format change made in one
/// place.
const manifest_golden = @embedFile("testdata/manifest_golden.bin");

/// The golden manifest's rows, chosen so every branch of `writeManifest` appears
/// at least once and a reader of the hex dump can see which is which:
///
///   7    tier 1, derived, current index_version — the ordinary row
///   8    tier 1 again, so the `updated_at` GAP is exercised inside a tier, and
///        `pending`, so the flags byte's high nibble is not always zero
///   300  the tier CHANGES, so the timestamp is a fresh ABSOLUTE anchor rather
///        than a gap; a file_id past 127, so its varint is two bytes; and NO
///        index_version, which is a blob nothing has looked at yet
///   301  tier changes again — a second anchor — and back to `derived`
///   302  a second row in the last tier, so a real gap is encoded after an anchor
///        as well as before one, and `index_version` ZERO, which is a version and
///        not an absence
const golden_manifest: Manifest = .{
    .coverage = .{ .notes = 3, .unsearchable = 1 },
    .rows = &.{
        .{ .file_id = 7, .md5 = "0123456789abcdef0123456789abcdef", .updated_at = 1_700_000_000, .index_version = 15, .tier = .note, .derivation = .derived },
        .{ .file_id = 8, .md5 = "fedcba9876543210fedcba9876543210", .updated_at = 1_699_990_000, .index_version = 15, .tier = .note, .derivation = .pending },
        .{ .file_id = 300, .md5 = "00112233445566778899aabbccddeeff", .updated_at = 1_600_000_000, .index_version = null, .tier = .marked, .derivation = .pending },
        .{ .file_id = 301, .md5 = "d41d8cd98f00b204e9800998ecf8427e", .updated_at = 1_599_999_999, .index_version = 3, .tier = .other, .derivation = .derived },
        .{ .file_id = 302, .md5 = "ffffffffffffffffffffffffffffffff", .updated_at = 1_500_000_000, .index_version = 0, .tier = .other, .derivation = .derived },
    },
};

// The golden manifest payload, byte for byte, 130 bytes. Written out so that a
// reviewer can check the file with `xxd` and nothing else.
//
//   53 4d 41 4e              "SMAN"
//   01                       manifest_format_version = 1
//   05 00 00 00              row_count = 5
//   03                       coverage.notes = 3
//   01                       coverage.unsearchable = 1
//
//   0123456789abcdef0123456789abcdef   md5
//   01                       flags: tier 1 (note), derivation 0 (derived)
//   07                       file_id 7
//   80 e2 cf aa 06           updated_at 1,700,000,000 ABSOLUTE — first row of a tier
//   10                       index_version 15, +1
//
//   fedcba9876543210fedcba9876543210   md5
//   11                       flags: tier 1, derivation 1 (pending)
//   08                       file_id 8
//   90 4e                    gap 10,000 — same tier, so it is a gap
//   10                       index_version 15, +1
//
//   00112233445566778899aabbccddeeff   md5
//   12                       flags: tier 2 (marked), derivation 1 (pending)
//   ac 02                    file_id 300 — two varint bytes
//   80 a0 f8 fa 05           updated_at 1,600,000,000 ABSOLUTE — the tier CHANGED
//   00                       index_version ABSENT
//
//   d41d8cd98f00b204e9800998ecf8427e   md5
//   03                       flags: tier 3 (other), derivation 0
//   ad 02                    file_id 301
//   ff 9f f8 fa 05           updated_at 1,599,999,999 ABSOLUTE — tier changed again
//   04                       index_version 3, +1
//
//   ffffffffffffffffffffffffffffffff   md5
//   03                       flags: tier 3, derivation 0
//   ae 02                    file_id 302
//   ff c1 d7 2f              gap 99,999,999 — same tier, so it is a real gap
//   01                       index_version 0, +1 — zero is a REAL version

test "the golden manifest encodes byte for byte" {
    const gpa = std.testing.allocator;
    var out: std.ArrayList(u8) = .empty;
    defer out.deinit(gpa);

    try writeManifest(gpa, &out, golden_manifest);

    // NOT a round-trip, for the same reason the term golden is not: the bytes are
    // checked in and the browser's suite decodes THIS FILE against expectations
    // written out by hand there. "Fixing" this assertion by regenerating the file
    // turns that suite red.
    try testing.expectEqualSlices(u8, manifest_golden, out.items);
}

test "the golden manifest is the size its annotated dump claims" {
    // Header 9 + two coverage varints + five rows. A different total means the
    // dump above has drifted from the encoder and stopped being verifiable by
    // reading it.
    try testing.expectEqual(@as(usize, 130), manifest_golden.len);
    try testing.expectEqual(@as(usize, 9), manifest_header_len);
    try testing.expectEqualSlices(u8, manifest_magic, manifest_golden[0..4]);
    try testing.expectEqual(manifest_format_version, manifest_golden[4]);
}

test "index_version ZERO is a real version and not an absent one" {
    // The `+1` in the encoding exists for exactly this row. A blob indexed at
    // version 0 and a blob with no index row at all are different facts — one is
    // cacheable under `(md5, 0)` and the other cannot be cached at all — and a
    // naive "0 means absent" merges them and hands the client a cache key it must
    // not use.
    const gpa = std.testing.allocator;
    var absent: std.ArrayList(u8) = .empty;
    defer absent.deinit(gpa);
    var zero: std.ArrayList(u8) = .empty;
    defer zero.deinit(gpa);
    const row: Row = .{
        .file_id = 1,
        .md5 = "0123456789abcdef0123456789abcdef",
        .updated_at = 0,
        .index_version = null,
        .tier = .note,
        .derivation = .derived,
    };
    var row_zero = row;
    row_zero.index_version = 0;
    try writeManifest(gpa, &absent, .{ .rows = &.{row}, .coverage = .{} });
    try writeManifest(gpa, &zero, .{ .rows = &.{row_zero}, .coverage = .{} });
    try testing.expect(!std.mem.eql(u8, absent.items, zero.items));
}

test "an md5 the manifest cannot spell never reaches the wire" {
    const gpa = std.testing.allocator;
    var out: std.ArrayList(u8) = .empty;
    defer out.deinit(gpa);
    // Same rule the term payload enforces, and for the same reason: the md5 is
    // the client's cache key, and a manifest spelling it in a different case than
    // the term payload would read as a document the client has never seen.
    const bad: Row = .{
        .file_id = 1,
        .md5 = "0123456789ABCDEF0123456789ABCDEF",
        .updated_at = 0,
        .index_version = null,
        .tier = .note,
        .derivation = .derived,
    };
    try testing.expectError(error.InvalidMd5, writeManifest(gpa, &out, .{ .rows = &.{bad}, .coverage = .{} }));
}

test "the ETag is the body, so a manifest that lost a row cannot answer 304" {
    // THE CONDITIONAL REQUEST'S WHOLE ARGUMENT, driven. Absence from the manifest
    // is the ONLY removal channel this design has (§2.2), so a validator that
    // said "unchanged" over a manifest that had lost a row would leave a trashed
    // document matching in the browser for ever. A hash of the bytes cannot say
    // that; a version number maintained beside them could.
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;

    _ = try f.putNote(1, "keep.note", &.{"fica"});
    const gone = try f.putNote(1, "gone.note", &.{"sai"});

    var a: std.ArrayList(u8) = .empty;
    defer a.deinit(gpa);
    try writeManifest(gpa, &a, try f.manifest(1));
    const etag_before = bodyEtag(a.items);

    // Same library, asked twice: the validator must be STABLE, or every visit
    // refetches and the conditional request buys nothing at all.
    var again: std.ArrayList(u8) = .empty;
    defer again.deinit(gpa);
    try writeManifest(gpa, &again, try f.manifest(1));
    try testing.expectEqualSlices(u8, &etag_before, &bodyEtag(again.items));

    try f.files.trash(1, gone);
    var b: std.ArrayList(u8) = .empty;
    defer b.deinit(gpa);
    try writeManifest(gpa, &b, try f.manifest(1));
    try testing.expect(!std.mem.eql(u8, &etag_before, &bodyEtag(b.items)));
}

test "the manifest carries no document names, and that is a decision" {
    // §3 step 3 omitted them deliberately: names would balloon the one response
    // paid on every visit, and a locally-answered result set gets them from the
    // file listing the app already holds, keyed on `file_id`. Asserted rather
    // than trusted, because "just add the name" is a one-line change that costs
    // every household bytes on every visit for ever.
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;
    _ = try f.putNote(1, "Reunião trimestral.note", &.{"pauta"});

    var out: std.ArrayList(u8) = .empty;
    defer out.deinit(gpa);
    try writeManifest(gpa, &out, try f.manifest(1));
    try testing.expect(std.mem.indexOf(u8, out.items, "Reuni") == null);
    try testing.expect(std.mem.indexOf(u8, out.items, ".note") == null);

    // And the size that buys: a row is a fixed 16 + 1 plus three varints, so the
    // payload is bounded by the row count and by nothing a user can type.
    try testing.expect(out.items.len < manifest_header_len + 2 + 32);
    // The absolute anchor really is there: the one row's timestamp must survive
    // the round trip, and a zero here would mean it had not.
    try testing.expect(out.items[out.items.len - 6] != 0);
}

// ---------------------------------------------------------------------------
// Tests — the term payload for a batch, and §2.4's join
// ---------------------------------------------------------------------------

fn exportTerms(f: *Fixture, user_id: u64, md5s: []const []const u8) ![]const u8 {
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(testing.allocator);
    try writeTerms(f.a(), testing.allocator, &out, f.db, user_id, md5s);
    return out.toOwnedSlice(testing.allocator);
}

/// How many documents the payload's ordinal table names — which is the whole
/// subject of the authorization tests, because "covered" and "not covered" is
/// exactly what the join decides.
fn docCountOf(payload: []const u8) u32 {
    return std.mem.readInt(u32, payload[5..9], .little);
}

fn termCountOf(payload: []const u8) u32 {
    return std.mem.readInt(u32, payload[9..13], .little);
}

fn payloadCovers(payload: []const u8, md5_hex: []const u8) bool {
    var raw: [16]u8 = undefined;
    md5FromHex(md5_hex, &raw) catch return false;
    const table = payload[header_len..][0 .. docCountOf(payload) * 16];
    var i: usize = 0;
    while (i < table.len) : (i += 16) {
        if (std.mem.eql(u8, table[i..][0..16], &raw)) return true;
    }
    return false;
}

fn md5Of(f: *Fixture, file_id: u64) ![]const u8 {
    var s = try f.db.prepare("SELECT md5 FROM files WHERE id = ?1;");
    defer s.finalize();
    s.bindInt(1, @intCast(file_id));
    _ = try s.step();
    return f.a().dupe(u8, s.columnText(0));
}

test "THE LEAK TEST: a caller who does not hold the md5 receives nothing, however well-formed the request" {
    var f = try Fixture.init();
    defer f.deinit();

    // §2.4, and the reason this route is its own entry point rather than a
    // parameter on an existing one. The BODY depends on md5 alone — that is what
    // makes it `immutable` and shareable between housemates — so the only thing
    // between a housemate's md5 and their document's entire vocabulary is the
    // `files` join, per request. `query.zig`'s module docs warn that "a second
    // entry point would be a place to forget it"; this is that second entry
    // point, and this is that test.
    //
    // The md5 is not a secret and must not be treated as one: it is 32 characters
    // sitting in the other person's own manifest, and it is the SAME 32
    // characters for identical bytes under both accounts, by design (§4).
    const mine = try f.putNote(1, "meu.note", &.{"particular"});
    const theirs = try f.putNote(2, "dele.note", &.{"confidencial"});
    const mine_md5 = try md5Of(&f, mine);
    const theirs_md5 = try md5Of(&f, theirs);
    try testing.expect(!std.mem.eql(u8, mine_md5, theirs_md5));

    // Asking for BOTH: the caller's own document comes back and the housemate's
    // is absent from the ordinal table entirely — not empty, ABSENT — so the
    // response says nothing about whether it exists.
    const payload = try exportTerms(&f, 1, &.{ mine_md5, theirs_md5 });
    defer testing.allocator.free(payload);
    try testing.expectEqual(@as(u32, 1), docCountOf(payload));
    try testing.expect(payloadCovers(payload, mine_md5));
    try testing.expect(!payloadCovers(payload, theirs_md5));
    try testing.expect(termCountOf(payload) > 0);

    // And asking for the housemate's ALONE is an empty payload rather than an
    // error: an error would itself be an answer about somebody else's library.
    const only_theirs = try exportTerms(&f, 1, &.{theirs_md5});
    defer testing.allocator.free(only_theirs);
    try testing.expectEqual(@as(u32, 0), docCountOf(only_theirs));
    try testing.expectEqual(@as(u32, 0), termCountOf(only_theirs));

    // A trashed file is not held either — the bin is not the library, and the
    // same clause is what says so.
    try f.files.trash(1, mine);
    const after_trash = try exportTerms(&f, 1, &.{mine_md5});
    defer testing.allocator.free(after_trash);
    try testing.expectEqual(@as(u32, 0), docCountOf(after_trash));

    // An md5 nobody holds, and an "md5" that is not one at all.
    const nobody = try exportTerms(&f, 1, &.{"00000000000000000000000000000000"});
    defer testing.allocator.free(nobody);
    try testing.expectEqual(@as(u32, 0), docCountOf(nobody));
    var sink: std.ArrayList(u8) = .empty;
    defer sink.deinit(testing.allocator);
    try testing.expectError(
        error.InvalidMd5,
        writeTerms(f.a(), testing.allocator, &sink, f.db, 1, &.{"\" OR 1=1 --"}),
    );
}

test "STRUCTURAL: every statement that reads a term reaches `files` through the ONE clause" {
    // The other half of the leak test, and the half that catches what behaviour
    // cannot. VERIFIED by deleting each: removing the owner test from
    // `held_by_caller` fails the leak test and the HTTP one, but removing the
    // `files` join from `terms_sql` alone leaves every behavioural test GREEN —
    // the ordinal table happens to gate it — so only a structural assertion can
    // say that the defense-in-depth copy is still there. That is precisely the
    // deletion `query.zig`'s "a second entry point would be a place to forget it"
    // is about.
    try testing.expect(std.mem.indexOf(u8, held_sql, held_by_caller) != null);
    try testing.expect(std.mem.indexOf(u8, terms_sql, held_by_caller) != null);
    // Exactly ONE occurrence of the owner test in each: a second copy is a second
    // opinion, and the one that gets edited is never the one that matters.
    for ([_][]const u8{ held_sql, terms_sql }) |sql| {
        var count: usize = 0;
        var at: usize = 0;
        while (std.mem.indexOfPos(u8, sql, at, "user_id")) |i| : (at = i + 1) count += 1;
        try testing.expectEqual(@as(usize, 1), count);
    }
}

test "the same blob under two users ships a byte-identical payload" {
    var f = try Fixture.init();
    defer f.deinit();

    // §4's `partition_id`-is-not-identity claim, which is the whole reason this
    // route can be `immutable` and its cache entry shared between housemates. The
    // two hold the same bytes under different names, in different partitions,
    // with different file ids — and none of that may reach the wire.
    const mine = try f.putNote(1, "meu.note", &.{ "reunião", "trimestral" });
    const theirs = try f.putNote(2, "cópia dele.note", &.{ "reunião", "trimestral" });
    const md5 = try md5Of(&f, mine);
    try testing.expectEqualStrings(md5, try md5Of(&f, theirs));

    const a = try exportTerms(&f, 1, &.{md5});
    defer testing.allocator.free(a);
    const b = try exportTerms(&f, 2, &.{md5});
    defer testing.allocator.free(b);
    try testing.expectEqualSlices(u8, a, b);
    try testing.expect(termCountOf(a) > 0);
}

test "the payload is a function of the md5 SET, not of the order they were asked in" {
    var f = try Fixture.init();
    defer f.deinit();

    // What makes one cache entry serve two clients that asked differently — and
    // what makes the postings come out strictly ascending for free, because the
    // ordinal table is sorted. A payload that honoured request order would be a
    // different byte string per client for the same documents.
    const a_id = try f.putNote(1, "a.note", &.{"alpha"});
    const b_id = try f.putNote(1, "b.note", &.{"bravo"});
    const a_md5 = try md5Of(&f, a_id);
    const b_md5 = try md5Of(&f, b_id);

    const one = try exportTerms(&f, 1, &.{ a_md5, b_md5 });
    defer testing.allocator.free(one);
    const other = try exportTerms(&f, 1, &.{ b_md5, a_md5 });
    defer testing.allocator.free(other);
    try testing.expectEqualSlices(u8, one, other);

    // A duplicate in the request is one document, not two: an ordinal table with
    // a repeat would make the same document match twice in the browser.
    const dup = try exportTerms(&f, 1, &.{ a_md5, a_md5 });
    defer testing.allocator.free(dup);
    try testing.expectEqual(@as(u32, 1), docCountOf(dup));
}

test "a blob with no searchable text ships an EMPTY term set, not a missing one" {
    var f = try Fixture.init();
    defer f.deinit();

    // §4's third state, from the server side. A document that folds to nothing is
    // derived-and-EMPTY and the client must be able to cache that as final; a
    // document ABSENT from the payload is one it must ask about again. On the
    // wire the difference is the ordinal table and nothing else — so it is the
    // ordinal table this asserts.
    const blank = try f.putNote(1, "blank.note", &.{});
    const blank_md5 = try md5Of(&f, blank);

    const payload = try exportTerms(&f, 1, &.{blank_md5});
    defer testing.allocator.free(payload);
    try testing.expectEqual(@as(u32, 1), docCountOf(payload)); // PRESENT
    try testing.expectEqual(@as(u32, 0), termCountOf(payload)); // and EMPTY
    try testing.expect(payloadCovers(payload, blank_md5));

    const with_text = try f.putNote(1, "texto.note", &.{"reunião"});
    const both = try exportTerms(&f, 1, &.{ blank_md5, try md5Of(&f, with_text) });
    defer testing.allocator.free(both);
    try testing.expectEqual(@as(u32, 2), docCountOf(both));
    try testing.expect(termCountOf(both) > 0);
}

test "PLAN PIN: the term export reaches `files` by blob and never re-walks the caller's library" {
    var f = try Fixture.init();
    defer f.deinit();
    _ = try f.putNote(1, "n.note", &.{"alpha"});

    // The hazard `query.zig` records with a number: without `INDEXED BY
    // files_md5` SQLite picks `files_user_parent (user_id=?)`, whose first column
    // selects the caller's ENTIRE library, and re-walks it once per row — which
    // took a ten-document page "from 8,811 to 48,811 VM steps" there. Here the
    // outer loop is the REQUESTED md5 list, so the same mistake costs a library
    // walk per md5 asked for, on the cold fill that asks for all of them.
    //
    // BOTH statements, because both join `files` and only one of them is the
    // access check people remember.
    inline for ([_][]const u8{ held_sql, terms_sql }) |sql| {
        var s = try f.db.prepare("EXPLAIN QUERY PLAN " ++ sql);
        defer s.finalize();
        var files_by_md5 = false;
        while (try s.step()) {
            const detail = s.columnText(3);
            if (std.mem.indexOf(u8, detail, "SEARCH f USING INDEX files_md5 (md5=?)") != null) files_by_md5 = true;
            // `json_each` is a table-valued function and shows as a SCAN of the
            // REQUEST's own md5 list, which is exactly right — every requested
            // md5 is visited once. Nothing belonging to the database may be.
            try testing.expect(std.mem.indexOf(u8, detail, "SCAN f") == null);
            try testing.expect(std.mem.indexOf(u8, detail, "SCAN dt") == null);
        }
        try testing.expect(files_by_md5);
    }

    // AND `doc_terms` BY BOTH PRIMARY KEY COLUMNS, which is the pin this file
    // learned the hard way and the reason the joins are spelt `CROSS JOIN`.
    //
    // MEASURED, before that: left as a plain `JOIN`, SQLite made `doc_terms` the
    // OUTER loop and seeked `PRIMARY KEY (partition_id=?)` — the partition prefix
    // ALONE — then probed the request's md5 list for each row. Every term row the
    // household owns, read once per request, to answer about eight documents.
    // Adding 400 unrelated notes of the caller's own took the export from 1,534
    // to 19,539 VM steps, for identical output.
    //
    // Naming `blob_md5=?` is what makes this line able to fail: the bad plan is
    // still a `SEARCH` on `dt` and still uses the PRIMARY KEY, so "doc_terms is
    // seeked" would have passed over exactly the regression it is here for — the
    // same lesson `note_page_index_blob` taught the manifest's pin.
    var s = try f.db.prepare("EXPLAIN QUERY PLAN " ++ terms_sql);
    defer s.finalize();
    var dt_seek = false;
    var sorts: usize = 0;
    while (try s.step()) {
        const detail = s.columnText(3);
        if (std.mem.indexOf(u8, detail, "SEARCH dt USING PRIMARY KEY (partition_id=? AND blob_md5=?)") != null) dt_seek = true;
        if (std.mem.indexOf(u8, detail, "TEMP B-TREE") != null) sorts += 1;
    }
    try testing.expect(dt_seek);
    // ONE temp b-tree, shared by the `DISTINCT` and the `ORDER BY` — the encoder
    // requires ascending terms and strictly ascending postings, so the sort is not
    // optional. A second would mean something else had started materialising.
    try testing.expectEqual(@as(usize, 1), sorts);
}

/// The VM steps ONE term export costs, both statements together.
///
/// The statements are re-prepared here rather than counted inside `writeTerms`:
/// `vmSteps` is per statement, and threading a counter through production code
/// for a test's benefit is how production code grows test-shaped seams.
fn termSteps(f: *Fixture, user_id: u64, md5s: []const []const u8) !i64 {
    const gpa = testing.allocator;
    var json_list: std.ArrayList(u8) = .empty;
    defer json_list.deinit(gpa);
    try json_list.append(gpa, '[');
    for (md5s, 0..) |m, i| {
        if (i != 0) try json_list.append(gpa, ',');
        try json_list.append(gpa, '"');
        try json_list.appendSlice(gpa, m);
        try json_list.append(gpa, '"');
    }
    try json_list.append(gpa, ']');

    var total: i64 = 0;
    var held = try f.db.prepare(held_sql);
    defer held.finalize();
    held.bindInt(1, @intCast(user_id));
    held.bindText(2, json_list.items);
    while (try held.step()) {}
    total += held.vmSteps();

    const part = (try partition.active(f.db, user_id)) orelse return total;
    var terms = try f.db.prepare(terms_sql);
    defer terms.finalize();
    terms.bindInt(1, @intCast(user_id));
    terms.bindText(2, json_list.items);
    terms.bindInt(3, part);
    while (try terms.step()) {}
    return total + terms.vmSteps();
}

test "WORK PIN: exporting N blobs costs VM steps linear in N and flat in library size" {
    var f = try Fixture.init();
    defer f.deinit();

    // The pin §6 asked for, and its note about why it is meaningful HERE:
    // search's work pins are blind to prefix expansion because that work happens
    // inside the FTS virtual table's `xFilter`/`xNext`, but this reads
    // `doc_terms` by primary key and runs no `MATCH`, so the counter sees all of
    // it. MEASURED: 1,062 VM steps for eight documents, and it does not move.
    const wanted = try f.a().alloc([]const u8, 8);
    for (0..8) |i| {
        const id = try f.putNote(1, try std.fmt.allocPrint(f.a(), "n{d}.note", .{i}), &.{
            try std.fmt.allocPrint(f.a(), "palavra{d}", .{i}),
            "comum",
        });
        wanted[i] = try md5Of(&f, id);
    }
    const base = try termSteps(&f, 1, wanted);

    // 400 documents OF THE CALLER'S OWN that were not asked for. The export is
    // driven by the request's md5 list, so none of them may be touched: what is
    // allowed here is a b-tree that grew a level, not a walk. This is the
    // assertion the `CROSS JOIN` exists for — as a plain `JOIN` it read 19,539
    // steps here against 1,534.
    for (0..400) |i| _ = try f.putNote(1, try std.fmt.allocPrint(f.a(), "bulk{d:0>4}.note", .{i}), &.{"enchimento"});
    try testing.expect((try termSteps(&f, 1, wanted)) - base <= 8);

    // And a whole other household member's library — the one the missing `files`
    // join would have made VISIBLE and a `user_id` access path would have made
    // EXPENSIVE. Neither, here.
    for (0..400) |i| _ = try f.putNote(2, try std.fmt.allocPrint(f.a(), "outro{d:0>4}.note", .{i}), &.{"enchimento"});
    try testing.expect((try termSteps(&f, 1, wanted)) - base <= 8);
}

// ---------------------------------------------------------------------------
// Tests — the plan pin and the work pin
// ---------------------------------------------------------------------------

test "PLAN PIN: the manifest seeks every table it touches and sorts the caller's library exactly once" {
    var f = try Fixture.init();
    defer f.deinit();
    _ = try f.putNote(1, "n.note", &.{"alpha"});
    _ = try f.putBytes(1, "b.epub", "EPUB");
    _ = try f.putBytes(1, "b.epub.mark", "ink");

    // SEVEN halves of one plan, pinned together because they fail in the same
    // silent way the search pins describe: the manifest still answers correctly
    // and just costs more — on a response fetched EVERY visit, which is the one
    // cost profile this architecture adds (§9.2).
    //
    // What each line is protecting:
    //
    //  1. `d` on `files_live_name` — the PARTIAL index. Its `WHERE deleted = 0`
    //     is why the bin is free: MEASURED, 400 trashed files cost 2,000 VM
    //     steps through `files_user_parent` and ZERO here. A household's bin
    //     grows without bound and nothing prunes it. (The document row is
    //     aliased `d` and not `f` — see `manifest_sql`; `f` inside the plan
    //     below belongs to the derivation predicate's own `files` row.)
    //  2. NO `SCAN` ANYWHERE — a backstop rather than the pin. A scan of
    //     `note_index` or `note_page_index` inside a correlated subquery is the
    //     classic shape of this regression: correct output, and the whole index
    //     re-read once per document. It is only a backstop because
    //     `note_page_index` also carries a UNIQUE autoindex on
    //     `(blob_md5, page_index)`: with `note_page_index_blob` dropped SQLite
    //     falls to the autoindex and never scans, so it is NAMING the index that
    //     makes this line able to fail (VERIFIED — see the note below).
    //  3/4. BOTH DIRECTIONS OF THE PAIRING RULE ride `files_live_name` — `p` is
    //     `hidePairedMark` (is this row ink?) and `m` is `hasPairedMark` (does
    //     this row carry ink?). `schema.zig` says a plan pin names this index;
    //     this is that pin. Tier 2 asks the question once per document, so an
    //     unindexed probe here is a full library walk per row.
    //  5. EXACTLY ONE temp b-tree. The ORDER BY cannot ride an index because
    //     `tier` is computed, and that is accepted — once. A second would mean
    //     something else in the statement had started materialising, and the
    //     manifest is already O(library) without help.
    //  6/7. THE DERIVATION PREDICATE, one correlated arm per deferred tenant,
    //     and its access path is the expensive half of this statement (WORK PIN:
    //     it took the per-row cost from 81 to 173 VM steps). Each arm reaches
    //     `files` by `files_md5 (md5=?)` and `blobs` by its md5 autoindex — both
    //     driven by the ONE bound the manifest adds, `f.md5 = d.md5`. Counted
    //     against `deferred.tenants.len` rather than merely observed, so that a
    //     tenant added to the worker and not reflected here fails, and so does
    //     an arm that stopped being correlated: an uncorrelated arm has no md5
    //     to seek on and falls to a scan of `files` PER ROW — the whole install,
    //     once per document, on the response paid on every visit.
    var s = try f.db.prepare("EXPLAIN QUERY PLAN " ++ manifest_sql);
    defer s.finalize();
    var driver = false;
    var hide_probe = false;
    var has_probe = false;
    var note_index_seek = false;
    var page_index_seek = false;
    var sorts: usize = 0;
    var derive_files_seeks: usize = 0;
    var derive_blob_seeks: usize = 0;
    while (try s.step()) {
        const detail = s.columnText(3);
        if (std.mem.indexOf(u8, detail, "SEARCH d USING INDEX files_live_name (user_id=?)") != null) driver = true;
        if (std.mem.indexOf(u8, detail, "SEARCH p USING INDEX files_live_name") != null) hide_probe = true;
        if (std.mem.indexOf(u8, detail, "SEARCH m USING INDEX files_live_name") != null) has_probe = true;
        if (std.mem.indexOf(u8, detail, "SEARCH note_index") != null and
            std.mem.indexOf(u8, detail, "blob_md5=?") != null) note_index_seek = true;
        if (std.mem.indexOf(u8, detail, "SEARCH note_page_index USING INDEX note_page_index_blob") != null) page_index_seek = true;
        if (std.mem.indexOf(u8, detail, "SEARCH f USING INDEX files_md5 (md5=?)") != null) derive_files_seeks += 1;
        if (std.mem.indexOf(u8, detail, "SEARCH b USING COVERING INDEX sqlite_autoindex_blobs_1 (md5=?)") != null) derive_blob_seeks += 1;
        if (std.mem.indexOf(u8, detail, "TEMP B-TREE") != null) sorts += 1;
        try testing.expect(std.mem.indexOf(u8, detail, "SCAN ") == null);
    }
    try testing.expect(driver);
    try testing.expect(hide_probe);
    try testing.expect(has_probe);
    try testing.expect(note_index_seek);
    try testing.expect(page_index_seek);
    try testing.expectEqual(@as(usize, 1), sorts);
    try testing.expectEqual(deferred.tenants.len, derive_files_seeks);
    try testing.expectEqual(deferred.tenants.len, derive_blob_seeks);

    // AND THE PIN THAT IS NOT AN ASSERTION: `INDEXED BY` is a requirement, so
    // renaming or dropping `files_live_name` does not make the manifest slow, it
    // makes this `prepare` fail — which is the trade `schema.zig` states beside
    // the index and the reason the access path is written into the SQL rather
    // than left to `ANALYZE`.
    //
    // ALL OF THEM WERE DRIVEN RED before this pin was committed, because a pin
    // that cannot fail is decoration: dropping `files_live_name` fails the
    // `prepare` outright; dropping `note_page_index_blob` leaves the plan seeking
    // the UNIQUE autoindex instead, which fails line 2; deleting the tier-2
    // `WHEN` removes `SEARCH m` from the plan, which fails line 4; swapping the
    // access path to `files_user_parent` took a three-document library with 400
    // trashed files from 223 VM steps to 2,233, which fails the WORK PIN below;
    // and dropping `files_md5` turns each derivation arm into `SCAN f USING
    // INDEX files_live_name` — the caller's WHOLE live library re-walked twice
    // per document — which fails line 2, fails line 6 (the seek count drops to
    // zero), and takes the WORK PIN's slope from 173 to **8,647** steps per
    // document. VERIFIED by dropping the index in the fixture. This is the one
    // regression that would not have announced itself: the manifest's output is
    // identical, and a household would simply find that every visit got slower
    // as its library grew.
    //
    // RE-RUN 2026-08-09, WHEN THE SEAM WAS FILLED. `owes_derive_expr` was `NULL`
    // — no plan and no cost — and is now the deferred tenants' own predicate,
    // correlated per row (`pending.owesDerive`). It adds THREE seeks per tenant
    // per document (`ni`, `b`, `f`), which is lines 6/7 and the 81 -> 173 step
    // jump the WORK PIN records.
}

/// The VM steps ONE manifest costs, drained — every row, both pairing probes,
/// the sort, and the coverage tally that rides along.
fn manifestSteps(f: *Fixture, user_id: u64) !i64 {
    var c = try Cursor.open(f.db, user_id);
    defer c.finalize();
    while (try c.next()) |_| {}
    return c.stmt.vmSteps();
}

fn fill(f: *Fixture, user_id: u64, prefix: []const u8, from: usize, to: usize) !void {
    for (from..to) |i| _ = try f.putBytes(
        user_id,
        try std.fmt.allocPrint(f.a(), "{s}{d:0>4}.pdf", .{ prefix, i }),
        try std.fmt.allocPrint(f.a(), "%PDF-1.4 {s} {d}", .{ prefix, i }),
    );
}

test "WORK PIN: the manifest costs the caller's own live library, and nothing else's" {
    // WHAT THIS PIN CANNOT SAY, stated up front: the manifest is COMPLETE by
    // definition (§2.2), so "flat in library size" — the property the search
    // pins hold — is not available here and never will be. Every row is the
    // point. What IS available, and is what actually regresses, is the shape:
    // linear in the caller's own live documents, FLAT in every other household
    // member's library and FLAT in the bin, with a bounded per-row cost.
    var f = try Fixture.init();
    defer f.deinit();

    try fill(&f, 1, "d", 0, 40);
    const base = try manifestSteps(&f, 1);

    // ANOTHER HOUSEHOLD MEMBER'S WHOLE LIBRARY. Not one of these rows may be
    // touched: they are excluded by `f.user_id = ?1`, which is the first column
    // of the index the statement names, so the seek never reaches them. The
    // bound is 8 rather than 0 because a b-tree that grows deep enough costs one
    // more step per level — MEASURED here: exactly +1.
    try fill(&f, 2, "o", 0, 400);
    try testing.expect((try manifestSteps(&f, 1)) - base <= 8);

    // THE CALLER'S OWN BIN, which is the regression `INDEXED BY files_live_name`
    // exists to prevent and the one a reviewer is least likely to think of. A
    // household's bin is unbounded — nothing prunes it — and through the total
    // index every trashed row was walked and discarded on EVERY visit: MEASURED
    // 400 trashed files at +2,000 VM steps, against +0 here.
    for (0..400) |i| {
        const id = try f.putBytes(
            1,
            try std.fmt.allocPrint(f.a(), "t{d:0>4}.pdf", .{i}),
            try std.fmt.allocPrint(f.a(), "%PDF-1.4 trashed {d}", .{i}),
        );
        try f.files.trash(1, id);
    }
    try testing.expect((try manifestSteps(&f, 1)) - base <= 8);

    // AND THE SLOPE, measured TWICE over the same fixture so a quadratic term
    // has somewhere to show. A per-row cost that grew with the library — a
    // pairing probe that stopped being a seek, say — would make the second slope
    // exceed the first, and no single measurement could tell the difference.
    //
    // MEASURED 2026-08-09: **173.0 steps per document at both sizes**, up from
    // 81.0 before the derivation seam was filled.
    //
    // **THE JUMP IS 2.1x AND IT IS STATED RATHER THAN ABSORBED**, because this is
    // the response paid on every visit. Where it went: `owes_derive_expr` is one
    // correlated `EXISTS` per deferred tenant, and each arm is three seeks — its
    // own `note_index` row, its `blobs` row, and its `files` row by `files_md5`
    // (the PLAN PIN names all of them). Two tenants, six seeks, ~92 steps.
    //
    // WHAT WAS NOT DONE ABOUT IT, and why. The obvious saving is that the outer
    // row already has the name and the md5 the arms go and re-read, so a
    // hand-written `d.name LIKE '%_.txt' AND ni.txt_index IS NULL` would answer
    // most rows without touching `files` at all. That is precisely the second
    // opinion `pending-ness.md` §3 forbids — *"free to drift from what the worker
    // actually does"* — and the failure it buys is silent: the manifest would
    // report `derived` for a blob the worker still owes, the client would cache
    // that document's emptiness for ever, and nothing anywhere would error. The
    // cost of the shared predicate is 92 VM steps a row; the cost of a second
    // opinion is a document.
    //
    // WORST CASE, and this fixture is it: every document here is an undrained
    // `.pdf`, so the txt arm runs in full and fails, and the pdf arm runs in full
    // and succeeds. A drained library short-circuits less work, not more, and a
    // `.note` library never reaches the second arm's `blobs` seek at all.
    //
    // AND WHAT IT COSTS IN TIME, because VM steps are not milliseconds. MEASURED
    // on the deployment target — Pi 1 B+, the 1,222-file install
    // `pending-ness.md` §11.1 measured on, 322 live documents for the owner under
    // test, warm cache, 40 iterations — the statement itself, both spellings:
    //
    //     owes_derive_expr = NULL          127.27 ms p50   141.51 ms p95
    //     owes_derive_expr = owesDerive    177.77 ms p50   203.71 ms p95
    //
    // **+50 ms, or +40%, against +114% in VM steps** — the added work is six
    // warm b-tree seeks a row, which the counter charges in full and the page
    // cache serves almost free. It is still 178 ms of held connection on every
    // cold visit, which is the number §9.2 should be read with: the manifest is
    // the most expensive single read this architecture adds, and it is the one
    // that is paid every time.
    try fill(&f, 1, "d", 40, 240);
    const at_240 = try manifestSteps(&f, 1);
    try fill(&f, 1, "d", 240, 440);
    const at_440 = try manifestSteps(&f, 1);

    const slope_1 = @divTrunc(at_240 - base, 200);
    const slope_2 = @divTrunc(at_440 - at_240, 200);
    try testing.expect(slope_2 <= slope_1 + 4);

    // The level itself, loosely, so a plan that reverted to a per-row library
    // walk could not pass by growing flat from a bad starting point — and a
    // lower bound, so a statement that returned nothing at all cannot pass by
    // being cheap. MEASURED 173; the bounds are far enough either side that a
    // SQLite upgrade reshuffling opcodes cannot fail them, and tight enough that
    // losing `files_md5` on the derivation arms (**8,647** steps per document,
    // VERIFIED by dropping the index in this fixture) fails here.
    try testing.expect(slope_1 >= 60 and slope_1 <= 300);

    // A DOCUMENT PER ROW, so the steps above bought the manifest they claim to.
    try testing.expectEqual(@as(usize, 440), (try f.manifest(1)).rows.len);
}

// ---------------------------------------------------------------------------
// Tests — what the manifest costs on the wire (§9.2, which flagged it UNMEASURED)
// ---------------------------------------------------------------------------

/// The manifest as JSON — the encoding step 4 would reach for without thinking
/// about it, and therefore the one worth sizing. Hand-written rather than
/// reflected so that the field names are the ones being measured and not
/// whatever a serializer chose.
///
/// **This is a MEASUREMENT SUBJECT, not the wire format.** The route is §3 step
/// 4's; what this file owes it is the number that decides the encoding.
fn writeJson(gpa: std.mem.Allocator, out: *std.ArrayList(u8), m: Manifest) !void {
    try out.print(
        gpa,
        "{{\"coverage\":{{\"notes\":{d},\"unsearchable\":{d}}},\"rows\":[",
        .{ m.coverage.notes, m.coverage.unsearchable },
    );
    for (m.rows, 0..) |r, i| {
        if (i != 0) try out.append(gpa, ',');
        try out.print(
            gpa,
            "{{\"id\":{d},\"md5\":\"{s}\",\"tier\":{d},\"updatedAt\":{d},\"derivation\":{d}",
            .{ r.file_id, r.md5, @intFromEnum(r.tier), r.updated_at, @intFromEnum(r.derivation) },
        );
        if (r.index_version) |v| try out.print(gpa, ",\"indexVersion\":{d}", .{v});
        try out.append(gpa, '}');
    }
    try out.appendSlice(gpa, "]}");
}

/// gzip at LEVEL 6 — the setting every other figure in `client-side-search.md`
/// and `client-side-search-impl.md` was taken at, so these numbers sit beside
/// those without a footnote.
fn gzipLen(gpa: std.mem.Allocator, bytes: []const u8) !usize {
    var sink: std.Io.Writer.Allocating = try .initCapacity(gpa, 4096);
    defer sink.deinit();
    const window = try gpa.alloc(u8, std.compress.flate.max_window_len);
    defer gpa.free(window);
    var c = try std.compress.flate.Compress.init(&sink.writer, window, .gzip, .level_6);
    try c.writer.writeAll(bytes);
    try c.writer.flush();
    return sink.written().len;
}

test "MEASUREMENT: what one manifest costs on the wire, and how it grows" {
    // §9.2 flagged this UNMEASURED and named it the one RECURRING network cost
    // this architecture adds: *"the same order as the whole tier-1 term payload,
    // paid on every visit rather than once, and no document sizes it."* This is
    // that document. It is a test rather than a note so that the numbers cannot
    // go stale without something going red.
    //
    // The library is sized to `search-baseline.md` §1's real corpus — 1,222
    // undeleted non-folder files — and the timestamps are SPREAD over two years
    // rather than left at the ingest clock, because a manifest whose rows all
    // shared one second would delta-encode to nothing and flatter the binary form
    // for a reason no household enjoys.
    //
    // MEASURED 2026-08-09, gzip level 6, and recorded in §9.2:
    //
    //   documents |   JSON raw   JSON gzip |  binary raw   binary gzip
    //   ----------+------------------------+--------------------------
    //          13 |      1,549         515 |         303           330
    //       1,222 |    143,139      38,597 |      27,663        26,937
    //   per row   |      117.1        31.6 |        22.6          22.0
    //
    // Four things follow, and between them they are §9.2's answer:
    //
    //  * §9.2's arithmetic projection was **40-60 KB raw**. The real JSON figure
    //    is **143 KB raw** — low by 2.4x, because the projection counted the md5
    //    and forgot that `updatedAt` is a ten-digit epoch second and every field
    //    carries its own name on every row. Gzipped it is **38.6 KB**, which
    //    lands inside the range the projection thought was the RAW size.
    //  * **The worry was right.** 38.6 KB against a tier-1 term payload projected
    //    at 45-110 KB gzip (§9.1) is the same order — and the term payload is
    //    fetched once per blob for ever, where this is fetched every visit. On a
    //    3G link at 1 Mbit/s that is ~0.3 s of transfer before the first search
    //    can be answered, on every cold visit.
    //  * **MD5 IS THE MANIFEST.** 1,222 raw md5s are 19,552 bytes and hashes do
    //    not compress: at 13 documents the binary form's gzip is LARGER than its
    //    raw (330 against 303), the same effect the ordinal table measured at
    //    +221 bytes on the same corpus. At 1,222 documents the md5s are **72.6%
    //    of the whole gzipped binary payload**. Everything else about a document
    //    — its id, its tier, its recency, its version, its derivation state — is
    //    worth about 7.4 KB gzip between them.
    //  * **Representation is therefore the only lever with any travel in it**,
    //    exactly as §9.2 says. Raw bytes over hex takes the fetch from 38.6 KB to
    //    26.9 KB, a **30% saving**, and what remains is 128 bits of identity per
    //    document, which nothing can remove. That is the same trade the term
    //    codec already took for the ordinal table, for the same reason, and it
    //    argues that step 4 should serve the manifest as bytes rather than JSON.
    //
    // WHAT THIS DOES NOT DECIDE, and is not this step's to decide: how often the
    // manifest is refetched. Every figure above is per fetch, and §9.2 flags the
    // refresh rate as open. A cheaper manifest does not answer it; the shape that
    // would is a conditional request, and that is step 4's design.
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;

    var json: std.ArrayList(u8) = .empty;
    defer json.deinit(gpa);
    var bin: std.ArrayList(u8) = .empty;
    defer bin.deinit(gpa);

    var rng = std.Random.DefaultPrng.init(0x5EA5);
    var filled: usize = 0;
    var json_gz_full: usize = 0;
    var bin_gz_full: usize = 0;
    for ([_]usize{ 13, 1222 }) |n| {
        try fill(&f, 1, "d", filled, n);
        // Two years of a household's saves, so the `updated_at` gap encoding is
        // measured against a real spread and not against the ingest clock.
        var i = filled;
        while (i < n) : (i += 1) {
            try f.touch(@intCast(i + 1), 1_690_000_000 + rng.random().intRangeLessThan(i64, 0, 63_072_000));
        }
        filled = n;

        const m = try f.manifest(1);
        try testing.expectEqual(n, m.rows.len);

        json.clearRetainingCapacity();
        bin.clearRetainingCapacity();
        try writeJson(gpa, &json, m);
        try writeManifest(gpa, &bin, m);
        const json_gz = try gzipLen(gpa, json.items);
        const bin_gz = try gzipLen(gpa, bin.items);
        if (n == 1222) {
            json_gz_full = json_gz;
            bin_gz_full = bin_gz;
        }

        // Bounds rather than equalities: `updated_at` is randomised and the
        // fixture's md5s are content-addressed, so the exact bytes move by a few
        // per cent between runs. What must not move is the per-row cost — a field
        // added carelessly to `Row` shows up here as a bigger recurring fetch for
        // every household, on every visit, and nowhere else.
        try testing.expect(json.items.len / n <= 130); // MEASURED 117-119
        try testing.expect(json_gz / n <= 45); // MEASURED 31.6 at scale, 39.6 at 13
        try testing.expect(bin.items.len / n <= 26); // MEASURED 22.6
        try testing.expect(bin_gz / n <= 30); // MEASURED 22.0 at scale, 25.4 at 13

        // LINEAR IN DOCUMENTS, with no per-document term of its own: the manifest
        // says one fixed-shape thing about each row, so a library ten times this
        // size costs ten times these bytes and never more. That is what makes the
        // projection to a bigger household arithmetic rather than a guess — and
        // the floor is the 16 raw bytes of md5 that cannot be removed at all.
        try testing.expect(bin.items.len > n * 16);
    }

    // THE LEVER, asserted so it cannot quietly close: at the real corpus size the
    // raw-bytes representation is at most three quarters of the JSON one.
    // MEASURED 69.8%. If a future field made JSON competitive again it would be
    // because that field was enormous, which is the thing to notice.
    try testing.expect(bin_gz_full * 4 <= json_gz_full * 3);

    // AND THE FLOOR: 1,222 md5s at 16 raw bytes are 19,552 bytes that no encoding
    // and no compressor can reduce, which is 72.6% of the gzipped binary payload.
    // A manifest cannot be made small; it can only be made minimal.
    try testing.expect(bin_gz_full > 1222 * 16);
}
