//! Server configuration, loaded from a ZON file (native Zig object notation:
//! typed, comment-friendly, no extra dependency). All fields have defaults, so
//! a missing or partial config file still yields a usable server.

const std = @import("std");

pub const Tls = struct {
    /// Terminate TLS in-process. When false the server speaks plaintext HTTP.
    enabled: bool = false,
    cert_path: []const u8 = "certs/cert.pem",
    key_path: []const u8 = "certs/key.pem",
    /// TLS 1.3 cipher-suite names to allow, most-preferred first. Empty = the
    /// library default set. Names must match tls.zig's `CipherSuite` enum tags
    /// (e.g. "AES_256_GCM_SHA384", "AES_128_GCM_SHA256", "CHACHA20_POLY1305_SHA256").
    cipher_suites: []const []const u8 = &.{},
};

/// Hot-cache versioning ("history of this file"). A synced edit RETAINS the
/// superseded version instead of pruning it: the old blob stays on disk, a
/// `file_history` row records it, and only the search rows are dropped (the
/// render index rides along with the retained blob). See
/// docs/scratch/hot-cache-versioning.md. Bounded two ways, both required.
pub const History = struct {
    /// Recent versions kept hot, per file (the single K, H6) — now the DEFAULT
    /// and the CEILING for the per-user `users.history_keep`, rather than the
    /// only value (docs/scratch/user-options.md §7). A user who has never chosen
    /// gets this; a user who has is clamped to it, so lowering it here takes
    /// effect for everyone immediately and no household member can set the whole
    /// install's disk policy. `keep = 0` disables versioning cleanly — back to
    /// prune-on-supersede, no history rows written.
    keep: u32 = 5,
    /// The CEILING a person may raise their own `keep` to — separate from the
    /// default above, which is what `keep` alone could not express.
    ///
    /// One number could not be both. Raising the ceiling to let somebody keep
    /// more also raised everyone's default, which is most of what §6 set out to
    /// fix: K only becomes safely user-settable if choosing a different value is
    /// actually available. So the admin now says two things — where everyone
    /// starts, and how far anyone may go.
    ///
    /// **The quota is the real limit, not this.** Since §6 charges retained
    /// versions to their owner's allotment, someone raising their K spends their
    /// own space and is self-limiting; this only stops one household member from
    /// deciding the install's disk policy. `max_bytes` stays behind both.
    ///
    /// Read through `@max(keep, max_keep)` wherever the ceiling is needed, so a
    /// config setting `keep` above it cannot produce a DEFAULT NOBODY MAY CHOOSE
    /// — an install that had raised `keep` on its own keeps working untouched,
    /// which a bare clamp would have quietly undone.
    max_keep: u32 = 15,
    /// Global ceiling on the retained-history store, in bytes (H4) — the SD
    /// guard. Since §6 charges retained versions to their owner's quota, this is
    /// a BACKSTOP rather than the primary control: each account is already bounded
    /// by its own allotment, and eviction against this ceiling now takes only the
    /// WRITING user's oldest versions, so one person's churn can no longer evict
    /// another's. Backup-independent.
    max_bytes: u64 = 500_000_000,
};

