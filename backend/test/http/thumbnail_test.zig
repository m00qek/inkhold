//! The thumbnail and template byte routes over HTTP.

const std = @import("std");
const repeat = @import("../../util/repeat.zig").repeat;
const noteindex = @import("../../services/note_index.zig");
const gpa = std.testing.allocator;
const harness = @import("harness.zig");
const buildRequest = harness.buildRequest;
const roundtrip = harness.roundtrip;
const onboardWeb = harness.onboardWeb;
const Fixture = harness.Fixture;
const requestWithCookie = harness.requestWithCookie;
const expectStatusWithCookie = harness.expectStatusWithCookie;
const putSeedHashed = harness.putSeedHashed;
const expectHeaderContains = harness.expectHeaderContains;
const expectHeaderAbsent = harness.expectHeaderAbsent;
const buildSpdFixture = harness.buildSpdFixture;

test "GET /thumbnail/{hash}: extracted .spd preview served immutable; 404 for no-thumbnail, corrupt, foreign, and unowned" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const bob = (try f.svc.createUser(admin, "bob", false)).id;
    const admin_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;
    var pbuf: [128]u8 = undefined;

    const jpeg = "\xff\xd8\xff\xe0" ++ (repeat(u8, "supernote-thumbnail-pixels", 8));

    const spd = try buildSpdFixture(jpeg);
    defer gpa.free(spd);
    const drawing = try putSeedHashed(f, admin, null, "drawing.spd", spd);

    {
        const path = try std.fmt.bufPrint(&pbuf, "/thumbnail/{s}", .{drawing.md5[0..]});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &admin_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualSlices(u8, jpeg, resp.body);
        try expectHeaderContains(resp.head, "content-type: image/jpeg");
        try expectHeaderContains(resp.head, "cache-control: public, max-age=31536000, immutable");
        try expectHeaderContains(resp.head, "x-content-type-options: nosniff");
        var lbuf: [64]u8 = undefined;
        try expectHeaderContains(resp.head, try std.fmt.bufPrint(&lbuf, "content-length: {d}", .{jpeg.len}));
        try expectHeaderAbsent(resp.head, "transfer-encoding");
    }

    // A `.txt` has no thumbnail, but `/file/{id}` serves its bytes for the snippet.
    const txt_body = "The quick brown fox.\nA second line the client would raster.\n";
    const note = try putSeedHashed(f, admin, null, "readme.txt", txt_body);
    {
        const tpath = try std.fmt.bufPrint(&pbuf, "/thumbnail/{s}", .{note.md5[0..]});
        try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", tpath, &admin_tok, "", 404);
    }
    {
        const fpath = try std.fmt.bufPrint(&pbuf, "/file/{d}?v={s}", .{ note.id, note.md5[0..] });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", fpath, &admin_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualStrings(txt_body, resp.body);
    }

    // A corrupt `.spd` still uploads; it just has no thumbnail.
    const corrupt = try putSeedHashed(f, admin, null, "broken.spd", "SQLite format 3\x00 then total garbage \xff\x00\xab");
    {
        const path = try std.fmt.bufPrint(&pbuf, "/thumbnail/{s}", .{corrupt.md5[0..]});
        try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", path, &admin_tok, "", 404);
    }

    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/thumbnail/not-a-hash", &admin_tok, "", 404);
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/thumbnail/ffffffffffffffffffffffffffffffff", &admin_tok, "", 404);

    // Bob's thumbnail row exists, but admin does not hold that blob: 404.
    const bob_spd = try buildSpdFixture("\x89PNG\r\n\x1a\n" ++ (repeat(u8, "bobs-private-drawing", 4)));
    defer gpa.free(bob_spd);
    const bob_drawing = try putSeedHashed(f, bob, null, "secret.spd", bob_spd);
    {
        try std.testing.expect(try f.files.holdsBlob(bob, &bob_drawing.md5));
        try std.testing.expect(!try f.files.holdsBlob(admin, &bob_drawing.md5));
        const path = try std.fmt.bufPrint(&pbuf, "/thumbnail/{s}", .{bob_drawing.md5[0..]});
        try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", path, &admin_tok, "", 404);
    }

    {
        const path = try std.fmt.bufPrint(&pbuf, "/thumbnail/{s}", .{drawing.md5[0..]});
        const req = try buildRequest(&reqbuf, "GET", path, &.{}, "");
        const resp = try roundtrip(ctx, req, &obuf);
        try std.testing.expectEqual(@as(u16, 401), resp.status);
    }
}

