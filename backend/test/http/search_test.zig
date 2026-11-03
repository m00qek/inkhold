//! The stitched search-index stream and the per-document text route.

const std = @import("std");
const repeat = @import("../../repeat.zig").repeat;
const app = @import("../../routes.zig");
const transport = @import("../../http/transport.zig");
const password = @import("../../services/auth/password.zig");
const context = @import("../../http/context.zig");
const Context = context.Context;
const gpa = std.testing.allocator;
const harness = @import("harness.zig");
const buildRequest = harness.buildRequest;
const roundtrip = harness.roundtrip;
const onboardWeb = harness.onboardWeb;
const Fixture = harness.Fixture;
const soleHistoryMd5 = harness.soleHistoryMd5;
const deviceLogin = harness.deviceLogin;
const seedRecognizedNote = harness.seedRecognizedNote;
const headerValue = harness.headerValue;
const requestWithCookie = harness.requestWithCookie;
const expectStatusWithCookie = harness.expectStatusWithCookie;
const listed = harness.listed;
const expectHeaderAbsentSubstring = harness.expectHeaderAbsentSubstring;
const expectHeaderContains = harness.expectHeaderContains;

/// A `files` row's blob md5 as lowercase hex.
fn fileMd5(f: *Fixture, id: u64) ![32]u8 {
    var s = try f.db.prepare("SELECT md5 FROM files WHERE id = ?1;");
    defer s.finalize();
    s.bindInt(1, @intCast(id));
    _ = try s.step();
    var out: [32]u8 = undefined;
    @memcpy(&out, s.columnText(0)[0..32]);
    return out;
}

/// Decodes a chunked body; the stream route sends no `Content-Length`, since
/// skipped fragments make the length unknowable up front.
fn dechunk(a: std.mem.Allocator, raw: []const u8) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    var rest = raw;
    while (true) {
        const eol = std.mem.indexOf(u8, rest, "\r\n") orelse return error.BadChunking;
        const semi = std.mem.indexOfScalar(u8, rest[0..eol], ';') orelse eol;
        const n = try std.fmt.parseInt(usize, rest[0..semi], 16);
        rest = rest[eol + 2 ..];
        if (n == 0) break;
        if (rest.len < n + 2) return error.BadChunking;
        try out.appendSlice(a, rest[0..n]);
        rest = rest[n + 2 ..];
    }
    return out.items;
}

/// Inflates a stitched body as a browser would and checks: exactly one gzip
/// member (by the full 10-byte header; 3-byte magic collides in deflate
/// output), the whole payload decodes, and the trailer matches.
/// `std.compress.flate.Decompress` never verifies the gzip CRC, so it is
/// checked here.
fn inflateStitched(a: std.mem.Allocator, body: []const u8) ![]u8 {
    const gzip_stitch = @import("../../http/gzip_stitch.zig");
    try std.testing.expectEqual(@as(usize, 1), std.mem.count(u8, body, gzip_stitch.header));

    var input: std.Io.Reader = .fixed(body);
    var window: [std.compress.flate.max_window_len]u8 = undefined;
    var d = std.compress.flate.Decompress.init(&input, .gzip, &window);
    var got: std.Io.Writer.Allocating = .init(a);
    _ = try d.reader.streamRemaining(&got.writer);

    try std.testing.expectEqual(std.hash.Crc32.hash(got.written()), d.container_metadata.gzip.crc);
    try std.testing.expectEqual(@as(u32, @intCast(got.written().len)), d.container_metadata.gzip.count);
    return got.written();
}

/// The uncompressed size from a stored fragment's 12-byte header, the number
/// the serve path feeds into the gzip trailer.
fn storedPlainLen(store: @import("../../store/derived.zig").DerivedStore, md5: []const u8) !u32 {
    const derivedstore = @import("../../store/derived.zig");
    const derivesearch = @import("../../services/derive_search.zig");
    var file = try store.open(md5, derivesearch.index_version);
    defer file.close(std.testing.io);
    const h = try derivedstore.readHeader(std.testing.io, file);
    return h.len;
}

