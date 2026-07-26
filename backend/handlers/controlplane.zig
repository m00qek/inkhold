//! Control-plane handlers (the browser face): device-management unlink, the
//! browse/read endpoints for the SPA (tree, note meta, per-page bytes), and the
//! live-freshness SSE channel. Thin HTTP shells over the `ControlPlaneService`.

const std = @import("std");
const router = @import("../http/router.zig");
const context = @import("../http/context.zig");
const json = @import("../http/json.zig");
const reply = @import("../http/reply.zig");
const controlplane = @import("../services/controlplane.zig");
const eventstreams = @import("../http/event_streams.zig");
const notesearch = @import("../services/search/query.zig");
const blobstore = @import("../store/blobs.zig");
const thumbnailmod = @import("../services/thumbnail.zig");
const filesvc = @import("../services/files.zig");
const config = @import("../config.zig");

const Context = context.Context;
const Request = router.Request;
const Params = router.Params;
const fail = reply.fail;
const badRequest = reply.badRequest;
const serverError = reply.serverError;

const UnbindReq = struct { equipmentNo: []const u8 };

/// POST /api/controlplane/equipment/unlink -> revoke a device (browser
/// device-management action).
pub fn controlplaneUnlink(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const svc = ctx.service.?;
    const caller = ctx.caller.?; // controlplane scope
    var parsed = json.readBody(UnbindReq, ctx.gpa, req) catch return badRequest(ctx, req);
    defer parsed.deinit();

    svc.unlinkDevice(caller.user_id, parsed.value.equipmentNo) catch return serverError(ctx, req);
    try json.respond(ctx.gpa, req, .ok, reply.BaseVO{ .success = true }, null);
}

/// GET /api/controlplane/usage -> the caller's OWN storage usage, for the rail's
/// quota bar. Raw VO like the other control-plane reads. `Files.capacity` never
/// errors on a missing row (reads 0 / the server default), so this can't 404.
const UsageVO = struct { used_bytes: i64, total_bytes: i64 };

pub fn controlplaneUsage(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files orelse return serverError(ctx, req);
    const cap = files.capacity(caller.user_id) catch return serverError(ctx, req);
    try json.respond(ctx.gpa, req, .ok, UsageVO{ .used_bytes = cap.used, .total_bytes = cap.total }, null);
}

// ---- server-info (the onboarding bootstrap fact) ----

/// The response VO. Serialized RAW (no `{success}` envelope), like every other
/// control-plane read: the SPA's `request()` passes a body without an explicit
/// `success:false` straight through, and `api.serverInfo()` reads exactly these
/// two top-level fields (`address`, `firstRun`).
const ServerInfoVO = struct { address: []const u8, firstRun: bool };

/// libc `struct ifaddrs` — only the fields we read. std has no portable
/// interface enumerator, so we go through getifaddrs (libc is linked) to learn
/// the host's own LAN IPv4, the one fact the browser cannot determine itself for
/// onboarding's connect step (a client that reached us over `localhost` has no
/// idea what the machine's network address is).
const ifaddrs = extern struct {
    next: ?*ifaddrs,
    name: ?[*:0]u8,
    flags: c_uint,
    addr: ?*std.posix.sockaddr,
    netmask: ?*std.posix.sockaddr,
    ifu: ?*std.posix.sockaddr,
    data: ?*anyopaque,
};
extern "c" fn getifaddrs(ifap: *?*ifaddrs) c_int;
extern "c" fn freeifaddrs(ifa: ?*ifaddrs) void;

fn isLoopback(o: [4]u8) bool {
    return o[0] == 127; // 127.0.0.0/8
}
fn isLinkLocal(o: [4]u8) bool {
    return o[0] == 169 and o[1] == 254; // 169.254.0.0/16
}
fn isPrivate(o: [4]u8) bool {
    return (o[0] == 10) or // 10.0.0.0/8
        (o[0] == 172 and o[1] >= 16 and o[1] <= 31) or // 172.16.0.0/12
        (o[0] == 192 and o[1] == 168); // 192.168.0.0/16
}

/// Interface-name prefixes for virtual/bridge devices that commonly carry a
/// private-range IPv4 but are NOT the household LAN: Docker's bridge + its veth
/// pairs, libvirt (`virbr`), VirtualBox/VMware (`vboxnet`/`vmnet`), WireGuard/
/// ZeroTier/Tailscale tunnels, generic bridges (`br-`), and loopback. Skipping
/// them stops `primaryIpv4` handing the Supernote an address like `docker0`'s
/// 172.17.0.1, which nothing on the real LAN can reach. A blind scan otherwise
/// returns whichever of these `getifaddrs` lists first, and on a dev box that is
/// often the bridge. A bare Pi has only `eth0`/`wlan0`, so this is a no-op there.
fn isVirtualIface(name_z: [*:0]const u8) bool {
    const name = std.mem.span(name_z);
    const skip = [_][]const u8{
        "lo",     "docker", "br-",       "veth",  "virbr",
        "vboxnet", "vmnet", "tailscale", "wg",    "zt",
        "tun",    "tap",
    };
    for (skip) |p| if (std.mem.startsWith(u8, name, p)) return true;
    return false;
}

/// The host's primary IPv4 as four octets, or null when none is usable.
/// Enumerates interfaces, SKIPS virtual/bridge devices by name (see
/// `isVirtualIface` — so `docker0` &c. never win over the real NIC), and among
/// what remains PREFERS a private-range address (a household LAN is 10/8,
/// 172.16/12, 192.168/16), otherwise the first IPv4 that is neither loopback
/// (127/8) nor link-local (169.254/16). Portable native code — getifaddrs is
/// POSIX, so this builds for the ARM Pi target.
fn primaryIpv4() ?[4]u8 {
    var list: ?*ifaddrs = null;
    if (getifaddrs(&list) != 0) return null;
    defer freeifaddrs(list);

    var fallback: ?[4]u8 = null;
    var it = list;
    while (it) |ifa| : (it = ifa.next) {
        const sa = ifa.addr orelse continue;
        if (sa.family != std.posix.AF.INET) continue;
        if (ifa.name) |n| if (isVirtualIface(n)) continue;
        const sin: *const std.posix.sockaddr.in = @ptrCast(@alignCast(sa));
        // `sin.addr` holds the address in network byte order; a bitcast to bytes
        // recovers the octets in a.b.c.d order on any host endianness.
        const octets: [4]u8 = @bitCast(sin.addr);
        if (isLoopback(octets) or isLinkLocal(octets)) continue;
        if (isPrivate(octets)) return octets;
        if (fallback == null) fallback = octets;
    }
    return fallback;
}

/// The server's LAN address as `host:port` for the connect step. The port is
/// always the configured one; the host is the detected primary IPv4, or — when
/// detection fails — the configured bind host (and `""` if even that will not
/// format, at which point the frontend falls back to `window.location`).
fn serverAddress(buf: []u8, cfg: config.Config) []const u8 {
    if (primaryIpv4()) |o|
        return std.fmt.bufPrint(buf, "{d}.{d}.{d}.{d}:{d}", .{ o[0], o[1], o[2], o[3], cfg.port }) catch "";
    return std.fmt.bufPrint(buf, "{s}:{d}", .{ cfg.host, cfg.port }) catch "";
}

/// GET /api/controlplane/server-info -> `{ address, firstRun }`, the onboarding
/// bootstrap fact the login page reads BEFORE anyone can sign in.
///
/// **PUBLIC scope on purpose.** On a single-household LAN tool "this server is
/// new" is not a secret, and the whole first-run experience turns on knowing it
/// pre-auth (the login page switches to its terminal-guidance rendering, and the
/// connect step shows the LAN address the household should point their Supernote
/// at — which the browser cannot compute itself). See docs/design/login-in-app.md.
pub fn controlplaneServerInfo(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const svc = ctx.service.?; // set at startup, present on every route incl. public
    const first_run = svc.isFirstRun() catch return serverError(ctx, req);

    var addr_buf: [64]u8 = undefined;
    try json.respond(ctx.gpa, req, .ok, ServerInfoVO{
        .address = serverAddress(&addr_buf, ctx.config),
        .firstRun = first_run,
    }, null);
}

// ---- the recycle bin ----
//
// ## CSRF, and why there is no token here
//
// These are the control plane's first WRITE routes (it was entirely `GET` until
// now, plus the one `controlplaneUnlink` POST). They introduce no CSRF machinery
// and deliberately follow that existing write's precedent: the session cookie is
// `HttpOnly; SameSite=Strict` (see `http/context.zig`), so a browser will not
// attach it to a request originating from another site — which is the whole of
// what a token would buy on a same-origin SPA with no cross-site form posts. A
// token scheme invented here would be a second, unshared mechanism guarding the
// same boundary the cookie already guards, and the day it drifted out of step
// with the cookie policy the drift would be silent.
//
// ## Ownership
//
// Every one of these funnels through a `Files` call scoped by `caller.user_id`,
// which reports a foreign id as `NotFound` — so a foreign id is answered exactly
// as a missing one and the endpoints are not an existence oracle over the id
// space. That matters more here than on the read routes: blobs are deduplicated,
// so two households can hold the same bytes, and only the `files` row says whose
// they are.

/// GET /api/controlplane/bin -> the caller's recycle bin: every trashed entry,
/// newest deletion first, each carrying the path it had when it was deleted.
///
/// The response is a FLAT list (`BinVO`) — see `Files.listBin` for why the
/// grouping the UI renders is the client's to derive rather than the server's to
/// impose.
pub fn controlplaneBin(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files orelse return serverError(ctx, req);

    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    var svc = controlplane.ControlPlaneService.init(files);
    const vo = svc.bin(arena.allocator(), caller.user_id) catch return serverError(ctx, req);
    try json.respond(ctx.gpa, req, .ok, vo, null);
}

/// DELETE /api/controlplane/entry/{id} -> move a LIVE entry to the recycle bin
/// (U5). The browser had no way to delete anything at all before this, which is
/// what made the bin unreachable from it.
///
/// A folder takes its whole subtree with it. The device does that walk itself and
/// sends one request per entity; the browser sends one request, so the walk
/// happens server-side in `Files.trash`'s single recursive UPDATE.
///
/// Reversible, so no confirmation is expected of the client — but the response
/// states the fanout (`entries`) so the undo toast can say "and the 2 notes
/// inside it" when the operation exceeds the row that was clicked. The count is
/// taken BEFORE the trash, because afterwards there is nothing live left to count.
///
/// Nothing here refunds quota and nothing decrefs: trashing holds every blob
/// reference. `purge` is where the bytes come back.
pub fn controlplaneTrash(ctx: *Context, req: *Request, params: Params) anyerror!void {
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files orelse return serverError(ctx, req);
    const id = reply.pathId(params) orelse return badRequest(ctx, req);

    // `get`, not `getAnyState`: a row already in the bin is not something a web
    // delete acts on (that is purge), and answering NotFound keeps "already
    // trashed" and "never existed" from being distinguishable either.
    const entry = (files.get(caller.user_id, id) catch return serverError(ctx, req)) orelse
        return fail(ctx, req, .not_found, "NOT_FOUND", "no such entry");
    defer ctx.gpa.free(entry.name);
    defer if (entry.md5) |m| ctx.gpa.free(m);

    const fanout = files.liveSubtreeCount(caller.user_id, id) catch return serverError(ctx, req);
    files.trash(caller.user_id, id) catch |err| switch (err) {
        error.NotFound => return fail(ctx, req, .not_found, "NOT_FOUND", "no such entry"),
        else => return serverError(ctx, req),
    };

    var idbuf: [24]u8 = undefined;
    const id_str = std.fmt.bufPrint(&idbuf, "{d}", .{id}) catch return serverError(ctx, req);
    try json.respond(ctx.gpa, req, .ok, controlplane.TrashedVO{
        .id = id_str,
        .name = entry.name,
        .isFolder = entry.is_folder,
        .entries = @intCast(fanout),
    }, null);
}

