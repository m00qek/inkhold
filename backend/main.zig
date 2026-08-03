//! Entry point for Inkhold.
//!
//!   zig build serve -- [--config=config.zon]
//!
//! Everything past argv lives in `cli.zig`: the grammar is
//! `inkhold [--config=<config>] [serve]` plus the `users` recovery group.
//! `inkhold` bare still serves; `inkhold config.zon` no longer parses, because
//! the config became an option. This file is only the stdio plumbing, the exit
//! code, and the one decision that needs the real streams — whether to style.

const std = @import("std");
const config = @import("config.zig");
const transport = @import("http/transport.zig");
const routes = @import("routes.zig");
const cli = @import("cli.zig");

pub fn main(init: std.process.Init) !void {
    const io = init.io;
    const gpa = init.gpa;

    const args = try init.minimal.args.toSlice(init.arena.allocator());

    // The one-time temporary password goes to STDOUT (never through `std.log`,
    // which an operator may well be piping to a file); diagnostics go to stderr.
    var out_buf: [4096]u8 = undefined;
    var out = std.Io.File.stdout().writerStreaming(io, &out_buf);
    var err_buf: [4096]u8 = undefined;
    var err = std.Io.File.stderr().writerStreaming(io, &err_buf);

    // STYLING IS DECIDED HERE because this is the only place that can see the
    // real streams. Off when stdout is not a terminal — this output is pasted
    // into bug reports by people who could not sign in, and escape codes in a
    // paste are noise exactly when clarity matters most — and off whenever
    // NO_COLOR is set at all, by presence rather than value.
    const tty = std.Io.File.stdout().isTty(io) catch false;
    // PRESENCE, not value — `NO_COLOR=0` still means no colour, per the informal
    // standard that tools converged on.
    const no_color = init.environ_map.get("NO_COLOR") != null;
    const st = cli.Style.choose(tty, no_color);

    const code = cli.runStyled(gpa, io, args[1..], &out.interface, &err.interface, st) catch |e| {
        out.interface.flush() catch {};
        err.interface.flush() catch {};
        return e;
    };
    try out.interface.flush();
    try err.interface.flush();
    if (code != 0) std.process.exit(code);
}

test {
    // Aggregate the backend's unit tests (rooted here so http/ can import ../config).
    // Every file is referenced so its colocated tests run.
    _ = config;
    _ = transport;
    _ = @import("app.zig");
    _ = routes;
    _ = cli;
    _ = @import("expiring.zig");
    _ = @import("http/router.zig");
    _ = @import("http/static.zig");
    _ = @import("http/json.zig");
    _ = @import("http/ratelimit.zig");
    _ = @import("http/download_tokens.zig");
    _ = @import("http/event_streams.zig");
    _ = @import("http/context.zig");
    _ = @import("http/reply.zig");
    _ = @import("http/multipart.zig");
    _ = @import("db/sqlite.zig");
    _ = @import("db/schema.zig");
    _ = @import("store/blobs.zig");
    _ = @import("store/blob_source.zig");
    _ = @import("store/thumbs.zig");
    _ = @import("services/files.zig");
    _ = @import("services/thumbnail.zig");
    _ = @import("services/spd_index.zig");
    _ = @import("services/sync.zig");
    _ = @import("services/controlplane.zig");
    _ = @import("services/settings.zig");
    _ = @import("services/health.zig");
    _ = @import("services/note_index.zig");
    _ = @import("services/search/query.zig");
    _ = @import("services/search/maintain.zig");
    _ = @import("services/search/fuzzy.zig");
    _ = @import("services/txt_index.zig");
    _ = @import("services/search_partition.zig");
    _ = @import("services/auth/password.zig");
    _ = @import("services/auth/service.zig");
    _ = @import("handlers/auth.zig");
    _ = @import("handlers/device.zig");
    _ = @import("handlers/controlplane.zig");
    _ = @import("handlers/admin.zig");
    _ = @import("test/http_integration.zig");
}
