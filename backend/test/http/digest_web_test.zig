//! The browser's Digest over HTTP: what the person's tablet synced, read back
//! with where each digest came from, and the handwritten notes' pages.

const std = @import("std");
const testing = std.testing;
const gpa = testing.allocator;
const harness = @import("harness.zig");
const helpers = @import("digest_helpers.zig");
const wire = @import("../wire.zig");
const Fixture = harness.Fixture;
const onboardWeb = harness.onboardWeb;
const requestWithCookie = harness.requestWithCookie;
const deviceLogin = harness.deviceLogin;
const putSeed = harness.putSeed;
const expectHeaderContains = harness.expectHeaderContains;
const expectFailure = harness.expectFailure;

/// The Nomad's note digest of 2026-11-10: handwriting on page 2, converted.
const note_add =
    \\{"commentStr":"","content":"This is a test note.","creationTime":1794354714865,"lastModifiedTime":1794354714866,"md5Hash":"b018b3f88421e0b94e6860bd88d4d9ea","metadata":"{\"author\":\"\",\"note_page\":\"2\",\"note_fileId\":\"F20261109060649314933DT231jzqIRw9\",\"note_pageId\":\"P20261109062932431207F1CB7AuJNdF7\",\"unique_identifier\":\"75d4b7d10094123e92ec7673753bbc2c\"}","parentUniqueIdentifier":"kb-phon","sourcePath":"Note/20261109_060644.note","sourceType":2}
;
const manual_add =
    \\{"commentStr":"  Note\n","content":"Typed on the tablet","md5Hash":"m3","metadata":"{\"unique_identifier\":\"u-manual\"}","parentUniqueIdentifier":"","sourcePath":"","sourceType":4}
;

const Listing = struct {
    enabled: bool,
    categories: []const struct { uid: []const u8, name: []const u8 } = &.{},
    digests: []const struct {
        id: u64,
        text: []const u8,
        comment: ?[]const u8 = null,
        categoryUid: []const u8,
        author: ?[]const u8 = null,
        createdAt: i64,
        source: struct { kind: []const u8, path: ?[]const u8 = null, fileId: ?u64 = null, page: ?i64 = null, changed: bool = false },
        note: ?[]const u8 = null,
        waiting: bool,
    } = &.{},
    tabletSyncedAt: ?i64 = null,
    waiting: bool = false,
};

const Bufs = struct { obuf: [16384]u8 = undefined, reqbuf: [8192]u8 = undefined };

/// A person signed in on the web and on their tablet.
const Person = struct { web: [32]u8, tablet: [32]u8, id: u64 };

fn person(f: *Fixture, b: *Bufs, who: []const u8) !Person {
    const admin = f.svc.userIdByEmail("admin") catch null orelse try f.svc.bootstrapAdmin("admin", "temp0000");
    const temp = try f.svc.createUser(admin, who, false);
    const web = try onboardWeb(&f.ctx, who, temp.temp_password.slice(), "apass111");
    return .{ .web = web, .tablet = try deviceLogin(&f.ctx, &b.obuf, &b.reqbuf, who, "apass111", "SN1"), .id = temp.id };
}

fn get(f: *Fixture, b: *Bufs, path: []const u8, tok: []const u8) !harness.Response {
    return requestWithCookie(&f.ctx, &b.obuf, &b.reqbuf, "GET", path, tok, "");
}

fn put(f: *Fixture, b: *Bufs, path: []const u8, tok: []const u8, body: []const u8) !harness.Response {
    return requestWithCookie(&f.ctx, &b.obuf, &b.reqbuf, "PUT", path, tok, body);
}

fn listing(f: *Fixture, b: *Bufs, tok: []const u8) !std.json.Parsed(Listing) {
    const resp = try get(f, b, "/api/controlplane/digests", tok);
    try testing.expectEqual(@as(u16, 200), resp.status);
    return std.json.parseFromSlice(Listing, gpa, resp.body, .{ .ignore_unknown_fields = true, .allocate = .alloc_always });
}

test "off: the listing says so and serves nothing" {
    const f = try Fixture.init();
    defer f.deinit();
    var b: Bufs = .{};
    _ = try f.svc.bootstrapAdmin("ana", "temp0000");
    const tok = try onboardWeb(&f.ctx, "ana", "temp0000", "anapass1");

    var l = try listing(f, &b, &tok);
    defer l.deinit();
    try testing.expect(!l.value.enabled);
    try testing.expectEqual(@as(usize, 0), l.value.digests.len);
    const resp = try get(f, &b, "/api/controlplane/digests/1/note/245354713d4c121a2368d9295f6379ca", &tok);
    try testing.expectEqual(@as(u16, 404), resp.status);
    const edit = try put(f, &b, "/api/controlplane/digests/1", &tok, "{\"comment\":\"x\"}");
    try testing.expectEqual(@as(u16, 409), edit.status);
    try expectFailure(edit.body, "DIGEST_SYNC_OFF");
}

