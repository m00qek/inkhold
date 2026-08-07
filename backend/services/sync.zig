//! SyncService: projects `files` rows into the device-sync VOs — the hash-diff
//! **read path**. The sync is hash-based: the device
//! pulls the server's md5 summary (`query/summary/hash`), diffs it against its
//! local files, and fetches per-id detail (`query/summary/id`) for what it wants.
//! The server is therefore largely stateless for reads — no per-device cursors —
//! so this layer is a pure paginated projection over the file tree.
//!
//! VO field names mirror docs/supernote-api.openapi.yaml so the device parser
//! accepts them; unmodelled optional fields are simply omitted from the JSON.

const std = @import("std");
const Files = @import("files.zig").Files;

// ---- response VOs ----

/// The device wants `metadataMap` as a string→string object; we expose the
/// file's full path under "path" (design §4).
pub const MetadataMap = struct { path: []const u8 };

/// One lightweight diff entry per live file (`query/summary/hash`).
pub const SummaryInfoVO = struct {
    id: i64,
    userId: i64,
    md5Hash: []const u8,
    /// A `.note` carries a separate "handwrite" md5; until we learn which drives
    /// the diff we mirror the file md5 here (design §7.1).
    handwriteMd5: []const u8,
    commentHandwriteName: []const u8 = "",
    lastModifiedTime: i64,
    metadataMap: MetadataMap,
};

pub const QuerySummaryMD5HashVO = struct {
    success: bool = true,
    totalRecords: i64,
    totalPages: i32,
    currentPage: i32,
    pageSize: i32,
    summaryInfoVOList: []const SummaryInfoVO,
};

/// Full per-entry detail (`query/summary/id`, `query/summary/group`). Only the
/// fields we can source from the tree are populated; the rest are omitted.
pub const SummaryDO = struct {
    id: i64,
    fileId: i64,
    name: []const u8,
    userId: i64,
    sourcePath: []const u8,
    md5Hash: []const u8,
    handwriteMD5: []const u8,
    metadata: []const u8 = "",
    isSummaryGroup: []const u8,
    isDeleted: []const u8 = "N",
    creationTime: i64,
    lastModifiedTime: i64,
};

pub const QuerySummaryByIdVO = struct {
    success: bool = true,
    summaryDOList: []const SummaryDO,
};

pub const QuerySummaryVO = struct {
    success: bool = true,
    totalRecords: i64,
    totalPages: i32,
    currentPage: i32,
    pageSize: i32,
    summaryDOList: []const SummaryDO,
};

