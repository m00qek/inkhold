//! **Is anything drawn on this page?** — the `note_page_index.has_ink`
//! tri-state, computed at ingest and back-filled off the write lock.
//!
//! Two entry points onto one classifier. `pageHasInk` is called by
//! `note_index`'s ingest, with the page in front of it; the `pendingInk` /
//! `scanInk` / `storeInk` trio is what the deferred `ink` tenant drives over
//! rows that predate the column (schema v16), reading the layer ranges the
//! index already recorded rather than re-parsing the container. The two reach
//! the same answer because they are the same function.
//!
//! See §2.1-§2.4 for the rules the classifier encodes: the
//! background does not count, a hidden layer does, and the third state is a
//! withheld answer rather than a guess.

const std = @import("std");
const sqlite = @import("../db/sqlite.zig");
const blobstore = @import("../store/blobs.zig");
const blob_source = @import("../store/blob_source.zig");
const noteindex = @import("note_index.zig");
const sn = @import("supernote");

const Allocator = std.mem.Allocator;

const index_version = noteindex.index_version;
const LayerRef = noteindex.LayerRef;
const max_layers = noteindex.max_layers;
const unpackLayers = noteindex.unpackLayers;

/// The window the INK scan reads a layer in, and it is deliberately NOT
/// `hash_chunk_len`.
///
/// The scan's whole cost story is that it stops at the first stroke, and a
/// caller that pulls 64 KiB before looking at the first byte has already paid
/// for the layer it meant to skip — MEASURED at 26 us/page on the real captures
/// against **1.7 us** here, all of it the window rather than the walk (a safe
/// build fills an `undefined` buffer, and a 64 KiB fill dwarfs the two bytes the
/// answer usually needs).
///
/// 4 KiB is generous for both sides of the question. An inked layer answers out
/// of the first window essentially always. A BLANK one is the case that reads to
/// the end, and it is tiny by construction: RATTA_RLE's longest run is `0x4000`
/// pixels, so a fully transparent 1404x1872 page is ~161 pairs — about 322
/// bytes, one window with room to spare. The widest panel the parser admits is
/// the A5X2/Manta's 1920x2560 (`types.Dimensions.a5x2`), ~300 pairs, ~600 bytes:
/// still one window, at 6.8x margin.
///
/// **THAT MARGIN IS LOAD-BEARING ON THE DEPLOYMENT TARGET, which is why the
/// ARM1176 sweep did not shrink this.** Every window is one
/// `BlobStore.readRange` — an open, a stat, a pread and a close — and that round
/// MEASURES ~100 us on the Pi 1 against the 52 us the 4 KiB fill costs there. A
/// blank layer that spilled into a second window would cost more than shrinking
/// the window ever saves. See `benchInk` for the table.
const ink_chunk_len: usize = 4 * 1024;

/// **Does this page carry a mark?** True when any NON-BACKGROUND layer holds a
/// run whose colour code is not transparent; false when none does; null when a
/// layer could not be READ, which is why the column is a tri-state
/// (§2.4) — the `ink` tenant offers a NULL row again rather than
/// storing a guess.
///
/// **The background is skipped, and that is the definition rather than an
/// optimisation** (§2.1): a page with a full-colour template and nothing written
/// on it is empty in the sense the page index means.
///
/// **A HIDDEN layer counts.** Its bitmap persists in the file and the panel can
/// toggle it back on, so hiding a layer is a view state and not an erasure —
/// which is why nothing here looks at the flag `emitPageLayers` sets.
pub fn pageHasInk(src: sn.Source, layers: []const LayerRef) ?bool {
    var unreadable = false;
    for (layers) |ref| {
        if (ref.slot == .background) continue;
        if (layerHasInk(src, ref.offset, ref.len)) |inked| {
            if (inked) return true;
        } else unreadable = true;
    }
    // An unreadable layer only matters when nothing else answered yes: a page
    // with a stroke on one layer is inked whatever the layer beside it did.
    return if (unreadable) null else false;
}

/// One layer, streamed through `decoder.InkFinder` in `ink_chunk_len` windows —
/// the shape `backgroundIsImage` uses, bounded the same way: scanning a multi-MB
/// layer costs one window of RSS. The window is 4 KiB rather than that
/// function's 64 KiB, worth 16x of this pass's whole measured cost — see
/// `ink_chunk_len`.
///
/// Null — not false — on a read failure. The caller validated every range in
/// bounds before storing it, so this is defensive; but storing `0` for a layer
/// nobody managed to read would tell a reader their written page is empty.
fn layerHasInk(src: sn.Source, offset: u32, len: u32) ?bool {
    var f = sn.decoder.InkFinder.init();
    var chunk: [ink_chunk_len]u8 = undefined;
    var off: u64 = offset;
    var left: u64 = len;
    while (left > 0) {
        const n: usize = @intCast(@min(left, @as(u64, chunk.len)));
        src.read(off, chunk[0..n]) catch return null;
        f.feed(chunk[0..n]);
        if (f.found) return true; // the rest of the layer is never read
        off += n;
        left -= n;
    }
    return f.done();
}

