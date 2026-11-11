//! Device upload sessions: upload/apply, /oss/put, upload/finish.

const std = @import("std");
const clock = @import("../../util/clock.zig");
const filesmod = @import("../files.zig");
const Files = filesmod.Files;
const internal = @import("internal.zig");
const UploadSession = filesmod.UploadSession;
const md5_len = filesmod.md5_len;

/// Binds `inner_name` (our opaque upload key) to the destination folder, file
/// name and declared size at `upload/apply`. These values, not finish's echoed
/// path, are authoritative.
pub fn createUploadSession(self: Files, user_id: u64, inner_name: []const u8, path: []const u8, file_name: []const u8, declared_size: u64) !void {
    try self.db.run(
        "INSERT INTO upload_sessions(inner_name, user_id, path, file_name, declared_size, blob_md5, created_at) VALUES(?1,?2,?3,?4,?5,NULL,?6);",
        &.{
            .{ .text = inner_name },
            .{ .int = @intCast(user_id) },
            .{ .text = path },
            .{ .text = file_name },
            .{ .int = @intCast(declared_size) },
            .{ .int = clock.nowSeconds(self.io) },
        },
    );
}

/// The md5 the blob store computed at `/oss/put`. NotFound if no such session.
pub fn setUploadBlob(self: Files, user_id: u64, inner_name: []const u8, md5: []const u8) !void {
    try self.db.run(
        "UPDATE upload_sessions SET blob_md5 = ?1 WHERE inner_name = ?2 AND user_id = ?3;",
        &.{ .{ .text = md5 }, .{ .text = inner_name }, .{ .int = @intCast(user_id) } },
    );
    if (self.db.changes() == 0) return error.NotFound;
}

/// Adds `delta` to a session's staged-byte total, bounding the sum of parts
/// (not just each body). Signed, since a re-POSTed part replaces its file;
/// clamped at 0. NotFound if not this caller's session.
pub fn addUploadReceived(self: Files, user_id: u64, inner_name: []const u8, delta: i64) !u64 {
    {
        try self.db.run(
            "UPDATE upload_sessions SET received_bytes = MAX(0, received_bytes + ?1) " ++
                "WHERE inner_name = ?2 AND user_id = ?3;",
            &.{ .{ .int = delta }, .{ .text = inner_name }, .{ .int = @intCast(user_id) } },
        );
        if (self.db.changes() == 0) return error.NotFound;
    }
    var r = (try self.db.row(
        "SELECT received_bytes FROM upload_sessions WHERE inner_name = ?1 AND user_id = ?2;",
        &.{ .{ .text = inner_name }, .{ .int = @intCast(user_id) } },
    )) orelse return error.NotFound;
    defer r.finalize();
    return @intCast(r.int(0));
}

/// Slices are owned by `alloc`.
pub fn uploadSession(self: Files, alloc: std.mem.Allocator, user_id: u64, inner_name: []const u8) !?UploadSession {
    var r = (try self.db.row("SELECT path, file_name, declared_size, blob_md5, received_bytes FROM upload_sessions WHERE inner_name = ?1 AND user_id = ?2;", &.{ .{ .text = inner_name }, .{ .int = @intCast(user_id) } })) orelse return null;
    defer r.finalize();
    const path = try alloc.dupe(u8, r.text(0));
    const file_name = try alloc.dupe(u8, r.text(1));
    const declared_size: u64 = @intCast(r.int(2));
    const raw_md5 = r.text(3);
    const blob_md5 = if (raw_md5.len == 0) null else try alloc.dupe(u8, raw_md5);
    return .{
        .path = path,
        .file_name = file_name,
        .declared_size = declared_size,
        .blob_md5 = blob_md5,
        .received_bytes = @intCast(r.int(4)),
    };
}

pub fn deleteUploadSession(self: Files, inner_name: []const u8) !void {
    try self.db.run("DELETE FROM upload_sessions WHERE inner_name = ?1;", &.{.{ .text = inner_name }});
}

/// Drops sessions older than `max_age_s` and their on-disk blob when it has no
/// `blobs` row (created only at finish, so a shared md5 is left alone).
pub fn sweepUploadSessions(self: Files, max_age_s: i64) !usize {
    const cutoff = clock.nowSeconds(self.io) - max_age_s;

    var doomed: std.ArrayList([]u8) = .empty; // inner_names, owned
    defer {
        for (doomed.items) |n| self.gpa.free(n);
        doomed.deinit(self.gpa);
    }
    var orphans: std.ArrayList([md5_len]u8) = .empty;
    defer orphans.deinit(self.gpa);
    {
        var s = try self.db.prepare(
            "SELECT s.inner_name, s.blob_md5 FROM upload_sessions s WHERE s.created_at < ?1;",
        );
        defer s.finalize();
        s.bindInt(1, cutoff);
        while (try s.step()) {
            try doomed.append(self.gpa, try self.gpa.dupe(u8, s.columnText(0)));
            const m = s.columnText(1);
            if (m.len == md5_len and !try blobRowExists(self, m)) {
                var arr: [md5_len]u8 = undefined;
                @memcpy(&arr, m[0..md5_len]);
                try orphans.append(self.gpa, arr);
            }
        }
    }

    for (doomed.items) |n| try self.deleteUploadSession(n);
    for (orphans.items) |*m| internal.removeBlobFiles(self, m); // reclaim on-disk-only bytes
    return doomed.items.len;
}

fn blobRowExists(self: Files, md5: []const u8) !bool {
    var s = try self.db.prepare("SELECT 1 FROM blobs WHERE md5 = ?1;");
    defer s.finalize();
    s.bindText(1, md5);
    return try s.step();
}

// ---- uploads that are not files: the Digest app's handwritten notes ----

/// The `path` of an upload session that is not a file in the tree, but a
/// digest's handwritten note (`upload/apply/summary`). It never starts with
/// `/`, so `upload/finish` refuses it rather than filing it as a document.
pub const digest_upload_path = "digest:";

/// Takes the blob an upload session holds as one more reference (the session
/// is dropped) and returns its md5, owned by `alloc`. Null when the session is
/// unknown or nothing was uploaded yet. The caller's transaction decides: on
/// rollback the reference and the session come back.
pub fn claimUploadedBlob(self: Files, alloc: std.mem.Allocator, user_id: u64, inner_name: []const u8) !?[]const u8 {
    const session = (try self.uploadSession(alloc, user_id, inner_name)) orelse return null;
    const md5 = session.blob_md5 orelse return null;
    const size = try self.blobs.sizeOf(md5);
    try internal.ensureBlobRow(self, md5, size);
    try internal.incref(self, md5);
    try self.deleteUploadSession(inner_name);
    return md5;
}

/// Gives up one reference taken by `claimUploadedBlob`. True means: call
/// `removeBlobFiles` once the transaction has committed.
pub fn releaseBlob(self: Files, md5: []const u8) !bool {
    return internal.decref(self, md5);
}

/// Removes a released blob's bytes and derived files (after commit).
pub fn removeBlobFiles(self: Files, md5: []const u8) void {
    internal.removeBlobFiles(self, md5);
}
