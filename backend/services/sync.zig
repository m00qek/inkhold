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
    /// Every live FOLDER's path for one user, computed once by SQLite so a row can
    /// CARRY its path instead of the caller deriving it.
    ///
    /// **It carries only FOLDERS, and that is the whole point.** A file's path is
    /// its parent folder's path plus its own name, so the only thing that has to
    /// be built, materialized and indexed is the directory skeleton — tens of rows
    /// in a household library, against the thousands of notes hanging off it. Drop
    /// the `is_folder=1` arms and this becomes a whole-library materialization
    /// behind a route that then throws all but one page away: 10.96 ms against
    /// 0.57 ms for one 100-row page on the 4x300 corpus, and 872 ms - 1.34 s on
    /// the Pi, where it is the read a device makes on EVERY sync. Same species as
    /// the bin listing and device `list_folder` before it — O(whole library) work
    /// to answer an O(page) question.
    ///
    /// `CROSS JOIN`, not `JOIN`, and it is load-bearing rather than decorative:
    /// SQLite is free to reorder an inner join and picks `SEARCH f USING
    /// files_user_parent (user_id=?)` — a re-read of everything the user owns,
    /// once per level of depth. `CROSS JOIN` pins `dirs` as the outer loop, so
    /// each folder SEEKS its children by `(user_id, parent_id, deleted)`. Worth
    /// 1.87 ms → 0.57 ms on its own, which is the difference between merely
    /// undoing the regression and beating what came before it. A test pins it,
    /// because a plain `JOIN` here is correct and silent.
    ///
    /// **What this does NOT buy, stated so nobody re-derives it from a
    /// disappointment:** the recursion is not O(folders). `files_user_parent` is
    /// keyed on the parent, not on `is_folder`, so seeking a folder's children
    /// still steps over the notes in it before the `is_folder=1` filter drops
    /// them — measured 5.0 VM steps per library file, against 32.0 for the
    /// whole-tree form. Small and linear rather than large and linear. For
    /// `summary/hash` and `summary/group` that residue is beneath their own
    /// `ORDER BY f.id LIMIT`, which sorts the user's files and predates all of
    /// this; for `summary/id` it is the whole remaining cost, and killing it
    /// needs an index keyed on folders. Recorded in `optimizations.md` entry 10,
    /// not built — no measurement demands it yet.
    ///
    /// **Still replaces a `pathOf` call per row**, which is what `6605d69` moved
    /// the path into SQL to buy and what this must not hand back: `pathOf` walks
    /// UP the tree, one query per ancestor, so a page of N files at depth D cost
    /// N x D round trips issued from inside an open cursor. That shape measures
    /// 1.73 ms on the same page, so this is 3.1x faster than the code the
    /// regression replaced, not merely faster than the regression. `pathOf` is
    /// untouched and still the right call for a single path.
    const dirs_cte =
        \\WITH RECURSIVE dirs(id,path) AS (
        \\  SELECT id, '/'||name FROM files WHERE user_id=?1 AND parent_id IS NULL AND deleted=0 AND is_folder=1
        \\  UNION ALL
        \\  SELECT f.id, d.path||'/'||f.name FROM dirs d CROSS JOIN files f ON f.parent_id=d.id
        \\  WHERE f.user_id=?1 AND f.deleted=0 AND f.is_folder=1
        \\)
    ;

    /// The row's own path, assembled from its PARENT folder's. A row at the root
    /// has no parent folder, so `COALESCE` supplies the empty string and both arms
    /// produce exactly one leading slash — `/top.note` and `/NOTE/Note/a.note`.
    /// Works unchanged for a folder row, whose parent is also a folder.
    const path_col = "COALESCE(d.path,'')||'/'||f.name";

    /// Attaches `path_col` to a `files f` row. LEFT, not inner: a root-level row
    /// has no parent folder to match and must still be returned.
    ///
    /// **Invariant it leans on: a live row's ancestors are all live.** `trash()`
    /// tombstones the entire subtree and `restore()` revives trashed ancestors to
    /// make an entry reachable, so `dirs` — which stops at a `deleted` folder —
    /// always contains the parent of every live row. If that invariant were ever
    /// broken, an orphaned file would surface here with a truncated path rather
    /// than vanish from the listing while still being counted in `totalRecords`,
    /// which is what the previous inner join did.
    const path_join = " FROM files f LEFT JOIN dirs d ON d.id = f.parent_id ";

    /// The six columns `rowToSummaryDO` reads, in its order, plus the path.
    const summary_cols = "SELECT f.id, f.name, f.is_folder, f.md5, f.created_at, f.updated_at, " ++ path_col;

    /// The three statements, named so a PLAN PIN test can `EXPLAIN` the exact
    /// string the service runs. ?1 = user, ?2/?3 = the window (or the file id).
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

    /// `query/summary/id` → full `SummaryDO` for each requested id (scoped to the
    /// user; unknown/foreign ids are skipped). Ids come from a prior hash diff.
    ///
    /// **The loop below re-runs `dirs_cte` once per id** — `reset()` discards the
    /// materialized CTE, and a statement cannot cache it across a rebind. That is
    /// why the recursion's size, not just its speed, is what matters on this
    /// route: with a whole-library walk this was the most expensive read on the
    /// device face by a wide margin (50 ids cost 240 ms against 4.3 ms on the
    /// 4x300 corpus, 56x), and it hid behind `summary/hash` because a bench asks
    /// for few ids while a real first sync asks for all of them.
    pub fn summaryById(self: SyncService, arena: std.mem.Allocator, user_id: u64, ids: []const i64) !QuerySummaryByIdVO {
        var list: std.ArrayList(SummaryDO) = .empty;
        var s = try self.files.db.prepare(summary_by_id_sql);
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

    /// Builds a `SummaryDO` from a row of `summary_cols` — `(id, name, is_folder,
    /// md5, created_at, updated_at, path)`. The path arrives WITH the row (see
    /// `dirs_cte`), rather than costing a walk up the tree per row.
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

// ---------------------------------------------------------------------------
// Tests — the plan pins. These exist because `6605d69` regressed device
// `summary/hash` 3-5x on the Pi (252-268 ms p50 → 872 ms-1.34 s, max 1.78 s)
// with a change that read as an optimization and passed every behavioural test
// there was. Only the SHAPE of the work regressed, so only a test that reads
// the shape can catch it. See `docs/scratch/optimizations.md` entry 10.
// ---------------------------------------------------------------------------

/// What the RECURSIVE STEP of a plan actually does to `files`.
///
/// This has to descend the plan tree rather than grep the text: the OUTER query
/// legitimately contains `SEARCH f USING INDEX files_user_parent (user_id=?)`
/// — that is the page scan — and the regression is that same string appearing
/// INSIDE the recursion, where it means "re-read everything this user owns,
/// once per level of depth". `EXPLAIN QUERY PLAN` rows are `(id, parent,
/// notused, detail)`, so the recursion's own loops are the rows whose parent is
/// the `RECURSIVE STEP` row.
const RecursionShape = struct {
    /// A `RECURSIVE STEP` node was found at all — guards against a pin that
    /// passes vacuously if the CTE is ever rewritten away.
    found: bool = false,
    /// Children are reached by an index SEEK on `(user_id, parent_id, deleted)`:
    /// folder-by-folder descent, the good shape.
    seeks_children: bool = false,
    /// The recursion reads `files` by `user_id` alone — a whole-library pass per
    /// level. This is the regression, and it must stay false.
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
    // A tree with real depth and real branching, so the planner has something to
    // choose between: an empty table can make any join order look identical.
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

    // `summary/id` is the sharpest instrument here: no window, no sort, one row
    // out — so every VM step past the point lookup belongs to the path
    // recursion. `summary/hash` cannot say it as cleanly, because its `ORDER BY
    // f.id LIMIT` sorts the user's files and so grows with them by design (it did
    // before `6605d69` too, and this change does not claim to fix that).
    //
    // VM steps rather than a clock: deterministic for a given plan and row set,
    // where a millisecond assertion would flake on a loaded machine.
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

    // MEASURED: 5.0 steps per library file here, against 32.0 for the whole-tree
    // recursion this replaced (247 → 1747 vs 402 → 10002 over the same 300
    // notes). The bound is 10 — loose enough that a SQLite upgrade shuffling
    // opcodes cannot fail it, tight enough that materializing every file's path
    // again cannot pass it. It is a slope, not a ceiling, on purpose: the
    // regression was not that the query was slow, it was that it grew with the
    // library, and a slope is the only thing that says so.
    try testing.expect(per_file <= 10);
}
