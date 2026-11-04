//! The bin's read-only views and its restore/purge routes over HTTP.

const std = @import("std");
const repeat = @import("../../util/repeat.zig").repeat;
const gpa = std.testing.allocator;
const harness = @import("harness.zig");
const onboardWeb = harness.onboardWeb;
const Fixture = harness.Fixture;
const soleHistoryMd5 = harness.soleHistoryMd5;
const currentFileMd5 = harness.currentFileMd5;
const putSeed = harness.putSeed;
const usedBytes = harness.usedBytes;
const searchHits = harness.searchHits;
const seedRecognizedNote = harness.seedRecognizedNote;
const seedRecognizedElements = harness.seedRecognizedElements;
const requestWithCookie = harness.requestWithCookie;
const expectStatusWithCookie = harness.expectStatusWithCookie;
const expectSuccess = harness.expectSuccess;
const putSeedHashed = harness.putSeedHashed;
const expectHeaderContains = harness.expectHeaderContains;
const shared = @import("bin_helpers.zig");
const getBin = shared.getBin;

test "the bin's own read path previews a trashed file that every LIVE route 404s" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const web = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    var pbuf: [256]u8 = undefined;

    const note_id = try seedRecognizedNote(f, admin, "doomed.note", &.{"Zebra"});
    const pic = try putSeedHashed(f, admin, null, "shot.png", "raw bytes");

    var page_hash: [32]u8 = undefined;
    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/file/metadata/{d}", .{note_id});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web, "");
        var p = try std.json.parseFromSlice(struct {
            pages: []const struct { hash: []const u8 },
        }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        @memcpy(&page_hash, p.value.pages[0].hash);
    }

    for ([_]u64{ note_id, pic.id }) |id| {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/entry/{d}", .{id});
        try expectStatusWithCookie(ctx, &obuf, &reqbuf, "DELETE", path, &web, "", 200);
    }

    // Live reads 404 (`Files.get` hardcodes `deleted = 0`, deliberately).
    {
        const live = [_][]const u8{
            try std.fmt.bufPrint(pbuf[0..80], "/api/controlplane/file/metadata/{d}", .{note_id}),
            try std.fmt.bufPrint(pbuf[80..160], "/note/{d}/page/0?v={s}", .{ note_id, page_hash[0..] }),
            try std.fmt.bufPrint(pbuf[160..], "/file/{d}?v={s}", .{ pic.id, pic.md5[0..] }),
        };
        for (live) |path| {
            const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web, "");
            try std.testing.expectEqual(@as(u16, 404), resp.status);
        }
    }

    // The bin-scoped twins serve them, so purging is decided while looking.
    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/bin/file/metadata/{d}", .{note_id});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "doomed.note") != null);
    }
    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/bin/note/{d}/page/0?v={s}", .{ note_id, page_hash[0..] });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        // Real bytes: trash holds the blob reference.
        try std.testing.expectEqualStrings("SNPG", resp.body[0..4]);
    }
    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/bin/file/{d}?v={s}", .{ pic.id, pic.md5[0..] });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualStrings("raw bytes", resp.body);
    }

    // A live id 404s through the bin routes: no second general read path.
    {
        const kept = try putSeedHashed(f, admin, null, "kept.png", "kept bytes");
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/bin/file/{d}?v={s}", .{ kept.id, kept.md5[0..] });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web, "");
        try std.testing.expectEqual(@as(u16, 404), resp.status);
    }
    try std.testing.expectEqual(@as(usize, 0), try searchHits(f, admin, "Zebra"));
}

