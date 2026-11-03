//! Recognised text over HTTP: page text, word boxes and the hasRecognizedText flag.

const std = @import("std");
const repeat = @import("../../repeat.zig").repeat;
const transport = @import("../../http/transport.zig");
const gpa = std.testing.allocator;
const harness = @import("harness.zig");
const buildRequest = harness.buildRequest;
const roundtrip = harness.roundtrip;
const onboardWeb = harness.onboardWeb;
const Fixture = harness.Fixture;
const deviceLogin = harness.deviceLogin;
const seedNoteHttp = harness.seedNoteHttp;
const seedRecognizedNote = harness.seedRecognizedNote;
const seedRecognizedElements = harness.seedRecognizedElements;
const requestWithCookie = harness.requestWithCookie;
const expectHeaderContains = harness.expectHeaderContains;

test "control-plane page text: raw VO, versioned by textHash, revalidated, 404 on stale or unrecognized" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    const web_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    const rec_id = try seedRecognizedNote(f, admin, "rec.note", &.{ "Test", "Middle" });
    const plain_id = try seedNoteHttp(f, admin, null, "plain.note", &.{"AAAA"}); // no recognition

    var text_hash: [32]u8 = undefined;
    {
        var pbuf: [96]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/file/metadata/{d}", .{rec_id});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(struct {
            pages: []const struct { hash: []const u8, textHash: ?[]const u8 = null },
        }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqual(@as(usize, 32), p.value.pages[0].textHash.?.len);
        @memcpy(&text_hash, p.value.pages[0].textHash.?);
    }
    {
        var pbuf: [96]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/file/metadata/{d}", .{plain_id});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "textHash") == null);
    }

    {
        var pbuf: [128]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/note/{d}/page/0/text?v={s}", .{ rec_id, text_hash[0..] });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        // `PageTextVO` shape can change under the same `?v=`, so no-cache.
        try expectHeaderContains(resp.head, "cache-control: no-cache");
        try std.testing.expect(std.mem.indexOf(u8, resp.head, "immutable") == null);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "success") == null); // raw VO
        var p = try std.json.parseFromSlice(struct { text: ?[]const u8 = null }, gpa, resp.body, .{});
        defer p.deinit();
        try std.testing.expectEqualStrings("Test\nMiddle", p.value.text.?); // v7: regions newline-joined
    }

    const stale = repeat(u8, "0", 32);
    const cases = [_]struct { id: u64, page: []const u8, v: []const u8 }{
        .{ .id = rec_id, .page = "0", .v = stale }, // stale `?v=`
        .{ .id = plain_id, .page = "0", .v = &text_hash }, // never recognized
        .{ .id = plain_id, .page = "0", .v = stale }, // ...with any version at all
        .{ .id = rec_id, .page = "9", .v = &text_hash }, // out of range
        .{ .id = 99999, .page = "0", .v = &text_hash }, // no such note
    };
    for (cases) |c| {
        var pbuf: [128]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/note/{d}/page/{s}/text?v={s}", .{ c.id, c.page, c.v });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 404), resp.status);
    }
    {
        var pbuf: [128]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/note/{d}/page/0/text", .{rec_id});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 404), resp.status);
    }

    {
        var pbuf: [128]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/note/{d}/page/0/text?v={s}", .{ rec_id, text_hash[0..] });
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", path, &.{}, ""), &obuf);
        try std.testing.expectEqual(@as(u16, 401), resp.status);
    }
    {
        const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "admin", "adminpw1", "SN9");
        var pbuf: [128]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/note/{d}/page/0/text?v={s}", .{ rec_id, text_hash[0..] });
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "GET", path, &.{
            .{ .name = "x-access-token", .value = &dev_tok },
        }, ""), &obuf);
        try std.testing.expectEqual(@as(u16, 403), resp.status);
    }

    // Keyed by blob md5 and shared by dedup: another account must not reach it.
    {
        const bob = try f.svc.createUser(admin, "bob", false);
        const bob_tok = try onboardWeb(ctx, "bob", bob.temp_password.slice(), "bpass111");
        var pbuf: [128]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/note/{d}/page/0/text?v={s}", .{ rec_id, text_hash[0..] });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &bob_tok, "");
        try std.testing.expectEqual(@as(u16, 404), resp.status);
    }
}

test "control-plane listing: hasRecognizedText tracks finished on-device recognition; textHash rides the page list" {
    // Pins `hasRecognizedText` on the tree and `textHash` on note detail over
    // the real transport (the fake API emits them in dev).
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    const web_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    const rec_id = try seedRecognizedNote(f, admin, "rec.note", &.{ "Test", "Middle" });
    const plain_id = try seedNoteHttp(f, admin, null, "plain.note", &.{"AAAA"}); // no recognition

    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/controlplane/tree", &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(struct {
            entries: []const struct {
                id: []const u8,
                name: []const u8,
                hasRecognizedText: ?bool = null,
            },
        }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqual(@as(usize, 2), p.value.entries.len);

        var saw_rec = false;
        var saw_plain = false;
        for (p.value.entries) |e| {
            if (std.mem.eql(u8, e.name, "rec.note")) {
                saw_rec = true;
                try std.testing.expectEqual(true, e.hasRecognizedText.?);
            } else if (std.mem.eql(u8, e.name, "plain.note")) {
                saw_plain = true;
                try std.testing.expectEqual(false, e.hasRecognizedText.?);
            }
        }
        try std.testing.expect(saw_rec and saw_plain);
    }

    {
        var pbuf: [96]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/file/metadata/{d}", .{rec_id});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(struct {
            pages: []const struct { hash: []const u8, textHash: ?[]const u8 = null },
        }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqual(@as(usize, 32), p.value.pages[0].textHash.?.len);
        try std.testing.expect(!std.mem.eql(u8, p.value.pages[0].hash, p.value.pages[0].textHash.?));
    }
    {
        var pbuf: [96]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/file/metadata/{d}", .{plain_id});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "textHash") == null);
    }
}

