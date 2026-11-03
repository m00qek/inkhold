//! The recycle bin over HTTP.

const std = @import("std");
const repeat = @import("../../repeat.zig").repeat;
const context = @import("../../http/context.zig");
const Context = context.Context;
const gpa = std.testing.allocator;
const harness = @import("harness.zig");
const Response = harness.Response;
const onboardWeb = harness.onboardWeb;
const Fixture = harness.Fixture;
const soleHistoryMd5 = harness.soleHistoryMd5;
const currentFileMd5 = harness.currentFileMd5;
const putSeed = harness.putSeed;
const usedBytes = harness.usedBytes;
const countTrashed = harness.countTrashed;
const searchHits = harness.searchHits;
const seedRecognizedNote = harness.seedRecognizedNote;
const seedRecognizedElements = harness.seedRecognizedElements;
const requestWithCookie = harness.requestWithCookie;
const expectStatusWithCookie = harness.expectStatusWithCookie;
const expectSuccess = harness.expectSuccess;
const putSeedHashed = harness.putSeedHashed;
const expectHeaderContains = harness.expectHeaderContains;

test "web DELETE of a folder walks the subtree itself, and the bin lists every row with the path it had" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const web = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    var pbuf: [128]u8 = undefined;

    const dir = try f.files.createFolder(admin, null, "NOTE");
    defer gpa.free(dir.name);
    const sub = try f.files.createFolder(admin, dir.id, "Work");
    defer gpa.free(sub.name);
    const deep = try putSeed(f, admin, sub.id, "deep.note", "deep body");
    const loose = try putSeed(f, admin, null, "loose.note", "loose");

    // The device walks the subtree itself; the browser sends one request, so
    // the server walks.
    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/entry/{d}", .{dir.id});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "DELETE", path, &web, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(struct {
            success: bool,
            name: []const u8,
            isFolder: bool,
            entries: i64,
        }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expect(p.value.success);
        try std.testing.expectEqualStrings("NOTE", p.value.name);
        try std.testing.expect(p.value.isFolder);
        try std.testing.expectEqual(@as(i64, 3), p.value.entries);
    }
    try std.testing.expectEqual(@as(i64, 3), try countTrashed(f, admin));

    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/entry/{d}", .{loose});
        try expectStatusWithCookie(ctx, &obuf, &reqbuf, "DELETE", path, &web, "", 200);
    }

    var parsed = try getBin(ctx, &obuf, &reqbuf, &web);
    defer parsed.deinit();
    const bin = parsed.value;
    try std.testing.expectEqual(@as(usize, 4), bin.entries.len);
    try std.testing.expectEqual(@as(i64, 30), bin.retentionDays);
    // Folder rows contribute no bytes, so "frees N bytes" does not double-count.
    try std.testing.expectEqual(@as(i64, 14), bin.totalBytes);

    var deep_id_buf: [24]u8 = undefined;
    const deep_id = try std.fmt.bufPrint(&deep_id_buf, "{d}", .{deep});
    var seen_deep = false;
    for (bin.entries) |e| {
        try std.testing.expect(e.deletedAt > 0);
        if (std.mem.eql(u8, e.id, deep_id)) {
            seen_deep = true;
            // Both ancestors are trashed; a live-only parent walk would say `/deep.note`.
            try std.testing.expectEqualStrings("/NOTE/Work/deep.note", e.path);
            try std.testing.expectEqualStrings("note", e.kind);
            try std.testing.expectEqualStrings("note", e.fileType.?); // not a real .note container
            try std.testing.expect(e.fileHash != null); // the preview URL's `?v=`
            try std.testing.expect(e.thumbAspect == null); // unparseable: no shape to freeze
            try std.testing.expect(!e.isRoot); // it came down with `NOTE`
        }
        if (std.mem.eql(u8, e.name, "loose.note")) {
            try std.testing.expectEqualStrings("/loose.note", e.path);
            try std.testing.expect(e.isRoot);
        }
        if (std.mem.eql(u8, e.name, "NOTE")) {
            try std.testing.expect(e.isRoot);
            try std.testing.expectEqual(@as(i64, 0), e.size);
        }
    }
    try std.testing.expect(seen_deep);

    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/controlplane/tree", &web, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "loose.note") == null);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "\"NOTE\"") == null);
    }
}

