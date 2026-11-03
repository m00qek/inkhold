//! The composition root: builds an Inkhold from a config and hands it to the
//! transport. A function, not a struct, so `defer` gives reverse-order teardown.

const std = @import("std");
const tls = @import("tls");
const Io = std.Io;

const config = @import("config.zig");
const router = @import("http/router.zig");
const transport = @import("http/transport.zig");
const Context = @import("http/context.zig").Context;
const sqlite = @import("db/sqlite.zig");
const reader_pool = @import("db/reader_pool.zig");
const schema = @import("db/schema.zig");
const authsvc = @import("services/auth/service.zig");
const filesmod = @import("services/files.zig");
const deferred = @import("services/deferred.zig");
const pendingsvc = @import("services/pending.zig");
const settingsmod = @import("services/settings.zig");
const ratelimit = @import("http/ratelimit.zig");
const dltokens = @import("http/download_tokens.zig");
const eventstreams = @import("http/event_streams.zig");
const lockstats = @import("http/lock_stats.zig");
const blobstore = @import("store/blobs.zig");
const thumbstore = @import("store/thumbs.zig");
const derivedstore = @import("store/derived.zig");
const passwordmod = @import("services/auth/password.zig");

/// Builds everything and serves; never returns on success.
pub fn run(gpa: std.mem.Allocator, io: Io, cfg: config.Config, routes: []const router.Route) !void {
    var rng_source: std.Random.IoSource = .{ .io = io };
    const rng = rng_source.interface();

    var auth: ?tls.config.CertKeyPair = null;
    defer if (auth) |*a| a.deinit(gpa);
    var ciphers: []const tls.config.CipherSuite = tls.config.cipher_suites.tls13;
    if (cfg.tls.enabled) {
        const dir = std.Io.Dir.cwd();
        auth = try tls.config.CertKeyPair.fromFilePath(gpa, io, dir, cfg.tls.cert_path, cfg.tls.key_path);
        ciphers = try transport.resolveCiphers(gpa, cfg.tls.cipher_suites);
    }
    defer if (cfg.tls.enabled and cfg.tls.cipher_suites.len > 0) gpa.free(ciphers);

    const db_path = try gpa.dupeSentinel(u8, cfg.db_path, 0); // sqlite wants a null-terminated path
    defer gpa.free(db_path);
    var db = try sqlite.Db.open(db_path);
    defer db.close();
    try schema.migrate(db);

    // Readers open after the writer has created the file and WAL, and close before
    // it (they share its `-shm`). A failed open is a broken install, so fatal.
    var readers = try reader_pool.Pool.open(gpa, db_path, reader_pool.default_size);
    defer readers.close(gpa);

    // Held outside the DB, so a stolen backup cannot decrypt credentials.
    const cred_key = try loadOrCreateCredKey(gpa, io, cfg.cred_key_path, rng);

    var svc = authsvc.Service.init(gpa, io, db, cred_key);
    defer svc.deinit();
    if (try ensureAdmin(&svc, cfg.admin_email, rng)) |pw| announceAdmin(cfg.admin_email, pw);

    var limiter = ratelimit.Limiter.init(gpa);
    defer limiter.deinit();

    var download_tokens = dltokens.DownloadTokens.init(gpa);
    defer download_tokens.deinit();

    // Admission control for held SSE streams; allocation-free, nothing to deinit.
    var event_streams: eventstreams.EventStreams = .{};

    // Sweep temp blobs a crash left behind.
    const blobs_path = try std.fmt.allocPrint(gpa, "{s}/blobs", .{cfg.data_dir});
    defer gpa.free(blobs_path);
    const blobs_dir = try std.Io.Dir.cwd().createDirPathOpen(io, blobs_path, .{});
    defer blobs_dir.close(io);
    var blob_store = try blobstore.BlobStore.init(io, blobs_dir);
    blob_store.sweepTmp();

    // Derived, regenerable thumbnails; healed on demand by `/thumbnail`.
    const thumbs_path = try std.fmt.allocPrint(gpa, "{s}/thumbs", .{cfg.data_dir});
    defer gpa.free(thumbs_path);
    const thumbs_dir = try std.Io.Dir.cwd().createDirPathOpen(io, thumbs_path, .{});
    defer thumbs_dir.close(io);
    const thumb_store = try thumbstore.ThumbStore.init(io, thumbs_dir);
    thumb_store.sweepTmp();

    // Per-document derived stores, regenerable like thumbs. Missing entries are
    // found by `deferred.Worker.reconcileDerived` on the worker thread, not here.
    const terms_path = try std.fmt.allocPrint(gpa, "{s}/terms", .{cfg.data_dir});
    defer gpa.free(terms_path);
    const terms_dir = try std.Io.Dir.cwd().createDirPathOpen(io, terms_path, .{});
    defer terms_dir.close(io);
    const terms_store = try derivedstore.DerivedStore.init(io, terms_dir);
    terms_store.sweepTmp();

    const text_path = try std.fmt.allocPrint(gpa, "{s}/text", .{cfg.data_dir});
    defer gpa.free(text_path);
    const text_dir = try std.Io.Dir.cwd().createDirPathOpen(io, text_path, .{});
    defer text_dir.close(io);
    const text_store = try derivedstore.DerivedStore.init(io, text_dir);
    text_store.sweepTmp();

    var files_svc = filesmod.Files.init(gpa, io, db, blob_store, thumb_store);
    files_svc.terms = terms_store;
    files_svc.text = text_store;
    files_svc.history = cfg.history; // hot-cache versioning bounds (keep / max_bytes)

    startupSweeps(io, db, &svc, files_svc);

    // Serializes the single shared SQLite connection across connection threads,
    // whole handlers at a time, so transactions never interleave.
    var db_lock: Io.Mutex = .init;

    // Written only under `db_lock`, so the two share a lifetime.
    var lock_stats_table: lockstats.LockStats = .{};

    // Post-upload processing. Declared after `db_lock` (it borrows it) and stopped
    // before `db.close()` by defer order, so no worker is mid-transaction at close.
    var worker: deferred.Worker = .{
        .gpa = gpa,
        .db = db,
        .blobs = blob_store,
        .lock = &db_lock,
        .io = io,
        .terms = terms_store,
        .text = text_store,
    };
    try worker.start();
    defer worker.stop();

    // Advisory wake; the worker's discovery query is the source of truth.
    files_svc.deferred = &worker;

    // Reads the worker's ingest epoch and job counter; nothing to stop or free.
    var pending_pulse: pendingsvc.Pulse = .{
        .db = db,
        .db_lock = &db_lock,
        .io = io,
        .worker = &worker,
    };

    var ctx: Context = .{
        .gpa = gpa,
        .io = io,
        .config = cfg,
        .service = &svc,
        .files = &files_svc,
        .limiter = &limiter,
        .download_tokens = &download_tokens,
        .event_streams = &event_streams,
        .pending = &pending_pulse,
        .db_lock = &db_lock,
        .readers = &readers,
        .lock_stats = &lock_stats_table,
    };

    const auth_ptr: ?*tls.config.CertKeyPair = if (auth) |*a| a else null;
    try transport.listenAndServe(io, cfg, routes, &ctx, auth_ptr, ciphers, rng);
}