pub const Config = struct {
    host: []const u8 = "127.0.0.1",
    port: u16 = 8089,
    /// SQLite database file (created if absent). ":memory:" for an ephemeral db.
    db_path: []const u8 = "inkhold.db",
    /// Path to the 32-byte credential-encryption key, held OUTSIDE the DB (and
    /// ideally outside the backup path) so a stolen `inkhold.db` yields no
    /// recoverable credentials. Generated + persisted 0600 on first run if absent.
    /// **Losing this file makes every stored credential unrecoverable → forced
    /// password resets** — back it up. See docs/design/auth.md §5b.
    cred_key_path: []const u8 = "cred.key",
    /// Directory for the content-addressed blob store and render cache.
    data_dir: []const u8 = "data",
    /// Path to the built web SPA (`dist/`) to serve as static files. Empty
    /// disables static serving (404 on any non-API route, as before). When set,
    /// this same process serves the browser UI (control-plane Face 2 + the SPA)
    /// alongside the device sync API — one port for everything. See http/static.zig.
    web_dir: []const u8 = "",
    /// Email/login of the auto-created first-run administrator.
    ///
    /// IT HAS TO BE AN EMAIL, and the default used to be `"admin"`, which is not
    /// one. The sign-in field is `type="email"`, so the browser refused to submit
    /// the very account the server had just minted: a fresh `make serve` install
    /// printed a temporary password for an account nothing could log in as, and
    /// the CLI has no create-or-rename command to undo it. `config.example.zon`
    /// always said `admin@home.lan`, so only the path that takes the DEFAULT —
    /// `make serve`, which is what the README's quick start tells a new user to
    /// run — was broken. Reported from a clean build (inkhold-beta#11).
    ///
    /// `looksLikeEmail` rejects the rest at startup rather than at first sign-in.
    admin_email: []const u8 = "admin@home.lan",
    /// Maximum connections in flight at once. Serve mode runs a thread per
    /// connection, so this is what bounds thread (and therefore memory) growth
    /// under a connection flood: `max_connections * http.transport.conn_stack_size`
    /// is the reserved-stack ceiling. Over the cap, new connections are closed
    /// immediately and accepting continues.
    ///
    /// Needs headroom, because slots are held for a connection's whole LIFETIME,
    /// not per request: HTTP keep-alive means a browser parks ~6 idle connections
    /// per tab, and the device holds a persistent Socket.IO WebSocket. 32 covers a
    /// household — several browser tabs plus the device — and is the largest cap
    /// that keeps the reserved-stack ceiling (32 x 1 MiB = 32 MB) inside the
    /// project's ~50 MB budget with room for the heap, SQLite and the blob I/O.
    ///
    /// The ceiling is reserved address space, not RSS: only the pages a thread
    /// actually touches become resident — ~68 KiB for an idle keep-alive
    /// connection (the socket buffers), ~576 KiB for one running a big transfer.
    /// Raise this only together with the RSS budget.
    ///
    /// 96, up from 32: household demand is ~80 sockets (12 browsers x ~6 + 8
    /// devices), and the old cap refused ~8 of them at 72 sockets while the lock
    /// still had headroom — refusing a connection does not make the box faster.
    /// The deliberate cost is ~6.4 MB resident worst-case (96 idle keep-alives),
    /// a spend against the ~50 MB budget, not a free win; chosen at 96 over 128
    /// because idle threads still carry a glibc descriptor + static TLS.
    max_connections: u16 = 96,
    tls: Tls = .{},
    /// Hot-cache versioning bounds (see `History`). Defaults keep the last 5
    /// versions per file under a 500 MB global ceiling.
    history: History = .{},
};

/// A parsed config plus the arena that owns its string allocations.
pub const Loaded = struct {
    config: Config,
    arena: std.heap.ArenaAllocator,

    pub fn deinit(self: *Loaded) void {
        self.arena.deinit();
    }
};

/// Is `s` shaped like an email — something `<input type="email">` will submit?
///
/// DELIBERATELY THE BROWSER'S RULE, not RFC 5322. The only thing that matters is
/// whether the sign-in form will accept the identity the server minted, so this
/// mirrors the HTML5 constraint: a non-empty local part, one `@`, a non-empty
/// domain, and no whitespace. Note it does NOT require a dot — `admin@home` is a
/// valid HTML5 email and a perfectly good household login, and rejecting it here
/// would refuse an account the browser would have accepted.
pub fn looksLikeEmail(s: []const u8) bool {
    const at = std.mem.indexOfScalar(u8, s, '@') orelse return false;
    if (at == 0 or at + 1 == s.len) return false;
    // A SECOND `@` is not an email. `indexOfScalar` finds the first, so without
    // this `a@b@c` would pass on the strength of its first one.
    if (std.mem.indexOfScalarPos(u8, s, at + 1, '@') != null) return false;
    for (s) |c| if (std.ascii.isWhitespace(c)) return false;
    return true;
}

pub const ParseError = error{ OutOfMemory, ParseZon };

/// Parse a config from a null-terminated ZON source. Omitted fields use defaults.
pub fn parse(gpa: std.mem.Allocator, source: [:0]const u8) ParseError!Loaded {
    var arena = std.heap.ArenaAllocator.init(gpa);
    errdefer arena.deinit();
    const cfg = try std.zon.parse.fromSliceAlloc(Config, arena.allocator(), source, null, .{});
    return .{ .config = cfg, .arena = arena };
}

