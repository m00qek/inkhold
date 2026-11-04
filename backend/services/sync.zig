//! Device-sync read path: projects `files` rows into the sync VOs. Sync is
//! hash-diff (no per-device cursors), so this is a paginated projection. VO
//! field names mirror docs/supernote-api.openapi.yaml.

const std = @import("std");
const Files = @import("files.zig").Files;

// ---- response VOs ----

/// The device wants `metadataMap` as string→string; we send the full path.
pub const MetadataMap = struct { path: []const u8 };

pub const SummaryInfoVO = struct {
    id: i64,
    userId: i64,
    md5Hash: []const u8,
    /// A `.note`'s separate "handwrite" md5; mirrors the file md5 until we learn
    /// which one drives the device's diff.
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

/// Full per-entry detail; unsourced fields are omitted.
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
    /// Every live folder's path for one user. Folders only, so a file's path is
    /// its parent's plus its name and the work stays O(folders) rather than
    /// O(library). `CROSS JOIN` pins `dirs` as the outer loop so children are
    /// seeked by `(user_id, parent_id, deleted)`; a plain `JOIN` is correct but
    /// lets SQLite rescan the user's files per level. A plan-pin test guards it.
    const dirs_cte =
        \\WITH RECURSIVE dirs(id,path) AS (
        \\  SELECT id, '/'||name FROM files WHERE user_id=?1 AND parent_id IS NULL AND deleted=0 AND is_folder=1
        \\  UNION ALL
        \\  SELECT f.id, d.path||'/'||f.name FROM dirs d CROSS JOIN files f ON f.parent_id=d.id
        \\  WHERE f.user_id=?1 AND f.deleted=0 AND f.is_folder=1
        \\)
    ;

    /// Root rows have no parent folder; `COALESCE` keeps exactly one leading slash.
    const path_col = "COALESCE(d.path,'')||'/'||f.name";

    /// LEFT so root rows survive. Relies on a live row's ancestors all being live
    /// (`trash` takes the subtree, `restore` revives ancestors).
    const path_join = " FROM files f LEFT JOIN dirs d ON d.id = f.parent_id ";

    const summary_cols = "SELECT f.id, f.name, f.is_folder, f.md5, f.created_at, f.updated_at, " ++ path_col;

    /// Named so the plan-pin tests `EXPLAIN` the exact strings. ?1 = user, ?2/?3 =
    /// the window (or the file id).
    const summary_hash_sql = dirs_cte ++
        "SELECT f.id, f.md5, f.updated_at, " ++ path_col ++ path_join ++
        "WHERE f.user_id = ?1 AND f.is_folder = 0 AND f.deleted = 0 ORDER BY f.id LIMIT ?2 OFFSET ?3;";
    const summary_by_id_sql = dirs_cte ++ summary_cols ++ path_join ++
        "WHERE f.id = ?2 AND f.user_id = ?1 AND f.deleted = 0;";
    const summary_group_sql = dirs_cte ++ summary_cols ++ path_join ++
        "WHERE f.user_id = ?1 AND f.is_folder = 1 AND f.deleted = 0 ORDER BY f.id LIMIT ?2 OFFSET ?3;";

    files: *Files,

    pub fn init(files: *Files) SyncService {
        return .{ .files = files };
    }

    const Window = struct { offset: i64, limit: i64, total_pages: i32, page_size: i32, current_page: i32 };

    /// `page` is 0-based; `size <= 0` means everything in one page.
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

    /// `query/summary/hash`: one entry per live file, allocated in `arena`.
    pub fn summaryHash(self: SyncService, arena: std.mem.Allocator, user_id: u64, page: i32, size: i32) !QuerySummaryMD5HashVO {
        const total = try self.count(user_id, 0);
        const w = window(total, page, size);

        var list: std.ArrayList(SummaryInfoVO) = .empty;
        var s = try self.files.db.prepare(summary_hash_sql);
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

    /// `query/summary/id`: detail per requested id, scoped to the user (foreign or
    /// unknown ids skipped). Re-runs `dirs_cte` per id, so its size matters here.
    pub fn summaryById(self: SyncService, arena: std.mem.Allocator, user_id: u64, ids: []const i64) !QuerySummaryByIdVO {
        var list: std.ArrayList(SummaryDO) = .empty;
        var s = try self.files.db.prepare(summary_by_id_sql);
        defer s.finalize();
        for (ids) |raw_id| {
            s.reset();
            // ?1 is the CTE's user, ?2 the file.
            s.bindInt(1, @intCast(user_id));
            s.bindInt(2, raw_id);
            if (!try s.step()) continue;
            try list.append(arena, try self.rowToSummaryDO(arena, &s, user_id));
        }
        return .{ .summaryDOList = list.items };
    }

    /// `query/summary/group`: one entry per live folder, paginated.
    pub fn summaryGroup(self: SyncService, arena: std.mem.Allocator, user_id: u64, page: i32, size: i32) !QuerySummaryVO {
        const total = try self.count(user_id, 1);
        const w = window(total, page, size);

        var list: std.ArrayList(SummaryDO) = .empty;
        var s = try self.files.db.prepare(summary_group_sql);
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
    defer e.deinit(testing.allocator);
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

    const all = try sync.summaryHash(arena.allocator(), 1, 0, 0);
    try testing.expectEqual(@as(i64, 2), all.totalRecords);
    try testing.expectEqual(@as(usize, 2), all.summaryInfoVOList.len);
    const first = all.summaryInfoVOList[0];
    try testing.expectEqualStrings("/NOTE/Note/a.note", first.metadataMap.path);
    try testing.expectEqual(@as(usize, 32), first.md5Hash.len);
    try testing.expectEqualStrings(first.md5Hash, first.handwriteMd5); // mirrored

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

// ---- plan pins: only the shape of the work regressed, so only a test that
// reads the shape can catch it ----

/// What the plan's recursive step does to `files`. Must walk the plan tree: the
/// outer page scan legitimately uses `files_user_parent (user_id=?)`; inside
/// the recursion the same string is the regression.
const RecursionShape = struct {
    /// Guards against a pin passing vacuously if the CTE disappears.
    found: bool = false,
    seeks_children: bool = false,
    /// The regression; must stay false.
    scans_the_user: bool = false,
};

fn recursionShape(db: sqlite.Db, comptime sql: []const u8) !RecursionShape {
    var s = try db.prepare("EXPLAIN QUERY PLAN " ++ sql);
    defer s.finalize();
    var out: RecursionShape = .{};
    var step_id: i64 = -1;
    while (try s.step()) {
        const id = s.columnInt(0);
        const parent = s.columnInt(1);
        const detail = s.columnText(3);
        if (std.mem.eql(u8, detail, "RECURSIVE STEP")) {
            step_id = id;
            out.found = true;
            continue;
        }
        if (parent != step_id) continue;
        if (std.mem.indexOf(u8, detail, "files_user_parent") == null) continue;
        if (std.mem.indexOf(u8, detail, "parent_id=?") != null) {
            out.seeks_children = true;
        } else {
            out.scans_the_user = true;
        }
    }
    return out;
}

test "PLAN PIN: all three sync summaries descend the tree folder-by-folder, never re-reading the library per level" {
    var f = try Fixture.init();
    defer f.deinit();
    // Real depth and branching: on an empty table any join order looks the same.
    _ = try f.files.ensureFolderPath(1, "Note/Work/Projects/Archive");
    _ = try f.files.ensureFolderPath(1, "Note/Personal/Journal");
    _ = try f.files.ensureFolderPath(1, "EXPORT");
    const deep = try f.files.ensureFolderPath(1, "Note/Work/Projects");
    for (0..40) |i| {
        var name: [24]u8 = undefined;
        _ = try putBytes(&f, deep, try std.fmt.bufPrint(&name, "n{d:0>4}.note", .{i}), "x");
    }

    inline for (.{
        SyncService.summary_hash_sql,
        SyncService.summary_by_id_sql,
        SyncService.summary_group_sql,
    }) |sql| {
        const shape = try recursionShape(f.db, sql);
        try testing.expect(shape.found); // the CTE is still a recursion
        try testing.expect(shape.seeks_children); // ... and it seeks by parent_id
        try testing.expect(!shape.scans_the_user); // ... never by user_id alone
    }
}

test "WORK PIN: a note added to the library costs `summary/id` a handful of steps, not a row read and a path built" {
    var f = try Fixture.init();
    defer f.deinit();
    _ = try f.files.ensureFolderPath(1, "Note/Work/Projects/Archive");
    const home = try f.files.ensureFolderPath(1, "Note/Work");
    const bulk = try f.files.ensureFolderPath(1, "Note/Personal/Journal");
    const probe = try putBytes(&f, home, "probe.note", "x");

    // `summary/id` has no window or sort, so every VM step past the lookup is the
    // path recursion. VM steps, not a clock, so it does not flake.
    const steps = struct {
        fn of(db: sqlite.Db, id: u64) !i64 {
            var s = try db.prepare(SyncService.summary_by_id_sql);
            defer s.finalize();
            s.bindInt(1, 1);
            s.bindInt(2, @intCast(id));
            try testing.expect(try s.step());
            return s.vmSteps();
        }
    }.of;

    const n = 300;
    const before = try steps(f.db, probe);
    for (0..n) |i| { // 300 more notes, and NOT one more folder
        var name: [24]u8 = undefined;
        _ = try putBytes(&f, bulk, try std.fmt.bufPrint(&name, "b{d:0>4}.note", .{i}), "y");
    }
    const per_file = @divTrunc((try steps(f.db, probe)) - before, n);

    // A slope bound (measured ~5 vs 32 for whole-tree): loose enough for SQLite
    // opcode churn, tight enough to catch per-file path materialization.
    try testing.expect(per_file <= 10);
}
