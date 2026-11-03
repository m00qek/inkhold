//! Entry point: stdio plumbing and exit code; the CLI grammar is in `cli.zig`.

const std = @import("std");
const config = @import("config.zig");
const transport = @import("http/transport.zig");
const routes = @import("routes.zig");
const cli = @import("cli.zig");

pub fn main(init: std.process.Init) !void {
    const io = init.io;
    const gpa = init.gpa;

    const args = try init.minimal.args.toSlice(init.arena.allocator());

    // The temporary password goes to stdout, never `std.log`; diagnostics to stderr.
    var out_buf: [4096]u8 = undefined;
    var out = std.Io.File.stdout().writerStreaming(io, &out_buf);
    var err_buf: [4096]u8 = undefined;
    var err = std.Io.File.stderr().writerStreaming(io, &err_buf);

    // Styling is off when stdout is not a TTY (output gets pasted into bug reports)
    const tty = std.Io.File.stdout().isTty(io) catch false;
    // or when NO_COLOR is present, whatever its value.
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
    // Aggregates the backend's colocated unit tests.
    _ = config;
    _ = transport;
    _ = @import("app.zig");
    _ = routes;
    _ = cli;
    _ = @import("expiring.zig");
    _ = @import("pdf/probe.zig");
    _ = @import("pdf/text.zig");
    _ = @import("http/router.zig");
    _ = @import("http/static.zig");
    _ = @import("http/json.zig");
    _ = @import("http/ratelimit.zig");
    _ = @import("http/download_tokens.zig");
    _ = @import("http/event_streams.zig");
    _ = @import("http/context.zig");
    _ = @import("http/reply.zig");
    _ = @import("http/multipart.zig");
    _ = @import("http/byte_range.zig");
    _ = @import("db/sqlite.zig");
    _ = @import("db/schema.zig");
    _ = @import("db/reader_pool.zig");
    _ = @import("store/blobs.zig");
    _ = @import("store/blob_source.zig");
    _ = @import("store/thumbs.zig");
    _ = @import("store/derived.zig");
    _ = @import("services/files.zig");
    _ = @import("services/thumbnail.zig");
    _ = @import("services/spd_index.zig");
    _ = @import("services/sync.zig");
    _ = @import("services/controlplane.zig");
    _ = @import("services/settings.zig");
    _ = @import("services/health.zig");
    _ = @import("services/note_index.zig");
    _ = @import("services/search/fuzzy.zig");
    _ = @import("services/search/index_export.zig");
    _ = @import("services/search/want_bitmap.zig");
    _ = @import("services/search/index_stream.zig");
    _ = @import("services/derive_search.zig");
    _ = @import("services/txt_index.zig");
    _ = @import("services/pdf_text.zig");
    _ = @import("services/pending.zig");
    _ = @import("services/auth/password.zig");
    _ = @import("services/auth/service.zig");
    _ = @import("handlers/auth.zig");
    _ = @import("handlers/device.zig");
    _ = @import("handlers/controlplane.zig");
    _ = @import("handlers/admin.zig");
    _ = @import("http/gzip_stitch.zig");
    _ = @import("test/http_integration.zig");
}