/// POST /api/controlplane/bin/{id}/restore -> bring a trashed entry back.
///
/// **The response reports what actually happened, not what was asked**, because
/// restore routinely does more than the user selected and the UI cannot tell the
/// truth otherwise: it restores the ancestor chain (a live row under a trashed
/// parent would be an orphan, visible in no listing), it restores every trashed
/// descendant of a folder, and it auto-renames when a live entry has taken the
/// name in the meantime — `files_live_name` is UNIQUE only `WHERE deleted = 0`.
/// So `name`/`renamed`/`ancestors`/`descendants` are all load-bearing.
pub fn controlplaneRestore(ctx: *Context, req: *Request, params: Params) anyerror!void {
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files orelse return serverError(ctx, req);
    const id = reply.pathId(params) orelse return badRequest(ctx, req);

    const done = files.restore(caller.user_id, id) catch |err| switch (err) {
        error.NotFound => return fail(ctx, req, .not_found, "NOT_FOUND", "no such entry"),
        else => return serverError(ctx, req),
    };
    defer done.deinit(ctx.gpa);

    try json.respond(ctx.gpa, req, .ok, controlplane.RestoredVO{
        .name = done.name,
        .renamed = done.renamed,
        .ancestors = @intCast(done.ancestors),
        .descendants = @intCast(done.descendants),
    }, null);
}

/// DELETE /api/controlplane/bin/{id} -> destroy one trashed entry (and its
/// subtree) permanently. Irreversible.
///
/// A LIVE id is a 404, not a hard delete: `Files.purge` refuses anything outside
/// the bin, so destroying a live file is never one mistyped id away. This is the
/// only route on this face that reaches `decref` — where blob refcounts drop, the
/// note index and FTS rows go, the blob leaves disk, and the bytes finally come
/// off the user's quota.
pub fn controlplanePurge(ctx: *Context, req: *Request, params: Params) anyerror!void {
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files orelse return serverError(ctx, req);
    const id = reply.pathId(params) orelse return badRequest(ctx, req);

    files.purge(caller.user_id, id) catch |err| switch (err) {
        error.NotFound => return fail(ctx, req, .not_found, "NOT_FOUND", "no such entry"),
        else => return serverError(ctx, req),
    };
    try json.respond(ctx.gpa, req, .ok, reply.BaseVO{ .success = true }, null);
}

/// DELETE /api/controlplane/bin -> destroy everything in the caller's bin.
/// Irreversible and bulk; the client confirms it (U4). Returns the count removed.
pub fn controlplaneEmptyBin(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files orelse return serverError(ctx, req);

    const n = files.emptyBin(caller.user_id) catch return serverError(ctx, req);
    try json.respond(ctx.gpa, req, .ok, controlplane.EmptiedVO{ .entries = @intCast(n) }, null);
}

/// GET /api/controlplane/bin/file/metadata/{id} -> the page list of a TRASHED item.
///
/// The bin-scoped twin of `controlplaneNote`, and the reason it has to exist:
/// `Files.get` hardcodes `deleted = 0`, so a trashed item 404s from `noteMeta`,
/// from page bytes and from the raw-file route — and deciding whether to restore
/// something deleted a fortnight ago means looking at it first. `Files.get` is
/// NOT relaxed to allow that; these three routes read through
/// `Files.getTrashed`, which sees trashed rows and nothing else.
///
/// It works at all only because trash holds the blob reference. Under the old
/// behaviour the bytes were already gone by the time anyone wanted to look.
pub fn controlplaneBinNote(ctx: *Context, req: *Request, params: Params) anyerror!void {
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files orelse return serverError(ctx, req);
    const id = reply.pathId(params) orelse return badRequest(ctx, req);

    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    var svc = controlplane.ControlPlaneService.init(files);
    const vo = (svc.binNoteMeta(arena.allocator(), caller.user_id, id) catch return serverError(ctx, req)) orelse
        return fail(ctx, req, .not_found, "NOT_FOUND", "no such note");
    try json.respond(ctx.gpa, req, .ok, vo, null);
}

/// GET /api/controlplane/bin/note/{id}/page/{n}/text -> page {n}'s recognized
/// transcript + per-word boxes for a TRASHED note — the bin twin of the live
/// `/note/{id}/page/{n}/text`, keyed on the trashed file's CURRENT md5 through
/// `ControlPlaneService.binPageText` (`.trashed` lookup → `pageTextForMd5`).
///
/// This closes the "no on-page ovals in the bin" gap: the transcript is retained
/// md5-keyed after trash (the FTS is tombstoned by `deleted = 1`, not dropped — H10),
/// so the same builder the live route uses serves it verbatim. A live id here is a
/// 404, exactly as it is on the sibling bin page/file routes.
///
/// SAME `PageTextVO` body shape as the live route, and `no-cache` for the SAME
/// reason: the body is serialised from a Zig struct whose SHAPE nothing in the URL
/// pins, so it must never be `immutable` (the cited `words`-field regression). No
/// `?v=` (unlike the live route): a trashed blob cannot be re-synced, so page {n}'s
/// text can never change under this id — like the history text route, the md5 the
/// handler resolves pins the content. NOT `manual_db_lock`: pure DB + one KB-scale
/// ranged read, nothing streams.
pub fn controlplaneBinPageText(ctx: *Context, req: *Request, params: Params) anyerror!void {
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files orelse return serverError(ctx, req);
    const id = reply.pathId(params) orelse return badRequest(ctx, req);
    const n = std.fmt.parseInt(u64, params.get("n") orelse return badRequest(ctx, req), 10) catch
        return badRequest(ctx, req);

    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    var svc = controlplane.ControlPlaneService.init(files);

    const pt = (svc.binPageText(arena.allocator(), caller.user_id, id, n) catch return serverError(ctx, req)) orelse
        return reply.notFound(req);

    // NOT `immutable` — see the header comment and the live text route: the id
    // versions the transcript, not the JSON shape it is wrapped in.
    try json.respondWith(ctx.gpa, req, .ok, pt.vo, &.{
        .{ .name = "cache-control", .value = "no-cache" },
    });
}

/// GET /api/controlplane/bin/note/{id}/search?q={terms} -> EVERY page of a TRASHED
/// note whose recognized text matches, with a per-page count — the bin twin of the
/// live `/note/{id}/search`, keyed on the trashed file's CURRENT md5 through
/// `ControlPlaneService.binSearch`.
///
/// One COMPLETE response, no cursor (the history-search shape): it is a one-document
/// scan of the retained `note_page_index`, not the FTS the live route drains. SAME
/// `NoteSearchResults` VO (`{ query, pages: [{ pageIndex, matches, terms }],
/// usedFuzzy }`) find-in-note serves, so the reader's find bar reuses its rendering.
///
/// A live/missing id, or a folder, is a 404 — the same owned + `deleted = 1` gate the
/// bin's other note routes share (a live id here is indistinguishable from a missing
/// one, and vice versa on the live route). A missing/blank `q` is a 200 with no pages
/// (the box searches as you type). NOT `immutable` (JSON) and NOT `manual_db_lock`.
pub fn controlplaneBinNoteSearch(ctx: *Context, req: *Request, params: Params) anyerror!void {
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files orelse return serverError(ctx, req);
    const id = reply.pathId(params) orelse return badRequest(ctx, req);

    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();

    // Read the target BEFORE responding — responding invalidates head strings.
    const raw_q = reply.queryParam(req.head.target, "q") orelse "";
    const q = reply.percentDecode(arena.allocator(), raw_q) catch return serverError(ctx, req);

    var svc = controlplane.ControlPlaneService.init(files);
    const vo = (svc.binSearch(arena.allocator(), caller.user_id, id, q) catch return serverError(ctx, req)) orelse
        return fail(ctx, req, .not_found, "NOT_FOUND", "no such note");
    try json.respond(ctx.gpa, req, .ok, vo, null);
}

/// GET /api/controlplane/tree?parent={id} -> a folder's child folders + note
/// summaries, its breadcrumb, and the user's syncVersion. `parent` omitted or
/// `root` = the user's root.
///
/// NOT `manual_db_lock`, so the whole handler runs under the global DB lock —
/// which is affordable precisely because `listing` is now a pure index read: a
/// handful of single-row `SELECT`s per entry, no file opened, no `.note` parsed.
/// It previously read and parsed **every note in the folder** under this lock.
///
/// The one exception is a cold blob (never indexed, or at a stale
/// `index_version`): it is backfilled in-flight, which parses under the lock. A
/// folder of N unindexed notes therefore costs N ranged parses once — no worse
/// than the old steady state, which parsed N whole notes on *every* request —
/// and it drains permanently on the first listing.
pub fn controlplaneTree(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files orelse return serverError(ctx, req);

    const parent = reply.queryParam(req.head.target, "parent");
    var parent_id: ?u64 = null;
    if (parent) |p| {
        if (p.len != 0 and !std.mem.eql(u8, p, "root")) {
            parent_id = std.fmt.parseInt(u64, p, 10) catch return badRequest(ctx, req);
        }
    }

    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    var svc = controlplane.ControlPlaneService.init(files);
    const vo = svc.listing(arena.allocator(), caller.user_id, parent_id) catch return serverError(ctx, req);
    try json.respond(ctx.gpa, req, .ok, vo, null);
}

/// GET /api/controlplane/search?q={terms}&limit={n}&cursor={token} -> full-text
/// search over the recognized (on-device OCR) transcripts of the CALLER'S notes.
///
/// Responds `{ query, hits: [{ noteId, noteName, pageIndex, snippet, kind? }],
/// usedFuzzy, cursor? }` — at most 20 hits, display-sorted (most recently
/// updated note first). `snippet` is an HTML-safe excerpt with `<mark>` around
/// the matched terms. `kind` is omitted for a `.note` page (0) and `1` for a
/// `.txt` paragraph — `pageIndex` is a page ordinal for the former, a paragraph
/// ordinal for the latter (see `notesearch.Hit`). `cursor` is an opaque resumption token, present ONLY
/// when more results may exist; the client passes it back as `?cursor=` to
/// fetch the next page. There is deliberately NO total anywhere in the
/// response — counting every match is the exact work the early-terminating
/// query avoids, so the UI says "20+", never "20 of N". A cursor that does not
/// parse is a 400.
///
/// A missing/blank `q` is a 200 with no hits, not a 400: the browser searches as
/// you type, and an emptied box is a normal state rather than a client error.
/// `q` is the one query parameter on this face that is real user text, so it is
/// percent-decoded (see `reply.percentDecode`).
///
/// Scoping lives entirely in `notesearch.searchPages`: the partition rowid
/// range only makes the scan cheap — the `files` join on the caller's
/// `user_id` remains the boundary, necessary because the text index is keyed
/// by blob md5 and blobs are deduplicated across users.
pub fn controlplaneSearch(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files orelse return serverError(ctx, req);

    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();

    // Read the target BEFORE responding — responding invalidates head strings.
    const raw_q = reply.queryParam(req.head.target, "q") orelse "";
    const q = reply.percentDecode(arena.allocator(), raw_q) catch return serverError(ctx, req);
    const limit: i64 = if (reply.queryParam(req.head.target, "limit")) |l|
        std.fmt.parseInt(i64, l, 10) catch return badRequest(ctx, req)
    else
        notesearch.default_limit;
    const cursor = reply.queryParam(req.head.target, "cursor");

    const vo = notesearch.searchPages(arena.allocator(), files.io, files.db, caller.user_id, q, limit, cursor) catch |e| switch (e) {
        error.InvalidCursor => return badRequest(ctx, req),
        else => return serverError(ctx, req),
    };
    try json.respond(ctx.gpa, req, .ok, vo, null);
}

