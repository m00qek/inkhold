//! `inkhold restore`: a snapshot back onto a fresh install. The server must
//! be stopped and the install empty: a restore never merges into, or writes
//! over, a database that exists.
//!
//! Order: the snapshot is verified; blobs go into the live store (each checked
//! against its md5 by the store itself); the database is inflated beside its
//! final path, prepared, and renamed into place last, so an interrupted
//! restore leaves no database and can simply be run again.
//!
//! Preparing the database:
//!   - Every device is signed out (DESIGN.md §2.6): the restored server is
//!     older than the tablets, and a tablet that resumed syncing against it
//!     might delete what it holds that the server lacks.
//!   - Half-finished uploads are dropped; their chunks were never backed up.
//!   - The record of past backups is emptied: it is the snapshot day's.
//!   - The library gets a new id. Signing out alone is not enough: a tablet
//!     keeps its file-sync records across sign-out, and only drops them at
//!     sign-in when the library id (or the account) changed. Seen on a Nomad.
//!   - The credential key: the snapshot's if it carried one; else the install's
//!     own, if it can decrypt the restored accounts; else a new key, and every
//!     account gets a temporary password (returned once, to print) because no
//!     stored credential can be read without the old key.
//! Thumbnails and search text are not restored; the server rebuilds them
//! (`ThumbStore.has` heals on demand, `Worker.reconcileDerived` at start).

const std = @import("std");
const layout = @import("layout.zig");
const manifest = @import("manifest.zig");
const list_mod = @import("list.zig");
const verify_mod = @import("verify.zig");
const blob_copy = @import("blob_copy.zig");
const gzfile = @import("gzfile.zig");
const pace_mod = @import("pace.zig");
const create_mod = @import("create.zig");
const status_mod = @import("status.zig");
const library = @import("../library.zig");
const sqlite = @import("../../db/sqlite.zig");
const schema = @import("../../db/schema.zig");
const blobstore = @import("../../store/blobs.zig");
const thumbstore = @import("../../store/thumbs.zig");
const atomic = @import("../../store/atomic.zig");
const authsvc = @import("../auth/service.zig");
const password = @import("../auth/password.zig");
const filesmod = @import("../files.zig");
const Io = std.Io;
const Dir = Io.Dir;

pub const Options = struct {
    /// A snapshot name; the newest complete one when null.
    snapshot: ?[]const u8 = null,
    /// Restoring is the one time speed matters: unlimited by default.
    rate: u64 = 0,
};

pub const Key = enum {
    /// The snapshot carried cred.key; it was written to the install.
    from_backup,
    /// The install already had the key that decrypts these accounts.
    kept_existing,
    /// No key could decrypt them: a new one, and every account reset.
    generated,
};

/// A temporary password to show once, then forget.
pub const Reset = struct {
    email: []u8,
    temp: authsvc.TempPassword,
};

pub const Report = struct {
    name: layout.SnapshotName = @splat('0'),
    created: i64 = 0,
    blobs: u64 = 0,
    bytes: u64 = 0,
    key: Key = .from_backup,
    devices_signed_out: i64 = 0,
    resets: std.ArrayList(Reset) = .empty,
    /// On `SnapshotDamaged`: what verify found.
    damage: ?verify_mod.Result = null,

    pub fn deinit(self: *Report, gpa: std.mem.Allocator) void {
        for (self.resets.items) |*r| {
            std.crypto.secureZero(u8, &r.temp.buf);
            gpa.free(r.email);
        }
        self.resets.deinit(gpa);
    }
};

pub const RestoreError = error{
    /// A database already exists at the configured path.
    TargetNotEmpty,
    NoSnapshots,
    NoSuchSnapshot,
    SnapshotDamaged,
    /// The snapshot comes from a newer schema than this binary knows.
    NewerSchema,
    /// The snapshot's cred.key and the install's differ.
    CredKeyConflict,
    /// The install has a cred.key, and it cannot decrypt the restored accounts.
    CredKeyMismatch,
};