const RenamedBody = struct { kind: []const u8, name: []const u8 };

fn renameEntry(ctx: *Context, obuf: []u8, reqbuf: []u8, tok: []const u8, id: u64, new_name: []const u8) !Response {
    var pbuf: [96]u8 = undefined;
    var bbuf: [256]u8 = undefined;
    const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/entry/{d}/rename", .{id});
    const body = try std.fmt.bufPrint(&bbuf, "{{\"name\":\"{s}\"}}", .{new_name});
    return requestWithCookie(ctx, obuf, reqbuf, "POST", path, tok, body);
}

fn liveName(f: *Fixture, user_id: u64, id: u64) ![]u8 {
    const e = (try f.files.get(user_id, id)).?;
    if (e.md5) |m| gpa.free(m);
    return @constCast(e.name);
}

test "web rename: renames a file and a folder in place, returns the updated entry, and bumps syncVersion" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const web = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;

    const dir = try f.files.createFolder(admin, null, "Poems");
    defer gpa.free(dir.name);
    const note = try putSeed(f, admin, dir.id, "Ozymandias.note", "I met a traveller");

    const v0 = try f.files.syncVersion(admin);
    {
        const resp = try renameEntry(ctx, &obuf, &reqbuf, &web, note, "Sonnet.note");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(RenamedBody, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqualStrings("note", p.value.kind);
        try std.testing.expectEqualStrings("Sonnet.note", p.value.name);
    }
    try std.testing.expect(try f.files.syncVersion(admin) > v0);
    {
        const nm = try liveName(f, admin, note);
        defer gpa.free(nm);
        try std.testing.expectEqualStrings("Sonnet.note", nm);
    }

    {
        var pbuf: [64]u8 = undefined;
        var idbuf: [24]u8 = undefined;
        const id_str = try std.fmt.bufPrint(&idbuf, "{d}", .{dir.id});
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/tree?parent={s}", .{id_str});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "Sonnet.note") != null);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "Ozymandias.note") == null);
    }

    {
        const resp = try renameEntry(ctx, &obuf, &reqbuf, &web, dir.id, "Verse");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(RenamedBody, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqualStrings("folder", p.value.kind);
        try std.testing.expectEqualStrings("Verse", p.value.name);
    }
    {
        const nm = try liveName(f, admin, dir.id);
        defer gpa.free(nm);
        try std.testing.expectEqualStrings("Verse", nm);
    }
}

test "web rename: a sibling name-clash is a 409 and changes nothing" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const web = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;

    _ = try putSeed(f, admin, null, "taken.note", "occupant");
    const mover = try putSeed(f, admin, null, "mover.note", "the one being renamed");

    const v0 = try f.files.syncVersion(admin);
    const resp = try renameEntry(ctx, &obuf, &reqbuf, &web, mover, "taken.note");
    try std.testing.expectEqual(@as(u16, 409), resp.status);

    {
        const nm = try liveName(f, admin, mover);
        defer gpa.free(nm);
        try std.testing.expectEqualStrings("mover.note", nm);
    }
    try std.testing.expectEqual(v0, try f.files.syncVersion(admin));
}

