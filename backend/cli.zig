//! The command line: `serve` plus the `users` recovery verbs, authorised by
//! access to the data directory. Only `serve` may create a database.

const std = @import("std");
const build_options = @import("build_options");
const config = @import("config.zig");
const app = @import("app.zig");
const routes = @import("routes.zig");
const sqlite = @import("db/sqlite.zig");
const schema = @import("db/schema.zig");
const authsvc = @import("services/auth/service.zig");
const passwordmod = @import("services/auth/password.zig");

/// The package version (`build.zig.zon`), surfaced by `--version`.
pub const version = build_options.version;

/// Default `<config>`.
pub const default_config = "config.zon";

/// `usage` (typed it wrong) is distinct from `failed` (it did not work).
pub const exit_ok: u8 = 0;
pub const exit_failed: u8 = 1;
pub const exit_usage: u8 = 2;

pub const Command = enum { serve, users_list, users_reset_password, users_make_admin, help, version };

pub const Invocation = struct {
    command: Command,
    /// Null when omitted: an explicit missing path is a typo and refused, a
    /// missing default means "use defaults".
    config: ?[]const u8 = null,
    /// The `<user>` for the account verbs, matched against the address.
    user: []const u8 = "",

    pub fn configPath(self: Invocation) []const u8 {
        return self.config orelse default_config;
    }
};

pub const ParseError = error{
    /// `users reset-password` / `users make-admin` with no account.
    MissingUser,
    /// `users` with no sub-verb, or one we do not have.
    MissingOrUnknownSubcommand,
    /// More positionals than the grammar has room for.
    UnexpectedArgument,
    /// A `-x` / `--xyz` we do not know.
    UnknownOption,
    /// `--config` with nothing after it.
    MissingConfigValue,
};

/// Parses `args` (argv without the program name):
/// `inkhold [--config=<config>] <group> <verb> [<user>]`. `--config` is an
/// option so `users` can never be read as a file name.
pub fn parse(args: []const []const u8) ParseError!Invocation {
    var inv: Invocation = .{ .command = .serve };
    var rest: [8][]const u8 = undefined;
    var n: usize = 0;

    var i: usize = 0;
    while (i < args.len) : (i += 1) {
        const a = args[i];
        if (std.mem.eql(u8, a, "-h") or std.mem.eql(u8, a, "--help")) return .{ .command = .help };
        if (std.mem.eql(u8, a, "--version")) return .{ .command = .version };
        if (std.mem.startsWith(u8, a, "--config=")) {
            inv.config = a["--config=".len..];
            continue;
        }
        if (std.mem.eql(u8, a, "--config") or std.mem.eql(u8, a, "-c")) {
            i += 1;
            if (i >= args.len) return error.MissingConfigValue;
            inv.config = args[i];
            continue;
        }
        if (a.len > 0 and a[0] == '-') return error.UnknownOption;
        if (n == rest.len) return error.UnexpectedArgument;
        rest[n] = a;
        n += 1;
    }

    const words = rest[0..n];
    if (words.len == 0) return inv; // bare `inkhold` still serves

    if (std.mem.eql(u8, words[0], "serve")) {
        if (words.len > 1) return error.UnexpectedArgument;
        inv.command = .serve;
        return inv;
    }
    if (std.mem.eql(u8, words[0], "users")) {
        if (words.len < 2) return error.MissingOrUnknownSubcommand;
        if (std.mem.eql(u8, words[1], "list")) {
            if (words.len > 2) return error.UnexpectedArgument;
            inv.command = .users_list;
            return inv;
        }
        const verb: Command = if (std.mem.eql(u8, words[1], "reset-password"))
            .users_reset_password
        else if (std.mem.eql(u8, words[1], "make-admin"))
            .users_make_admin
        else
            return error.MissingOrUnknownSubcommand;
        if (words.len < 3) return error.MissingUser;
        if (words.len > 3) return error.UnexpectedArgument;
        inv.command = verb;
        inv.user = words[2];
        return inv;
    }
    return error.MissingOrUnknownSubcommand;
}

/// ANSI styling. Every field is empty when off, so messages exist once. Off
/// unless stdout is a TTY, and when `NO_COLOR` is present. Bold and dim only.
pub const Style = struct {
    bold: []const u8 = "",
    dim: []const u8 = "",
    reset: []const u8 = "",

    pub const plain: Style = .{};
    pub const ansi: Style = .{ .bold = "\x1b[1m", .dim = "\x1b[2m", .reset = "\x1b[0m" };

    /// `tty` is decided by the caller, the only one that knows the stream.
    pub fn choose(tty: bool, no_color_set: bool) Style {
        return if (tty and !no_color_set) ansi else plain;
    }
};

