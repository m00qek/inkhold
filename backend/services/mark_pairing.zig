//! The `.mark` pairing rule: a `.mark` file is the ink of the sibling document
//! whose full name it extends. SQL generators and the Zig side, from one source.
//! `Files.liveMarkIdFor` is the per-file lookup and stays on `Files`.

const std = @import("std");

/// What the device appends to a document's full name to name its ink file:
/// `foo.pdf` -> `foo.pdf.mark` (`parsers/note/note-format.md` §13.2).
pub const mark_ext = ".mark";

/// `mark_ext.len` as a SQL literal, so `substr` offsets cannot drift.
const mark_len = std.fmt.comptimePrint("{d}", .{mark_ext.len});

/// SQL: is the row aliased `a` a mark hiding behind its document? `deleted` is
/// the state both members must share ("0" library, "1" bin). Relational, not an
/// extension whitelist: the device annotates formats we do not render (EPUB).
/// Neither half is a folder, the document may not itself end in `.mark` (no
/// chains), and an orphaned mark still lists. Must admit exactly the set
/// `pairOf` matches; shared by every listing and count so they cannot disagree.
pub fn hidePairedMark(comptime a: []const u8, comptime deleted: []const u8) []const u8 {
    return " AND NOT (" ++ a ++ ".is_folder = 0" ++
        " AND substr(" ++ a ++ ".name, -" ++ mark_len ++ ") = '" ++ mark_ext ++ "'" ++
        " AND EXISTS (SELECT 1 FROM files p" ++
        " WHERE p.user_id = " ++ a ++ ".user_id" ++
        " AND COALESCE(p.parent_id, 0) = COALESCE(" ++ a ++ ".parent_id, 0)" ++
        " AND p.name = substr(" ++ a ++ ".name, 1, length(" ++ a ++ ".name) - " ++ mark_len ++ ")" ++
        " AND substr(p.name, -" ++ mark_len ++ ") <> '" ++ mark_ext ++ "'" ++
        " AND p.is_folder = 0 AND p.deleted = " ++ deleted ++ "))";
}

/// SQL: the live `.mark` id carried by document row `a`, or NULL. A subquery
/// (one index seek inside the caller's statement) rather than a per-row
/// `liveMarkIdFor` call. Live only; same guards as `hidePairedMark`.
pub fn pairedMarkId(comptime a: []const u8) []const u8 {
    return "(SELECT m.id FROM files m" ++
        " WHERE " ++ a ++ ".is_folder = 0" ++
        " AND substr(" ++ a ++ ".name, -" ++ mark_len ++ ") <> '" ++ mark_ext ++ "'" ++
        " AND m.user_id = " ++ a ++ ".user_id" ++
        " AND COALESCE(m.parent_id, 0) = COALESCE(" ++ a ++ ".parent_id, 0)" ++
        " AND m.name = " ++ a ++ ".name || '" ++ mark_ext ++ "'" ++
        " AND m.is_folder = 0 AND m.deleted = 0)";
}

/// `foo.epub.mark` -> `foo.epub`, or null when `name` cannot be a mark (no
/// `.mark` tail, empty stem, or stem itself a mark). Admits the same set as
/// `hidePairedMark`; whether it is actually paired is `pairOf`'s question.
pub fn markStemOf(name: []const u8) ?[]const u8 {
    if (!std.mem.endsWith(u8, name, mark_ext)) return null;
    const stem = name[0 .. name.len - mark_ext.len];
    if (stem.len == 0 or std.mem.endsWith(u8, stem, mark_ext)) return null;
    return stem;
}
