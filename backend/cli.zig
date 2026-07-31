//! The command line: `serve` plus the three recovery verbs.
//!
//! See docs/scratch/cli-recovery.md. The short version: a single-admin install
//! that loses its one password has no way back in over HTTP — there is nobody
//! left to issue a reset. These verbs are authorised by READ/WRITE ACCESS TO THE
//! DATA DIRECTORY, which on a self-hosted server is proof of ownership and is
//! strictly weaker than what the holder of `minicloud.db` + `cred.key` can
//! already do with `sqlite3`. The CLI does not open a door; it puts a handle on
//! a door that has no wall around it.
//!
//! Two rules shape everything here:
//!
//!   1. **Nothing but `serve` may create a database.** `sqlite3_open` creates on
//!      open (see `db/sqlite.zig`), so a mistyped `<config>` would otherwise
//!      migrate a brand-new empty file and report that your own account does not
//!      exist — at the exact moment somebody already fears they have lost their
//!      server. `openExisting` refuses first and names the path it tried.
//!   2. **The config is an OPTION, and `users` is a noun group.** The grammar is
//!      `inkhold [--config=<config>] users <verb> [<user>]`. Naming the config
//!      means the parser never has to decide whether `users` is a command or a
//!      file called users, and `users reset-password` says what it acts on where
//!      a bare `reset-password` could be read as the SERVER's password.
//!
//!      This REPLACED `inkhold [serve] [<config>]`, so `inkhold config.zon` no
//!      longer parses — deliberately, since nothing can keep that positional
//!      alongside `--config` without restoring the ambiguity it removes.

const std = @import("std");
const build_options = @import("build_options");
const config = @import("config.zig");
const transport = @import("http/transport.zig");
const routes = @import("routes.zig");
const sqlite = @import("db/sqlite.zig");
const schema = @import("db/schema.zig");
const authsvc = @import("services/auth/service.zig");
const passwordmod = @import("services/auth/password.zig");

/// The package version (`build.zig.zon`), surfaced by `--version`.
pub const version = build_options.version;

/// What `<config>` defaults to when none is given — the same string `main` used
/// before there were subcommands, so `inkhold` bare is unchanged.
pub const default_config = "config.zon";

/// Process exit codes. `usage` is separated from `failed` so a script can tell
/// "you typed it wrong" from "the thing you asked for did not work".
pub const exit_ok: u8 = 0;
pub const exit_failed: u8 = 1;
pub const exit_usage: u8 = 2;

pub const Command = enum { serve, users_list, users_reset_password, users_make_admin, help, version };

