//! **THE PAIRING RULE** — the one fact that a `.mark` file is not a document
//! but the ink belonging to one, expressed in the several places a query needs
//! it and generated from a single source so those cannot drift.
//!
//! Three expressions of it live here: `hidePairedMark` (is this row ink hiding
//! behind its document?), `pairedMarkId` (which row is this document's ink?)
//! and `markStemOf` (the Zig side — what document would this name be ink for?).
//! The comptime SQL generators are applied by whichever statement needs them,
//! under whatever table alias that statement gave `files`; the applied
//! constants belong to their callers, not here.
//!
//! `Files.liveMarkIdFor` is the fourth expression and stays a method on `Files`
//! — it is a prepared statement over the connection, not a generator.

const std = @import("std");

/// What the device appends — never substitutes — to a document's FULL name to
/// name the file its ink goes in: `foo.pdf` -> `foo.pdf.mark`
/// (`parsers/note/note-format.md` §13.2).
pub const mark_ext = ".mark";

/// `mark_ext.len` as a SQL literal, so the `substr` offsets below cannot drift
/// from the string they are slicing off.
const mark_len = std.fmt.comptimePrint("{d}", .{mark_ext.len});

/// THE PAIRING RULE, as SQL, generated once for whichever listing applies it.
/// `a` is the alias the outer query gave `files`; `deleted` is the state the
/// two members must SHARE ("0" for the library, "1" for the bin).
///
/// The device writes annotations to a SEPARATE file named after the annotated
/// document's full name plus `.mark`. That file is not a document but a layer
/// belonging to one, so a pair is ONE row wherever files are listed, and the
/// row is the document's.
///
/// **RELATIONAL, NOT A FORMAT WHITELIST.** A row is a paired mark iff a
/// SIBLING file exists whose `name || '.mark'` is this row's name. Nothing here
/// asks what the document is: the device annotates formats this server does not
/// render (EPUB, and the set is open), and a `%.pdf.mark` gate left an
/// annotated `book.epub.mark` listing as a file of its own, not travelling with
/// its document through trash/restore/move, and surfacing in search.
/// Enumerating the extensions we know about is the same bug with more entries.
///
/// The rule refuses a CHAIN: the document may not itself end in `.mark`
/// (`substr(p.name, -5) <> '.mark'`). Without that, `a`, `a.mark` and
/// `a.mark.mark` hide as a chain of pairs while `pairOf` — which matches one
/// partner, not a chain — carries only two of the three, and the leftover is
/// un-hidden by the very delete meant to take it.
///
/// **NEITHER HALF IS EVER A FOLDER** (`is_folder = 0` on BOTH sides). Without
/// it on the mark side, a folder called `plan.pdf.mark` beside a file
/// `plan.pdf` is hidden from every listing — its whole subtree unreachable
/// behind it — then left where it stood by the delete that took `plan.pdf`, at
/// which point it reappears. Ink is a file, and `pairOf` already returns null
/// for a folder outright.
///
/// **Both members must be in the SAME state**, which is why `deleted` is a
/// parameter rather than a literal `0`. A live document and a trashed mark are
/// not a pair — the mark is in the bin as a thing of its own. This is exactly
/// the state `pairOf` matches, so what a listing folds away is precisely what a
/// mutation carries: nothing can be hidden here and left behind there (a
/// trashed PDF un-hiding its mark conjures a file the user never made).
///
/// An ORPHANED mark still lists. With no document beside it in the same state
/// the mark is the only remaining trace of that ink, and hiding it would make
/// it unreachable through the UI while it went on consuming quota.
///
/// SHARED BY `list`, `childCount`, `liveSubtreeCount` and the bin listing —
/// which is why it is generated rather than typed out, and why it is `pub`:
/// copies of a predicate this fiddly do not stay equal, and a count that
/// disagreed with the listing beside it is the bin leaking back into view.
///
/// Cost is one index seek per `.mark` in the folder and none for anything else:
/// the suffix test fails first for every other row, and the `EXISTS` rides the
/// `files_live_name` UNIQUE index. The tail is matched case-SENSITIVELY
/// (`substr(name, -5)`) and the stem exactly, because those are the two things
/// `pairOf` can look up by equality — the predicate and the lookup have to
/// admit the same set or the gap between them is a bug. A row named exactly
/// `.mark` has an empty stem, which matches no name, so it is an orphan and
/// lists — same answer in both.
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

