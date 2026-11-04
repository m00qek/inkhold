//! Seeding and inspecting state for the HTTP tests: files, notes, quota, the bin and search.

const std = @import("std");
const context = @import("../../http/context.zig");
const sqlite = @import("../../db/sqlite.zig");
const blobstore = @import("../../store/blobs.zig");
const Context = context.Context;
const gpa = std.testing.allocator;
const harness = @import("harness.zig");
const Fixture = harness.Fixture;
const Response = harness.Response;
const buildRequest = harness.buildRequest;
const challenge = harness.challenge;
const getCode = harness.getCode;
const roundtrip = harness.roundtrip;

/// The single retained-version md5 of `file_id`.
pub fn soleHistoryMd5(f: *Fixture, file_id: u64) ![32]u8 {
    var r = (try f.db.row("SELECT md5 FROM file_history WHERE file_id = ?1;", &.{.{ .int = @intCast(file_id) }})) orelse return error.NoHistory;
    defer r.finalize();
    var out: [32]u8 = undefined;
    @memcpy(&out, r.text(0)[0..32]);
    return out;
}

pub fn currentFileMd5(f: *Fixture, file_id: u64) ![32]u8 {
    var r = (try f.db.row("SELECT md5 FROM files WHERE id = ?1;", &.{.{ .int = @intCast(file_id) }})) orelse return error.NoFile;
    defer r.finalize();
    var out: [32]u8 = undefined;
    @memcpy(&out, r.text(0)[0..32]);
    return out;
}

pub fn countRows(f: *Fixture, sql: []const u8) !i64 {
    var s = try f.db.prepare(sql);
    defer s.finalize();
    _ = try s.step();
    return s.columnInt(0);
}

pub fn deviceRequest(ctx: *Context, obuf: []u8, reqbuf: []u8, method: []const u8, path: []const u8, token: []const u8, eno: []const u8, body: []const u8) !Response {
    const req = try buildRequest(reqbuf, method, path, &.{
        .{ .name = "content-type", .value = "application/json" },
        .{ .name = "x-access-token", .value = token },
        .{ .name = "equipmentNo", .value = eno },
    }, body);
    return roundtrip(ctx, req, obuf);
}

pub fn deviceLogin(ctx: *Context, obuf: []u8, reqbuf: []u8, account: []const u8, pw: []const u8, eno: []const u8) ![32]u8 {
    const code = try getCode(ctx, account);
    const hash = challenge(pw, &code);
    const body = try std.fmt.allocPrint(gpa, "{{\"account\":\"{s}\",\"password\":\"{s}\",\"equipmentNo\":\"{s}\",\"version\":\"202407\"}}", .{ account, hash[0..], eno });
    defer gpa.free(body);
    const req = try buildRequest(reqbuf, "POST", "/api/official/user/account/login/equipment", &.{
        .{ .name = "content-type", .value = "application/json" },
    }, body);
    const resp = try roundtrip(ctx, req, obuf);
    try std.testing.expectEqual(@as(u16, 200), resp.status);
    var p = try std.json.parseFromSlice(struct { token: []const u8 }, gpa, resp.body, .{ .ignore_unknown_fields = true });
    defer p.deinit();
    var tok: [32]u8 = undefined;
    @memcpy(&tok, p.value.token);
    return tok;
}

pub fn putSeed(f: *Fixture, user_id: u64, parent: ?u64, name: []const u8, data: []const u8) !u64 {
    var r = std.Io.Reader.fixed(data);
    const e = try f.files.putFile(user_id, parent, name, &r, null);
    defer e.deinit(gpa);
    return e.id;
}

pub fn usedBytes(f: *Fixture, user_id: u64) !i64 {
    var s = try f.db.prepare("SELECT used_bytes FROM capacity WHERE user_id = ?1;");
    defer s.finalize();
    s.bindInt(1, @intCast(user_id));
    _ = try s.step();
    return s.columnInt(0);
}

/// Files staged under the blob store's `tmp/`, where a refused upload could
/// strand bytes.
pub fn blobTempCount(f: *Fixture) !usize {
    var d = try f.tmp.dir.openDir(std.testing.io, "tmp", .{ .iterate = true });
    defer d.close(std.testing.io);
    var it = d.iterate();
    var n: usize = 0;
    while (try it.next(std.testing.io)) |_| n += 1;
    return n;
}

/// `len` bytes of a non-repeating pattern with no multipart delimiter look-alike.
pub fn filler(len: usize) ![]u8 {
    const buf = try gpa.alloc(u8, len);
    for (buf, 0..) |*b, i| b.* = @intCast((i * 31 + 7) & 0xFF);
    return buf;
}

/// The most a capped ingest may read before refusing: the cap plus three
/// `chunk_len` reads of framing and lookahead headroom.
pub fn cappedReadCeiling(limit: usize) usize {
    return limit + 3 * blobstore.chunk_len;
}

pub fn countTrashed(f: *Fixture, user_id: u64) !i64 {
    var s = try f.db.prepare("SELECT COUNT(*) FROM files WHERE user_id = ?1 AND deleted = 1;");
    defer s.finalize();
    s.bindInt(1, @intCast(user_id));
    _ = try s.step();
    return s.columnInt(0);
}

