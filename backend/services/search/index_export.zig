//! The search-index manifest: the caller's complete live document set, tiered
//! by fill priority. Absence from it is the only way a trashed file stops
//! matching in the browser, so it is never partial, paginated or filtered.

const std = @import("std");

pub const EncodeError = error{
    /// 32 lowercase hex characters, which is what `files.md5` holds.
    InvalidMd5,
} || std.mem.Allocator.Error;

fn appendU32(gpa: std.mem.Allocator, out: *std.ArrayList(u8), v: u32) std.mem.Allocator.Error!void {
    var buf: [4]u8 = undefined;
    std.mem.writeInt(u32, &buf, v, .little);
    try out.appendSlice(gpa, &buf);
}

/// Unsigned LEB128.
fn appendVarint(gpa: std.mem.Allocator, out: *std.ArrayList(u8), value: u64) std.mem.Allocator.Error!void {
    var v = value;
    while (true) {
        const low: u8 = @intCast(v & 0x7f);
        v >>= 7;
        if (v == 0) return out.append(gpa, low);
        try out.append(gpa, low | 0x80);
    }
}

/// Lowercase only: the md5 is the client's cache key and must match the manifest.
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

// ---- the manifest ----

const sqlite = @import("../../db/sqlite.zig");
const filesmod = @import("../files.zig");
const markpair = @import("../mark_pairing.zig");
const pending = @import("../pending.zig");
const derivedstore = @import("../../store/derived.zig");

/// The fill pass, in order, so `ORDER BY tier` is the fill order. A priority,
/// not an exclusion: `other` catches everything else.
pub const Tier = enum(u8) {
    /// The user's own handwriting.
    note = 1,
    /// Has a `.mark` companion.
    marked = 2,
    other = 3,
};

/// What the client may conclude from an empty term set. Only `derived` empties
/// are cacheable, and only under `(md5, index_version)`: `derived` means no
/// deferred tenant owes work, which under-reports while the note half is stale.
pub const Derivation = enum(u8) {
    /// Final for this `(md5, index_version)`; cache, empty included.
    derived = 0,
    /// The worker still owes work; do not cache an empty answer.
    pending = 1,
    /// No longer produced, but what a NULL reads as; treat as `pending`.
    unknown = 2,
};

/// The deferred tenants' own predicate, so pending-ness cannot drift from the
/// worker. Tenant clauses bind `f`, hence the manifest's row is `d`: an outer
/// `f` would correlate `f.md5 = f.md5` and make everything pending.
const owes_derive_expr = pending.owesDerive("d");

/// A note by the indexer's verdict, never by name. Also the tier-1 test, so
/// tiering and coverage agree.
fn isNote(comptime a: []const u8) []const u8 {
    return "EXISTS (SELECT 1 FROM note_index WHERE blob_md5 = " ++ a ++ ".md5 AND indexable = 1)";
}

const has_text = "text IS NOT NULL AND text <> ''";

/// Carries recognised text; the complement of `unsearchable`.
fn hasRecognisedText(comptime a: []const u8) []const u8 {
    return "EXISTS (SELECT 1 FROM note_page_index WHERE blob_md5 = " ++ a ++
        ".md5 AND recogn_status = 1 AND " ++ has_text ++ ")";
}

/// The three fill passes as one SQL expression over alias `a`. Tier 2 is the
/// relational `.mark` pairing rule, so an annotated format of any kind counts.
pub fn tierExpr(comptime a: []const u8) []const u8 {
    return "CASE WHEN " ++ isNote(a) ++ " THEN 1" ++
        " WHEN " ++ markpair.pairedMarkId(a) ++ " IS NOT NULL THEN 2" ++
        " ELSE 3 END";
}

/// The shared `.mark` fold: a paired mark is a layer, not a document. An
/// orphaned mark still lists.
const hide_paired_mark = markpair.hidePairedMark("d", "0");

/// Searchability counts for the browser's empty state, tallied over the
/// manifest's own rows so the fraction and the row set are one population.
pub const Coverage = struct {
    /// Notes the caller owns, by the indexer's verdict (`isNote`).
    notes: i64 = 0,
    /// Notes with no recognised text. Permanent, unlike `Derivation.pending`.
    unsearchable: i64 = 0,
};

