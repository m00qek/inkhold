//! The tablet's Digest app (schema v23): digests and their categories, stored
//! exactly as the app sends them. The app decides every merge from the md5s
//! it compares (decompiled `KnowledgeSyncRepository.processKnowledgeHash`);
//! the server keeps what it was given, assigns ids and lists it back.
//!
//! The rule everything here serves: the app DELETES a synced digest whose id
//! the manifest lacks, and an empty manifest deletes all of them. So the
//! manifest and the category list are always complete, never paged, never
//! filtered beyond "live"; ids are never reused (AUTOINCREMENT), so a stale id
//! on a tablet can never name a different digest; and a delete of something
//! already gone succeeds.
//!
//! A category is a row with `is_group`; a digest names its category by the
//! category's `uid` in `parent_uid`, and '' is the app's built-in
//! Uncategorized, which is never a row. Deleting a category deletes its
//! digests, as the official server and the app's guide both do.

const std = @import("std");
const sqlite = @import("../db/sqlite.zig");

pub const Error = sqlite.Error || std.mem.Allocator.Error;

/// The app's own limits are 15 000 characters of content, 2 000 of comment
/// and 150 of category name (`KnowledgeFieldNameConstants`). The server's caps
/// sit well above them: a refused add would abort the app's whole sync, so
/// they only keep out what no tablet sends.
pub const max_content_bytes = 15_000 * 4 * 4;
pub const max_comment_bytes = 2_000 * 4 * 4;
pub const max_field_bytes = 64 * 1024;

/// A digest or a category, as the app sends and reads it (`SummaryDO`).
pub const Digest = struct {
    id: u64 = 0,
    is_group: bool = false,
    /// A category's `uniqueIdentifier`; for a digest, the
    /// `unique_identifier` inside its metadata (null when it has none).
    uid: ?[]const u8 = null,
    /// The category's uid; '' is Uncategorized.
    parent_uid: []const u8 = "",
    name: ?[]const u8 = null,
    description: ?[]const u8 = null,
    content: ?[]const u8 = null,
    source_path: ?[]const u8 = null,
    source_type: ?i64 = null,
    data_source: ?[]const u8 = null,
    author: ?[]const u8 = null,
    tags: ?[]const u8 = null,
    /// JSON text, kept byte for byte.
    metadata: ?[]const u8 = null,
    comment_str: ?[]const u8 = null,
    comment_handwrite_name: ?[]const u8 = null,
    handwrite_inner_name: ?[]const u8 = null,
    handwrite_md5: ?[]const u8 = null,
    md5_hash: []const u8 = "",
    creation_time: i64 = 0,
    last_modified_time: i64 = 0,
    /// Server times, ms: the official `createTime`/`updateTime`.
    created_at: i64 = 0,
    updated_at: i64 = 0,
};

/// One row of the manifest (`SummaryInfoVO`).
pub const HashRow = struct {
    id: u64,
    md5_hash: []const u8,
    handwrite_md5: ?[]const u8,
    comment_handwrite_name: ?[]const u8,
    last_modified_time: i64,
};

pub const Tag = struct {
    id: u64,
    name: []const u8,
    created_at: i64,
};

/// The `unique_identifier` inside a digest's metadata JSON, or null. Owned by
/// `a`. Metadata the app sends is JSON text; anything else simply has none.
pub fn uidOfMetadata(a: std.mem.Allocator, metadata: ?[]const u8) ?[]const u8 {
    const text = metadata orelse return null;
    const parsed = std.json.parseFromSliceLeaky(std.json.Value, a, text, .{}) catch return null;
    if (parsed != .object) return null;
    const v = parsed.object.get("unique_identifier") orelse return null;
    if (v != .string or v.string.len == 0) return null;
    return v.string;
}

// ---- digests ----