/// How many of `user_id`'s own live files contain `q`, read straight from
/// `note_page_index.text` (the server runs no queries). A case-folded substring,
/// not a tokenizer; only `.note` rows (`kind = 0`) remain. The `files` join
/// carries ownership, `deleted = 0`, and current-only via `files.md5`.
pub fn searchHits(f: *Fixture, user_id: u64, q: []const u8) !usize {
    var s = try f.db.prepare(
        "SELECT COUNT(DISTINCT f.id) FROM files f " ++
            "JOIN note_page_index p ON p.blob_md5 = f.md5 " ++
            "WHERE f.user_id = ?1 AND f.deleted = 0 AND f.is_folder = 0 " ++
            "  AND p.text IS NOT NULL AND instr(lower(p.text), lower(?2)) > 0;",
    );
    defer s.finalize();
    s.bindInt(1, @intCast(user_id));
    s.bindText(2, q);
    _ = try s.step();
    return @intCast(s.columnInt(0));
}

/// Stores a synthetic `.note` (one main layer per page); returns the file id.
pub fn seedNoteHttp(f: *Fixture, user_id: u64, parent: ?u64, name: []const u8, page_bitmaps: []const []const u8) !u64 {
    const nb = @import("note_builder");
    var layers = try gpa.alloc([1]nb.LayerSpec, page_bitmaps.len);
    defer gpa.free(layers);
    var pagespecs = try gpa.alloc(nb.PageSpec, page_bitmaps.len);
    defer gpa.free(pagespecs);
    for (page_bitmaps, 0..) |bmp, i| {
        layers[i] = .{.{ .slot = .main, .bitmap = bmp }};
        pagespecs[i] = .{ .layers = layers[i][0..1] };
    }
    const bytes = try nb.serialize(gpa, .{ .pages = pagespecs });
    defer gpa.free(bytes);

    var r = std.Io.Reader.fixed(bytes);
    const e = try f.files.putFile(user_id, parent, name, &r, null);
    defer e.deinit(gpa);
    return e.id;
}

/// A one-page `.note` with finished recognition holding `labels`.
pub fn seedRecognizedNote(f: *Fixture, user_id: u64, name: []const u8, labels: []const []const u8) !u64 {
    return seedRecognizedElements(f, user_id, name, "N6", blk: {
        const nb = @import("note_builder");
        const els = try gpa.alloc(nb.ElementSpec, labels.len);
        for (labels, els) |label, *e| e.* = .{ .label = label };
        break :blk els;
    }, true);
}

/// A recognized note with explicit `APPLY_EQUIPMENT` (null = unmeasured
/// hardware) and per-word boxes. `owns_elements` frees the slice.
pub fn seedRecognizedElements(
    f: *Fixture,
    user_id: u64,
    name: []const u8,
    equipment: ?[]const u8,
    elements: []const @import("note_builder").ElementSpec,
    owns_elements: bool,
) !u64 {
    const nb = @import("note_builder");
    defer if (owns_elements) gpa.free(elements);

    const header: []const nb.Kv = if (equipment) |eq|
        &.{.{ .key = "APPLY_EQUIPMENT", .value = eq }}
    else
        &.{};

    const bytes = try nb.serialize(gpa, .{ .header = header, .pages = &.{.{
        .layers = &.{.{ .slot = .main, .bitmap = "AAAA" }},
        .recogn_status = 1,
        .recogn_elements = elements,
    }} });
    defer gpa.free(bytes);

    var r = std.Io.Reader.fixed(bytes);
    const e = try f.files.putFile(user_id, null, name, &r, null);
    defer e.deinit(gpa);
    return e.id;
}

/// `putSeed` plus the blob md5 (the raw-file route's `?v=`).
pub const Seeded = struct { id: u64, md5: [32]u8 };

pub fn putSeedHashed(f: *Fixture, user_id: u64, parent: ?u64, name: []const u8, data: []const u8) !Seeded {
    var r = std.Io.Reader.fixed(data);
    const e = try f.files.putFile(user_id, parent, name, &r, null);
    defer e.deinit(gpa);
    var out: Seeded = .{ .id = e.id, .md5 = undefined };
    @memcpy(&out.md5, e.md5.?);
    return out;
}

/// A minimal `.spd` (SQLite with a `config` table) as bytes; `thumbnail` null
/// omits the `thumbnail` row.
pub fn buildSpdFixture(thumb: ?[]const u8) ![]u8 {
    var db = try sqlite.Db.openMemory();
    defer db.close();
    try db.exec("CREATE TABLE config(name TEXT PRIMARY KEY NOT NULL, value BLOB);");
    try db.exec("INSERT INTO config(name, value) VALUES('fmt_ver', '2');");
    if (thumb) |t| {
        try db.run("INSERT INTO config(name, value) VALUES('thumbnail', ?1);", &.{.{ .blob = t }});
    }
    return db.serializeAlloc(gpa);
}
