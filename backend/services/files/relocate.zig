//! Moving and copying entries, pairs included, without cycles.

const std = @import("std");
const markpair = @import("../mark_pairing.zig");
const internal = @import("internal.zig");
const bin = @import("bin.zig");
const filesmod = @import("../files.zig");
const Files = filesmod.Files;
const md5_len = filesmod.md5_len;
const Entry = filesmod.Entry;

/// Moves and/or renames a live entry in one transaction. Paths are not
/// materialized, so a folder's subtree follows for free.
///   - Same parent and name is a no-op without a sync bump.
///   - A taken name: ` (n)` with `autorename`, else NameConflict; never clobber.
///   - Adopting a stranger's `.mark` (or becoming one) counts as a conflict.
///   - A folder may not move into its own subtree (InvalidMove).
///   - A pair moves and renames as one; the mark's name follows the document's
///     final name. A rename that would unpair them is InvalidMove: a document
///     may not take a `.mark` name; a mark may only take names `markStemOf`
///     accepts.
/// NotFound if absent, foreign or trashed. Caller frees `.name` / `.md5`.
pub fn move(self: Files, user_id: u64, id: u64, new_parent_id: ?u64, new_name: []const u8, autorename: bool) !Entry {
    if (new_name.len == 0) return error.NameConflict;
    try internal.assertFolder(self, user_id, new_parent_id);

    // Trashed / absent / foreign is NotFound (the handler treats it as success).
    var is_folder = false;
    var md5buf: [md5_len]u8 = undefined;
    var has_md5 = false;
    var size: u64 = 0;
    {
        var r = (try self.db.row(
            "SELECT is_folder, md5, size FROM files WHERE id = ?1 AND user_id = ?2 AND deleted = 0;",
            &.{ .{ .int = @intCast(id) }, .{ .int = @intCast(user_id) } },
        )) orelse return error.NotFound;
        defer r.finalize();
        is_folder = r.int(0) != 0;
        const m = r.text(1);
        if (m.len == md5_len) {
            @memcpy(&md5buf, m);
            has_md5 = true;
        }
        size = @intCast(r.int(2));
    }

    if (is_folder and try wouldCycle(self, user_id, new_parent_id, id)) return error.InvalidMove;

    // The rule, spent once (see `pairOf`).
    const partner = try internal.pairOf(self, user_id, id);

    // The document's requested name anchors both rows.
    var pdf_want: []const u8 = new_name;
    if (partner) |p| {
        if (p.entry_is_mark) {
            pdf_want = markpair.markStemOf(new_name) orelse return error.InvalidMove;
        } else if (std.mem.endsWith(u8, new_name, markpair.mark_ext)) {
            // A document ending in `.mark` would make a chain, unpairing them.
            return error.InvalidMove;
        }
    }

    var owned_pdf: ?[]u8 = null; // the PDF's name, when autorename produced one
    defer if (owned_pdf) |n| self.gpa.free(n);
    var owned_mark: ?[]u8 = null; // the mark's, always derived from the PDF's
    defer if (owned_mark) |n| self.gpa.free(n);
    var final_name: []const u8 = new_name; // the ENTRY's, whichever member it is
    var pdf_final: []const u8 = pdf_want; // the anchor the mark's is built from
    if (partner) |p| {
        const pdf_id = if (p.entry_is_mark) p.id else id;

        // Already in place: a true no-op.
        if (try internal.liveChild(self, user_id, new_parent_id, pdf_want)) |occ| {
            if (occ.id == pdf_id) return (try self.get(user_id, id)) orelse error.NotFound;
        }

        // Both targets must be free at the same ` (n)`.
        if (!try bin.nameFree(self, user_id, new_parent_id, pdf_want, markpair.mark_ext)) {
            if (!autorename) return error.NameConflict; // never clobber, never unpair
            owned_pdf = try bin.freeName(self, user_id, new_parent_id, pdf_want, markpair.mark_ext);
            pdf_final = owned_pdf.?;
        }
        owned_mark = try std.fmt.allocPrint(self.gpa, "{s}" ++ markpair.mark_ext, .{pdf_final});
        final_name = if (p.entry_is_mark) owned_mark.? else pdf_final;
    } else {
        // Checked first: `bin.nameFree` would count the row's own name as taken.
        if (try internal.liveChild(self, user_id, new_parent_id, new_name)) |occ| {
            if (occ.id == id) return (try self.get(user_id, id)) orelse error.NotFound;
        }

        // This unpaired row must not walk into an existing pairing (an orphan
        // `.mark` at the new name, or as a mark becoming someone's ink). Same
        // posture as `restore`'s paired arm; `restore`'s unpaired arm deliberately
        // re-pairs because it returns a row to its own name. Folders never pair.
        const pair_guard: ?[]const u8 = if (is_folder) null else markpair.mark_ext;
        if (!try bin.nameFree(self, user_id, new_parent_id, new_name, pair_guard)) {
            if (!autorename) return error.NameConflict; // never clobber, never adopt
            owned_pdf = try bin.freeName(self, user_id, new_parent_id, new_name, pair_guard);
            final_name = owned_pdf.?;
        }
    }

    const ts = internal.now(self);
    try self.db.exec("BEGIN IMMEDIATE;");
    errdefer self.db.exec("ROLLBACK;") catch {};
    {
        var s = try self.db.prepare(
            "UPDATE files SET parent_id = ?1, name = ?2, updated_at = ?3 WHERE id = ?4 AND user_id = ?5;",
        );
        defer s.finalize();
        internal.bindOpt(s, 1, new_parent_id);
        s.bindText(2, final_name);
        s.bindInt(3, ts);
        s.bindInt(4, @intCast(id));
        s.bindInt(5, @intCast(user_id));
        _ = try s.step();
    }
    if (partner) |p| {
        // Names fall out of the anchor, not out of what each row had.
        var s = try self.db.prepare(
            "UPDATE files SET parent_id = ?1, name = ?2, updated_at = ?3 WHERE id = ?4 AND user_id = ?5;",
        );
        defer s.finalize();
        internal.bindOpt(s, 1, new_parent_id);
        s.bindText(2, if (p.entry_is_mark) pdf_final else owned_mark.?);
        s.bindInt(3, ts);
        s.bindInt(4, @intCast(p.id));
        s.bindInt(5, @intCast(user_id));
        _ = try s.step();
    }
    try internal.bumpSync(self, user_id);
    try self.db.exec("COMMIT;");

    return .{
        .id = id,
        .parent_id = new_parent_id,
        .name = try self.gpa.dupe(u8, final_name),
        .is_folder = is_folder,
        .md5 = if (has_md5) try self.gpa.dupe(u8, &md5buf) else null,
        .size = size,
        .updated_at = ts,
        // After the move: the pair travelled together.
        .mark_id = if (is_folder) null else try self.liveMarkIdFor(user_id, new_parent_id, final_name),
    };
}