test "bin parity phase 1: page-text ovals serve a TRASHED note's current version; live routes 404" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const web = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    var pbuf: [128]u8 = undefined;

    // Two versions with words and boxes, then trash: blob, `note_index` and
    // `file_history` are all retained.
    const nb = @import("note_builder");
    const v1_els = [_]nb.ElementSpec{.{ .label = "alpha", .words = &.{
        .{ .label = "alpha", .box = .{ .x = 10, .y = 20, .width = 30, .height = 8 } },
    } }};
    const v2_els = [_]nb.ElementSpec{.{ .label = "beta", .words = &.{
        .{ .label = "beta", .box = .{ .x = 40, .y = 100, .width = 20, .height = 9 } },
    } }};
    const id = try seedRecognizedElements(f, admin, "trash.note", "N6", &v1_els, false);
    _ = try seedRecognizedElements(f, admin, "trash.note", "N6", &v2_els, false);
    try f.files.trash(admin, id);

    const PageTextBody = struct {
        text: ?[]const u8 = null,
        words: ?[]const struct { text: []const u8 } = null,
    };

    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/bin/note/{d}/page/0/text", .{id});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try expectHeaderContains(resp.head, "cache-control: no-cache");
        try std.testing.expect(std.mem.indexOf(u8, resp.head, "immutable") == null);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "success") == null); // raw VO
        var p = try std.json.parseFromSlice(PageTextBody, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqualStrings("beta", p.value.text.?); // the CURRENT version's text
        try std.testing.expectEqual(@as(usize, 1), p.value.words.?.len);
        try std.testing.expectEqualStrings("beta", p.value.words.?[0].text);
    }

    {
        const path = try std.fmt.bufPrint(&pbuf, "/note/{d}/page/0/text?v={s}", .{ id, repeat(u8, "f", 32) });
        try std.testing.expectEqual(@as(u16, 404), (try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web, "")).status);
    }

    {
        const live_id = try seedRecognizedNote(f, admin, "live.note", &.{"gamma"});
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/bin/note/{d}/page/0/text", .{live_id});
        try std.testing.expectEqual(@as(u16, 404), (try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web, "")).status);
    }
}

test "bin parity phase 2: view-only version history for a TRASHED note serves each retained version; live-history scope unchanged" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const web = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    var pbuf: [200]u8 = undefined;

    // A `.note` and a `.spd`, two versions each, both trashed: `file_history`
    // follows a file to the bin.
    const nb = @import("note_builder");
    const v1_els = [_]nb.ElementSpec{.{ .label = "alpha", .words = &.{
        .{ .label = "alpha", .box = .{ .x = 10, .y = 20, .width = 30, .height = 8 } },
    } }};
    const v2_els = [_]nb.ElementSpec{.{ .label = "beta", .words = &.{
        .{ .label = "beta", .box = .{ .x = 40, .y = 100, .width = 20, .height = 9 } },
    } }};
    const id = try seedRecognizedElements(f, admin, "vh.note", "N6", &v1_els, false);
    _ = try seedRecognizedElements(f, admin, "vh.note", "N6", &v2_els, false);
    const v1md5 = try soleHistoryMd5(f, id);
    const v2md5 = try currentFileMd5(f, id);

    const spd_v1 = "spd-version-one-bytes";
    const spd_v2 = "spd-version-two-bytes-longer";
    const spd_id = try putSeed(f, admin, null, "vh.spd", spd_v1);
    _ = try putSeed(f, admin, null, "vh.spd", spd_v2);
    const spd_v1md5 = try soleHistoryMd5(f, spd_id);

    try f.files.trash(admin, id);
    try f.files.trash(admin, spd_id);

    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/bin/note/{d}/history", .{id});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expect(std.mem.indexOf(u8, resp.head, "immutable") == null);
        var p = try std.json.parseFromSlice(struct {
            versions: []const struct { md5: []const u8, pageCount: i64 = 0, current: bool = false },
        }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqual(@as(usize, 2), p.value.versions.len);
        try std.testing.expect(p.value.versions[0].current); // current leads
        try std.testing.expectEqualStrings(&v2md5, p.value.versions[0].md5);
        try std.testing.expect(!p.value.versions[1].current);
        try std.testing.expectEqualStrings(&v1md5, p.value.versions[1].md5);
        try std.testing.expectEqual(@as(i64, 1), p.value.versions[1].pageCount);
    }

    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/bin/note/{d}/history/{s}/page/0", .{ id, v1md5 });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualStrings("SNPG", resp.body[0..4]);
        try expectHeaderContains(resp.head, "cache-control: public, max-age=31536000, immutable");
    }

    const PageTextBody = struct { text: ?[]const u8 = null, words: ?[]const struct { text: []const u8 } = null };
    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/bin/note/{d}/history/{s}/page/0/text", .{ id, v1md5 });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try expectHeaderContains(resp.head, "cache-control: no-cache");
        try std.testing.expect(std.mem.indexOf(u8, resp.head, "immutable") == null);
        var p = try std.json.parseFromSlice(PageTextBody, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqualStrings("alpha", p.value.text.?); // the RETAINED text
    }
    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/bin/note/{d}/page/0/text", .{id});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(PageTextBody, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqualStrings("beta", p.value.text.?); // the CURRENT text — distinct
    }

    // An md5 not in this file's history is a 404 (`historyVersionIn(.trashed)`).
    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/bin/note/{d}/history/{s}/page/0/text", .{ id, repeat(u8, "f", 32) });
        try std.testing.expectEqual(@as(u16, 404), (try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web, "")).status);
    }

    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/bin/note/{d}/history/{s}/raw", .{ spd_id, spd_v1md5 });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualStrings(spd_v1, resp.body); // v1's EXACT bytes
        try expectHeaderContains(resp.head, "cache-control: public, max-age=31536000, immutable");
    }

    // The bin history is view-only: no restore twin.
    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/bin/note/{d}/history/{s}/restore", .{ id, v1md5 });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "POST", path, &web, "");
        try std.testing.expectEqual(@as(u16, 404), resp.status); // no such route
    }

    // A trashed id on live history routes 404s, and a live id on bin history
    // routes 404s.
    {
        const live = [_][]const u8{
            try std.fmt.bufPrint(pbuf[0..90], "/api/controlplane/note/{d}/history", .{id}),
            try std.fmt.bufPrint(pbuf[90..], "/api/controlplane/note/{d}/history/{s}/page/0/text", .{ id, v1md5 }),
        };
        for (live) |path|
            try std.testing.expectEqual(@as(u16, 404), (try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web, "")).status);
    }
    {
        const live_id = try seedRecognizedElements(f, admin, "kept.note", "N6", &v1_els, false);
        _ = try seedRecognizedElements(f, admin, "kept.note", "N6", &v2_els, false);
        const live_v1 = try soleHistoryMd5(f, live_id);

        var b1: [100]u8 = undefined;
        const live_hist = try std.fmt.bufPrint(&b1, "/api/controlplane/note/{d}/history", .{live_id});
        try std.testing.expectEqual(@as(u16, 200), (try requestWithCookie(ctx, &obuf, &reqbuf, "GET", live_hist, &web, "")).status);

        const bin = [_][]const u8{
            try std.fmt.bufPrint(pbuf[0..90], "/api/controlplane/bin/note/{d}/history", .{live_id}),
            try std.fmt.bufPrint(pbuf[90..], "/api/controlplane/bin/note/{d}/history/{s}/page/0", .{ live_id, live_v1 }),
        };
        for (bin) |path|
            try std.testing.expectEqual(@as(u16, 404), (try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web, "")).status);
    }
}

