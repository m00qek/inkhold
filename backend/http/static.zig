//! Static file serving for the built SPA, reached only when no API route
//! matched. Hash routing, so no SPA fallback: unknown paths 404.

const std = @import("std");
const context = @import("context.zig");
const router = @import("router.zig");

const Context = context.Context;
const Request = router.Request;

/// Serves `req` from `ctx.config.web_dir`. False when static serving doesn't
/// apply (no `web_dir`, non-GET), so the caller answers not-found.
pub fn serve(ctx: *Context, req: *Request) !bool {
    const web_dir = ctx.config.web_dir;
    if (web_dir.len == 0) return false;
    if (req.head.method != .GET) return false;

    const rel = relPath(router.stripQuery(req.head.target));

    // Refuse any `..` segment or NUL before building a path.
    if (!isSafeRel(rel)) {
        try req.respond("forbidden\n", .{ .status = .forbidden });
        return true;
    }

    var path_buf: [1024]u8 = undefined;
    const full = std.fmt.bufPrint(&path_buf, "{s}/{s}", .{ web_dir, rel }) catch {
        try req.respond("not found\n", .{ .status = .not_found });
        return true;
    };

    var file = std.Io.Dir.cwd().openFile(ctx.io, full, .{}) catch {
        try req.respond("not found\n", .{ .status = .not_found });
        return true;
    };
    defer file.close(ctx.io);

    const st = file.stat(ctx.io) catch {
        try req.respond("not found\n", .{ .status = .not_found });
        return true;
    };
    if (st.kind != .file) {
        try req.respond("not found\n", .{ .status = .not_found });
        return true;
    }

    // Upgrade to a build-time `.br`/`.gz` sibling when the client accepts it;
    // nothing is compressed at request time.
    var enc_buf: [256]u8 = undefined;
    const accept_encoding = router.headerCopy(req, "accept-encoding", &enc_buf);

    var stream_file = file;
    var stream_size = st.size;
    var content_encoding: ?[]const u8 = null;
    var variant_file: ?std.Io.File = null;

    // Fixed preference br > gzip > raw; only an explicit `q=0` is honored.
    const prefs = [_]struct { enc: []const u8, suffix: []const u8 }{
        .{ .enc = "br", .suffix = ".br" },
        .{ .enc = "gzip", .suffix = ".gz" },
    };
    for (prefs) |p| {
        if (!encodingAccepted(accept_encoding, p.enc)) continue;
        var vpath_buf: [1024]u8 = undefined;
        const vpath = std.fmt.bufPrint(&vpath_buf, "{s}{s}", .{ full, p.suffix }) catch continue;
        var vf = std.Io.Dir.cwd().openFile(ctx.io, vpath, .{}) catch continue;
        const vst = vf.stat(ctx.io) catch {
            vf.close(ctx.io);
            continue;
        };
        if (vst.kind != .file) {
            vf.close(ctx.io);
            continue;
        }
        variant_file = vf;
        stream_file = vf;
        stream_size = vst.size;
        content_encoding = p.enc;
        break;
    }
    defer if (variant_file) |*vf| vf.close(ctx.io);

    // Hashed `/assets/*` are immutable. `index.html` must be `no-cache`: it
    // points at the current bundle, and without a validator browsers kept
    // loading a stale one after a rebuild. Both headers key off the base path.
    var headers: [4]std.http.Header = undefined;
    var nh: usize = 0;
    headers[nh] = .{ .name = "content-type", .value = contentType(rel) };
    nh += 1;
    headers[nh] = if (std.mem.startsWith(u8, rel, "assets/"))
        .{ .name = "cache-control", .value = "public, max-age=31536000, immutable" }
    else
        .{ .name = "cache-control", .value = "no-cache" };
    nh += 1;
    if (content_encoding) |ce| {
        headers[nh] = .{ .name = "content-encoding", .value = ce };
        nh += 1;
        headers[nh] = .{ .name = "vary", .value = "Accept-Encoding" };
        nh += 1;
    }

    var wbuf: [64 * 1024]u8 = undefined;
    var body = req.respondStreaming(&wbuf, .{
        .content_length = stream_size,
        .respond_options = .{ .extra_headers = headers[0..nh] },
    }) catch return true;

    // A client abort must return (closing short of `content_length`), not reach
    // `body.end()`, which asserts the full length and panics in safe builds.
    var rbuf: [64 * 1024]u8 = undefined;
    var fr = stream_file.reader(ctx.io, &rbuf);
    _ = fr.interface.streamRemaining(&body.writer) catch return error.StreamTruncated;
    body.end() catch {};
    return true;
}

/// True if `Accept-Encoding` lists `enc` without `;q=0`.
fn encodingAccepted(accept_encoding: []const u8, enc: []const u8) bool {
    var it = std.mem.splitScalar(u8, accept_encoding, ',');
    while (it.next()) |raw_elem| {
        var parts = std.mem.splitScalar(u8, std.mem.trim(u8, raw_elem, " \t"), ';');
        const token = std.mem.trim(u8, parts.next() orelse continue, " \t");
        if (!std.ascii.eqlIgnoreCase(token, enc)) continue;
        while (parts.next()) |raw_param| {
            const param = std.mem.trim(u8, raw_param, " \t");
            if (param.len >= 2 and std.ascii.eqlIgnoreCase(param[0..2], "q=") and qIsZero(param[2..]))
                return false;
        }
        return true;
    }
    return false;
}