fn sweepFailed(what: []const u8, e: anyerror) usize {
    std.log.warn("{s} sweep failed: {t}", .{ what, e });
    return 0;
}

/// Every startup housekeeping sweep, as one unit so the set can be tested. All
/// best-effort: warn and let the server come up.
fn startupSweeps(io: Io, db: sqlite.Db, svc: *authsvc.Service, files_svc: filesmod.Files) void {
    // An expired session is refused per request anyway; this is disk hygiene.
    svc.sweepExpiredSessions() catch |e| {
        _ = sweepFailed("expired-session", e);
    };

    {
        const set = settingsmod.Settings.init(io, db);
        const purged = sweep: {
            const retention = set.binRetention() catch |e| break :sweep sweepFailed("recycle-bin retention", e);
            const now = std.Io.Clock.real.now(io).toSeconds();
            const cutoff = settingsmod.sweepCutoff(now, retention) orelse break :sweep 0;
            break :sweep files_svc.sweepBinBefore(cutoff) catch |e| sweepFailed("recycle-bin retention", e);
        };
        if (purged > 0) std.log.info("recycle bin: purged {d} expired entr{s}", .{ purged, if (purged == 1) "y" else "ies" });
    }

    // Abandoned uploads (hash mismatch, quota refusal, a stopped client) leave
    // staged blobs. A day lets a slow upload resume the next morning.
    {
        const swept = files_svc.sweepUploadSessions(24 * 60 * 60) catch |e| sweepFailed("abandoned-upload", e);
        if (swept > 0) std.log.info("uploads: reclaimed {d} abandoned session{s}", .{ swept, if (swept == 1) "" else "s" });
    }
}