/// Wires both derived stores into a fixture; without them every manifest row
/// would be skipped and the test would assert nothing.
fn withDerivedStores(f: *Fixture) !void {
    const derivedstore = @import("../../store/derived.zig");
    const io = std.testing.io;
    const terms_dir = try f.tmp.dir.createDirPathOpen(io, "terms", .{});
    const text_dir = try f.tmp.dir.createDirPathOpen(io, "text", .{});
    f.files.terms = try derivedstore.DerivedStore.init(io, terms_dir);
    f.files.text = try derivedstore.DerivedStore.init(io, text_dir);
}

test "the search-index stream is ONE gzip member carrying every document, not a concatenation" {
    const derivesearch = @import("../../services/derive_search.zig");
    const f = try Fixture.init();
    defer f.deinit();
    try withDerivedStores(f);
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");

    var obuf: [65536]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    var pbuf: [512]u8 = undefined;
    const web_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    const a = arena.allocator();

    // Eight documents, each with a unique term: the bug is a ratio.
    const words = [_][]const u8{
        "trimestral", "orcamento",  "reuniao",  "acta",
        "relatorio",  "manutencao", "projecto", "arquivo",
    };
    var md5s: [words.len][32]u8 = undefined;
    for (words, 0..) |w, i| {
        const name = try std.fmt.allocPrint(a, "doc{d}.note", .{i});
        const id = try seedRecognizedNote(f, admin, name, &.{w});
        md5s[i] = try fileMd5(f, id);
    }

    // Unlink one fragment: a missing file mid-walk (GC race) is skipped, since
    // an error mid-stream poisons the whole stitched gzip.
    const gone = 5;
    f.files.terms.?.remove(&md5s[gone], derivesearch.index_version);

    var etag_buf: [64]u8 = undefined;
    var etag: []const u8 = "";
    var rows: u32 = 0;
    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/controlplane/search-index/manifest", &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        rows = std.mem.readInt(u32, resp.body[5..9], .little);
        try std.testing.expectEqual(@as(u32, words.len), rows);
        etag = try headerValue(resp.head, "etag", &etag_buf);
    }
    try std.testing.expectEqual(@as(usize, 34), etag.len);
    const etag_hex = etag[1 .. etag.len - 1];

    var want_buf: [64]u8 = undefined;
    const want_all = wantEveryPosition(&want_buf, rows);

    const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/search-index/stream?m={s}&want={s}", .{ etag_hex, want_all });
    const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
    try std.testing.expectEqual(@as(u16, 200), resp.status);

    // `content-encoding: gzip` regardless of `Accept-Encoding`: fragments only
    // exist compressed.
    try expectHeaderContains(resp.head, "content-encoding: gzip");
    try expectHeaderContains(resp.head, "content-type: application/x-ndjson");
    try expectHeaderContains(resp.head, "cache-control: private, no-store");
    try expectHeaderAbsentSubstring(resp.head, "content-length:");

    const body = try dechunk(a, resp.body);
    const plain = try inflateStitched(a, body);

    // Every record opens with `{"md5":"…`; seven, the unlinked one skipped.
    try std.testing.expectEqual(@as(usize, words.len - 1), std.mem.count(u8, plain, "{\"md5\":\""));

    // Decoded byte count from the stored headers catches a dropped fragment.
    var expected_bytes: u64 = 0;
    for (md5s, 0..) |md5, i| {
        if (i == gone) continue;
        expected_bytes += try storedPlainLen(f.files.terms.?, &md5);
    }
    try std.testing.expectEqual(expected_bytes, plain.len);

    // Each md5 and term exactly once; the unlinked one nowhere.
    for (md5s, words, 0..) |md5, word, i| {
        if (i == gone) {
            try std.testing.expectEqual(@as(usize, 0), std.mem.count(u8, plain, &md5));
            try std.testing.expect(std.mem.indexOf(u8, plain, word) == null);
            continue;
        }
        try std.testing.expectEqual(@as(usize, 1), std.mem.count(u8, plain, &md5));
        try std.testing.expect(std.mem.indexOf(u8, plain, word) != null);
    }

    // Each position singly: the manifest orders by `updated_at DESC, id`, so
    // seeding across a second boundary reorders it.
    {
        var served: usize = 0;
        var skipped: usize = 0;
        var pos: u32 = 0;
        while (pos < rows) : (pos += 1) {
            var bits = @as([8]u8, @splat(0));
            bits[pos >> 3] = @as(u8, 1) << @intCast(pos & 7);
            var b64: [16]u8 = undefined;
            const enc = std.base64.url_safe_no_pad.Encoder;
            const want_one = enc.encode(&b64, bits[0 .. (rows + 7) / 8]);

            const one = try std.fmt.bufPrint(&pbuf, "/api/controlplane/search-index/stream?m={s}&want={s}", .{ etag_hex, want_one });
            const r = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", one, &web_tok, "");
            try std.testing.expectEqual(@as(u16, 200), r.status);
            const p = try inflateStitched(a, try dechunk(a, r.body));
            switch (std.mem.count(u8, p, "{\"md5\":\"")) {
                0 => skipped += 1,
                1 => served += 1,
                else => return error.TestUnexpectedResult, // one bit, one document
            }
        }
        try std.testing.expectEqual(words.len - 1, served);
        try std.testing.expectEqual(@as(usize, 1), skipped);
    }

    {
        const none = try std.fmt.bufPrint(&pbuf, "/api/controlplane/search-index/stream?m={s}&want=", .{etag_hex});
        const r = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", none, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), r.status);
        try std.testing.expectEqualStrings("", try inflateStitched(a, try dechunk(a, r.body)));
    }
}