test "a person's digests: categories, sources found in the library, pages 1-based; another person sees none" {
    const f = try Fixture.init();
    defer f.deinit();
    f.ctx.config.digest_sync = true;
    var b: Bufs = .{};
    const ana = try person(f, &b, "ana");
    const rui = try person(f, &b, "rui");

    // The PDF is in the library; the notebook is not (yet).
    const folder = try f.files.ensureFolderPath(ana.id, "NOTE/MyStyle/Français");
    const pdf = try putSeed(f, ana.id, folder, "La_phonetique_du_francais_Prof_Flavio_Adler.pdf", "%PDF-1.4 stand-in");

    _ = try helpers.addId(f, &b.obuf, &b.reqbuf, &ana.tablet, "/api/file/add/summary/group",
        \\{"uniqueIdentifier":"kb-phon","name":"Phonétique","md5Hash":"g1","creationTime":1,"lastModifiedTime":1}
    );
    const pdf_digest = try helpers.addId(f, &b.obuf, &b.reqbuf, &ana.tablet, "/api/file/add/summary", helpers.nomad_add);
    const note_digest = try helpers.addId(f, &b.obuf, &b.reqbuf, &ana.tablet, "/api/file/add/summary", note_add);
    const manual = try helpers.addId(f, &b.obuf, &b.reqbuf, &ana.tablet, "/api/file/add/summary", manual_add);

    {
        var l = try listing(f, &b, &ana.web);
        defer l.deinit();
        const v = l.value;
        try testing.expect(v.enabled);
        try testing.expectEqual(@as(usize, 1), v.categories.len);
        try testing.expectEqualStrings("kb-phon", v.categories[0].uid);
        try testing.expectEqualStrings("Phonétique", v.categories[0].name);
        try testing.expectEqual(@as(usize, 3), v.digests.len);

        const d0 = v.digests[0];
        try testing.expectEqual(pdf_digest, d0.id);
        try testing.expectEqualStrings("La phonétique du français", d0.text);
        try testing.expectEqualStrings("yeah", d0.comment.?);
        try testing.expectEqualStrings("", d0.categoryUid);
        try testing.expectEqualStrings("john", d0.author.?);
        try testing.expectEqual(@as(i64, 1794175867249), d0.createdAt);
        try testing.expectEqualStrings("document", d0.source.kind);
        try testing.expectEqual(@as(?u64, pdf), d0.source.fileId);
        try testing.expectEqual(@as(?i64, 1), d0.source.page);
        // The tablet reported a note it has not uploaded: nothing to serve.
        try testing.expectEqual(@as(?[]const u8, null), d0.note);

        const d1 = v.digests[1];
        try testing.expectEqual(note_digest, d1.id);
        try testing.expectEqualStrings("note", d1.source.kind);
        try testing.expectEqualStrings("Note/20261109_060644.note", d1.source.path.?);
        try testing.expectEqual(@as(?u64, null), d1.source.fileId);
        try testing.expectEqual(@as(?i64, 2), d1.source.page);
        try testing.expectEqualStrings("kb-phon", d1.categoryUid);
        try testing.expectEqual(@as(?[]const u8, null), d1.comment);

        const d2 = v.digests[2];
        try testing.expectEqual(manual, d2.id);
        try testing.expectEqualStrings("manual", d2.source.kind);
        try testing.expectEqual(@as(?[]const u8, null), d2.source.path);
        // The blank space the tablet left around its comment is not listed.
        try testing.expectEqualStrings("Note", d2.comment.?);
    }
    {
        var l = try listing(f, &b, &rui.web);
        defer l.deinit();
        try testing.expect(l.value.enabled);
        try testing.expectEqual(@as(usize, 0), l.value.categories.len);
        try testing.expectEqual(@as(usize, 0), l.value.digests.len);
    }
    // A deleted digest leaves the listing.
    {
        var body: [32]u8 = undefined;
        _ = try helpers.call(f, &b.obuf, &b.reqbuf, &ana.tablet, "DELETE", "/api/file/delete/summary", try std.fmt.bufPrint(&body, "{{\"id\":{d}}}", .{manual}));
        var l = try listing(f, &b, &ana.web);
        defer l.deinit();
        try testing.expectEqual(@as(usize, 2), l.value.digests.len);
    }
}

