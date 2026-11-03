//! The recovery verbs: users, reset-password and make-admin against an existing install.

const std = @import("std");
const config = @import("config.zig");
const app = @import("app.zig");
const sqlite = @import("db/sqlite.zig");
const schema = @import("db/schema.zig");
const authsvc = @import("services/auth/service.zig");
const passwordmod = @import("services/auth/password.zig");
const cli = @import("cli.zig");
const Command = cli.Command;
const Invocation = cli.Invocation;
const Style = cli.Style;
const exit_failed = cli.exit_failed;
const exit_ok = cli.exit_ok;

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
pub fn listUsers(
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
pub fn resetPassword(
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
pub fn makeAdmin(
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

test {
    _ = @import("cli_test.zig");
}

// ---- tests of private helpers ----

const fixture = @import("cli_test_fixture.zig");

const capture = fixture.capture;

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