/// GET /api/controlplane/note/{id}/search?q={terms} -> EVERY page of one note
/// that matches, with a match count per page.
///
/// Responds `{ query, pages: [{ pageIndex, matches, terms }], usedFuzzy }`, in
/// page order. This is find-in-note's counter and its filmstrip badges; the word
/// rectangles the ovals are drawn from come separately from
/// `/note/{id}/page/{n}/text`, lazily, for the page actually on screen — so a
/// 200-page notebook costs one of these plus one page-text request per page
/// looked at.
///
/// `terms` names WHICH words each page matched, folded as the index holds them,
/// so the client circles exactly what was counted instead of re-deriving it; and
/// `usedFuzzy` reports the typo fallback, which runs here for the same reason it
/// runs on `/search` — see `notesearch.searchNotePages`.
///
/// ## Its own route, not a `noteId` on `/search`
///
/// The two answer different questions and therefore have different contracts.
/// `/search` is ranked bm25 across the library; this is UNRANKED and reaches the
/// EXACT per-note count by draining the keyset stream (bm25's window would drop
/// the note being read below other notes' hits, so a rank on this face is a
/// wrong count). It carries counts, not snippets/note names. As a sub-resource
/// of a note it sits where the note's other reads already are, beside
/// `/api/controlplane/file/metadata/{id}`.
///
/// It IS keyset-batched (a `batch` stride, not a bm25 `limit`): the fairness win
/// over the old one-shot complete scan, and — because rank plays no part —
/// draining every batch still reaches the exact count, which a finite document
/// always can.
///
/// `batch` (page stride, default `default_batch`) + `cursor` keyset the stream:
/// the response carries one batch of pages plus a `cursor` when more remain, and
/// the client auto-drains to the exact count — each batch a separate request, so
/// a separate small lock window (the fairness win, replacing the old one-shot
/// complete scan). A `cursor` that does not parse is a 400.
///
/// A missing/blank `q` is a 200 with no pages (the box searches as you type), and
/// a note id that is not the caller's is a 200 with no pages rather than a 404 —
/// the scoping lives in `notesearch.searchNotePages`, whose `files` join makes a
/// foreign, trashed and non-existent note one indistinguishable answer.
pub fn controlplaneNoteSearch(ctx: *Context, req: *Request, params: Params) anyerror!void {
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files orelse return serverError(ctx, req);
    const id = reply.pathId(params) orelse return badRequest(ctx, req);

    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();

    // Read the target BEFORE responding — responding invalidates head strings.
    const raw_q = reply.queryParam(req.head.target, "q") orelse "";
    const q = reply.percentDecode(arena.allocator(), raw_q) catch return serverError(ctx, req);
    const batch: i64 = if (reply.queryParam(req.head.target, "batch")) |b|
        std.fmt.parseInt(i64, b, 10) catch return badRequest(ctx, req)
    else
        notesearch.default_batch;
    const cursor = reply.queryParam(req.head.target, "cursor");

    const vo = notesearch.searchNotePages(arena.allocator(), files.db, caller.user_id, id, q, cursor, batch) catch |e| switch (e) {
        error.InvalidCursor => return badRequest(ctx, req),
        else => return serverError(ctx, req),
    };
    try json.respond(ctx.gpa, req, .ok, vo, null);
}

/// GET /api/controlplane/note/{id}/txt-search?q={terms} -> EVERY `.txt`
/// paragraph of one file that matches, with a per-paragraph count and byte
/// range.
///
/// Responds `{ query, segments: [{ segment, offset, length, matches, terms }],
/// usedFuzzy }`, in ordinal (= byte) order. This is find-in-txt's counter and
/// its prev/next paragraph jumps: the viewer already holds the whole file, so
/// it marks matches inside the loaded text (client-side, from `terms`) and
/// scrolls to a paragraph by its `offset`/`length` byte range.
///
/// ## Its own route, not a `kind` on `/note/{id}/search`
///
/// The note-scoped `/search` answers about `.note` PAGES (page index + count);
/// this answers about `.txt` PARAGRAPHS (ordinal + BYTE RANGE + count). They
/// carry different fields for different viewers, so a single route switching
/// its response shape on the file's kind would make the contract invisible at
/// the call site. It mirrors `/search`'s contract otherwise — complete,
/// unranked, unlimited, typo-tolerant — through `notesearch.searchTxtSegments`.
///
/// Same boundary as `/search`: the scoping is entirely in `searchTxtSegments`,
/// whose `files` join makes a foreign, trashed and non-existent file one
/// indistinguishable empty answer; a `.note` id here simply has no `kind = 1`
/// rows and so also answers empty. A missing/blank `q` is a 200 with no
/// segments (the box searches as you type).
pub fn controlplaneTxtSearch(ctx: *Context, req: *Request, params: Params) anyerror!void {
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files orelse return serverError(ctx, req);
    const id = reply.pathId(params) orelse return badRequest(ctx, req);

    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();

    // Read the target BEFORE responding — responding invalidates head strings.
    const raw_q = reply.queryParam(req.head.target, "q") orelse "";
    const q = reply.percentDecode(arena.allocator(), raw_q) catch return serverError(ctx, req);
    const batch: i64 = if (reply.queryParam(req.head.target, "batch")) |b|
        std.fmt.parseInt(i64, b, 10) catch return badRequest(ctx, req)
    else
        notesearch.default_batch;
    const cursor = reply.queryParam(req.head.target, "cursor");

    const vo = notesearch.searchTxtSegments(arena.allocator(), files.db, caller.user_id, id, q, cursor, batch) catch |e| switch (e) {
        error.InvalidCursor => return badRequest(ctx, req),
        else => return serverError(ctx, req),
    };
    try json.respond(ctx.gpa, req, .ok, vo, null);
}

/// GET /api/controlplane/file/metadata/{id} -> the full page list (per-page
/// content hash + dims). The GENERIC per-item metadata endpoint every previewable
/// kind opens with (hence `/file/metadata/`, not the `/note/` noun) — the handler
/// symbol stays `controlplaneNote`/`noteMeta` because the VO is unchanged.
///
/// Also a pure index read (one row per page, one statement), so holding the
/// global lock for the whole handler costs a few microseconds rather than a
/// whole-file read plus parse. Same cold-blob caveat as `controlplaneTree`.
pub fn controlplaneNote(ctx: *Context, req: *Request, params: Params) anyerror!void {
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files orelse return serverError(ctx, req);
    const id = reply.pathId(params) orelse return badRequest(ctx, req);

    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    var svc = controlplane.ControlPlaneService.init(files);
    const vo = (svc.noteMeta(arena.allocator(), caller.user_id, id) catch return serverError(ctx, req)) orelse
        return fail(ctx, req, .not_found, "NOT_FOUND", "no such note");
    try json.respond(ctx.gpa, req, .ok, vo, null);
}

/// GET /note/{id}/page/{n}?v={hash} -> the immutable per-page byte payload. The
/// `?v=` content hash makes the response cacheable forever (`immutable` +
/// `ETag`), so a repeat view is a browser-cache hit. A missing page or a stale
/// `?v=` is a 404, prompting the client to refetch the note's metadata.
///
/// ## Why `immutable` IS honest here (unlike the page-text route below)
///
/// The rule is: `immutable` is safe only when the cache key covers everything
/// that can change about the response. The body here is layer bitmaps lifted
/// verbatim out of the blob — opaque bytes, and `?v=` is exactly their md5. There
/// is no Zig struct serialised into this response that could gain a field on a
/// deploy, which is precisely what made `/text` unsafe.
///
/// The one thing `?v=` does NOT cover is the 20-byte SNPG envelope the server
/// synthesises around those bytes. That is deliberate and bounded: SNPG is
/// **self-describing and versioned in band** (`page_payload.MAGIC` +
/// `page_payload.VERSION`), and the decoder rejects a foreign magic or version
/// with `BadPayload`. So a format change is a loud, attributable decode error
/// rather than a silently truncated response — the opposite of the `/text` bug.
/// The decoder itself (`/note-decode.wasm`) is un-fingerprinted and therefore
/// revalidated, so it can never lag the payload format. **Bumping
/// `page_payload.VERSION` still requires turning over the `?v=` domain** (see
/// `note_index.pageContentHash`), or year-old cache entries outlive the decoder
/// that can read them.
///
/// `manual_db_lock` (same shape as `device.ossGet`): the lookup and the plan run
/// inside one narrow `ctx.db_lock` window, then the payload is **streamed** with
/// the lock released. Opening a note fires ~10 of these (stage + neighbour
/// prefetch + filmstrip thumbnails), so under the default whole-handler lock they
/// serialized against each other AND stalled device sync behind them.
///
/// The response body is never assembled: the plan carries the SNPG header, the
/// stored layer ranges, the exact `Content-Length` and the `ETag`, and
/// `writePage` pumps each layer's block out of the blob in 64 KB windows. So the
/// peak cost of serving a page is a fixed pair of buffers, whatever the page
/// weighs — and because `Content-Length` is computed from the index rather than
/// measured, the response is a plain sized body, not chunked.
pub fn controlplanePage(ctx: *Context, req: *Request, params: Params) anyerror!void {
    return pageBytes(ctx, req, params, .live);
}

/// GET /api/controlplane/bin/note/{id}/page/{n}?v={hash} -> the same payload for
/// a TRASHED note, so the reader can open a bin item (U2b). Identical in every
/// respect except the lookup: `.trashed` resolves through `Files.getTrashed`, so
/// this route can never serve a live note and `/note/{id}/page/{n}` can never
/// serve a trashed one. See `controlplaneBinNote` for why the split exists.
pub fn controlplaneBinPage(ctx: *Context, req: *Request, params: Params) anyerror!void {
    return pageBytes(ctx, req, params, .trashed);
}

fn pageBytes(ctx: *Context, req: *Request, params: Params, scope: controlplane.ControlPlaneService.ReadScope) anyerror!void {
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files orelse return serverError(ctx, req);
    const id = reply.pathId(params) orelse return badRequest(ctx, req);
    const n = std.fmt.parseInt(u64, params.get("n") orelse return badRequest(ctx, req), 10) catch
        return badRequest(ctx, req);
    // Capture `?v=` before responding (responding invalidates the head strings).
    const v = reply.queryParam(req.head.target, "v");

    var svc = controlplane.ControlPlaneService.init(files);

    // The ONLY DB touches in this handler — the route is `manual_db_lock`, so we
    // take `ctx.db_lock` for exactly these two calls and nothing more.
    // `pagePlanOf` REQUIRES the lock (it reads `note_index`, and backfills a cold
    // blob); `writePage` below runs unlocked and is contractually DB-free.
    //
    // The plan is a plain value with inline storage — no borrow of SQLite
    // statement memory survives the unlock, which is what makes streaming it
    // outside the lock safe on a shared connection.
    const planned = blk: {
        ctx.lockDb();
        defer ctx.unlockDb();
        const entry = (svc.lookup(scope, caller.user_id, id) catch return serverError(ctx, req)) orelse
            break :blk null;
        defer ctx.gpa.free(entry.name);
        defer if (entry.md5) |m| ctx.gpa.free(m);
        break :blk svc.pagePlanOf(entry, n) catch return serverError(ctx, req);
    } orelse return reply.notFound(req);

    // The version must name the exact content we hold, or the client is stale.
    // Checked against the STORED hash, so a stale `?v=` costs no file I/O at all.
    if (v == null or !std.ascii.eqlIgnoreCase(v.?, &planned.plan.content_hash))
        return reply.notFound(req);

    return writePageResponse(ctx, req, svc, planned);
}

