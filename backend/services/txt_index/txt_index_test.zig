//! Tests for `.txt` indexing.

const std = @import("std");
const sqlite = @import("../../db/sqlite.zig");
const derivesearch = @import("../derive_search.zig");
const blobstore = @import("../../store/blobs.zig");
const noteindex = @import("../note_index.zig");
const Allocator = std.mem.Allocator;
const testing = std.testing;
const schema = @import("../../db/schema.zig");
const thumbstore = @import("../../store/thumbs.zig");
const filesmod = @import("../files.zig");
const deferredmod = @import("../deferred.zig");
const derivedstore = @import("../../store/derived.zig");
const nb = @import("note_builder");
const txt_index = @import("../txt_index.zig");
const max_file_bytes = txt_index.max_file_bytes;
const wants = txt_index.wants;
const deriveSlice = txt_index.deriveSlice;
const derive = txt_index.derive;
const deriveStored = txt_index.deriveStored;
const rowCount = txt_index.rowCount;
const Verdict = txt_index.Verdict;
const verdictFor = txt_index.verdictFor;
const needsDerive = txt_index.needsDerive;

test "wants: .txt only, case-insensitive, leading-dot and trailing-dot excluded" {
    try testing.expect(wants("notes.txt"));
    try testing.expect(wants("NOTES.TXT"));
    try testing.expect(wants("a.b.txt"));
    try testing.expect(!wants(".txt")); // leading dot: no extension
    try testing.expect(!wants("notes.")); // trailing dot
    try testing.expect(!wants("notes"));
    try testing.expect(!wants("notes.md"));
    try testing.expect(!wants("notes.txt.bak"));
}

test "invalid UTF-8 is lossily replaced in the INDEX copy only; the range still addresses raw bytes" {
    const blob = "good \xff\xfe bytes\n\nsecond\n";
    var d = try deriveSlice(testing.allocator, blob);
    defer d.deinit();

    try testing.expectEqual(@as(usize, 2), d.segments.len);
    try testing.expect(std.unicode.utf8ValidateSlice(d.segments[0].text));
    try testing.expect(std.mem.indexOf(u8, d.segments[0].text, "\u{FFFD}") != null);
    const off: usize = @intCast(d.segments[0].offset);
    try testing.expectEqualStrings("good \xff\xfe bytes", blob[off..][0..d.segments[0].len]);
}

test "hostile input: NULs and truncated sequences chunk without panic, text sanitized" {
    const blob = "a\x00b\n\n\xe2\x82\n\nplain\n";
    var d = try deriveSlice(testing.allocator, blob);
    defer d.deinit();
    try testing.expectEqual(@as(usize, 3), d.segments.len);
    for (d.segments) |seg| try testing.expect(std.unicode.utf8ValidateSlice(seg.text));
}

test "empty and whitespace-only files chunk to nothing" {
    for ([_][]const u8{ "", "\n\n\n", "   \t\n  \n" }) |blob| {
        var d = try deriveSlice(testing.allocator, blob);
        defer d.deinit();
        try testing.expectEqual(@as(usize, 0), d.segments.len);
        try testing.expect(!d.skipped_over_cap);
        try testing.expectEqual(@as(usize, 1), rowCount(d));
    }
}

test "a file over the 16 MiB cap is skipped WHOLE (logged), never silently truncated" {
    const saved = testing.log_level;
    testing.log_level = .err; // the warn is the contract; silence it for the suite
    defer testing.log_level = saved;

    const gpa = testing.allocator;
    const big = try gpa.alloc(u8, max_file_bytes + 1);
    defer gpa.free(big);
    @memset(big, 'x');

    var d = try deriveSlice(gpa, big);
    defer d.deinit();
    try testing.expectEqual(@as(usize, 0), d.segments.len);
    try testing.expect(d.skipped_over_cap);
    try testing.expectEqual(Verdict.over_cap, verdictFor(d));
}

test "the ranged (blob-store) source derives identically to the slice source" {
    const gpa = testing.allocator;
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    const store = try blobstore.BlobStore.init(testing.io, tmp.dir);

    const blob = "alpha one\n\nbeta two\n\ngamma three\n";
    var r = std.Io.Reader.fixed(blob);
    const put = try store.put(&r, null);

    var a_ = try deriveSlice(gpa, blob);
    defer a_.deinit();
    var b = (try deriveStored(gpa, store, &put.md5)).?;
    defer b.deinit();

    try testing.expectEqual(a_.segments.len, b.segments.len);
    for (a_.segments, b.segments) |x, y| {
        try testing.expectEqual(x.offset, y.offset);
        try testing.expectEqual(x.len, y.len);
        try testing.expectEqualStrings(x.text, y.text);
    }
}

const Put = struct { id: u64, md5: [32]u8 };