/// Rewrites every relative path in `cfg` to be relative to `dir` — the
/// directory the config file itself lives in.
///
/// **WHY THE CONFIG'S OWN DIRECTORY, AND NOT THE WORKING DIRECTORY.** These
/// paths used to resolve against the cwd, which is invisible in the config and
/// different for every caller. A config saying `db_path = "server/8089/mini.db"`
/// therefore named a DIFFERENT DATABASE depending on where the process happened
/// to be standing — the server (cwd = repo root) and a CLI run from a sibling
/// checkout resolved the same file to two different installs.
///
/// That is not hypothetical. `users make-admin` was pointed at another
/// checkout's config with `-c`, promoted the account, reported success, and
/// changed a database nobody was looking at; the browser showed no change
/// because from its side nothing had happened. `openExisting`'s refuse-to-create
/// check could not catch it, because the wrong database EXISTED.
///
/// Resolving against the config's own directory makes `-c <path>` mean "that
/// install" from anywhere, which is the only reading under which pointing a
/// recovery tool at a config is a safe thing to do. Absolute paths are left
/// exactly as written.
fn rebase(arena: std.mem.Allocator, cfg: *Config, dir: []const u8) !void {
    if (dir.len == 0) return;
    const fields = [_]*[]const u8{
        &cfg.db_path,
        &cfg.cred_key_path,
        &cfg.data_dir,
        &cfg.web_dir,
        &cfg.tls.cert_path,
        &cfg.tls.key_path,
    };
    for (fields) |f| {
        const v = f.*;
        if (v.len == 0) continue; // "" means "unset", not "the config's directory"
        if (std.fs.path.isAbsolute(v)) continue;
        f.* = try std.fs.path.join(arena, &.{ dir, v });
    }
}

/// Load config from `path`; if the file does not exist, return defaults.
///
/// Relative paths inside the file are resolved against the FILE's directory
/// (see `rebase`). When the file is absent the defaults are returned untouched,
/// so they keep meaning "relative to the working directory" — there is no config
/// directory to be relative to, and that is the first-run case.
pub fn loadFileOrDefault(gpa: std.mem.Allocator, io: std.Io, path: []const u8) !Loaded {
    const src = std.Io.Dir.cwd().readFileAllocOptions(
        io,
        path,
        gpa,
        .limited(1 << 20),
        .of(u8),
        0, // null sentinel -> [:0]u8 for the ZON parser
    ) catch |err| switch (err) {
        error.FileNotFound => {
            const arena = std.heap.ArenaAllocator.init(gpa);
            return .{ .config = .{}, .arena = arena };
        },
        else => return err,
    };
    defer gpa.free(src);
    var loaded = try parse(gpa, src);
    errdefer loaded.deinit();
    rebase(loaded.arena.allocator(), &loaded.config, std.fs.path.dirname(path) orelse "") catch |e| {
        return e;
    };
    return loaded;
}

test "relative paths resolve against the CONFIG's directory, not the caller's cwd" {
    // THE BUG THIS EXISTS FOR. `users make-admin` was pointed at another
    // checkout's config with `-c`; the config said `db_path =
    // "server/8089/minicloud.db"`, which resolved against the CLI's working
    // directory rather than the config's, so it promoted an account in a
    // DIFFERENT install, reported success, and left the browser showing nothing
    // because from its side nothing had happened. The refuse-to-create check
    // could not catch it: the wrong database existed.
    var loaded = try parse(std.testing.allocator,
        \\.{
        \\    .db_path = "minicloud.db",
        \\    .cred_key_path = "cred.key",
        \\    .data_dir = "data",
        \\    .web_dir = "../../webapp/dist",
        \\}
    );
    defer loaded.deinit();
    try rebase(loaded.arena.allocator(), &loaded.config, "server/8089");

    try std.testing.expectEqualStrings("server/8089/minicloud.db", loaded.config.db_path);
    try std.testing.expectEqualStrings("server/8089/cred.key", loaded.config.cred_key_path);
    try std.testing.expectEqualStrings("server/8089/data", loaded.config.data_dir);
    // Escaping upward is allowed and left intact — a config in a subdirectory
    // legitimately reaches repo-level assets.
    try std.testing.expectEqualStrings("server/8089/../../webapp/dist", loaded.config.web_dir);
}

test "rebase leaves absolute paths alone, and leaves an empty field empty" {
    var loaded = try parse(std.testing.allocator,
        \\.{ .db_path = "/srv/inkhold/mini.db", .data_dir = "data" }
    );
    defer loaded.deinit();
    try rebase(loaded.arena.allocator(), &loaded.config, "/etc/inkhold");

    try std.testing.expectEqualStrings("/srv/inkhold/mini.db", loaded.config.db_path);
    try std.testing.expectEqualStrings("/etc/inkhold/data", loaded.config.data_dir);
    // `web_dir` defaults to "" and MEANS "serve nothing" — rebasing it would
    // turn a disabled feature into a directory that happens to exist.
    try std.testing.expectEqualStrings("", loaded.config.web_dir);
}