/// All `n` positions set, base64url like `webapp/src/search/wantBitmap.ts`.
/// Bits past `n` must stay clear (a set one is a 412).
fn wantEveryPosition(buf: []u8, n: u32) []const u8 {
    var bits: [64]u8 = @splat(0);
    for (0..n) |i| bits[i >> 3] |= @as(u8, 1) << @intCast(i & 7);
    return std.base64.url_safe_no_pad.Encoder.encode(buf, bits[0 .. (n + 7) / 8]);
}

test "the search-index stream refuses a bitmap it cannot trust: 412 on the manifest, 400 on the encoding" {
    const f = try Fixture.init();
    defer f.deinit();
    try withDerivedStores(f);
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");

    var obuf: [65536]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    var pbuf: [512]u8 = undefined;
    const web_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    _ = try seedRecognizedNote(f, admin, "a.note", &.{"trimestral"});
    const doomed = try seedRecognizedNote(f, admin, "b.note", &.{"orcamento"});

    var etag_buf: [64]u8 = undefined;
    var etag: []const u8 = "";
    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/controlplane/search-index/manifest", &web_tok, "");
        etag = try headerValue(resp.head, "etag", &etag_buf);
    }
    var hex_buf: [32]u8 = undefined;
    @memcpy(&hex_buf, etag[1 .. etag.len - 1]);
    const etag_hex: []const u8 = &hex_buf;

    {
        const req = try buildRequest(&reqbuf, "GET", "/api/controlplane/search-index/stream?m=x&want=AQ", &.{}, "");
        const resp = try roundtrip(ctx, req, &obuf);
        try std.testing.expectEqual(@as(u16, 401), resp.status);
    }
    {
        const bob = (try f.svc.createUser(admin, "bob", false)).id;
        _ = try f.svc.changePassword(bob, null, &password.md5Hex("bpass111"));
        const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "bob", "bpass111", "SN9");
        const req = try buildRequest(&reqbuf, "GET", "/api/controlplane/search-index/stream?m=x&want=AQ", &.{
            .{ .name = "x-access-token", .value = &dev_tok },
        }, "");
        const resp = try roundtrip(ctx, req, &obuf);
        try std.testing.expectEqual(@as(u16, 403), resp.status);
    }

    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/controlplane/search-index/stream?want=AQ", &web_tok, "", 400);

    // A wrong `m=` is 412 before the bitmap is parsed (this `want` would be a 400).
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/controlplane/search-index/stream?m=" ++ repeat(u8, "0", 32) ++ "&want=+A", &web_tok, "", 412);

    // Trashing a document moves the manifest, so the old ETag stops answering.
    {
        const stale = try std.fmt.bufPrint(&pbuf, "/api/controlplane/search-index/stream?m={s}&want=Aw", .{etag_hex});
        try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", stale, &web_tok, "", 200);
        try f.files.trash(admin, doomed);
        try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", stale, &web_tok, "", 412);
    }

    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/controlplane/search-index/manifest", &web_tok, "");
        etag = try headerValue(resp.head, "etag", &etag_buf);
        @memcpy(&hex_buf, etag[1 .. etag.len - 1]);
    }
    // Malformed encodings are 400: refetching the manifest would not help.
    for ([_][]const u8{ "+A", "/A", "A", "AB" }) |bad| {
        const p = try std.fmt.bufPrint(&pbuf, "/api/controlplane/search-index/stream?m={s}&want={s}", .{ etag_hex, bad });
        try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", p, &web_tok, "", 400);
    }
    // Too long, or a bit past the end: 412, the two sides disagree on ordering.
    for ([_][]const u8{ "AAAA", "_g" }) |bad| {
        const p = try std.fmt.bufPrint(&pbuf, "/api/controlplane/search-index/stream?m={s}&want={s}", .{ etag_hex, bad });
        try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", p, &web_tok, "", 412);
    }
}

