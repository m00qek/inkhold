//! Static file serving for the built web SPA (the browser UI — control-plane
//! Face 2 — plus the SPA assets themselves).
//!
//! This runs only as a fallback: the router tries the API route table first and
//! only calls in here when **no API route matched** (GET only). So API routes
//! always win — `/note/:id/page/:n` is a route and is dispatched; a bare
//! `/note-decode.wasm` is a single unmatched segment and falls through to here.
//!
//! The SPA uses hash routing (`#/…`), so there is deliberately **no SPA
//! fallback**: we serve `/` → `index.html` and each real file by its path;
//! anything else 404s. Files are streamed (never buffered whole), and any path
//! that could escape `web_dir` is refused before a file is ever opened.

const std = @import("std");
const context = @import("context.zig");
const router = @import("router.zig");

const Context = context.Context;
const Request = router.Request;

/// Try to serve `req` as a static file from `ctx.config.web_dir`.
///
/// Returns `true` when the request was handled here (a response was sent — 200,
/// 404, or 403). Returns `false` when static serving does not apply (no
/// `web_dir` configured, or a non-GET method), so the caller falls through to
/// its own not-found.
pub fn serve(ctx: *Context, req: *Request) !bool {
    const web_dir = ctx.config.web_dir;
    if (web_dir.len == 0) return false; // static serving disabled
    if (req.head.method != .GET) return false;

    const rel = relPath(router.stripQuery(req.head.target));

    // SECURITY: never let a request read outside web_dir. Reject any `..`
    // segment or NUL before we build a path or open anything.
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
    if (st.kind != .file) { // a directory (or other) is not servable
        try req.respond("not found\n", .{ .status = .not_found });
        return true;
    }

    // Negotiate a precompressed variant. The base file was found above (so 404 /
    // 403 semantics are unchanged); here we only try to UPGRADE to a smaller,
    // build-time sibling (`<file>.br` / `<file>.gz`, see scripts/precompress.mjs)
    // when the client accepts that coding. The RPi does zero compression at
    // request time — it just streams the right pre-made file.
    //
    // Accept-Encoding lives in the request-head buffer; we don't read a body in
    // static serving, but copying is cheap and keeps the value obviously valid.
    var enc_buf: [256]u8 = undefined;
    const accept_encoding = router.headerCopy(req, "accept-encoding", &enc_buf);

    // The file we'll actually stream and how to label it. Defaults: the raw file
    // opened above, no Content-Encoding.
    var stream_file = file;
    var stream_size = st.size;
    var content_encoding: ?[]const u8 = null;
    var variant_file: ?std.Io.File = null; // an opened sibling to close, if any

    // Server preference order is fixed (br beats gzip beats raw) — we do NOT rank
    // the client's q-values, just honor an explicit `q=0` that disables a coding.
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

    // Content-Type by extension, plus a cache policy that has to be stated for
    // BOTH halves of the fingerprinting scheme, not just the fingerprinted half.
    //
    //   /assets/*  carry a content hash in the filename, so they are immutable:
    //              a new build is a new URL and can never collide.
    //   index.html is the one file whose URL never changes, and it is what
    //              POINTS AT the current hashed bundle. Sending it with no
    //              cache-control and no validator left browsers to heuristic
    //              freshness — so a rebuilt app could keep loading the OLD
    //              bundle until someone cleared site data by hand, which is
    //              exactly what happened. `no-cache` still allows caching; it
    //              requires revalidation, so the shell is one conditional
    //              request rather than a stale copy of unknown age.
    //
    // Content-Type and cache-control are keyed off the BASE path (`rel`), never
    // the `.br`/`.gz` suffix, so a variant is labeled as the asset it encodes.
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

    // A client abort mid-stream (navigating away while the bundle loads) returns,
    // closing the connection short of `content_length` — the truncation signal —
    // rather than falling through to `body.end()`, which asserts the full length was
    // written and would panic ("reached unreachable code") in a safe build.
    // `stream_size` is the real size of whichever file we stream, so a full stream
    // lands exactly on `content_length` and reaches `end()`; see the page route
    // (`controlplanePage`) for the full why.
    var rbuf: [64 * 1024]u8 = undefined;
    var fr = stream_file.reader(ctx.io, &rbuf);
    _ = fr.interface.streamRemaining(&body.writer) catch return error.StreamTruncated;
    body.end() catch {};
    return true;
}