pub const SyncService = struct {
    /// Every live path for one user, computed once by SQLite so a row can CARRY its
    /// path instead of the caller deriving it.
    ///
    /// **This replaced a `pathOf` call per row.** `pathOf` walks UP the tree, one
    /// query per ancestor, so a page of N files at depth D cost N x D round trips —
    /// issued from inside an open cursor, and with the global DB lock held for all
    /// of it. The device asks for these summaries on every sync, which made it the
    /// most expensive read on the hot path. One recursive CTE does the same work in
    /// the engine, in one statement.
    ///
    /// The recursion is the same shape as `files.tree_walk_sql`, minus the columns
    /// nothing here reads.
    const path_cte =
        \\WITH RECURSIVE tree(id,path) AS (
        \\  SELECT id, '/'||name FROM files WHERE user_id=?1 AND parent_id IS NULL AND deleted=0
        \\  UNION ALL
        \\  SELECT f.id, t.path||'/'||f.name FROM files f JOIN tree t ON f.parent_id=t.id
        \\  WHERE f.user_id=?1 AND f.deleted=0
        \\)
    ;

    files: *Files,

    pub fn init(files: *Files) SyncService {
        return .{ .files = files };
    }

    const Window = struct { offset: i64, limit: i64, total_pages: i32, page_size: i32, current_page: i32 };

    /// Resolves a `(page, size)` request against a known total into an SQL window.
    /// `page` is 0-based; `size <= 0` means "everything in a single page".
    fn window(total: i64, page: i32, size: i32) Window {
        const cur: i32 = if (page < 0) 0 else page;
        if (size <= 0) {
            return .{ .offset = 0, .limit = total, .total_pages = if (total > 0) 1 else 0, .page_size = @intCast(total), .current_page = 0 };
        }
        const sz: i64 = size;
        const pages: i32 = @intCast(@divTrunc(total + sz - 1, sz)); // ceil(total/size)
        return .{ .offset = @as(i64, cur) * sz, .limit = sz, .total_pages = pages, .page_size = size, .current_page = cur };
    }

    fn count(self: SyncService, user_id: u64, is_folder: i64) !i64 {
        var s = try self.files.db.prepare("SELECT COUNT(*) FROM files WHERE user_id = ?1 AND is_folder = ?2 AND deleted = 0;");
        defer s.finalize();
        s.bindInt(1, @intCast(user_id));
        s.bindInt(2, is_folder);
        _ = try s.step();
        return s.columnInt(0);
    }

    /// `query/summary/hash` → one `SummaryInfoVO` per live file, paginated. The
    /// device diffs these md5s against its local files. Everything is allocated
    /// in `arena` (the handler owns it and frees it after the response is sent).
    pub fn summaryHash(self: SyncService, arena: std.mem.Allocator, user_id: u64, page: i32, size: i32) !QuerySummaryMD5HashVO {
        const total = try self.count(user_id, 0);
        const w = window(total, page, size);

        var list: std.ArrayList(SummaryInfoVO) = .empty;
        var s = try self.files.db.prepare(path_cte ++
            "SELECT f.id, f.md5, f.updated_at, t.path FROM files f JOIN tree t ON t.id = f.id " ++
            "WHERE f.user_id = ?1 AND f.is_folder = 0 AND f.deleted = 0 ORDER BY f.id LIMIT ?2 OFFSET ?3;");
        defer s.finalize();
        s.bindInt(1, @intCast(user_id));
        s.bindInt(2, w.limit);
        s.bindInt(3, w.offset);
        while (try s.step()) {
            const id: i64 = s.columnInt(0);
            const md5 = try arena.dupe(u8, s.columnText(1));
            const mtime = s.columnInt(2);
            const path = try arena.dupe(u8, s.columnText(3));
            try list.append(arena, .{
                .id = id,
                .userId = @intCast(user_id),
                .md5Hash = md5,
                .handwriteMd5 = md5,
                .lastModifiedTime = mtime,
                .metadataMap = .{ .path = path },
            });
        }
        return .{
            .totalRecords = total,
            .totalPages = w.total_pages,
            .currentPage = w.current_page,
            .pageSize = w.page_size,
            .summaryInfoVOList = list.items,
        };
    }

    /// `query/summary/id` → full `SummaryDO` for each requested id (scoped to the
    /// user; unknown/foreign ids are skipped). Ids come from a prior hash diff.
    pub fn summaryById(self: SyncService, arena: std.mem.Allocator, user_id: u64, ids: []const i64) !QuerySummaryByIdVO {
        var list: std.ArrayList(SummaryDO) = .empty;
        var s = try self.files.db.prepare(
            path_cte ++ "SELECT f.id, f.name, f.is_folder, f.md5, f.created_at, f.updated_at, t.path " ++
                "FROM files f JOIN tree t ON t.id = f.id WHERE f.id = ?2 AND f.user_id = ?1 AND f.deleted = 0;",
        );
        defer s.finalize();
        for (ids) |raw_id| {
            s.reset();
            // ?1 is the user (the CTE's own parameter), ?2 the file — the CTE
            // owns ?1, so the ids swapped when the path moved into the query.
            s.bindInt(1, @intCast(user_id));
            s.bindInt(2, raw_id);
            if (!try s.step()) continue;
            try list.append(arena, try self.rowToSummaryDO(arena, &s, user_id));
        }
        return .{ .summaryDOList = list.items };
    }

    /// `query/summary/group` → one `SummaryDO` per live folder (the note
    /// libraries), paginated.
    pub fn summaryGroup(self: SyncService, arena: std.mem.Allocator, user_id: u64, page: i32, size: i32) !QuerySummaryVO {
        const total = try self.count(user_id, 1);
        const w = window(total, page, size);

        var list: std.ArrayList(SummaryDO) = .empty;
        var s = try self.files.db.prepare(
            path_cte ++ "SELECT f.id, f.name, f.is_folder, f.md5, f.created_at, f.updated_at, t.path " ++
                "FROM files f JOIN tree t ON t.id = f.id WHERE f.user_id = ?1 AND f.is_folder = 1 AND f.deleted = 0 " ++
                "ORDER BY f.id LIMIT ?2 OFFSET ?3;",
        );
        defer s.finalize();
        s.bindInt(1, @intCast(user_id));
        s.bindInt(2, w.limit);
        s.bindInt(3, w.offset);
        while (try s.step()) try list.append(arena, try self.rowToSummaryDO(arena, &s, user_id));
        return .{
            .totalRecords = total,
            .totalPages = w.total_pages,
            .currentPage = w.current_page,
            .pageSize = w.page_size,
            .summaryDOList = list.items,
        };
    }

    /// Builds a `SummaryDO` from a row of `(id, name, is_folder, md5, created_at,
    /// updated_at, path)` — the path arrives WITH the row now (see `path_cte`),
    /// rather than costing a walk up the tree per row.
    fn rowToSummaryDO(_: SyncService, arena: std.mem.Allocator, s: anytype, user_id: u64) !SummaryDO {
        const id: i64 = s.columnInt(0);
        const name = try arena.dupe(u8, s.columnText(1));
        const is_folder = s.columnInt(2) != 0;
        const md5 = try arena.dupe(u8, s.columnText(3)); // "" for folders
        const created = s.columnInt(4);
        const updated = s.columnInt(5);
        const path = try arena.dupe(u8, s.columnText(6));
        return .{
            .id = id,
            .fileId = id,
            .name = name,
            .userId = @intCast(user_id),
            .sourcePath = path,
            .md5Hash = md5,
            .handwriteMD5 = md5,
            .isSummaryGroup = if (is_folder) "Y" else "N",
            .creationTime = created,
            .lastModifiedTime = updated,
        };
    }
};