/// Stores a new digest and returns its id. A resend of a digest still live
/// (same metadata `unique_identifier`, e.g. after a lost reply) updates that
/// row and returns its id, rather than making a second copy.
pub fn addDigest(db: sqlite.Db, user_id: u64, d: Digest, now_ms: i64) sqlite.Error!u64 {
    if (d.uid) |uid| {
        if (try liveId(db, user_id, false, uid)) |id| {
            _ = try putDigest(db, user_id, id, d, now_ms);
            return id;
        }
    }
    try db.runCached(
        \\INSERT INTO digests (user_id, is_group, uid, parent_uid, content, source_path, source_type,
        \\  data_source, author, tags, metadata, comment_str, comment_handwrite_name,
        \\  handwrite_inner_name, handwrite_md5, md5_hash, creation_time, last_modified_time,
        \\  created_at, updated_at)
        \\VALUES (?1, 0, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?18);
    , &.{
        .{ .int = @intCast(user_id) },           .{ .text_opt = d.uid },           .{ .text = d.parent_uid },
        .{ .text_opt = d.content },              .{ .text_opt = d.source_path },   .{ .int_opt = d.source_type },
        .{ .text_opt = d.data_source },          .{ .text_opt = d.author },        .{ .text_opt = d.tags },
        .{ .text_opt = d.metadata },             .{ .text_opt = d.comment_str },   .{ .text_opt = d.comment_handwrite_name },
        .{ .text_opt = d.handwrite_inner_name }, .{ .text_opt = d.handwrite_md5 }, .{ .text = d.md5_hash },
        .{ .int = d.creation_time },             .{ .int = d.last_modified_time }, .{ .int = now_ms },
    });
    return @intCast(db.lastInsertRowId());
}

/// Replaces a live digest's fields, keeping its id and creation times.
/// False when there is no such live digest.
pub fn putDigest(db: sqlite.Db, user_id: u64, id: u64, d: Digest, now_ms: i64) sqlite.Error!bool {
    try db.runCached(
        \\UPDATE digests SET uid = COALESCE(?3, uid), parent_uid = ?4, content = ?5, source_path = ?6,
        \\  source_type = ?7, data_source = ?8, author = ?9, tags = ?10, metadata = ?11,
        \\  comment_str = ?12, comment_handwrite_name = ?13, handwrite_inner_name = ?14,
        \\  handwrite_md5 = ?15, md5_hash = ?16, last_modified_time = ?17, updated_at = ?18
        \\WHERE user_id = ?1 AND id = ?2 AND is_group = 0 AND deleted = 0;
    , &.{
        .{ .int = @intCast(user_id) },             .{ .int = @intCast(id) },                .{ .text_opt = d.uid },
        .{ .text = d.parent_uid },                 .{ .text_opt = d.content },              .{ .text_opt = d.source_path },
        .{ .int_opt = d.source_type },             .{ .text_opt = d.data_source },          .{ .text_opt = d.author },
        .{ .text_opt = d.tags },                   .{ .text_opt = d.metadata },             .{ .text_opt = d.comment_str },
        .{ .text_opt = d.comment_handwrite_name }, .{ .text_opt = d.handwrite_inner_name }, .{ .text_opt = d.handwrite_md5 },
        .{ .text = d.md5_hash },                   .{ .int = d.last_modified_time },        .{ .int = now_ms },
    });
    return db.changes() > 0;
}

/// Soft-deletes a digest: it leaves every listing at once. Nothing to delete
/// is not an error.
pub fn deleteDigest(db: sqlite.Db, user_id: u64, id: u64, now_ms: i64) sqlite.Error!void {
    try db.runCached(
        \\UPDATE digests SET deleted = 1, deleted_at = ?3, updated_at = ?3
        \\WHERE user_id = ?1 AND id = ?2 AND is_group = 0 AND deleted = 0;
    , &.{ .{ .int = @intCast(user_id) }, .{ .int = @intCast(id) }, .{ .int = now_ms } });
}

// ---- categories ----

/// Stores a new category and returns its id. A resend of a category still
/// live (same `uniqueIdentifier`) updates it and returns its id.
pub fn addGroup(db: sqlite.Db, user_id: u64, g: Digest, now_ms: i64) sqlite.Error!u64 {
    if (g.uid) |uid| {
        if (try liveId(db, user_id, true, uid)) |id| {
            _ = try putGroup(db, user_id, id, g, now_ms);
            return id;
        }
    }
    try db.runCached(
        \\INSERT INTO digests (user_id, is_group, uid, name, description, md5_hash, creation_time,
        \\  last_modified_time, created_at, updated_at)
        \\VALUES (?1, 1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8);
    , &.{
        .{ .int = @intCast(user_id) },    .{ .text_opt = g.uid },  .{ .text_opt = g.name },
        .{ .text_opt = g.description },   .{ .text = g.md5_hash }, .{ .int = g.creation_time },
        .{ .int = g.last_modified_time }, .{ .int = now_ms },
    });
    return @intCast(db.lastInsertRowId());
}