// ---------------------------------------------------------------------------
// `has_ink` — the back-fill for rows that predate the column
// ---------------------------------------------------------------------------

/// THE `ink` TENANT'S PREDICATE: live `.note` blobs holding at least one page
/// nobody has scanned yet. §2.4's back-fill, in the shape
/// `txt_index.pending_from_where` and `pdf_index.pending_from_where` already
/// have — `files` aliased `f`, `blobs` aliased `b`, `note_index` aliased `ni`,
/// bound parameter 1 the note index version.
///
/// **A FROM/WHERE and not a statement, for the reason `txt_index` states:**
/// `deferred.zig` takes `LIMIT 1` from it and `pending.zig` counts over it, and
/// a second hand-written copy is how those two come to disagree. Callers may
/// only ADD a bound.
///
/// **`has_ink IS NULL` is the whole memo, and there is no column beside it.**
/// The other two tenants keep a verdict on `note_index` because their work
/// produces FILES whose absence is not visible in a row; this one's work IS the
/// row. It is also why this needed no `index_version` bump: the rows heal
/// instead of being re-derived.
///
/// `ni.indexable = 1` is the FORMAT question — a real `.note`, verified by the
/// parser rather than claimed by a name — and it is what keeps every `.txt` and
/// `.pdf` out. `p.kind = 0` is belt and braces on the same point.
///
/// The `note_index` join is the ORDER CONTRACT both other tenants inherit: a
/// blob whose row is missing or stale is not offered here, because the note half
/// heals first and its heal REWRITES `has_ink` for every page anyway.
pub const ink_pending_from_where =
    \\  FROM files f
    \\  JOIN blobs b ON b.md5 = f.md5
    \\  JOIN note_index ni ON ni.blob_md5 = f.md5
    \\ WHERE f.is_folder = 0
    \\   AND f.deleted = 0
    \\   AND f.md5 IS NOT NULL
    \\   AND ni.index_version = ?1
    \\   AND ni.indexable = 1
    \\   AND EXISTS (SELECT 1 FROM note_page_index p
    \\               WHERE p.blob_md5 = f.md5 AND p.kind = 0 AND p.has_ink IS NULL)
;

/// Whether this blob still has pages nobody has looked at — the authority the
/// discovery query approximates, and what the worker re-asks UNDER THE LOCK
/// after scanning off it. Same shape as `txt_index.needsDerive`: a missing or
/// stale `note_index` row is `false`, because the note half heals first and its
/// heal fills every page's `has_ink` on the way past.
pub fn inkNeedsScan(db: sqlite.Db, blob_md5: []const u8) !bool {
    const r = (try db.row(
        "SELECT 1 FROM note_page_index p JOIN note_index ni ON ni.blob_md5 = p.blob_md5 " ++
            "WHERE p.blob_md5 = ?1 AND ni.index_version = ?2 AND ni.indexable = 1 " ++
            "AND p.kind = 0 AND p.has_ink IS NULL LIMIT 1;",
        &.{ .{ .text = blob_md5 }, .{ .int = index_version } },
    )) orelse return false;
    r.finalize();
    return true;
}

/// One blob's outstanding ink questions, lifted out of the database so the scan
/// itself can run off the lock.
///
/// **IT CARRIES THE PACKED LAYER RECORDS, NOT A PARSE.** The rows already hold
/// every layer's `(offset, len, slot)`, so the back-fill needs no `.note` parse:
/// it reads the ranges the index recorded straight out of the immutable blob.
pub const InkScan = struct {
    arena: std.heap.ArenaAllocator,
    pages: []Page,

    pub const Page = struct {
        page_index: u32,
        /// The row's packed `layers` blob, copied into the arena — the row's own
        /// memory dies with the statement, and the statement dies with the lock.
        layers: []const u8,
        /// Filled by `scanInk`. Null means the scan could not answer, and the
        /// row is left NULL so it is asked again rather than told a lie.
        has_ink: ?bool = null,
    };

    pub fn deinit(self: *InkScan) void {
        self.arena.deinit();
    }
};