// ---- tests ----

const testing = std.testing;
const sqlite = @import("../db/sqlite.zig");
const schema = @import("../db/schema.zig");
const blobstore = @import("../store/blobs.zig");
const thumbstore = @import("../store/thumbs.zig");

const Fixture = struct {
    db: sqlite.Db,
    files: Files,
    tmp: testing.TmpDir,

    fn init() !Fixture {
        var db = try sqlite.Db.openMemory();
        try schema.migrate(db);
        try db.exec("INSERT INTO users(id, email, password_md5, created_at) VALUES(1, 'a@b.c', '0123456789abcdef0123456789abcdef', 0);");
        try db.exec("INSERT INTO capacity(user_id, used_bytes, total_bytes) VALUES(1, 0, 1000000);");
        const tmp = testing.tmpDir(.{});
        const store = try blobstore.BlobStore.init(testing.io, tmp.dir);
        const thumbs_dir = try tmp.dir.createDirPathOpen(testing.io, "thumbs", .{});
        const thumbs = try thumbstore.ThumbStore.init(testing.io, thumbs_dir);
        return .{ .db = db, .files = Files.init(testing.allocator, testing.io, db, store, thumbs), .tmp = tmp };
    }

    fn deinit(f: *Fixture) void {
        f.db.close();
        f.tmp.cleanup();
    }
};

fn putBytes(f: *Fixture, parent: ?u64, name: []const u8, data: []const u8) !u64 {
    var r = std.Io.Reader.fixed(data);
    const e = try f.files.putFile(1, parent, name, &r, null);
    defer testing.allocator.free(e.name);
    if (e.md5) |m| testing.allocator.free(m);
    return e.id;
}