test "a handwritten note's page: served under its md5, immutable, to its owner only" {
    const f = try Fixture.init();
    defer f.deinit();
    f.ctx.config.digest_sync = true;
    var b: Bufs = .{};
    const ana = try person(f, &b, "ana");
    const rui = try person(f, &b, "rui");

    // A digest's note: a one-page `.mark` of the Nomad's panel.
    const nb = @import("note_builder");
    const bmp = [_]u8{ 0x61, 0x00, 0x62, 0x03 };
    const mark = try nb.serialize(gpa, .{
        .filetype = "mark",
        .header = &.{.{ .key = "APPLY_EQUIPMENT", .value = "N6" }},
        .pages = &.{.{ .layers = &.{.{ .slot = .main, .bitmap = &bmp }} }},
    });
    defer gpa.free(mark);
    const md5 = helpers.md5Hex(mark);
    const inner = try helpers.uploadNote(f, &b.obuf, &b.reqbuf, &ana.tablet, mark);
    const add = try helpers.noteAdd(gpa, &inner, &md5, "u-note");
    defer gpa.free(add);
    const id = try helpers.addId(f, &b.obuf, &b.reqbuf, &ana.tablet, "/api/file/add/summary", add);

    {
        var l = try listing(f, &b, &ana.web);
        defer l.deinit();
        try testing.expectEqualStrings(&md5, l.value.digests[0].note.?);
    }

    var pbuf: [96]u8 = undefined;
    const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/digests/{d}/note/{s}", .{ id, &md5 });
    {
        const resp = try get(f, &b, path, &ana.web);
        try testing.expectEqual(@as(u16, 200), resp.status);
        try expectHeaderContains(resp.head, "immutable");
        try expectHeaderContains(resp.head, "etag:");
        try testing.expect(resp.body.len > 0);
    }
    // Someone else's digest, a stale md5, a digest that does not exist.
    try testing.expectEqual(@as(u16, 404), (try get(f, &b, path, &rui.web)).status);
    {
        const stale = try std.fmt.bufPrint(&pbuf, "/api/controlplane/digests/{d}/note/{s}", .{ id, "0123456789abcdef0123456789abcdef" });
        const resp = try get(f, &b, stale, &ana.web);
        try testing.expectEqual(@as(u16, 404), resp.status);
        // A miss is never cached as if it were the note.
        try harness.expectHeaderAbsentSubstring(resp.head, "immutable");
    }
    {
        const missing = try std.fmt.bufPrint(&pbuf, "/api/controlplane/digests/{d}/note/{s}", .{ id + 100, &md5 });
        try testing.expectEqual(@as(u16, 404), (try get(f, &b, missing, &ana.web)).status);
    }
}

/// The manifest's row for `id`, as the tablet's app reads it.
fn manifestRow(f: *Fixture, b: *Bufs, tok: *const [32]u8, id: u64) !struct { md5: [32]u8, modified: i64 } {
    const resp = try helpers.call(f, &b.obuf, &b.reqbuf, tok, "POST", "/api/file/query/summary/hash", "{\"page\":0,\"size\":0}");
    var p = try std.json.parseFromSlice(struct { summaryInfoVOList: []const struct { id: u64, md5Hash: []const u8, lastModifiedTime: i64 } }, gpa, resp.body, .{ .ignore_unknown_fields = true });
    defer p.deinit();
    for (p.value.summaryInfoVOList) |r| if (r.id == id) {
        var md5: [32]u8 = undefined;
        @memcpy(&md5, r.md5Hash[0..32]);
        return .{ .md5 = md5, .modified = r.lastModifiedTime };
    };
    return error.NotInManifest;
}

test "the comment, edited in the browser: a new md5 the tablet takes, waiting until it asks; nothing else changes" {
    const f = try Fixture.init();
    defer f.deinit();
    f.ctx.config.digest_sync = true;
    var b: Bufs = .{};
    const ana = try person(f, &b, "ana");
    const rui = try person(f, &b, "rui");
    const id = try helpers.addId(f, &b.obuf, &b.reqbuf, &ana.tablet, "/api/file/add/summary", helpers.nomad_add);
    const before = try manifestRow(f, &b, &ana.tablet, id);

    var pbuf: [64]u8 = undefined;
    const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/digests/{d}", .{id});
    try harness.expectSuccess((try put(f, &b, path, &ana.web, "{\"comment\":\"  Learn it by heart \\n\"}")).body);
    {
        var l = try listing(f, &b, &ana.web);
        defer l.deinit();
        const d = l.value.digests[0];
        try testing.expectEqualStrings("Learn it by heart", d.comment.?);
        try testing.expectEqualStrings("La phonétique du français", d.text);
        try testing.expect(d.waiting and l.value.waiting);
    }
    // The tablet's next sync: a new md5 and a later time, so its app takes the
    // server's copy; asking for the manifest is the fetch, and nothing waits.
    const after = try manifestRow(f, &b, &ana.tablet, id);
    try testing.expect(!std.mem.eql(u8, &before.md5, &after.md5));
    try testing.expect(after.modified > before.modified);
    {
        var l = try listing(f, &b, &ana.web);
        defer l.deinit();
        try testing.expect(!l.value.digests[0].waiting and !l.value.waiting);
        try testing.expect(l.value.tabletSyncedAt != null);
    }
    {
        var body: [32]u8 = undefined;
        const resp = try helpers.call(f, &b.obuf, &b.reqbuf, &ana.tablet, "POST", "/api/file/query/summary/id", try std.fmt.bufPrint(&body, "{{\"ids\":[{d}]}}", .{id}));
        try testing.expect(std.mem.indexOf(u8, resp.body, "\"commentStr\":\"Learn it by heart\"") != null);
        // The handwritten note is the tablet's, untouched.
        try testing.expect(std.mem.indexOf(u8, resp.body, "245354713d4c121a2368d9295f6379ca") != null);
    }

    // "" removes the comment.
    try harness.expectSuccess((try put(f, &b, path, &ana.web, "{\"comment\":\"\"}")).body);
    {
        var l = try listing(f, &b, &ana.web);
        defer l.deinit();
        try testing.expectEqual(@as(?[]const u8, null), l.value.digests[0].comment);
    }

    // Longer than the app holds, no comment at all, someone else's, a digest that is gone.
    const long = try gpa.alloc(u8, 2_001 * 2);
    defer gpa.free(long);
    for (0..2_001) |i| @memcpy(long[i * 2 ..][0..2], "é");
    const too_long = try std.fmt.allocPrint(gpa, "{{\"comment\":\"{s}\"}}", .{long});
    defer gpa.free(too_long);
    try expectFailure((try put(f, &b, path, &ana.web, too_long)).body, "BAD_COMMENT");
    try testing.expectEqual(@as(u16, 400), (try put(f, &b, path, &ana.web, "{}")).status);
    try expectFailure((try put(f, &b, path, &rui.web, "{\"comment\":\"mine\"}")).body, "NO_SUCH_DIGEST");
    const gone = try std.fmt.bufPrint(&pbuf, "/api/controlplane/digests/{d}", .{id + 100});
    try expectFailure((try put(f, &b, gone, &ana.web, "{\"comment\":\"x\"}")).body, "NO_SUCH_DIGEST");
}