/// Replaces a live category's name, description and md5. False when there is
/// no such live category.
pub fn putGroup(db: sqlite.Db, user_id: u64, id: u64, g: Digest, now_ms: i64) sqlite.Error!bool {
    try db.runCached(
        \\UPDATE digests SET uid = COALESCE(?3, uid), name = ?4, description = ?5, md5_hash = ?6,
        \\  last_modified_time = ?7, updated_at = ?8
        \\WHERE user_id = ?1 AND id = ?2 AND is_group = 1 AND deleted = 0;
    , &.{
        .{ .int = @intCast(user_id) },    .{ .int = @intCast(id) },       .{ .text_opt = g.uid },
        .{ .text_opt = g.name },          .{ .text_opt = g.description }, .{ .text = g.md5_hash },
        .{ .int = g.last_modified_time }, .{ .int = now_ms },
    });
    return db.changes() > 0;
}

/// Soft-deletes a category and every digest in it, together. Nothing to
/// delete is not an error.
pub fn deleteGroup(db: sqlite.Db, user_id: u64, id: u64, now_ms: i64) sqlite.Error!void {
    try db.exec("BEGIN IMMEDIATE;");
    errdefer db.exec("ROLLBACK;") catch {};
    const binds: []const sqlite.Bind = &.{ .{ .int = @intCast(user_id) }, .{ .int = @intCast(id) }, .{ .int = now_ms } };
    try db.runCached(
        \\UPDATE digests SET deleted = 1, deleted_at = ?3, updated_at = ?3
        \\WHERE user_id = ?1 AND is_group = 0 AND deleted = 0 AND parent_uid <> ''
        \\  AND parent_uid = (SELECT uid FROM digests WHERE user_id = ?1 AND id = ?2 AND is_group = 1 AND deleted = 0);
    , binds);
    try db.runCached(
        \\UPDATE digests SET deleted = 1, deleted_at = ?3, updated_at = ?3
        \\WHERE user_id = ?1 AND id = ?2 AND is_group = 1 AND deleted = 0;
    , binds);
    try db.exec("COMMIT;");
}

// ---- listings ----

/// The manifest: EVERY live digest of the account, in id order. Never paged
/// and never filtered further: the app deletes whatever it lacks.
pub fn manifest(db: sqlite.Db, arena: std.mem.Allocator, user_id: u64) Error![]HashRow {
    var st = try db.prepareCached(
        \\SELECT id, md5_hash, handwrite_md5, comment_handwrite_name, last_modified_time
        \\FROM digests WHERE user_id = ?1 AND is_group = 0 AND deleted = 0 ORDER BY id;
    );
    defer st.finalize();
    st.bindInt(1, @intCast(user_id));
    var out: std.ArrayList(HashRow) = .empty;
    while (try st.step()) {
        try out.append(arena, .{
            .id = @intCast(st.columnInt(0)),
            .md5_hash = try arena.dupe(u8, st.columnText(1)),
            .handwrite_md5 = try optText(arena, st, 2),
            .comment_handwrite_name = try optText(arena, st, 3),
            .last_modified_time = st.columnInt(4),
        });
    }
    return out.items;
}

/// EVERY live category of the account, in id order (the app reads them in one
/// call, and deletes a synced category the list lacks, as it does digests).
pub fn groups(db: sqlite.Db, arena: std.mem.Allocator, user_id: u64) Error![]Digest {
    var st = try db.prepareCached("SELECT " ++ columns ++
        \\ FROM digests WHERE user_id = ?1 AND is_group = 1 AND deleted = 0 ORDER BY id;
    );
    defer st.finalize();
    st.bindInt(1, @intCast(user_id));
    return readAll(arena, st);
}

