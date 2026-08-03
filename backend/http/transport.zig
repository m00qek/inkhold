//! Reusable HTTP(S) transport: an accept loop that optionally terminates TLS
//! in-process (via ianic/tls.zig) and dispatches each request through a route
//! table supplied by the caller. It is app-agnostic — the route table is passed
//! into `run`, so this stays pure plumbing.

const std = @import("std");
const tls = @import("tls");
const config = @import("../config.zig");
const router = @import("router.zig");
const context = @import("context.zig");
const Context = context.Context;
const sqlite = @import("../db/sqlite.zig");
const schema = @import("../db/schema.zig");
const authsvc = @import("../services/auth/service.zig");
const passwordmod = @import("../services/auth/password.zig");
const ratelimit = @import("ratelimit.zig");
const dltokens = @import("download_tokens.zig");
const eventstreams = @import("event_streams.zig");
const lockstats = @import("lock_stats.zig");
const filesmod = @import("../services/files.zig");
const settingsmod = @import("../services/settings.zig");
const blobstore = @import("../store/blobs.zig");
const thumbstore = @import("../store/thumbs.zig");

const Io = std.Io;

// Socket-side buffers must hold whole TLS ciphertext records; plaintext-side
// buffers hold decrypted data / HTTP heads.
const sock_read_len = tls.input_buffer_len;
const sock_write_len = tls.output_buffer_len;
const plain_len = 16 * 1024;

pub const Error = error{UnknownCipherSuite} || std.mem.Allocator.Error;

/// Stack reserved for each per-connection thread.
///
/// ESTABLISHED EMPIRICALLY, because static frame analysis badly under-predicts.
/// Summing the `sub $N,%rsp` prologues along the deepest chain in the compiled
/// Debug binary gives only ~281 KB:
///
///   handleConn                67,952 B  socket buffers (tls.input_buffer_len
///                                       16,645 + output 16,469) + the TLS
///                                       plaintext buffers (2 x 16,384)
///   serve + handle +
///     dispatchLocked + dispatch  2,976 B
///   ossPut                   134,728 B  a [64 KiB] read + a [64 KiB] write
///                                       buffer, both on the stack
///   multipart.extract         75,144 B  the [read_chunk + max_term] work buffer
///
/// The real requirement is roughly DOUBLE that — the sum misses the reader/writer,
/// Io-vtable and syscall-wrapper frames beneath the sink, and glibc's thread
/// descriptor + static TLS come out of the same mapping. A live 32 MB upload
/// bisects the true floor to between 512 KiB (reproducible SIGSEGV on entry to
/// `multipart.extract`) and 576 KiB (clean). Do not trust the static sum alone;
/// re-bisect against a real transfer if these frames change.
///
/// 1 MiB is ~1.8x that measured floor. The download path (`ossGet`, 134,768 B),
/// static SPA serving (`static.serve`, 133,904 B) and the TLS handshake
/// (`DhKeyPair.init`, 124,336 B) are all shallower than the upload path this is
/// sized against. Undersizing here is far worse than the thread flood the cap
/// bounds — it is a stack-overflow crash mid-transfer, as the 512 KiB run showed.
///
/// Also a floor from below: glibc rejects small stacks with EINVAL, and Zig's
/// `Thread.spawn` treats that as `unreachable` (a panic, not an error the accept
/// loop's inline fallback could absorb). 1 MiB is far clear of that.
pub const conn_stack_size = 1024 * 1024;

/// Bounds how many connections may be in flight at once.
///
/// Serve mode spawns a detached thread per connection, so without a cap a
/// connection flood is a thread flood — each with `conn_stack_size` of stack plus
/// its buffers — which blows the project's hard ~50 MB RSS target. Over the cap
/// the accept loop closes the connection immediately and keeps accepting.
///
/// Split out of the accept loop (which tests never invoke) so the accounting is
/// directly unit-testable, following `authorize`/`formatPeerIp`. The real risk
/// here is not the arithmetic but BALANCE: one missed `release` on an error or
/// fallback path leaks a slot, and the count drifts up until the server refuses
/// everything. A pure `admit(active, max)` predicate could not catch that.
pub const ConnLimiter = struct {
    active: std.atomic.Value(u32) = .init(0),
    max: u32,

    pub fn init(max: u32) ConnLimiter {
        return .{ .max = max };
    }

    /// Reserve a slot, or false if at capacity. On false the caller MUST close the
    /// connection; on true it MUST eventually `release` exactly once.
    pub fn tryAcquire(self: *ConnLimiter) bool {
        var cur = self.active.load(.monotonic);
        while (true) {
            if (cur >= self.max) return false;
            // Compare-and-swap rather than fetchAdd-then-check: an overshooting
            // add would be briefly visible to another accepting thread and, worse,
            // needs a compensating decrement on the failure path — one more place
            // to leak a slot.
            cur = self.active.cmpxchgWeak(cur, cur + 1, .acquire, .monotonic) orelse return true;
        }
    }

    /// Give a slot back. Exactly one per successful `tryAcquire`.
    pub fn release(self: *ConnLimiter) void {
        const prev = self.active.fetchSub(1, .release);
        std.debug.assert(prev != 0); // released more than acquired — a slot-accounting bug
    }

    /// Slots currently held. For tests and diagnostics.
    pub fn count(self: *const ConnLimiter) u32 {
        return self.active.load(.monotonic);
    }
};