test "startupSweeps runs EVERY sweep, including the one that was never wired" {
    // Asserts each sweep by its effect on rows; `sweepUploadSessions` once ran from
    // nowhere but its own tests.
    const testing = std.testing;
    var db = try sqlite.Db.openMemory();
    defer db.close();
    try schema.migrate(db);
    try db.exec("INSERT INTO users(id, email, password_md5, cred_enc, is_admin, created_at) VALUES(1,'a@h','','',1,0);");

    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    const store = try blobstore.BlobStore.init(testing.io, tmp.dir);
    const thumbs_dir = try tmp.dir.createDirPathOpen(testing.io, "thumbs", .{});
    const thumbs = try thumbstore.ThumbStore.init(testing.io, thumbs_dir);
    const files_svc = filesmod.Files.init(testing.allocator, testing.io, db, store, thumbs);

    try db.exec(
        "INSERT INTO upload_sessions(inner_name, user_id, path, file_name, declared_size, blob_md5, created_at) " ++
            "VALUES('stale', 1, '/Note', 'x.note', 1, '0123456789abcdef0123456789abcdef', 0);",
    );
    try db.exec(
        "INSERT INTO sessions(token_hash, user_id, audience, created_at, expires_at) " ++
            "VALUES('deadbeef', 1, 'controlplane', 0, 1);",
    );

    var svc = authsvc.Service.init(testing.allocator, testing.io, db, @as([passwordmod.cred_key_len]u8, @splat(0)));
    defer svc.deinit();
    startupSweeps(testing.io, db, &svc, files_svc);

    var r = (try db.row("SELECT COUNT(*) FROM upload_sessions;", &.{})).?;
    defer r.finalize();
    try testing.expectEqual(@as(i64, 0), r.int(0));

    var s = (try db.row("SELECT COUNT(*) FROM sessions;", &.{})).?;
    defer s.finalize();
    try testing.expectEqual(@as(i64, 0), s.int(0));
}

test "a failed session sweep warns and lets the boot continue, sweeps after it included" {
    // Pins both wrong fixes: propagating the error, and returning early so later
    // sweeps are dropped. A trigger makes the DELETE really fail.
    const testing = std.testing;
    var db = try sqlite.Db.openMemory();
    defer db.close();
    try schema.migrate(db);
    try db.exec("INSERT INTO users(id, email, password_md5, cred_enc, is_admin, created_at) VALUES(1,'a@h','','',1,0);");
    try db.exec(
        "INSERT INTO upload_sessions(inner_name, user_id, path, file_name, declared_size, blob_md5, created_at) " ++
            "VALUES('stale', 1, '/Note', 'x.note', 1, '0123456789abcdef0123456789abcdef', 0);",
    );
    try db.exec(
        "INSERT INTO sessions(token_hash, user_id, audience, created_at, expires_at) " ++
            "VALUES('deadbeef', 1, 'controlplane', 0, 1);",
    );
    try db.exec("CREATE TRIGGER no_sweep BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT, 'refused'); END;");

    const saved_level = testing.log_level;
    testing.log_level = .err;
    defer testing.log_level = saved_level;

    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    const store = try blobstore.BlobStore.init(testing.io, tmp.dir);
    const thumbs_dir = try tmp.dir.createDirPathOpen(testing.io, "thumbs", .{});
    const thumbs = try thumbstore.ThumbStore.init(testing.io, thumbs_dir);
    const files_svc = filesmod.Files.init(testing.allocator, testing.io, db, store, thumbs);

    var svc = authsvc.Service.init(testing.allocator, testing.io, db, @as([passwordmod.cred_key_len]u8, @splat(0)));
    defer svc.deinit();

    startupSweeps(testing.io, db, &svc, files_svc);

    var r = (try db.row("SELECT COUNT(*) FROM upload_sessions;", &.{})).?;
    defer r.finalize();
    try testing.expectEqual(@as(i64, 0), r.int(0));

    // Proves the DELETE really failed.
    var s = (try db.row("SELECT COUNT(*) FROM sessions;", &.{})).?;
    defer s.finalize();
    try testing.expectEqual(@as(i64, 1), s.int(0));
}