/// The live digests among `ids`, in id order; unknown or deleted ids are left
/// out, never invented.
pub fn digestsByIds(db: sqlite.Db, arena: std.mem.Allocator, user_id: u64, ids: []const u64) Error![]Digest {
    var out: std.ArrayList(Digest) = .empty;
    var st = try db.prepareCached("SELECT " ++ columns ++
        \\ FROM digests WHERE user_id = ?1 AND id = ?2 AND is_group = 0 AND deleted = 0;
    );
    defer st.finalize();
    const sorted = try arena.dupe(u64, ids);
    std.mem.sort(u64, sorted, {}, std.sort.asc(u64));
    var prev: ?u64 = null;
    for (sorted) |id| {
        if (prev == id) continue;
        prev = id;
        st.reset();
        st.bindInt(1, @intCast(user_id));
        st.bindInt(2, @intCast(id));
        if (try st.step()) try out.append(arena, try readRow(arena, st));
    }
    return out.items;
}

/// One page of live digests, in id order, optionally of one category
/// (`parent_uid`, '' for Uncategorized). `page` is 1-based, as the app sends
/// it; it reads pages until one comes back short.
pub fn digestsPage(db: sqlite.Db, arena: std.mem.Allocator, user_id: u64, parent_uid: ?[]const u8, page: u32, size: u32) Error![]Digest {
    const offset: i64 = @as(i64, @max(page, 1) - 1) * size;
    var st = try db.prepareCached("SELECT " ++ columns ++
        \\ FROM digests WHERE user_id = ?1 AND is_group = 0 AND deleted = 0
        \\  AND (?2 IS NULL OR parent_uid = ?2)
        \\ORDER BY id LIMIT ?3 OFFSET ?4;
    );
    defer st.finalize();
    st.bindInt(1, @intCast(user_id));
    st.bindTextOpt(2, parent_uid);
    st.bindInt(3, size);
    st.bindInt(4, offset);
    return readAll(arena, st);
}

/// How many live digests a `digestsPage` listing has in all.
pub fn digestCount(db: sqlite.Db, user_id: u64, parent_uid: ?[]const u8) sqlite.Error!i64 {
    var r = (try db.rowCached(
        \\SELECT COUNT(*) FROM digests WHERE user_id = ?1 AND is_group = 0 AND deleted = 0
        \\  AND (?2 IS NULL OR parent_uid = ?2);
    , &.{ .{ .int = @intCast(user_id) }, .{ .text_opt = parent_uid } })).?;
    defer r.finalize();
    return r.int(0);
}

// ---- tags ----

pub fn addTag(db: sqlite.Db, user_id: u64, name: []const u8, now_ms: i64) sqlite.Error!u64 {
    try db.runCached("INSERT INTO digest_tags (user_id, name, created_at) VALUES (?1, ?2, ?3);", &.{
        .{ .int = @intCast(user_id) }, .{ .text = name }, .{ .int = now_ms },
    });
    return @intCast(db.lastInsertRowId());
}

/// False when there is no such tag.
pub fn renameTag(db: sqlite.Db, user_id: u64, id: u64, name: []const u8) sqlite.Error!bool {
    try db.runCached("UPDATE digest_tags SET name = ?3 WHERE user_id = ?1 AND id = ?2;", &.{
        .{ .int = @intCast(user_id) }, .{ .int = @intCast(id) }, .{ .text = name },
    });
    return db.changes() > 0;
}

/// Nothing to delete is not an error.
pub fn deleteTag(db: sqlite.Db, user_id: u64, id: u64) sqlite.Error!void {
    try db.runCached("DELETE FROM digest_tags WHERE user_id = ?1 AND id = ?2;", &.{
        .{ .int = @intCast(user_id) }, .{ .int = @intCast(id) },
    });
}

pub fn tags(db: sqlite.Db, arena: std.mem.Allocator, user_id: u64) Error![]Tag {
    var st = try db.prepareCached("SELECT id, name, created_at FROM digest_tags WHERE user_id = ?1 ORDER BY id;");
    defer st.finalize();
    st.bindInt(1, @intCast(user_id));
    var out: std.ArrayList(Tag) = .empty;
    while (try st.step()) try out.append(arena, .{
        .id = @intCast(st.columnInt(0)),
        .name = try arena.dupe(u8, st.columnText(1)),
        .created_at = st.columnInt(2),
    });
    return out.items;
}

// ---- retention ----

/// Removes rows soft-deleted before `before_ms` for good (the bin's retention).
pub fn purgeDeleted(db: sqlite.Db, before_ms: i64) sqlite.Error!void {
    try db.runCached("DELETE FROM digests WHERE deleted = 1 AND deleted_at < ?1;", &.{.{ .int = before_ms }});
}

// ---- internals ----

