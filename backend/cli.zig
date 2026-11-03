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

const cli_recovery = @import("cli_recovery.zig");
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

test {
    _ = cli_recovery;
}
