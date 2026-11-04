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

const cli_recovery = @import("cli/recovery.zig");
const cli_backup = @import("cli/backup.zig");
const listUsers = cli_recovery.listUsers;
const resetPassword = cli_recovery.resetPassword;
const makeAdmin = cli_recovery.makeAdmin;

/// The package version (`build.zig.zon`), surfaced by `--version`.
pub const version = build_options.version;

/// Default `<config>`.
pub const default_config = "config.zon";

/// `usage` (typed it wrong) is distinct from `failed` (it did not work).
pub const exit_ok: u8 = 0;
pub const exit_failed: u8 = 1;
pub const exit_usage: u8 = 2;

pub const Command = enum {
    serve,
    users_list,
    users_reset_password,
    users_make_admin,
    backup_create,
    backup_list,
    backup_verify,
    backup_prune,
    restore,
    help,
    version,
};

/// The options `backup` and `restore` take; which apply is per verb (`allowed`).
pub const BackupFlags = struct {
    keep: ?u32 = null,
    include_cred_key: bool = false,
    no_compress: bool = false,
    /// Bytes per second; 0 is unlimited.
    max_rate: ?u64 = null,
    deep: bool = false,

    const Which = enum { keep, include_cred_key, no_compress, max_rate, deep };

    fn has(self: BackupFlags, w: Which) bool {
        return switch (w) {
            .keep => self.keep != null,
            .include_cred_key => self.include_cred_key,
            .no_compress => self.no_compress,
            .max_rate => self.max_rate != null,
            .deep => self.deep,
        };
    }

    /// Refuses a flag the verb does not take: a silently ignored `--keep` on
    /// `verify` would read as a prune that never happened.
    fn allowed(self: BackupFlags, ok: []const Which) ParseError!void {
        for (std.enums.values(Which)) |w| {
            if (self.has(w) and std.mem.indexOfScalar(Which, ok, w) == null) return error.OptionNotForCommand;
        }
    }
};

pub const Invocation = struct {
    command: Command,
    /// Null when omitted: an explicit missing path is a typo and refused, a
    /// missing default means "use defaults".
    config: ?[]const u8 = null,
    /// The `<user>` for the account verbs, matched against the address.
    user: []const u8 = "",
    /// The `<dir>` of `backup` and `restore`, and the optional `<snapshot>`.
    backup_dir: []const u8 = "",
    snapshot: ?[]const u8 = null,
    flags: BackupFlags = .{},

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
    /// `backup <verb>` / `restore` with no `<dir>`.
    MissingBackupDir,
    /// `backup prune` without `--keep`.
    MissingKeep,
    /// `--keep=x`, `--max-rate=fast`, or an option with no value.
    BadOptionValue,
    /// A backup option on a verb that does not take it.
    OptionNotForCommand,
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
        if (std.mem.eql(u8, a, "--include-cred-key")) {
            inv.flags.include_cred_key = true;
            continue;
        }
        if (std.mem.eql(u8, a, "--no-compress")) {
            inv.flags.no_compress = true;
            continue;
        }
        if (std.mem.eql(u8, a, "--deep")) {
            inv.flags.deep = true;
            continue;
        }
        if (valued(args, &i, "--keep")) |v| {
            const keep = std.fmt.parseInt(u32, v orelse return error.BadOptionValue, 10) catch return error.BadOptionValue;
            if (keep == 0) return error.BadOptionValue;
            inv.flags.keep = keep;
            continue;
        }
        if (valued(args, &i, "--max-rate")) |v| {
            inv.flags.max_rate = parseRate(v orelse return error.BadOptionValue) orelse return error.BadOptionValue;
            continue;
        }
        if (a.len > 0 and a[0] == '-') return error.UnknownOption;
        if (n == rest.len) return error.UnexpectedArgument;
        rest[n] = a;
        n += 1;
    }

    const words = rest[0..n];
    const backup_verb = words.len > 0 and (std.mem.eql(u8, words[0], "backup") or std.mem.eql(u8, words[0], "restore"));
    if (!backup_verb) try inv.flags.allowed(&.{});
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
    if (std.mem.eql(u8, words[0], "backup")) {
        if (words.len < 2) return error.MissingOrUnknownSubcommand;
        const verb = words[1];
        const W = BackupFlags.Which;
        if (std.mem.eql(u8, verb, "create")) {
            inv.command = .backup_create;
            try inv.flags.allowed(&.{ W.keep, W.include_cred_key, W.no_compress, W.max_rate });
        } else if (std.mem.eql(u8, verb, "list")) {
            inv.command = .backup_list;
            try inv.flags.allowed(&.{});
        } else if (std.mem.eql(u8, verb, "verify")) {
            inv.command = .backup_verify;
            try inv.flags.allowed(&.{ W.deep, W.max_rate });
        } else if (std.mem.eql(u8, verb, "prune")) {
            inv.command = .backup_prune;
            try inv.flags.allowed(&.{W.keep});
            if (inv.flags.keep == null) return error.MissingKeep;
        } else return error.MissingOrUnknownSubcommand;
        if (words.len < 3) return error.MissingBackupDir;
        inv.backup_dir = words[2];
        const takes_snapshot = inv.command == .backup_verify;
        if (words.len > (if (takes_snapshot) @as(usize, 4) else 3)) return error.UnexpectedArgument;
        if (words.len == 4) inv.snapshot = words[3];
        return inv;
    }
    if (std.mem.eql(u8, words[0], "restore")) {
        inv.command = .restore;
        try inv.flags.allowed(&.{BackupFlags.Which.max_rate});
        if (words.len < 2) return error.MissingBackupDir;
        if (words.len > 3) return error.UnexpectedArgument;
        inv.backup_dir = words[1];
        if (words.len == 3) inv.snapshot = words[2];
        return inv;
    }
    return error.MissingOrUnknownSubcommand;
}