const columns =
    \\id, is_group, uid, parent_uid, name, description, content, source_path, source_type,
    \\  data_source, author, tags, metadata, comment_str, comment_handwrite_name,
    \\  handwrite_inner_name, handwrite_md5, md5_hash, creation_time, last_modified_time,
    \\  created_at, updated_at
;

fn readAll(arena: std.mem.Allocator, st: sqlite.Stmt) Error![]Digest {
    var out: std.ArrayList(Digest) = .empty;
    while (try st.step()) try out.append(arena, try readRow(arena, st));
    return out.items;
}

fn readRow(arena: std.mem.Allocator, st: sqlite.Stmt) Error!Digest {
    return .{
        .id = @intCast(st.columnInt(0)),
        .is_group = st.columnInt(1) != 0,
        .uid = try optText(arena, st, 2),
        .parent_uid = try arena.dupe(u8, st.columnText(3)),
        .name = try optText(arena, st, 4),
        .description = try optText(arena, st, 5),
        .content = try optText(arena, st, 6),
        .source_path = try optText(arena, st, 7),
        .source_type = st.columnIntOpt(8),
        .data_source = try optText(arena, st, 9),
        .author = try optText(arena, st, 10),
        .tags = try optText(arena, st, 11),
        .metadata = try optText(arena, st, 12),
        .comment_str = try optText(arena, st, 13),
        .comment_handwrite_name = try optText(arena, st, 14),
        .handwrite_inner_name = try optText(arena, st, 15),
        .handwrite_md5 = try optText(arena, st, 16),
        .md5_hash = try arena.dupe(u8, st.columnText(17)),
        .creation_time = st.columnInt(18),
        .last_modified_time = st.columnInt(19),
        .created_at = st.columnInt(20),
        .updated_at = st.columnInt(21),
    };
}

fn liveId(db: sqlite.Db, user_id: u64, is_group: bool, uid: []const u8) sqlite.Error!?u64 {
    var r = (try db.rowCached(
        \\SELECT id FROM digests WHERE user_id = ?1 AND is_group = ?2 AND uid = ?3 AND deleted = 0
        \\ORDER BY id LIMIT 1;
    , &.{ .{ .int = @intCast(user_id) }, .{ .int = @intFromBool(is_group) }, .{ .text = uid } })) orelse return null;
    defer r.finalize();
    return @intCast(r.int(0));
}

fn optText(arena: std.mem.Allocator, st: sqlite.Stmt, col: c_int) Error!?[]const u8 {
    if (st.columnIsNull(col)) return null;
    return try arena.dupe(u8, st.columnText(col));
}

// ---- tests ----

const testing = std.testing;
const schema = @import("../db/schema.zig");

fn testDb() !sqlite.Db {
    var db = try sqlite.Db.openMemory();
    errdefer db.close();
    try schema.migrate(db);
    try db.exec("INSERT INTO users (id, email, password_md5, created_at) VALUES (1, 'ana', '', 0), (2, 'rui', '', 0);");
    return db;
}

/// The digest the Nomad made on 2026-11-08 (read from the app's log): a
/// highlight in a PDF, Uncategorized, with a typed and a handwritten note.
const nomad_metadata =
    \\{"document_location_data":"[{\"chapter\":0,\"endPosition\":50,\"page\":0,\"startPosition\":26}]","source_size":407277,"unique_identifier":"c1ad0a49d44c62dc94b8f71448b3da5a","author":"john"}
;

fn nomadDigest(a: std.mem.Allocator) Digest {
    return .{
        .uid = uidOfMetadata(a, nomad_metadata),
        .content = "La phonétique du français",
        .source_path = "MyStyle/Français/La_phonetique_du_francais_Prof_Flavio_Adler.pdf",
        .source_type = 1,
        .metadata = nomad_metadata,
        .comment_str = "yeah",
        .comment_handwrite_name = "6003a8c1725a175c14868baedd7133a1.mark",
        .handwrite_md5 = "245354713d4c121a2368d9295f6379ca",
        .md5_hash = "187a8bd48f89d12a78b3198a166d494a",
        .creation_time = 1794175867249,
        .last_modified_time = 1794176056052,
    };
}