/// One `text/<md5>` record line.
const Record = struct {
    ordinal: i64,
    offset: i64,
    length: i64,
    text: []const u8,
};

fn allTermsIn(text: []const u8, q: []const u8) bool {
    var it = std.mem.tokenizeAny(u8, q, " \t\n");
    var any = false;
    while (it.next()) |t| {
        any = true;
        if (std.ascii.findIgnoreCase(text, t) == null) return false;
    }
    return any;
}

const Fixture = struct {
    db: sqlite.Db,
    files: filesmod.Files,
    terms: derivedstore.DerivedStore,
    text: derivedstore.DerivedStore,
    tmp: testing.TmpDir,
    arena: std.heap.ArenaAllocator,

    fn init() !Fixture {
        const tmp = testing.tmpDir(.{});
        var db = try sqlite.Db.openMemory();
        try schema.migrate(db);
        for ([_]u8{ 1, 2 }) |uid| {
            try db.run(
                "INSERT INTO users(id, email, password_md5, created_at) VALUES(?1, ?1 || '@b.c', '0123456789abcdef0123456789abcdef', 0);",
                &.{.{ .int = uid }},
            );
            try db.run(
                "INSERT INTO capacity(user_id, used_bytes, total_bytes) VALUES(?1, 0, 1000000000);",
                &.{.{ .int = uid }},
            );
        }
        const store_ = try blobstore.BlobStore.init(testing.io, tmp.dir);
        const thumbs_dir = try tmp.dir.createDirPathOpen(testing.io, "thumbs", .{});
        const thumbs = try thumbstore.ThumbStore.init(testing.io, thumbs_dir);
        const terms_dir = try tmp.dir.createDirPathOpen(testing.io, "terms", .{});
        const text_dir = try tmp.dir.createDirPathOpen(testing.io, "text", .{});
        const terms = try derivedstore.DerivedStore.init(testing.io, terms_dir);
        const text = try derivedstore.DerivedStore.init(testing.io, text_dir);

        var files = filesmod.Files.init(testing.allocator, testing.io, db, store_, thumbs);
        // The purge path unlinks a reaped blob's derived files through these.
        files.terms = terms;
        files.text = text;
        return .{
            .db = db,
            .files = files,
            .terms = terms,
            .text = text,
            .tmp = tmp,
            .arena = std.heap.ArenaAllocator.init(testing.allocator),
        };
    }

    fn deinit(f: *Fixture) void {
        f.arena.deinit();
        f.db.close();
        f.tmp.cleanup();
    }

    fn a(f: *Fixture) Allocator {
        return f.arena.allocator();
    }

    /// Upload, then drain the deferred worker: the real sequence.
    fn put(f: *Fixture, user_id: u64, name: []const u8, bytes: []const u8) !Put {
        const up = try f.putRaw(user_id, name, bytes);
        f.drain();
        return up;
    }

    fn putRaw(f: *Fixture, user_id: u64, name: []const u8, bytes: []const u8) !Put {
        var r = std.Io.Reader.fixed(bytes);
        const e = try f.files.putFile(user_id, null, name, &r, null);
        defer e.deinit(testing.allocator);
        var md5: [32]u8 = undefined;
        @memcpy(&md5, e.md5.?[0..32]);
        return .{ .id = e.id, .md5 = md5 };
    }

    fn drain(f: *Fixture) void {
        var lock: std.Io.Mutex = .init;
        var w: deferredmod.Worker = .{
            .gpa = testing.allocator,
            .db = f.db,
            .blobs = f.files.blobs,
            .lock = &lock,
            .io = testing.io,
            .terms = f.terms,
            .text = f.text,
        };
        w.drain();
    }

    /// The `text/<md5>` record, parsed. `n` (address space) and the row count
    /// are deliberately different numbers.
    fn records(f: *Fixture, md5: []const u8) !struct { n: i64, rows: []const Record } {
        const raw = try derivedstore.readPlain(f.a(), f.text, md5, derivesearch.index_version);
        var lines = std.mem.tokenizeScalar(u8, raw, '\n');
        const head = try std.json.parseFromSlice(std.json.Value, f.a(), lines.next().?, .{});
        var out: std.ArrayList(Record) = .empty;
        while (lines.next()) |line| {
            const v = try std.json.parseFromSlice(std.json.Value, f.a(), line, .{});
            try out.append(f.a(), .{
                .ordinal = v.value.object.get("p").?.integer,
                .offset = v.value.object.get("o").?.integer,
                .length = v.value.object.get("l").?.integer,
                .text = try f.a().dupe(u8, v.value.object.get("t").?.string),
            });
        }
        return .{ .n = head.value.object.get("n").?.integer, .rows = out.items };
    }

    /// Records of `md5` carrying every token of `q`, in ordinal order.
    fn matching(f: *Fixture, md5: []const u8, q: []const u8) ![]const Record {
        const all = try f.records(md5);
        var out: std.ArrayList(Record) = .empty;
        for (all.rows) |r| if (allTermsIn(r.text, q)) try out.append(f.a(), r);
        return out.items;
    }

    fn count(f: *Fixture, sql: []const u8) !i64 {
        var s = try f.db.prepare(sql);
        defer s.finalize();
        _ = try s.step();
        return s.columnInt(0);
    }
};