/// One parsed command line.
pub const Invocation = struct {
    command: Command,
    /// The `<config>` positional, or null when it was omitted. Kept OPTIONAL
    /// rather than defaulted here because the two cases differ: an explicit path
    /// that does not exist is a typo and is refused, while a missing default is
    /// the ordinary "no config file, use the defaults" case that `serve` has
    /// always supported.
    config: ?[]const u8 = null,
    /// The `<user>` positional for the account verbs; "" for the others. It is
    /// matched against the address, but it is named for the ACCOUNT rather than
    /// for how the account happens to be spelled today.
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

/// Parses `args` (argv WITHOUT the program name).
///
/// The grammar is `inkhold [--config=<config>] <group> <verb> [<user>]`. Two
/// deliberate shapes:
///
///   * **`--config` is an OPTION, not a positional.** It used to be the trailing
///     positional, which forced the grammar to resolve "is `users` a command or
///     a file called users?" by rule. Naming it never asks the question. It also
///     puts the default where a reader looks for one — `[default: config.zon]`
///     in `Options:` — which a positional cannot carry.
///   * **`users` is a NOUN GROUP with sub-verbs**, not three flat verbs. A bare
///     `reset-password` reads as though it might reset the SERVER's password;
///     `users reset-password` says what it acts on. It is also the only shape
///     that leaves room for a second group without renaming anything.
///
/// The cost, accepted deliberately: `inkhold config.zon` no longer parses.
/// Nothing can rescue that positional alongside `--config` without bringing back
/// the ambiguity the option removes.
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

/// The help text, verbatim from docs/scratch/cli-recovery.md §3. The Recovery
/// and Notes paragraphs are not padding: this is read by somebody who cannot
/// sign in, and the two facts they need are that filesystem access is the
/// authorisation and that nothing here will ever create a database.
/// ANSI styling, decided once and threaded through as strings.
///
/// **Every field is EMPTY when styling is off**, so call sites interpolate
/// unconditionally and there is no second, unstyled copy of any message to drift.
///
/// Off unless stdout is a terminal, and off when `NO_COLOR` is set at all (the
/// informal standard: presence, not value). That matters more here than for most
/// tools — this output gets pasted into bug reports and issue threads by somebody
/// who could not sign in, and escape codes in a paste are noise at exactly the
/// moment clarity is worth most. Piping to a file or `less` is the common case,
/// not the exotic one.
///
/// BOLD AND DIM ONLY, no colour. The app dresses as paper and ink; a rainbow
/// terminal would be the one surface that does not.
pub const Style = struct {
    bold: []const u8 = "",
    dim: []const u8 = "",
    reset: []const u8 = "",

    pub const plain: Style = .{};
    pub const ansi: Style = .{ .bold = "\x1b[1m", .dim = "\x1b[2m", .reset = "\x1b[0m" };

    /// `NO_COLOR` honoured by PRESENCE, and `tty` decided by the caller (which
    /// is the only place that knows which stream this is going to).
    pub fn choose(tty: bool, no_color_set: bool) Style {
        return if (tty and !no_color_set) ansi else plain;
    }
};

/// The help text. The Recovery and Notes paragraphs are not padding: this is
/// read by somebody who cannot sign in, and the facts they need are that
/// filesystem access is the authorisation, that nothing here will ever create a
/// database, and that they do NOT have to stop the server first — which is the
/// riskiest thing a person in that state can decide to do unaided.
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


/// Parse + dispatch. Returns the process exit code; `serve` does not return.
///
/// `out` is stdout and `err` is stderr, passed in rather than reached for, so
/// the tests below drive the real commands against a buffer and assert on what a
/// person would actually see.
pub fn run(
    gpa: std.mem.Allocator,
    io: std.Io,
    args: []const []const u8,
    out: *std.Io.Writer,
    err: *std.Io.Writer,
) !u8 {
    return runStyled(gpa, io, args, out, err, Style.plain);
}

/// `run`, with the styling decided by the caller. `main` chooses from the real
/// stdout; the tests call this with `Style.plain` so an assertion never has to
/// know about escape codes, and once with `Style.ansi` to prove they appear.
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
    return executeStyled(gpa, io, inv, out, err, st);
}

pub fn execute(
    gpa: std.mem.Allocator,
    io: std.Io,
    inv: Invocation,
    out: *std.Io.Writer,
    err: *std.Io.Writer,
) !u8 {
    return executeStyled(gpa, io, inv, out, err, Style.plain);
}

pub fn executeStyled(
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
            // Unchanged from the days when this was the only thing `main` did:
            // the config file may be ABSENT (defaults), and the database is
            // CREATED if it is not there. First run is a real case.
            var loaded = try config.loadFileOrDefault(gpa, io, inv.configPath());
            defer loaded.deinit();
            try transport.run(gpa, io, loaded.config, &routes.routes);
            return exit_ok;
        },
        .users_list => return listUsers(gpa, io, inv, out, err, st),
        .users_reset_password => return resetPassword(gpa, io, inv, out, err, st),
        .users_make_admin => return makeAdmin(gpa, io, inv, out, err, st),
    }
}

// ---- opening an EXISTING install ----------------------------------------

/// A database and the service over it, plus the config arena that owns the
/// paths. Everything a recovery verb needs, and nothing it may create.
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