test "a digest comes back exactly as the tablet sent it, under the id it was given" {
    var db = try testDb();
    defer db.close();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    const sent = nomadDigest(a);
    try testing.expectEqualStrings("c1ad0a49d44c62dc94b8f71448b3da5a", sent.uid.?);
    const id = try addDigest(db, 1, sent, 1000);

    const got = (try digestsByIds(db, a, 1, &.{id}))[0];
    try testing.expectEqualStrings(nomad_metadata, got.metadata.?);
    try testing.expectEqualStrings("La phonétique du français", got.content.?);
    try testing.expectEqualStrings("", got.parent_uid);
    try testing.expectEqual(@as(?i64, 1), got.source_type);
    try testing.expectEqualStrings(sent.md5_hash, got.md5_hash);
    try testing.expectEqual(sent.last_modified_time, got.last_modified_time);
    try testing.expectEqual(@as(i64, 1000), got.created_at);

    const rows = try manifest(db, a, 1);
    try testing.expectEqual(@as(usize, 1), rows.len);
    try testing.expectEqual(id, rows[0].id);
    try testing.expectEqualStrings(sent.handwrite_md5.?, rows[0].handwrite_md5.?);
}

test "a resent add (lost reply) updates the live digest instead of copying it" {
    var db = try testDb();
    defer db.close();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    const id = try addDigest(db, 1, nomadDigest(a), 1);
    var again = nomadDigest(a);
    again.comment_str = "edited";
    try testing.expectEqual(id, try addDigest(db, 1, again, 2));
    try testing.expectEqual(@as(usize, 1), (try manifest(db, a, 1)).len);
    try testing.expectEqualStrings("edited", (try digestsByIds(db, a, 1, &.{id}))[0].comment_str.?);

    // Deleted, then made again on the tablet: a new digest with a new id.
    try deleteDigest(db, 1, id, 3);
    const id2 = try addDigest(db, 1, nomadDigest(a), 4);
    try testing.expect(id2 != id);
}

test "the manifest lists every live digest, unpaged, and nothing deleted or anyone else's" {
    var db = try testDb();
    defer db.close();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    var ids: [1200]u64 = undefined;
    for (&ids, 0..) |*id, i| id.* = try addDigest(db, 1, .{ .md5_hash = "x", .last_modified_time = @intCast(i) }, 0);
    _ = try addDigest(db, 2, .{ .md5_hash = "rui" }, 0);
    try deleteDigest(db, 1, ids[5], 9);
    try deleteDigest(db, 1, ids[5], 9); // already gone: still fine
    try deleteDigest(db, 1, 999_999, 9); // never existed: still fine

    const rows = try manifest(db, a, 1);
    try testing.expectEqual(@as(usize, 1199), rows.len);
    for (rows) |r| try testing.expect(r.id != ids[5]);
    try testing.expectEqual(@as(usize, 1), (try manifest(db, a, 2)).len);
}

test "ids are never reused, even after the newest digest is purged" {
    var db = try testDb();
    defer db.close();
    const first = try addDigest(db, 1, .{}, 0);
    const second = try addDigest(db, 1, .{}, 0);
    try deleteDigest(db, 1, second, 1);
    try purgeDeleted(db, 100);
    const third = try addDigest(db, 1, .{}, 200);
    try testing.expect(third > second and second > first);
}

test "deleting a category deletes its digests; Uncategorized and other categories stay" {
    var db = try testDb();
    defer db.close();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    const french = try addGroup(db, 1, .{ .uid = "kb-french", .name = "Français", .md5_hash = "g1" }, 0);
    _ = try addGroup(db, 1, .{ .uid = "kb-work", .name = "Work", .md5_hash = "g2" }, 0);
    try testing.expectEqual(french, try addGroup(db, 1, .{ .uid = "kb-french", .name = "Français", .md5_hash = "g1" }, 1));
    _ = try addDigest(db, 1, .{ .parent_uid = "kb-french", .md5_hash = "a" }, 0);
    _ = try addDigest(db, 1, .{ .parent_uid = "kb-french", .md5_hash = "b" }, 0);
    _ = try addDigest(db, 1, .{ .parent_uid = "kb-work", .md5_hash = "c" }, 0);
    _ = try addDigest(db, 1, .{ .md5_hash = "d" }, 0); // Uncategorized
    _ = try addDigest(db, 2, .{ .parent_uid = "kb-french", .md5_hash = "rui" }, 0);

    try deleteGroup(db, 1, french, 5);
    try deleteGroup(db, 1, french, 5); // already gone: still fine

    const left = try groups(db, a, 1);
    try testing.expectEqual(@as(usize, 1), left.len);
    try testing.expectEqualStrings("Work", left[0].name.?);
    try testing.expectEqual(@as(usize, 2), (try manifest(db, a, 1)).len);
    try testing.expectEqual(@as(usize, 1), (try manifest(db, a, 2)).len); // rui's untouched
    try testing.expectEqual(@as(i64, 1), try digestCount(db, 1, ""));
}

