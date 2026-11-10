//! How much of the person's handwriting search can find. Only what the tablet
//! recognized is searchable (`note_index`'s `RECOGNTEXT`); this counts, per
//! live note, the pages with writing, how many of them were recognized, how
//! many the tablet was still recognizing when it synced, and whether
//! recognition is switched on for the note at all. Blank pages are not
//! counted: there is nothing on them to find.

const std = @import("std");
const sqlite = @import("../../db/sqlite.zig");

pub const NoteCoverage = struct {
    file_id: u64,
    /// `FILE_RECOGN_TYPE` 1: the tablet recognizes this note's handwriting.
    recognition: bool,
    /// Pages with writing: inked (or not scanned yet), or with text.
    /// The tablet also "recognizes" blank pages, to nothing; those don't count.
    written: u32,
    /// Of those, searchable: recognized, or with typed text.
    recognized: u32,
    /// `RECOGNSTATUS` 2: the tablet had not finished when it synced.
    running: u32,
};

/// One query over the person's live `.note` files with writing on them. A
/// page "with writing": `has_ink` not 0 (NULL, not scanned yet, counts: better
/// to say a page may be unsearchable than to hide it), or recognized to text.
const written = "(p.has_ink IS NOT 0 OR length(p.text) > 0)";
/// Searchable: recognised, or with typed text (which needs no recognition).
const searchable = "(p.recogn_status = 1 OR length(p.text) > 0)";
const sql =
    "SELECT f.id, n.recogn_type = '1', SUM(" ++ written ++ "), SUM(" ++ searchable ++ " AND " ++ written ++ ")," ++
    " SUM(p.recogn_status = 2 AND " ++ written ++ ")" ++
    " FROM files f JOIN note_index n ON n.blob_md5 = f.md5 JOIN note_page_index p ON p.blob_md5 = f.md5" ++
    " WHERE f.user_id = ?1 AND f.deleted = 0 AND f.is_folder = 0 AND lower(f.name) LIKE '%.note' AND n.indexable = 1" ++
    " GROUP BY f.id HAVING SUM(" ++ written ++ ") > 0 ORDER BY f.id;";

pub fn coverage(arena: std.mem.Allocator, db: sqlite.Db, user_id: u64) ![]const NoteCoverage {
    var s = try db.prepare(sql);
    defer s.finalize();
    s.bindInt(1, @intCast(user_id));
    var out: std.ArrayList(NoteCoverage) = .empty;
    while (try s.step()) {
        try out.append(arena, .{
            .file_id = @intCast(s.columnInt(0)),
            .recognition = s.columnInt(1) == 1,
            .written = @intCast(s.columnInt(2)),
            .recognized = @intCast(s.columnInt(3)),
            .running = @intCast(s.columnInt(4)),
        });
    }
    return out.items;
}

// ---- tests ----

const testing = std.testing;
const fixture = @import("index_export/fixture.zig");
const nb = @import("note_builder");

fn putNote(f: *fixture.Fixture, name: []const u8, on: bool, statuses: []const u8, inked: []const bool) !u64 {
    const pages = try f.a().alloc(nb.PageSpec, statuses.len);
    for (pages, statuses, inked) |*p, st, ink| p.* = .{
        .layers = if (ink) &.{.{ .slot = .main, .bitmap = "AAAA" }} else &.{},
        .recogn_status = st,
        .recogn_labels = if (st == 1 and ink) &.{"palavra"} else if (st == 1) &.{} else null,
    };
    const bytes = try nb.serialize(testing.allocator, .{
        .header = &.{.{ .key = "FILE_RECOGN_TYPE", .value = if (on) "1" else "0" }},
        .pages = pages,
    });
    defer testing.allocator.free(bytes);
    return f.putBytes(1, name, bytes);
}

test "counts written, recognized and still-running pages per note, and whether recognition is on" {
    var f = try fixture.Fixture.init();
    defer f.deinit();
    // The last page is blank and "recognized" to nothing, as the tablet does.
    const on = try putNote(&f, "Aula.note", true, &.{ 1, 0, 2, 0, 1 }, &.{ true, true, true, false, false });
    const off = try putNote(&f, "Diário.note", false, &.{ 0, 0 }, &.{ true, true });
    _ = try putNote(&f, "Branco.note", true, &.{ 0, 0 }, &.{ false, false });
    _ = try f.putBytes(1, "livro.pdf", "%PDF-1.4 x");
    f.drain();

    const got = try coverage(f.a(), f.db, 1);
    try testing.expectEqual(@as(usize, 2), got.len); // the blank note has nothing to find
    try testing.expectEqual(NoteCoverage{ .file_id = on, .recognition = true, .written = 3, .recognized = 1, .running = 1 }, got[0]);
    try testing.expectEqual(NoteCoverage{ .file_id = off, .recognition = false, .written = 2, .recognized = 0, .running = 0 }, got[1]);
}

test "only the caller's live notes" {
    var f = try fixture.Fixture.init();
    defer f.deinit();
    const id = try putNote(&f, "Aula.note", true, &.{1}, &.{true});
    f.drain();
    try testing.expectEqual(@as(usize, 0), (try coverage(f.a(), f.db, 2)).len);
    try f.files.trash(1, id);
    try testing.expectEqual(@as(usize, 0), (try coverage(f.a(), f.db, 1)).len);
}

test "a never-recognised note with typed text counts its page as searchable" {
    var f = try fixture.Fixture.init();
    defer f.deinit();
    const id = try f.putBytes(1, "Standard.note", @embedFile("textbox_recognition_off.note"));
    f.drain();
    const got = try coverage(f.a(), f.db, 1);
    try testing.expectEqual(@as(usize, 1), got.len);
    try testing.expectEqual(NoteCoverage{ .file_id = id, .recognition = false, .written = 1, .recognized = 1, .running = 0 }, got[0]);
}