/// The help text. It is read by somebody who cannot sign in, so it states that
/// filesystem access is the authorisation, that nothing creates a database, and
/// that the server need not be stopped first.
pub fn writeHelp(w: *std.Io.Writer, st: Style) !void {
    try w.print(
        \\{[b]s}Inkhold{[r]s} — a private cloud for Supernote devices.
        \\
        \\{[b]s}Usage:{[r]s}
        \\  inkhold [--config=<config>] [serve]
        \\  inkhold [--config=<config>] users list
        \\  inkhold [--config=<config>] users reset-password <user>
        \\  inkhold [--config=<config>] users make-admin <user>
        \\  inkhold (-h | --help)
        \\  inkhold --version
        \\
        \\{[b]s}Arguments:{[r]s}
        \\  {[b]s}<user>{[r]s}            Account to act on, exactly as `inkhold users list`
        \\                    prints it.
        \\
        \\{[b]s}Options:{[r]s}
        \\  {[b]s}-c --config=<config>{[r]s}   Config file to read {[d]s}[default: config.zon]{[r]s}.
        \\  {[b]s}-h --help{[r]s}              Show this message and exit.
        \\  {[b]s}--version{[r]s}              Print the version and exit.
        \\
        \\{[b]s}Commands:{[r]s}
        \\  {[b]s}serve{[r]s}                       Run the server. Assumed when no command
        \\                              is given.
        \\  {[b]s}users list{[r]s}                  List accounts: address, whether they are
        \\                              an admin, and whether a password change is
        \\                              already pending.
        \\  {[b]s}users reset-password{[r]s}        Issue a temporary password and print it
        \\                              ONCE. Signs that account out everywhere; a
        \\                              change is required at next sign-in.
        \\  {[b]s}users make-admin{[r]s}            Grant admin to an account that already
        \\                              exists.
        \\
        \\{[b]s}Recovery:{[r]s}
        \\  These exist for the one case the web app cannot cover: nobody can sign
        \\  in, so nobody can be helped from the admin console. They are authorised by
        \\  read/write access to the data directory — proof of ownership on a self-hosted
        \\  server, and access you already have to the database and the credential key.
        \\
        \\  A household with ONE admin is one forgotten password from unreachable.
        \\  `users list` is the diagnosis, `users make-admin` is the cure, and both are
        \\  worth running before anything goes wrong rather than after.
        \\
        \\{[b]s}Notes:{[r]s}
        \\  The database must already exist. Every command except `serve` refuses to
        \\  create one and prints the path it tried — a mistyped --config would
        \\  otherwise open an empty database and report that your own account does not
        \\  exist, at the worst possible moment.
        \\
        \\  {[b]s}Safe to run while the server is up{[r]s}; a reset takes effect on the next
        \\  request. There is no need to stop it first.
        \\
        \\  The temporary password is printed to stdout and never written to a log.
        \\
    , .{ .b = st.bold, .d = st.dim, .r = st.reset });
}

/// Parses and dispatches with the caller's styling; returns the exit code
/// (`serve` does not return). `out`/`err` are injected so tests see real output.
pub fn runStyled(
    gpa: std.mem.Allocator,
    io: std.Io,
    args: []const []const u8,
    out: *std.Io.Writer,
    err: *std.Io.Writer,
    st: Style,
) !u8 {
    const inv = parse(args) catch |e| {
        switch (e) {
            error.MissingUser => try err.writeAll("That command needs an account: inkhold users <verb> <user>\n"),
            error.MissingOrUnknownSubcommand => try err.writeAll("Unknown command.\n"),
            error.UnexpectedArgument => try err.writeAll("Too many arguments.\n"),
            error.UnknownOption => try err.writeAll("Unknown option.\n"),
            error.MissingConfigValue => try err.writeAll("--config needs a path.\n"),
        }
        try err.writeAll("\n");
        try writeHelp(err, st);
        return exit_usage;
    };
    return execute(gpa, io, inv, out, err, st);
}