test "a config in the CURRENT directory is unchanged, so the common case is untouched" {
    var loaded = try parse(std.testing.allocator,
        \\.{ .db_path = "inkhold.db", .data_dir = "data" }
    );
    defer loaded.deinit();
    // `dirname("config.zon")` is null -> "" -> no rebase at all.
    try rebase(loaded.arena.allocator(), &loaded.config, std.fs.path.dirname("config.zon") orelse "");

    try std.testing.expectEqualStrings("inkhold.db", loaded.config.db_path);
    try std.testing.expectEqualStrings("data", loaded.config.data_dir);
}

test "parse full config" {
    var loaded = try parse(std.testing.allocator,
        \\.{
        \\    .host = "0.0.0.0",
        \\    .port = 9443,
        \\    .tls = .{
        \\        .enabled = true,
        \\        .cert_path = "/etc/sn/cert.pem",
        \\        .key_path = "/etc/sn/key.pem",
        \\        .cipher_suites = .{ "AES_256_GCM_SHA384" },
        \\    },
        \\}
    );
    defer loaded.deinit();
    const c = loaded.config;
    try std.testing.expectEqualStrings("0.0.0.0", c.host);
    try std.testing.expectEqual(@as(u16, 9443), c.port);
    try std.testing.expect(c.tls.enabled);
    try std.testing.expectEqualStrings("/etc/sn/cert.pem", c.tls.cert_path);
    try std.testing.expectEqual(@as(usize, 1), c.tls.cipher_suites.len);
    try std.testing.expectEqualStrings("AES_256_GCM_SHA384", c.tls.cipher_suites[0]);
}

test "defaults fill in for a minimal config" {
    var loaded = try parse(std.testing.allocator, ".{ .port = 1234 }");
    defer loaded.deinit();
    try std.testing.expectEqual(@as(u16, 1234), loaded.config.port);
    try std.testing.expectEqualStrings("127.0.0.1", loaded.config.host);
    try std.testing.expect(!loaded.config.tls.enabled);
    try std.testing.expectEqualStrings("certs/cert.pem", loaded.config.tls.cert_path);
    try std.testing.expectEqualStrings("inkhold.db", loaded.config.db_path);
    try std.testing.expectEqualStrings("data", loaded.config.data_dir);
    // AN EMAIL, because the sign-in field is `type="email"` and will not submit
    // anything else. The default was `"admin"`, which locked a fresh `make serve`
    // install out of the account it had just created (inkhold-beta#11).
    try std.testing.expectEqualStrings("admin@home.lan", loaded.config.admin_email);
    try std.testing.expect(looksLikeEmail(loaded.config.admin_email));
    // Hot-cache versioning defaults.
    try std.testing.expectEqual(@as(u32, 5), loaded.config.history.keep);
    try std.testing.expectEqual(@as(u64, 500_000_000), loaded.config.history.max_bytes);
}

test "looksLikeEmail accepts what the sign-in field accepts, and nothing else" {
    // THE ONE THAT MATTERS: the old default. It reached the database, printed a
    // password, and then could never be typed into a `type="email"` field.
    try std.testing.expect(!looksLikeEmail("admin"));

    // No dot required — `admin@home` is a valid HTML5 email and a fine household
    // login. Rejecting it would refuse an account the browser would have taken.
    try std.testing.expect(looksLikeEmail("admin@home"));
    try std.testing.expect(looksLikeEmail("admin@home.lan"));
    try std.testing.expect(looksLikeEmail("a@b"));

    try std.testing.expect(!looksLikeEmail(""));
    try std.testing.expect(!looksLikeEmail("@home.lan")); // no local part
    try std.testing.expect(!looksLikeEmail("admin@")); // no domain
    try std.testing.expect(!looksLikeEmail("a@b@c")); // the second `@`
    try std.testing.expect(!looksLikeEmail("admin home@lan")); // whitespace
    try std.testing.expect(!looksLikeEmail("admin@home lan"));
}

test "history bounds parse from a partial config" {
    var loaded = try parse(std.testing.allocator, ".{ .history = .{ .keep = 0, .max_bytes = 1024 } }");
    defer loaded.deinit();
    try std.testing.expectEqual(@as(u32, 0), loaded.config.history.keep); // disables versioning
    try std.testing.expectEqual(@as(u64, 1024), loaded.config.history.max_bytes);
}