test "window pagination math" {
    const w1 = SyncService.window(10, 0, 4);
    try testing.expectEqual(@as(i64, 0), w1.offset);
    try testing.expectEqual(@as(i64, 4), w1.limit);
    try testing.expectEqual(@as(i32, 3), w1.total_pages); // ceil(10/4)
    const w2 = SyncService.window(10, 2, 4);
    try testing.expectEqual(@as(i64, 8), w2.offset);
    const w3 = SyncService.window(10, 0, 0); // size<=0 → all in one page
    try testing.expectEqual(@as(i64, 10), w3.limit);
    try testing.expectEqual(@as(i32, 1), w3.total_pages);
    const w4 = SyncService.window(0, 0, 10); // empty
    try testing.expectEqual(@as(i32, 0), w4.total_pages);
}

test "summaryHash maps files to VOs with md5 + full path, paginated" {
    var f = try Fixture.init();
    defer f.deinit();
    const note = try f.files.ensureFolderPath(1, "NOTE/Note");
    const a = try putBytes(&f, note, "a.note", "aaaa");
    _ = try putBytes(&f, note, "b.note", "bbbbbb");
    _ = a;

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var sync = SyncService.init(&f.files);

    // Full listing (size 0): both files, folders excluded.
    const all = try sync.summaryHash(arena.allocator(), 1, 0, 0);
    try testing.expectEqual(@as(i64, 2), all.totalRecords);
    try testing.expectEqual(@as(usize, 2), all.summaryInfoVOList.len);
    const first = all.summaryInfoVOList[0];
    try testing.expectEqualStrings("/NOTE/Note/a.note", first.metadataMap.path);
    try testing.expectEqual(@as(usize, 32), first.md5Hash.len);
    try testing.expectEqualStrings(first.md5Hash, first.handwriteMd5); // mirrored

    // Page 1 of size 1 → the second file only.
    const pg = try sync.summaryHash(arena.allocator(), 1, 1, 1);
    try testing.expectEqual(@as(i32, 2), pg.totalPages);
    try testing.expectEqual(@as(i32, 1), pg.currentPage);
    try testing.expectEqual(@as(usize, 1), pg.summaryInfoVOList.len);
    try testing.expectEqualStrings("/NOTE/Note/b.note", pg.summaryInfoVOList[0].metadataMap.path);
}

test "summaryById returns detail for requested ids, scoped and skipping unknowns" {
    var f = try Fixture.init();
    defer f.deinit();
    const id = try putBytes(&f, null, "top.note", "data");

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var sync = SyncService.init(&f.files);

    const vo = try sync.summaryById(arena.allocator(), 1, &.{ @intCast(id), 99999 });
    try testing.expectEqual(@as(usize, 1), vo.summaryDOList.len); // unknown id skipped
    const d = vo.summaryDOList[0];
    try testing.expectEqualStrings("top.note", d.name);
    try testing.expectEqualStrings("/top.note", d.sourcePath);
    try testing.expectEqualStrings("N", d.isSummaryGroup);
    try testing.expectEqual(@as(usize, 32), d.md5Hash.len);

    // A foreign user's request for the same id returns nothing.
    try f.db.exec("INSERT INTO users(id, email, password_md5, created_at) VALUES(2, 'x@y.z', '0123456789abcdef0123456789abcdef', 0);");
    const none = try sync.summaryById(arena.allocator(), 2, &.{@intCast(id)});
    try testing.expectEqual(@as(usize, 0), none.summaryDOList.len);
}

test "summaryGroup lists folders as groups" {
    var f = try Fixture.init();
    defer f.deinit();
    _ = try f.files.ensureFolderPath(1, "NOTE/Note"); // 2 folders
    _ = try putBytes(&f, null, "top.note", "x"); // a file, must NOT appear

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var sync = SyncService.init(&f.files);

    const vo = try sync.summaryGroup(arena.allocator(), 1, 0, 0);
    try testing.expectEqual(@as(i64, 2), vo.totalRecords);
    for (vo.summaryDOList) |g| try testing.expectEqualStrings("Y", g.isSummaryGroup);
}