test "ConnLimiter: admits up to the cap, refuses beyond it, and balances back to zero" {
    var l: ConnLimiter = .init(3);
    try std.testing.expectEqual(@as(u32, 0), l.count());

    // Up to the cap.
    for (0..3) |_| try std.testing.expect(l.tryAcquire());
    try std.testing.expectEqual(@as(u32, 3), l.count());

    // Over the cap: refused, and refusal must not itself consume or leak a slot
    // (a flood hits this path repeatedly — drift here is the whole failure mode).
    for (0..10) |_| try std.testing.expect(!l.tryAcquire());
    try std.testing.expectEqual(@as(u32, 3), l.count());

    // Freeing one slot re-admits exactly one.
    l.release();
    try std.testing.expectEqual(@as(u32, 2), l.count());
    try std.testing.expect(l.tryAcquire());
    try std.testing.expect(!l.tryAcquire());

    // Everything released → back to zero, and full capacity is available again.
    l.release();
    l.release();
    l.release();
    try std.testing.expectEqual(@as(u32, 0), l.count());
    for (0..3) |_| try std.testing.expect(l.tryAcquire());
    try std.testing.expectEqual(@as(u32, 3), l.count());
    for (0..3) |_| l.release();
    try std.testing.expectEqual(@as(u32, 0), l.count());
}

test "ConnLimiter: a slot is returned even when the connection handler fails" {
    // Mirrors the accept loop's contract: `connThread` releases via `defer`, and
    // the inline spawn-failure fallback releases too. A handler that errors out
    // must not strand its slot — that is the drift that eventually refuses every
    // connection while the server looks healthy.
    var l: ConnLimiter = .init(2);
    const serveOne = struct {
        fn run(lim: *ConnLimiter, fail: bool) !void {
            try std.testing.expect(lim.tryAcquire());
            defer lim.release(); // exactly what connThread does
            if (fail) return error.ConnectionReset;
        }
    }.run;

    for (0..50) |i| {
        serveOne(&l, i % 2 == 0) catch {};
        try std.testing.expectEqual(@as(u32, 0), l.count()); // never drifts
    }

    // After a burst of failures the full cap is still available.
    try std.testing.expect(l.tryAcquire());
    try std.testing.expect(l.tryAcquire());
    try std.testing.expect(!l.tryAcquire());
    l.release();
    l.release();
    try std.testing.expectEqual(@as(u32, 0), l.count());
}

test "ConnLimiter: a zero cap refuses everything without underflowing" {
    var l: ConnLimiter = .init(0);
    try std.testing.expect(!l.tryAcquire());
    try std.testing.expectEqual(@as(u32, 0), l.count());
}

/// Runs the server until an unrecoverable error. Never returns on success.
/// `routes` is the application's route table (see backend/routes.zig).
/// The retention sweep is best-effort housekeeping at startup: a failure here
/// must warn and let the server come up, never abort the boot.

/// EVERY startup housekeeping sweep, in one named place so the SET of them can be
/// tested rather than only the individual sweeps.
///
/// That distinction is the reason this function exists. `sweepUploadSessions` was
/// written, documented and unit-tested, and called from NOTHING but its own
/// tests — so abandoned uploads accumulated for ever on real installs while a
/// green suite reported the sweep working perfectly. A test can assert a function
/// reclaims rows; only a test of the COMPOSITION can assert that anybody asks it
/// to. `startup_sweeps` below is that test's handle.
///
/// All best-effort: housekeeping must warn and let the server come up, never
/// abort the boot.
fn startupSweeps(io: Io, db: sqlite.Db, svc: *authsvc.Service, files_svc: filesmod.Files) void {
    // EXPIRED SESSIONS. This one used to sit up in `run` as a bare `try`, so a
    // sweep that failed — a locked DB, a read-only data dir — took the whole boot
    // down with it, while the two housekeeping sweeps below it deliberately warned
    // and carried on. Nothing here is load-bearing for serving requests: an
    // expired session is already refused by `caller` on every request, so the row
    // is disk hygiene, not an authorization gate. Same policy as its neighbours.
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

    // ABANDONED UPLOADS. Three paths in `putChunk`/`finishUpload` deliberately
    // leave a staged blob behind — a hash mismatch, a quota refusal, and an
    // upload the client simply stopped — each with a comment saying the sweep
    // will reclaim it. The sweep existed and was called from NOTHING but its own
    // tests, so on a real install those blobs and their `upload_sessions` rows
    // accumulated for ever, on exactly the Pi-class box where disk is the
    // binding constraint.
    //
    // A day is the window: long enough that a genuinely slow upload resumed the
    // next morning is not destroyed, short enough that a wedged one does not
    // outlive the interest in it. Best-effort like the bin sweep above and for
    // the same reason — housekeeping must warn and let the server come up, never
    // abort the boot.
    {
        const swept = files_svc.sweepUploadSessions(24 * 60 * 60) catch |e| sweepFailed("abandoned-upload", e);
        if (swept > 0) std.log.info("uploads: reclaimed {d} abandoned session{s}", .{ swept, if (swept == 1) "" else "s" });
    }

}