test "a digest moved to another category in the browser: the tablet reads it there; only a live category of one's own" {
    const f = try Fixture.init();
    defer f.deinit();
    f.ctx.config.digest_sync = true;
    var b: Bufs = .{};
    const ana = try person(f, &b, "ana");
    const rui = try person(f, &b, "rui");
    _ = try helpers.addId(f, &b.obuf, &b.reqbuf, &ana.tablet, "/api/file/add/summary/group",
        \\{"uniqueIdentifier":"kb-phon","name":"Phonétique","md5Hash":"g1","creationTime":1,"lastModifiedTime":1}
    );
    _ = try helpers.addId(f, &b.obuf, &b.reqbuf, &rui.tablet, "/api/file/add/summary/group",
        \\{"uniqueIdentifier":"kb-rui","name":"Rui's","md5Hash":"g2","creationTime":1,"lastModifiedTime":1}
    );
    const id = try helpers.addId(f, &b.obuf, &b.reqbuf, &ana.tablet, "/api/file/add/summary", helpers.nomad_add);
    const before = try manifestRow(f, &b, &ana.tablet, id);

    var pbuf: [64]u8 = undefined;
    const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/digests/{d}", .{id});
    try harness.expectSuccess((try put(f, &b, path, &ana.web, "{\"categoryUid\":\"kb-phon\"}")).body);
    {
        var l = try listing(f, &b, &ana.web);
        defer l.deinit();
        try testing.expectEqualStrings("kb-phon", l.value.digests[0].categoryUid);
        try testing.expectEqualStrings("yeah", l.value.digests[0].comment.?);
        try testing.expect(l.value.digests[0].waiting);
    }
    try testing.expect(!std.mem.eql(u8, &before.md5, &(try manifestRow(f, &b, &ana.tablet, id)).md5));
    {
        var body: [32]u8 = undefined;
        const resp = try helpers.call(f, &b.obuf, &b.reqbuf, &ana.tablet, "POST", "/api/file/query/summary/id", try std.fmt.bufPrint(&body, "{{\"ids\":[{d}]}}", .{id}));
        try testing.expect(std.mem.indexOf(u8, resp.body, "\"parentUniqueIdentifier\":\"kb-phon\"") != null);
    }
    // Back to Uncategorized; never into a category that is gone or someone else's.
    try harness.expectSuccess((try put(f, &b, path, &ana.web, "{\"categoryUid\":\"\"}")).body);
    try expectFailure((try put(f, &b, path, &ana.web, "{\"categoryUid\":\"kb-gone\"}")).body, "NO_SUCH_CATEGORY");
    try expectFailure((try put(f, &b, path, &ana.web, "{\"categoryUid\":\"kb-rui\"}")).body, "NO_SUCH_CATEGORY");
    // Both at once.
    try harness.expectSuccess((try put(f, &b, path, &ana.web, "{\"comment\":\"moved\",\"categoryUid\":\"kb-phon\"}")).body);
    var l = try listing(f, &b, &ana.web);
    defer l.deinit();
    try testing.expectEqualStrings("moved", l.value.digests[0].comment.?);
    try testing.expectEqualStrings("kb-phon", l.value.digests[0].categoryUid);
}