test "the search-index stream is scoped to the caller: a housemate's documents are not in it" {
    const f = try Fixture.init();
    defer f.deinit();
    try withDerivedStores(f);
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");

    var obuf: [65536]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    var pbuf: [512]u8 = undefined;
    const web_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    const a = arena.allocator();

    const bob = (try f.svc.createUser(admin, "bob", false)).id;
    _ = try f.svc.changePassword(bob, null, &password.md5Hex("bpass111"));
    const mine = try seedRecognizedNote(f, admin, "mine.note", &.{"trimestral"});
    const theirs = try seedRecognizedNote(f, bob, "theirs.note", &.{"confidencial"});
    const mine_md5 = try fileMd5(f, mine);
    const theirs_md5 = try fileMd5(f, theirs);

    var etag_buf: [64]u8 = undefined;
    var rows: u32 = 0;
    var etag: []const u8 = "";
    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/controlplane/search-index/manifest", &web_tok, "");
        rows = std.mem.readInt(u32, resp.body[5..9], .little);
        etag = try headerValue(resp.head, "etag", &etag_buf);
    }
    // The scope is the manifest's (`d.user_id = ?1`): a position can only name
    // a row the caller's manifest listed.
    try std.testing.expectEqual(@as(u32, 1), rows);

    var want_buf: [64]u8 = undefined;
    const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/search-index/stream?m={s}&want={s}", .{
        etag[1 .. etag.len - 1],
        wantEveryPosition(&want_buf, rows),
    });
    const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
    try std.testing.expectEqual(@as(u16, 200), resp.status);
    const plain = try inflateStitched(a, try dechunk(a, resp.body));

    try std.testing.expectEqual(@as(usize, 1), std.mem.count(u8, plain, "{\"md5\":\""));
    try std.testing.expect(std.mem.indexOf(u8, plain, &mine_md5) != null);
    try std.testing.expect(std.mem.indexOf(u8, plain, &theirs_md5) == null);
    try std.testing.expect(std.mem.indexOf(u8, plain, "confidencial") == null);
}

/// GETs one md5's text record, asserts the transport contract, returns the
/// decoded bytes.
fn fetchDocText(
    a: std.mem.Allocator,
    ctx: *Context,
    obuf: []u8,
    reqbuf: []u8,
    tok: []const u8,
    md5: []const u8,
) ![]u8 {
    var pbuf: [128]u8 = undefined;
    const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/text/{s}", .{md5});
    const resp = try requestWithCookie(ctx, obuf, reqbuf, "GET", path, tok, "");
    try std.testing.expectEqual(@as(u16, 200), resp.status);

    try expectHeaderContains(resp.head, "content-type: application/x-ndjson");
    try expectHeaderContains(resp.head, "content-encoding: gzip");
    // A bare URL is not cached for a year: its key omits the `index_version`
    // the file is keyed by, so a parser bump could not invalidate it.
    try expectHeaderContains(resp.head, "cache-control: private, immutable");
    try expectHeaderAbsentSubstring(resp.head, "max-age");

    const derivesearch = @import("../../services/derive_search.zig");
    // With `?v=` it can be immutable.
    {
        var vbuf: [256]u8 = undefined;
        const versioned = try std.fmt.bufPrint(&vbuf, "/api/controlplane/text/{s}?v={d}", .{ md5, derivesearch.index_version });
        const r = try requestWithCookie(ctx, obuf, reqbuf, "GET", versioned, tok, "");
        try std.testing.expectEqual(@as(u16, 200), r.status);
        try expectHeaderContains(r.head, "cache-control: private, max-age=31536000, immutable");
    }
    {
        var vbuf: [256]u8 = undefined;
        const stale = try std.fmt.bufPrint(&vbuf, "/api/controlplane/text/{s}?v={d}", .{ md5, derivesearch.index_version - 1 });
        const r = try requestWithCookie(ctx, obuf, reqbuf, "GET", stale, tok, "");
        try std.testing.expectEqual(@as(u16, 200), r.status);
        try expectHeaderAbsentSubstring(r.head, "max-age");
    }
    // A real length: no mid-walk skip is possible here.
    try expectHeaderContains(resp.head, "content-length:");
    try expectHeaderAbsentSubstring(resp.head, "transfer-encoding:");

    return inflateStitched(a, resp.body);
}