test "control-plane page text: word boxes in millimetres, separators skipped, scale only for known hardware" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    const web_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    const nb = @import("note_builder");
    // Two of the four words are the device's null-box layout separators. Boxes
    // are mm on the 118.64 x 158.19 mm canvas.
    const elements = [_]nb.ElementSpec{.{ .label = "alpha beta", .words = &.{
        .{ .label = "alpha", .box = .{ .x = 10.5, .y = 20.25, .width = 30.5, .height = 8.125 } },
        .{ .label = "\n", .box = null },
        .{ .label = " ", .box = null },
        .{ .label = "beta", .box = .{ .x = 40, .y = 100, .width = 20, .height = 9 } },
    } }};

    const known_id = try seedRecognizedElements(f, admin, "known.note", "N6", &elements, false);
    // Unmeasured hardware: `Dimensions.forEquipment`'s 1404x1872 fallback must
    // not become a mm scale.
    const unknown_id = try seedRecognizedElements(f, admin, "unknown.note", "N5", &elements, false);

    const Meta = struct {
        pages: []const struct { textHash: ?[]const u8 = null },
        pxPerMm: ?f32 = null,
    };
    const Body = struct {
        text: ?[]const u8 = null,
        words: ?[]const struct {
            text: []const u8,
            xMm: f32,
            yMm: f32,
            wMm: f32,
            hMm: f32,
        } = null,
    };

    var known_hash: [32]u8 = undefined;
    {
        var pbuf: [96]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/file/metadata/{d}", .{known_id});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(Meta, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectApproxEqAbs(@as(f32, 11.834), p.value.pxPerMm.?, 0.001);
        @memcpy(&known_hash, p.value.pages[0].textHash.?);
    }

    // Unknown hardware: omitted, not zero or the pixel table's default.
    var unknown_hash: [32]u8 = undefined;
    {
        var pbuf: [96]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/file/metadata/{d}", .{unknown_id});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "pxPerMm") == null);
        var p = try std.json.parseFromSlice(Meta, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expect(p.value.pxPerMm == null);
        @memcpy(&unknown_hash, p.value.pages[0].textHash.?);
    }

    {
        var pbuf: [128]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/note/{d}/page/0/text?v={s}", .{ known_id, known_hash[0..] });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        // `?v={textHash}` versions the transcript, not the struct; an
        // immutable response once pinned wordless copies.
        try expectHeaderContains(resp.head, "cache-control: no-cache");
        try std.testing.expect(std.mem.indexOf(u8, resp.head, "immutable") == null);

        var p = try std.json.parseFromSlice(Body, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();

        try std.testing.expectEqualStrings("alpha beta", p.value.text.?);

        // Null-box separators are dropped, not defaulted to {0,0,0,0}.
        const words = p.value.words.?;
        try std.testing.expectEqual(@as(usize, 2), words.len);
        try std.testing.expectEqualStrings("alpha", words[0].text);
        try std.testing.expectApproxEqAbs(@as(f32, 10.5), words[0].xMm, 1e-4);
        try std.testing.expectApproxEqAbs(@as(f32, 20.25), words[0].yMm, 1e-4);
        try std.testing.expectApproxEqAbs(@as(f32, 30.5), words[0].wMm, 1e-4);
        try std.testing.expectApproxEqAbs(@as(f32, 8.125), words[0].hMm, 1e-4);
        try std.testing.expectEqualStrings("beta", words[1].text);
        try std.testing.expectApproxEqAbs(@as(f32, 100), words[1].yMm, 1e-4);
        for (words) |w| try std.testing.expect(w.xMm >= 0 and w.yMm >= 0);
    }

    // Boxes are the device's mm verbatim; hardware only changes `pxPerMm`.
    {
        var pbuf: [128]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/note/{d}/page/0/text?v={s}", .{ unknown_id, unknown_hash[0..] });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(Body, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        const words = p.value.words.?;
        try std.testing.expectEqual(@as(usize, 2), words.len);
        try std.testing.expectApproxEqAbs(@as(f32, 10.5), words[0].xMm, 1e-4);
    }

    // No positioned words: `words` is omitted, not `[]`.
    {
        const bare = try seedRecognizedNote(f, admin, "bare.note", &.{"solo"});
        var pbuf: [96]u8 = undefined;
        const mpath = try std.fmt.bufPrint(&pbuf, "/api/controlplane/file/metadata/{d}", .{bare});
        const mresp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", mpath, &web_tok, "");
        var mp = try std.json.parseFromSlice(Meta, gpa, mresp.body, .{ .ignore_unknown_fields = true });
        defer mp.deinit();

        var tbuf: [128]u8 = undefined;
        const tpath = try std.fmt.bufPrint(&tbuf, "/note/{d}/page/0/text?v={s}", .{ bare, mp.value.pages[0].textHash.? });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", tpath, &web_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "words") == null);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "solo") != null);
    }
}
