//! Wire-contract fixtures: the JSON the server sends, committed under
//! `webapp/tests/fixtures/wire/`, where `webapp/tests/unit/wireContract.test.ts`
//! checks that the web app's client decides every key. A change to the wire
//! fails here until regenerated: `INK_UPDATE_WIRE_FIXTURES=1 zig build test`.

const std = @import("std");
const testing = std.testing;

const wire_dir = "webapp/tests/fixtures/wire";

/// Set non-empty to write the fixtures instead of comparing.
const wire_update_env = "INK_UPDATE_WIRE_FIXTURES";

/// The handlers' options: null optionals become absent keys.
pub const opts: std.json.Stringify.Options = .{ .emit_null_optional_fields = false };

/// Pinned epoch-ms for wall-clock fields, so fixtures are stable.
pub const time_ms: i64 = 1_700_000_000_000;

/// `std.c` is available because this module links libc.
fn wireUpdating() bool {
    const v = std.c.getenv(wire_update_env) orelse return false;
    return v[0] != 0;
}

/// The repo root, by walking up from the test's unspecified cwd. The marker is
/// `webapp/src/api/client.ts` because nested packages have their own
/// `build.zig.zon`.
fn openRepoRoot() !std.Io.Dir {
    for ([_][]const u8{ ".", "..", "../..", "../../..", "../../../.." }) |rel| {
        var d = std.Io.Dir.cwd().openDir(testing.io, rel, .{}) catch continue;
        if (d.access(testing.io, "webapp/src/api/client.ts", .{})) |_| return d else |_| {}
        d.close(testing.io);
    }
    std.debug.print(
        "\nwire fixtures: could not find the repo root by walking up from the test's cwd\n" ++
            "(looked for webapp/src/api/client.ts). Run the suite as `zig build test` from the repo root.\n",
        .{},
    );
    return error.RepoRootNotFound;
}

/// Compares `vo`'s serialisation with `wire/<name>`, or writes it when updating.
pub fn expectVO(name: []const u8, vo: anytype) !void {
    const json = try std.json.Stringify.valueAlloc(testing.allocator, vo, opts);
    defer testing.allocator.free(json);
    return expect(name, json);
}

/// Compares `json`, a reply's body, with `wire/<name>`, or writes it when updating.
pub fn expect(name: []const u8, json: []const u8) !void {
    const gpa = testing.allocator;

    var root = try openRepoRoot();
    defer root.close(testing.io);

    var path_buf: [256]u8 = undefined;
    const rel = try std.fmt.bufPrint(&path_buf, wire_dir ++ "/{s}", .{name});

    if (wireUpdating()) {
        try root.createDirPath(testing.io, wire_dir);
        return root.writeFile(testing.io, .{ .sub_path = rel, .data = json });
    }

    const have = root.readFileAlloc(testing.io, rel, gpa, .limited(1 << 20)) catch |err| {
        std.debug.print(
            "\nwire fixture {s} could not be read ({t}).\n" ++
                "Regenerate it with: INK_UPDATE_WIRE_FIXTURES=1 zig build test\n",
            .{ rel, err },
        );
        return err;
    };
    defer gpa.free(have);

    if (!std.mem.eql(u8, have, json)) {
        std.debug.print(
            "\nWIRE CONTRACT DRIFT in {s}\n" ++
                "The server no longer produces the committed bytes for this shape. If the\n" ++
                "change is intended, regenerate and read the diff as a wire change:\n" ++
                "    INK_UPDATE_WIRE_FIXTURES=1 zig build test && git diff {s}\n" ++
                "Then update the key table in webapp/tests/unit/wireContract.test.ts, which\n" ++
                "is what decides whether the client consumes the new field.\n",
            .{ rel, rel },
        );
        try testing.expectEqualStrings(have, json);
        return error.WireFixtureMismatch;
    }
}