test "the per-document text route serves ONE document's real text, by each of the three ways a caller reaches it" {
    const f = try Fixture.init();
    defer f.deinit();
    try withDerivedStores(f);
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");

    var obuf: [65536]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    const web_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    const a = arena.allocator();

    // Accents on purpose: `terms/` is diacritic-folded, `text/` holds the real
    // text find-in-document highlights.
    const live = try seedRecognizedNote(f, admin, "vivo.note", &.{"reunião de orçamento"});
    // Supersede to create gate 2: a version no `files` row points at.
    _ = try seedRecognizedNote(f, admin, "vivo.note", &.{"versão revista"});
    const current_md5 = try fileMd5(f, live);
    const retained_md5 = try soleHistoryMd5(f, live);

    const binned = try seedRecognizedNote(f, admin, "lixo.note", &.{"documentação antiga"});
    const binned_md5 = try fileMd5(f, binned);
    try f.files.trash(admin, binned);

    {
        const plain = try fetchDocText(a, ctx, &obuf, &reqbuf, &web_tok, &current_md5);

        // One header line naming md5 and version, then one line per segment.
        try std.testing.expectEqual(@as(usize, 1), std.mem.count(u8, plain, "{\"md5\":\""));
        try std.testing.expect(std.mem.startsWith(u8, plain, "{\"md5\":\""));
        try std.testing.expect(std.mem.indexOf(u8, plain, &current_md5) != null);
        try std.testing.expect(std.mem.indexOf(u8, plain, "\"p\":0") != null);
        try std.testing.expect(std.mem.indexOf(u8, plain, "versão revista") != null);

        try std.testing.expectEqual(
            @as(usize, try storedPlainLen(f.files.text.?, &current_md5)),
            plain.len,
        );
    }

    // Gate 2: `reachesBlob` finding the `file_history` row.
    {
        const plain = try fetchDocText(a, ctx, &obuf, &reqbuf, &web_tok, &retained_md5);
        try std.testing.expect(std.mem.indexOf(u8, plain, &retained_md5) != null);
        try std.testing.expect(std.mem.indexOf(u8, plain, "reunião de orçamento") != null);
        try std.testing.expect(std.mem.indexOf(u8, plain, "versão revista") == null);
    }

    // Gate 3: trashing hides the row but the bin reads the same file.
    {
        const plain = try fetchDocText(a, ctx, &obuf, &reqbuf, &web_tok, &binned_md5);
        try std.testing.expect(std.mem.indexOf(u8, plain, &binned_md5) != null);
        try std.testing.expect(std.mem.indexOf(u8, plain, "documentação antiga") != null);
    }
}