/// The rule read from the DOCUMENT's side — "does this file carry ink" to
/// `hidePairedMark`'s "is this file the ink" — answering with the mark's ID
/// rather than a boolean: a correlated scalar subquery over the row aliased
/// `a`, yielding the live `.mark`'s `id` or SQL NULL.
///
/// **Both readers of the document's side ask it through this.** A LISTING
/// carries the id itself; the search index's tier-2 ladder
/// (`index_export.zig`) wants only the boolean and spells it
/// `pairedMarkId(a) IS NOT NULL`. The two admit exactly the same set (`m.id` is
/// a rowid primary key and so never NULL, the same WHERE decides both, and
/// `files_live_name` admits at most one row), so there is one predicate rather
/// than two to drift.
///
/// `liveMarkIdFor` is the per-file lookup and stays that: called once per
/// listing row it would be one extra prepared statement per card, which on a
/// 200-file folder is 200 extra statements on a Raspberry Pi. As a subquery it
/// is one index seek per file row inside the caller's own statement.
///
/// The two guards on `a` sit inside the subquery's WHERE because a scalar
/// subquery has nowhere else to put them; they are constant per outer row, and
/// failing either yields no row and therefore NULL. `a.is_folder = 0` — a
/// folder is never half of a pair, in either direction. The `.mark` tail test
/// on `a` refuses chains, the same exclusion `markStemOf` makes.
///
/// LIVE ONLY (`m.deleted = 0`), like `liveMarkIdFor` and unlike `pairOf`: this
/// is a read for the library's view, and a trashed mark is not ink anyone can
/// be shown. Which SCOPE of row it is asked ABOUT is the caller's to get right
/// — see `Entry.mark_id`.
pub fn pairedMarkId(comptime a: []const u8) []const u8 {
    return "(SELECT m.id FROM files m" ++
        " WHERE " ++ a ++ ".is_folder = 0" ++
        " AND substr(" ++ a ++ ".name, -" ++ mark_len ++ ") <> '" ++ mark_ext ++ "'" ++
        " AND m.user_id = " ++ a ++ ".user_id" ++
        " AND COALESCE(m.parent_id, 0) = COALESCE(" ++ a ++ ".parent_id, 0)" ++
        " AND m.name = " ++ a ++ ".name || '" ++ mark_ext ++ "'" ++
        " AND m.is_folder = 0 AND m.deleted = 0)";
}

/// The name of the document `name` would be the ink for — `foo.epub.mark` ->
/// `foo.epub` — or null when it could not be anybody's mark. THE ZIG SIDE OF
/// `hidePairedMark`, and it must admit exactly the same set: the `.mark` tail
/// exact (it is what the rule appends and looks up by equality), the stem
/// non-empty (a bare `.mark` names nothing, and no row is named "") and the
/// stem not itself a mark (no chains — see there).
///
/// What the stem's EXTENSION looks like is deliberately not asked. Whether the
/// mark is actually paired is a question about the folder rather than the
/// name, and only `pairOf` and the SQL answer that.
pub fn markStemOf(name: []const u8) ?[]const u8 {
    if (!std.mem.endsWith(u8, name, mark_ext)) return null;
    const stem = name[0 .. name.len - mark_ext.len];
    if (stem.len == 0 or std.mem.endsWith(u8, stem, mark_ext)) return null;
    return stem;
}