test "pages are 1-based and the last one comes back short, as the app reads them" {
    var db = try testDb();
    defer db.close();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    for (0..5) |_| _ = try addDigest(db, 1, .{ .parent_uid = "kb" }, 0);
    _ = try addDigest(db, 1, .{}, 0);
    try testing.expectEqual(@as(usize, 2), (try digestsPage(db, a, 1, "kb", 1, 2)).len);
    try testing.expectEqual(@as(usize, 2), (try digestsPage(db, a, 1, "kb", 2, 2)).len);
    try testing.expectEqual(@as(usize, 1), (try digestsPage(db, a, 1, "kb", 3, 2)).len);
    try testing.expectEqual(@as(usize, 0), (try digestsPage(db, a, 1, "kb", 4, 2)).len);
    try testing.expectEqual(@as(usize, 6), (try digestsPage(db, a, 1, null, 0, 100)).len);
}

test "an update of a digest that is gone says so; one that is live keeps its id" {
    var db = try testDb();
    defer db.close();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const id = try addDigest(db, 1, .{ .md5_hash = "a", .creation_time = 7 }, 0);
    try testing.expect(try putDigest(db, 1, id, .{ .md5_hash = "b", .parent_uid = "kb" }, 1));
    const got = (try digestsByIds(db, a, 1, &.{id}))[0];
    try testing.expectEqualStrings("b", got.md5_hash);
    try testing.expectEqualStrings("kb", got.parent_uid); // moved
    try testing.expectEqual(@as(i64, 7), got.creation_time);
    try deleteDigest(db, 1, id, 2);
    try testing.expect(!try putDigest(db, 1, id, .{}, 3));
    try testing.expect(!try putDigest(db, 2, id, .{}, 3)); // not rui's
}

test "tags per account" {
    var db = try testDb();
    defer db.close();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const t = try addTag(db, 1, "phonetics", 5);
    _ = try addTag(db, 2, "rui", 5);
    try testing.expect(try renameTag(db, 1, t, "phonétique"));
    try testing.expect(!try renameTag(db, 2, t, "nope"));
    const mine = try tags(db, arena.allocator(), 1);
    try testing.expectEqual(@as(usize, 1), mine.len);
    try testing.expectEqualStrings("phonétique", mine[0].name);
    try deleteTag(db, 1, t);
    try deleteTag(db, 1, t);
    try testing.expectEqual(@as(usize, 0), (try tags(db, arena.allocator(), 1)).len);
}

test "a deleted account takes its digests" {
    var db = try testDb();
    defer db.close();
    _ = try addGroup(db, 1, .{ .uid = "g" }, 0);
    _ = try addDigest(db, 1, .{}, 0);
    _ = try addTag(db, 1, "t", 0);
    try db.exec("PRAGMA foreign_keys = ON; DELETE FROM users WHERE id = 1;");
    var r = (try db.row("SELECT (SELECT COUNT(*) FROM digests) + (SELECT COUNT(*) FROM digest_tags);", &.{})).?;
    defer r.finalize();
    try testing.expectEqual(@as(i64, 0), r.int(0));
}

test "metadata without a unique_identifier, or not JSON, has no uid" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    try testing.expectEqual(@as(?[]const u8, null), uidOfMetadata(a, null));
    try testing.expectEqual(@as(?[]const u8, null), uidOfMetadata(a, "not json"));
    try testing.expectEqual(@as(?[]const u8, null), uidOfMetadata(a, "{\"author\":\"x\"}"));
    try testing.expectEqual(@as(?[]const u8, null), uidOfMetadata(a, "{\"unique_identifier\":\"\"}"));
    try testing.expectEqualStrings("u1", uidOfMetadata(a, "{\"unique_identifier\":\"u1\"}").?);
}