/// Streams a resolved page's SNPG payload under the immutable, content-addressed
/// page contract — the shared tail of `pageBytes` (live/trashed) and
/// `controlplaneHistoryPage`. The caller has already resolved `planned` under the
/// DB lock AND, where its route requires it, validated `?v=`; this emits the head
/// (ETag = the page content hash, `immutable`) and pumps the layers off the blob
/// with the lock released.
///
/// `immutable` is honest on every caller: the body is opaque layer bitmaps whose
/// md5 IS `content_hash`. On the live/trashed routes `?v=` pins that; on the
/// history route the URL's `{md5}` pins the whole blob (a fixed blob's page N
/// never changes), so no `?v=` is needed there.
fn writePageResponse(ctx: *Context, req: *Request, svc: controlplane.ControlPlaneService, planned: controlplane.PagePlan) anyerror!void {
    var etag_buf: [36]u8 = undefined;
    const etag = std.fmt.bufPrint(&etag_buf, "\"{s}\"", .{planned.plan.content_hash}) catch
        return serverError(ctx, req);

    var wbuf: [blobstore.chunk_len]u8 = undefined;
    var body = req.respondStreaming(&wbuf, .{
        .content_length = planned.plan.content_length,
        .respond_options = .{ .extra_headers = &.{
            .{ .name = "content-type", .value = "application/octet-stream" },
            .{ .name = "cache-control", .value = "public, max-age=31536000, immutable" },
            .{ .name = "etag", .value = etag },
        } },
    }) catch return;

    // A mid-stream failure (a blob deleted under us, a dead socket) can no longer
    // be turned into a status code — the head is already on the wire. On failure we
    // abandon the body and return, which closes the connection: a content-length
    // body cut short by a connection close is exactly how HTTP signals truncation
    // (same as `ossGet`). We must NOT fall through to `body.end()` on that path —
    // `end()` asserts the body reached its `Content-Length`, and that assert is live
    // in a safe build, so ending a short body panics ("reached unreachable code").
    // Returning also forces the close a truncated content-length body requires: a
    // reused connection would let the client read the next response as this body's
    // missing tail. `end()` therefore runs only when every byte was written.
    svc.writePage(planned, &body.writer) catch return error.StreamTruncated;
    body.end() catch {};
}

// ---- hot-cache versioning: history of this file (phases 3-6) ----
//
// The read/write endpoints the "history of this file" UI consumes. Every one is
// note-scoped by `{id}` (the same ownership gate the sibling `/note/{id}/...`
// routes use) and, for the per-version routes, gated on `{md5}` being a RETAINED
// version of THAT file (`Files.historyVersion`) — so a stranger's md5, or an md5
// not in this file's history, is one indistinguishable 404. Being in
// `file_history` is itself the guarantee the blob + its `note_index` are on disk
// (H1/H2), so nothing here re-parses; preview reuses the page path and restore
// reuses the supersede path (`linkBlobIndexed`), verbatim.

/// GET /api/controlplane/note/{id}/history -> the file's versions, newest first:
/// the CURRENT blob (`current: true`) then each retained `file_history` row
/// (`{md5, size, createdAt}`). The UI renders timestamps and pulls each version's
/// thumbnail from the existing content-addressed `/thumbnail/{md5}` — no new
/// thumbnail work here. A foreign / missing id, or a folder, is a 404.
pub fn controlplaneHistory(ctx: *Context, req: *Request, params: Params) anyerror!void {
    return historyList(ctx, req, params, .live);
}

/// GET /api/controlplane/bin/note/{id}/history -> the version list of a TRASHED
/// file (view-only). The bin twin of `controlplaneHistory`, delegating to the SAME
/// handler with the trashed scope: `.trashed` reads the file live-vs-trashed through
/// `Files.getTrashed` and lists its RETAINED `file_history` (H10). A live id here is
/// a 404, exactly as a trashed id is on the live route. There is deliberately NO
/// per-version restore twin — the bin's restore story is "restore the FILE" (via
/// `/bin/{id}/restore`), then restore a version in the live viewer.
pub fn controlplaneBinHistory(ctx: *Context, req: *Request, params: Params) anyerror!void {
    return historyList(ctx, req, params, .trashed);
}

fn historyList(ctx: *Context, req: *Request, params: Params, scope: controlplane.ControlPlaneService.ReadScope) anyerror!void {
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files orelse return serverError(ctx, req);
    const id = reply.pathId(params) orelse return badRequest(ctx, req);

    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    var svc = controlplane.ControlPlaneService.init(files);
    const vo = (svc.historyIn(arena.allocator(), caller.user_id, id, scope) catch return serverError(ctx, req)) orelse
        return fail(ctx, req, .not_found, "NOT_FOUND", "no such note");
    try json.respond(ctx.gpa, req, .ok, vo, null);
}

/// GET /api/controlplane/note/{id}/history/{md5}/meta -> the page list + geometry
/// of a RETAINED version, read from ITS OWN retained `note_index` (H7): the
/// version's real page count, per-page dims and its `fileType`/`pxPerMm`. The
/// preview reader consumes it exactly like `/file/metadata/{id}` (`NoteMetaVO` on
/// both, one normalizer), so a version whose page count differs from the current note
/// previews with its OWN geometry rather than the live note's slots. `fileHash` is
/// the version md5 and `size` is the version's; `id`/`name` stay the file's.
///
/// A pure index read like `/file/metadata/{id}` — NOT `manual_db_lock`: nothing
/// streams, so the whole handler runs under the global DB lock, and its cache policy
/// is non-immutable (JSON serialised from a struct), exactly like the sibling
/// `/file/metadata/{id}` and `/history` reads. An md5 not in this file's history, or a
/// foreign / missing id, is one indistinguishable 404 — the gate every per-version
/// route shares (`Files.historyVersion`).
pub fn controlplaneHistoryMeta(ctx: *Context, req: *Request, params: Params) anyerror!void {
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files orelse return serverError(ctx, req);
    const id = reply.pathId(params) orelse return badRequest(ctx, req);
    const md5 = params.get("md5") orelse return badRequest(ctx, req);

    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    var svc = controlplane.ControlPlaneService.init(files);
    const vo = (svc.historyNoteMeta(arena.allocator(), caller.user_id, id, md5) catch return serverError(ctx, req)) orelse
        return fail(ctx, req, .not_found, "NOT_FOUND", "no such version");
    try json.respond(ctx.gpa, req, .ok, vo, null);
}

/// GET /api/controlplane/note/{id}/history/{md5}/page/{n} -> page `n` of a
/// RETAINED version, served through the SAME internals as the live page route
/// (`note_index` → `BlobStore.readRange` → SNPG), only keyed by `{md5}` instead
/// of the file's current blob. `manual_db_lock`, exactly like `/note/{id}/page/{n}`.
///
/// No `?v=` (unlike the live route): `{md5}` already pins the immutable blob, so
/// page `n`'s bytes can never change under this URL — the content addressing the
/// live route gets from `?v=` this route gets from `{md5}` itself. A 404 covers an
/// md5 not in this file's history, a page that does not exist, and a non-`.note`.
pub fn controlplaneHistoryPage(ctx: *Context, req: *Request, params: Params) anyerror!void {
    return historyPage(ctx, req, params, .live);
}

/// GET /api/controlplane/bin/note/{id}/history/{md5}/page/{n} -> page {n} of a
/// retained version of a TRASHED file — the bin twin of `controlplaneHistoryPage`,
/// delegating to the SAME handler with the trashed scope. Identical in every
/// respect except the gate's state (`historyVersionIn(.trashed)` requires
/// `deleted = 1`), so a live file's md5 here is a 404 and a trashed file's is one on
/// the live route. `manual_db_lock` + `immutable`, exactly like its live twin (the
/// `{md5}` pins the whole blob).
pub fn controlplaneBinHistoryPage(ctx: *Context, req: *Request, params: Params) anyerror!void {
    return historyPage(ctx, req, params, .trashed);
}

fn historyPage(ctx: *Context, req: *Request, params: Params, scope: controlplane.ControlPlaneService.ReadScope) anyerror!void {
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files orelse return serverError(ctx, req);
    const id = reply.pathId(params) orelse return badRequest(ctx, req);
    const md5 = params.get("md5") orelse return badRequest(ctx, req);
    const n = std.fmt.parseInt(u64, params.get("n") orelse return badRequest(ctx, req), 10) catch
        return badRequest(ctx, req);

    var svc = controlplane.ControlPlaneService.init(files);

    // The ONLY DB touches in this handler — the route is `manual_db_lock`, so we
    // take `ctx.db_lock` for exactly the gate + the plan (both indexed reads), then
    // stream with the lock released. The plan is inline storage with no borrow of
    // statement memory, so streaming it unlocked is safe (same as `pageBytes`).
    const planned = blk: {
        ctx.lockDb();
        defer ctx.unlockDb();
        // The gate: `{md5}` must be a retained version of THIS file, owned by the
        // caller and in `scope`'s deleted-state. A miss breaks to null → the shared 404.
        if ((files.historyVersionIn(scope, caller.user_id, id, md5) catch return serverError(ctx, req)) == null)
            break :blk null;
        break :blk svc.pagePlanForMd5(md5, n) catch return serverError(ctx, req);
    } orelse return reply.notFound(req);

    return writePageResponse(ctx, req, svc, planned);
}

/// GET /api/controlplane/note/{id}/history/{md5}/search?q={terms} -> the pages of
/// a RETAINED version whose recognized text matches, `{ query, pages: [{
/// pageIndex, matches, terms }], usedFuzzy }` — the same VO find-in-note serves,
/// so the reader's find-in-preview reuses its rendering.
///
/// A ONE-DOCUMENT scan of that version's `note_page_index.text` (H8), NOT the FTS:
/// retained versions are never in the shared index by design, so this reads the
/// OLD text directly. Exact + accent-fold, no corpus scan, no fuzzy widening.
/// A missing/blank `q` is a 200 with no pages (the box searches as you type); an
/// md5 not in this file's history is a 404.
pub fn controlplaneHistorySearch(ctx: *Context, req: *Request, params: Params) anyerror!void {
    return historySearch(ctx, req, params, .live);
}

/// GET /api/controlplane/bin/note/{id}/history/{md5}/search?q={terms} -> find-in-a-
/// retained-version of a TRASHED file — the bin twin of `controlplaneHistorySearch`,
/// delegating to the SAME handler with the trashed scope. Same one-document scan,
/// same `NoteSearchResults` VO; only the gate's state differs
/// (`historyVersionIn(.trashed)`), so a live file's md5 here is a 404.
pub fn controlplaneBinHistorySearch(ctx: *Context, req: *Request, params: Params) anyerror!void {
    return historySearch(ctx, req, params, .trashed);
}

fn historySearch(ctx: *Context, req: *Request, params: Params, scope: controlplane.ControlPlaneService.ReadScope) anyerror!void {
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files orelse return serverError(ctx, req);
    const id = reply.pathId(params) orelse return badRequest(ctx, req);
    const md5 = params.get("md5") orelse return badRequest(ctx, req);

    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();

    // The gate is a real 404 here (not an empty result like the note-wide search):
    // a per-version URL that names a version this file never had is a client error,
    // not "no matches". Same rule the preview/restore routes follow.
    if ((files.historyVersionIn(scope, caller.user_id, id, md5) catch return serverError(ctx, req)) == null)
        return fail(ctx, req, .not_found, "NOT_FOUND", "no such version");

    // Read the target BEFORE responding — responding invalidates head strings.
    const raw_q = reply.queryParam(req.head.target, "q") orelse "";
    const q = reply.percentDecode(arena.allocator(), raw_q) catch return serverError(ctx, req);

    const vo = notesearch.searchHistoryPages(arena.allocator(), files.db, md5, q) catch return serverError(ctx, req);
    try json.respond(ctx.gpa, req, .ok, vo, null);
}