/// Unparseable `q` values count as non-zero.
fn qIsZero(v: []const u8) bool {
    const q = std.fmt.parseFloat(f32, std.mem.trim(u8, v, " \t")) catch return false;
    return q == 0;
}

/// `/` → `index.html`; otherwise leading slashes are stripped.
fn relPath(raw: []const u8) []const u8 {
    const trimmed = std.mem.trimStart(u8, raw, "/");
    return if (trimmed.len == 0) "index.html" else trimmed;
}

/// True if `rel` (already relative) has no `..` segment and no NUL.
fn isSafeRel(rel: []const u8) bool {
    if (rel.len == 0) return false;
    if (std.mem.indexOfScalar(u8, rel, 0) != null) return false;
    var it = std.mem.splitScalar(u8, rel, '/');
    while (it.next()) |seg| {
        if (std.mem.eql(u8, seg, "..")) return false;
    }
    return true;
}

fn extOf(path: []const u8) []const u8 {
    const dot = std.mem.lastIndexOfScalar(u8, path, '.') orelse return "";
    // A dot in an earlier segment (e.g. `dir.v1/file`) is not an extension.
    if (std.mem.indexOfScalarPos(u8, path, dot, '/') != null) return "";
    return path[dot..];
}

/// `.wasm` must be `application/wasm` for `instantiateStreaming`.
fn contentType(path: []const u8) []const u8 {
    const ext = extOf(path);
    const eq = std.ascii.eqlIgnoreCase;
    if (eq(ext, ".html") or eq(ext, ".htm")) return "text/html; charset=utf-8";
    if (eq(ext, ".js") or eq(ext, ".mjs")) return "text/javascript";
    if (eq(ext, ".css")) return "text/css; charset=utf-8";
    if (eq(ext, ".wasm")) return "application/wasm";
    if (eq(ext, ".json") or eq(ext, ".map")) return "application/json";
    if (eq(ext, ".svg")) return "image/svg+xml";
    if (eq(ext, ".png")) return "image/png";
    if (eq(ext, ".jpg") or eq(ext, ".jpeg")) return "image/jpeg";
    if (eq(ext, ".webp")) return "image/webp";
    if (eq(ext, ".gif")) return "image/gif";
    if (eq(ext, ".ico")) return "image/x-icon";
    if (eq(ext, ".woff2")) return "font/woff2";
    if (eq(ext, ".woff")) return "font/woff";
    if (eq(ext, ".ttf")) return "font/ttf";
    if (eq(ext, ".txt")) return "text/plain; charset=utf-8";
    return "application/octet-stream";
}

test "relPath maps root and strips leading slashes" {
    try std.testing.expectEqualStrings("index.html", relPath("/"));
    try std.testing.expectEqualStrings("index.html", relPath("//"));
    try std.testing.expectEqualStrings("index.html", relPath("/index.html"));
    try std.testing.expectEqualStrings("assets/x.js", relPath("/assets/x.js"));
    try std.testing.expectEqualStrings("note-decode.wasm", relPath("/note-decode.wasm"));
}

test "isSafeRel rejects traversal and accepts real paths" {
    try std.testing.expect(isSafeRel("index.html"));
    try std.testing.expect(isSafeRel("assets/index-abc123.js"));
    try std.testing.expect(!isSafeRel("../secret"));
    try std.testing.expect(!isSafeRel("assets/../../etc/passwd"));
    try std.testing.expect(!isSafeRel(".."));
    try std.testing.expect(!isSafeRel("a\x00b"));
}

test "encodingAccepted: token scan, whitespace, case, and q=0" {
    const acc = encodingAccepted;
    try std.testing.expect(acc("gzip, deflate, br", "br"));
    try std.testing.expect(acc("gzip, deflate, br", "gzip"));
    try std.testing.expect(acc("br", "br"));
    try std.testing.expect(acc("  BR  ", "br"));
    try std.testing.expect(acc("gzip;q=1.0, br;q=0.5", "br"));
    try std.testing.expect(!acc("gzip, deflate", "br"));
    try std.testing.expect(!acc("", "br"));
    try std.testing.expect(!acc("identity", "gzip"));
    try std.testing.expect(!acc("br;q=0, gzip", "br"));
    try std.testing.expect(acc("br;q=0, gzip", "gzip"));
    try std.testing.expect(!acc("gzip;q=0.000", "gzip"));
    try std.testing.expect(!acc("br; q=0", "br"));
    try std.testing.expect(acc("br;q=0.001", "br"));
    try std.testing.expect(acc("br;q=bogus", "br"));
    try std.testing.expect(!acc("x-gzip", "gzip"));
}

test "contentType by extension" {
    const eq = std.testing.expectEqualStrings;
    try eq("text/html; charset=utf-8", contentType("index.html"));
    try eq("text/javascript", contentType("assets/index-abc.js"));
    try eq("text/css; charset=utf-8", contentType("assets/index-abc.css"));
    try eq("application/wasm", contentType("note-decode.wasm"));
    try eq("application/json", contentType("assets/index-abc.js.map"));
    try eq("image/svg+xml", contentType("logo.svg"));
    try eq("application/octet-stream", contentType("noext"));
    try eq("application/octet-stream", contentType("dir.v1/noext"));
}
