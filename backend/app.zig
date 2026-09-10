//! The composition root: it builds an Inkhold out of a config and hands the
//! result to the transport.
//!
//! **This lived in `http/transport.zig`, whose own header claimed to be
//! "app-agnostic — pure plumbing" while it opened the database, constructed four
//! services and two stores, and ran the startup sweeps.** The claim had been
//! true once. Splitting it here makes it true again: `transport.listenAndServe` now takes
//! an assembled `Context` and knows nothing about what is in it.
//!
//! **Why a function and not an `App` struct.** Everything below is stack-scoped
//! with `defer`, which gives correct reverse-order teardown for free and unwinds
//! a partial failure correctly without a line of code. A struct would have to
//! reproduce that order by hand in a `deinit`, plus an `errdefer` chain for every
//! partially-built state — replacing something the compiler gets right with
//! something a reviewer has to check. `serve` never returns on success, so these
//! defers run only when the server is coming down anyway.

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

/// Builds everything and serves until an unrecoverable error. Never returns on
/// success. `routes` is the application's route table (see `routes.zig`).
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
        ciphers = try transport.resolveCiphers(gpa, cfg.tls.cipher_suites);
    }
    defer if (cfg.tls.enabled and cfg.tls.cipher_suites.len > 0) gpa.free(ciphers);

    // Bring up the database and the auth/data service (shared across requests).
    const db_path = try gpa.dupeZ(u8, cfg.db_path); // sqlite wants a null-terminated path
    defer gpa.free(db_path);
    var db = try sqlite.Db.open(db_path);
    defer db.close();
    try schema.migrate(db);

    // Read-only connections for the `read_only` routes, opened AFTER the writer
    // has created the file and established WAL — a reader can do neither. Closed
    // BEFORE the writer (defers unwind last-first), which also matters: the
    // readers coordinate through the `-shm` file the writer keeps alive.
    //
    // Failing to open one is fatal rather than degraded, deliberately: it means
    // the database file is not readable by the process that just wrote it, which
    // is a broken install and not a load condition. Exhaustion at RUNTIME is the
    // thing that must degrade, and it does — see `db/reader_pool.zig`.
    var readers = try reader_pool.Pool.open(gpa, db_path, reader_pool.default_size);
    defer readers.close(gpa);

    // The credential-encryption key (loaded/generated before the service opens, so
    // every credential path has it). Held outside the DB, deliberately.
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

    // The two per-document derived stores (§2.1). Same
    // posture as thumbs: derived, regenerable, backup-skippable, cleanup riding
    // the source blob's GC. Losing either directory costs a re-derive, not data.
    //
    // NOT on the boot path, and not from the tenants' discovery query either:
    // `deferred.Worker.reconcileDerived` finds what is missing, on the worker
    // thread. The tenant predicates ask "does this blob still owe INDEX work?",
    // which is the wrong question — §2.4 makes the FILE the fact — and answers
    // "no" for every document indexed before these stores existed.
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

    // Post-upload processing, off the connection (`services/deferred.zig`).
    //
    // Declared AFTER `db_lock` because it borrows it, and STOPPED before the
    // connection closes: `db.close()` is deferred further up, and defers unwind
    // last-registered-first, so this join always runs first. A worker still
    // inside a transaction when the connection went away would be the one bug
    // this ordering exists to make impossible.
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

    // The ingest path wakes it after each commit. Advisory only — the worker's
    // discovery query is the source of truth, and its idle tick picks up
    // anything a missed signal or a restart left behind.
    files_svc.deferred = &worker;

    // The shared pending count behind the live channel's `event: index` frame.
    // AFTER the worker because it reads the worker's own signals — the ingest
    // epoch and the completed-job counter — to decide when its answer is stale.
    // It holds no memory and no thread of its own, so there is nothing to stop
    // and nothing to free; it simply goes with this stack frame.
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

/// A startup housekeeping sweep that did not run. Named by its caller, because
/// there are two now and a warning that says "recycle-bin" while the upload sweep
/// is what failed sends the next reader to the wrong table.
fn sweepFailed(what: []const u8, e: anyerror) usize {
    std.log.warn("{s} sweep failed: {t}", .{ what, e });
    return 0;
}

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

/// Runs the server until an unrecoverable error. Never returns on success.
/// `routes` is the application's route table (see backend/routes.zig).
/// The retention sweep is best-effort housekeeping at startup: a failure here
/// must warn and let the server come up, never abort the boot.
/// Load the 32-byte credential-encryption key from `path`, or generate + persist a
/// fresh one (0600) on first run. The key lives OUTSIDE the DB so a stolen backup
/// cannot decrypt `users.cred_enc`; LOSING it makes every credential unrecoverable
/// (forced resets), which is why a fresh key is loudly logged.
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
pub fn ensureAdmin(svc: *authsvc.Service, email: []const u8, rng: std.Random) !?passwordmod.TempPassword {
    if (try svc.hasAnyUser()) return null;
    const pw = passwordmod.generateTemp(rng);
    _ = try svc.bootstrapAdmin(email, pw.slice());
    return pw;
}

/// Shows the first-run admin banner on the terminal. This is the ONLY time the
/// temporary password is ever displayed and it is the only way into a fresh
/// install, so it must stay loud and human-visible — hence stderr (unbuffered,
/// always on the terminal) rather than a log level someone could filter away.
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