pub fn execute(
    gpa: std.mem.Allocator,
    io: std.Io,
    inv: Invocation,
    out: *std.Io.Writer,
    err: *std.Io.Writer,
    st: Style,
) !u8 {
    switch (inv.command) {
        .help => {
            try writeHelp(out, st);
            return exit_ok;
        },
        .version => {
            try out.print("inkhold {s}\n", .{version});
            return exit_ok;
        },
        .serve => {
            // The config may be absent and the database is created: first run.
            var loaded = try config.loadFileOrDefault(gpa, io, inv.configPath());
            defer loaded.deinit();

            // Refuse a non-email admin before opening the DB: the `type="email"`
            // sign-in could never use it and no CLI verb can rename it.
            if (!config.looksLikeEmail(loaded.config.admin_email)) {
                try err.print(
                    \\{[b]s}`admin_email` is not an email address:{[r]s} {[e]s}
                    \\  {[d]s}(as `admin_email` in {[cfg]s}){[r]s}
                    \\
                    \\{[b]s}Nothing was created.{[r]s} Sign-in requires an email, so the first-run
                    \\administrator would be an account you could not log in as. Set it to
                    \\something like {[b]s}admin@home.lan{[r]s} and start again.
                    \\
                , .{
                    .b = st.bold,
                    .d = st.dim,
                    .r = st.reset,
                    .e = loaded.config.admin_email,
                    .cfg = inv.configPath(),
                });
                return exit_failed;
            }

            try app.run(gpa, io, loaded.config, &routes.routes);
            return exit_ok;
        },
        .users_list => return listUsers(gpa, io, inv, out, err, st),
        .users_reset_password => return resetPassword(gpa, io, inv, out, err, st),
        .users_make_admin => return makeAdmin(gpa, io, inv, out, err, st),
    }
}

// ---- opening an EXISTING install ----------------------------------------

/// A database and its service, plus the config arena that owns the paths.
const Opened = struct {
    loaded: config.Loaded,
    db: sqlite.Db,
    svc: authsvc.Service,

    fn deinit(self: *Opened) void {
        self.svc.deinit();
        self.db.close();
        self.loaded.deinit();
    }
};

const OpenError = error{ NoConfig, NoDatabase, NoCredKey, OpenFailed };

/// Opens the install named by `<config>`, refusing to create anything:
/// `sqlite3_open` creates on open, so a typo would migrate an empty database and
/// report the account missing. An explicit missing `<config>` is refused; a
/// missing `cred.key` is never generated (a fresh key would invalidate every
/// credential). `need_cred_key` is false for read-only verbs.
fn openExisting(
    gpa: std.mem.Allocator,
    io: std.Io,
    inv: Invocation,
    need_cred_key: bool,
    err: *std.Io.Writer,
    st: Style,
) !Opened {
    const config_path = inv.configPath();
    if (inv.config != null and !exists(io, config_path)) {
        try err.print(
            \\{[b]s}No config file at:{[r]s} {[p]s}
            \\Nothing was created. Check the path, then try again.
            \\
        , .{ .b = st.bold, .r = st.reset, .p = config_path });
        return error.NoConfig;
    }

    var loaded = config.loadFileOrDefault(gpa, io, config_path) catch |e| {
        try err.print("Could not read the config at {s}: {t}\n", .{ config_path, e });
        return error.NoConfig;
    };
    errdefer loaded.deinit();
    const cfg = loaded.config;

    // ---- the refuse-to-create check ----
    if (!exists(io, cfg.db_path)) {
        // Read by somebody who fears they lost their server: say nothing was
        // touched, and name the path and the config it came from.
        try err.print(
            \\{[b]s}No database at:{[r]s} {[db]s}
            \\  {[d]s}(as `db_path` in {[cfg]s}){[r]s}
            \\
            \\{[b]s}Nothing was created.{[r]s} If that is not where your database lives, point
            \\--config at the right config file and try again.
            \\
        , .{ .b = st.bold, .d = st.dim, .r = st.reset, .db = cfg.db_path, .cfg = config_path });
        return error.NoDatabase;
    }

    const db_path = try gpa.dupeSentinel(u8, cfg.db_path, 0);
    defer gpa.free(db_path);
    var db = sqlite.Db.open(db_path) catch |e| {
        try err.print("Could not open the database at {s}: {t}\n", .{ cfg.db_path, e });
        return error.OpenFailed;
    };
    errdefer db.close();
    schema.migrate(db) catch |e| {
        try err.print("Could not read the database schema at {s}: {t}\n", .{ cfg.db_path, e });
        return error.OpenFailed;
    };

    // Zeroes when the verb does not need the key.
    var cred_key: [passwordmod.cred_key_len]u8 = @splat(0);
    if (need_cred_key) {
        cred_key = app.loadCredKey(gpa, io, cfg.cred_key_path) catch |e| {
            try err.print("Could not read the credential key at {s}: {t}\n", .{ cfg.cred_key_path, e });
            return error.NoCredKey;
        } orelse {
            try err.print(
                \\No credential key at: {s}
                \\Nothing was created. Every stored credential is encrypted with that
                \\key, and generating a fresh one here would invalidate all of them —
                \\so restore it from your backup before running this.
                \\
            , .{cfg.cred_key_path});
            return error.NoCredKey;
        };
    }

    return .{ .loaded = loaded, .db = db, .svc = authsvc.Service.init(gpa, io, db, cred_key) };
}