test "a source changed since its passage was taken is said so; a category with no id is never listed; a malformed id names no digest" {
    const f = try Fixture.init();
    defer f.deinit();
    f.ctx.config.digest_sync = true;
    var b: Bufs = .{};
    const ana = try person(f, &b, "ana");
    // The Nomad's PDF was 407277 bytes when the passage was taken.
    const folder = try f.files.ensureFolderPath(ana.id, "NOTE/MyStyle/Français");
    const same = try gpa.alloc(u8, 407277);
    defer gpa.free(same);
    @memset(same, 'x');
    _ = try putSeed(f, ana.id, folder, "La_phonetique_du_francais_Prof_Flavio_Adler.pdf", same);
    _ = try helpers.addId(f, &b.obuf, &b.reqbuf, &ana.tablet, "/api/file/add/summary", helpers.nomad_add);
    {
        var l = try listing(f, &b, &ana.web);
        defer l.deinit();
        try testing.expect(l.value.digests[0].source.fileId != null);
        try testing.expect(!l.value.digests[0].source.changed);
    }
    _ = try putSeed(f, ana.id, folder, "La_phonetique_du_francais_Prof_Flavio_Adler.pdf", "%PDF-1.4 a different edition");
    {
        var l = try listing(f, &b, &ana.web);
        defer l.deinit();
        try testing.expect(l.value.digests[0].source.changed);
    }

    // A category row stored with an empty id would pose as Uncategorized.
    try f.ctx.db.run("INSERT INTO digests (user_id, is_group, uid, name, md5_hash, created_at, updated_at) VALUES (?1, 1, '', 'Ghost', 'g', 0, 0);", &.{.{ .int = @intCast(ana.id) }});
    {
        var l = try listing(f, &b, &ana.web);
        defer l.deinit();
        try testing.expectEqual(@as(usize, 0), l.value.categories.len);
    }

    try testing.expectEqual(@as(u16, 404), (try get(f, &b, "/api/controlplane/digests/abc/note/245354713d4c121a2368d9295f6379ca", &ana.web)).status);
    try expectFailure((try put(f, &b, "/api/controlplane/digests/abc", &ana.web, "{\"comment\":\"x\"}")).body, "NO_SUCH_DIGEST");
}

fn send(f: *Fixture, b: *Bufs, method: []const u8, path: []const u8, tok: []const u8, body: []const u8) !harness.Response {
    return requestWithCookie(&f.ctx, &b.obuf, &b.reqbuf, method, path, tok, body);
}

const TabletGroups = struct {
    summaryDOList: []const struct { uniqueIdentifier: ?[]const u8 = null, name: ?[]const u8 = null, md5Hash: ?[]const u8 = null, lastModifiedTime: i64 = 0 } = &.{},
};

/// The categories as the tablet's app reads them.
fn tabletGroups(f: *Fixture, b: *Bufs, tok: *const [32]u8) !std.json.Parsed(TabletGroups) {
    const resp = try helpers.call(f, &b.obuf, &b.reqbuf, tok, "POST", "/api/file/query/summary/group", "{\"page\":0,\"size\":50}");
    return std.json.parseFromSlice(TabletGroups, gpa, resp.body, .{ .ignore_unknown_fields = true, .allocate = .alloc_always });
}

/// `{"name":"é…"}` with `n` of them, owned by the caller.
fn nameOf(n: usize) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(gpa);
    try out.appendSlice(gpa, "{\"name\":\"");
    for (0..n) |_| try out.appendSlice(gpa, "é");
    try out.appendSlice(gpa, "\"}");
    return out.toOwnedSlice(gpa);
}