/// POST /api/controlplane/note/{id}/history/{md5}/restore -> re-point the file at
/// a RETAINED version, through the SAME supersede path an upload takes
/// (`Files.restoreVersion` → `linkBlobIndexed`) — NEVER a raw `UPDATE files SET
/// md5`. That re-derives the version as CURRENT (re-indexes it into the FTS,
/// regenerates thumbnails) and retains the DISPLACED current as a new history
/// row, which is what makes restore inherently UNDOABLE ("undo" = restore the
/// displaced version). Returns the file's new current version.
///
/// An md5 not in this file's history is a 404; a restore that would exceed the
/// owner's quota is a 507 and changes nothing.
pub fn controlplaneHistoryRestore(ctx: *Context, req: *Request, params: Params) anyerror!void {
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files orelse return serverError(ctx, req);
    const id = reply.pathId(params) orelse return badRequest(ctx, req);
    const md5 = params.get("md5") orelse return badRequest(ctx, req);

    const entry = files.restoreVersion(caller.user_id, id, md5) catch |err| switch (err) {
        error.NotFound => return fail(ctx, req, .not_found, "NOT_FOUND", "no such version"),
        error.QuotaExceeded => return fail(ctx, req, .insufficient_storage, "QUOTA_EXCEEDED", "restoring this version would exceed your storage"),
        else => return serverError(ctx, req),
    };
    defer ctx.gpa.free(entry.name);
    defer if (entry.md5) |m| ctx.gpa.free(m);

    try json.respond(ctx.gpa, req, .ok, controlplane.RestoredVersionVO{
        .md5 = entry.md5 orelse "",
        .size = @intCast(entry.size),
        .createdAt = entry.updated_at * 1000, // epoch s → ms
    }, null);
}

/// GET /api/controlplane/note/{id}/history/{md5}/raw[?download=1] -> the RAW
/// stored bytes of a RETAINED version — the raw-by-version twin of the live
/// `/file/{id}?v=` route. It exists for the client-side viewers that fetch a WHOLE
/// blob rather than per-page SNPG like `.note`: `.spd` (→ `spd_decode` WASM),
/// `.txt` (→ `.text()`), and images (→ native `<img>`). Their live preview goes
/// through `/file/{id}?v=`, which serves the CURRENT blob only; this is how a
/// retained version reaches those same viewers.
///
/// Bytes + headers are IDENTICAL to `/file/{id}` for this file's name, only keyed
/// by the version `{md5}` instead of the current blob: same inline allowlist
/// (`attachment` for `.spd`/`.note`, inline for image/pdf), same `nosniff`, same
/// `?download=1` override, same streaming (`streamRawBlob`, shared with the live
/// route). The version shares the live file's NAME — so the same extension, the
/// same disposition — read from the same owner-scoped `lookup` the live route uses.
///
/// The gate is `Files.historyVersion` — the SAME shared gate the sibling
/// `/history/...` routes use — so a stranger's md5, an md5 not in THIS file's
/// history, and a foreign/trashed/missing id are one indistinguishable 404. No
/// `?v=` (unlike the live route): the path's `{md5}` already pins the immutable
/// blob, so these bytes can never change under this URL — the content addressing
/// the live route gets from `?v=` this route gets from `{md5}` itself.
///
/// `immutable`, like `/history/{md5}/page/{n}`: the `{md5}` pins the whole blob.
/// `manual_db_lock`, exactly like `/file/{id}`: the gate + the name lookup are two
/// indexed reads under one narrow lock window, then a possibly multi-MB blob
/// streams with the lock RELEASED.
pub fn controlplaneHistoryRaw(ctx: *Context, req: *Request, params: Params) anyerror!void {
    return historyRaw(ctx, req, params, .live);
}

/// GET /api/controlplane/bin/note/{id}/history/{md5}/raw[?download=1] -> the raw
/// bytes of a retained version of a TRASHED file — the bin twin of
/// `controlplaneHistoryRaw`, delegating to the SAME handler with the trashed scope.
/// The `.spd`/`.txt`/image half of previewing a past version in the bin. Both the
/// gate and the name lookup run under `scope`, so a live file's md5/id here is a 404.
/// `manual_db_lock` + `immutable`, exactly like its live twin.
pub fn controlplaneBinHistoryRaw(ctx: *Context, req: *Request, params: Params) anyerror!void {
    return historyRaw(ctx, req, params, .trashed);
}

fn historyRaw(ctx: *Context, req: *Request, params: Params, scope: controlplane.ControlPlaneService.ReadScope) anyerror!void {
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files orelse return serverError(ctx, req);
    const id = reply.pathId(params) orelse return badRequest(ctx, req);
    const md5 = params.get("md5") orelse return badRequest(ctx, req);
    // Capture query params BEFORE responding (responding invalidates head strings).
    const forced_download = if (reply.queryParam(req.head.target, "download")) |d|
        !std.mem.eql(u8, d, "0")
    else
        false;

    var svc = controlplane.ControlPlaneService.init(files);

    // The ONLY DB touches in this handler — the route is `manual_db_lock`, so we
    // take `ctx.db_lock` for exactly the gate + the name lookup (both indexed
    // reads), then stream with the lock released. `name` is `gpa.dupe`d by
    // `rowToEntry` (hence the free below), so it is no borrow of statement memory.
    const resolved = blk: {
        ctx.lockDb();
        defer ctx.unlockDb();
        // The gate: `{md5}` must be a retained version of THIS file, owned by the
        // caller and in `scope`'s deleted-state (returns the version's `{md5, size}`).
        // A miss → the shared 404.
        const v = (files.historyVersionIn(scope, caller.user_id, id, md5) catch return serverError(ctx, req)) orelse
            break :blk null;
        // The version shares the file's name (→ its extension → its disposition). The
        // lookup is the SAME owner-scoped resolve under `scope` the gate used; they
        // resolve in lock-step. We keep only `name`; the current md5 is irrelevant
        // here (we stream the VERSION's md5), so free it now.
        const entry = (svc.lookup(scope, caller.user_id, id) catch return serverError(ctx, req)) orelse
            break :blk null;
        if (entry.md5) |m| ctx.gpa.free(m);
        break :blk .{ .name = entry.name, .md5_hex = v.md5, .size = v.size };
    } orelse return reply.notFound(req);
    defer ctx.gpa.free(resolved.name);

    return streamRawBlob(ctx, req, resolved.name, &resolved.md5_hex, resolved.size, forced_download);
}

/// GET /api/controlplane/note/{id}/history/{md5}/page/{n}/text -> page `n`'s
/// recognized transcript + per-word boxes for a RETAINED version — the per-version
/// twin of the live `/note/{id}/page/{n}/text` route, read from ITS OWN retained
/// `note_page_index` (the version's `text` row + the rich `RECOGNTEXT` range via
/// `recogn_offset`/`recogn_length`). A version whose page N text differs from the
/// current blob's returns the OLD text and boxes — a pure DB read plus one KB-scale
/// ranged read, NEVER a re-parse (retention keeps the version's index, H2).
///
/// SAME body shape as the live route (`PageTextVO`: `{ text, words: [ … ] }`) so the
/// reader reuses its transcript/box rendering. No `?v=` (unlike the live route): the
/// path's `{md5}` already pins the immutable blob, so page N's text can never change
/// under this URL — the content addressing the live route earns from `?v=` this one
/// gets from `{md5}` for free.
///
/// NOT `immutable`, exactly like the live text route: the body is serialised from a
/// Zig struct, whose SHAPE the URL's `{md5}` does NOT cover (a new field would freeze
/// an old shape on a URL that never changes — the very regression the cache-policy
/// pin guards). `no-cache` lets the browser store but revalidate. NOT `manual_db_lock`,
/// also like the live text route: it is pure DB + one KB-scale ranged read, nothing
/// streams, so the whole handler runs under the global DB lock.
///
/// The gate is `Files.historyVersion` — the SAME shared gate the sibling
/// `/history/...` routes use — so a stranger's md5, an md5 not in THIS file's
/// history, and a foreign/trashed/missing id are one indistinguishable 404. A page
/// with no finished recognition falls out as a 404 too (no servable transcript row),
/// exactly as on the live route.
pub fn controlplaneHistoryPageText(ctx: *Context, req: *Request, params: Params) anyerror!void {
    return historyPageText(ctx, req, params, .live);
}

/// GET /api/controlplane/bin/note/{id}/history/{md5}/page/{n}/text -> page {n}'s
/// transcript + word boxes for a retained version of a TRASHED file — the bin twin
/// of `controlplaneHistoryPageText`, delegating to the SAME handler with the trashed
/// scope. Same `PageTextVO`, same `no-cache`/never-`immutable` policy; only the
/// gate's state differs (`historyVersionIn(.trashed)`), so a live file's md5 is a 404.
pub fn controlplaneBinHistoryPageText(ctx: *Context, req: *Request, params: Params) anyerror!void {
    return historyPageText(ctx, req, params, .trashed);
}

fn historyPageText(ctx: *Context, req: *Request, params: Params, scope: controlplane.ControlPlaneService.ReadScope) anyerror!void {
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files orelse return serverError(ctx, req);
    const id = reply.pathId(params) orelse return badRequest(ctx, req);
    const md5 = params.get("md5") orelse return badRequest(ctx, req);
    const n = std.fmt.parseInt(u64, params.get("n") orelse return badRequest(ctx, req), 10) catch
        return badRequest(ctx, req);

    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    var svc = controlplane.ControlPlaneService.init(files);

    // The gate: `{md5}` must be a retained version of THIS file, owned by the
    // caller and in `scope`'s deleted-state. A miss → the shared 404.
    const version = (files.historyVersionIn(scope, caller.user_id, id, md5) catch return serverError(ctx, req)) orelse
        return reply.notFound(req);

    // Keyed by the version's md5, not the file's current blob — so it reads the
    // VERSION's own retained transcript. `.hash` is unused here (`{md5}` pins the
    // blob, so there is no `?v=` to revalidate against).
    const pt = (svc.pageTextForMd5(arena.allocator(), &version.md5, n) catch return serverError(ctx, req)) orelse
        return reply.notFound(req);

    // NOT `immutable` — see the header comment: `{md5}` versions the transcript, not
    // the JSON shape it is wrapped in. Same policy as the live text route.
    try json.respondWith(ctx.gpa, req, .ok, pt.vo, &.{
        .{ .name = "cache-control", .value = "no-cache" },
    });
}

/// One entry of the **inline allowlist**: an extension we are willing to let the
/// browser render in-page, and the `Content-Type` we label it with.
const InlineType = struct { ext: []const u8, mime: []const u8 };