/// A startup housekeeping sweep that did not run. Named by its caller, because
/// there are two now and a warning that says "recycle-bin" while the upload sweep
/// is what failed sends the next reader to the wrong table.
fn sweepFailed(what: []const u8, e: anyerror) usize {
    std.log.warn("{s} sweep failed: {t}", .{ what, e });
    return 0;
}

test "startupSweeps runs EVERY sweep, including the one that was never wired" {
    // THE TEST THE MISSING WIRING NEEDED. `sweepUploadSessions` was written,
    // documented and unit-tested — and called from nothing but its own tests, so
    // abandoned uploads accumulated for ever while a green suite reported the
    // sweep working. A test of the FUNCTION cannot catch that; only a test of the
    // composition can, which is why `startupSweeps` exists as a named unit.
    //
    // Both sweeps are asserted through their EFFECT on rows, not by observing a
    // call, so a wiring that runs a sweep with a window it can never collect
    // anything in still fails here.
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

    // An abandoned upload session, dated at the epoch so any sane window takes it.
    try db.exec(
        "INSERT INTO upload_sessions(inner_name, user_id, path, file_name, declared_size, blob_md5, created_at) " ++
            "VALUES('stale', 1, '/Note', 'x.note', 1, '0123456789abcdef0123456789abcdef', 0);",
    );
    // A long-expired session, likewise dated at the epoch.
    try db.exec(
        "INSERT INTO sessions(token_hash, user_id, audience, created_at, expires_at) " ++
            "VALUES('deadbeef', 1, 'controlplane', 0, 1);",
    );

    var svc = authsvc.Service.init(testing.allocator, testing.io, db, [_]u8{0} ** passwordmod.cred_key_len);
    defer svc.deinit();
    startupSweeps(testing.io, db, &svc, files_svc);

    var r = (try db.row("SELECT COUNT(*) FROM upload_sessions;", &.{})).?;
    defer r.finalize();
    try testing.expectEqual(@as(i64, 0), r.int(0));

    // The expired-session sweep is part of the SAME set: it used to be a bare
    // `try` up in `run`, outside anything a composition test could reach.
    var s = (try db.row("SELECT COUNT(*) FROM sessions;", &.{})).?;
    defer s.finalize();
    try testing.expectEqual(@as(i64, 0), s.int(0));
}

test "a failed session sweep warns and lets the boot continue, sweeps after it included" {
    // The session sweep aborted the boot on failure while both housekeeping sweeps
    // beside it warned and carried on. Two ways to get that wrong, so both are
    // pinned here: propagating the error (the original bug) and catching it but
    // returning early (the plausible half-fix), which silently drops every sweep
    // that follows.
    //
    // A BEFORE DELETE trigger makes the sweep's DELETE genuinely fail inside
    // SQLite; the abandoned-upload sweep after it must still reclaim its row.
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

    // The warn is the contract; silence it for the suite's output.
    const saved_level = testing.log_level;
    testing.log_level = .err;
    defer testing.log_level = saved_level;

    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    const store = try blobstore.BlobStore.init(testing.io, tmp.dir);
    const thumbs_dir = try tmp.dir.createDirPathOpen(testing.io, "thumbs", .{});
    const thumbs = try thumbstore.ThumbStore.init(testing.io, thumbs_dir);
    const files_svc = filesmod.Files.init(testing.allocator, testing.io, db, store, thumbs);

    var svc = authsvc.Service.init(testing.allocator, testing.io, db, [_]u8{0} ** passwordmod.cred_key_len);
    defer svc.deinit();

    // Returns normally (the signature is `void` — a failure here cannot be an
    // error the caller might `try`), and the later sweep still did its work.
    startupSweeps(testing.io, db, &svc, files_svc);

    var r = (try db.row("SELECT COUNT(*) FROM upload_sessions;", &.{})).?;
    defer r.finalize();
    try testing.expectEqual(@as(i64, 0), r.int(0));

    // And the session the sweep could not take is still there, proving the DELETE
    // really failed rather than the test asserting an empty sweep.
    var s = (try db.row("SELECT COUNT(*) FROM sessions;", &.{})).?;
    defer s.finalize();
    try testing.expectEqual(@as(i64, 1), s.int(0));
}