/// True if the coding `enc` (e.g. `"br"`) is acceptable per an `Accept-Encoding`
/// header value: its token is present AND not explicitly disabled with `;q=0`.
///
/// A deliberately simple token scan — we split on commas, take each element's
/// coding token (up to the first `;`), match it case-insensitively, and reject
/// only when a `q=0` parameter turns it off. We do NOT rank q-values into a
/// preference order; the caller's preference (br > gzip > raw) is fixed. Honoring
/// `q=0` is the one bit of q-parsing that matters — it's how a client says "not
/// this coding" (e.g. `br;q=0, gzip`).
fn encodingAccepted(accept_encoding: []const u8, enc: []const u8) bool {
    var it = std.mem.splitScalar(u8, accept_encoding, ',');
    while (it.next()) |raw_elem| {
        var parts = std.mem.splitScalar(u8, std.mem.trim(u8, raw_elem, " \t"), ';');
        const token = std.mem.trim(u8, parts.next() orelse continue, " \t");
        if (!std.ascii.eqlIgnoreCase(token, enc)) continue;
        // Token matches. Honor an explicit q=0 (the only q-value we act on).
        while (parts.next()) |raw_param| {
            const param = std.mem.trim(u8, raw_param, " \t");
            if (param.len >= 2 and std.ascii.eqlIgnoreCase(param[0..2], "q=") and qIsZero(param[2..]))
                return false;
        }
        return true;
    }
    return false;
}

/// True if a `q` parameter value is zero (`0`, `0.0`, `0.000`, …). Unparseable
/// values are treated as non-zero, i.e. the coding stays acceptable.
fn qIsZero(v: []const u8) bool {
    const q = std.fmt.parseFloat(f32, std.mem.trim(u8, v, " \t")) catch return false;
    return q == 0;
}

/// Maps a request path to a path relative to `web_dir`. `/` and any all-slashes
/// path become `index.html`; otherwise the leading slash(es) are stripped
/// (`/index.html` → `index.html`, `/assets/x.js` → `assets/x.js`).
fn relPath(raw: []const u8) []const u8 {
    const trimmed = std.mem.trimStart(u8, raw, "/");
    return if (trimmed.len == 0) "index.html" else trimmed;
}

/// True if `rel` cannot escape `web_dir`: no `..` segment, no NUL byte. `rel` is
/// already slash-stripped (relative), so an absolute escape is impossible.
fn isSafeRel(rel: []const u8) bool {
    if (rel.len == 0) return false;
    if (std.mem.indexOfScalar(u8, rel, 0) != null) return false;
    var it = std.mem.splitScalar(u8, rel, '/');
    while (it.next()) |seg| {
        if (std.mem.eql(u8, seg, "..")) return false;
    }
    return true;
}

/// The file extension of `path` including the dot (e.g. `.wasm`), or `""`.
fn extOf(path: []const u8) []const u8 {
    const dot = std.mem.lastIndexOfScalar(u8, path, '.') orelse return "";
    // A dot in an earlier segment (e.g. `dir.v1/file`) is not an extension.
    if (std.mem.indexOfScalarPos(u8, path, dot, '/') != null) return "";
    return path[dot..];
}

/// Content-Type for a file path, by extension. `.wasm` → application/wasm is
/// important: the browser renderer prefers instantiateStreaming, which requires it.
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
    // Present -> accepted (case-insensitive, whitespace-tolerant).
    try std.testing.expect(acc("gzip, deflate, br", "br"));
    try std.testing.expect(acc("gzip, deflate, br", "gzip"));
    try std.testing.expect(acc("br", "br"));
    try std.testing.expect(acc("  BR  ", "br"));
    try std.testing.expect(acc("gzip;q=1.0, br;q=0.5", "br"));
    // Absent -> not accepted; empty header -> nothing accepted.
    try std.testing.expect(!acc("gzip, deflate", "br"));
    try std.testing.expect(!acc("", "br"));
    try std.testing.expect(!acc("identity", "gzip"));
    // q=0 (and its spellings) explicitly DISABLE a coding, even when present.
    try std.testing.expect(!acc("br;q=0, gzip", "br"));
    try std.testing.expect(acc("br;q=0, gzip", "gzip"));
    try std.testing.expect(!acc("gzip;q=0.000", "gzip"));
    try std.testing.expect(!acc("br; q=0", "br"));
    // A non-zero / unparseable q keeps the coding acceptable.
    try std.testing.expect(acc("br;q=0.001", "br"));
    try std.testing.expect(acc("br;q=bogus", "br"));
    // A token that only appears as a SUBSTRING of another coding is not a match.
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