/// The pages of `blob_md5` still at `has_ink IS NULL`. Reads the shared
/// connection, so the caller holds the lock; allocates one arena and copies the
/// packed records out of it, which is a few tens of bytes per page.
pub fn pendingInk(gpa: Allocator, db: sqlite.Db, blob_md5: []const u8) !InkScan {
    var arena = std.heap.ArenaAllocator.init(gpa);
    errdefer arena.deinit();
    const a = arena.allocator();

    var out: std.ArrayList(InkScan.Page) = .empty;
    var s = try db.prepare(
        "SELECT page_index, layers FROM note_page_index " ++
            "WHERE blob_md5 = ?1 AND kind = 0 AND has_ink IS NULL ORDER BY page_index;",
    );
    defer s.finalize();
    s.bindText(1, blob_md5);
    while (try s.step()) {
        try out.append(a, .{
            .page_index = @intCast(s.columnInt(0)),
            .layers = try a.dupe(u8, s.columnBlob(1)),
        });
    }
    return .{ .arena = arena, .pages = out.items };
}

/// Answer every outstanding page. **Call WITHOUT the lock** — this is the read
/// of the blob, and it is the whole reason the pending set was lifted out first.
///
/// Never fails: a blob that has vanished, or a `layers` blob that will not
/// unpack, leaves the page's answer null and the row NULL, so the tenant offers
/// the blob again on the next idle tick.
pub fn scanInk(blobs: blobstore.BlobStore, md5: []const u8, scan: *InkScan) void {
    var bs = blob_source.BlobSource.init(blobs, md5) catch return;
    const src = bs.source();
    var buf: [max_layers]LayerRef = undefined;
    for (scan.pages) |*p| {
        const refs = unpackLayers(p.layers, &buf) catch continue;
        p.has_ink = pageHasInk(src, refs);
    }
}