/// Copies a live file: a second row on the same blob, an `incref`. No
/// derived state is redone and, since quota is per distinct blob per user,
/// copying your own file costs nothing. Name rules as in `move`. IsFolder:
/// folders are not deep-copied. Caller frees `.name` / `.md5`.
pub fn copy(self: Files, user_id: u64, id: u64, new_parent_id: ?u64, new_name: []const u8, autorename: bool) !Entry {
    if (new_name.len == 0) return error.NameConflict;
    try internal.assertFolder(self, user_id, new_parent_id);

    var md5buf: [md5_len]u8 = undefined;
    var size: u64 = 0;
    {
        var r = (try self.db.row(
            "SELECT is_folder, md5, size FROM files WHERE id = ?1 AND user_id = ?2 AND deleted = 0;",
            &.{ .{ .int = @intCast(id) }, .{ .int = @intCast(user_id) } },
        )) orelse return error.NotFound;
        defer r.finalize();
        if (r.int(0) != 0) return error.IsFolder; // no recursive folder copy
        const m = r.text(1);
        if (m.len != md5_len) return error.NotFound; // a file with no blob is nothing to copy
        @memcpy(&md5buf, m);
        size = @intCast(r.int(2));
    }
    const md5: []const u8 = &md5buf;

    // Any occupant, the source included, is a conflict: a copy is always new.
    var owned_name: ?[]u8 = null;
    defer if (owned_name) |n| self.gpa.free(n);
    var final_name: []const u8 = new_name;
    if (try internal.liveChild(self, user_id, new_parent_id, new_name)) |_| {
        if (!autorename) return error.NameConflict;
        owned_name = try bin.freeName(self, user_id, new_parent_id, new_name, null);
        final_name = owned_name.?;
    }

    const ts = internal.now(self);
    try self.db.exec("BEGIN IMMEDIATE;");
    errdefer self.db.exec("ROLLBACK;") catch {};

    try internal.ensureBlobRow(self, md5, size); // idempotent — the source already made it

    // Zero for a copy of one's own file; computed as uploads do.
    const delta: i64 = if (try internal.userChargedRefs(self, user_id, md5) == 0) @intCast(size) else 0;

    var file_id: u64 = undefined;
    {
        var s = try self.db.prepare(
            "INSERT INTO files(user_id, parent_id, name, is_folder, md5, size, created_at, updated_at) VALUES(?1,?2,?3,0,?4,?5,?6,?6);",
        );
        defer s.finalize();
        s.bindInt(1, @intCast(user_id));
        internal.bindOpt(s, 2, new_parent_id);
        s.bindText(3, final_name);
        s.bindText(4, md5);
        s.bindInt(5, @intCast(size));
        s.bindInt(6, ts);
        _ = try s.step();
        file_id = @intCast(self.db.lastInsertRowId());
    }

    try internal.incref(self, md5);

    const cap = try self.capacity(user_id);
    if (cap.used + delta > cap.total) return error.QuotaExceeded; // errdefer rolls back
    try internal.addUsed(self, user_id, delta);

    try internal.bumpSync(self, user_id); // the tree gained a row
    try self.db.exec("COMMIT;");

    return .{
        .id = file_id,
        .parent_id = new_parent_id,
        .name = try self.gpa.dupe(u8, final_name),
        .is_folder = false,
        .md5 = try self.gpa.dupe(u8, md5),
        .size = size,
        .updated_at = ts,
        // Asked of the destination name, after any suffix.
        .mark_id = try self.liveMarkIdFor(user_id, new_parent_id, final_name),
    };
}

/// Whether moving folder `id` under `new_parent` would create a cycle (walks
/// up from `new_parent`, 256-hop guard).
fn wouldCycle(self: Files, user_id: u64, new_parent: ?u64, id: u64) !bool {
    var cur = new_parent;
    var guard: usize = 0;
    while (cur) |c| {
        if (c == id) return true;
        guard += 1;
        if (guard > 256) break;
        cur = try internal.parentOf(self, user_id, c);
    }
    return false;
}