/// Opens the install named by `<config>` — **refusing to create anything.**
///
/// THIS IS THE MOST IMPORTANT FUNCTION IN THE FILE. `sqlite3_open` creates the
/// database when it is absent, so without the `access` check below a mistyped
/// config path would produce an empty database, migrate it, and answer "no such
/// account" for the very account the person is trying to recover. The failure
/// mode of a recovery tool must not look like the catastrophe it is used to
/// avert, so the check comes BEFORE the open and the message names the path.
///
/// The same reasoning covers two neighbours:
///   - an EXPLICIT `<config>` that does not exist is a typo and is refused. (An
///     omitted one still falls back to defaults, exactly as `serve` does.)
///   - a missing `cred.key` is never generated here. `serve` generates one on
///     first run, which is right for a fresh install and catastrophic for an
///     existing one: a fresh key silently invalidates every stored credential,
///     so `reset-password` would "succeed" and lock out the whole household.
///     `need_cred_key` is false for the read-only verbs, which do not touch
///     credentials and must stay usable for diagnosis even then.
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
        // THE MESSAGE THIS WHOLE TOOL IS JUDGED BY. It is read by somebody who
        // already fears they have lost their server, so it leads with the fact
        // that nothing was touched and names both the path and the file the path
        // came from — the second being what actually gets them unstuck when the
        // answer is "you pointed at the wrong config".
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

    const db_path = try gpa.dupeZ(u8, cfg.db_path);
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

    // Zeroes when the verb does not need it — nothing on a non-credential path
    // reads `cred_key`, and handing it a real key it has no use for would be the
    // larger mistake.
    var cred_key: [passwordmod.cred_key_len]u8 = @splat(0);
    if (need_cred_key) {
        cred_key = transport.loadCredKey(gpa, io, cfg.cred_key_path) catch |e| {
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

/// Whether `path` names something that is already there. Deliberately a plain
/// existence test and not "open it and see": the point is to make no change.
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

/// `inkhold users` — the diagnosis. Address, admin flag, pending-change flag,
/// and the count that actually matters: how many admins are there?
///
/// **Addresses only, no ids** (cli-recovery.md open question 2). The address is
/// what a person knows and what every other verb here takes; the id is what the
/// admin HTTP API takes, and printing both invites the wrong one to be typed
/// into the wrong tool.
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
        // Padded only when something follows, so no line carries trailing
        // whitespace into somebody's terminal or paste buffer.
        if (u.is_admin or u.must_change) {
            try out.splatByteAll(' ', width - u.email.len + 2);
            if (u.must_change) {
                if (u.is_admin) {
                    try out.print("{s}admin{s}  ", .{ st.bold, st.reset });
                } else {
                    try out.writeAll("       ");
                }
                // Dim, because it is a STATE rather than a problem: a pending
                // change is the normal condition of an account that was just
                // reset, and colouring it like a warning would make the one line
                // that IS a warning below read as more of the same.
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

    // The whole reason this command exists. Said here rather than left for the
    // reader to count, because a person runs `users` when something is already
    // wrong and the cure is one line away.
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

/// `inkhold reset-password <email>` — the verb the whole feature exists for.
///
/// Calls the MECHANISM (`Service.resetPasswordFor`), not the admin-checked
/// policy wrapper: there is no actor here, and that is the point. The
/// authorisation already happened, at the filesystem.
///
/// The plaintext goes to STDOUT and nowhere else — never through `std.log`,
/// which a server operator may well be piping to a file.
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

    // THE PASSWORD ITSELF IS UNSTYLED, deliberately. It is the one string on
    // screen that will be selected and retyped — into a phone, across a room,
    // onto a tablet keyboard — and a stray escape code that survives a copy is a
    // password that does not work for a reason nobody can see. Bold the label
    // around it instead, which is what the eye needs to find it anyway.
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

/// `inkhold make-admin <email>` — the cure for the CAUSE rather than the
/// instance. Idempotent: promoting an existing admin says so and is not an
/// error, because a person who is unsure whether it worked will run it twice.
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
        // Not bold: nothing happened, and a message that shouts about a no-op
        // teaches people to stop reading the ones that do not.
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
    // THE REGRESSION THAT WOULD SHOW UP AS SOMEBODY'S SERVER NOT COMING BACK UP.
    // Note what is NOT here any more: `inkhold config.zon`. The trailing
    // positional was dropped when `--config` arrived, deliberately — nothing can
    // keep both without bringing back the ambiguity the option exists to remove.
    // A unit file that passed the config positionally must gain `--config=`.
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
    // A bare path is no longer a config file — it is an unknown command, and
    // saying so is better than silently serving the wrong install.
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
    // A file called `users` can no longer be mistaken for the command, and the
    // command can no longer be mistaken for a file. The question is gone.
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
    // This output gets pasted into bug reports by somebody who could not sign
    // in. Escape codes in a paste are noise exactly when clarity is worth most,
    // and piping to a file or `less` is the common case rather than the exotic
    // one. NO_COLOR is honoured by PRESENCE, per the informal standard.
    try testing.expectEqualStrings("", Style.choose(false, false).bold);
    try testing.expectEqualStrings("", Style.choose(true, true).bold);
    try testing.expectEqualStrings("", Style.choose(false, true).bold);
    try testing.expect(Style.choose(true, false).bold.len > 0);
    // Plain must be EMPTY strings rather than absent, so call sites interpolate
    // unconditionally and no message exists in two versions that can drift.
    try testing.expectEqualStrings("", Style.plain.reset);
    try testing.expectEqualStrings("", Style.plain.dim);
}

// ---- the fixture: a real database file on disk ----------------------------

/// A temp directory holding `inkhold.db` + `cred.key` + `inkhold.zon`, i.e. an
/// install as the CLI will find one. A FILE, not `:memory:`, because the whole
/// refuse-to-create behaviour is about a path on disk.
const Fixture = struct {
    tmp: testing.TmpDir,
    dir_path: []u8,
    config_path: []u8,
    db_path: []u8,

    const cred_key: [passwordmod.cred_key_len]u8 = @splat(0x42);

    fn init(gpa: std.mem.Allocator) !Fixture {
        var tmp = testing.tmpDir(.{});
        errdefer tmp.cleanup();
        // `testing.tmpDir` lives at `.zig-cache/tmp/<sub_path>` relative to the
        // test process's cwd, and SQLite takes a path rather than a directory
        // handle — so reconstruct it.
        const dir_path = try std.fmt.allocPrint(gpa, ".zig-cache/tmp/{s}", .{&tmp.sub_path});
        errdefer gpa.free(dir_path);
        const db_path = try std.fmt.allocPrint(gpa, "{s}/inkhold.db", .{dir_path});
        errdefer gpa.free(db_path);
        const config_path = try std.fmt.allocPrint(gpa, "{s}/inkhold.zon", .{dir_path});
        errdefer gpa.free(config_path);

        try tmp.dir.writeFile(testing.io, .{ .sub_path = "cred.key", .data = &cred_key });
        // BARE NAMES, relative to the config's own directory — which is what
        // `config.rebase` now resolves them against, and which is how a real
        // install's config should be written so that pointing `-c` at it means
        // the same install from anywhere. This used to spell out paths relative
        // to the TEST's cwd, the very pattern that let one config name two
        // different databases.
        const source =
            \\.{ .db_path = "inkhold.db", .cred_key_path = "cred.key", .data_dir = "data" }
        ;
        try tmp.dir.writeFile(testing.io, .{ .sub_path = "inkhold.zon", .data = source });

        return .{ .tmp = tmp, .dir_path = dir_path, .config_path = config_path, .db_path = db_path };
    }

    /// Creates and migrates the database, and hands back a service over it. The
    /// caller closes both.
    fn openDb(self: Fixture, gpa: std.mem.Allocator) !struct { sqlite.Db, authsvc.Service } {
        const z = try gpa.dupeZ(u8, self.db_path);
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
    const code = try execute(gpa, testing.io, inv, &out.writer, &err.writer);
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

/// An admin who has not onboarded plus `ana@home`, whose password is the known
/// `ana_password` (so a test can assert her credential is untouched — the temp
/// one `createUser` generated is deliberately unrecoverable from the database).
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

    // Deliberately NOT created: this is the mistyped-<config> case.
    try testing.expect(!fx.dbExists());

    for ([_]Command{ .users_list, .users_reset_password, .users_make_admin }) |cmd| {
        const c = try capture(gpa, fx.invocation(cmd, "ana@home"));
        defer c.deinit(gpa);
        try testing.expectEqual(exit_failed, c.code);
        // The message NAMES THE PATH IT TRIED — the one thing a panicking person
        // needs in order to see that they pointed it somewhere wrong.
        try testing.expect(std.mem.indexOf(u8, c.err, fx.db_path) != null);
        try testing.expect(std.mem.indexOf(u8, c.err, "No database at") != null);
        try testing.expectEqualStrings("", c.out);
        // THE DURABLE FACT, not a transient one: nothing was created. Remove the
        // `exists` guard in `openExisting` and sqlite3_open makes the file here.
        try testing.expect(!fx.dbExists());
    }
}

test "an explicit <config> that does not exist is refused rather than defaulted" {
    const gpa = testing.allocator;
    // A config path that is a typo. `loadFileOrDefault` would silently fall back
    // to the DEFAULTS, whose `db_path` is "inkhold.db" in the cwd — so without
    // this guard the tool would go and look at (or create) an unrelated database.
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
        // `seed` leaves Ana onboarded and the admin still owing a change.
        _ = try seed(&svc);
    }

    const c = try capture(gpa, fx.invocation(.users_list, ""));
    defer c.deinit(gpa);
    try testing.expectEqual(exit_ok, c.code);
    // Captured through `execute`, i.e. Style.plain — so this asserts the WORDS,
    // with every style field an empty string. A separate test proves the escapes
    // appear under Style.ansi; keeping them apart means a wording change is
    // never obscured by escape codes in the diff.
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

    // Pull the printed plaintext back out of stdout: everything on the indented
    // line. Asserting THROUGH the service with it is what makes a no-op that
    // returns success impossible to pass with.
    const start = (std.mem.indexOf(u8, c.out, "\n\n    ") orelse return error.NoPasswordPrinted) + 6;
    const end = std.mem.indexOfScalarPos(u8, c.out, start, '\n').?;
    const temp = c.out[start..end];
    try testing.expect(temp.len > 0);

    var db, var svc = try fx.openDb(gpa);
    defer db.close();
    defer svc.deinit();

    // The printed one works — and lands as `pending`, i.e. `must_change_password`
    // really is set, so the temporary secret unlocks nothing but its replacement.
    try testing.expect((try loginAna(&svc, temp)).audience == .pending);
    // The old one does not.
    try testing.expectError(error.InvalidCredentials, loginAna(&svc, ana_password));
    // And every session that account held is gone.
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

    // The near-miss account is untouched — asserted through the service: her real
    // password still logs in, and still as a FULL session rather than `pending`,
    // so no stray must-change flag was set on the way past either.
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

    // Asserted through the service, not by reading the flag back: Ana can now do
    // an admin-only thing she could not do before.
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
    // The pair matters. Every other output test runs through `Style.plain` and
    // asserts WORDS, so a wording change is never buried in escape codes; this
    // one is the only place that looks at the codes themselves, so "styling
    // silently stopped happening" cannot pass unnoticed either.
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

    // And the WORDS are identical either way — the styling must not be able to
    // change what the help says, only how it looks.
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
    // The three facts a person in trouble needs from it. Asserted as phrases that
    // sit on ONE line: an earlier version looked for "refuses to create one",
    // which a re-wrap split across a line break, and the test then failed for
    // prose reflowing rather than for the fact going missing.
    try testing.expect(std.mem.indexOf(u8, c.out, "read/write access to the data directory") != null);
    try testing.expect(std.mem.indexOf(u8, c.out, "The database must already exist") != null);
    try testing.expect(std.mem.indexOf(u8, c.out, "Safe to run while the server is up") != null);
}