/// A plain existence test, so it makes no change.
fn exists(io: std.Io, path: []const u8) bool {
    std.Io.Dir.cwd().access(io, path, .{}) catch return false;
    return true;
}

/// Maps an `openExisting` failure to an exit code. The message is already out.
fn openFailure(e: anyerror) !u8 {
    return switch (e) {
        error.NoConfig, error.NoDatabase, error.NoCredKey, error.OpenFailed => exit_failed,
        else => e,
    };
}

// ---- users ---------------------------------------------------------------

/// `inkhold users`: addresses, admin and pending flags, and the admin count.
/// Addresses only, no ids, which belong to the HTTP API.
fn listUsers(
    gpa: std.mem.Allocator,
    io: std.Io,
    inv: Invocation,
    out: *std.Io.Writer,
    err: *std.Io.Writer,
    st: Style,
) !u8 {
    var open = openExisting(gpa, io, inv, false, err, st) catch |e| return openFailure(e);
    defer open.deinit();

    const users = try open.svc.listUsers(gpa);
    defer authsvc.Service.freeUsers(gpa, users);

    if (users.len == 0) {
        try out.writeAll("No accounts.\n");
        return exit_ok;
    }

    var width: usize = 0;
    var admins: usize = 0;
    for (users) |u| {
        width = @max(width, u.email.len);
        if (u.is_admin) admins += 1;
    }

    for (users) |u| {
        try out.writeAll(u.email);
        // Padded only when something follows: no trailing whitespace.
        if (u.is_admin or u.must_change) {
            try out.splatByteAll(' ', width - u.email.len + 2);
            if (u.must_change) {
                if (u.is_admin) {
                    try out.print("{s}admin{s}  ", .{ st.bold, st.reset });
                } else {
                    try out.writeAll("       ");
                }
                // Dim: a pending change is a state, not a warning.
                try out.print("{s}password change pending{s}", .{ st.dim, st.reset });
            } else {
                try out.print("{s}admin{s}", .{ st.bold, st.reset });
            }
        }
        try out.writeAll("\n");
    }

    try out.print("\n{d} account{s}, {d} admin{s}.\n", .{
        users.len,
        if (users.len == 1) "" else "s",
        admins,
        if (admins == 1) "" else "s",
    });

    if (admins <= 1) {
        try out.print(
            \\
            \\{[b]s}Only one administrator.{[r]s} If that password is lost, nobody can be
            \\helped from the admin console. `{[b]s}inkhold users make-admin <user>{[r]s}` gives
            \\the household a second key, and is worth doing now rather than then.
            \\
        , .{ .b = st.bold, .r = st.reset });
    }
    return exit_ok;
}

// ---- reset-password ------------------------------------------------------

/// `inkhold users reset-password <email>`. Calls the mechanism
/// (`Service.resetPasswordFor`), not the admin-checked wrapper: authorisation
/// happened at the filesystem. The plaintext goes to stdout only, never `std.log`.
fn resetPassword(
    gpa: std.mem.Allocator,
    io: std.Io,
    inv: Invocation,
    out: *std.Io.Writer,
    err: *std.Io.Writer,
    st: Style,
) !u8 {
    var open = openExisting(gpa, io, inv, true, err, st) catch |e| return openFailure(e);
    defer open.deinit();

    const id = (try open.svc.userIdByEmail(inv.user)) orelse return noSuchAccount(inv.user, err, st);
    const temp = try open.svc.resetPasswordFor(id);

    // The password itself is unstyled: an escape code surviving a copy makes it
    // silently wrong.
    try out.print(
        \\{[b]s}Temporary password for {[who]s}:{[r]s}
        \\
        \\    {[pw]s}
        \\
        \\Shown once — it is not stored and cannot be shown again. That account is
        \\now signed out everywhere and must choose a new password at its next
        \\sign-in. {[b]s}A running server picks this up on the next request{[r]s}, so there
        \\is no need to stop it.
        \\
    , .{ .b = st.bold, .r = st.reset, .who = inv.user, .pw = temp.slice() });
    return exit_ok;
}

// ---- make-admin ----------------------------------------------------------