/// `--name=value` or `--name value`: null when `args[i.*]` is not `name`,
/// `.{null}` (a missing value) when it is but nothing follows.
fn valued(args: []const []const u8, i: *usize, comptime name: []const u8) ??[]const u8 {
    const a = args[i.*];
    if (std.mem.startsWith(u8, a, name ++ "=")) return a[name.len + 1 ..];
    if (!std.mem.eql(u8, a, name)) return null;
    i.* += 1;
    if (i.* >= args.len) return @as(?[]const u8, null);
    return args[i.*];
}

/// `4M`, `512K`, `1G` (binary multiples, an optional trailing `B` or `/s`
/// tolerated) or a plain byte count; `0` is unlimited.
pub fn parseRate(text: []const u8) ?u64 {
    var t = text;
    if (std.mem.endsWith(u8, t, "/s")) t = t[0 .. t.len - 2];
    if (std.mem.endsWith(u8, t, "B") or std.mem.endsWith(u8, t, "b")) t = t[0 .. t.len - 1];
    if (t.len == 0) return null;
    const mult: u64 = switch (std.ascii.toUpper(t[t.len - 1])) {
        'K' => 1 << 10,
        'M' => 1 << 20,
        'G' => 1 << 30,
        else => 1,
    };
    if (mult != 1) t = t[0 .. t.len - 1];
    const n = std.fmt.parseInt(u64, t, 10) catch return null;
    return std.math.mul(u64, n, mult) catch null;
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
        \\  inkhold [--config=<config>] backup create <dir> [--keep=<n>] [--include-cred-key]
        \\                              [--no-compress] [--max-rate=<rate>]
        \\  inkhold [--config=<config>] backup list <dir>
        \\  inkhold [--config=<config>] backup verify <dir> [<snapshot>] [--deep]
        \\  inkhold [--config=<config>] backup prune <dir> --keep=<n>
        \\  inkhold [--config=<config>] restore <dir> [<snapshot>]
        \\  inkhold (-h | --help)
        \\  inkhold --version
        \\
        \\{[b]s}Arguments:{[r]s}
        \\  {[b]s}<user>{[r]s}            Account to act on, exactly as `inkhold users list`
        \\                    prints it.
        \\  {[b]s}<dir>{[r]s}             A backup directory. It must already exist: on a Pi a
        \\                    missing one is usually an unmounted NAS.
        \\  {[b]s}<snapshot>{[r]s}        One snapshot in it, as `backup list` names it; the
        \\                    newest when omitted.
        \\
        \\{[b]s}Options:{[r]s}
        \\  {[b]s}-c --config=<config>{[r]s}   Config file to read {[d]s}[default: config.zon]{[r]s}.
        \\  {[b]s}-h --help{[r]s}              Show this message and exit.
        \\  {[b]s}--version{[r]s}              Print the version and exit.
        \\  {[b]s}--keep=<n>{[r]s}             Keep the newest <n> snapshots; remove the rest and
        \\                         every file only they needed.
        \\  {[b]s}--include-cred-key{[r]s}     Put cred.key in the snapshot too {[d]s}[default: no]{[r]s}.
        \\  {[b]s}--no-compress{[r]s}          Store every file as it is, not gzipped.
        \\  {[b]s}--max-rate=<rate>{[r]s}      Read at most this fast, e.g. 4M or 512K; 0 is
        \\                         unlimited {[d]s}[default: 4M for backup, 0 for restore]{[r]s}.
        \\  {[b]s}--deep{[r]s}                 Also re-read every file and check the database
        \\                         page by page.
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
        \\  {[b]s}backup create{[r]s}               Snapshot this install into <dir>, beside a
        \\                              running server. Only what is new is copied.
        \\  {[b]s}backup list{[r]s}                 The snapshots in <dir>, oldest first.
        \\  {[b]s}backup verify{[r]s}               Check that each snapshot can be restored.
        \\  {[b]s}backup prune{[r]s}                Keep the newest snapshots; free the rest.
        \\  {[b]s}restore{[r]s}                     Put a snapshot back onto a fresh install,
        \\                              with the server stopped.
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
        \\{[b]s}Backups:{[r]s}
        \\  A backup directory holds plain files, safe to keep on a NAS share, a USB
        \\  disk or in a Dropbox folder: copying tools carry it intact, and each run
        \\  adds only what changed. Nothing in it is encrypted, so keep it as private
        \\  as your notes. cred.key is left out unless asked for: without it a restore
        \\  still returns every note, and every account gets a temporary password.
        \\  To run one nightly, see the README.
        \\
        \\  {[b]s}Before restoring, back up each tablet.{[r]s} A restore signs every tablet
        \\  out; one that syncs against the older server may delete files it holds
        \\  that the snapshot does not.
        \\
        \\{[b]s}Notes:{[r]s}
        \\  The database must already exist. Every command except `serve` and `restore`
        \\  refuses to create one and prints the path it tried — a mistyped --config
        \\  would otherwise open an empty database and report that your own account
        \\  does not exist, at the worst possible moment. `restore` is the opposite: it
        \\  refuses to run where a database already exists.
        \\
        \\  {[b]s}Safe to run while the server is up{[r]s}, all but `restore`: a reset takes
        \\  effect on the next request, and a backup runs beside it at low priority.
        \\
        \\  Temporary passwords are printed to stdout and never written to a log.
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
            error.MissingBackupDir => try err.writeAll("That command needs a backup directory: inkhold backup <verb> <dir>\n"),
            error.MissingKeep => try err.writeAll("`backup prune` needs --keep=<n>: how many snapshots to keep.\n"),
            error.BadOptionValue => try err.writeAll("That option needs a value: --keep=<n> takes a number from 1, --max-rate=<rate> a size such as 4M.\n"),
            error.OptionNotForCommand => try err.writeAll("That option does not apply to this command.\n"),
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
        .backup_create => return cli_backup.create(gpa, io, inv, out, err, st),
        .backup_list => return cli_backup.list(gpa, io, inv, out, err, st),
        .backup_verify => return cli_backup.verify(gpa, io, inv, out, err, st),
        .backup_prune => return cli_backup.prune(gpa, io, inv, out, err, st),
        .restore => return cli_backup.restore(gpa, io, inv, out, err, st),
    }
}

test {
    _ = cli_recovery;
    _ = cli_backup;
    _ = @import("cli/cli_test.zig");
}
