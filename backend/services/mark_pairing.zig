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
        " AND EXISTS (SELECT 1" ++ docOfMark(a, deleted) ++ "))";
}

/// SQL: the document id the `.mark` row `a` is the ink of, or NULL. `deleted`
/// as in `hidePairedMark`, whose set it matches.
pub fn pairedDocId(comptime a: []const u8, comptime deleted: []const u8) []const u8 {
    return "(SELECT p.id" ++ docOfMark(a, deleted) ++ " LIMIT 1)";
}

/// SQL: the `.mark` id carried by document row `a`, or NULL. A subquery (one
/// index seek inside the caller's statement) rather than a per-row
/// `liveMarkIdFor` call. `deleted` as in `hidePairedMark`: "0" pairs a live
/// document with its live mark, "1" a trashed one with the mark it went to the
/// bin with (`inBin`). Same guards as `hidePairedMark`.
pub fn pairedMarkId(comptime a: []const u8, comptime deleted: []const u8) []const u8 {
    return "(SELECT m.id FROM files m" ++
        " WHERE " ++ a ++ ".is_folder = 0" ++
        " AND substr(" ++ a ++ ".name, -" ++ mark_len ++ ") <> '" ++ mark_ext ++ "'" ++
        " AND m.user_id = " ++ a ++ ".user_id" ++
        " AND COALESCE(m.parent_id, 0) = COALESCE(" ++ a ++ ".parent_id, 0)" ++
        " AND m.name = " ++ a ++ ".name || '" ++ mark_ext ++ "'" ++
        " AND m.is_folder = 0 AND m.deleted = " ++ deleted ++
        inBin(deleted, "m", a) ++ " LIMIT 1)";
}

/// `FROM ... WHERE ...` of the document the mark row `a` names, in `deleted`.
fn docOfMark(comptime a: []const u8, comptime deleted: []const u8) []const u8 {
    return " FROM files p" ++
        " WHERE p.user_id = " ++ a ++ ".user_id" ++
        " AND COALESCE(p.parent_id, 0) = COALESCE(" ++ a ++ ".parent_id, 0)" ++
        " AND p.name = substr(" ++ a ++ ".name, 1, length(" ++ a ++ ".name) - " ++ mark_len ++ ")" ++
        " AND substr(p.name, -" ++ mark_len ++ ") <> '" ++ mark_ext ++ "'" ++
        " AND p.is_folder = 0 AND p.deleted = " ++ deleted ++
        inBin(deleted, a, "p");
}

/// The library holds one row per name, so a name is the pair. The bin can hold
/// several: there a mark is the ink of the document it was trashed with. Both
/// halves always go to the bin in one transaction under one timestamp, whichever was deleted
/// (`Files.trash`), so they share `deleted_at`; a document trashed again later,
/// alone, takes no ink that was never on it. A mark trashed alone is restored
/// alone, and then pairs by name like any other: with a live document of that
/// name, if there is one.
fn inBin(comptime deleted: []const u8, comptime m: []const u8, comptime d: []const u8) []const u8 {
    return if (comptime std.mem.eql(u8, deleted, "1"))
        " AND COALESCE(" ++ m ++ ".deleted_at, 0) = COALESCE(" ++ d ++ ".deleted_at, 0)"
    else
        "";
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