/// `inkhold users make-admin <email>`. Idempotent; a repeat is not an error.
fn makeAdmin(
    gpa: std.mem.Allocator,
    io: std.Io,
    inv: Invocation,
    out: *std.Io.Writer,
    err: *std.Io.Writer,
    st: Style,
) !u8 {
    var open = openExisting(gpa, io, inv, false, err, st) catch |e| return openFailure(e);
    defer open.deinit();

    const id = (try open.svc.userIdByEmail(inv.user)) orelse return noSuchAccount(inv.user, err, st);
    if (try open.svc.setAdmin(id, true)) {
        try out.print("{s}{s} is now an administrator.{s}\n", .{ st.bold, inv.user, st.reset });
    } else {
        try out.print("{s} is already an administrator.\n", .{inv.user});
    }
    return exit_ok;
}

fn noSuchAccount(user: []const u8, err: *std.Io.Writer, st: Style) !u8 {
    try err.print(
        \\{[b]s}No account with that address:{[r]s} {[who]s}
        \\Nothing was changed. Run `{[b]s}inkhold users list{[r]s}` to see the addresses
        \\exactly as they are stored.
        \\
    , .{ .b = st.bold, .r = st.reset, .who = user });
    return exit_failed;
}

// ==== tests ===============================================================

const testing = std.testing;

test "bare `inkhold` and an explicit `serve` both serve" {
    // `inkhold config.zon` no longer parses; units must use `--config=`.
    {
        const inv = try parse(&.{});
        try testing.expectEqual(Command.serve, inv.command);
        try testing.expect(inv.config == null);
        try testing.expectEqualStrings("config.zon", inv.configPath());
    }
    {
        const inv = try parse(&.{"serve"});
        try testing.expectEqual(Command.serve, inv.command);
        try testing.expectEqualStrings("config.zon", inv.configPath());
    }
    try testing.expectError(error.MissingOrUnknownSubcommand, parse(&.{"server/8089/serve-run.zon"}));
}

test "--config is an option, and takes either spelling, anywhere" {
    for ([_][]const []const u8{
        &.{ "--config=alt.zon", "users", "list" },
        &.{ "--config", "alt.zon", "users", "list" },
        &.{ "-c", "alt.zon", "users", "list" },
        &.{ "users", "list", "--config=alt.zon" }, // trailing is accepted too
    }) |argv| {
        const inv = try parse(argv);
        try testing.expectEqual(Command.users_list, inv.command);
        try testing.expectEqualStrings("alt.zon", inv.configPath());
    }
    try testing.expectError(error.MissingConfigValue, parse(&.{"--config"}));
    try testing.expectError(error.MissingOrUnknownSubcommand, parse(&.{"users.zon"}));
}

test "`users` is a group: it needs a verb, and the verbs that take an account say so" {
    {
        const inv = try parse(&.{ "users", "list" });
        try testing.expectEqual(Command.users_list, inv.command);
        try testing.expect(inv.config == null);
    }
    {
        const inv = try parse(&.{ "users", "reset-password", "ana@home" });
        try testing.expectEqual(Command.users_reset_password, inv.command);
        try testing.expectEqualStrings("ana@home", inv.user);
    }
    {
        const inv = try parse(&.{ "--config=alt.zon", "users", "make-admin", "rui@home" });
        try testing.expectEqual(Command.users_make_admin, inv.command);
        try testing.expectEqualStrings("rui@home", inv.user);
        try testing.expectEqualStrings("alt.zon", inv.configPath());
    }
    try testing.expectError(error.MissingOrUnknownSubcommand, parse(&.{"users"}));
    try testing.expectError(error.MissingOrUnknownSubcommand, parse(&.{ "users", "wat" }));
    try testing.expectError(error.MissingUser, parse(&.{ "users", "reset-password" }));
    try testing.expectError(error.MissingUser, parse(&.{ "users", "make-admin" }));
    try testing.expectError(error.UnexpectedArgument, parse(&.{ "users", "list", "extra" }));
    try testing.expectError(error.UnknownOption, parse(&.{"--nope"}));
}

test "help and version win wherever they appear" {
    try testing.expectEqual(Command.help, (try parse(&.{"-h"})).command);
    try testing.expectEqual(Command.help, (try parse(&.{"--help"})).command);
    try testing.expectEqual(Command.version, (try parse(&.{"--version"})).command);
    // Even after a command, so `inkhold users --help` explains rather than runs.
    try testing.expectEqual(Command.help, (try parse(&.{ "users", "--help" })).command);
}

test "styling is OFF unless stdout is a terminal, and off whenever NO_COLOR is set" {
    try testing.expectEqualStrings("", Style.choose(false, false).bold);
    try testing.expectEqualStrings("", Style.choose(true, true).bold);
    try testing.expectEqualStrings("", Style.choose(false, true).bold);
    try testing.expect(Style.choose(true, false).bold.len > 0);
    try testing.expectEqualStrings("", Style.plain.reset);
    try testing.expectEqualStrings("", Style.plain.dim);
}