/// One document of the caller's, per file rather than per blob.
pub const Row = struct {
    /// `files.id`. What a local hit has to name to be opened.
    file_id: i64,
    /// 32 lowercase hex, borrowed from the statement.
    md5: []const u8,
    /// `files.updated_at`; the within-tier order.
    updated_at: i64,
    /// The other half of the cache key; null means nothing to fetch.
    index_version: ?i64,
    tier: Tier,
    derivation: Derivation,
};

/// The whole manifest, materialised: O(library) in memory. Stream `Cursor`
/// for very large libraries.
pub const Manifest = struct {
    rows: []const Row,
    coverage: Coverage,
};

/// Every live document of `user_id`'s: tier, then `updated_at` DESC, then
/// `d.id` so equal timestamps have a stable order. `d.user_id = ?1` is the
/// whole authorization. `INDEXED BY files_live_name` is required: the partial
/// index skips the bin, and dropping it fails the prepare rather than walking
/// it. Sort on the alias `tier`, not an ordinal a new column would rebind.
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

/// The manifest one row at a time, tallying coverage as it goes.
pub const Cursor = struct {
    stmt: sqlite.Stmt,
    /// Consulted per row by `derivedVersion`; production must pass it.
    terms: ?derivedstore.DerivedStore = null,
    tally: Coverage = .{},
    drained: bool = false,

    pub fn open(db: sqlite.Db, user_id: u64, terms: ?derivedstore.DerivedStore) !Cursor {
        const stmt = try db.prepare(manifest_sql);
        stmt.bindInt(1, @intCast(user_id));
        return .{ .stmt = stmt, .terms = terms };
    }

    /// The next document, or null when done. `Row.md5` borrows SQLite's buffer
    /// until the next call. One row per file, not per blob: removal is per
    /// file, so trashing one of two copies must drop a row.
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
        // Coverage's denominator is tier 1; no second `EXISTS` per row.
        if (tier == .note) {
            self.tally.notes += 1;
            if (self.stmt.columnInt(col_has_text) == 0) self.tally.unsearchable += 1;
        }
        const md5 = self.stmt.columnText(col_md5);
        return .{
            .file_id = self.stmt.columnInt(col_id),
            .md5 = md5,
            .updated_at = self.stmt.columnInt(col_updated_at),
            .index_version = self.derivedVersion(md5),
            .tier = tier,
            // Never NULL (an `EXISTS`), but a NULL must not default to `derived`,
            // which licenses caching an empty set for ever.
            .derivation = if (self.stmt.columnIsNull(col_derivation))
                .unknown
            else if (self.stmt.columnInt(col_derivation) != 0) .pending else .derived,
        };
    }

    /// The version the client may ask for: only when the terms file exists.
    /// `note_index.index_version` marks every processed blob, textless ones
    /// included, and advertising those left clients re-asking for ever.
    fn derivedVersion(self: Cursor, md5: []const u8) ?i64 {
        const recorded = self.stmt.columnIntOpt(col_index_version) orelse return null;
        const store = self.terms orelse return recorded;
        return if (store.has(md5, recorded)) recorded else null;
    }

    /// Only meaningful once drained: a tally of the rows that went past.
    pub fn coverage(self: Cursor) Coverage {
        std.debug.assert(self.drained);
        return self.tally;
    }

    pub fn finalize(self: Cursor) void {
        self.stmt.finalize();
    }
};

/// The whole manifest in `arena`. Rows own their md5s.
pub fn manifest(arena: std.mem.Allocator, files: filesmod.Files, user_id: u64) !Manifest {
    var c = try Cursor.open(files.db, user_id, files.terms);
    defer c.finalize();
    var rows: std.ArrayList(Row) = .empty;
    while (try c.next()) |row| {
        var owned = row;
        owned.md5 = try arena.dupe(u8, row.md5);
        try rows.append(arena, owned);
    }
    return .{ .rows = rows.items, .coverage = c.coverage() };
}

// ---- the manifest on the wire ----

/// How the manifest is spelt; independent of `index_version`.
pub const manifest_format_version: u8 = 1;

/// So an error page or truncated response fails on byte 0.
pub const manifest_magic = "SMAN";

/// magic + version + row_count.
pub const manifest_header_len = manifest_magic.len + 1 + 4;