test "GET /thumbnail/{hash}: a lost thumbs/ file heals on demand — the next GET regenerates and serves 200" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const admin_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;
    var pbuf: [128]u8 = undefined;

    const jpeg = "\xff\xd8\xff\xe0" ++ (repeat(u8, "regenerate-me", 8));
    const spd = try buildSpdFixture(jpeg);
    defer gpa.free(spd);
    const drawing = try putSeedHashed(f, admin, null, "drawing.spd", spd);
    const path = try std.fmt.bufPrint(&pbuf, "/thumbnail/{s}", .{drawing.md5[0..]});

    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &admin_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
    }

    // A restore skipped `thumbs/`: the serve path must re-derive and serve.
    f.files.thumbs.remove(&drawing.md5);
    try std.testing.expect(!f.files.thumbs.has(&drawing.md5));
    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &admin_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualSlices(u8, jpeg, resp.body);
        try expectHeaderContains(resp.head, "content-type: image/jpeg");
    }
    try std.testing.expect(f.files.thumbs.has(&drawing.md5)); // healed on disk too
}

test "GET /thumbnail/{hash}: a corrupt .spd is derived ONCE — two GETs, two 404s, one derive" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const admin_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;
    var pbuf: [128]u8 = undefined;

    // SQLite magic + garbage fails the real open (`indexable = 0`); wiping the
    // row makes the first GET pay the derive.
    const corrupt = try putSeedHashed(f, admin, null, "broken.spd", "SQLite format 3\x00 then total garbage \xff\x00\xab");
    try f.db.exec("DELETE FROM spd_index;");
    const path = try std.fmt.bufPrint(&pbuf, "/thumbnail/{s}", .{corrupt.md5[0..]});

    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", path, &admin_tok, "", 404);
    {
        var s = try f.db.prepare("SELECT indexable FROM spd_index WHERE blob_md5 = ?1;");
        defer s.finalize();
        s.bindText(1, &corrupt.md5);
        try std.testing.expect(try s.step()); // the memo row exists
        try std.testing.expectEqual(@as(i64, 0), s.columnInt(0)); // recorded as unparseable
    }

    // A sentinel `indexed_at` survives only if no second derive upserts it.
    try f.db.exec("UPDATE spd_index SET indexed_at = 12345;");

    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", path, &admin_tok, "", 404);
    {
        var s = try f.db.prepare("SELECT indexed_at FROM spd_index WHERE blob_md5 = ?1;");
        defer s.finalize();
        s.bindText(1, &corrupt.md5);
        try std.testing.expect(try s.step());
        try std.testing.expectEqual(@as(i64, 12345), s.columnInt(0));
    }
}

/// A real minimal PNG head (320×240 IHDR) that sniffs and yields dims.
const cover_png = "\x89PNG\r\n\x1a\n" ++
    "\x00\x00\x00\x0d" ++ "IHDR" ++
    "\x00\x00\x01\x40" ++ "\x00\x00\x00\xf0" ++
    "\x08\x02\x00\x00\x00" ++ (repeat(u8, "p", 16));

/// A one-page `.note`, optionally with `cover` as its `COVER_2` block.
fn buildNoteFixture(cover: ?[]const u8) ![]u8 {
    const nb = @import("note_builder");
    const bmp = [_]u8{ 0x61, 0x00, 0x62, 0x03 };
    return nb.serialize(gpa, .{
        .header = &.{.{ .key = "APPLY_EQUIPMENT", .value = "N6" }},
        .pages = &.{.{ .style = "style_white", .layers = &.{.{ .slot = .main, .bitmap = &bmp }} }},
        .covers = if (cover) |c| &.{.{ .bytes = c }} else &.{},
    });
}