test "the per-document text route: unreachable and underived are ONE 404, byte for byte" {
    const derivesearch = @import("../../services/derive_search.zig");
    const f = try Fixture.init();
    defer f.deinit();
    try withDerivedStores(f);
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");

    var obuf: [65536]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    var pbuf: [128]u8 = undefined;
    const web_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    const a = arena.allocator();

    const bob = (try f.svc.createUser(admin, "bob", false)).id;
    _ = try f.svc.changePassword(bob, null, &password.md5Hex("bpass111"));

    // Bob has a live and a retained version: both gates must hold the boundary.
    const theirs = try seedRecognizedNote(f, bob, "deles.note", &.{"confidencial"});
    _ = try seedRecognizedNote(f, bob, "deles.note", &.{"confidencial revisto"});
    const theirs_md5 = try fileMd5(f, theirs);
    const theirs_old_md5 = try soleHistoryMd5(f, theirs);

    const mine = try seedRecognizedNote(f, admin, "meu.note", &.{"inventário"});
    const mine_md5 = try fileMd5(f, mine);

    {
        const req = try buildRequest(&reqbuf, "GET", "/api/controlplane/text/" ++ repeat(u8, "a", 32), &.{}, "");
        try std.testing.expectEqual(@as(u16, 401), (try roundtrip(ctx, req, &obuf)).status);
    }
    {
        const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "bob", "bpass111", "SN9");
        const req = try buildRequest(&reqbuf, "GET", "/api/controlplane/text/" ++ repeat(u8, "a", 32), &.{
            .{ .name = "x-access-token", .value = &dev_tok },
        }, "");
        try std.testing.expectEqual(@as(u16, 403), (try roundtrip(ctx, req, &obuf)).status);
    }

    // Works for the owner first, so the 404s below are the gate.
    _ = try fetchDocText(a, ctx, &obuf, &reqbuf, &web_tok, &mine_md5);

    // Underived: the blob is reachable, the derived file absent (GC'd or pending).
    f.files.text.?.remove(&mine_md5, derivesearch.index_version);

    // All refusals must be byte-identical, or the route is an existence oracle
    // over the shared blob space.
    const refusals = [_][]const u8{
        &mine_md5, // reachable, NOT derived
        &theirs_md5, // derived, NOT reachable — a housemate's live document
        &theirs_old_md5, // derived, NOT reachable — a housemate's retained version
        repeat(u8, "f", 32), // names no blob at all
        "nao-e-um-md5", // not even the right shape: still 404, never a 400
    };
    var first: []const u8 = "";
    for (refusals, 0..) |md5, i| {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/text/{s}", .{md5});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 404), resp.status);
        // A miss carries no cache policy: the URL becomes valid once derived.
        try expectHeaderAbsentSubstring(resp.head, "immutable");
        try expectHeaderAbsentSubstring(resp.head, "cache-control");

        const whole = try std.fmt.allocPrint(a, "{s}\r\n\r\n{s}", .{ resp.head, resp.body });
        if (i == 0) first = whole else try std.testing.expectEqualStrings(first, whole);
    }
}

// Find-in-note is done in the browser over `text/:md5`. Content-addressing
// means a housemate holding identical bytes gets that text; `reachesBlob` is
// the boundary.

test "static SPA serving: index, assets, wasm, path-traversal refused, API precedence, disabled=404" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    var web = std.testing.tmpDir(.{});
    defer web.cleanup();
    const index_html = "<!doctype html><title>SPA</title>";
    try web.dir.writeFile(std.testing.io, .{ .sub_path = "index.html", .data = index_html });
    var assets = try web.dir.createDirPathOpen(std.testing.io, "assets", .{});
    assets.close(std.testing.io);
    try web.dir.writeFile(std.testing.io, .{ .sub_path = "assets/x.js", .data = "console.log(1)" });
    try web.dir.writeFile(std.testing.io, .{ .sub_path = "x.wasm", .data = "\x00asm\x01\x00\x00\x00" });

    // The tmp dir is `.zig-cache/tmp/<sub_path>` relative to the repo root.
    var wd_buf: [256]u8 = undefined;
    ctx.config.web_dir = try std.fmt.bufPrint(&wd_buf, ".zig-cache/tmp/{s}", .{web.sub_path});

    var obuf: [4096]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;

    // The shell must state `no-cache`: its URL never changes and it points at
    // the current hashed bundle, so heuristic freshness pins an old build.
    {
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", "/", &.{}, ""), &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualStrings(index_html, resp.body);
        try std.testing.expect(std.mem.indexOf(u8, resp.head, "content-type: text/html") != null);
        try expectHeaderContains(resp.head, "cache-control: no-cache");
        try std.testing.expect(std.mem.indexOf(u8, resp.head, "immutable") == null);
        try std.testing.expect(std.mem.indexOf(u8, resp.head, "max-age") == null);
    }

    // Both URLs reach the shell, so both carry the policy.
    {
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", "/index.html", &.{}, ""), &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualStrings(index_html, resp.body);
        try expectHeaderContains(resp.head, "cache-control: no-cache");
        try std.testing.expect(std.mem.indexOf(u8, resp.head, "immutable") == null);
    }

    {
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", "/assets/x.js", &.{}, ""), &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualStrings("console.log(1)", resp.body);
        try std.testing.expect(std.mem.indexOf(u8, resp.head, "content-type: text/javascript") != null);
        try std.testing.expect(std.mem.indexOf(u8, resp.head, "immutable") != null);
    }

    // Un-fingerprinted, so it revalidates: the decoder must never lag the
    // year-cached SNPG payloads it decodes.
    {
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", "/x.wasm", &.{}, ""), &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expect(std.mem.indexOf(u8, resp.head, "content-type: application/wasm") != null);
        try expectHeaderContains(resp.head, "cache-control: no-cache");
        try std.testing.expect(std.mem.indexOf(u8, resp.head, "immutable") == null);
    }

    {
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", "/../../etc/passwd", &.{}, ""), &obuf);
        try std.testing.expectEqual(@as(u16, 403), resp.status);
    }

    // No SPA fallback (hash routing).
    {
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", "/does-not-exist.js", &.{}, ""), &obuf);
        try std.testing.expectEqual(@as(u16, 404), resp.status);
    }

    {
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", "/api/version", &.{}, ""), &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualStrings(app.api_version, resp.body); // the handler ran, not static
    }

    {
        ctx.config.web_dir = "";
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", "/", &.{}, ""), &obuf);
        try std.testing.expectEqual(@as(u16, 404), resp.status);
    }
}

