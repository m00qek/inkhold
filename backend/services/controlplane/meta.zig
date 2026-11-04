//! Note metadata for the reader: lookup by scope, file type, and the per-device geometry.

const std = @import("std");
const Entry = @import("../files.zig").Entry;
const sn = @import("supernote");
const controlplane = @import("../controlplane.zig");
const ControlPlaneService = controlplane.ControlPlaneService;
const NoteMetaVO = controlplane.NoteMetaVO;
const fileTypeFor = controlplane.fileTypeFor;
const idStr = controlplane.idStr;
const freeEntry = controlplane.freeEntry;
const controlplane_index = @import("index.zig");

/// Which state a read may see: `.trashed` for the bin's preview and history
/// endpoints, `.live` otherwise. Same type as `Files.HistoryScope`.
pub const ReadScope = @import("../files.zig").HistoryScope;

/// Each scope refuses the other's rows.
pub fn lookup(self: ControlPlaneService, scope: ReadScope, user_id: u64, id: u64) !?Entry {
    return switch (scope) {
        .live => self.files.get(user_id, id),
        .trashed => self.files.getTrashed(user_id, id),
    };
}

/// `GET /api/controlplane/file/metadata/{id}`. Null if missing, not owned or a
/// folder.
pub fn noteMeta(self: ControlPlaneService, arena: std.mem.Allocator, user_id: u64, id: u64) !?NoteMetaVO {
    return noteMetaIn(self, arena, user_id, id, .live);
}

/// `GET /api/controlplane/bin/file/metadata/{id}` — the same for a trashed file.
pub fn binNoteMeta(self: ControlPlaneService, arena: std.mem.Allocator, user_id: u64, id: u64) !?NoteMetaVO {
    return noteMetaIn(self, arena, user_id, id, .trashed);
}

/// Compares the verified type, never the filename.
pub fn isPdf(file_type: ?[]const u8) bool {
    return file_type != null and std.mem.eql(u8, file_type.?, "pdf");
}

/// The live `.mark` beside `entry` (`foo.pdf` -> `foo.pdf.mark`: the
/// extension is appended, not replaced), or null. Per-file route only;
/// listings use `Entry.mark_id`, and the two are pinned to agree by test.
/// The gate keys off the described type while pairing keys off the name, so
/// a PDF named without the extension still finds its ink. Live only.
fn annotationsIdFor(self: ControlPlaneService, arena: std.mem.Allocator, user_id: u64, entry: Entry) !?[]const u8 {
    const found = (try self.files.liveMarkIdFor(user_id, entry.parent_id, entry.name)) orelse return null;
    return try idStr(arena, found);
}

pub fn noteMetaIn(self: ControlPlaneService, arena: std.mem.Allocator, user_id: u64, id: u64, scope: ReadScope) !?NoteMetaVO {
    const entry = (try lookup(self, scope, user_id, id)) orelse return null;
    defer freeEntry(self.files.gpa, entry);
    if (entry.is_folder) return null;

    const described = try describe(self, arena, entry);
    return .{
        .id = try idStr(arena, id),
        .name = try arena.dupe(u8, entry.name),
        .pages = try controlplane_index.pageRefsOf(self, arena, entry),
        .fileType = described.file_type,
        .fileHash = if (entry.md5) |m| try arena.dupe(u8, m) else null,
        .size = @intCast(entry.size),
        .pxPerMm = described.px_per_mm,
        // Live only: the lookup is live-scoped and must not pair with a
        // trashed document.
        .annotationsId = if (scope == .live and isPdf(described.file_type))
            try annotationsIdFor(self, arena, user_id, entry)
        else
            null,
    };
}

/// `GET /api/controlplane/note/{id}/history/{md5}/meta` — the page list of a
/// retained version, from that version's own `note_index`. Null when `md5` is
/// not a retained version of `id` owned by `user_id`.
pub fn historyNoteMeta(self: ControlPlaneService, arena: std.mem.Allocator, user_id: u64, id: u64, md5: []const u8) !?NoteMetaVO {
    // The gate every per-version endpoint shares.
    const version = (try self.files.historyVersion(user_id, id, md5)) orelse return null;

    const entry = (try lookup(self, .live, user_id, id)) orelse return null;
    defer freeEntry(self.files.gpa, entry);
    if (entry.is_folder) return null;

    // The file's identity with the version's md5 and size. Borrows `entry`'s
    // name and `version.md5`; owns nothing.
    const version_entry: Entry = .{
        .id = entry.id,
        .parent_id = entry.parent_id,
        .name = entry.name,
        .is_folder = false,
        .md5 = &version.md5,
        .size = version.size,
        .updated_at = entry.updated_at,
        // Unused: past ink lives in the mark's own history.
        .mark_id = entry.mark_id,
    };

    const described = try describe(self, arena, version_entry);
    return .{
        .id = try idStr(arena, id),
        .name = try arena.dupe(u8, entry.name),
        .pages = try controlplane_index.pageRefsOf(self, arena, version_entry),
        .fileType = described.file_type,
        .fileHash = try arena.dupe(u8, &version.md5),
        .size = @intCast(version.size),
        .pxPerMm = described.px_per_mm,
    };
}

/// The verified mm→px scale, or null for unknown equipment, a zero width or a
/// non-finite result. Never a plausible fallback: misplaced invisible PDF text
/// goes unnoticed.
pub fn pxPerMmFor(equipment: ?[]const u8, width: i64) ?f32 {
    if (width <= 0) return null;
    const canvas = sn.types.CanvasMm.forEquipment(equipment) orelse return null;
    const scale = canvas.pxPerMm(@intCast(width));
    return if (std.math.isFinite(scale) and scale > 0) scale else null;
}

/// The blob's verified type and mm→px scale, for callers that have only the
/// entry. Shares `fileTypeFor` with `summarize`.
const Described = struct { file_type: []const u8, px_per_mm: ?f32 };

pub fn describe(self: ControlPlaneService, arena: std.mem.Allocator, entry: Entry) !Described {
    var indexable = false;
    var marker: ?[4]u8 = null;
    var px_per_mm: ?f32 = null;
    if (entry.md5) |md5| {
        if (try controlplane_index.indexRowEnsuring(self, md5)) |row| {
            indexable = row.indexable;
            marker = row.filetype;
            px_per_mm = row.px_per_mm;
        }
    }
    return .{
        .file_type = try fileTypeFor(arena, indexable, marker, entry.name),
        .px_per_mm = px_per_mm,
    };
}
