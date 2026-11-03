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
const filesvc = @import("../files.zig");
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
pub fn manifest(
    arena: std.mem.Allocator,
    db: sqlite.Db,
    user_id: u64,
    terms: ?derivedstore.DerivedStore,
) !Manifest {
    var c = try Cursor.open(db, user_id, terms);
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

// ---- tests: the manifest and the tiering ----

const testing = std.testing;
const schema = @import("../../db/schema.zig");
const blobstore = @import("../../store/blobs.zig");
const thumbstore = @import("../../store/thumbs.zig");
const nb = @import("note_builder");
const deferred = @import("../deferred.zig");
const noteindex = @import("../note_index.zig");

/// So the fixture can call `manifest` past its method of the same name.
const index_export = @This();

const tier_expr_d = tierExpr("d");

/// Two users and the real `Files` service: rows come from the ingest path,
/// never hand-inserted.
const Fixture = struct {
    db: sqlite.Db,
    files: filesvc.Files,
    tmp: testing.TmpDir,
    arena: std.heap.ArenaAllocator,
    /// `drainNow` demands a real lock.
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
        var files = filesvc.Files.init(testing.allocator, testing.io, db, store, thumbs);
        // Without the derived stores the cursor falls back to the database.
        const terms_dir = try tmp.dir.createDirPathOpen(testing.io, "terms", .{});
        files.terms = try derivedstore.DerivedStore.init(testing.io, terms_dir);
        const text_dir = try tmp.dir.createDirPathOpen(testing.io, "text", .{});
        files.text = try derivedstore.DerivedStore.init(testing.io, text_dir);
        return .{
            .db = db,
            .files = files,
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

    /// A real `.note` whose page carries `labels` as finished recognition.
    fn putNote(f: *Fixture, user_id: u64, name: []const u8, labels: []const []const u8) !u64 {
        const bytes = try nb.serialize(testing.allocator, .{ .pages = &.{.{
            .layers = &.{.{ .slot = .main, .bitmap = "AAAA" }},
            .recogn_status = 1,
            .recogn_labels = labels,
        }} });
        defer testing.allocator.free(bytes);
        return f.putBytes(user_id, name, bytes);
    }

    /// Content the indexer cannot parse as a `.note`.
    fn putBytes(f: *Fixture, user_id: u64, name: []const u8, bytes: []const u8) !u64 {
        var r = std.Io.Reader.fixed(bytes);
        const e = try f.files.putFile(user_id, null, name, &r, null);
        defer testing.allocator.free(e.name);
        if (e.md5) |m| testing.allocator.free(m);
        return e.id;
    }

    /// Runs the real deferred worker to exhaustion.
    fn drain(f: *Fixture) void {
        deferred.drainNow(testing.allocator, f.db, f.files.blobs, &f.lock, testing.io);
    }

    fn touch(f: *Fixture, id: u64, at: i64) !void {
        var s = try f.db.prepare("UPDATE files SET updated_at = ?2 WHERE id = ?1;");
        defer s.finalize();
        s.bindInt(1, @intCast(id));
        s.bindInt(2, at);
        _ = try s.step();
    }

    fn manifest(f: *Fixture, user_id: u64) !Manifest {
        return index_export.manifest(f.a(), f.db, user_id, f.files.terms);
    }

    fn rowFor(f: *Fixture, user_id: u64, file_id: u64) !?Row {
        const m = try f.manifest(user_id);
        for (m.rows) |r| if (r.file_id == @as(i64, @intCast(file_id))) return r;
        return null;
    }
};

test "the manifest arrives in the fill order: notes, then anything annotated, then everything else" {
    var f = try Fixture.init();
    defer f.deinit();

    // Timestamped so recency alone would reverse the tiers.
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

    // Ids ascend while timestamps descend, so only a real sort passes.
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

    // Same second for all three: the order must still be total.
    for ([_]u64{ oldest, middle, newest }) |id| try f.touch(id, 500);
    m = try f.manifest(1);
    try testing.expectEqual(@as(i64, @intCast(oldest)), m.rows[0].file_id);
    try testing.expectEqual(@as(i64, @intCast(middle)), m.rows[1].file_id);
    try testing.expectEqual(@as(i64, @intCast(newest)), m.rows[2].file_id);
}

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

test "tier 1 is the indexer's verdict, not the file's name" {
    var f = try Fixture.init();
    defer f.deinit();

    const liar = try f.putBytes(1, "not-really.note", "PNG\x89 not a note at all");
    const honest = try f.putNote(1, "handwriting.bin", &.{"caligrafia"});

    try testing.expectEqual(Tier.other, (try f.rowFor(1, liar)).?.tier);
    try testing.expectEqual(Tier.note, (try f.rowFor(1, honest)).?.tier);
}

test "a paired .mark is in no tier and in no coverage denominator" {
    var f = try Fixture.init();
    defer f.deinit();

    // A `.mark` is a `.note` container and would otherwise be tier 1.
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
    try testing.expectEqual(@as(i64, 0), m.coverage.notes);
    try testing.expectEqual(@as(i64, 0), m.coverage.unsearchable);

    // An orphaned mark still lists, as tier 1. Trashing the PDF takes its
    // mark along, so the orphan is made directly.
    try f.files.trash(1, pdf);
    try testing.expectEqual(@as(usize, 0), (try f.manifest(1)).rows.len);

    const orphan = try f.putBytes(1, "Nobody's book.epub.mark", mark_bytes);
    try testing.expectEqual(Tier.note, (try f.rowFor(1, orphan)).?.tier);
}

test "the manifest is COMPLETE: a document with nothing to say is still a row" {
    var f = try Fixture.init();
    defer f.deinit();

    // Each of these is a row a tempting filter would drop.
    const png = try f.putBytes(1, "scan.png", "\x89PNG not text at any point"); // never searchable
    const note = try f.putNote(1, "blank.note", &.{}); // no recognised text
    const pdf = try f.putBytes(1, "book.pdf", "%PDF-1.4"); // derived later, by the worker
    const dup = try f.putBytes(1, "scan copy.png", "\x89PNG not text at any point"); // same blob as `png`

    // A blob with no `note_index` row, as during an outstanding derive.
    try f.db.exec("DELETE FROM note_index WHERE blob_md5 = (SELECT md5 FROM files WHERE name = 'book.pdf');");

    const m = try f.manifest(1);
    try testing.expectEqual(@as(usize, 4), m.rows.len);
    for ([_]u64{ png, note, pdf, dup }) |id| try testing.expect((try f.rowFor(1, id)) != null);

    // One blob, two files, two rows.
    const a_row = (try f.rowFor(1, png)).?;
    const b_row = (try f.rowFor(1, dup)).?;
    try testing.expectEqualStrings(a_row.md5, b_row.md5);

    try testing.expect((try f.rowFor(1, pdf)).?.index_version == null);

    // Exactly once: a join fan-out would break the client's set diff.
    for (m.rows, 0..) |r, i| for (m.rows[i + 1 ..]) |other| try testing.expect(r.file_id != other.file_id);
}

test "the version a row reports is the STORE's, so the client never asks for a file that will never exist" {
    var f = try Fixture.init();
    defer f.deinit();

    const png = try f.putBytes(1, "scan.png", "\x89PNG not text at any point");
    const blank = try f.putNote(1, "blank.note", &.{});
    const written = try f.putNote(1, "handwriting.note", &.{"caligrafia"});
    f.drain();

    // The database has a version for all three; that is what is corrected.
    for ([_]u64{ png, blank, written }) |id| {
        var st = try f.db.prepare(
            "SELECT ni.index_version FROM files d JOIN note_index ni ON ni.blob_md5 = d.md5 WHERE d.id = ?1;",
        );
        defer st.finalize();
        st.bindInt(1, @intCast(id));
        try testing.expect(try st.step());
        try testing.expect(!st.columnIsNull(0));
    }

    try testing.expect((try f.rowFor(1, png)).?.index_version == null);

    // A blank `.note` does get a terms file at ingest, so it advertises a
    // version: emptiness that arrived converges.
    const blank_row = (try f.rowFor(1, blank)).?;
    try testing.expect(blank_row.index_version != null);
    try testing.expect(f.files.terms.?.has(blank_row.md5, blank_row.index_version.?));

    const row = (try f.rowFor(1, written)).?;
    try testing.expect(row.index_version != null);
    try testing.expect(f.files.terms.?.has(row.md5, row.index_version.?));

    try testing.expectEqual(@as(usize, 3), (try f.manifest(1)).rows.len);

    f.files.terms.?.removeAll(row.md5);
    try testing.expect((try f.rowFor(1, written)).?.index_version == null);
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
    try testing.expect((try f.rowFor(1, gone)) == null);
}

test "one household member's manifest never contains another's documents" {
    var f = try Fixture.init();
    defer f.deinit();

    const mine = try f.putNote(1, "meu.note", &.{"particular"});
    const theirs = try f.putNote(2, "dele.note", &.{"particular"});

    // Identical bytes, so both users share one blob.
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

    try testing.expectEqualStrings(
        (try f.rowFor(1, shared)).?.md5,
        (try f.rowFor(2, shared_2)).?.md5,
    );
}

test "a just-uploaded document is PENDING, and stops being pending when the worker finishes" {
    var f = try Fixture.init();
    defer f.deinit();

    const txt = try f.putBytes(1, "notes.txt", "Primeiro parágrafo.\n\nSegundo parágrafo.\n");
    try testing.expectEqual(Derivation.pending, (try f.rowFor(1, txt)).?.derivation);

    f.drain();
    try testing.expectEqual(Derivation.derived, (try f.rowFor(1, txt)).?.derivation);
}

test "a derived blob with no text is DERIVED and stays cacheable — the other half of the trap" {
    var f = try Fixture.init();
    defer f.deinit();

    const blank = try f.putNote(1, "blank.note", &.{});
    const scan = try f.putBytes(1, "scan.png", "\x89PNG not text at any point");
    f.drain();

    try testing.expectEqual(Derivation.derived, (try f.rowFor(1, blank)).?.derivation);
    try testing.expectEqual(Derivation.derived, (try f.rowFor(1, scan)).?.derivation);
}

test "a .note is never pending, because nothing is owed for it" {
    var f = try Fixture.init();
    defer f.deinit();

    // The note half is indexed inside the upload transaction.
    const note = try f.putNote(1, "BuJo.note", &.{"segunda-feira"});
    try testing.expectEqual(Derivation.derived, (try f.rowFor(1, note)).?.derivation);
}

test "no row ever reports UNKNOWN now that the seam is filled" {
    var f = try Fixture.init();
    defer f.deinit();

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

    // Stale `note_index` rows are not offered to the worker, so they read
    // `derived`; safe only because the cache key carries `index_version`.
    const txt = try f.putBytes(1, "notes.txt", "parágrafo um\n\nparágrafo dois\n");
    try testing.expectEqual(Derivation.pending, (try f.rowFor(1, txt)).?.derivation);

    try f.db.exec("UPDATE note_index SET index_version = index_version - 1;");
    const stale = (try f.rowFor(1, txt)).?;
    try testing.expectEqual(Derivation.derived, stale.derivation);
    // ...and the row offers no version, because no such file exists.
    try testing.expect(stale.index_version == null);
    try testing.expect(!f.files.terms.?.has(stale.md5, noteindex.index_version - 1));
}

// ---- tests: the manifest on the wire ----

/// Shared with `webapp/tests/unit/manifestCodec.test.ts`, each side checked
/// against hand-written expectations; do not regenerate to make one pass.
const manifest_golden = @embedFile("testdata/manifest_golden.bin");

/// Rows chosen to hit every branch: a gap inside a tier, `pending` in the
/// high nibble, anchors at tier changes, a two-byte file_id, an absent
/// index_version, and index_version 0.
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

test "the golden manifest encodes byte for byte" {
    const gpa = std.testing.allocator;
    var out: std.ArrayList(u8) = .empty;
    defer out.deinit(gpa);

    try writeManifest(gpa, &out, golden_manifest);

    try testing.expectEqualSlices(u8, manifest_golden, out.items);
}

test "the golden manifest is the size its annotated dump claims" {
    try testing.expectEqual(@as(usize, 130), manifest_golden.len);
    try testing.expectEqual(@as(usize, 9), manifest_header_len);
    try testing.expectEqualSlices(u8, manifest_magic, manifest_golden[0..4]);
    try testing.expectEqual(manifest_format_version, manifest_golden[4]);
}

test "index_version ZERO is a real version and not an absent one" {
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
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;

    _ = try f.putNote(1, "keep.note", &.{"fica"});
    const gone = try f.putNote(1, "gone.note", &.{"sai"});

    var a: std.ArrayList(u8) = .empty;
    defer a.deinit(gpa);
    try writeManifest(gpa, &a, try f.manifest(1));
    const etag_before = bodyEtag(a.items);

    // Stable, or every visit refetches.
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
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;
    _ = try f.putNote(1, "Reunião trimestral.note", &.{"pauta"});

    var out: std.ArrayList(u8) = .empty;
    defer out.deinit(gpa);
    try writeManifest(gpa, &out, try f.manifest(1));
    try testing.expect(std.mem.indexOf(u8, out.items, "Reuni") == null);
    try testing.expect(std.mem.indexOf(u8, out.items, ".note") == null);

    try testing.expect(out.items.len < manifest_header_len + 2 + 32);
    // The absolute anchor survived.
    try testing.expect(out.items[out.items.len - 6] != 0);
}

// ---- tests: plan pin and work pin ----

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

/// VM steps of one drained manifest.
fn manifestSteps(f: *Fixture, user_id: u64) !i64 {
    var c = try Cursor.open(f.db, user_id, f.files.terms);
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
    // The manifest is complete, so it cannot be flat in library size; pin
    // linear in the caller's own live documents, flat in others' and the bin.
    var f = try Fixture.init();
    defer f.deinit();

    try fill(&f, 1, "d", 0, 40);
    const base = try manifestSteps(&f, 1);

    // Another user's library; the bound allows +1 per b-tree level.
    try fill(&f, 2, "o", 0, 400);
    try testing.expect((try manifestSteps(&f, 1)) - base <= 8);

    // The caller's own bin: through the total index it cost +2,000 steps.
    for (0..400) |i| {
        const id = try f.putBytes(
            1,
            try std.fmt.allocPrint(f.a(), "t{d:0>4}.pdf", .{i}),
            try std.fmt.allocPrint(f.a(), "%PDF-1.4 trashed {d}", .{i}),
        );
        try f.files.trash(1, id);
    }
    try testing.expect((try manifestSteps(&f, 1)) - base <= 8);

    // Two slopes over the same fixture so a quadratic term shows. 173 steps
    // per document, about 92 of them the shared tenant predicate; a hand-copied
    // cheaper predicate would be a second opinion that can silently lose a
    // document. On a Pi 1 B+ with 322 documents: 178 ms p50.
    try fill(&f, 1, "d", 40, 240);
    const at_240 = try manifestSteps(&f, 1);
    try fill(&f, 1, "d", 240, 440);
    const at_440 = try manifestSteps(&f, 1);

    const slope_1 = @divTrunc(at_240 - base, 200);
    const slope_2 = @divTrunc(at_440 - at_240, 200);
    try testing.expect(slope_2 <= slope_1 + 4);

    // A level band too, so a cheap empty answer or a per-row walk fails.
    try testing.expect(slope_1 >= 60 and slope_1 <= 300);

    try testing.expectEqual(@as(usize, 440), (try f.manifest(1)).rows.len);
}

// ---- tests: wire size ----

/// The manifest as JSON, the encoding being measured against.
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

/// gzip level 6, as every figure in this tree.
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
    // 1,222 documents (the real corpus), timestamps spread over two years.
    // Measured: JSON 143,139 raw / 38,597 gzip, binary 27,663 / 26,937. md5s
    // are 72.6% of the gzipped binary and do not compress.
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

        // Bounds, not equalities: timestamps are randomised.
        try testing.expect(json.items.len / n <= 130); // measured 117-119
        try testing.expect(json_gz / n <= 45); // measured 31.6 at scale, 39.6 at 13
        try testing.expect(bin.items.len / n <= 26); // measured 22.6
        try testing.expect(bin_gz / n <= 30); // measured 22.0 at scale, 25.4 at 13

        // The floor is 16 raw md5 bytes per row.
        try testing.expect(bin.items.len > n * 16);
    }

    // Binary gzip at most three quarters of JSON gzip (measured 69.8%).
    try testing.expect(bin_gz_full * 4 <= json_gz_full * 3);

    try testing.expect(bin_gz_full > 1222 * 16);
}