// ---- the fixture: a real database file on disk ----------------------------

/// A temp install on disk (`inkhold.db`, `cred.key`, `inkhold.zon`); a file,
/// because refuse-to-create is about a path.
const Fixture = struct {
    tmp: testing.TmpDir,
    dir_path: []u8,
    config_path: []u8,
    db_path: []u8,

    const cred_key: [passwordmod.cred_key_len]u8 = @splat(0x42);

    fn init(gpa: std.mem.Allocator) !Fixture {
        var tmp = testing.tmpDir(.{});
        errdefer tmp.cleanup();
        // SQLite takes a path, so rebuild `testing.tmpDir`'s.
        const dir_path = try std.fmt.allocPrint(gpa, ".zig-cache/tmp/{s}", .{&tmp.sub_path});
        errdefer gpa.free(dir_path);
        const db_path = try std.fmt.allocPrint(gpa, "{s}/inkhold.db", .{dir_path});
        errdefer gpa.free(db_path);
        const config_path = try std.fmt.allocPrint(gpa, "{s}/inkhold.zon", .{dir_path});
        errdefer gpa.free(config_path);

        try tmp.dir.writeFile(testing.io, .{ .sub_path = "cred.key", .data = &cred_key });
        // Bare names, resolved against the config's own directory.
        const source =
            \\.{ .db_path = "inkhold.db", .cred_key_path = "cred.key", .data_dir = "data" }
        ;
        try tmp.dir.writeFile(testing.io, .{ .sub_path = "inkhold.zon", .data = source });

        return .{ .tmp = tmp, .dir_path = dir_path, .config_path = config_path, .db_path = db_path };
    }

    /// Creates and migrates the database; the caller closes both.
    fn openDb(self: Fixture, gpa: std.mem.Allocator) !struct { sqlite.Db, authsvc.Service } {
        const z = try gpa.dupeSentinel(u8, self.db_path, 0);
        defer gpa.free(z);
        const db = try sqlite.Db.open(z);
        try schema.migrate(db);
        return .{ db, authsvc.Service.init(gpa, testing.io, db, cred_key) };
    }

    fn invocation(self: Fixture, command: Command, user: []const u8) Invocation {
        return .{ .command = command, .config = self.config_path, .user = user };
    }

    fn dbExists(self: Fixture) bool {
        return exists(testing.io, self.db_path);
    }

    fn deinit(self: *Fixture, gpa: std.mem.Allocator) void {
        gpa.free(self.dir_path);
        gpa.free(self.config_path);
        gpa.free(self.db_path);
        self.tmp.cleanup();
    }
};

/// Runs a command with captured stdout/stderr. Caller frees both slices.
const Captured = struct {
    code: u8,
    out: []u8,
    err: []u8,

    fn deinit(self: Captured, gpa: std.mem.Allocator) void {
        gpa.free(self.out);
        gpa.free(self.err);
    }
};

fn capture(gpa: std.mem.Allocator, inv: Invocation) !Captured {
    var out: std.Io.Writer.Allocating = .init(gpa);
    errdefer out.deinit();
    var err: std.Io.Writer.Allocating = .init(gpa);
    errdefer err.deinit();
    const code = try execute(gpa, testing.io, inv, &out.writer, &err.writer, Style.plain);
    var out_list = out.toArrayList();
    errdefer out_list.deinit(gpa);
    var err_list = err.toArrayList();
    errdefer err_list.deinit(gpa);
    return .{
        .code = code,
        .out = try out_list.toOwnedSlice(gpa),
        .err = try err_list.toOwnedSlice(gpa),
    };
}

/// An admin who has not onboarded plus `ana@home` with the known
/// `ana_password` (the generated temp password is unrecoverable).
const ana_password = "anareal0";

fn seed(svc: *authsvc.Service) !struct { admin: u64, ana: u64 } {
    const admin = try svc.bootstrapAdmin("admin@home", "adminpw0");
    const ana = (try svc.createUser(admin, "ana@home", false)).id;
    _ = try svc.changePassword(ana, null, &passwordmod.md5Hex(ana_password));
    return .{ .admin = admin, .ana = ana };
}

/// Logs in as Ana with `password`, returning the session's audience.
fn loginAna(svc: *authsvc.Service, plaintext: []const u8) !authsvc.Session {
    const code = try svc.getRandomCode("ana@home");
    return svc.login("ana@home", &passwordmod.challengeHash(&passwordmod.md5Hex(plaintext), &code), false, null);
}

// ---- the refuse-to-create check ------------------------------------------