/// The manifest as bytes, 5.2x smaller than JSON raw (API responses are not
/// compressed). No names: the client maps `file_id` through its listing.
///
///     "SMAN", version u8, row_count u32 LE, notes varint, unsearchable varint,
///     then per row: md5 (16 raw bytes), flags u8 (tier low nibble, derivation
///     high), file_id varint, updated_at varint, index_version varint.
///
/// `row_count` up front lets the decoder detect truncation, which would
/// otherwise read as deletions. `updated_at` is the gap from the previous row,
/// absolute on each tier's first row. `index_version` is stored +1 so 0 is
/// absent.
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
        try out.append(gpa, @as(u8, @backingInt(r.tier)) | (@as(u8, @backingInt(r.derivation)) << 4));
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

/// A strong validator: md5 of the body. Not a version pair, which would be a
/// second opinion about what changes the manifest, and a wrong 304 leaves a
/// deleted document matching for ever. Saves bytes, not the query.
pub fn bodyEtag(bytes: []const u8) [32]u8 {
    var digest: [16]u8 = undefined;
    std.crypto.hash.Md5.hash(bytes, &digest, .{});
    var hex: [32]u8 = undefined;
    _ = std.fmt.bufPrint(&hex, "{x}", .{&digest}) catch unreachable;
    return hex;
}

/// The manifest as one request sees it: rows in order, and the body's ETag.
pub const Gate = struct {
    rows: []const Row,
    etag: [32]u8,
};

/// Re-runs the manifest query and hashes what it would serialize to, so a
/// stream request can prove its `want` bitmap indexes the ordering the client
/// holds. The body bytes come from `gpa` and are freed here; the rows live in
/// `arena`. Given the same `Files` as the manifest route, so the ETags agree.
pub fn gate(arena: std.mem.Allocator, gpa: std.mem.Allocator, files: filesmod.Files, user_id: u64) !Gate {
    const m = try manifest(arena, files, user_id);
    var body: std.ArrayList(u8) = .empty;
    defer body.deinit(gpa);
    try writeManifest(gpa, &body, m);
    return .{ .rows = m.rows, .etag = bodyEtag(body.items) };
}

test {
    _ = @import("index_export/manifest_test.zig");
    _ = @import("index_export/wire_test.zig");
}

// ---- tests of private helpers ----

const testing = std.testing;
const deferred = @import("../deferred.zig");
const fixture = @import("index_export/fixture.zig");
const Fixture = fixture.Fixture;

const tier_expr_d = tierExpr("d");

test "an annotated EPUB is tier 2, because the rule asks for a sibling and never for a format" {
    var f = try Fixture.init();
    defer f.deinit();

    // The pairing rule once was `LIKE '%.pdf.mark'`, which made it PDF-only.
    const epub = try f.putBytes(1, "Os Lusíadas.epub", "EPUB bytes");
    _ = try f.putBytes(1, "Os Lusíadas.epub.mark", "ink");
    const plain = try f.putBytes(1, "Os Lusíadas cópia.epub", "EPUB bytes, unannotated");

    try testing.expectEqual(Tier.marked, (try f.rowFor(1, epub)).?.tier);
    try testing.expectEqual(Tier.other, (try f.rowFor(1, plain)).?.tier);

    // The tier expression names no format. Not asserted over `manifest_sql`,
    // whose shared tenant predicate legitimately does.
    inline for ([_][]const u8{ ".pdf", ".epub", ".note", ".txt" }) |ext| {
        try testing.expect(std.mem.indexOf(u8, tier_expr_d, ext) == null);
    }
}

test "PLAN PIN: the manifest seeks every table it touches and sorts the caller's library exactly once" {
    var f = try Fixture.init();
    defer f.deinit();
    _ = try f.putNote(1, "n.note", &.{"alpha"});
    _ = try f.putBytes(1, "b.epub", "EPUB");
    _ = try f.putBytes(1, "b.epub.mark", "ink");

    // The manifest is fetched every visit, so a slower plan is a silent cost.
    // `files_live_name` is partial and skips the bin. The no-`SCAN` check is a
    // backstop: `note_page_index`'s UNIQUE autoindex hides a dropped
    // `note_page_index_blob`, so that index is named. One temp b-tree for the
    // computed `tier` sort. Each deferred tenant's arm must seek `files_md5`
    // and the blobs autoindex; uncorrelated, it scans `files` per row.
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

    // Dropping `files_live_name` fails the prepare (`INDEXED BY`). Dropping
    // `files_md5` took the slope from 173 to 8,647 steps per document.
}