test "categories made, renamed and deleted in the browser: what the tablet's sync reads; the app's name rules" {
    const f = try Fixture.init();
    defer f.deinit();
    f.ctx.config.digest_sync = true;
    var b: Bufs = .{};
    const ana = try person(f, &b, "ana");
    const rui = try person(f, &b, "rui");

    const made = try send(f, &b, "POST", "/api/controlplane/digests/categories", &ana.web, "{\"name\":\"  Verbes \"}");
    try testing.expectEqual(@as(u16, 200), made.status);
    var created = try std.json.parseFromSlice(struct { uid: []const u8, name: []const u8 }, gpa, made.body, .{ .ignore_unknown_fields = true, .allocate = .alloc_always });
    defer created.deinit();
    try testing.expectEqualStrings("Verbes", created.value.name);
    try testing.expectEqual(@as(usize, 32), created.value.uid.len);
    {
        var g = try tabletGroups(f, &b, &ana.tablet);
        defer g.deinit();
        try testing.expectEqual(@as(usize, 1), g.value.summaryDOList.len);
        try testing.expectEqualStrings(created.value.uid, g.value.summaryDOList[0].uniqueIdentifier.?);
        try testing.expectEqualStrings("Verbes", g.value.summaryDOList[0].name.?);
    }
    {
        var l = try listing(f, &b, &ana.web);
        defer l.deinit();
        try testing.expectEqual(@as(usize, 1), l.value.categories.len);
        try testing.expect(l.value.waiting);
    }

    // The app's rules: none empty, none past 150 characters, none starting with a dot,
    // none with a character a file name may not hold, no second of a name.
    const bad = [_][]const u8{ "{\"name\":\"   \"}", "{\"name\":\".hidden\"}", "{\"name\":\"a/b\"}", "{\"name\":\"a:b\"}", "{\"name\":\"say \\\"hi\\\"\"}", "{\"name\":\"two\\nlines\"}", "{\"name\":\"a\\tb\"}" };
    for (bad) |body| try expectFailure((try send(f, &b, "POST", "/api/controlplane/digests/categories", &ana.web, body)).body, "BAD_NAME");
    const long = try nameOf(151);
    defer gpa.free(long);
    try expectFailure((try send(f, &b, "POST", "/api/controlplane/digests/categories", &ana.web, long)).body, "BAD_NAME");
    const longest = try nameOf(150);
    defer gpa.free(longest);
    try harness.expectSuccess((try send(f, &b, "POST", "/api/controlplane/digests/categories", &ana.web, longest)).body);
    try expectFailure((try send(f, &b, "POST", "/api/controlplane/digests/categories", &ana.web, "{\"name\":\"Verbes\"}")).body, "NAME_TAKEN");
    // Another person's names are their own.
    try harness.expectSuccess((try send(f, &b, "POST", "/api/controlplane/digests/categories", &rui.web, "{\"name\":\"Verbes\"}")).body);

    var pbuf: [128]u8 = undefined;
    const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/digests/categories/{s}", .{created.value.uid});
    const before = blk: {
        var g = try tabletGroups(f, &b, &ana.tablet);
        defer g.deinit();
        for (g.value.summaryDOList) |c| if (std.mem.eql(u8, c.uniqueIdentifier.?, created.value.uid)) break :blk c.lastModifiedTime;
        unreachable;
    };
    // Renaming to its own name is no clash; a new md5 and a later time make the tablet take it.
    try harness.expectSuccess((try send(f, &b, "PUT", path, &ana.web, "{\"name\":\"Verbes\"}")).body);
    try harness.expectSuccess((try send(f, &b, "PUT", path, &ana.web, "{\"name\":\"Verbes irréguliers\"}")).body);
    {
        var g = try tabletGroups(f, &b, &ana.tablet);
        defer g.deinit();
        for (g.value.summaryDOList) |c| if (std.mem.eql(u8, c.uniqueIdentifier.?, created.value.uid)) {
            try testing.expectEqualStrings("Verbes irréguliers", c.name.?);
            try testing.expect(c.lastModifiedTime > before);
        };
    }
    try expectFailure((try send(f, &b, "PUT", path, &ana.web, longest)).body, "NAME_TAKEN");
    try expectFailure((try send(f, &b, "PUT", path, &rui.web, "{\"name\":\"Mine\"}")).body, "NO_SUCH_CATEGORY");

    // Deleting it takes its digests to the bin; the tablet's manifest no longer has them.
    const add = try std.fmt.allocPrint(gpa,
        \\{{"content":"aller","md5Hash":"m1","metadata":"{{\"unique_identifier\":\"u-aller\"}}","parentUniqueIdentifier":"{s}","sourcePath":"","sourceType":4}}
    , .{created.value.uid});
    defer gpa.free(add);
    const id = try helpers.addId(f, &b.obuf, &b.reqbuf, &ana.tablet, "/api/file/add/summary", add);
    try expectFailure((try send(f, &b, "DELETE", path, &rui.web, "")).body, "NO_SUCH_CATEGORY");
    const del = try send(f, &b, "DELETE", path, &ana.web, "");
    try testing.expect(std.mem.indexOf(u8, del.body, "\"digests\":1") != null);
    try testing.expectError(error.NotInManifest, manifestRow(f, &b, &ana.tablet, id));
    {
        var g = try tabletGroups(f, &b, &ana.tablet);
        defer g.deinit();
        try testing.expectEqual(@as(usize, 1), g.value.summaryDOList.len);
    }
    try expectFailure((try send(f, &b, "DELETE", path, &ana.web, "")).body, "NO_SUCH_CATEGORY");
}

const BinListing = struct {
    enabled: bool,
    retentionDays: i64 = 0,
    digests: []const struct {
        id: u64,
        text: []const u8,
        categoryUid: []const u8,
        categoryName: ?[]const u8 = null,
        deletedAt: i64,
        back: bool,
    } = &.{},
};

fn binListing(f: *Fixture, b: *Bufs, tok: []const u8) !std.json.Parsed(BinListing) {
    const resp = try get(f, b, "/api/controlplane/digests/bin", tok);
    try testing.expectEqual(@as(u16, 200), resp.status);
    return std.json.parseFromSlice(BinListing, gpa, resp.body, .{ .ignore_unknown_fields = true, .allocate = .alloc_always });
}

