//! The history-of-this-file listing.

const std = @import("std");
const controlplane = @import("controlplane.zig");
const ControlPlaneService = controlplane.ControlPlaneService;
const HistoryVersionVO = controlplane.HistoryVersionVO;
const HistoryVO = controlplane.HistoryVO;
const idStr = controlplane.idStr;
const freeEntry = controlplane.freeEntry;
const controlplane_meta = @import("controlplane_meta.zig");

/// `GET /api/controlplane/note/{id}/history` — current blob first, then each
/// retained `file_history` row. Null when missing, not owned, a folder or
/// blob-less.
pub fn history(self: ControlPlaneService, arena: std.mem.Allocator, user_id: u64, id: u64) !?HistoryVO {
    return historyIn(self, arena, user_id, id, .live);
}

/// `GET /api/controlplane/bin/note/{id}/history` — the same for a trashed file
/// (view-only); trash keeps `file_history`.
pub fn binHistory(self: ControlPlaneService, arena: std.mem.Allocator, user_id: u64, id: u64) !?HistoryVO {
    return historyIn(self, arena, user_id, id, .trashed);
}

pub fn historyIn(self: ControlPlaneService, arena: std.mem.Allocator, user_id: u64, id: u64, scope: controlplane_meta.ReadScope) !?HistoryVO {
    const entry = (try controlplane_meta.lookup(self, scope, user_id, id)) orelse return null;
    defer freeEntry(self.files.gpa, entry);
    if (entry.is_folder) return null;
    const cur_md5 = entry.md5 orelse return null; // a blob-less file has no versions

    var out: std.ArrayList(HistoryVersionVO) = .empty;
    // The current version leads, timestamped by `updated_at`.
    try out.append(arena, .{
        .md5 = try arena.dupe(u8, cur_md5),
        .size = @intCast(entry.size),
        .createdAt = entry.updated_at * 1000, // epoch s → ms
        .pageCount = try self.pageCountOf(cur_md5),
        .current = true,
    });
    for (try self.files.fileHistoryIn(scope, arena, user_id, id)) |v| {
        // A just-restored version may still have a row equal to the current blob.
        if (std.mem.eql(u8, &v.md5, cur_md5)) continue;
        try out.append(arena, .{
            .md5 = try arena.dupe(u8, &v.md5),
            .size = @intCast(v.size),
            .createdAt = v.created_at * 1000,
            .pageCount = try self.pageCountOf(&v.md5),
        });
    }
    return .{ .id = try idStr(arena, id), .versions = out.items };
}