/// The types `/file/{id}` may serve with `Content-Disposition: inline`.
///
/// THE SECURITY BOUNDARY OF THIS ENDPOINT. These are device-authored bytes served
/// from the app's OWN ORIGIN, so anything the browser renders inline runs in the
/// session's context — an inline-rendered HTML or SVG file is stored XSS with
/// access to the session cookie. So the rule is an allowlist, not a denylist:
/// only these render inline, and **everything else is `attachment`**, which turns
/// an unknown or hostile type into a download rather than a page.
///
/// **`svg` is deliberately absent even though it is an image.** SVG is an XML
/// document format: it can carry `<script>`, `<foreignObject>` with HTML, and
/// event-handler attributes, and browsers execute all of it when an SVG is
/// navigated to or rendered as a document. `image/svg+xml` from an untrusted
/// author is the classic same-origin stored-XSS vector, so an `.svg` in `EXPORT/`
/// is an attachment like any other unrecognised file. (It is still safe in an
/// `<img>` tag — that context never runs script — but this endpoint cannot know
/// which context the response lands in, so it refuses the inline disposition.)
///
/// PDF is included: browsers open it in a sandboxed viewer, not as a document in
/// this origin, so it cannot reach the session the way inline markup can.
const inline_types = [_]InlineType{
    .{ .ext = "png", .mime = "image/png" },
    .{ .ext = "jpg", .mime = "image/jpeg" },
    .{ .ext = "jpeg", .mime = "image/jpeg" },
    .{ .ext = "webp", .mime = "image/webp" },
    .{ .ext = "gif", .mime = "image/gif" },
    .{ .ext = "pdf", .mime = "application/pdf" },
};

/// The allowlist entry for `name`'s extension, or null when the file is not
/// inline-renderable (which includes every extension we do not know, and `svg`).
/// Matched case-insensitively on the extension ALONE — never on the file's
/// contents — so the label we send is the one the name declares, and `nosniff`
/// stops the browser from second-guessing it.
fn inlineTypeOf(name: []const u8) ?InlineType {
    const dot = std.mem.lastIndexOfScalar(u8, name, '.') orelse return null;
    if (dot == 0 or dot + 1 == name.len) return null;
    const ext = name[dot + 1 ..];
    for (inline_types) |t| {
        if (std.ascii.eqlIgnoreCase(ext, t.ext)) return t;
    }
    return null;
}

/// GET /file/{id}?v={md5}[&download=1] -> the file's RAW stored bytes.
///
/// **One endpoint for both preview and download**; the only difference is the
/// `Content-Disposition`, which is not worth a second route. The browser face
/// needs this because a folder is not all `.note`: an exported PNG or a synced
/// PDF used to open into the reader's blank canvas, since `fallbackPage`
/// fabricates a placeholder page for any non-parseable blob. With `fileType` now
/// server-verified the SPA can branch, and this is where the bytes come from.
///
/// **The universal raw-bytes primitive.** This route returns the exact stored
/// bytes of ANY file, `.note` INCLUDED — it is the `.note` download path (the
/// reader builds it via `rawFileUrl(..., {download:true})`). There is deliberately
/// no `.note`-specific download route: the per-page SNPG path (`/note/{id}/page/{n}`)
/// is a `.note` RENDER convenience layered on top of these same bytes, never the
/// way to fetch a `.note`'s bytes. One blob-fetch primitive for every type; the
/// integration test "raw file: /file serves a .note's exact bytes as attachment"
/// pins that a `.note` flows through here like any other blob.
///
/// It is NOT `/oss/get/{id}?t=`: that is the device face, authorized by a URL
/// capability token because the device sends no session credential on its
/// download GET. This one is `.controlplane`, cookie-authed, and ownership-scoped
/// through `files.get(caller.user_id, id)` exactly like every other read here.
///
/// **404, not 403, for another user's file.** `files.get` is scoped by
/// `user_id`, so a foreign id is indistinguishable from a missing one — and that
/// is the answer we want: a 403 would confirm that the id exists and belongs to
/// somebody, turning the endpoint into an existence oracle over the whole id
/// space. Same rule the page route already follows.
///
/// `?v=` is REQUIRED and must equal the blob md5, exactly as `?v=` on the page
/// route must equal the page content hash. That is what makes the URL
/// content-addressed, and therefore what makes `immutable` honest: a file
/// replaced by a later sync gets a different md5 and so a different URL, and no
/// year-long cache entry can outlive the bytes it described. A stale `?v=` is a
/// 404 meaning "refetch the listing", costing no file I/O at all.
///
/// `manual_db_lock` (same shape as `device.ossGet`): the single `files.get` runs
/// inside one narrow `ctx.db_lock` window and the transfer runs with the lock
/// RELEASED. A PDF is the largest thing on this face; holding the one global DB
/// lock for the length of its download would stall every other request, including
/// device sync, behind it.
///
/// **Streaming, and bounded.** The body is never assembled: `Content-Length` is
/// `files.size` (authoritative since the ingested-size fix, so the response is a
/// plain sized body rather than chunked), and the bytes are pumped straight from
/// the blob through a fixed `blobstore.chunk_len` read buffer into a fixed
/// `blobstore.chunk_len` write buffer. Peak cost is those two buffers whatever the
/// file weighs — the claim in docs/explanation/resource-budget-and-streaming.md
/// holds here too. `streamExact64` bounds the pump by `Content-Length` itself, so
/// a blob that grew under us cannot overrun the declared length.
pub fn controlplaneFile(ctx: *Context, req: *Request, params: Params) anyerror!void {
    return rawFile(ctx, req, params, .live);
}

/// GET /api/controlplane/bin/file/{id}?v={md5} -> the same raw bytes for a
/// TRASHED file: the image/PDF half of previewing something before deciding
/// whether to restore it (U2b). Same allowlist, same `nosniff`, same
/// content-addressed `?v=`; only the lookup differs. See `controlplaneBinNote`.
pub fn controlplaneBinFile(ctx: *Context, req: *Request, params: Params) anyerror!void {
    return rawFile(ctx, req, params, .trashed);
}

fn rawFile(ctx: *Context, req: *Request, params: Params, scope: controlplane.ControlPlaneService.ReadScope) anyerror!void {
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files orelse return serverError(ctx, req);
    const id = reply.pathId(params) orelse return badRequest(ctx, req);
    // Capture query params BEFORE responding (responding invalidates head strings).
    const v = reply.queryParam(req.head.target, "v");
    const forced_download = if (reply.queryParam(req.head.target, "download")) |d|
        !std.mem.eql(u8, d, "0")
    else
        false;

    // The ONLY DB touch in this handler — the route is `manual_db_lock`, so we
    // take `ctx.db_lock` for exactly this call and nothing more. Safe to use
    // `entry` after the unlock: `rowToEntry` `gpa.dupe`s `name` and `md5` (hence
    // the frees below), so neither is a borrow of SQLite statement memory.
    var svc = controlplane.ControlPlaneService.init(files);
    const got = blk: {
        ctx.lockDb();
        defer ctx.unlockDb();
        break :blk svc.lookup(scope, caller.user_id, id);
    };
    const entry = (got catch return serverError(ctx, req)) orelse return reply.notFound(req);
    defer ctx.gpa.free(entry.name);
    defer if (entry.md5) |m| ctx.gpa.free(m);
    if (entry.is_folder) return reply.notFound(req);
    const md5 = entry.md5 orelse return reply.notFound(req);
    if (md5.len != blobstore.md5_hex_len) return reply.notFound(req);
    if (v == null or !std.ascii.eqlIgnoreCase(v.?, md5)) return reply.notFound(req);

    return streamRawBlob(ctx, req, entry.name, md5, entry.size, forced_download);
}

/// Streams a resolved raw blob under the `/file/{id}` contract — the shared tail
/// of `rawFile` (live/trashed) and `controlplaneHistoryRaw`. The caller has
/// already resolved `name` (which drives the inline-vs-attachment disposition
/// through `inlineTypeOf`), the blob `md5` (content-addressed → `immutable` +
/// `ETag = md5`) and its `size` (`Content-Length`) under the DB lock, and has
/// verified ownership; this opens the blob and pumps it with the lock RELEASED,
/// applying the same inline allowlist, `nosniff`, `?download=1` override, and
/// truncation discipline the live route documents.
fn streamRawBlob(ctx: *Context, req: *Request, name: []const u8, md5: []const u8, size: u64, forced_download: bool) anyerror!void {
    const files = ctx.files orelse return serverError(ctx, req);
    if (md5.len != blobstore.md5_hex_len) return reply.notFound(req);

    const allowed = inlineTypeOf(name);
    const mime = if (allowed) |t| t.mime else "application/octet-stream";
    const disposition = if (allowed != null and !forced_download) "inline" else "attachment";

    var cd_buf: [1024]u8 = undefined;
    const cd = reply.contentDisposition(&cd_buf, disposition, name) catch
        return serverError(ctx, req);

    var etag_buf: [36]u8 = undefined;
    const etag = std.fmt.bufPrint(&etag_buf, "\"{s}\"", .{md5}) catch return serverError(ctx, req);

    var file = files.blobs.open(md5) catch return reply.notFound(req);
    defer file.close(ctx.io);

    var wbuf: [blobstore.chunk_len]u8 = undefined;
    var body = req.respondStreaming(&wbuf, .{
        .content_length = size,
        .respond_options = .{
            .extra_headers = &.{
                .{ .name = "content-type", .value = mime },
                .{ .name = "content-disposition", .value = cd },
                // The label above is derived from the NAME, so it can be wrong. This
                // header is what stops a wrong label from being "corrected" by content
                // sniffing into text/html — which would re-open the same-origin script
                // execution the allowlist exists to close.
                .{ .name = "x-content-type-options", .value = "nosniff" },
                .{ .name = "cache-control", .value = "public, max-age=31536000, immutable" },
                .{ .name = "etag", .value = etag },
            },
        },
    }) catch return;

    // A mid-stream failure (a blob deleted under us, a dead socket) can no longer
    // become a status code — the head is already on the wire. On failure we return,
    // closing the connection short of `content_length` — the truncation signal —
    // rather than falling through to `body.end()`, which asserts the full length was
    // written and would panic. See the page route (`controlplanePage`) for the why.
    var rbuf: [blobstore.chunk_len]u8 = undefined;
    var fr = file.reader(ctx.io, &rbuf);
    fr.interface.streamExact64(&body.writer, size) catch return error.StreamTruncated;
    body.end() catch {};
}

