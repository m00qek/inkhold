//! Web upload's onConflict=replace mode.

const std = @import("std");
const blobstore = @import("../../store/blobs.zig");
const gpa = std.testing.allocator;
const harness = @import("harness.zig");
const onboardWeb = harness.onboardWeb;
const Fixture = harness.Fixture;
const soleHistoryMd5 = harness.soleHistoryMd5;
const currentFileMd5 = harness.currentFileMd5;
const countRows = harness.countRows;
const putSeed = harness.putSeed;
const usedBytes = harness.usedBytes;
const requestWithCookie = harness.requestWithCookie;
const shared = @import("upload_helpers.zig");
const uploadFile = shared.uploadFile;
const uploadFileQuery = shared.uploadFileQuery;
const UploadedBody = shared.UploadedBody;

const UploadHistVersion = struct { md5: []const u8, size: i64, current: bool = false };

test "web upload onConflict=replace: supersedes the same-named file, keeps the row id, and the old bytes stay a restorable version" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const web = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [8192]u8 = undefined;
    var pbuf: [128]u8 = undefined;

    const v1 = "the first draft of the paper";
    const v2 = "the SECOND draft, materially different";
    const v1md5 = blobstore.md5HexOf(v1);
    const v2md5 = blobstore.md5HexOf(v2);

    const id = try putSeed(f, admin, null, "paper.pdf", v1);

    {
        const resp = try uploadFileQuery(ctx, &obuf, &reqbuf, &web, "root", "paper.pdf", v2, "?onConflict=replace");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(UploadedBody, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqualStrings("paper.pdf", p.value.name); // no " (2)"
        try std.testing.expectEqual(id, try std.fmt.parseInt(u64, p.value.id, 10)); // the SAME row
        try std.testing.expectEqualStrings(&v2md5, p.value.fileHash.?);
    }
    try std.testing.expectEqualSlices(u8, &v2md5, &(try currentFileMd5(f, id)));

    try std.testing.expectEqual(
        @as(i64, 1),
        try countRows(f, "SELECT COUNT(*) FROM files WHERE name = 'paper.pdf' AND deleted = 0;"),
    );

    // The superseded bytes are retained, which is why `replace` is offered.
    try std.testing.expectEqualSlices(u8, &v1md5, &(try soleHistoryMd5(f, id)));
    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/note/{d}/history", .{id});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(
            struct { id: []const u8, versions: []UploadHistVersion },
            gpa,
            resp.body,
            .{ .ignore_unknown_fields = true },
        );
        defer p.deinit();
        try std.testing.expectEqual(@as(usize, 2), p.value.versions.len);
        try std.testing.expect(p.value.versions[0].current);
        try std.testing.expectEqualStrings(&v2md5, p.value.versions[0].md5);
        try std.testing.expect(!p.value.versions[1].current);
        try std.testing.expectEqualStrings(&v1md5, p.value.versions[1].md5);
    }
    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/note/{d}/history/{s}/restore", .{ id, v1md5 });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "POST", path, &web, "{}");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
    }
    try std.testing.expectEqualSlices(u8, &v1md5, &(try currentFileMd5(f, id)));
}

test "web upload onConflict=replace: with nothing of that name it is just a create" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const web = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [8192]u8 = undefined;

    const bytes = "nothing to supersede";
    const resp = try uploadFileQuery(ctx, &obuf, &reqbuf, &web, "root", "fresh.pdf", bytes, "?onConflict=replace");
    try std.testing.expectEqual(@as(u16, 200), resp.status);
    var p = try std.json.parseFromSlice(UploadedBody, gpa, resp.body, .{ .ignore_unknown_fields = true });
    defer p.deinit();
    try std.testing.expectEqualStrings("fresh.pdf", p.value.name);

    const id = try std.fmt.parseInt(u64, p.value.id, 10);
    try std.testing.expectEqualSlices(u8, &blobstore.md5HexOf(bytes), &(try currentFileMd5(f, id)));
    try std.testing.expectEqual(@as(i64, @intCast(bytes.len)), try usedBytes(f, admin));
    try std.testing.expectEqual(@as(i64, 0), try countRows(f, "SELECT COUNT(*) FROM file_history;"));
}

test "web upload: the DEFAULT and an unrecognised onConflict both auto-rename — an old or confused client can never overwrite" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const web = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [8192]u8 = undefined;

    const occupant = "the file already there";
    const id = try putSeed(f, admin, null, "notes.pdf", occupant);

    const queries = [_][]const u8{
        "",
        "?onConflict=",
        "?onConflict=Rename",
        "?onConflict=overwrite",
        "?onConflict=replace%20", // not a literal match, so not a replace
        "?other=replace",
    };
    var expected_suffix: usize = 2;
    for (queries) |q| {
        const resp = try uploadFileQuery(ctx, &obuf, &reqbuf, &web, "root", "notes.pdf", "a different document", q);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(UploadedBody, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        var want: [32]u8 = undefined;
        try std.testing.expectEqualStrings(
            try std.fmt.bufPrint(&want, "notes ({d}).pdf", .{expected_suffix}),
            p.value.name,
        );
        expected_suffix += 1;
    }

    {
        const kept = (try f.files.get(admin, id)).?;
        defer kept.deinit(gpa);
        try std.testing.expectEqualStrings("notes.pdf", kept.name);
        try std.testing.expectEqualStrings(&blobstore.md5HexOf(occupant), kept.md5.?);
    }
    try std.testing.expectEqual(@as(i64, 0), try countRows(f, "SELECT COUNT(*) FROM file_history;"));
}

