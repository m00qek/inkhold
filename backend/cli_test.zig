//! Tests for the CLI: argument parsing and the admin subcommands.

const std = @import("std");
const config = @import("config.zig");
const testing = std.testing;
const cli = @import("cli.zig");
const version = cli.version;
const exit_ok = cli.exit_ok;
const exit_failed = cli.exit_failed;
const Command = cli.Command;
const parse = cli.parse;
const Style = cli.Style;
const writeHelp = cli.writeHelp;
const fixture = @import("cli_test_fixture.zig");
const capture = fixture.capture;

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

test "an explicit <config> that does not exist is refused rather than defaulted" {
    const gpa = testing.allocator;
    // `loadFileOrDefault` would fall back to defaults and an unrelated cwd database.
    const c = try capture(gpa, .{ .command = .users_list, .config = "no/such/inkhold.zon" });
    defer c.deinit(gpa);
    try testing.expectEqual(exit_failed, c.code);
    try testing.expect(std.mem.indexOf(u8, c.err, "no/such/inkhold.zon") != null);
    try testing.expect(std.mem.indexOf(u8, c.err, "No config file at") != null);
}

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