/// Load the 32-byte credential-encryption key from `path`, or generate + persist a
/// fresh one (0600) on first run. The key lives OUTSIDE the DB so a stolen backup
/// cannot decrypt `users.cred_enc`; LOSING it makes every credential unrecoverable
/// (forced resets), which is why a fresh key is loudly logged. See auth.md §5b.
fn loadOrCreateCredKey(gpa: std.mem.Allocator, io: Io, path: []const u8, rng: std.Random) ![passwordmod.cred_key_len]u8 {
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

/// Reads the credential key at `path`, or null when there is none — **the
/// load-only half, which never creates one.**
///
/// That distinction is the whole reason it is a separate function. Generating a
/// fresh key is right on first run and catastrophic on an existing install: it
/// makes every stored `cred_enc` undecryptable, so the next credential written
/// under it "succeeds" while locking out everybody else in the household. `serve`
/// may create (first run is real); the recovery CLI may not, and calls this.
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

pub fn run(gpa: std.mem.Allocator, io: Io, cfg: config.Config, routes: []const router.Route) !void {
    var rng_source: std.Random.IoSource = .{ .io = io };
    const rng = rng_source.interface();

    // Load the certificate once if TLS is enabled.
    var auth: ?tls.config.CertKeyPair = null;
    defer if (auth) |*a| a.deinit(gpa);
    var ciphers: []const tls.config.CipherSuite = tls.config.cipher_suites.tls13;
    if (cfg.tls.enabled) {
        const dir = std.Io.Dir.cwd();
        auth = try tls.config.CertKeyPair.fromFilePath(gpa, io, dir, cfg.tls.cert_path, cfg.tls.key_path);
        ciphers = try resolveCiphers(gpa, cfg.tls.cipher_suites);
    }
    defer if (cfg.tls.enabled and cfg.tls.cipher_suites.len > 0) gpa.free(ciphers);

    // Bring up the database and the auth/data service (shared across requests).
    const db_path = try gpa.dupeZ(u8, cfg.db_path); // sqlite wants a null-terminated path
    defer gpa.free(db_path);
    var db = try sqlite.Db.open(db_path);
    defer db.close();
    try schema.migrate(db);

    // The credential-encryption key (loaded/generated before the service opens, so
    // every credential path has it). Held outside the DB — see auth.md §5b.
    const cred_key = try loadOrCreateCredKey(gpa, io, cfg.cred_key_path, rng);

    var svc = authsvc.Service.init(gpa, io, db, cred_key);
    defer svc.deinit();
    // (the expired-session sweep runs with the other startup housekeeping below)
    if (try ensureAdmin(&svc, cfg.admin_email, rng)) |pw| announceAdmin(cfg.admin_email, pw);

    var limiter = ratelimit.Limiter.init(gpa);
    defer limiter.deinit();

    // Capability tokens for URL-authed downloads (see http/download_tokens.zig).
    var download_tokens = dltokens.DownloadTokens.init(gpa);
    defer download_tokens.deinit();

    // Admission control for the held SSE streams. Serve mode is the ONLY mode
    // that sets this — a held stream needs a thread of its own to park on, which
    // is exactly what the accept loop below hands out. Allocation-free, so there
    // is no `deinit` and nothing that can outlive this scope: when `run` returns,
    // the registry goes with the stack frame, and every stream thread it was
    // tracking is a detached connection thread whose socket dies with the process.
    var event_streams: eventstreams.EventStreams = .{};

    // Content-addressed blob store + file-tree service, shared across requests
    // (the device sync + control-plane file faces). Sweep any temp blobs a prior crash left.
    const blobs_path = try std.fmt.allocPrint(gpa, "{s}/blobs", .{cfg.data_dir});
    defer gpa.free(blobs_path);
    const blobs_dir = try std.Io.Dir.cwd().createDirPathOpen(io, blobs_path, .{});
    defer blobs_dir.close(io);
    var blob_store = try blobstore.BlobStore.init(io, blobs_dir);
    blob_store.sweepTmp();

    // The derived-thumbnail store beside it (`thumbs/<source_md5>`). Derived and
    // regenerable — losing this dir (it is backup-skippable) heals on demand via
    // the `/thumbnail` serve path, so there is no startup backfill to run here.
    const thumbs_path = try std.fmt.allocPrint(gpa, "{s}/thumbs", .{cfg.data_dir});
    defer gpa.free(thumbs_path);
    const thumbs_dir = try std.Io.Dir.cwd().createDirPathOpen(io, thumbs_path, .{});
    defer thumbs_dir.close(io);
    const thumb_store = try thumbstore.ThumbStore.init(io, thumbs_dir);
    thumb_store.sweepTmp();

    var files_svc = filesmod.Files.init(gpa, io, db, blob_store, thumb_store);
    files_svc.history = cfg.history; // hot-cache versioning bounds (keep / max_bytes)

    // Recycle-bin retention, on the same startup tick as the session sweep: an
    // entry trashed longer ago than the window is destroyed for real here.
    //
    // The window is CONFIGURABLE now (admin console), so it is read from the
    // `settings` table rather than the compiled constant — and the cutoff comes
    // from `settings.sweepCutoff`, which returns null when a recently-SHORTENED
    // window has not yet been in force for its own length. That null is what stops
    // an admin editing a number from purging a month of other people's notes on
    // the next restart; nothing is swept until the new window has been served in
    // full. See services/settings.zig.
    startupSweeps(io, db, &svc, files_svc);

    // Serializes access to the single shared SQLite connection across the
    // per-connection threads the accept loop spawns: a shared connection must be
    // serialized, and holding this across a whole handler also rules out
    // multi-statement transaction interleaving between threads.
    var db_lock: Io.Mutex = .init;

    // Per-route hold times for that lock, reported by GET /api/admin/health. Lives
    // here because its lifetime is the server's and its safety argument is
    // `db_lock`'s (see http/lock_stats.zig): every write happens under the lock
    // next to it, so the two must be born and shared together.
    var lock_stats_table: lockstats.LockStats = .{};

    const address = try Io.net.IpAddress.parse(cfg.host, cfg.port);
    var listener = try address.listen(io, .{ .mode = .stream, .reuse_address = true });
    defer listener.close(io);

    std.debug.print("Inkhold listening on {s}://{s}:{d}\n", .{
        if (cfg.tls.enabled) "https" else "http", cfg.host, cfg.port,
    });

    var ctx: Context = .{
        .gpa = gpa,
        .io = io,
        .config = cfg,
        .service = &svc,
        .files = &files_svc,
        .limiter = &limiter,
        .download_tokens = &download_tokens,
        .event_streams = &event_streams,
        .db_lock = &db_lock,
        .lock_stats = &lock_stats_table,
    };

    const auth_ptr: ?*tls.config.CertKeyPair = if (auth) |*a| a else null;

    var conns: ConnLimiter = .init(cfg.max_connections);
    var refusing = false; // true while over capacity, so we log once per episode

    while (true) {
        const stream = listener.accept(io) catch |err| {
            std.debug.print("accept failed: {}\n", .{err});
            continue;
        };
        // Bound the in-flight connections BEFORE spawning: one detached thread per
        // connection means an unbounded flood is a thread flood (see ConnLimiter).
        // Over the cap we close immediately and keep accepting — refusing fast is
        // what keeps the accept loop responsive for the connections we do serve.
        if (!conns.tryAcquire()) {
            stream.close(io);
            if (!refusing) {
                refusing = true; // one line per episode, not one per refused connection
                std.debug.print(
                    "at max_connections ({d}); refusing new connections until one closes\n",
                    .{cfg.max_connections},
                );
            }
            continue;
        }
        refusing = false;
        // One detached thread per connection. A connection can be held open for a
        // long time — a browser keep-alive, the device's persistent Socket.IO
        // WebSocket, an SSE stream — and serving connections one-at-a-time wedges
        // the accept loop (nothing else can be served while one is parked). The
        // shared state each thread touches is synchronized: the SQLite connection
        // via `ctx.db_lock` (whole handler = whole transaction, no interleaving),
        // the rate limiter and download-token store via their own mutexes.
        // `connThread` takes `ctx` by value so
        // per-request mutations (`client_ip`, `caller`) stay thread-local. On spawn
        // failure we fall back to handling inline so the server keeps serving.
        // `stack_size` is explicit, not the (large) default: the cap only bounds
        // memory if the per-thread reservation is a known number. See conn_stack_size.
        const t = std.Thread.spawn(.{ .stack_size = conn_stack_size }, connThread, .{ ctx, routes, stream, auth_ptr, ciphers, rng, &conns }) catch |err| {
            // Inline fallback: this thread never took a slot of its own, so release
            // the one we reserved above — missing this leaks a slot per spawn failure.
            defer conns.release();
            std.debug.print("thread spawn failed ({}); handling inline\n", .{err});
            handleConn(&ctx, routes, stream, auth_ptr, ciphers, rng) catch |e| {
                std.debug.print("connection error: {}\n", .{e});
            };
            stream.close(io);
            continue;
        };
        t.detach();
    }
}

/// Handle one accepted connection on its own thread. Takes `ctx` by value so
/// per-connection/per-request mutations (`client_ip`, `caller`) touch a
/// thread-local copy — the shared pointers inside it (`service`/`files` DB via
/// `db_lock`, `limiter`, `download_tokens`) carry their own synchronization.
fn connThread(
    ctx: Context,
    routes: []const router.Route,
    stream: Io.net.Stream,
    auth: ?*tls.config.CertKeyPair,
    ciphers: []const tls.config.CipherSuite,
    rng: std.Random,
    conns: *ConnLimiter,
) void {
    // Give the slot back however this thread ends — a normal close, a connection
    // error, anything. This `defer` is the whole balance guarantee for the common
    // path; the accept loop's inline fallback has its own.
    defer conns.release();
    var local = ctx;
    handleConn(&local, routes, stream, auth, ciphers, rng) catch |err| {
        std.debug.print("connection error: {}\n", .{err});
    };
    stream.close(local.io);
}

fn handleConn(
    ctx: *Context,
    routes: []const router.Route,
    stream: Io.net.Stream,
    auth: ?*tls.config.CertKeyPair,
    ciphers: []const tls.config.CipherSuite,
    rng: std.Random,
) !void {
    const io = ctx.io;
    var ip_buf: [46]u8 = undefined; // max textual IPv6 length
    ctx.client_ip = peerIp(stream, &ip_buf); // per-connection; null if unavailable

    var sock_rbuf: [sock_read_len]u8 = undefined;
    var sock_wbuf: [sock_write_len]u8 = undefined;
    var sr = stream.reader(io, &sock_rbuf);
    var sw = stream.writer(io, &sock_wbuf);

    if (ctx.config.tls.enabled) {
        var conn = try tls.server(&sr.interface, &sw.interface, .{
            .auth = auth,
            .rng = rng,
            .now = Io.Clock.real.now(io),
            .cipher_suites = ciphers,
        });
        var plain_rbuf: [plain_len]u8 = undefined;
        var plain_wbuf: [plain_len]u8 = undefined;
        var cr = conn.reader(&plain_rbuf);
        var cw = conn.writer(&plain_wbuf);
        try serve(ctx, routes, &cr.interface, &cw.interface);
        conn.close() catch {};
    } else {
        try serve(ctx, routes, &sr.interface, &sw.interface);
    }
}

/// Serve HTTP requests on one (already-decrypted) reader/writer pair,
/// dispatching each through the supplied route table.
fn serve(ctx: *Context, routes: []const router.Route, in: *Io.Reader, out: *Io.Writer) !void {
    var http = std.http.Server.init(in, out);
    while (true) {
        var req = http.receiveHead() catch return; // client closed / no more requests
        try handle(ctx, routes, &req);
    }
}

/// Resolve the caller for one request and dispatch it. Exposed so integration
/// tests can drive a request through the real auth + routing path over an
/// in-memory reader/writer, without a socket.
pub fn handle(ctx: *Context, routes: []const router.Route, req: *router.Request) !void {
    // Guard against a std.http assert that otherwise takes down the whole
    // connection thread: `discardBody` (run on the response path to ready the
    // socket for keep-alive) asserts that a body-bearing method carries framing
    //   assert(transfer_encoding != .none or content_length != null)
    // So a POST/PUT/PATCH with NEITHER a Content-Length NOR a Transfer-Encoding
    // — a valid empty-body request — panics the server the moment we respond
    // before reading its (absent) body: every early reject (401/403/404/429)
    // and every body-less POST handler (e.g. `restore`). The assert sits behind
    //   if (keep_alive and request.head.keep_alive)
    // so dropping THIS request's keep-alive skips it entirely; the handler still
    // sends its real response and the connection simply closes afterward.
    // Browsers send `Content-Length: 0` and never hit this; lean clients
    // (`curl -X POST` with no body, some scripts) and malformed/hostile ones do.
    if (req.head.method.requestHasBody() and
        req.head.content_length == null and
        req.head.transfer_encoding == .none)
    {
        req.head.keep_alive = false;
    }
    return dispatchLocked(ctx, routes, req);
}

/// Resolve the caller and dispatch, applying the route table's `db_lock` policy.
///
/// Default policy: hold `db_lock` across resolveCaller + the whole handler, so the
/// shared SQLite connection is never touched concurrently and a multi-statement
/// transaction can't interleave with another thread's. Coarse but correct.
///
/// `manual_db_lock` policy (the streaming transfer routes): hold the lock only
/// across `resolveCaller` — it reads the session table, so it MUST be locked —
/// then release and run the handler unlocked. Those handlers take the lock again
/// themselves around each of their own (short) DB touches, so a multi-MB transfer
/// no longer serializes every other request behind it.
///
/// Skipped entirely when `db_lock` is unset (the integration tests drive handle()
/// directly and are single-threaded).
fn dispatchLocked(ctx: *Context, routes: []const router.Route, req: *router.Request) !void {
    const idx = router.matchedIndex(routes, req);
    // Set before any lock is taken, so EVERY window this request opens is
    // attributed to the route — including the ones a `manual_db_lock` handler
    // opens for itself, which is the only way their "the windows are short" claim
    // can be checked rather than trusted.
    ctx.route_idx = idx;
    ctx.routes = routes; // so the health handler can name what the histogram indexes
    const route = if (idx) |i| &routes[i] else null;
    const manual = if (route) |r| r.manual_db_lock else false;
    const admin_route = if (route) |r| r.require_admin else false;
    // The two are mutually exclusive BY CONSTRUCTION: the manual branch below
    // returns before `renewElevation`, so a manual admin route would silently stop
    // sliding the elevation window and hand admins a surprise 428 with nothing
    // pointing at the flag that did it. `routes.zig` refuses to compile such a
    // route (`router.manualAdminRoute`); this assert is the same rule for the
    // synthetic tables tests build.
    //
    // Chosen over renewing in BOTH branches on purpose. That fix works, and it is
    // the worse one: it puts a silent behaviour in a second place, under a
    // different lock discipline (a manual handler holds no lock here, so its
    // renewal would need a window of its own), where the next reader has to
    // remember it exists. This one cannot be got wrong.
    std.debug.assert(!(manual and admin_route));
    if (manual) {
        const caller = blk: {
            ctx.lockDb();
            defer ctx.unlockDb();
            break :blk if (ctx.service) |svc| resolveCaller(svc, req) else null;
        };
        return router.dispatch(routes, ctx, req, caller);
    }
    ctx.lockDb();
    defer ctx.unlockDb();
    const caller = if (ctx.service) |svc| resolveCaller(svc, req) else null;
    if (admin_route) renewElevation(ctx, req);
    try router.dispatch(routes, ctx, req, caller);
}

/// Slide the caller's admin elevation forward, because they are using the admin
/// console right now. The window is idle-based with a hard ceiling, and this is
/// the "activity" half of it: `Service.renewElevation` clamps the new deadline to
/// the ceiling, so a console left open in a tab cannot renew itself forever.
///
/// Called on `require_admin` routes ONLY — elevation should track admin activity,
/// not any browsing the same session happens to do — and BEFORE `authorize`, which
/// is safe because renewal can only ever extend an already-live elevation: a NULL,
/// an idle-lapsed or a ceiling-exceeded one is left untouched. So it can never
/// grant what the gate is about to refuse.
///
/// Best-effort: a failure here costs the admin an early re-prompt, which is the
/// safe direction to fail.
fn renewElevation(ctx: *Context, req: *router.Request) void {
    const svc = ctx.service orelse return;
    const token = presentedToken(req) orelse return;
    _ = svc.renewElevation(token) catch return;
}

/// The session token presented on a request: the device `x-access-token` header,
/// else the control-plane session cookie. Null if neither is present.
pub fn presentedToken(req: *router.Request) ?[]const u8 {
    var cookie_header: ?[]const u8 = null;
    var it = req.iterateHeaders();
    while (it.next()) |h| {
        if (std.ascii.eqlIgnoreCase(h.name, "x-access-token")) return h.value;
        if (std.ascii.eqlIgnoreCase(h.name, "cookie")) cookie_header = h.value;
    }
    if (cookie_header) |ch| return cookieValue(ch, context.session_cookie_name);
    return null;
}

/// Resolve the authenticated caller from the request's credentials. The device
/// face presents its token in the `x-access-token` header (plus an `equipmentNo`
/// header identifying the device); the control-plane face uses the session cookie. Either
/// way the token is validated against the session store, and the *stored*
/// audience — not the channel — governs authority. Fails closed (null caller →
/// only public routes) on any lookup error.
fn resolveCaller(svc: *authsvc.Service, req: *router.Request) ?router.Caller {
    const t = presentedToken(req) orelse return null;
    var who = (svc.caller(t) catch |err| {
        std.debug.print("resolveCaller: session lookup failed: {}\n", .{err});
        return null;
    }) orelse return null;
    if (who.audience == .device) {
        // Copy the serial INLINE now: header values borrow the request head
        // buffer, which `json.readBody` overwrites before the device handlers
        // read `caller.equipmentNo()` (a use-after-free on the head buffer).
        // `headerCopy` is the shared helper that makes copying the only option.
        who.equipment_len = router.headerCopy(req, "equipmentno", &who.equipment_buf).len;
    }
    return who;
}

/// The peer's IP address (no port) as text, for rate-limit keying. Uses
/// `getpeername` on the socket fd; null if unavailable or an unknown family.
/// (We terminate TLS in-process with no proxy, so this is the real client.)
fn peerIp(stream: Io.net.Stream, buf: []u8) ?[]const u8 {
    var storage: std.posix.sockaddr.storage = undefined;
    var len: std.posix.socklen_t = @sizeOf(@TypeOf(storage));
    std.posix.getpeername(stream.socket.handle, @ptrCast(&storage), &len) catch return null;
    return formatPeerIp(&storage, buf);
}

/// Formats a peer address into just its IP (IPv4 dotted-quad or IPv6 hextets).
/// Pure — split out so it can be unit-tested with a fabricated sockaddr.
fn formatPeerIp(storage: *const std.posix.sockaddr.storage, buf: []u8) ?[]const u8 {
    const sa: *const std.posix.sockaddr = @ptrCast(storage);
    switch (sa.family) {
        std.posix.AF.INET => {
            const in: *const std.posix.sockaddr.in = @ptrCast(@alignCast(storage));
            const b = std.mem.asBytes(&in.addr); // network byte order = dotted order
            return std.fmt.bufPrint(buf, "{d}.{d}.{d}.{d}", .{ b[0], b[1], b[2], b[3] }) catch null;
        },
        std.posix.AF.INET6 => {
            const in6: *const std.posix.sockaddr.in6 = @ptrCast(@alignCast(storage));
            var w = std.Io.Writer.fixed(buf);
            for (in6.addr, 0..) |octet, i| {
                if (i != 0 and i % 2 == 0) w.writeByte(':') catch return null;
                w.print("{x:0>2}", .{octet}) catch return null;
            }
            return buf[0..w.end];
        },
        else => return null,
    }
}

test "formatPeerIp renders an IPv4 dotted quad" {
    var storage: std.posix.sockaddr.storage = std.mem.zeroes(std.posix.sockaddr.storage);
    const in: *std.posix.sockaddr.in = @ptrCast(@alignCast(&storage));
    in.family = std.posix.AF.INET;
    in.addr = std.mem.bytesToValue(u32, &[4]u8{ 192, 168, 1, 42 }); // network order bytes
    var buf: [46]u8 = undefined;
    try std.testing.expectEqualStrings("192.168.1.42", formatPeerIp(&storage, &buf).?);
}

/// Extracts cookie `name` from a `Cookie` header value (`a=1; b=2`), or null.
fn cookieValue(header: []const u8, name: []const u8) ?[]const u8 {
    var it = std.mem.splitScalar(u8, header, ';');
    while (it.next()) |pair| {
        const kv = std.mem.trim(u8, pair, " \t");
        const eq = std.mem.indexOfScalar(u8, kv, '=') orelse continue;
        if (std.mem.eql(u8, kv[0..eq], name)) return kv[eq + 1 ..];
    }
    return null;
}

/// First-run bootstrap: with no accounts yet, create the admin with a random
/// temporary password (diceware), which is RETURNED (null if an account already
/// existed). `must_change_password` forces a change on first login, so the secret
/// grants nothing but that.
///
/// It returns the password rather than printing it because this function also
/// runs under `zig build test`: anything a test binary writes to the console is
/// picked up by the build runner and reported as a bogus `failed command:` line
/// against a truncated step name, while the build still exits 0. Only `serve`
/// prints the banner (see `announceAdmin`), so the test path stays silent.
fn ensureAdmin(svc: *authsvc.Service, email: []const u8, rng: std.Random) !?passwordmod.TempPassword {
    if (try svc.hasAnyUser()) return null;
    const pw = passwordmod.generateTemp(rng);
    _ = try svc.bootstrapAdmin(email, pw.slice());
    return pw;
}

/// Shows the first-run admin banner on the terminal. This is the ONLY time the
/// temporary password is ever displayed and it is the only way into a fresh
/// install, so it must stay loud and human-visible — hence stderr (unbuffered,
/// always on the terminal) rather than a log level someone could filter away.
fn announceAdmin(email: []const u8, pw: passwordmod.TempPassword) void {
    std.debug.print(
        \\
        \\== First run ==
        \\Created admin '{s}' with a temporary password: {s}
        \\Change it on first login (the temporary password grants nothing else).
        \\
        \\
    , .{ email, pw.slice() });
}

fn resolveCiphers(gpa: std.mem.Allocator, names: []const []const u8) Error![]const tls.config.CipherSuite {
    if (names.len == 0) return tls.config.cipher_suites.tls13;
    const out = try gpa.alloc(tls.config.CipherSuite, names.len);
    errdefer gpa.free(out);
    for (names, out) |name, *slot| {
        slot.* = std.meta.stringToEnum(tls.config.CipherSuite, name) orelse return error.UnknownCipherSuite;
    }
    return out;
}

test "cookieValue extracts a named cookie, tolerating spaces" {
    const eq = std.testing.expectEqualStrings;
    try eq("abc123", cookieValue("sn_session=abc123", "sn_session").?);
    try eq("abc123", cookieValue("theme=dark; sn_session=abc123; lang=en", "sn_session").?);
    try eq("abc123", cookieValue("theme=dark;  sn_session=abc123", "sn_session").?); // padded
    try std.testing.expect(cookieValue("theme=dark; lang=en", "sn_session") == null);
    try std.testing.expect(cookieValue("", "sn_session") == null);
    // Must not match on a suffix/substring of another cookie name.
    try std.testing.expect(cookieValue("x_sn_session=nope", "sn_session") == null);
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

    // Idempotent: a second run must not create (or clobber) an admin.
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