test "static serving negotiates precompressed variants: br > gzip > raw, honoring q=0" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    // Sibling files hold distinct sentinels (not real gzip/brotli), so the body
    // shows which variant was chosen.
    var web = std.testing.tmpDir(.{});
    defer web.cleanup();
    var assets = try web.dir.createDirPathOpen(std.testing.io, "assets", .{});
    assets.close(std.testing.io);
    const raw = "RAW-console.log(1)";
    const gz = "GZIP-BYTES-x";
    const br = "BROTLI-BYTES";
    try web.dir.writeFile(std.testing.io, .{ .sub_path = "assets/x.js", .data = raw });
    try web.dir.writeFile(std.testing.io, .{ .sub_path = "assets/x.js.gz", .data = gz });
    try web.dir.writeFile(std.testing.io, .{ .sub_path = "assets/x.js.br", .data = br });
    try web.dir.writeFile(std.testing.io, .{ .sub_path = "assets/y.css", .data = "body{color:red}" });

    var wd_buf: [256]u8 = undefined;
    ctx.config.web_dir = try std.fmt.bufPrint(&wd_buf, ".zig-cache/tmp/{s}", .{web.sub_path});

    var obuf: [4096]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;

    // .br bytes with the base Content-Type, Vary, and the base path's cache policy.
    {
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", "/assets/x.js", &.{
            .{ .name = "accept-encoding", .value = "gzip, deflate, br" },
        }, ""), &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualStrings(br, resp.body);
        try expectHeaderContains(resp.head, "content-encoding: br");
        try std.testing.expect(std.mem.indexOf(u8, resp.head, "content-type: text/javascript") != null);
        try expectHeaderContains(resp.head, "vary: accept-encoding");
        try std.testing.expect(std.mem.indexOf(u8, resp.head, "immutable") != null);
    }

    {
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", "/assets/x.js", &.{
            .{ .name = "accept-encoding", .value = "gzip, deflate" },
        }, ""), &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualStrings(gz, resp.body);
        try expectHeaderContains(resp.head, "content-encoding: gzip");
        try expectHeaderContains(resp.head, "vary: accept-encoding");
    }

    {
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", "/assets/x.js", &.{}, ""), &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualStrings(raw, resp.body);
        try expectHeaderAbsentSubstring(resp.head, "content-encoding:");
        try expectHeaderAbsentSubstring(resp.head, "vary:");
    }

    {
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", "/assets/x.js", &.{
            .{ .name = "accept-encoding", .value = "identity" },
        }, ""), &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualStrings(raw, resp.body);
        try expectHeaderAbsentSubstring(resp.head, "content-encoding:");
    }

    {
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", "/assets/x.js", &.{
            .{ .name = "accept-encoding", .value = "br;q=0, gzip" },
        }, ""), &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualStrings(gz, resp.body);
        try expectHeaderContains(resp.head, "content-encoding: gzip");
    }

    {
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", "/assets/y.css", &.{
            .{ .name = "accept-encoding", .value = "br, gzip" },
        }, ""), &obuf);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualStrings("body{color:red}", resp.body);
        try expectHeaderAbsentSubstring(resp.head, "content-encoding:");
        try std.testing.expect(std.mem.indexOf(u8, resp.head, "content-type: text/css") != null);
    }
}