test "GET /thumbnail/{hash}: a .note cover serves 200 immutable; a coverless note is a memoized 404" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const admin_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;
    var pbuf: [128]u8 = undefined;

    // Streamed from the blob at the location the ingest parse recorded, same
    // serve contract as the `.spd` thumbnail.
    const covered = try buildNoteFixture(cover_png);
    defer gpa.free(covered);
    const note = try putSeedHashed(f, admin, null, "covered.note", covered);
    {
        const path = try std.fmt.bufPrint(&pbuf, "/thumbnail/{s}", .{note.md5[0..]});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &admin_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualSlices(u8, cover_png, resp.body);
        try expectHeaderContains(resp.head, "content-type: image/png");
        try expectHeaderContains(resp.head, "cache-control: public, max-age=31536000, immutable");
        try expectHeaderContains(resp.head, "x-content-type-options: nosniff");
        var lbuf: [64]u8 = undefined;
        try expectHeaderContains(resp.head, try std.fmt.bufPrint(&lbuf, "content-length: {d}", .{cover_png.len}));
        try expectHeaderAbsent(resp.head, "transfer-encoding");
    }

    // Coverless (the common case) is memoized; the sentinel proves no re-parse.
    const plain = try buildNoteFixture(null);
    defer gpa.free(plain);
    const coverless = try putSeedHashed(f, admin, null, "plain.note", plain);
    const path = try std.fmt.bufPrint(&pbuf, "/thumbnail/{s}", .{coverless.md5[0..]});
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", path, &admin_tok, "", 404);
    {
        var s = try f.db.prepare("UPDATE note_index SET indexed_at = 54321 WHERE blob_md5 = ?1;");
        defer s.finalize();
        s.bindText(1, &coverless.md5);
        _ = try s.step();
    }
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", path, &admin_tok, "", 404);
    {
        var s = try f.db.prepare("SELECT indexed_at FROM note_index WHERE blob_md5 = ?1;");
        defer s.finalize();
        s.bindText(1, &coverless.md5);
        try std.testing.expect(try s.step());
        try std.testing.expectEqual(@as(i64, 54321), s.columnInt(0));
    }
}

test "GET /thumbnail/{hash}: a wiped .note cover row heals on demand — the repair e2e, second format" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const admin_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;
    var pbuf: [128]u8 = undefined;

    const covered = try buildNoteFixture(cover_png);
    defer gpa.free(covered);
    const note = try putSeedHashed(f, admin, null, "covered.note", covered);
    const path = try std.fmt.bufPrint(&pbuf, "/thumbnail/{s}", .{note.md5[0..]});

    // A `.note` cover streams from the blob; ingest writes no thumbs file.
    try std.testing.expect(!f.files.thumbs.has(&note.md5));
    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &admin_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualSlices(u8, cover_png, resp.body);
    }

    // No index row: the magic dispatch must route the re-derive to the cover parse.
    try f.db.exec("DELETE FROM note_index;");
    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &admin_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualSlices(u8, cover_png, resp.body);
        try expectHeaderContains(resp.head, "content-type: image/png");
    }
    {
        var sqlbuf: [160]u8 = undefined;
        const sql = try std.fmt.bufPrintSentinel(&sqlbuf, "SELECT cover_offset IS NOT NULL FROM note_index WHERE blob_md5 = ?1 AND index_version = {d};", .{noteindex.index_version}, 0);
        var s = try f.db.prepare(sql);
        defer s.finalize();
        s.bindText(1, &note.md5);
        try std.testing.expect(try s.step());
        try std.testing.expectEqual(@as(i64, 1), s.columnInt(0));
    }
}

test "GET /note/{id}/template/{hash}: serves the custom image template; 404 for a wrong hash or note" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const nb = @import("note_builder");

    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const admin_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    const hash = "deadbeefdeadbeefdeadbeefdeadbeef";
    const bytes = try nb.serialize(gpa, .{ .pages = &.{.{
        .style = "customImage",
        .style_md5 = hash,
        .layers = &.{
            .{ .slot = .background, .name = "BGLAYER", .protocol = "RATTA_RLE", .bitmap = cover_png },
            .{ .slot = .main, .name = "MAINLAYER", .protocol = "RATTA_RLE", .bitmap = &.{ 0x61, 0x00 } },
        },
    }} });
    defer gpa.free(bytes);
    const note = try putSeedHashed(f, admin, null, "template.note", bytes);

    var obuf: [16384]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;
    var pbuf: [128]u8 = undefined;

    {
        const path = try std.fmt.bufPrint(&pbuf, "/note/{d}/template/{s}", .{ note.id, hash });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &admin_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expectEqualSlices(u8, cover_png, resp.body);
        try expectHeaderContains(resp.head, "content-type: image/png");
        try expectHeaderContains(resp.head, "immutable");
    }
    {
        const path = try std.fmt.bufPrint(&pbuf, "/note/{d}/template/{s}", .{ note.id, "00000000000000000000000000000000" });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &admin_tok, "");
        try std.testing.expectEqual(@as(u16, 404), resp.status);
    }
    {
        const path = try std.fmt.bufPrint(&pbuf, "/note/{d}/template/{s}", .{ note.id + 999, hash });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &admin_tok, "");
        try std.testing.expectEqual(@as(u16, 404), resp.status);
    }
}
