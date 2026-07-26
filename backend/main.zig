//! Entry point for the Inkhold server.
//!
//!   zig build serve -- [config.zon]
//!
//! Loads config (defaults if the file is absent) and runs the HTTP(S) server.

const std = @import("std");
const config = @import("config.zig");
const transport = @import("http/transport.zig");
const routes = @import("routes.zig");

pub fn main(init: std.process.Init) !void {
    const io = init.io;
    const gpa = init.gpa;

    const args = try init.minimal.args.toSlice(init.arena.allocator());
    const config_path = if (args.len > 1) args[1] else "config.zon";

    var loaded = try config.loadFileOrDefault(gpa, io, config_path);
    defer loaded.deinit();

    // Composition root: wire the application's routes into the transport.
    try transport.run(gpa, io, loaded.config, &routes.routes);
}

test {
    // Aggregate the backend's unit tests (rooted here so http/ can import ../config).
    // Every file is referenced so its colocated tests run.
    _ = config;
    _ = transport;
    _ = routes;
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