test "every recovery verb refuses a database that is not there, and creates nothing" {
    const gpa = testing.allocator;
    var fx = try Fixture.init(gpa);
    defer fx.deinit(gpa);

    try testing.expect(!fx.dbExists());

    for ([_]Command{ .users_list, .users_reset_password, .users_make_admin }) |cmd| {
        const c = try capture(gpa, fx.invocation(cmd, "ana@home"));
        defer c.deinit(gpa);
        try testing.expectEqual(exit_failed, c.code);
        try testing.expect(std.mem.indexOf(u8, c.err, fx.db_path) != null);
        try testing.expect(std.mem.indexOf(u8, c.err, "No database at") != null);
        try testing.expectEqualStrings("", c.out);
        // Nothing was created: without the `exists` guard sqlite3_open makes it.
        try testing.expect(!fx.dbExists());
    }
}

test "an explicit <config> that does not exist is refused rather than defaulted" {
    const gpa = testing.allocator;
    // `loadFileOrDefault` would fall back to defaults and an unrelated cwd database.
    const c = try capture(gpa, .{ .command = .users_list, .config = "no/such/inkhold.zon" });
    defer c.deinit(gpa);
    try testing.expectEqual(exit_failed, c.code);
    try testing.expect(std.mem.indexOf(u8, c.err, "no/such/inkhold.zon") != null);
    try testing.expect(std.mem.indexOf(u8, c.err, "No config file at") != null);
}

// ---- users ---------------------------------------------------------------

test "users lists addresses with the admin and pending-change flags" {
    const gpa = testing.allocator;
    var fx = try Fixture.init(gpa);
    defer fx.deinit(gpa);
    {
        var db, var svc = try fx.openDb(gpa);
        defer db.close();
        defer svc.deinit();
        _ = try seed(&svc);
    }

    const c = try capture(gpa, fx.invocation(.users_list, ""));
    defer c.deinit(gpa);
    try testing.expectEqual(exit_ok, c.code);
    // Style.plain: asserts the words; escapes are tested separately.
    try testing.expectEqualStrings(
        \\admin@home  admin  password change pending
        \\ana@home
        \\
        \\2 accounts, 1 admin.
        \\
        \\Only one administrator. If that password is lost, nobody can be
        \\helped from the admin console. `inkhold users make-admin <user>` gives
        \\the household a second key, and is worth doing now rather than then.
        \\
    , c.out);
}

test "users counts the admins, and stops warning once there are two" {
    const gpa = testing.allocator;
    var fx = try Fixture.init(gpa);
    defer fx.deinit(gpa);
    {
        var db, var svc = try fx.openDb(gpa);
        defer db.close();
        defer svc.deinit();
        const ids = try seed(&svc);
        _ = try svc.setAdmin(ids.ana, true);
    }

    const c = try capture(gpa, fx.invocation(.users_list, ""));
    defer c.deinit(gpa);
    try testing.expectEqual(exit_ok, c.code);
    try testing.expect(std.mem.indexOf(u8, c.out, "2 accounts, 2 admins.") != null);
    try testing.expect(std.mem.indexOf(u8, c.out, "Only one administrator") == null);
}

// ---- reset-password ------------------------------------------------------

test "reset-password prints a working temporary password, once, and revokes sessions" {
    const gpa = testing.allocator;
    var fx = try Fixture.init(gpa);
    defer fx.deinit(gpa);

    var live: authsvc.Session = undefined;
    {
        var db, var svc = try fx.openDb(gpa);
        defer db.close();
        defer svc.deinit();
        _ = try seed(&svc);
        live = try loginAna(&svc, ana_password); // a session that the reset must revoke
    }

    const c = try capture(gpa, fx.invocation(.users_reset_password, "ana@home"));
    defer c.deinit(gpa);
    try testing.expectEqual(exit_ok, c.code);
    try testing.expectEqualStrings("", c.err);

    // Assert through the service with the printed plaintext, so a no-op cannot pass.
    const start = (std.mem.indexOf(u8, c.out, "\n\n    ") orelse return error.NoPasswordPrinted) + 6;
    const end = std.mem.indexOfScalarPos(u8, c.out, start, '\n').?;
    const temp = c.out[start..end];
    try testing.expect(temp.len > 0);

    var db, var svc = try fx.openDb(gpa);
    defer db.close();
    defer svc.deinit();

    try testing.expect((try loginAna(&svc, temp)).audience == .pending);
    try testing.expectError(error.InvalidCredentials, loginAna(&svc, ana_password));
    try testing.expect((try svc.caller(&live.token)) == null);
}