/// Write what the scan learned. Call inside the caller's transaction.
///
/// **`AND has_ink IS NULL` is the concurrency rule.** The scan ran off the lock,
/// so an ingest may have re-indexed the same blob meanwhile and written a
/// FRESHER answer from the same bytes; this must not overwrite it. A page the
/// scan could not answer is skipped entirely, so its row stays NULL and stays
/// outstanding.
pub fn storeInk(db: sqlite.Db, blob_md5: []const u8, scan: InkScan) !void {
    var s = try db.prepare(
        "UPDATE note_page_index SET has_ink = ?3 " ++
            "WHERE blob_md5 = ?1 AND page_index = ?2 AND kind = 0 AND has_ink IS NULL;",
    );
    defer s.finalize();
    for (scan.pages) |p| {
        const v = p.has_ink orelse continue;
        s.reset();
        s.bindText(1, blob_md5);
        s.bindInt(2, p.page_index);
        s.bindInt(3, if (v) 1 else 0);
        _ = try s.step();
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const testing = std.testing;
const schema = @import("../db/schema.zig");
const thumbstore = @import("../store/thumbs.zig");
const filesvc = @import("files.zig");
const nb = @import("note_builder");

const ensureIndexed = noteindex.ensureIndexed;
const LayerRecord = noteindex.LayerRecord;
const unpackLayerRecords = noteindex.unpackLayerRecords;

/// Real device captures. Local fixtures only — they are not redistributed.
const sample = @embedFile("sample.note");
const sample2 = @embedFile("sample-2.note");
/// The layer-panel capture: page 1 `#`-JSON LAYERINFO, page 2 base64 with a
/// HIDDEN Layer 2 (bitmap persists), a renamed top layer, layerId -1 bg.
const layers_edited = @embedFile("layers_edited.note");

/// The PNG magic + IHDR marker a synthetic image template carries, and the
/// `PAGESTYLEMD5` it is filed under.
const fake_png = [_]u8{ 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52 };
const template_hash = "deadbeefdeadbeefdeadbeefdeadbeef";

const Fixture = struct {
    db: sqlite.Db,
    files: filesvc.Files,
    tmp: testing.TmpDir,

    fn init() !Fixture {
        var db = try sqlite.Db.openMemory();
        try schema.migrate(db);
        try db.exec("INSERT INTO users(id, email, password_md5, created_at) VALUES(1, 'a@b.c', '0123456789abcdef0123456789abcdef', 0);");
        try db.exec("INSERT INTO capacity(user_id, used_bytes, total_bytes) VALUES(1, 0, 1000000000);");
        const tmp = testing.tmpDir(.{});
        const store_ = try blobstore.BlobStore.init(testing.io, tmp.dir);
        const thumbs_dir = try tmp.dir.createDirPathOpen(testing.io, "thumbs", .{});
        const thumbs_ = try thumbstore.ThumbStore.init(testing.io, thumbs_dir);
        return .{ .db = db, .files = filesvc.Files.init(testing.allocator, testing.io, db, store_, thumbs_), .tmp = tmp };
    }

    fn deinit(f: *Fixture) void {
        f.db.close();
        f.tmp.cleanup();
    }

    /// Puts `data` as a file, returning its (owned) md5 hex.
    fn put(f: *Fixture, name: []const u8, data: []const u8) ![blobstore.md5_hex_len]u8 {
        var r = std.Io.Reader.fixed(data);
        const e = try f.files.putFile(1, null, name, &r, null);
        defer testing.allocator.free(e.name);
        defer if (e.md5) |m| testing.allocator.free(m);
        var out: [blobstore.md5_hex_len]u8 = undefined;
        @memcpy(&out, e.md5.?[0..blobstore.md5_hex_len]);
        return out;
    }

    fn countRows(f: *Fixture, sql: []const u8) !i64 {
        var s = try f.db.prepare(sql);
        defer s.finalize();
        _ = try s.step();
        return s.columnInt(0);
    }
};

/// A layer of nothing: two long transparent runs and not a mark in them. This is
/// what a blank page's main layer really looks like — the ONLY case the scan
/// walks to the end of, and it is a handful of bytes.
const rle_blank = [_]u8{ 0x62, 0xFF, 0x62, 0xFF };
/// A stroke, with transparent on both sides of it so the finder has to walk
/// past something before it fires.
const rle_stroke = [_]u8{ 0x62, 0xFF, 0x61, 0x20, 0x62, 0xFF };
/// The same, drawn in WHITE — colour code `0x65`, the opaque `0xFE` that masks
/// the layer below. §2.3: a white pen is a pen.
const rle_white_pen = [_]u8{ 0x62, 0xFF, 0x65, 0x20, 0x62, 0xFF };
/// A `LAYERINFO` value marking MAINLAYER hidden — the device's `#`-JSON
/// encoding, where `#` stands where JSON wants `:`.
const layerinfo_main_hidden =
    "[{\"layerId\"#0,\"name\"#\"Main\",\"isVisible\"#false,\"isDeleted\"#false}]";

/// Six pages, one per rule in §2.1/§2.3.
fn inkNote(gpa: Allocator) ![]u8 {
    return nb.serialize(gpa, .{
        .pages = &.{
            // 0 — an all-transparent main layer. EMPTY.
            .{ .style = "style_white", .layers = &.{
                .{ .slot = .main, .bitmap = &rle_blank },
            } },
            // 1 — a stroke on the main layer. INKED.
            .{ .style = "style_white", .layers = &.{
                .{ .slot = .main, .bitmap = &rle_stroke },
            } },
            // 2 — a custom IMAGE template and nothing written on it. EMPTY: the
            //     background is not ink, which is the whole of §2.1.
            .{ .style = "customImage", .style_md5 = template_hash, .layers = &.{
                .{ .slot = .background, .name = "BGLAYER", .bitmap = &fake_png },
            } },
            // 3 — a HIDDEN main layer carrying a stroke. INKED: hidden is a view
            //     state, not an erasure, and the bitmap persists in the file.
            .{ .style = "style_white", .layer_info = layerinfo_main_hidden, .layers = &.{
                .{ .slot = .main, .bitmap = &rle_stroke },
            } },
            // 4 — the only mark is the opaque near-white `0xFE`. INKED.
            .{ .style = "style_white", .layers = &.{
                .{ .slot = .main, .bitmap = &rle_white_pen },
            } },
            // 5 — an RLE background FULL of marks under a blank main layer. EMPTY:
            //     a built-in template is drawn on the page and not by the user.
            .{ .style = "style_white", .layers = &.{
                .{ .slot = .background, .name = "BGLAYER", .bitmap = &rle_stroke },
                .{ .slot = .main, .bitmap = &rle_blank },
            } },
        },
    });
}

test "ingest: has_ink is the mark on a NON-BACKGROUND layer — hidden counts, a template does not, 0xFE does" {
    // The two that are easy to get wrong are both here: a page whose only
    // content is a template is EMPTY (so the indicator does not light every page
    // of a PDF-backed notebook), and a hidden layer with a stroke is INKED.
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;

    const bytes = try inkNote(gpa);
    defer gpa.free(bytes);
    const md5 = try f.put("ink.note", bytes);

    const want = [_]i64{ 0, 1, 0, 1, 1, 0 };
    var s = try f.db.prepare(
        "SELECT page_index, has_ink FROM note_page_index WHERE blob_md5 = ?1 ORDER BY page_index;",
    );
    defer s.finalize();
    s.bindText(1, &md5);
    var n: usize = 0;
    while (try s.step()) : (n += 1) {
        try testing.expectEqual(@as(i64, @intCast(n)), s.columnInt(0));
        // NEVER NULL at ingest: the page was in front of us, so "not yet looked"
        // is not an answer we are entitled to.
        try testing.expect(!s.columnIsNull(1));
        try testing.expectEqual(want[n], s.columnInt(1));
    }
    try testing.expectEqual(want.len, n);

    // And the hidden page really is hidden — otherwise page 3 would be proving
    // nothing that page 1 does not already prove.
    var l = try f.db.prepare("SELECT layers FROM note_page_index WHERE blob_md5 = ?1 AND page_index = 3;");
    defer l.finalize();
    l.bindText(1, &md5);
    try testing.expect(try l.step());
    var recs: [max_layers]LayerRecord = undefined;
    const got = try unpackLayerRecords(l.columnBlob(0), &recs);
    try testing.expectEqual(@as(usize, 1), got.len);
    try testing.expectEqual(sn.types.LayerSlot.main, got[0].ref.slot);
    try testing.expect(got[0].ref.hidden);
}

test "has_ink AGREES WITH THE DECODER, on every page of every real capture" {
    // The cheap pass must reach the same verdict as a full decode of every
    // non-background layer to pixels — the literal reading of §2.1 — against a
    // walk that never allocates a bitmap. Driven on the REAL captures, because
    // synthetic streams are written by the same understanding the finder is.
    const gpa = testing.allocator;
    for ([_][]const u8{ sample, sample2, layers_edited }) |bytes| {
        var note = try sn.parse(gpa, bytes);
        defer note.deinit();
        const src = sn.Source.fromSlice(bytes);
        const variant = sn.page_payload.variantOf(note);
        const dims = note.dimensions();

        for (note.pages, 0..) |page, i| {
            var refs_buf: [max_layers]LayerRef = undefined;
            const refs = try sn.page_payload.emitLayers(note, i, &refs_buf);
            const eff = dims.oriented(page.orientation());

            var painted = false;
            for (refs) |r| {
                if (r.slot == .background) continue;
                const data = src.view(r.offset, r.len).?;
                const gray = try sn.decoder.decode(gpa, variant, data, eff.width, eff.height, r.all_blank);
                defer gpa.free(gray);
                // 0xFF is the transparent sentinel; everything else is paint,
                // `0xFE` included.
                for (gray) |px| {
                    if (px != 0xFF) {
                        painted = true;
                        break;
                    }
                }
                if (painted) break;
            }
            try testing.expectEqual(painted, pageHasInk(src, refs).?);
        }
    }
}

test "has_ink stops at the FIRST stroke — the layer's tail is never read" {
    // The performance claim, driven against a source that COUNTS BYTES. A
    // written page must not read its whole layer, and that is the entire
    // argument for a flag over a count (§2.4): here a 1 MB layer whose stroke is
    // in the first pair costs one chunk, while the blank layer beside it — the
    // only case that scans to the end — is a few bytes long.
    const Counting = struct {
        bytes: []const u8,
        read_total: u64 = 0,

        fn readFn(ctx: *anyopaque, offset: u64, dest: []u8) sn.source.Error!void {
            const self: *@This() = @ptrCast(@alignCast(ctx));
            if (offset + dest.len > self.bytes.len) return error.OutOfBounds;
            @memcpy(dest, self.bytes[@intCast(offset)..][0..dest.len]);
            self.read_total += dest.len;
        }
        fn source(self: *@This()) sn.Source {
            return .{ .ranged = .{ .ctx = self, .size = self.bytes.len, .readFn = readFn } };
        }
    };

    const gpa = testing.allocator;
    const big = 1 << 20;
    const layer = try gpa.alloc(u8, big);
    defer gpa.free(layer);
    // Transparent all the way down…
    var i: usize = 0;
    while (i + 1 < layer.len) : (i += 2) {
        layer[i] = 0x62;
        layer[i + 1] = 0xFF;
    }

    // …and the finder walks all of it, once, in bounded windows.
    {
        var c = Counting{ .bytes = layer };
        try testing.expectEqual(@as(?bool, false), layerHasInk(c.source(), 0, @intCast(layer.len)));
        try testing.expectEqual(@as(u64, layer.len), c.read_total);
    }

    // One stroke at the very front, and the other 1 MB is never fetched.
    {
        layer[0] = 0x61;
        var c = Counting{ .bytes = layer };
        try testing.expectEqual(@as(?bool, true), layerHasInk(c.source(), 0, @intCast(layer.len)));
        try testing.expectEqual(@as(u64, ink_chunk_len), c.read_total);
        try testing.expect(c.read_total < layer.len);
    }
}

test "has_ink: an unreadable layer is NULL, not 0 — the third state is what stops the lie" {
    // A read failure must not be recorded as "this page is empty". The column
    // has three states precisely so the answer can be withheld, and the deferred
    // tenant asks again. Driven through a source that refuses every read.
    const Broken = struct {
        fn readFn(_: *anyopaque, _: u64, _: []u8) sn.source.Error!void {
            return error.ReadFailed;
        }
        fn source(self: *@This()) sn.Source {
            return .{ .ranged = .{ .ctx = self, .size = 1024, .readFn = readFn } };
        }
    };
    var b = Broken{};
    const src = b.source();

    try testing.expectEqual(@as(?bool, null), layerHasInk(src, 0, 16));
    // A page whose only layer cannot be read is UNKNOWN…
    try testing.expectEqual(@as(?bool, null), pageHasInk(src, &.{
        .{ .offset = 0, .len = 16, .slot = .main, .all_blank = false, .hidden = false },
    }));
    // …but a page with NO non-background layer at all is honestly EMPTY, because
    // nothing was left unread.
    try testing.expectEqual(@as(?bool, false), pageHasInk(src, &.{
        .{ .offset = 0, .len = 16, .slot = .background, .all_blank = false, .hidden = false },
    }));
    try testing.expectEqual(@as(?bool, false), pageHasInk(src, &.{}));
}

test "has_ink survives a re-index, and a stale row heals to the same answer" {
    // The upsert has to carry the column like every other page fact: a heal that
    // dropped it would leave a page at NULL for ever after its first re-index,
    // and the strip would quietly lose its mark on notes that had one.
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;

    const bytes = try inkNote(gpa);
    defer gpa.free(bytes);
    const md5 = try f.put("ink.note", bytes);

    // Force the row stale AND blank the column — the state a database migrated
    // from v15 is in.
    try f.db.exec("UPDATE note_index SET index_version = 1;");
    try f.db.exec("UPDATE note_page_index SET has_ink = NULL;");
    try testing.expectEqual(@as(i64, 6), try f.countRows(
        "SELECT COUNT(*) FROM note_page_index WHERE has_ink IS NULL;",
    ));

    try ensureIndexed(gpa, testing.io, f.db, f.files.blobs, &md5, 0);

    try testing.expectEqual(@as(i64, 0), try f.countRows(
        "SELECT COUNT(*) FROM note_page_index WHERE has_ink IS NULL;",
    ));
    try testing.expectEqual(@as(i64, 3), try f.countRows(
        "SELECT COUNT(*) FROM note_page_index WHERE has_ink = 1;",
    ));
    try testing.expectEqual(@as(i64, 3), try f.countRows(
        "SELECT COUNT(*) FROM note_page_index WHERE has_ink = 0;",
    ));
}

test "the back-fill answers exactly the NULL rows, from the stored layer ranges and no parse" {
    // `pendingInk` / `scanInk` / `storeInk` — the three halves the deferred
    // tenant drives, exercised without it so the pieces are pinned separately
    // from the threading. The point of the shape is that the scan needs no
    // `.note` parse at all: the packed `layers` blob already locates every
    // bitmap, so a back-fill reads ranges out of the immutable blob.
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;

    const bytes = try inkNote(gpa);
    defer gpa.free(bytes);
    const md5 = try f.put("ink.note", bytes);

    // Blank three pages' answers — the "some rows predate the column" state.
    try f.db.exec("UPDATE note_page_index SET has_ink = NULL WHERE page_index IN (0, 1, 3);");
    try testing.expect(try inkNeedsScan(f.db, &md5));

    var scan = try pendingInk(gpa, f.db, &md5);
    defer scan.deinit();
    // ONLY the NULL rows are offered, and each carries its packed records.
    try testing.expectEqual(@as(usize, 3), scan.pages.len);
    try testing.expectEqual(@as(u32, 0), scan.pages[0].page_index);
    try testing.expectEqual(@as(u32, 1), scan.pages[1].page_index);
    try testing.expectEqual(@as(u32, 3), scan.pages[2].page_index);
    for (scan.pages) |p| {
        try testing.expect(p.layers.len > 0);
        try testing.expectEqual(@as(?bool, null), p.has_ink);
    }

    scanInk(f.files.blobs, &md5, &scan);
    try testing.expectEqual(@as(?bool, false), scan.pages[0].has_ink);
    try testing.expectEqual(@as(?bool, true), scan.pages[1].has_ink);
    try testing.expectEqual(@as(?bool, true), scan.pages[2].has_ink); // hidden still counts

    try storeInk(f.db, &md5, scan);
    try testing.expectEqual(@as(i64, 0), try f.countRows(
        "SELECT COUNT(*) FROM note_page_index WHERE has_ink IS NULL;",
    ));
    try testing.expect(!try inkNeedsScan(f.db, &md5));

    // And it reaches the SAME answers ingest did — the two are one function.
    var s = try f.db.prepare(
        "SELECT has_ink FROM note_page_index WHERE blob_md5 = ?1 ORDER BY page_index;",
    );
    defer s.finalize();
    s.bindText(1, &md5);
    const want = [_]i64{ 0, 1, 0, 1, 1, 0 };
    var n: usize = 0;
    while (try s.step()) : (n += 1) try testing.expectEqual(want[n], s.columnInt(0));
    try testing.expectEqual(want.len, n);
}

test "the back-fill never overwrites a fresher answer, and leaves an unanswerable page NULL" {
    // The scan runs OFF the write lock, so an ingest can re-index the same blob
    // underneath it. `storeInk`'s `has_ink IS NULL` guard is what keeps the
    // stale-but-equally-valid answer from landing on top of a newer row — and a
    // page the scan could not answer must stay outstanding rather than be
    // written as empty.
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;

    const bytes = try inkNote(gpa);
    defer gpa.free(bytes);
    const md5 = try f.put("ink.note", bytes);
    try f.db.exec("UPDATE note_page_index SET has_ink = NULL;");

    var scan = try pendingInk(gpa, f.db, &md5);
    defer scan.deinit();
    scanInk(f.files.blobs, &md5, &scan);

    // Someone else answered page 1 while we were reading — with the opposite
    // value, so the guard is observable rather than merely plausible.
    try f.db.exec("UPDATE note_page_index SET has_ink = 0 WHERE page_index = 1;");
    // And page 4 came back unanswerable.
    scan.pages[4].has_ink = null;

    try storeInk(f.db, &md5, scan);

    var s = try f.db.prepare(
        "SELECT has_ink FROM note_page_index WHERE blob_md5 = ?1 AND page_index = ?2;",
    );
    defer s.finalize();
    s.bindText(1, &md5);
    s.bindInt(2, 1);
    try testing.expect(try s.step());
    try testing.expectEqual(@as(i64, 0), s.columnInt(0)); // the other writer's answer stands
    s.reset();
    s.bindText(1, &md5);
    s.bindInt(2, 4);
    try testing.expect(try s.step());
    try testing.expect(s.columnIsNull(0)); // still owed, not called empty
    try testing.expect(try inkNeedsScan(f.db, &md5));
}

// BENCH — printed through `std.log.info`, so it is SILENT in the normal suite
// (`testing.log_level` starts at `.warn`). To read it, raise the level inside
// the test the way `app.zig` and `deferred.zig` lower it:
//
//     const saved = testing.log_level; testing.log_level = .info;
//     defer testing.log_level = saved;
//
// then `zig build test -Doptimize=ReleaseSafe`. For the deployment target,
// cross-compile the test binary (`-Dtarget=arm-linux-musleabihf
// -Dcpu=arm1176jzf_s`) and run it there — `derive_bench.zig` is a standalone
// executable for exactly that reason, and this rides the suite instead only
// because its corpus is three files the suite already embeds.
//
// THE QUESTION: §2.3 says the ink scan is free because it stops at the first
// stroke, and "should be cheap" is not a number. This times the per-page scan
// over the three real device captures — a one-page notebook, a two-page note
// with a recognised page, and the layer-panel capture, which turns out to carry
// one written page and one genuinely BLANK one (the case that reads to the end).
//
// The emit list is hoisted out of the timing: the indexer builds it anyway (it
// IS the `layers` column), so what is measured is the scan over a list it was
// handed.
//
// TAKEN 2026-09-09, x86 Ryzen 7 7840U, ReleaseSafe, 200 sweeps, slice source:
//
// | capture | pages | inked | ink-layer bytes | per page |
// |---|---:|---:|---:|---:|
// | `sample.note`         | 1 | 1 | 32,168 | **1.61 us** |
// | `sample-2.note`       | 2 | 2 | 63,860 | **1.63 us** |
// | `layers_edited.note`  | 2 | 1 | 42,862 | **1.67 us** |
//
// Flat at ~1.6 us whatever the layer bytes say, which is the early exit visible
// as a NUMBER: 32 KB and 64 KB of ink cost the same because neither is read.
// What is left is one `ink_chunk_len` window per layer — and that constant is
// where the whole measurement went. At `hash_chunk_len` (64 KiB) the same bench
// reported **26 us/page**, none of it the walk: a safe build fills an
// `undefined` buffer, so a 64 KiB window costs 64 KiB of memory traffic to
// answer a question the first two bytes usually settle. 4 KiB is 16x less and
// still one read for every layer in the corpus.
//
// TAKEN 2026-09-10 ON THE DEPLOYMENT TARGET — Raspberry Pi Model B Plus Rev 1.2
// (BCM2835, one ARM1176 core at 700 MHz, 426 MB), Raspbian armv6l,
// cross-compiled `-Dtarget=arm-linux-musleabihf -Dcpu=arm1176jzf_s`,
// ReleaseSafe, 400 sweeps x 5 reps best, the same three captures and the same
// slice source, so the columns are comparable:
//
// | capture | per page | vs x86 |
// |---|---:|---:|
// | `sample.note`         | **48 us** | 30x |
// | `sample-2.note`       | **59 us** | 36x |
// | `layers_edited.note`  | **45 us** | 27x |
//
// **STILL FLAT, which is the half that mattered.** 32 KB and 64 KB of ink layer
// still cost the same page on hardware whose memory system has nothing in common
// with the Ryzen's, and the sweep below says why: the cost is the WINDOW, linear
// in it to within 5% from 1 KiB to 64 KiB, with the layer's own length absent
// from it entirely. §2.3's early exit is a property of the algorithm and not of
// a cache.
//
// **THE PROJECTION ABOVE MISSED, and it is worth saying how.** "40-50x -> ~70-80
// us/page" borrowed a multiplier from benches that measure ARITHMETIC. This
// workload is a memset and a memcpy; the real multiplier is **~30x**, for ~50
// us/page. The direction was lucky — a borrowed CPU multiplier could as easily
// have been 2x low on a memory-bound pass as 1.5x high.
//
// THE WINDOW SWEEP, on the ARM1176, `sample.note` (the other two track it within
// 15%). The right-hand column is the source shape the SERVER actually uses:
// `ensureIndexed` and `scanInk` both read through `BlobSource`, and
// `BlobStore.readRange` does an open + stat + pread + close for EVERY window.
//
// | window | slice | via `BlobStore.readRange` |
// |---|---:|---:|
// | 512 B     |   4 us |  100 us |
// | 1 KiB     |  12 us |  110 us |
// | 2 KiB     |  25 us |  127 us |
// | **4 KiB** | **52 us** | **152 us** |
// | 8 KiB     | 106 us |  204 us |
// | 16 KiB    | 218 us |  315 us |
// | 64 KiB    | 818 us |  903 us |
//
// The two columns differ by a flat ~100 us — the syscall round, which is 2/3 of
// the real per-page cost at 4 KiB and is not the window's to save. **So 4 KiB
// STAYS, and the sweep is what settles it rather than what unsettles it.**
// Dropping to 1 KiB would save 42 us of a 152 us scan — 28% of a step that is 8%
// of the hash beside it, so ~2% of the page. It would buy that by cutting the
// margin under `ink_chunk_len`'s blank-layer bound to 1.7x (600 bytes on an
// A5X2/Manta, `types.Dimensions.a5x2`), and one extra window on this path costs
// ~100 us — MORE than the whole saving. The asymmetry runs the other way, and
// 64 KiB is worse here than it was on x86.
//
// AND THE RATIO, which is the claim the absolutes serve. `pageContentHash` runs
// on the same page, streams EVERY byte of EVERY layer through md5, and is
// already there:
//
// | source | scan (4 KiB) | `pageContentHash` | scan/hash |
// |---|---:|---:|---:|
// | slice              |  47-59 us | 1.11-1.44 ms | **3.4-4.3%** |
// | `BlobStore`-shaped | 148-159 us | 1.93-2.02 ms | **7.7-8.0%** |
//
// The scan is not the cost of an ingest; it is noise beside the hash it runs
// beside — on the ARM1176 as on the Ryzen, at a twelfth of it on the path the
// server takes. §2.3's conclusion holds: this belongs inline at ingest.
fn benchInk(bytes: []const u8, label: []const u8, iters: usize) !void {
    const gpa = testing.allocator;
    var note = try sn.parse(gpa, bytes);
    defer note.deinit();
    if (note.pages.len == 0) return;
    const src = sn.Source.fromSlice(bytes);

    // The emit list is HOISTED, and that is not cheating: the indexer builds it
    // anyway (it is the `layers` column), so the scan's own cost is what it does
    // with a list it was handed. Timed as ONE run of `iters` sweeps rather than
    // per-sweep, because a real capture is one or two pages and two clock reads
    // amortised over two pages measure the clock.
    var refs_bufs: [64][max_layers]LayerRef = undefined;
    var refs: [64][]const LayerRef = undefined;
    const pages = @min(note.pages.len, refs_bufs.len);
    var ink_bytes: u64 = 0;
    for (0..pages) |i| {
        refs[i] = try sn.page_payload.emitLayers(note, i, &refs_bufs[i]);
        for (refs[i]) |r| {
            if (r.slot != .background) ink_bytes += r.len;
        }
    }

    const t0 = std.Io.Clock.awake.now(testing.io);
    var found: usize = 0;
    for (0..iters) |_| {
        for (0..pages) |i| {
            if (pageHasInk(src, refs[i]) orelse false) found += 1;
        }
    }
    const t1 = std.Io.Clock.awake.now(testing.io);
    std.mem.doNotOptimizeAway(found);
    const ns: u64 = @intCast(t0.durationTo(t1).toNanoseconds());

    std.log.info("[bench] ink {s}: {d} pages, {d} inked, {d} bytes of ink layers, {d} ns/page over {d} sweeps", .{
        label, pages, found / iters, ink_bytes, ns / (iters * pages), iters,
    });
}

test "BENCH note: the ink scan, per page, over the real captures (figures printed)" {
    try benchInk(sample, "sample.note", 200);
    try benchInk(sample2, "sample-2.note", 200);
    try benchInk(layers_edited, "layers_edited.note", 200);
}