test "bin routes: restore reports the rename and the fanout, purge is the only thing that decrefs and refunds" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const web = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    var pbuf: [128]u8 = undefined;

    const dir = try f.files.createFolder(admin, null, "Dir");
    defer gpa.free(dir.name);
    const sub = try f.files.createFolder(admin, dir.id, "Sub");
    defer gpa.free(sub.name);
    const a = try putSeedHashed(f, admin, sub.id, "a.note", "aaaa");
    const charged = try usedBytes(f, admin);
    try std.testing.expect(charged > 0);

    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/entry/{d}", .{dir.id});
        try expectStatusWithCookie(ctx, &obuf, &reqbuf, "DELETE", path, &web, "", 200);
    }
    // Trash refunds and releases nothing.
    try std.testing.expectEqual(charged, try usedBytes(f, admin));
    try std.testing.expect(f.files.blobs.has(&a.md5));

    // The device recreates the folder, so the restore lands on an occupied name.
    const squatter = try f.files.createFolder(admin, null, "Dir");
    defer gpa.free(squatter.name);

    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/bin/{d}/restore", .{sub.id});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "POST", path, &web, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(struct {
            success: bool,
            name: []const u8,
            renamed: bool,
            ancestors: i64,
            descendants: i64,
        }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expect(p.value.success);
        // `Sub` didn't collide; its ancestor did and was renamed.
        try std.testing.expectEqualStrings("Sub", p.value.name);
        try std.testing.expectEqual(@as(i64, 1), p.value.ancestors);
        try std.testing.expectEqual(@as(i64, 1), p.value.descendants);
    }
    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/controlplane/tree", &web, "");
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "Dir (2)") != null);
    }

    // Purge is the only route that reaches `decref`.
    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/entry/{d}", .{a.id});
        try expectStatusWithCookie(ctx, &obuf, &reqbuf, "DELETE", path, &web, "", 200);
    }
    try std.testing.expectEqual(charged, try usedBytes(f, admin)); // still charged
    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/bin/{d}", .{a.id});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "DELETE", path, &web, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try expectSuccess(resp.body);
    }
    try std.testing.expectEqual(@as(i64, 0), try usedBytes(f, admin)); // refunded HERE
    try std.testing.expect(!f.files.blobs.has(&a.md5)); // and GC'd HERE

    const live = try putSeedHashed(f, admin, null, "live.note", "live");
    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/bin/{d}", .{live.id});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "DELETE", path, &web, "");
        try std.testing.expectEqual(@as(u16, 404), resp.status);
        try std.testing.expect(f.files.blobs.has(&live.md5));
    }

    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/entry/{d}", .{live.id});
        try expectStatusWithCookie(ctx, &obuf, &reqbuf, "DELETE", path, &web, "", 200);
    }
    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "DELETE", "/api/controlplane/bin", &web, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(struct { success: bool, entries: i64 }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqual(@as(i64, 1), p.value.entries);
    }
    var parsed = try getBin(ctx, &obuf, &reqbuf, &web);
    defer parsed.deinit();
    try std.testing.expectEqual(@as(usize, 0), parsed.value.entries.len);
    try std.testing.expectEqual(@as(i64, 0), parsed.value.totalBytes);
}

