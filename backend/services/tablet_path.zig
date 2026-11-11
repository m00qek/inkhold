//! Where a file the tablet names sits in the library. The tablet's apps name
//! files by their place on its storage: To-Do links by the absolute path
//! (`/storage/emulated/0/Note/a.note`), Digest by the path under the storage
//! root (`MyStyle/Français/b.pdf`). The library files the same folders under
//! the cloud's roots (`NOTE/Note`, `NOTE/MyStyle`, `DOCUMENT/Document`); every
//! other top folder (`EXPORT`, `INBOX`, …) keeps its name.

const std = @import("std");

/// The tablet's storage root.
const storage_root = "/storage/emulated/0/";

const roots = [_]struct { tablet: []const u8, library: []const u8 }{
    .{ .tablet = "Note", .library = "NOTE/Note" },
    .{ .tablet = "MyStyle", .library = "NOTE/MyStyle" },
    .{ .tablet = "Document", .library = "DOCUMENT/Document" },
};

/// An absolute tablet path in the library's form, owned by `arena`; null for
/// one outside the tablet's storage.
pub fn fromAbsolute(arena: std.mem.Allocator, path: []const u8) ?[]const u8 {
    if (!std.mem.startsWith(u8, path, storage_root)) return null;
    return fromStorage(arena, path[storage_root.len..]);
}

/// A path under the tablet's storage root in the library's form, owned by
/// `arena`; null for one with no folder (nothing the cloud syncs lives at the root).
pub fn fromStorage(arena: std.mem.Allocator, path: []const u8) ?[]const u8 {
    const cut = std.mem.indexOfScalar(u8, path, '/') orelse return null;
    if (cut == 0) return null;
    const top = path[0..cut];
    for (roots) |r| if (std.mem.eql(u8, r.tablet, top))
        return std.fmt.allocPrint(arena, "{s}{s}", .{ r.library, path[cut..] }) catch null;
    return path;
}

// ---- tests ----

const testing = std.testing;

test "absolute tablet paths: the cloud's roots, other folders as named, the rest none" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    try testing.expectEqualStrings("NOTE/Note/Français/Apostila.note", fromAbsolute(a, "/storage/emulated/0/Note/Français/Apostila.note").?);
    try testing.expectEqualStrings("NOTE/MyStyle/x.note", fromAbsolute(a, "/storage/emulated/0/MyStyle/x.note").?);
    try testing.expectEqualStrings("DOCUMENT/Document/b.pdf", fromAbsolute(a, "/storage/emulated/0/Document/b.pdf").?);
    try testing.expectEqualStrings("INBOX/a.note", fromAbsolute(a, "/storage/emulated/0/INBOX/a.note").?);
    try testing.expectEqual(@as(?[]const u8, null), fromAbsolute(a, "/sdcard/elsewhere.note"));
}

test "storage-relative paths, as Digest names its sources" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    try testing.expectEqualStrings(
        "NOTE/MyStyle/Français/La_phonetique_du_francais_Prof_Flavio_Adler.pdf",
        fromStorage(a, "MyStyle/Français/La_phonetique_du_francais_Prof_Flavio_Adler.pdf").?,
    );
    try testing.expectEqualStrings("NOTE/Note/20261109_060644.note", fromStorage(a, "Note/20261109_060644.note").?);
    try testing.expectEqual(@as(?[]const u8, null), fromStorage(a, "loose.pdf"));
    try testing.expectEqual(@as(?[]const u8, null), fromStorage(a, ""));
    try testing.expectEqual(@as(?[]const u8, null), fromStorage(a, "/Note/a.note"));
}