/// GET /thumbnail/{hash} -> the raw bytes of the embedded thumbnail derived
/// from the blob with md5 `{hash}` — a `.spd`'s `config.thumbnail`, or a
/// `.note`'s device-rendered COVER — streamed from the `thumbs/` derived store
/// with a `Content-Type` sniffed from the file's own magic. The client routes
/// here only for types it knows may ship an embedded thumbnail (it holds the
/// file type), so there is no discriminating envelope.
///
/// **404 when the blob ships no embedded thumbnail** — a coverless `.note`
/// (most of them: covers are user-set), a `.txt`, an empty `.spd`, a corrupt
/// one — and, indistinguishably, when the caller does not hold the blob. The
/// scoping lives in `ControlPlaneService.thumbnailAllowed`
/// (`Files.holdsBlob`): a foreign or absent hash is answered exactly as "no
/// thumbnail", so the endpoint is no existence oracle over the deduplicated
/// blob space — the same rule `/file/{id}` follows for a foreign id.
///
/// **This is the on-demand heal.** Inside the same lock window as the
/// ownership check, `files.thumbNeedsRepair` asks whether the derived data is
/// missing or stale — dispatching on the blob's OWN magic (the URL carries no
/// filename) to the right format's memo (a pre-v13 database, a pre-cover
/// `note_index` row, an `index_version` bump, a restore that skipped the
/// backup-skippable `thumbs/` dir). If so the lock is RELEASED and
/// `files.repairDerivedThumb` re-derives — single-flight behind its own mutex,
/// taking the db lock itself only for the brief row write. The row is the
/// memo: a current row saying "no thumbnail" serves 404 with no derive, so a
/// corrupt `.spd` costs its deserialize — and a coverless `.note` its parse —
/// once, ever.
///
/// **Content-addressed and immutable, exactly like page bytes.** The URL is
/// keyed by the source blob md5 and the thumbnail is derived from that
/// immutable content, so a given hash maps to the same bytes forever:
/// `immutable` is honest, the `ETag` is the hash. `nosniff` because the label
/// comes from the stored bytes' own magic, not the caller's assertion; a file
/// whose magic no longer sniffs (torn on disk) is a 404, as is a size-0 file.
///
/// `manual_db_lock` (the `rawFile` shape): the DB is touched only for the
/// ownership check + repair gate, then the bytes stream fs→socket with the
/// lock released — and, sharper than the streaming argument, the repair path
/// MUST run off the handler lock (the `.spd` derive buffers up to 16 MiB of
/// untrusted SQLite, the `.note` one is a full container parse, and the lock
/// order is repair-mutex → db-lock; see `Files.thumb_repair`).
pub fn controlplaneThumbnail(ctx: *Context, req: *Request, params: Params) anyerror!void {
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files orelse return serverError(ctx, req);
    const hash = params.get("hash") orelse return badRequest(ctx, req);

    // The ONLY handler-held lock window: ownership + the repair gate. Both are
    // indexed single-row reads (`thumbNeedsRepair` adds one `access(2)` probe
    // and a `source_probe_len` head read for the format dispatch).
    var svc = controlplane.ControlPlaneService.init(files);
    const gate: struct { allowed: bool, repair: bool } = blk: {
        ctx.lockDb();
        defer ctx.unlockDb();
        const allowed = svc.thumbnailAllowed(caller.user_id, hash) catch
            break :blk .{ .allowed = false, .repair = false };
        if (!allowed) break :blk .{ .allowed = false, .repair = false };
        break :blk .{ .allowed = true, .repair = files.thumbNeedsRepair(hash) };
    };
    if (!gate.allowed) return reply.notFound(req);

    // Heal on demand, with the db lock RELEASED (repairDerivedThumb manages its
    // own locking; taking it while holding the lock would deadlock — see the
    // lock-order note on `Files.thumb_repair`). Best-effort: a failed repair
    // just leaves the miss in place and we 404 below.
    if (gate.repair) files.repairDerivedThumb(ctx, hash);

    // Dispatch on the blob's own magic (the URL carries no filename): a `.note`
    // COVER is STREAMED straight from the immutable blob at the location the
    // index recorded — never a resident copy, no `thumbs/` file — while a `.spd`
    // thumbnail is served from the `thumbs/` derived store below. `.none` (and a
    // note that ships no cover) is 404, indistinguishable from a foreign hash.
    switch (files.thumbnailSourceKind(hash)) {
        .note => return streamNoteCover(ctx, req, files, hash),
        .spd => {}, // the stored-thumbnail path below
        .none => return reply.notFound(req),
    }

    var file = files.thumbs.open(hash) catch return reply.notFound(req);
    defer file.close(ctx.io);
    const size = (file.stat(ctx.io) catch return reply.notFound(req)).size;
    if (size == 0) return reply.notFound(req); // defensive: a torn file must not serve

    // The label comes from the bytes themselves. Ingest only ever wrote bytes
    // that passed `sniffMime`, so a failure here means on-disk corruption → 404.
    var magic: [16]u8 = undefined;
    const head_len: usize = @intCast(@min(size, magic.len));
    const got = file.readPositionalAll(ctx.io, magic[0..head_len], 0) catch return reply.notFound(req);
    if (got != head_len) return reply.notFound(req);
    const mime = thumbnailmod.sniffMime(magic[0..head_len]) orelse return reply.notFound(req);

    // `hash` is 32 hex here (the ownership check passed), so the ETag fits.
    var etag_buf: [36]u8 = undefined;
    const etag = std.fmt.bufPrint(&etag_buf, "\"{s}\"", .{hash}) catch return serverError(ctx, req);

    var wbuf: [blobstore.chunk_len]u8 = undefined;
    var body = req.respondStreaming(&wbuf, .{
        .content_length = size,
        .respond_options = .{
            .extra_headers = &.{
                .{ .name = "content-type", .value = mime },
                .{ .name = "x-content-type-options", .value = "nosniff" },
                .{ .name = "cache-control", .value = "public, max-age=31536000, immutable" },
                .{ .name = "etag", .value = etag },
            },
        },
    }) catch return;

    // A mid-stream failure returns, closing the connection short of `content_length`
    // — the truncation signal — instead of falling through to `body.end()`, which
    // asserts the full length and would panic; same as `rawFile` and the page route.
    var rbuf: [blobstore.chunk_len]u8 = undefined;
    var fr = file.reader(ctx.io, &rbuf);
    fr.interface.streamExact64(&body.writer, size) catch return error.StreamTruncated;
    body.end() catch {};
}

/// Streams a `.note` COVER straight from the immutable blob — the on-demand,
/// NEVER-RESIDENT half of `/thumbnail/{hash}` (the `.spd` half above serves a
/// stored `thumbs/` file). The cover's byte offset + length + MIME come from the
/// index row (`Files.noteCover`); the bytes are read from the blob in
/// `blobstore.chunk_len` windows and written to the response as they go, so a
/// 20 MB cover costs one chunk of RSS, never the whole image. 404 when the note
/// ships no cover (the memoized negative case) — indistinguishable, like every
/// branch here, from a foreign or absent hash. Same contract as the `.spd`
/// thumbnail: sniffed/recorded `Content-Type`, `nosniff`, immutable caching, an
/// exact `Content-Length`, and a mid-stream failure that ends short of it to
/// signal truncation.
fn streamNoteCover(ctx: *Context, req: *Request, files: *filesvc.Files, hash: []const u8) anyerror!void {
    const loc = (files.noteCover(hash) catch return reply.notFound(req)) orelse return reply.notFound(req);
    // `loc` (and the MIME it hands out) is a stack value that lives for this
    // whole function — including the `streamBlobRange` call below, which runs
    // while this frame is still on the stack — so the header slice stays valid
    // across the streamed write. The cover's own hash IS its blob key.
    return streamBlobRange(ctx, req, files, hash, hash, loc.offset, loc.length, loc.mime());
}

/// The shared never-resident tail of `streamNoteCover` and `streamNoteTemplate`:
/// stream a byte RANGE of an immutable blob under the fixed thumbnail/template
/// response contract. The caller has already resolved WHAT to stream — the blob
/// key `blob_key` to read from, the `offset`/`length` of the range, its `mime`
/// label, and the `etag_hash` the ETag is built from (the same as `blob_key` for
/// a cover, but the URL's `PAGESTYLEMD5` for a template, whose blob key is a
/// different md5). Emits the recorded/sniffed `Content-Type`, `nosniff`,
/// immutable caching, an exact `Content-Length`, and — on a read or write
/// failure mid-stream — returns short of `content_length` (the truncation
/// signal) rather than reaching `body.end()`, whose length assert would panic;
/// see the page route (`controlplanePage`) for the why. Every window is
/// re-validated against the blob's real on-disk size by `readRange` (the
/// recorded offset/length came from an untrusted device's metadata). `end()`
/// runs only on a full stream.
fn streamBlobRange(
    ctx: *Context,
    req: *Request,
    files: *filesvc.Files,
    blob_key: []const u8,
    etag_hash: []const u8,
    offset: u64,
    length: u64,
    mime: []const u8,
) anyerror!void {
    // `max_template_hash_len` (64) is the larger of the two callers' hashes, so
    // this buffer also fits a cover's 32-hex hash.
    var etag_buf: [controlplane.max_template_hash_len + 2]u8 = undefined;
    const etag = std.fmt.bufPrint(&etag_buf, "\"{s}\"", .{etag_hash}) catch return serverError(ctx, req);

    var wbuf: [blobstore.chunk_len]u8 = undefined;
    var body = req.respondStreaming(&wbuf, .{
        .content_length = length,
        .respond_options = .{
            .extra_headers = &.{
                .{ .name = "content-type", .value = mime },
                .{ .name = "x-content-type-options", .value = "nosniff" },
                .{ .name = "cache-control", .value = "public, max-age=31536000, immutable" },
                .{ .name = "etag", .value = etag },
            },
        },
    }) catch return;

    var rbuf: [blobstore.chunk_len]u8 = undefined;
    var off: u64 = offset;
    var left: u64 = length;
    while (left > 0) {
        const take: usize = @intCast(@min(left, @as(u64, rbuf.len)));
        const chunk = files.blobs.readRange(blob_key, off, take, rbuf[0..take]) catch return error.StreamTruncated;
        body.writer.writeAll(chunk) catch return error.StreamTruncated;
        off += take;
        left -= take;
    }
    body.end() catch {};
}

/// GET /note/{id}/template/{hash} -> the page's custom IMAGE template
/// (PNG/JPG/JPEG/WEBP background), streamed straight from the immutable blob.
///
/// A near-verbatim clone of the page route + `streamNoteCover`: NOTE-SCOPED (the
/// `{id}` ownership check is the same gate the page bytes get), content-addressed
/// by `{hash}` (→ immutable caching, ETag = hash), and `manual_db_lock` so the
/// resolve runs in one narrow lock window and the bytes stream with the lock
/// released. The whole resolution is **pure DB + one ranged read, zero `.note`
/// parsing**: `templatePlanOf` reads the byte range already recorded in the
/// page's `layers` blob (see `note_index.templateLocation`), then the handler
/// sniffs the MIME from the range's first bytes and streams it. 404 — always
/// indistinguishable from a foreign/absent hash — when the note isn't owned,
/// isn't a `.note`, has no image background under that hash, or the range is
/// empty/over the size cap.
pub fn controlplaneTemplate(ctx: *Context, req: *Request, params: Params) anyerror!void {
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files orelse return serverError(ctx, req);
    const id = reply.pathId(params) orelse return badRequest(ctx, req);
    const hash = params.get("hash") orelse return badRequest(ctx, req);
    // A template hash is a short content hash (PAGESTYLEMD5, md5 hex). Bound the
    // path segment so a hostile URL cannot smuggle an absurd string into the
    // lookup (it is a bound SQL parameter regardless, but implausible = 404).
    if (hash.len == 0 or hash.len > controlplane.max_template_hash_len) return reply.notFound(req);

    var svc = controlplane.ControlPlaneService.init(files);

    // The ONLY DB touches in this handler — the route is `manual_db_lock`. The
    // plan is inline storage with no borrow of statement memory, so streaming it
    // outside the lock is safe on the shared connection (same as the page route).
    const planned = blk: {
        ctx.lockDb();
        defer ctx.unlockDb();
        const entry = (svc.lookup(.live, caller.user_id, id) catch return serverError(ctx, req)) orelse
            break :blk null;
        defer ctx.gpa.free(entry.name);
        defer if (entry.md5) |m| ctx.gpa.free(m);
        break :blk svc.templatePlanOf(entry, hash) catch return serverError(ctx, req);
    } orelse return reply.notFound(req);

    return streamNoteTemplate(ctx, req, files, planned, hash);
}