test "bin routes: a foreign id is indistinguishable from a missing one, over a DEDUPLICATED blob" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const alice_new = try f.svc.createUser(admin, "alice", false);
    const alice = alice_new.id;
    const admin_web = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");
    const alice_web = try onboardWeb(ctx, "alice", alice_new.temp_password.slice(), "apass111");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    var pbuf: [160]u8 = undefined;

    // Both hold the same bytes: one blob at refcount 2 and one shared
    // `note_index` row; only the `files` row records ownership.
    const mine = try putSeedHashed(f, alice, null, "secret.note", "identical bytes");
    const theirs = try putSeedHashed(f, admin, null, "mine.note", "identical bytes");
    try std.testing.expectEqualStrings(&mine.md5, &theirs.md5);

    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/entry/{d}", .{mine.id});
        try expectStatusWithCookie(ctx, &obuf, &reqbuf, "DELETE", path, &alice_web, "", 200);
    }

    // Alice's id and a missing id must answer identically.
    for ([_]u64{ mine.id, 99999 }) |id| {
        {
            const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/bin/{d}/restore", .{id});
            try expectStatusWithCookie(ctx, &obuf, &reqbuf, "POST", path, &admin_web, "", 404);
        }
        {
            const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/bin/{d}", .{id});
            try expectStatusWithCookie(ctx, &obuf, &reqbuf, "DELETE", path, &admin_web, "", 404);
        }
        {
            const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/entry/{d}", .{id});
            try expectStatusWithCookie(ctx, &obuf, &reqbuf, "DELETE", path, &admin_web, "", 404);
        }
        {
            const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/bin/file/metadata/{d}", .{id});
            try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", path, &admin_web, "", 404);
        }
        {
            // Even with the right `?v=` (same md5), the row is not admin's.
            const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/bin/file/{d}?v={s}", .{ id, theirs.md5[0..] });
            try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", path, &admin_web, "", 404);
        }
    }

    var parsed = try getBin(ctx, &obuf, &reqbuf, &alice_web);
    defer parsed.deinit();
    try std.testing.expectEqual(@as(usize, 1), parsed.value.entries.len);
    try std.testing.expectEqualStrings("secret.note", parsed.value.entries[0].name);
    var admin_bin = try getBin(ctx, &obuf, &reqbuf, &admin_web);
    defer admin_bin.deinit();
    try std.testing.expectEqual(@as(usize, 0), admin_bin.value.entries.len);
    try std.testing.expect(f.files.blobs.has(&theirs.md5));
    const still_theirs = (try f.files.get(admin, theirs.id)).?;
    defer gpa.free(still_theirs.name);
    defer if (still_theirs.md5) |m| gpa.free(m);
}