/// Loads the 32-byte credential key, or generates and persists one (0600) on
/// first run. Kept outside the DB; losing it forces every password reset.
pub fn loadOrCreateCredKey(gpa: std.mem.Allocator, io: Io, path: []const u8, rng: std.Random) ![passwordmod.cred_key_len]u8 {
    if (try loadCredKey(gpa, io, path)) |key| return key;

    var key: [passwordmod.cred_key_len]u8 = undefined;
    rng.bytes(&key);
    std.Io.Dir.cwd().writeFile(io, .{
        .sub_path = path,
        .data = &key,
        .flags = .{ .permissions = std.Io.File.Permissions.fromMode(0o600) },
    }) catch |e| {
        std.log.err("could not persist credential key to {s}: {t}", .{ path, e });
        return e;
    };
    std.log.warn(
        "generated a new credential-encryption key at {s} (0600). BACK IT UP — losing it makes every stored credential unrecoverable (forced password resets).",
        .{path},
    );
    return key;
}

/// First-run bootstrap: with no accounts, creates the admin with a diceware
/// temporary password (must-change) and returns it. Returned, not printed,
/// because console output from a test binary shows up as bogus build failures.
pub fn ensureAdmin(svc: *authsvc.Service, email: []const u8, rng: std.Random) !?passwordmod.TempPassword {
    if (try svc.hasAnyUser()) return null;
    const pw = passwordmod.generateTemp(rng);
    _ = try svc.bootstrapAdmin(email, pw.slice());
    return pw;
}

/// The only time the temporary password is shown, so stderr, not a log level.
pub fn announceAdmin(email: []const u8, pw: passwordmod.TempPassword) void {
    std.debug.print(
        \\
        \\== First run ==
        \\Created admin '{s}' with a temporary password: {s}
        \\Change it on first login (the temporary password grants nothing else).
        \\
        \\
    , .{ email, pw.slice() });
}

test "ensureAdmin creates an admin once, then is a no-op" {
    var db = try sqlite.Db.openMemory();
    defer db.close();
    try schema.migrate(db);
    var svc = authsvc.Service.init(std.testing.allocator, std.testing.io, db, @splat(0xA5));
    defer svc.deinit();

    var rng_source: std.Random.IoSource = .{ .io = std.testing.io };
    const rng = rng_source.interface();

    try std.testing.expect(!try svc.hasAnyUser());
    const pw = try ensureAdmin(&svc, "admin", rng);
    try std.testing.expect(pw != null); // the caller gets the password to display
    try std.testing.expect(pw.?.len > 0 and pw.?.len <= passwordmod.max_temp_len);
    try std.testing.expect(try svc.hasAnyUser());

    var count_before: i64 = undefined;
    {
        var s = try db.prepare("SELECT COUNT(*) FROM users;");
        defer s.finalize();
        _ = try s.step();
        count_before = s.columnInt(0);
    }
    try std.testing.expect((try ensureAdmin(&svc, "admin", rng)) == null); // nothing to announce
    {
        var s = try db.prepare("SELECT COUNT(*) FROM users;");
        defer s.finalize();
        _ = try s.step();
        try std.testing.expectEqual(count_before, s.columnInt(0));
    }
}

/// Reads the credential key, or null; never creates one. A fresh key on an
/// existing install makes every `cred_enc` undecryptable, so only `serve` may
/// create; the recovery CLI calls this.
pub fn loadCredKey(gpa: std.mem.Allocator, io: Io, path: []const u8) !?[passwordmod.cred_key_len]u8 {
    const bytes = std.Io.Dir.cwd().readFileAlloc(io, path, gpa, .limited(4096)) catch |err| switch (err) {
        error.FileNotFound => return null,
        else => return err,
    };
    defer gpa.free(bytes);
    if (bytes.len != passwordmod.cred_key_len) {
        std.log.err(
            "credential key {s} is {d} bytes, expected {d} — refusing to start (restore the original key, or every credential is lost)",
            .{ path, bytes.len, passwordmod.cred_key_len },
        );
        return error.BadCredKey;
    }
    var key: [passwordmod.cred_key_len]u8 = undefined;
    @memcpy(&key, bytes);
    return key;
}