/// Streams a resolved custom template's bytes from the immutable blob — the
/// never-resident tail of `controlplaneTemplate`, mirroring `streamNoteCover`.
/// Sniffs the `Content-Type` from the range's own magic (`nosniff`), caps the
/// stream at the cover's 20 MB ceiling (`thumbnail.max_cover_bytes` — a 404 above
/// it), and ends short on a mid-stream failure to signal truncation.
fn streamNoteTemplate(
    ctx: *Context,
    req: *Request,
    files: *filesvc.Files,
    plan: controlplane.TemplatePlan,
    hash: []const u8,
) anyerror!void {
    // Reuse the cover's 20 MB stream cap (Ratta removed the device-side limit);
    // refuse anything larger rather than stream it.
    if (plan.length == 0 or plan.length > thumbnailmod.max_cover_bytes) return reply.notFound(req);

    // The label comes from the range's own bytes, never the caller's assertion.
    var magic: [16]u8 = undefined;
    const head_len: usize = @intCast(@min(plan.length, @as(u64, magic.len)));
    const got = files.blobs.readRange(&plan.md5, plan.offset, head_len, magic[0..head_len]) catch
        return reply.notFound(req);
    const mime = thumbnailmod.sniffMime(got) orelse return reply.notFound(req);

    // The blob key is the plan's md5 (a different hash from the URL's
    // `PAGESTYLEMD5`, which is the ETag hash); the streamed tail is shared with
    // the cover route.
    return streamBlobRange(ctx, req, files, &plan.md5, hash, plan.offset, plan.length, mime);
}

/// GET /note/{id}/page/{n}/text?v={textHash} -> one page's recognized (on-device
/// OCR) transcript: `{ text?: string }`, a raw VO with no `{success}` envelope.
///
/// The sibling of the page-bytes route and versioned the same way, except by
/// `text_hash` — the md5 of the page's `RECOGNTEXT` block — so the URL turns over
/// exactly when the recognition does and never when the strokes change.
///
/// ## Why this is `no-cache` and the page-bytes route is not
///
/// It WAS `immutable, max-age=1y`, and that was a bug. `?v={text_hash}` versions
/// the *content* — it says nothing about the *shape* of the JSON we wrap that
/// content in. `PageTextVO` is a Zig struct; the day it gained `words`, every
/// browser holding a cached response kept its old, wordless copy for a YEAR, on a
/// URL that could never change and with no validator to revalidate against. The
/// failure was silent end to end: the note metadata (not immutably cached) carried
/// `pxPerMm` fine, the match counter came from a different request and was
/// correct, and the page simply had nothing circled on it. No error, no console
/// warning, and it looked note-specific because different notes had been cached at
/// different moments.
///
/// The rule this route now follows: **`immutable` is safe only when the cache key
/// covers everything that can change about the response.** A content hash covers
/// opaque bytes. It cannot cover a struct that can gain or lose a field on any
/// deploy, so a response serialised from one does not get to be `immutable`.
///
/// `no-cache` still lets the browser STORE the response; it just forbids blind
/// reuse, so a shape change is picked up on the next load instead of the next
/// year. The cost is one small request, and this is the route that can afford it:
/// it is pure DB plus one KB-scale ranged read (2–10 KB of JSON), it is explicitly
/// NOT `manual_db_lock` because the streaming argument does not apply to it, and
/// the frontend already memoises transcripts and word boxes per note — so a page
/// is fetched at most once per session either way. Contrast `/note/:id/page/:n`,
/// which is multi-MB, fires ~10 times on every note open, and carries opaque
/// bytes: it keeps `immutable`, and the comments there say why.
///
/// **404 means "your metadata is stale, refetch it"**, same contract as page
/// bytes, and it covers three cases with one rule — no such note/page, a `?v=`
/// that doesn't match, and a page with no finished recognition. The last falls
/// out rather than being special-cased: with no `text_hash` there is no `?v=`
/// that could match. A client following the contract never asks (`PageRef.textHash`
/// is null, and `Api.getPageText` short-circuits on it), so reaching this is
/// either a hand-made URL or a stale page list — and "refetch the metadata" is
/// the right answer to both.
///
/// Pure DB: the transcript was extracted at index time. No `.note` is opened.
///
/// The body is **device-authored content**. It is emitted as a JSON string and
/// nothing here presumes it is markup; the frontend sets it via `textContent`.
pub fn controlplanePageText(ctx: *Context, req: *Request, params: Params) anyerror!void {
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files orelse return serverError(ctx, req);
    const id = reply.pathId(params) orelse return badRequest(ctx, req);
    const n = std.fmt.parseInt(u64, params.get("n") orelse return badRequest(ctx, req), 10) catch
        return badRequest(ctx, req);
    // Capture `?v=` before responding (responding invalidates the head strings).
    const v = reply.queryParam(req.head.target, "v");

    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    var svc = controlplane.ControlPlaneService.init(files);

    const pt = (svc.pageText(arena.allocator(), caller.user_id, id, n) catch return serverError(ctx, req)) orelse
        return reply.notFound(req);
    if (v == null or !std.ascii.eqlIgnoreCase(v.?, &pt.hash)) return reply.notFound(req);

    // NOT `immutable` — see the header comment. `?v=` versions the transcript,
    // not the JSON shape it is wrapped in.
    try json.respondWith(ctx.gpa, req, .ok, pt.vo, &.{
        .{ .name = "cache-control", .value = "no-cache" },
    });
}

/// The response headers shared by both shapes of this endpoint. `no-store` and
/// `nosniff` are hygiene; `x-accel-buffering: no` is the load-bearing one — a
/// buffering reverse proxy would hold each frame back until its buffer filled,
/// which for a stream that emits ~20 bytes a minute means the live channel never
/// delivers anything at all while looking perfectly healthy.
const sse_headers = [_]std.http.Header{
    .{ .name = "content-type", .value = "text/event-stream" },
    .{ .name = "cache-control", .value = "no-store" },
    .{ .name = "x-content-type-options", .value = "nosniff" },
    .{ .name = "x-accel-buffering", .value = "no" },
};

/// The DEGRADED shape of `/api/controlplane/events`: one `event: sync` frame
/// carrying the current version, then close.
///
/// Not an error path — a deliberate fallback, and the *only* behaviour this
/// endpoint had before streaming existed. The client cannot tell the two apart
/// beyond the connection closing, and `EventSource` reacts to a closed stream by
/// reconnecting after `retry:`. So an over-cap or non-serve-mode caller silently
/// becomes a `retry_ms` poller and stays correct; nothing in the frontend needs
/// to know which shape it got.
fn eventsOneShot(ctx: *Context, req: *Request, sync_version: i64) anyerror!void {
    var buf: [128]u8 = undefined;
    const body = std.fmt.bufPrint(&buf, "retry: {d}\nevent: sync\ndata: {d}\n\n", .{
        eventstreams.retry_ms, sync_version,
    }) catch return serverError(ctx, req);
    try req.respond(body, .{
        .keep_alive = false,
        .extra_headers = &sse_headers,
    });
}

/// GET /api/controlplane/events -> the live-freshness (SSE) channel: the caller's
/// `syncVersion`, pushed whenever it CHANGES, on a held connection.
///
/// ## Why this can hold a connection now
///
/// It could not before: serve mode ran a single-threaded accept loop, so a parked
/// stream wedged it and nothing else could be served. Serve mode now spawns a
/// thread per connection, so a parked stream costs one thread and one connection
/// slot and blocks nobody. `ctx.event_streams` is what says so — it is set only by
/// `transport.run`, and a null one (the integration harness, which drives
/// `handle()` over in-memory buffers with no thread to park on) takes the one-shot
/// path below.
///
/// ## `manual_db_lock`, and why it is not optional here
///
/// THE WHOLE-HANDLER DB LOCK AND A HELD STREAM ARE INCOMPATIBLE. Under the default
/// policy this handler would hold the one global `db_lock` for the stream's entire
/// lifetime — minutes — and every other request on the server would block on it:
/// not just the browser, but DEVICE SYNC. A single open browser tab would stop the
/// Nomad from syncing, and the symptom (sync mysteriously stalls while the web UI
/// works) points nowhere near here.
///
/// So the route is `manual_db_lock` and follows the discipline `/oss/get/:id`,
/// `/note/:id/page/:n` and `/file/:id` already established: take `ctx.db_lock`
/// around each DB touch and NOTHING else. Every DB access in this handler is a
/// single `files.syncVersion` — one indexed single-row SELECT — inside its own
/// `lockDb`/`unlockDb` bracket. The lock is never held across the sleep, the
/// socket write, or the flush.
///
/// ## The loop
///
/// Poll `syncVersion` every `poll_interval_ms`; emit `event: sync` only when it
/// differs from what we last sent (see `event_streams.zig` for why polling rather
/// than a broadcast from the write path). Emit a `: ping` comment frame when
/// nothing has gone out for `heartbeat_ms`, so a dead connection is detected by
/// both ends rather than parked forever. End cleanly after `max_lifetime_ms`.
///
/// ## Teardown
///
/// Every exit — a closed tab, a dropped link, a lifetime expiry, a DB error —
/// leaves the loop, runs the `defer` that returns the stream slot, and returns
/// from the handler; `serve` then finds the connection dead, `connThread`
/// releases its connection slot and the thread ends. A disconnected client is
/// discovered by the first write that fails, which is exactly what the heartbeat
/// guarantees will happen within `heartbeat_ms` even on a stream with no news.
pub fn controlplaneEvents(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files orelse return serverError(ctx, req);

    // DB touch #1 of 2 in this handler, and the only one before the head is sent.
    const initial: i64 = blk: {
        ctx.lockDb();
        defer ctx.unlockDb();
        break :blk files.syncVersion(caller.user_id) catch 0;
    };

    const streams = ctx.event_streams orelse return eventsOneShot(ctx, req, initial);
    if (!streams.tryAcquire(ctx.io, caller.user_id)) return eventsOneShot(ctx, req, initial);
    // THE slot-balance guarantee: one release per successful acquire, on every
    // path out of the handler including the error returns below.
    defer streams.release(ctx.io, caller.user_id);

    // No `content_length` -> chunked, which is what lets the body stay open. A
    // failure from here on cannot become a status code (the head is on the wire),
    // so every write is `catch break`/`catch return` and the client sees the
    // stream end — which `EventSource` handles by reconnecting.
    var wbuf: [256]u8 = undefined;
    var body = req.respondStreaming(&wbuf, .{
        .respond_options = .{ .keep_alive = false, .extra_headers = &sse_headers },
    }) catch return;

    body.writer.print("retry: {d}\nevent: sync\ndata: {d}\n\n", .{ eventstreams.retry_ms, initial }) catch return;
    body.flush() catch return;

    var last = initial;
    var since_write_ms: i64 = 0;
    var lived_ms: i64 = 0;

    while (lived_ms < streams.max_lifetime_ms) {
        // Unlocked wait. Cancellation (shutdown) ends the stream cleanly.
        ctx.io.sleep(.fromMilliseconds(streams.poll_interval_ms), .awake) catch break; // .awake = CLOCK_MONOTONIC
        lived_ms += streams.poll_interval_ms;
        since_write_ms += streams.poll_interval_ms;

        // DB touch #2 of 2. Narrow bracket, taken and released every tick — this
        // is the difference between a stream that costs microseconds of global
        // lock per second and one that freezes device sync for its whole life.
        // A read error is treated as "no change": a transient DB failure must not
        // fabricate a version bump that would make every client refetch.
        const current: i64 = blk: {
            ctx.lockDb();
            defer ctx.unlockDb();
            break :blk files.syncVersion(caller.user_id) catch last;
        };

        if (current != last) {
            last = current;
            since_write_ms = 0;
            body.writer.print("event: sync\ndata: {d}\n\n", .{current}) catch break;
            body.flush() catch break;
        } else if (since_write_ms >= streams.heartbeat_ms) {
            since_write_ms = 0;
            // A comment frame: `EventSource` ignores it, but the bytes are what
            // make a dead peer surface as a write error rather than a silent park.
            body.writer.writeAll(": ping\n\n") catch break;
            body.flush() catch break;
        }
    }

    body.end() catch {};
}