test "A .txt DERIVATION IS TWO FILES AND A VERDICT — and no `note_page_index` rows at all" {
    var f = try Fixture.init();
    defer f.deinit();

    const put = try f.put(1, "doc.txt", "alpha one\n\nbeta two words\n\ngamma three");

    try testing.expect(f.terms.has(&put.md5, derivesearch.index_version));
    try testing.expect(f.text.has(&put.md5, derivesearch.index_version));
    try testing.expect(!try needsDerive(f.db, &put.md5)); // the memo, written last

    try testing.expectEqual(@as(i64, 0), try f.count("SELECT indexable FROM note_index;"));
    try testing.expectEqual(noteindex.index_version, try f.count("SELECT index_version FROM note_index;"));
    try testing.expectEqual(@as(i64, 0), try f.count("SELECT COUNT(*) FROM note_page_index;"));
}

test "FIND-IN-TXT'S MATERIAL: one record per paragraph, its ordinal, and a byte range that replays exactly" {
    var f = try Fixture.init();
    defer f.deinit();

    const blob = "the target sits here\n\nno match in this one\n\ntarget then target again\n";
    const put = try f.put(1, "doc.txt", blob);

    const all = try f.records(&put.md5);
    try testing.expectEqual(@as(i64, 3), all.n);
    try testing.expectEqual(@as(usize, 3), all.rows.len);

    const hits = try f.matching(&put.md5, "target");
    try testing.expectEqual(@as(usize, 2), hits.len);
    try testing.expectEqual(@as(i64, 0), hits[0].ordinal);
    try testing.expectEqual(@as(usize, 1), std.mem.count(u8, hits[0].text, "target"));
    try testing.expectEqual(@as(i64, 2), hits[1].ordinal);
    try testing.expectEqual(@as(usize, 2), std.mem.count(u8, hits[1].text, "target"));

    for (all.rows) |r| {
        const off: usize = @intCast(r.offset);
        const len: usize = @intCast(r.length);
        try testing.expectEqualStrings(r.text, blob[off..][0..len]);
    }
}

test "AND semantics are per-PARAGRAPH: adjacent paragraphs do not co-match, one paragraph does" {
    var f = try Fixture.init();
    defer f.deinit();

    const split = try f.put(1, "adjacent.txt", "solitary wordalpha here\n\nsolitary wordbeta there\n");
    const one = try f.put(1, "together.txt", "both wordgamma and worddelta in one paragraph\n");

    try testing.expectEqual(@as(usize, 0), (try f.matching(&split.md5, "wordalpha wordbeta")).len);
    try testing.expectEqual(@as(usize, 1), (try f.matching(&one.md5, "wordgamma worddelta")).len);
}

test "THE STORED PARAGRAPH IS UNFOLDED: accents survive into the text record" {
    var f = try Fixture.init();
    defer f.deinit();

    // `text/` is unfolded (accents intact, unlike `terms/`); folding on the way
    // in would break both the viewer's marks and the byte ranges.
    const put = try f.put(1, "notes.txt", "a linha sobre caf\u{00e9} aqui\n\nplain paragraph\n");

    const rows = try f.matching(&put.md5, "linha");
    try testing.expectEqual(@as(usize, 1), rows.len);
    try testing.expectEqual(@as(i64, 0), rows[0].ordinal);
    try testing.expectEqualStrings("a linha sobre caf\u{00e9} aqui", rows[0].text);
}

test "an EDIT is a new blob, and the new content derives under its own md5" {
    var f = try Fixture.init();
    defer f.deinit();

    const v1 = try f.put(1, "doc.txt", "alpha one\n\nbeta two\n");
    const v2 = try f.put(1, "doc.txt", "alpha one\n\nBETA EDITED\n\ngamma three\n");
    try testing.expect(!std.mem.eql(u8, &v1.md5, &v2.md5));

    const rows = (try f.records(&v2.md5)).rows;
    try testing.expectEqual(@as(usize, 3), rows.len);
    try testing.expectEqualStrings("BETA EDITED", rows[1].text);
    try testing.expectEqualStrings("gamma three", rows[2].text);
    try testing.expectEqual(@as(usize, 1), (try f.matching(&v2.md5, "EDITED")).len);
}

test "an empty .txt records its verdict: no records, no re-derive" {
    var f = try Fixture.init();
    defer f.deinit();

    const put = try f.put(1, "empty.txt", "");
    try testing.expect(!try needsDerive(f.db, &put.md5)); // the memo

    const all = try f.records(&put.md5);
    try testing.expectEqual(@as(i64, 1), all.n);
    try testing.expectEqual(@as(usize, 0), all.rows.len);
}