test "web rename: refuses the fixed category roots and anchor subfolders (403), but renames user folders that merely share a name" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const web = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;

    // Device tree: roots NOTE / DOCUMENT, anchors NOTE/Note, NOTE/MyStyle,
    // DOCUMENT/Document.
    const root_note = try f.files.createFolder(admin, null, "NOTE");
    defer gpa.free(root_note.name);
    const root_doc = try f.files.createFolder(admin, null, "DOCUMENT");
    defer gpa.free(root_doc.name);
    const anchor_note = try f.files.createFolder(admin, root_note.id, "Note");
    defer gpa.free(anchor_note.name);
    const anchor_mystyle = try f.files.createFolder(admin, root_note.id, "MyStyle");
    defer gpa.free(anchor_mystyle.name);
    const anchor_document = try f.files.createFolder(admin, root_doc.id, "Document");
    defer gpa.free(anchor_document.name);

    const Guarded = struct { id: u64, name: []const u8 };
    const guarded = [_]Guarded{
        .{ .id = root_note.id, .name = "NOTE" },
        .{ .id = root_doc.id, .name = "DOCUMENT" },
        .{ .id = anchor_note.id, .name = "Note" },
        .{ .id = anchor_mystyle.id, .name = "MyStyle" },
        .{ .id = anchor_document.id, .name = "Document" },
    };
    for (guarded) |g| {
        const resp = try renameEntry(ctx, &obuf, &reqbuf, &web, g.id, "Renamed");
        try std.testing.expectEqual(@as(u16, 403), resp.status);
        const nm = try liveName(f, admin, g.id);
        defer gpa.free(nm);
        try std.testing.expectEqualStrings(g.name, nm); // untouched
    }

    // The guard keys on shape, not name: a root-level "Note"...
    const loose_note = try f.files.createFolder(admin, null, "Note");
    defer gpa.free(loose_note.name);
    {
        const resp = try renameEntry(ctx, &obuf, &reqbuf, &web, loose_note.id, "Journal");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
    }
    // ...a "Note" under the anchor "Note"...
    const deep_note = try f.files.createFolder(admin, anchor_note.id, "Note");
    defer gpa.free(deep_note.name);
    {
        const resp = try renameEntry(ctx, &obuf, &reqbuf, &web, deep_note.id, "Sub");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
    }
    // ...and a "Note" under a non-root "NOTE" all rename fine.
    const user_container = try f.files.createFolder(admin, loose_note.id, "NOTE");
    defer gpa.free(user_container.name);
    const note_under_nonroot = try f.files.createFolder(admin, user_container.id, "Note");
    defer gpa.free(note_under_nonroot.name);
    {
        const resp = try renameEntry(ctx, &obuf, &reqbuf, &web, note_under_nonroot.id, "Free");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
    }
}

test "web rename: a foreign or missing id is one indistinguishable 404" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const bob = (try f.svc.createUser(admin, "bob", false)).id;
    const web = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;

    const bob_id = try putSeed(f, bob, null, "bob.note", "bob bytes");

    // Foreign and missing ids both 404.
    const foreign = try renameEntry(ctx, &obuf, &reqbuf, &web, bob_id, "stolen.note");
    try std.testing.expectEqual(@as(u16, 404), foreign.status);
    const missing = try renameEntry(ctx, &obuf, &reqbuf, &web, 999999, "ghost.note");
    try std.testing.expectEqual(@as(u16, 404), missing.status);

    const nm = try liveName(f, bob, bob_id);
    defer gpa.free(nm);
    try std.testing.expectEqualStrings("bob.note", nm);
}

test "web rename: rejects an empty name and a name containing a path separator (400)" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const web = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;

    const note = try putSeed(f, admin, null, "keep.note", "unchanged");

    const empty = try renameEntry(ctx, &obuf, &reqbuf, &web, note, "   ");
    try std.testing.expectEqual(@as(u16, 400), empty.status);
    const slashed = try renameEntry(ctx, &obuf, &reqbuf, &web, note, "a/b.note");
    try std.testing.expectEqual(@as(u16, 400), slashed.status);

    const nm = try liveName(f, admin, note);
    defer gpa.free(nm);
    try std.testing.expectEqualStrings("keep.note", nm);
}

const shared = @import("bin_helpers.zig");
const getBin = shared.getBin;