test "the bin: a digest deleted in the browser leaves the manifest; restored, it is back under its id and md5, its category with it" {
    const f = try Fixture.init();
    defer f.deinit();
    f.ctx.config.digest_sync = true;
    var b: Bufs = .{};
    const ana = try person(f, &b, "ana");
    const rui = try person(f, &b, "rui");
    _ = try helpers.addId(f, &b.obuf, &b.reqbuf, &ana.tablet, "/api/file/add/summary/group",
        \\{"uniqueIdentifier":"kb-phon","name":"Phonétique","md5Hash":"g1","creationTime":1,"lastModifiedTime":1}
    );
    const id = try helpers.addId(f, &b.obuf, &b.reqbuf, &ana.tablet, "/api/file/add/summary", note_add);
    const before = try manifestRow(f, &b, &ana.tablet, id);

    var pbuf: [96]u8 = undefined;
    const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/digests/{d}", .{id});
    try expectFailure((try send(f, &b, "DELETE", path, &rui.web, "")).body, "NO_SUCH_DIGEST");
    try harness.expectSuccess((try send(f, &b, "DELETE", path, &ana.web, "")).body);
    try testing.expectError(error.NotInManifest, manifestRow(f, &b, &ana.tablet, id));
    // The tablet deletes its category too: the browser does it while the digest is in the bin.
    try harness.expectSuccess((try send(f, &b, "DELETE", "/api/controlplane/digests/categories/kb-phon", &ana.web, "")).body);
    {
        var l = try binListing(f, &b, &ana.web);
        defer l.deinit();
        try testing.expect(l.value.enabled);
        try testing.expect(l.value.retentionDays > 0);
        try testing.expectEqual(@as(usize, 1), l.value.digests.len);
        const d = l.value.digests[0];
        try testing.expectEqual(id, d.id);
        try testing.expectEqualStrings("This is a test note.", d.text);
        try testing.expectEqualStrings("Phonétique", d.categoryName.?);
        try testing.expect(!d.back);
    }
    {
        var l = try binListing(f, &b, &rui.web);
        defer l.deinit();
        try testing.expectEqual(@as(usize, 0), l.value.digests.len);
    }

    var rbuf: [96]u8 = undefined;
    const restore = try std.fmt.bufPrint(&rbuf, "/api/controlplane/digests/bin/{d}/restore", .{id});
    try expectFailure((try send(f, &b, "POST", restore, &rui.web, "")).body, "NOT_IN_BIN");
    try harness.expectSuccess((try send(f, &b, "POST", restore, &ana.web, "")).body);
    {
        var l = try listing(f, &b, &ana.web);
        defer l.deinit();
        try testing.expectEqualStrings("kb-phon", l.value.digests[0].categoryUid);
    }
    const after = try manifestRow(f, &b, &ana.tablet, id);
    try testing.expectEqualSlices(u8, &before.md5, &after.md5);
    {
        var g = try tabletGroups(f, &b, &ana.tablet);
        defer g.deinit();
        try testing.expectEqual(@as(usize, 1), g.value.summaryDOList.len);
        try testing.expectEqualStrings("kb-phon", g.value.summaryDOList[0].uniqueIdentifier.?);
    }
    try expectFailure((try send(f, &b, "POST", restore, &ana.web, "")).body, "NOT_IN_BIN");

    // The tablet edited it before syncing the delete: it sends it back as new, and the bin's copy stays there.
    try harness.expectSuccess((try send(f, &b, "DELETE", path, &ana.web, "")).body);
    const again = try helpers.addId(f, &b.obuf, &b.reqbuf, &ana.tablet, "/api/file/add/summary", note_add);
    try testing.expect(again != id);
    {
        var l = try binListing(f, &b, &ana.web);
        defer l.deinit();
        try testing.expect(l.value.digests[0].back);
    }
    const back = try send(f, &b, "POST", restore, &ana.web, "");
    try testing.expectEqual(@as(u16, 409), back.status);
    try expectFailure(back.body, "BACK_ALREADY");

    // Deleted for good: out of the bin, and no restore.
    var gbuf: [96]u8 = undefined;
    const purge = try std.fmt.bufPrint(&gbuf, "/api/controlplane/digests/bin/{d}", .{id});
    try expectFailure((try send(f, &b, "DELETE", purge, &rui.web, "")).body, "NOT_IN_BIN");
    try harness.expectSuccess((try send(f, &b, "DELETE", purge, &ana.web, "")).body);
    {
        var l = try binListing(f, &b, &ana.web);
        defer l.deinit();
        try testing.expectEqual(@as(usize, 0), l.value.digests.len);
    }
    try expectFailure((try send(f, &b, "DELETE", purge, &ana.web, "")).body, "NOT_IN_BIN");
}

test "off: the bin says so; category and bin changes are refused" {
    const f = try Fixture.init();
    defer f.deinit();
    var b: Bufs = .{};
    _ = try f.svc.bootstrapAdmin("ana", "temp0000");
    const tok = try onboardWeb(&f.ctx, "ana", "temp0000", "anapass1");
    var l = try binListing(f, &b, &tok);
    defer l.deinit();
    try testing.expect(!l.value.enabled);
    const refused = [_][3][]const u8{
        .{ "POST", "/api/controlplane/digests/categories", "{\"name\":\"x\"}" },
        .{ "PUT", "/api/controlplane/digests/categories/kb", "{\"name\":\"x\"}" },
        .{ "DELETE", "/api/controlplane/digests/categories/kb", "" },
        .{ "DELETE", "/api/controlplane/digests/1", "" },
        .{ "POST", "/api/controlplane/digests/bin/1/restore", "" },
        .{ "DELETE", "/api/controlplane/digests/bin/1", "" },
    };
    for (refused) |c| try expectFailure((try send(f, &b, c[0], c[1], &tok, c[2])).body, "DIGEST_SYNC_OFF");
}