test "reset-password on an unknown address fails clearly and changes nothing" {
    const gpa = testing.allocator;
    var fx = try Fixture.init(gpa);
    defer fx.deinit(gpa);
    {
        var db, var svc = try fx.openDb(gpa);
        defer db.close();
        defer svc.deinit();
        _ = try seed(&svc);
    }

    const c = try capture(gpa, fx.invocation(.users_reset_password, "ana@hom"));
    defer c.deinit(gpa);
    try testing.expectEqual(exit_failed, c.code);
    try testing.expectEqualStrings("", c.out);
    try testing.expect(std.mem.indexOf(u8, c.err, "No account with that address: ana@hom") != null);

    // The near-miss account still logs in, as a full session.
    var db, var svc = try fx.openDb(gpa);
    defer db.close();
    defer svc.deinit();
    try testing.expect((try loginAna(&svc, ana_password)).audience == .controlplane);
}

// ---- make-admin ----------------------------------------------------------

test "make-admin promotes, and promoting an admin again is a no-op not an error" {
    const gpa = testing.allocator;
    var fx = try Fixture.init(gpa);
    defer fx.deinit(gpa);
    var ana_id: u64 = 0;
    {
        var db, var svc = try fx.openDb(gpa);
        defer db.close();
        defer svc.deinit();
        ana_id = (try seed(&svc)).ana;
    }

    {
        const c = try capture(gpa, fx.invocation(.users_make_admin, "ana@home"));
        defer c.deinit(gpa);
        try testing.expectEqual(exit_ok, c.code);
        try testing.expectEqualStrings("ana@home is now an administrator.\n", c.out);
    }
    {
        const c = try capture(gpa, fx.invocation(.users_make_admin, "ana@home"));
        defer c.deinit(gpa);
        try testing.expectEqual(exit_ok, c.code);
        try testing.expectEqualStrings("ana@home is already an administrator.\n", c.out);
    }

    // Asserted by doing an admin-only thing, not by reading the flag.
    var db, var svc = try fx.openDb(gpa);
    defer db.close();
    defer svc.deinit();
    _ = try svc.createUser(ana_id, "rui@home", false);
}

test "make-admin on an unknown address fails clearly" {
    const gpa = testing.allocator;
    var fx = try Fixture.init(gpa);
    defer fx.deinit(gpa);
    {
        var db, var svc = try fx.openDb(gpa);
        defer db.close();
        defer svc.deinit();
        _ = try seed(&svc);
    }
    const c = try capture(gpa, fx.invocation(.users_make_admin, "nobody@home"));
    defer c.deinit(gpa);
    try testing.expectEqual(exit_failed, c.code);
    try testing.expect(std.mem.indexOf(u8, c.err, "No account with that address") != null);
}

// ---- help / version ------------------------------------------------------

test "the escapes are really there under ansi, and really absent under plain" {
    // The only test that looks at the escape codes themselves.
    const gpa = testing.allocator;

    var styled: std.Io.Writer.Allocating = .init(gpa);
    defer styled.deinit();
    try writeHelp(&styled.writer, Style.ansi);
    try testing.expect(std.mem.indexOf(u8, styled.written(), "\x1b[1m") != null);
    try testing.expect(std.mem.indexOf(u8, styled.written(), "\x1b[0m") != null);

    var plain: std.Io.Writer.Allocating = .init(gpa);
    defer plain.deinit();
    try writeHelp(&plain.writer, Style.plain);
    try testing.expect(std.mem.indexOf(u8, plain.written(), "\x1b") == null);

    var stripped: std.ArrayList(u8) = .empty;
    defer stripped.deinit(gpa);
    var i: usize = 0;
    const src = styled.written();
    while (i < src.len) {
        if (src[i] == 0x1b) {
            while (i < src.len and src[i] != 'm') i += 1;
            i += 1;
            continue;
        }
        try stripped.append(gpa, src[i]);
        i += 1;
    }
    try testing.expectEqualStrings(plain.written(), stripped.items);
}

test "help goes to stdout and names every command" {
    const gpa = testing.allocator;
    const c = try capture(gpa, .{ .command = .help });
    defer c.deinit(gpa);
    try testing.expectEqual(exit_ok, c.code);
    for ([_][]const u8{ "users list", "users reset-password", "users make-admin", "--config", "--version" }) |verb| {
        try testing.expect(std.mem.indexOf(u8, c.out, verb) != null);
    }
    // Each phrase must sit on one line, or a re-wrap fails the test.
    try testing.expect(std.mem.indexOf(u8, c.out, "read/write access to the data directory") != null);
    try testing.expect(std.mem.indexOf(u8, c.out, "The database must already exist") != null);
    try testing.expect(std.mem.indexOf(u8, c.out, "Safe to run while the server is up") != null);
}