test "web upload onConflict=replace: a FOLDER holding the name is still 409, and the folder survives" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const web = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [8192]u8 = undefined;

    // A file may never supersede a folder, under either mode.
    const dir = try f.files.createFolder(admin, null, "archive.pdf");
    defer gpa.free(dir.name);

    const bytes = "trying to become a folder";
    const resp = try uploadFileQuery(ctx, &obuf, &reqbuf, &web, "root", "archive.pdf", bytes, "?onConflict=replace");
    try std.testing.expectEqual(@as(u16, 409), resp.status);
    try std.testing.expect(std.mem.indexOf(u8, resp.body, "NAME_TAKEN") != null);

    {
        const kept = (try f.files.get(admin, dir.id)).?;
        defer kept.deinit(gpa);
        try std.testing.expect(kept.is_folder);
        try std.testing.expectEqualStrings("archive.pdf", kept.name);
    }
    try std.testing.expectEqual(@as(i64, 0), try usedBytes(f, admin));
    try std.testing.expect(!f.files.blobs.has(&blobstore.md5HexOf(bytes)));

    {
        const ok = try uploadFile(ctx, &obuf, &reqbuf, &web, "root", "archive.pdf", bytes);
        try std.testing.expectEqual(@as(u16, 200), ok.status);
        var p = try std.json.parseFromSlice(UploadedBody, gpa, ok.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqualStrings("archive (2).pdf", p.value.name);
    }
}

test "web upload onConflict=replace: quota releases the old charge only when nothing live still holds the blob" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const web = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [8192]u8 = undefined;

    // Different lengths so the arithmetic can't balance by coincidence.
    const old_bytes = "old bytes";
    const new_bytes = "the replacement bytes, rather longer than the old";
    const old_len: i64 = @intCast(old_bytes.len);
    const new_len: i64 = @intCast(new_bytes.len);

    const solo = try putSeed(f, admin, null, "solo.pdf", old_bytes);
    try std.testing.expectEqual(old_len, try usedBytes(f, admin));
    {
        const resp = try uploadFileQuery(ctx, &obuf, &reqbuf, &web, "root", "solo.pdf", new_bytes, "?onConflict=replace");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
    }
    // The old charge stays: the retained version keeps the bytes on disk.
    try std.testing.expectEqual(old_len + new_len, try usedBytes(f, admin));
    try std.testing.expect(f.files.blobs.has(&blobstore.md5HexOf(old_bytes)));
    try std.testing.expectEqualSlices(u8, &blobstore.md5HexOf(old_bytes), &(try soleHistoryMd5(f, solo)));

    // Two rows on one blob cost one charge; replacing one releases nothing.
    const shared_a = try putSeed(f, admin, null, "shared-a.pdf", old_bytes);
    _ = try putSeed(f, admin, null, "shared-b.pdf", old_bytes);
    _ = shared_a;
    const before = try usedBytes(f, admin);
    // Dedup against your own history is still dedup.
    try std.testing.expectEqual(new_len + old_len, before);
    {
        const resp = try uploadFileQuery(ctx, &obuf, &reqbuf, &web, "root", "shared-a.pdf", "third distinct payload", "?onConflict=replace");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
    }
    try std.testing.expectEqual(before + @as(i64, "third distinct payload".len), try usedBytes(f, admin));
}

test "web upload onConflict=replace: re-uploading identical bytes is a no-op, not a spurious version" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const web = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [8192]u8 = undefined;

    const bytes = "unchanged content";
    const id = try putSeed(f, admin, null, "same.pdf", bytes);
    const charged = try usedBytes(f, admin);

    const resp = try uploadFileQuery(ctx, &obuf, &reqbuf, &web, "root", "same.pdf", bytes, "?onConflict=replace");
    try std.testing.expectEqual(@as(u16, 200), resp.status);
    var p = try std.json.parseFromSlice(UploadedBody, gpa, resp.body, .{ .ignore_unknown_fields = true });
    defer p.deinit();
    try std.testing.expectEqual(id, try std.fmt.parseInt(u64, p.value.id, 10));

    try std.testing.expectEqual(@as(i64, 0), try countRows(f, "SELECT COUNT(*) FROM file_history;"));
    try std.testing.expectEqual(charged, try usedBytes(f, admin));
    try std.testing.expectEqual(
        @as(i64, 1),
        try countRows(f, "SELECT COUNT(*) FROM files WHERE name = 'same.pdf' AND deleted = 0;"),
    );
}