pub fn restore(gpa: std.mem.Allocator, io: Io, paths: create_mod.Paths, dir: Dir, opts: Options, report: *Report) !void {
    if (exists(io, paths.db_path)) return error.TargetNotEmpty;
    var wal_buf: [Dir.max_path_bytes]u8 = undefined;
    if (exists(io, std.fmt.bufPrint(&wal_buf, "{s}-wal", .{paths.db_path}) catch return error.NameTooLong)) return error.TargetNotEmpty;

    report.name = try pick(gpa, io, dir, opts.snapshot);
    const name: []const u8 = &report.name;
    {
        var v = try verify_mod.verify(gpa, io, dir, name, .{ .rate = 0 });
        defer v.deinit(gpa);
        if (!v.allOk()) {
            report.damage = v.results.items[0];
            return error.SnapshotDamaged;
        }
    }
    const header = try list_mod.readHeader(io, dir, name);
    if (header.schema > schema.version) return error.NewerSchema;
    report.created = header.created;

    const s = try gpa.create(blob_copy.Scratch);
    defer gpa.destroy(s);
    var pace = pace_mod.Pace.init(io, opts.rate);

    // ---- blobs, into the live store ----
    const blobs_path = try std.fmt.allocPrint(gpa, "{s}/blobs", .{paths.data_dir});
    defer gpa.free(blobs_path);
    var blobs_dir = try Dir.cwd().createDirPathOpen(io, blobs_path, .{});
    defer blobs_dir.close(io);
    const store = try blobstore.BlobStore.init(io, blobs_dir);
    try restoreBlobs(io, dir, name, store, s, &pace, report);

    // ---- the database, beside its final path ----
    const tmp_path = try std.fmt.allocPrintSentinel(gpa, "{s}.restoring", .{paths.db_path}, 0);
    defer gpa.free(tmp_path);
    Dir.cwd().deleteFile(io, tmp_path) catch {};
    errdefer Dir.cwd().deleteFile(io, tmp_path) catch {};
    {
        var pb: [layout.snapshot_name_len + 1 + layout.db_name.len]u8 = undefined;
        const src = std.fmt.bufPrint(&pb, "{s}/{s}", .{ name, layout.db_name }) catch unreachable;
        const out = try Dir.cwd().createFile(io, tmp_path, .{});
        defer out.close(io);
        var fw = out.writerStreaming(io, &s.write_buf);
        var head: [0]u8 = .{};
        _ = try gzfile.inflate(io, dir, src, &fw.interface, &head, s, &pace);
        try fw.interface.flush();
        try out.sync(io);
    }
    var new_key: ?[password.cred_key_len]u8 = null;
    {
        const db = try sqlite.Db.openNoCreate(tmp_path, create_mod.cache_kib);
        defer db.close();
        try schema.migrate(db);
        new_key = try prepare(gpa, io, db, paths, dir, name, header.has_cred_key, store, report);
    }
    // The key file is written only once the database is ready, just before it
    // goes into place: a restore that fails earlier leaves no key behind that
    // a second attempt would then find unable to decrypt these accounts.
    if (new_key) |k| try writeKey(io, paths.cred_key_path, &k);
    try Dir.rename(Dir.cwd(), tmp_path, Dir.cwd(), paths.db_path, io);
}

/// The snapshot named, or the newest complete one.
fn pick(gpa: std.mem.Allocator, io: Io, dir: Dir, wanted: ?[]const u8) !layout.SnapshotName {
    if (wanted) |w| {
        if (!layout.isSnapshotName(w)) return error.NoSuchSnapshot;
        dir.access(io, w, .{}) catch return error.NoSuchSnapshot;
        return w[0..layout.snapshot_name_len].*;
    }
    var l = try list_mod.list(gpa, io, dir);
    defer l.deinit(gpa);
    var i = l.entries.items.len;
    while (i > 0) {
        i -= 1;
        if (l.entries.items[i].header != null) return l.entries.items[i].name;
    }
    return error.NoSnapshots;
}

fn restoreBlobs(io: Io, dir: Dir, name: []const u8, store: blobstore.BlobStore, s: *blob_copy.Scratch, pace: *pace_mod.Pace, report: *Report) !void {
    var pb: [layout.snapshot_name_len + 1 + layout.manifest_name.len]u8 = undefined;
    const path = std.fmt.bufPrint(&pb, "{s}/{s}", .{ name, layout.manifest_name }) catch unreachable;
    const f = try dir.openFile(io, path, .{});
    defer f.close(io);
    var mbuf: [4096]u8 = undefined;
    var fr = f.reader(io, &mbuf);
    var m = try manifest.Reader.init(&fr.interface);
    while (try m.next()) |md5| {
        var src: blob_copy.Source = undefined;
        try blob_copy.open(io, dir, &md5, s, &src);
        defer src.close(io);
        // The store hashes what it writes and refuses a mismatch.
        const put = try store.put(src.reader(), &md5);
        report.blobs += 1;
        report.bytes += put.size;
        pace.take(io, @intCast(@min(put.size, std.math.maxInt(usize))));
    }
}

