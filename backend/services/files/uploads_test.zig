//! Tests for device upload sessions.

const std = @import("std");
const testing = std.testing;
const fx = @import("fixture.zig");
const Fixture = fx.Fixture;
const putBytes = fx.putBytes;
const freeEntry = fx.freeEntry;

test "upload session sweep drops stale sessions and reclaims only untracked blobs" {
    var f = try Fixture.init();
    defer f.deinit();
    const alloc = testing.allocator;

    var ra = std.Io.Reader.fixed("orphaned upload");
    const oa = try f.files.blobs.put(&ra, null);
    try f.files.createUploadSession(1, "aaaaaaaaaaaaaaaa", "/NOTE", "a.note", oa.size);
    try f.files.setUploadBlob(1, "aaaaaaaaaaaaaaaa", &oa.md5);

    const shared = try putBytes(&f, 1, null, "kept.note", "shared bytes");
    defer freeEntry(shared);
    try f.files.createUploadSession(1, "bbbbbbbbbbbbbbbb", "/NOTE", "b.note", shared.size);
    try f.files.setUploadBlob(1, "bbbbbbbbbbbbbbbb", shared.md5.?);

    try testing.expect(f.files.blobs.has(&oa.md5));
    try testing.expect(f.files.blobs.has(shared.md5.?));

    const swept = try f.files.sweepUploadSessions(-1);
    try testing.expectEqual(@as(usize, 2), swept);

    try testing.expect((try f.files.uploadSession(alloc, 1, "aaaaaaaaaaaaaaaa")) == null);
    try testing.expect((try f.files.uploadSession(alloc, 1, "bbbbbbbbbbbbbbbb")) == null);
    try testing.expect(!f.files.blobs.has(&oa.md5));
    try testing.expect(f.files.blobs.has(shared.md5.?));

    try f.files.createUploadSession(1, "cccccccccccccccc", "/NOTE", "c.note", 10);
    try testing.expectEqual(@as(usize, 0), try f.files.sweepUploadSessions(3600));
    const young = (try f.files.uploadSession(alloc, 1, "cccccccccccccccc")).?;
    alloc.free(young.path);
    alloc.free(young.file_name);
    if (young.blob_md5) |m| alloc.free(m);
}

test "addUploadReceived accumulates per session, credits a replaced part, and clamps at zero" {
    var f = try Fixture.init();
    defer f.deinit();
    const alloc = testing.allocator;

    try f.files.createUploadSession(1, "aaaaaaaaaaaaaaaa", "/NOTE", "a.note", 1000);
    try f.files.createUploadSession(2, "bbbbbbbbbbbbbbbb", "/NOTE", "b.note", 1000);

    {
        const s = (try f.files.uploadSession(alloc, 1, "aaaaaaaaaaaaaaaa")).?;
        defer {
            alloc.free(s.path);
            alloc.free(s.file_name);
            if (s.blob_md5) |m| alloc.free(m);
        }
        try testing.expectEqual(@as(u64, 0), s.received_bytes);
    }
    try testing.expectEqual(@as(u64, 400), try f.files.addUploadReceived(1, "aaaaaaaaaaaaaaaa", 400));
    try testing.expectEqual(@as(u64, 700), try f.files.addUploadReceived(1, "aaaaaaaaaaaaaaaa", 300));

    try testing.expectEqual(@as(u64, 700), try f.files.addUploadReceived(1, "aaaaaaaaaaaaaaaa", -300 + 300));

    {
        const b = (try f.files.uploadSession(alloc, 2, "bbbbbbbbbbbbbbbb")).?;
        defer {
            alloc.free(b.path);
            alloc.free(b.file_name);
            if (b.blob_md5) |m| alloc.free(m);
        }
        try testing.expectEqual(@as(u64, 0), b.received_bytes);
    }
    try testing.expectError(error.NotFound, f.files.addUploadReceived(2, "aaaaaaaaaaaaaaaa", 100));
    try testing.expectError(error.NotFound, f.files.addUploadReceived(1, "nosuchsession___", 100));

    // A negative total read back as u64 would switch the cap off.
    try testing.expectEqual(@as(u64, 0), try f.files.addUploadReceived(1, "aaaaaaaaaaaaaaaa", -100_000));

    const again = (try f.files.uploadSession(alloc, 1, "aaaaaaaaaaaaaaaa")).?;
    defer {
        alloc.free(again.path);
        alloc.free(again.file_name);
        if (again.blob_md5) |m| alloc.free(m);
    }
    try testing.expectEqual(@as(u64, 0), again.received_bytes);
}