test "a real .note named .txt is never split: the parser's verdict wins over the extension" {
    var f = try Fixture.init();
    defer f.deinit();

    const note_bytes = try nb.serialize(testing.allocator, .{ .pages = &.{.{
        .layers = &.{.{ .slot = .main, .bitmap = "AAAA" }},
        .recogn_status = 1,
        .recogn_labels = &.{"genuine ink"},
    }} });
    defer testing.allocator.free(note_bytes);
    const put = try f.put(1, "disguised.txt", note_bytes);

    try testing.expectEqual(@as(i64, 1), try f.count("SELECT indexable FROM note_index;"));
    try testing.expect(!try needsDerive(f.db, &put.md5)); // `indexable = 1` is the whole answer
    try testing.expectEqual(@as(i64, 1), try f.count("SELECT COUNT(*) FROM note_page_index WHERE kind = 0;"));
    try testing.expectEqual(@as(i64, 0), try f.count("SELECT COUNT(*) FROM note_page_index WHERE kind <> 0;"));

    const raw = try derivedstore.readPlain(f.a(), f.text, &put.md5, derivesearch.index_version);
    try testing.expect(std.mem.indexOf(u8, raw, "genuine ink") != null);
}

test "content linked under a non-.txt name derives when a .txt name arrives" {
    var f = try Fixture.init();
    defer f.deinit();

    const body = "one single paragraph of prose\n";
    const bin = try f.put(1, "data.bin", body); // no txt gate: not offered
    try testing.expect(try needsDerive(f.db, &bin.md5));
    try testing.expect(!f.text.has(&bin.md5, derivesearch.index_version));

    // Same content under a `.txt` name derives per blob, for both holders.
    const txt = try f.put(1, "prose.txt", body);
    try testing.expectEqualStrings(&bin.md5, &txt.md5); // content addressing: one blob
    try testing.expect(!try needsDerive(f.db, &txt.md5));
    try testing.expectEqual(@as(usize, 1), (try f.matching(&txt.md5, "prose")).len);
}

test "v5→v6 HEAL: a stale .txt is not offered, and the note half's heal is what makes it derivable" {
    var f = try Fixture.init();
    defer f.deinit();

    const put = try f.put(1, "legacy.txt", "healed alpha\n\nhealed beta\n");

    // A pre-upgrade v5 row: no verdict, no derived files.
    try f.db.exec("UPDATE note_index SET index_version = 5, txt_index = NULL;");
    f.terms.remove(&put.md5, derivesearch.index_version);
    f.text.remove(&put.md5, derivesearch.index_version);

    try testing.expect(try needsDerive(f.db, &put.md5));
    try testing.expect(try noOfferedTxt(&f));

    try noteindex.ensureIndexed(testing.allocator, testing.io, f.db, f.files.blobs, &put.md5, 42);
    try testing.expect(try needsDerive(f.db, &put.md5));
    try testing.expect(!try noOfferedTxt(&f)); // ...and now it IS offered.

    f.drain();
    try testing.expect(!try needsDerive(f.db, &put.md5));
    try testing.expect(f.terms.has(&put.md5, derivesearch.index_version));
    try testing.expect(f.text.has(&put.md5, derivesearch.index_version));
    try testing.expectEqual(@as(usize, 1), (try f.matching(&put.md5, "alpha")).len);
}

/// True when the `.txt` tenant's discovery query has nothing to offer.
fn noOfferedTxt(f: *Fixture) !bool {
    const found = try deferredmod.nextJob(testing.allocator, f.db) orelse return true;
    defer testing.allocator.free(found.name);
    return !std.mem.eql(u8, found.tenant.name, "txt");
}

test "purge and GC: a purged .txt takes its derived files with it" {
    var f = try Fixture.init();
    defer f.deinit();

    const put = try f.put(1, "gone.txt", "ephemeral paragraph\n");
    try testing.expect(f.terms.has(&put.md5, derivesearch.index_version));
    try testing.expect(f.text.has(&put.md5, derivesearch.index_version));

    // The bin holds the reference, so restore must cost nothing.
    try f.files.trash(1, put.id);
    try testing.expect(f.text.has(&put.md5, derivesearch.index_version));

    try f.files.purge(1, put.id);
    try testing.expectEqual(@as(i64, 0), try f.count("SELECT COUNT(*) FROM blobs;"));
    try testing.expectEqual(@as(i64, 0), try f.count("SELECT COUNT(*) FROM note_page_index;"));
    try testing.expect(!f.terms.has(&put.md5, derivesearch.index_version));
    try testing.expect(!f.text.has(&put.md5, derivesearch.index_version));
}