/// Signs devices out (or resets every account, under a new key), drops
/// half-finished uploads. Returns the key to persist, when the install had none.
fn prepare(gpa: std.mem.Allocator, io: Io, db: sqlite.Db, paths: create_mod.Paths, dir: Dir, name: []const u8, has_key: bool, store: blobstore.BlobStore, report: *Report) !?[password.cred_key_len]u8 {
    const chosen = try chooseKey(gpa, io, db, paths.cred_key_path, dir, name, has_key, report);
    const key = chosen.key;
    var svc = authsvc.Service.init(gpa, io, db, key);
    defer svc.deinit();

    if (report.key == .generated) {
        // Each reset signs that account out everywhere, devices included.
        const users = try svc.listUsers(gpa);
        defer authsvc.Service.freeUsers(gpa, users);
        for (users) |u| {
            const temp = try svc.resetPasswordFor(u.id);
            try report.resets.append(gpa, .{ .email = try gpa.dupe(u8, u.email), .temp = temp });
        }
    } else {
        report.devices_signed_out = try svc.revokeDeviceSessions();
    }

    // Half-finished uploads: their chunks were never in the backup. A negative
    // age puts the cutoff in the future, so every session goes.
    const thumbs_path = try std.fmt.allocPrint(gpa, "{s}/thumbs", .{paths.data_dir});
    defer gpa.free(thumbs_path);
    var thumbs_dir = try Dir.cwd().createDirPathOpen(io, thumbs_path, .{});
    defer thumbs_dir.close(io);
    const files = filesmod.Files.init(gpa, io, db, store, try thumbstore.ThumbStore.init(io, thumbs_dir));
    _ = try files.sweepUploadSessions(-1);
    // The snapshot's record of backups is the snapshot day's, not this server's.
    try status_mod.clear(db);
    // A new library id: tablets compare it at sign-in and, seeing it changed,
    // sync from scratch instead of deleting what this older server lacks.
    try library.renew(db);
    return if (chosen.write) key else null;
}

const Chosen = struct {
    key: [password.cred_key_len]u8,
    /// The install has no key file yet; the caller writes it last.
    write: bool,
};

/// Settles which key the restored install uses. Writes nothing.
fn chooseKey(gpa: std.mem.Allocator, io: Io, db: sqlite.Db, key_path: []const u8, dir: Dir, name: []const u8, has_key: bool, report: *Report) !Chosen {
    const existing = try readKey(gpa, io, Dir.cwd(), key_path);

    if (has_key) {
        var pb: [layout.snapshot_name_len + 1 + layout.cred_key_name.len]u8 = undefined;
        const p = std.fmt.bufPrint(&pb, "{s}/{s}", .{ name, layout.cred_key_name }) catch unreachable;
        const from_backup = (try readKey(gpa, io, dir, p)) orelse return error.CredKeyMissingFromSnapshot;
        if (existing) |e| if (!std.mem.eql(u8, &e, &from_backup)) return error.CredKeyConflict;
        report.key = .from_backup;
        return .{ .key = from_backup, .write = existing == null };
    }

    if (existing) |e| {
        if (!try decrypts(db, e)) return error.CredKeyMismatch;
        report.key = .kept_existing;
        return .{ .key = e, .write = false };
    }

    var key: [password.cred_key_len]u8 = undefined;
    io.random(&key);
    report.key = .generated;
    return .{ .key = key, .write = true };
}

/// Whether `key` opens the restored accounts' credentials (no accounts: yes).
fn decrypts(db: sqlite.Db, key: [password.cred_key_len]u8) !bool {
    var r = (try db.row("SELECT cred_enc FROM users WHERE cred_enc IS NOT NULL AND cred_enc <> '' LIMIT 1;", &.{})) orelse return true;
    defer r.finalize();
    _ = password.decryptCred(key, r.text(0)) catch return false;
    return true;
}

fn readKey(gpa: std.mem.Allocator, io: Io, dir: Dir, path: []const u8) !?[password.cred_key_len]u8 {
    const bytes = dir.readFileAlloc(io, path, gpa, .limited(4096)) catch |e| switch (e) {
        error.FileNotFound => return null,
        else => return e,
    };
    defer gpa.free(bytes);
    if (bytes.len != password.cred_key_len) return error.BadCredKey;
    return bytes[0..password.cred_key_len].*;
}

/// Written 0600 and exclusively: a key is never overwritten.
fn writeKey(io: Io, path: []const u8, key: []const u8) !void {
    const f = try Dir.cwd().createFile(io, path, .{ .exclusive = true, .permissions = Io.File.Permissions.fromMode(0o600) });
    defer f.close(io);
    try f.writePositionalAll(io, key, 0);
    try f.sync(io);
}

fn exists(io: Io, path: []const u8) bool {
    Dir.cwd().access(io, path, .{}) catch return false;
    return true;
}

/// Whether something already answers on `host:port`: a server still running
/// on the install being restored. The command line refuses to restore then.
pub fn serverAnswers(io: Io, host: []const u8, port: u16) bool {
    const addr = Io.net.IpAddress.parse(host, port) catch return false;
    const stream = addr.connect(io, .{ .mode = .stream }) catch return false;
    stream.close(io);
    return true;
}