test "Empty bin takes the digests the page listed with the files, their notes' blobs released; live digests stay; unlisted or off, it leaves them" {
    const f = try Fixture.init();
    defer f.deinit();
    f.ctx.config.digest_sync = true;
    var b: Bufs = .{};
    const ana = try person(f, &b, "ana");

    const nb = @import("note_builder");
    const bmp = [_]u8{ 0x61, 0x00, 0x62, 0x03 };
    const mark = try nb.serialize(gpa, .{
        .filetype = "mark",
        .header = &.{.{ .key = "APPLY_EQUIPMENT", .value = "N6" }},
        .pages = &.{.{ .layers = &.{.{ .slot = .main, .bitmap = &bmp }} }},
    });
    defer gpa.free(mark);
    const md5 = helpers.md5Hex(mark);
    const inner = try helpers.uploadNote(f, &b.obuf, &b.reqbuf, &ana.tablet, mark);
    const add = try helpers.noteAdd(gpa, &inner, &md5, "u-note");
    defer gpa.free(add);
    const noted = try helpers.addId(f, &b.obuf, &b.reqbuf, &ana.tablet, "/api/file/add/summary", add);
    const live = try helpers.addId(f, &b.obuf, &b.reqbuf, &ana.tablet, "/api/file/add/summary", manual_add);

    var pbuf: [64]u8 = undefined;
    try harness.expectSuccess((try send(f, &b, "DELETE", try std.fmt.bufPrint(&pbuf, "/api/controlplane/digests/{d}", .{noted}), &ana.web, "")).body);

    // Off, the bin's digests are not the files' bin's to empty; nor, on, when
    // the page could not list them: nothing goes that the person was not shown.
    f.ctx.config.digest_sync = false;
    _ = try send(f, &b, "DELETE", "/api/controlplane/bin?digests=1", &ana.web, "");
    f.ctx.config.digest_sync = true;
    _ = try send(f, &b, "DELETE", "/api/controlplane/bin", &ana.web, "");
    try testing.expect(f.files.blobs.has(&md5));
    {
        var l = try binListing(f, &b, &ana.web);
        defer l.deinit();
        try testing.expectEqual(@as(usize, 1), l.value.digests.len);
    }

    const resp = try send(f, &b, "DELETE", "/api/controlplane/bin?digests=1", &ana.web, "");
    try testing.expectEqual(@as(u16, 200), resp.status);
    try testing.expect(std.mem.indexOf(u8, resp.body, "\"digests\":1") != null);
    try testing.expect(!f.files.blobs.has(&md5));
    var l = try binListing(f, &b, &ana.web);
    defer l.deinit();
    try testing.expectEqual(@as(usize, 0), l.value.digests.len);
    var kept = try listing(f, &b, &ana.web);
    defer kept.deinit();
    try testing.expectEqual(@as(usize, 1), kept.value.digests.len);
    try testing.expectEqual(live, kept.value.digests[0].id);
}

/// `body` with its clock fields pinned, so the fixture is stable.
fn pinTimes(a: std.mem.Allocator, body: []const u8) ![]u8 {
    const parsed = try std.json.parseFromSliceLeaky(std.json.Value, a, body, .{});
    pin(parsed);
    return std.json.Stringify.valueAlloc(a, parsed, .{});
}

fn pin(v: std.json.Value) void {
    switch (v) {
        .array => |arr| for (arr.items) |x| pin(x),
        .object => |obj| {
            var it = obj.iterator();
            while (it.next()) |e| {
                const clock = for ([_][]const u8{ "createdAt", "modifiedAt", "deletedAt", "tabletSyncedAt" }) |k| {
                    if (std.mem.eql(u8, k, e.key_ptr.*)) break true;
                } else false;
                if (clock) e.value_ptr.* = .{ .integer = wire.time_ms } else pin(e.value_ptr.*);
            }
        },
        else => {},
    }
}

test "wire contract: the listing and the bin, as the web app's client reads them" {
    const f = try Fixture.init();
    defer f.deinit();
    f.ctx.config.digest_sync = true;
    var b: Bufs = .{};
    const ana = try person(f, &b, "ana");
    const folder = try f.files.ensureFolderPath(ana.id, "NOTE/MyStyle/Français");
    _ = try putSeed(f, ana.id, folder, "La_phonetique_du_francais_Prof_Flavio_Adler.pdf", "%PDF-1.4 stand-in");
    _ = try helpers.addId(f, &b.obuf, &b.reqbuf, &ana.tablet, "/api/file/add/summary/group",
        \\{"uniqueIdentifier":"kb-phon","name":"Phonétique","md5Hash":"g1","creationTime":1,"lastModifiedTime":1}
    );
    _ = try helpers.addId(f, &b.obuf, &b.reqbuf, &ana.tablet, "/api/file/add/summary", helpers.nomad_add);
    const binned = try helpers.addId(f, &b.obuf, &b.reqbuf, &ana.tablet, "/api/file/add/summary", note_add);
    const manual = try helpers.addId(f, &b.obuf, &b.reqbuf, &ana.tablet, "/api/file/add/summary", manual_add);

    var pbuf: [96]u8 = undefined;
    try harness.expectSuccess((try put(f, &b, try std.fmt.bufPrint(&pbuf, "/api/controlplane/digests/{d}", .{manual}), &ana.web, "{\"comment\":\"Edited here\"}")).body);
    try harness.expectSuccess((try send(f, &b, "DELETE", try std.fmt.bufPrint(&pbuf, "/api/controlplane/digests/{d}", .{binned}), &ana.web, "")).body);

    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const list = try get(f, &b, "/api/controlplane/digests", &ana.web);
    try testing.expectEqual(@as(u16, 200), list.status);
    try wire.expect("digests.json", try pinTimes(a, list.body));
    const bin = try get(f, &b, "/api/controlplane/digests/bin", &ana.web);
    try testing.expectEqual(@as(u16, 200), bin.status);
    try wire.expect("digest-bin.json", try pinTimes(a, bin.body));
}
