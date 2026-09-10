//! Device / sync handlers (the device face): the pre-login probes
//! (check/exists, query/server, lenient unlink), bind, user/query, the sync
//! session bracket (start/end), the hash-diff read path (summary hash/id/group),
//! and the Planner stubs. Thin HTTP shells over `files` + the `SyncService`.

const std = @import("std");
const router = @import("../http/router.zig");
const context = @import("../http/context.zig");
const json = @import("../http/json.zig");
const reply = @import("../http/reply.zig");
const multipart = @import("../http/multipart.zig");
const upload_cap = @import("upload_cap.zig");
const sync = @import("../services/sync.zig");
const filesmod = @import("../services/files.zig");
const authsvc = @import("../services/auth/service.zig");
const blobstore = @import("../store/blobs.zig");

const Context = context.Context;
const Request = router.Request;
const Params = router.Params;
const fail = reply.fail;
const badRequest = reply.badRequest;
const serverError = reply.serverError;

/// Sane upper bound on any device-supplied byte count (`upload/apply` `size`).
/// A `.note` is MB-scale, so this is generous headroom yet far below `i64max` —
/// downstream arithmetic (`used + size`) stays overflow-proof, so one malformed
/// request can't panic the server. Values above it are rejected, not clamped.
pub const max_declared_bytes: i64 = 64 * 1024 * 1024 * 1024; // 64 GiB

// ---- request/response bodies ----

/// `label` is the device's default folder tree (e.g. `["NOTE/Note","EXPORT",…]`).
///
/// `totalCapacity` is the DEVICE'S OWN storage size, not a request for cloud
/// quota: the official spec names it 设备总容量 ("device total capacity"), and the
/// live Nomad sent `"25485312"` — 24.3 GiB in KB, which is a 32 GB device's
/// formatted user space, not a plausible cloud allocation. We ignore it
/// entirely (`bindEquipment` below); it is parsed only so the field is
/// documented and does not read as unhandled.
const BindReq = struct {
    equipmentNo: []const u8,
    /// The account the device is binding to. Only consulted when the request
    /// arrives WITHOUT a token — see `bindEquipment`. Never trusted on its own.
    account: ?[]const u8 = null,
    name: ?[]const u8 = null,
    label: ?[]const []const u8 = null,
    totalCapacity: ?[]const u8 = null,
};
const UnbindReq = struct { equipmentNo: []const u8 };

const UserCheckReq = struct { email: ?[]const u8 = null };
const UserQueryVO = struct { success: bool = true, email: []const u8, userName: []const u8, totalCapacity: []const u8 };

/// `get_space_usage`: the storage figure the device shows, and the gate the
/// "select folders to sync" screen reads before it will render. The Nomad calls
/// it ~4× per sync session.
///
/// The field names + nesting are LITERAL, matched to a live capture-passthrough
/// exchange with a real Nomad (which accepted exactly this shape and then
/// rendered the folder-selection screen): `used` and `allocationVO.allocated`
/// are BYTES, and `tag` is the account class. Do not tidy them, and do not add
/// fields the device was never observed to receive.
const SpaceUsageReq = struct { equipmentNo: ?[]const u8 = null, version: ?[]const u8 = null };
const AllocationVO = struct { tag: []const u8 = "Individual", allocated: i64 };
const SpaceUsageVO = struct { success: bool = true, used: i64, allocationVO: AllocationVO };

const SyncStartReq = struct { equipmentNo: ?[]const u8 = null };
const SyncStartVO = struct { success: bool = true, equipmentNo: []const u8, synType: bool = true };
const SyncEndReq = struct { equipmentNo: ?[]const u8 = null, flag: ?[]const u8 = null };
const SyncEndVO = struct { success: bool = true, equipmentNo: []const u8 };

/// Paginated query bodies. `page` is 0-based; `size <= 0` (or absent) = all.
const PageReq = struct { page: ?i32 = null, size: ?i32 = null };
const SummaryByIdReq = struct { ids: ?[]const i64 = null, page: ?i32 = null, size: ?i32 = null };

/// One file/folder as the device's file API expects it. The JSON field names are
/// literal (a mix of snake_case and camelCase) — matched to a live capture + the
/// allenporter reference; do not "tidy" them.
///
/// FLAGGED ASSUMPTIONS to validate on re-capture against the live Nomad:
///   - `path_display` uses Dropbox format: leading slash, NO trailing slash.
///   - `lastUpdateTime` is MILLISECONDS (`files.updated_at * 1000`).
///   - `is_downloadable = !is_folder`.
const EntriesVO = struct {
    tag: []const u8, // "file" | "folder"
    id: []const u8, // our files.id, as a string
    name: []const u8,
    path_display: []const u8,
    content_hash: []const u8, // md5 for files; "" for folders
    is_downloadable: bool,
    size: i64,
    lastUpdateTime: i64,
    parent_path: []const u8,
};

const ListFolderReq = struct { path: ?[]const u8 = null, recursive: ?bool = null, equipmentNo: ?[]const u8 = null };
const ListFolderVO = struct { success: bool = true, equipmentNo: []const u8, entries: []const EntriesVO };

const QueryByPathReq = struct { path: ?[]const u8 = null };
const QueryByIdReq = struct { id: ?[]const u8 = null };
/// `entriesVO` is optional so a not-found resolves to `{success,equipmentNo}`
/// with the field OMITTED (json.respond drops null optionals).
const EntriesQueryVO = struct { success: bool = true, equipmentNo: []const u8, entriesVO: ?EntriesVO = null };

const DownloadReq = struct { id: ?[]const u8 = null };
const DownloadVO = struct {
    success: bool = true,
    equipmentNo: []const u8,
    id: []const u8,
    url: []const u8,
    name: []const u8,
    path_display: []const u8,
    content_hash: []const u8,
    size: i64,
    is_downloadable: bool,
};

/// Device delete (`delete_folder_v3`). Despite the name it deletes FILES as well
/// as folders — the capture's `id: "19"` was a note. `metadata` is optional so an
/// unknown id resolves to `{success,equipmentNo}` with the field OMITTED, the
/// same shape `EntriesQueryVO` uses on this face.
const DeleteFolderReq = struct { id: ?[]const u8 = null, equipmentNo: ?[]const u8 = null };
const DeleteMetadataVO = struct {
    tag: []const u8, // "file" | "folder"
    id: []const u8, // our files.id, as a string
    name: []const u8,
};
const DeleteFolderVO = struct { success: bool = true, equipmentNo: []const u8, metadata: ?DeleteMetadataVO = null };

/// Device folder creation (`create_folder_v2`). Shapes taken from the official
/// spec's `CreateFolderLocalDTO`/`CreateFolderLocalVO` (`equipmentNo`, `path`,
/// `autorename` in; `{success, equipmentNo, metadata}` out) and from the live
/// capture, which sent `{"autorename": false, "path": …}`.
///
/// `CreateMetadataVO` carries `path_display` where `DeleteMetadataVO` does not:
/// the spec's shared `MetadataVO` has it, and here it is load-bearing rather
/// than decorative — under `autorename` the created folder's name is the
/// server's choice, so the path is the only way the device learns where its
/// folder actually landed.
const CreateFolderReq = struct {
    path: ?[]const u8 = null,
    autorename: ?bool = null,
    equipmentNo: ?[]const u8 = null,
};
const CreateMetadataVO = struct {
    tag: []const u8 = "folder",
    id: []const u8,
    name: []const u8,
    path_display: []const u8,
};
const CreateFolderVO = struct { success: bool = true, equipmentNo: []const u8, metadata: ?CreateMetadataVO = null };

/// Device move/rename (`move_v3`). The captured body is
/// `{"id","to_path","autorename","equipmentNo"}`, and `to_path` is the FULL
/// destination path INCLUDING the final filename — the OpenAPI contract's "parent
/// directory" wording is WRONG; the real Nomad sends the whole path (e.g.
/// `/NOTE/Note/corpus/note/custom_template.note`). A RENAME is a `to_path` with
/// the same parent and a new final segment; a MOVE is a different parent — one
/// unified operation. `id` is the cloud id as a STRING (parsed leniently, like
/// every other device handler). `autorename` governs the destination name on a
/// conflict.
const MoveReq = struct {
    id: ?[]const u8 = null,
    to_path: ?[]const u8 = null,
    autorename: ?bool = null,
    equipmentNo: ?[]const u8 = null,
};

/// `FileMoveLocalVO`. `entriesVO` is optional so every idempotent never-404 case
/// (unknown / foreign / already-trashed id, an unusable path, a real name
/// conflict under `autorename:false`, or a self-into-subtree move) resolves to
/// `{success, equipmentNo}` with the field OMITTED — the settled shape
/// `delete_folder_v3` / `create_folder_v2` already use on this face. When the move
/// happens it carries the entry AFTER the move (its new `path_display` / `name`),
/// which is how the device learns where the file actually landed — including the
/// server's autorename choice.
const MoveVO = struct { success: bool = true, equipmentNo: []const u8, entriesVO: ?EntriesVO = null };

/// Upload handshake (M2). `upload/apply` reserves an upload; `/oss/put` receives
/// the bytes; `upload/finish` commits. Field names are literal (matched to the
/// live capture). `apply.size` is an int; `finish.size` is a STRING (unused — the
/// authoritative size is the one bound at apply).
const UploadApplyReq = struct { path: []const u8, fileName: []const u8, equipmentNo: ?[]const u8 = null, size: i64 = 0 };
const UploadApplyVO = struct {
    success: bool = true,
    equipmentNo: []const u8,
    bucketName: []const u8 = "ufile",
    innerName: []const u8,
    // Cosmetic S3-style fields the device echoes but we don't verify (our OSS is
    // JWT-authed): stable placeholders, exactly as the capture returned.
    xAmzDate: []const u8 = "20260101T000000Z",
    authorization: []const u8 = "capture",
    fullUploadUrl: []const u8,
    partUploadUrl: []const u8,
};

const UploadFinishReq = struct {
    content_hash: []const u8,
    equipmentNo: ?[]const u8 = null,
    fileName: ?[]const u8 = null,
    innerName: []const u8,
    path: ?[]const u8 = null,
    size: ?[]const u8 = null,
};
const UploadFinishVO = struct {
    success: bool = true,
    equipmentNo: []const u8,
    id: []const u8, // the real created files.id, as a string
    name: []const u8,
    path_display: []const u8,
    size: i64 = 0, // the capture returned 0 here; the device ignores it
    content_hash: []const u8,
};

/// Planner (calendar/to-do) stubs — empty lists keep the device's Planner app
/// from erroring during a note sync; it is not part of the file protocol.
const ScheduleGroupAllVO = struct { success: bool = true, pageToken: []const u8 = "", scheduleTaskGroup: []const struct {} = &.{} };
const ScheduleTaskAllVO = struct { success: bool = true, nextPageToken: []const u8 = "", nextSyncToken: i64 = 0, scheduleTask: []const struct {} = &.{} };

// ---- handlers ----

/// Resolve the device serial for a request, and LAZILY auto-bind it.
///
/// The order is the settled one: the body's `equipmentNo` (the app and Nomad both
/// put it on every file call) wins, then the `x-access-token`-resolved header
/// serial, then "". Centralised in ONE place — the ~half-dozen device handlers
/// used to inline `parsed.value.equipmentNo orelse caller.equipmentNo() orelse ""`,
/// and the auto-bind must not drift between them.
///
/// The official app never calls `bindEquipment`, so its `ANDROID-…` id is unknown
/// until the first file call carries it. When a device caller presents a body
/// serial that is not yet bound, bind it here (idempotent via `bindDevice`) so the
/// app appears in the admin device list and becomes remotely unlinkable, matching
/// the Nomad. Binding is `user_id`-scoped, so an app can only ever bind a serial to
/// its OWN account. Best-effort: a bind failure must never fail the file call.
fn resolveEquipment(ctx: *Context, body_eno: ?[]const u8, caller: *const context.Caller) []const u8 {
    const eno = body_eno orelse caller.equipmentNo() orelse "";
    if (caller.audience == .device and body_eno != null and eno.len > 0) {
        const svc = ctx.service.?;
        if (!(svc.isDeviceBound(caller.user_id, eno) catch true)) {
            // "Supernote", not "Supernote app". This path fires for ANY device
            // caller presenting a body serial — the Nomad included — so the old
            // label told people their e-ink tablet was a phone app, on a project
            // that deliberately does not support the phone app at all. It is a
            // PLACEHOLDER standing in until `bindEquipment` reports the real
            // name, so it should be the least wrong thing we can say, not a
            // guess at hardware we have not been told about.
            svc.bindDevice(caller.user_id, eno, "Supernote") catch {};
            // Worth a line: this is a device appearing on the account WITHOUT
            // having introduced itself, so whatever the screen shows for it is a
            // placeholder until `bindEquipment` arrives. When somebody asks why
            // their tablet is called "Supernote", this is the answer.
            std.log.info("device {s} auto-bound from a file call; no name reported yet", .{eno});
        }
    }
    return eno;
}

/// POST /api/terminal/equipment/unlink -> the device's **pre-login** unlink. It
/// carries no token (it clears its binding before re-binding), so this route is
/// public and lenient: best-effort, always succeeds.
///
/// SECURITY: when there is NO caller (the unauthenticated pre-login case) we do
/// NOT touch any binding or session — we just return the lenient success the
/// device expects. The subsequent `bindEquipment` re-establishes the binding, so
/// the destructive global-unbind is unnecessary for the device flow; performing
/// it here would let any unauthenticated client on the LAN force-unbind and log
/// out the household's device by its (printed) serial — a trivial DoS. Only an
/// authenticated caller gets a real unlink, scoped to its own account.
///
/// FLAGGED: this changes device-facing pre-login behavior and must be
/// re-validated against a live Nomad capture. Low-risk by construction (bind
/// re-establishes the binding), but unverified on hardware.
pub fn unlinkEquipmentLenient(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const svc = ctx.service.?;
    var parsed = json.readBody(UnbindReq, ctx.gpa, req) catch return badRequest(ctx, req);
    defer parsed.deinit();
    const eno = parsed.value.equipmentNo;
    if (ctx.caller) |c| {
        svc.unlinkDevice(c.user_id, eno) catch {};
    }
    // else: unauthenticated pre-login — intentionally a no-op (see doc comment).
    try json.respond(ctx.gpa, req, .ok, reply.BaseVO{ .success = true }, null);
}

/// POST …/check/exists/server -> does an account with this email exist here?
/// (`success:true` iff it does; a private-cloud drop-in has no "other server".)
pub fn checkExists(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const svc = ctx.service.?;
    var parsed = json.readBody(UserCheckReq, ctx.gpa, req) catch return badRequest(ctx, req);
    defer parsed.deinit();
    const email = parsed.value.email orelse return fail(ctx, req, .ok, "BAD_REQUEST", "email required");
    const exists = svc.userExistsByEmail(email) catch return serverError(ctx, req);
    if (exists) {
        try json.respond(ctx.gpa, req, .ok, reply.BaseVO{ .success = true }, null);
    } else {
        try fail(ctx, req, .ok, "USER_NOT_FOUND", "no such account");
    }
}

/// GET /api/file/query/server -> connectivity ping.
pub fn queryServer(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    try json.respond(ctx.gpa, req, .ok, reply.BaseVO{ .success = true }, null);
}

/// POST …/bindEquipment -> auto-bind the calling device to its user, then
/// provision its default `label` root folders and adopt its reported capacity.
pub fn bindEquipment(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const svc = ctx.service.?;
    var parsed = json.readBody(BindReq, ctx.gpa, req) catch return badRequest(ctx, req);
    defer parsed.deinit();
    const in = parsed.value;

    // THIS ROUTE ACCEPTS AN UNAUTHENTICATED CALL, and only this one.
    //
    // The Nomad fires `bindEquipment` SIX MILLISECONDS before it stores the token
    // its login just returned, so the one request
    // carrying the device's name goes out with no `x-access-token`. Requiring the
    // token meant answering 401 to every pairing: the handler never ran, the name
    // never landed, and the account screen showed a placeholder for a tablet that
    // had said what it was called — while sync worked perfectly, because the
    // binding itself already existed. Nothing about the failure was visible.
    //
    // With no token we fall back to the session that login just created for THIS
    // serial and THIS account. That is the token's own evidence read from the
    // sessions table rather than the header, and it is strictly narrower than
    // trusting the body: an unknown serial, or one whose live session belongs to
    // somebody else, is still refused. A caller cannot reach an account it could
    // not already log into.
    const user_id = if (ctx.caller) |c| c.user_id else blk: {
        const account = in.account orelse return fail(ctx, req, .unauthorized, "UNAUTHORIZED", "unauthorized");
        const owner = svc.deviceSessionOwner(in.equipmentNo, account) catch return serverError(ctx, req);
        break :blk owner orelse return fail(ctx, req, .unauthorized, "UNAUTHORIZED", "unauthorized");
    };

    const name = in.name orelse "Supernote";
    svc.bindDevice(user_id, in.equipmentNo, name) catch return serverError(ctx, req);
    // THE DEVICE'S OWN NAME WINS. `bindDevice` never overwrites an existing
    // label — it runs on every login and a placeholder must not clobber a real
    // name — but this call IS the device saying what it is called, and by now the
    // row usually exists already: `resolveEquipment` binds the serial on the
    // first file call and stamps the literal "Supernote app". Without this the
    // screen showed that placeholder for ever, for a tablet that had reported
    // "Supernote Nomad AA". Passed `in.name` and not `name`, so the fallback can
    // never overwrite a good label with a generic one.
    if (in.name) |reported| svc.nameDevice(user_id, in.equipmentNo, reported) catch {};
    // The one place a device tells us what it is called, and it happens when the
    // account is ADDED rather than on every login — so a name that never updates
    // is usually a `bindEquipment` that never arrived. Logged with what was
    // actually reported, so that is answerable from the record instead of guessed.
    if (in.name) |reported| {
        std.log.info("device {s} bound via bindEquipment, reported name \"{s}\"", .{ in.equipmentNo, reported });
    } else {
        std.log.info("device {s} bound via bindEquipment but reported NO name", .{in.equipmentNo});
    }

    // Ensure the capacity row EXISTS (a freshly-onboarded account may not have one
    // yet, and the upload quota pre-check must never 500 on a missing row) WITHOUT
    // letting the device set it: `ensureCapacity` is INSERT OR IGNORE, so an
    // existing quota (the server default from user creation, or an admin-set value)
    // is preserved. We deliberately ignore the device-reported `totalCapacity` — a
    // device-token holder must not be able to self-raise or clobber its quota.
    svc.ensureCapacity(user_id, authsvc.default_capacity) catch {};
    // Auto-create the default folder tree (idempotent; best-effort per label).
    if (ctx.files) |files| {
        if (in.label) |labels| {
            for (labels) |path| _ = files.ensureFolderPath(user_id, path) catch {};
        }
    }
    try json.respond(ctx.gpa, req, .ok, reply.BaseVO{ .success = true }, null);
}

/// POST /api/user/query -> the calling device's user-info VO.
///
/// `totalCapacity` is emitted as RAW BYTES, and that is a deliberate
/// non-decision rather than a verified one. It was suspected of being 1024x
/// too large, on the theory that the device round-trips the `totalCapacity` it
/// sends at bind time (documented as KB). That theory is refuted: the bind
/// field is the DEVICE's own storage size (see `BindReq`), while this one lives
/// in the account-profile VO alongside `email`/`userName`/`fileServer` — a
/// different quantity, so there is no round trip to preserve units through.
///
/// What is CONFIRMED is only the neighbouring endpoint: `get_space_usage` is in
/// bytes (a live Nomad rendered "3 MB / 10.0 GB" from `used_bytes = 3347435`,
/// `total_bytes = 10737418240`). Bytes here is the consistent guess, not an
/// observation — no capture has ever shown the device displaying THIS field.
/// Changing it blind would misreport free space to a device, which is worse
/// than the present uncertainty, so it stays as-is until someone observes the
/// screen that reads it.
pub fn userQuery(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const svc = ctx.service.?;
    const caller = ctx.caller.?; // device scope
    const info = (svc.userInfo(ctx.gpa, caller.user_id) catch return serverError(ctx, req)) orelse
        return fail(ctx, req, .unauthorized, "NO_USER", "session user no longer exists");
    defer ctx.gpa.free(info.email);
    const total = svc.userCapacity(caller.user_id) catch 0;
    var cbuf: [24]u8 = undefined;
    const cap_str = std.fmt.bufPrint(&cbuf, "{d}", .{total}) catch "0";
    try json.respond(ctx.gpa, req, .ok, UserQueryVO{
        .email = info.email,
        .userName = info.email,
        .totalCapacity = cap_str,
    }, null);
}

/// POST …/2/users/get_space_usage -> the caller's storage figure, straight from
/// their `capacity` row: `used_bytes` → `used`, `total_bytes` →
/// `allocationVO.allocated`.
///
/// This is where the server-owned-quota decision becomes VISIBLE: `bindEquipment`
/// deliberately ignores the device's reported `totalCapacity`, so the number the
/// Nomad displays has to come from us. A user with no `capacity` row reads as the
/// server default (see `Files.capacity`) rather than erroring — `ensureCapacity`
/// guarantees the row on every write path, so a missing row just means "nothing
/// stored yet".
///
/// The request body (`equipmentNo`, `version`) carries nothing we need; it is
/// parsed only to drain the body, and a malformed one is not worth failing the
/// device's storage display over.
pub fn getSpaceUsage(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const caller = ctx.caller.?; // device scope
    const files = ctx.files orelse return serverError(ctx, req);

    if (json.readBody(SpaceUsageReq, ctx.gpa, req)) |parsed| parsed.deinit() else |_| {}

    const cap = files.capacity(caller.user_id) catch return serverError(ctx, req);
    try json.respond(ctx.gpa, req, .ok, SpaceUsageVO{
        .used = cap.used,
        .allocationVO = .{ .allocated = cap.total },
    }, null);
}

/// `bind/status`: does this account hold ANY active device binding? The official
/// app calls it right after login to confirm the account is paired. `null` optional
/// fields serialize omitted (house style), matching the documented shape.
const BindStatusVO = struct { success: bool = true, errorCode: ?[]const u8 = null, errorMsg: ?[]const u8 = null, bindStatus: bool };

/// POST /api/equipment/bind/status -> whether the caller's account has any active
/// device binding. No body — the account is identified by the token. After the
/// lazy auto-bind (see `resolveEquipment`) a synced app self-binds on its first
/// file call, so this reads `true` for it; a brand-new account with no device yet
/// reads `false`.
pub fn bindStatus(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const svc = ctx.service.?;
    const caller = ctx.caller.?; // device scope
    const n = svc.deviceCount(caller.user_id) catch return serverError(ctx, req);
    try json.respond(ctx.gpa, req, .ok, BindStatusVO{ .bindStatus = n > 0 }, null);
}

/// `capacity/query`: the same used/total the device's storage screen reads, in the
/// app's own envelope (bytes). No body; identified by the token.
const CapacityQueryVO = struct { success: bool = true, usedCapacity: i64, totalCapacity: i64 };

/// POST /api/file/capacity/query -> the caller's used/allotted bytes. Same numbers
/// `get_space_usage` computes, a different envelope the app expects.
pub fn capacityQuery(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const caller = ctx.caller.?; // device scope
    const files = ctx.files orelse return serverError(ctx, req);
    const cap = files.capacity(caller.user_id) catch return serverError(ctx, req);
    try json.respond(ctx.gpa, req, .ok, CapacityQueryVO{
        .usedCapacity = cap.used,
        .totalCapacity = cap.total,
    }, null);
}

/// POST …/synchronous/start -> open a sync session. `synType:true` = normal
/// incremental sync (the device diffs against our hash summary).
pub fn syncStart(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const caller = ctx.caller.?; // device scope
    var parsed = json.readBody(SyncStartReq, ctx.gpa, req) catch return badRequest(ctx, req);
    defer parsed.deinit();
    const eno = resolveEquipment(ctx, parsed.value.equipmentNo, &caller);
    try json.respond(ctx.gpa, req, .ok, SyncStartVO{ .equipmentNo = eno, .synType = true }, null);
}

/// POST …/synchronous/end -> close the sync session (its `flag` is the device's
/// success indicator; we just acknowledge).
pub fn syncEnd(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const caller = ctx.caller.?; // device scope
    var parsed = json.readBody(SyncEndReq, ctx.gpa, req) catch return badRequest(ctx, req);
    defer parsed.deinit();
    const eno = resolveEquipment(ctx, parsed.value.equipmentNo, &caller);
    try json.respond(ctx.gpa, req, .ok, SyncEndVO{ .equipmentNo = eno }, null);
}

/// POST …/query/summary/hash -> the md5 diff source: one entry per live file.
pub fn summaryHash(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const caller = ctx.caller.?; // device scope
    var parsed = json.readBody(PageReq, ctx.gpa, req) catch return badRequest(ctx, req);
    defer parsed.deinit();
    const files = ctx.files orelse return serverError(ctx, req);

    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    var syncsvc = sync.SyncService.init(files);
    const vo = syncsvc.summaryHash(arena.allocator(), caller.user_id, parsed.value.page orelse 0, parsed.value.size orelse 0) catch
        return serverError(ctx, req);
    try json.respond(ctx.gpa, req, .ok, vo, null);
}

/// POST …/query/summary/id -> full detail for the requested (diffed) ids.
pub fn summaryById(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const caller = ctx.caller.?; // device scope
    var parsed = json.readBody(SummaryByIdReq, ctx.gpa, req) catch return badRequest(ctx, req);
    defer parsed.deinit();
    const files = ctx.files orelse return serverError(ctx, req);

    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    var syncsvc = sync.SyncService.init(files);
    const ids = parsed.value.ids orelse &[_]i64{};
    const vo = syncsvc.summaryById(arena.allocator(), caller.user_id, ids) catch return serverError(ctx, req);
    try json.respond(ctx.gpa, req, .ok, vo, null);
}

/// POST …/query/summary/group -> the folders (note libraries) as summary groups.
pub fn summaryGroup(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const caller = ctx.caller.?; // device scope
    var parsed = json.readBody(PageReq, ctx.gpa, req) catch return badRequest(ctx, req);
    defer parsed.deinit();
    const files = ctx.files orelse return serverError(ctx, req);

    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    var syncsvc = sync.SyncService.init(files);
    const vo = syncsvc.summaryGroup(arena.allocator(), caller.user_id, parsed.value.page orelse 0, parsed.value.size orelse 0) catch
        return serverError(ctx, req);
    try json.respond(ctx.gpa, req, .ok, vo, null);
}

// ---- device file enumeration + raw download (Face-1) ----

/// Maps a `TreeNode` to an `EntriesVO`. `n`'s slices are arena-owned (from
/// `walkTree`/`nodeById`) and reused directly; only `id` is freshly formatted.
fn entriesVO(arena: std.mem.Allocator, n: filesmod.TreeNode) !EntriesVO {
    return .{
        .tag = if (n.is_folder) "folder" else "file",
        .id = try std.fmt.allocPrint(arena, "{d}", .{n.id}),
        .name = n.name,
        .path_display = n.path_display,
        .content_hash = n.md5,
        .is_downloadable = !n.is_folder, // FLAGGED assumption (see EntriesVO)
        .size = @intCast(n.size),
        .lastUpdateTime = n.updated_at * 1000, // ms — FLAGGED assumption (see EntriesVO)
        .parent_path = n.parent_path,
    };
}

/// Normalizes a requested folder path to Dropbox form: leading slash, no
/// trailing slash; empty / "/" → "/" (the root). Owned by `arena`.
fn folderPath(arena: std.mem.Allocator, raw: []const u8) ![]const u8 {
    const t = std.mem.trimEnd(u8, std.mem.trim(u8, raw, " "), "/");
    if (t.len == 0) return "/";
    if (t[0] != '/') return std.fmt.allocPrint(arena, "/{s}", .{t});
    return arena.dupe(u8, t);
}

fn parseId(s: ?[]const u8) ?u64 {
    const v = s orelse return null;
    return std.fmt.parseInt(u64, v, 10) catch null;
}

/// Splits a Dropbox-format FULL file path into its parent-folder path and its
/// final component: `/NOTE/Note/x.note` → parent `/NOTE/Note`, name `x.note`; a
/// top-level `/x.note` → parent `/` (the root), name `x.note`. A trailing slash
/// is tolerated (stripped). An empty `name` (the path was `""` or `/`) signals
/// "nothing to move". Both slices point into `path` (or the literal `/`) — no
/// allocation. The parent form (leading slash, no trailing slash) is exactly what
/// `Files.ensureFolderPath` tokenizes, the same shape upload/finish provisions.
const SplitPath = struct { parent: []const u8, name: []const u8 };
fn splitPath(path: []const u8) SplitPath {
    const t = std.mem.trimEnd(u8, path, "/");
    if (std.mem.lastIndexOfScalar(u8, t, '/')) |i| {
        return .{ .parent = if (i == 0) "/" else t[0..i], .name = t[i + 1 ..] };
    }
    return .{ .parent = "/", .name = t }; // a bare name at the root (or empty)
}

/// The `Host` request header, copied into `buf` (short-lived head strings are
/// invalidated once the body is read, so callers capture it first). "" if absent.
/// POST …/2/files/list_folder -> advertise the server's files to the device.
/// This is the **download trigger**: it must report the real Files tree so the
/// device pulls what it lacks. `path` "/" = root; `recursive` returns the whole
/// subtree, else only the folder's direct children.
pub fn listFolder(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const caller = ctx.caller.?; // device scope
    const files = ctx.files orelse return serverError(ctx, req);
    var parsed = json.readBody(ListFolderReq, ctx.gpa, req) catch return badRequest(ctx, req);
    defer parsed.deinit();

    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    const a = arena.allocator();

    const eno = try a.dupe(u8, resolveEquipment(ctx, parsed.value.equipmentNo, &caller));
    const recursive = parsed.value.recursive orelse false;
    const target = try folderPath(a, parsed.value.path orelse "/");
    const is_root = std.mem.eql(u8, target, "/");

    // Scope the query to the requested folder instead of walking the WHOLE tree and
    // filtering in Zig (O(folder), not O(library)). `.manual_db_lock` route: the DB
    // is touched ONLY inside this block — the lock is released before the VO build +
    // `json.respond`, so a large listing is serialized unlocked. Same shape as
    // `controlplaneCover`/`streamNoteCover`.
    const nodes: []filesmod.TreeNode = blk: {
        ctx.lockDb();
        defer ctx.unlockDb();
        if (is_root) {
            // Root: recursive → the whole tree (which it genuinely is); else the
            // root's direct children (`parent_id IS NULL`).
            break :blk (if (recursive)
                files.walkTree(a, caller.user_id)
            else
                files.walkChildren(a, caller.user_id, null, target)) catch return serverError(ctx, req);
        }
        // A named folder must resolve; an unknown path lists nothing — matching the
        // old walk-and-filter, whose in-memory filter then matched no node.
        const fid = (files.resolvePath(caller.user_id, target) catch return serverError(ctx, req)) orelse
            break :blk &[_]filesmod.TreeNode{};
        break :blk (if (recursive)
            files.walkSubtree(a, caller.user_id, fid, target)
        else
            files.walkChildren(a, caller.user_id, fid, target)) catch return serverError(ctx, req);
    };

    var entries: std.ArrayList(EntriesVO) = .empty;
    for (nodes) |n| try entries.append(a, try entriesVO(a, n));
    try json.respond(ctx.gpa, req, .ok, ListFolderVO{ .equipmentNo = eno, .entries = entries.items }, null);
}

/// POST …/3/files/query/by/path_v3 -> resolve a path to a live entry. Found →
/// `entriesVO` populated; not found → the field is OMITTED.
pub fn queryByPathV3(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const caller = ctx.caller.?; // device scope
    const files = ctx.files orelse return serverError(ctx, req);
    var parsed = json.readBody(QueryByPathReq, ctx.gpa, req) catch return badRequest(ctx, req);
    defer parsed.deinit();

    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const eno = try a.dupe(u8, caller.equipmentNo() orelse "");

    const id = (files.resolvePath(caller.user_id, parsed.value.path orelse "") catch return serverError(ctx, req)) orelse
        return json.respond(ctx.gpa, req, .ok, EntriesQueryVO{ .equipmentNo = eno }, null);
    const node = (files.nodeById(a, caller.user_id, id) catch return serverError(ctx, req)) orelse
        return json.respond(ctx.gpa, req, .ok, EntriesQueryVO{ .equipmentNo = eno }, null);
    try json.respond(ctx.gpa, req, .ok, EntriesQueryVO{ .equipmentNo = eno, .entriesVO = try entriesVO(a, node) }, null);
}

/// POST …/3/files/query_v3 -> the same VO, looked up by id. Unknown id → the
/// `entriesVO` field is OMITTED.
pub fn queryV3(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const caller = ctx.caller.?; // device scope
    const files = ctx.files orelse return serverError(ctx, req);
    var parsed = json.readBody(QueryByIdReq, ctx.gpa, req) catch return badRequest(ctx, req);
    defer parsed.deinit();

    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const eno = try a.dupe(u8, caller.equipmentNo() orelse "");

    const id = parseId(parsed.value.id) orelse
        return json.respond(ctx.gpa, req, .ok, EntriesQueryVO{ .equipmentNo = eno }, null);
    const node = (files.nodeById(a, caller.user_id, id) catch return serverError(ctx, req)) orelse
        return json.respond(ctx.gpa, req, .ok, EntriesQueryVO{ .equipmentNo = eno }, null);
    try json.respond(ctx.gpa, req, .ok, EntriesQueryVO{ .equipmentNo = eno, .entriesVO = try entriesVO(a, node) }, null);
}

/// POST …/3/files/download_v3 -> hand the device a download URL for an id. The
/// `url` points back at our `/oss/get/:id` (as it does for `/oss/put`), built
/// from the `Host` header so it names whatever address the device dialed, with
/// the scheme matching our own listener (`https` under `tls.enabled`, else
/// `http`) so a TLS deployment never hands out a plaintext URL to a TLS port.
///
/// The device sends NO `x-access-token` on the download GET, so we URL-auth it:
/// we mint a short-TTL, file-scoped capability token and append it as `?t=…`.
/// Deliberately simple for a single-household LAN — to be replaced by proper
/// signed URLs / HTTPS later (see http/download_tokens.zig).
pub fn downloadV3(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const caller = ctx.caller.?; // device scope
    const files = ctx.files orelse return serverError(ctx, req);

    // Capture Host BEFORE reading the body — reading it invalidates head strings.
    var host_buf: [256]u8 = undefined;
    const host = router.headerCopy(req, "host", &host_buf);

    var parsed = json.readBody(DownloadReq, ctx.gpa, req) catch return badRequest(ctx, req);
    defer parsed.deinit();

    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const eno = try a.dupe(u8, caller.equipmentNo() orelse "");

    const id = parseId(parsed.value.id) orelse return fail(ctx, req, .ok, "NOT_FOUND", "no such file");
    const node = (files.nodeById(a, caller.user_id, id) catch return serverError(ctx, req)) orelse
        return fail(ctx, req, .ok, "NOT_FOUND", "no such file");

    const id_str = try std.fmt.allocPrint(a, "{d}", .{node.id});

    // Mint the URL capability token for (file, caller) and embed it in the URL.
    const tokens = ctx.download_tokens orelse return serverError(ctx, req);
    const now_ms = std.Io.Clock.real.now(ctx.io).toMilliseconds();
    const tok = tokens.mint(ctx.io, node.id, caller.user_id, now_ms) catch return serverError(ctx, req);
    const scheme = if (ctx.config.tls.enabled) "https" else "http";
    const url = try std.fmt.allocPrint(a, "{s}://{s}/oss/get/{s}?t={s}", .{ scheme, host, id_str, &tok });
    try json.respond(ctx.gpa, req, .ok, DownloadVO{
        .equipmentNo = eno,
        .id = id_str,
        .url = url,
        .name = node.name,
        .path_display = node.path_display,
        .content_hash = node.md5,
        .size = @intCast(node.size),
        .is_downloadable = !node.is_folder,
    }, null);
}

/// POST …/3/files/delete_folder_v3 -> move an entry to the recycle bin.
///
/// Despite the name this is the device's ONLY delete, for files as much as
/// folders. The device has already walked the subtree: it sends **one request per
/// entity, children first and the parent last**, and it retries. So this handler
/// tombstones exactly the row it is given (`Files.trash` is idempotent, tolerates
/// a folder whose children are already gone, and preserves the original
/// `deleted_at` so a retry does not restart the retention clock) — it does no
/// walking of its own.
///
/// Soft delete, never hard: the blob reference is held, the row is restorable and
/// the bytes stay readable. Quota is deliberately NOT refunded — the bytes still
/// occupy disk until `purge` (see the recycle-bin notes in services/files.zig).
///
/// OWNERSHIP vs IDEMPOTENCY. The lookup is `getAnyState`, not `get`: `get`
/// hardcodes `deleted = 0`, so on the retry — where the row is already trashed —
/// it would report "not found" and the delete would never settle. `getAnyState`
/// is still user-scoped, so a foreign id reads as null just as it does through
/// every other read path.
///
/// JUDGEMENT CALL — an unknown or foreign id answers **success**, with `metadata`
/// omitted. We have never captured how the firmware reacts to a failure here, and
/// the two candidate behaviours are not symmetric in cost: an idempotent success
/// states the truth the device cares about (the thing it wants gone is gone) and
/// settles, whereas a failure risks it retrying forever against a state it can
/// never reach — and this very endpoint 404ing is what made the device
/// re-download the notes it had just deleted. It also keeps a foreign id and a
/// missing id INDISTINGUISHABLE, so the endpoint cannot be used as an existence
/// oracle over another user's id space.
pub fn deleteFolderV3(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const caller = ctx.caller.?; // device scope
    const files = ctx.files orelse return serverError(ctx, req);
    var parsed = json.readBody(DeleteFolderReq, ctx.gpa, req) catch return badRequest(ctx, req);
    defer parsed.deinit();

    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const eno = try a.dupe(u8, resolveEquipment(ctx, parsed.value.equipmentNo, &caller));

    const id = parseId(parsed.value.id) orelse
        return json.respond(ctx.gpa, req, .ok, DeleteFolderVO{ .equipmentNo = eno }, null);

    // One state-blind, user-scoped lookup serves both the ownership check and the
    // name/tag we have to report — read BEFORE trashing so the name is the one the
    // user deleted, and so a retry still reports it.
    const entry = (files.getAnyState(caller.user_id, id) catch return serverError(ctx, req)) orelse
        return json.respond(ctx.gpa, req, .ok, DeleteFolderVO{ .equipmentNo = eno }, null);
    defer ctx.gpa.free(entry.name);
    defer if (entry.md5) |m| ctx.gpa.free(m);

    const name = try a.dupe(u8, entry.name);
    files.trash(caller.user_id, id) catch return serverError(ctx, req);

    try json.respond(ctx.gpa, req, .ok, DeleteFolderVO{
        .equipmentNo = eno,
        .metadata = .{
            .tag = if (entry.is_folder) "folder" else "file",
            .id = try std.fmt.allocPrint(a, "{d}", .{id}),
            .name = name,
        },
    }, null);
}

/// POST …/2/files/create_folder_v2 -> create a folder the device just made.
///
/// Until this existed a folder created on the Nomad never reached the server: it
/// surfaced only when a file was uploaded into it, because `upload/apply`
/// provisions the destination path as a side effect. An empty folder simply did
/// not sync.
///
/// The work is `Files.createFolderPath` — ancestors provisioned, `autorename`
/// applied to the leaf; see there for the rule. The device sends
/// `autorename: false`, which is the idempotent case: an existing folder of that
/// name comes back unchanged.
///
/// JUDGEMENT CALL, the same one `delete_folder_v3` makes and for the same
/// reason. A missing/blank `path` answers **success** with `metadata` omitted
/// rather than 400: we have never captured how the firmware reacts to a failure
/// here, and the two candidate behaviours are not symmetric in cost — a device
/// that treats a failure as retryable retries forever, and this endpoint being
/// absent is already known to have left the tree silently wrong. A real
/// conflict (a FILE occupying the path) is the one case that answers with
/// `metadata` omitted for an actual reason, because there is no folder to name.
///
/// Ownership needs no check of its own: every lookup inside `createFolderPath`
/// is scoped to `caller.user_id`, so another user's identical path is a
/// different tree, not a conflict.
pub fn createFolderV2(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const caller = ctx.caller.?; // device scope
    const files = ctx.files orelse return serverError(ctx, req);
    var parsed = json.readBody(CreateFolderReq, ctx.gpa, req) catch return badRequest(ctx, req);
    defer parsed.deinit();

    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const eno = try a.dupe(u8, resolveEquipment(ctx, parsed.value.equipmentNo, &caller));

    const path = parsed.value.path orelse
        return json.respond(ctx.gpa, req, .ok, CreateFolderVO{ .equipmentNo = eno }, null);

    const entry = files.createFolderPath(caller.user_id, path, parsed.value.autorename orelse false) catch |err| switch (err) {
        // A file sitting on the path, or a path naming nothing. Neither is
        // retryable, so report the settled shape rather than an error the device
        // would come back to.
        error.NameConflict, error.NotFound, error.NotAFolder => return json.respond(ctx.gpa, req, .ok, CreateFolderVO{ .equipmentNo = eno }, null),
        else => return serverError(ctx, req),
    };
    defer ctx.gpa.free(entry.name);
    defer if (entry.md5) |m| ctx.gpa.free(m);

    // The REAL path, not the requested one: `autorename` may have changed the
    // leaf, and the device has no other way to find out where its folder went.
    const display = files.pathOf(a, caller.user_id, entry.id) catch return serverError(ctx, req);

    try json.respond(ctx.gpa, req, .ok, CreateFolderVO{
        .equipmentNo = eno,
        .metadata = .{
            .id = try std.fmt.allocPrint(a, "{d}", .{entry.id}),
            .name = try a.dupe(u8, entry.name),
            .path_display = display,
        },
    }, null);
}

/// POST …/3/files/move_v3 -> move or rename a file/folder the device just moved.
///
/// This endpoint being ABSENT is a real incident: renaming a note on the Nomad
/// 404'd, and the firmware treats a 404 here as FATAL — it aborts the whole sync
/// (the same failure class as `delete_folder_v3`, whose 404 once made the device
/// re-download notes it had just deleted). So it must NEVER 404: an unknown /
/// foreign / already-trashed id, an unusable path, a real name conflict under
/// `autorename:false`, or a self-into-subtree move all answer `{success,
/// equipmentNo}` with `entriesVO` omitted — the settled shape delete/create use.
///
/// `to_path` is the FULL destination path INCLUDING the final filename (see
/// `MoveReq`). We split off the final component as the new name, provision the
/// destination parent folder if it does not exist yet (`ensureFolderPath`, exactly
/// as upload/finish provisions an upload's folder), and hand both to `Files.move`,
/// which reparents + renames in one transaction. A rename and a move are the same
/// operation — the parent simply differs or not.
///
/// OWNERSHIP vs IDEMPOTENCY, the same judgement `delete_folder_v3` makes: the id
/// is looked up user-scoped with `getAnyState`, so a foreign id is
/// indistinguishable from a missing one (no cross-user existence probe, no
/// cross-user move) and both settle as success — and we do NOT provision phantom
/// destination folders for an id we cannot move. The move itself is live-scoped
/// inside `Files.move`, so a trashed row (found by `getAnyState` but not live)
/// settles the same way. `entriesVO` reports the entry AFTER the move — its real,
/// authoritative `path_display` / `name`, the device's only way to learn where the
/// file landed when `autorename` changed the final component.
pub fn moveV3(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const caller = ctx.caller.?; // device scope
    const files = ctx.files orelse return serverError(ctx, req);
    var parsed = json.readBody(MoveReq, ctx.gpa, req) catch return badRequest(ctx, req);
    defer parsed.deinit();

    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const eno = try a.dupe(u8, resolveEquipment(ctx, parsed.value.equipmentNo, &caller));

    // Any unusable input settles as success (never 404): a missing id/path is
    // nothing we can act on, and erroring would strand the device's sync.
    const id = parseId(parsed.value.id) orelse
        return json.respond(ctx.gpa, req, .ok, MoveVO{ .equipmentNo = eno }, null);
    const to_path = parsed.value.to_path orelse
        return json.respond(ctx.gpa, req, .ok, MoveVO{ .equipmentNo = eno }, null);
    const split = splitPath(to_path);
    if (split.name.len == 0)
        return json.respond(ctx.gpa, req, .ok, MoveVO{ .equipmentNo = eno }, null);

    // OWNERSHIP GATE. A foreign / unknown id reads as null here (user-scoped),
    // exactly as through every other read path, and settles as success — so the
    // endpoint is no existence oracle over another account, and we do NOT
    // provision phantom destination folders for an id we cannot move.
    const gate = (files.getAnyState(caller.user_id, id) catch return serverError(ctx, req)) orelse
        return json.respond(ctx.gpa, req, .ok, MoveVO{ .equipmentNo = eno }, null);
    ctx.gpa.free(gate.name);
    if (gate.md5) |m| ctx.gpa.free(m);

    // Provision the destination PARENT folder (creating missing ancestors), just
    // as upload/finish provisions an upload's folder. Root when the path is
    // top-level. A FILE sitting on the parent path is a NameConflict — not a folder
    // we can move into, and not retryable, so it settles as success with no entry.
    const parent: ?u64 = if (std.mem.eql(u8, split.parent, "/"))
        null
    else
        files.ensureFolderPath(caller.user_id, split.parent) catch |e| switch (e) {
            error.NameConflict => return json.respond(ctx.gpa, req, .ok, MoveVO{ .equipmentNo = eno }, null),
            else => return serverError(ctx, req),
        };

    const moved = files.move(caller.user_id, id, parent, split.name, parsed.value.autorename orelse false) catch |e| switch (e) {
        // Every one of these is a settled, non-retryable outcome, and a 404 here
        // aborts the device's sync — so answer success with entriesVO omitted:
        //   NotFound     — the row was trashed / gone by the time we moved it
        //   NameConflict — a different live sibling holds the name and autorename
        //                  was false, so we did NOT clobber it (never lossy)
        //   InvalidMove  — a folder into its own subtree; refused to avoid orphaning
        //   NotAFolder   — the destination parent resolved to a file
        error.NotFound, error.NameConflict, error.InvalidMove, error.NotAFolder => return json.respond(ctx.gpa, req, .ok, MoveVO{ .equipmentNo = eno }, null),
        else => return serverError(ctx, req),
    };
    ctx.gpa.free(moved.name);
    if (moved.md5) |m| ctx.gpa.free(m);

    // Report the entry AFTER the move — its authoritative path_display / name.
    const node = (files.nodeById(a, caller.user_id, moved.id) catch return serverError(ctx, req)) orelse
        return json.respond(ctx.gpa, req, .ok, MoveVO{ .equipmentNo = eno }, null);
    try json.respond(ctx.gpa, req, .ok, MoveVO{ .equipmentNo = eno, .entriesVO = try entriesVO(a, node) }, null);
}

/// POST …/3/files/copy_v3 — the device's copy, the twin of `move_v3`. Its live
/// use is CONFLICT RESOLUTION: when the device's local copy and the cloud copy of
/// a note have diverged, the firmware copies the local one aside to a
/// `…_CONFLICT_<ts>.note` name (autorename off, it computed the name), then syncs
/// both. Its ABSENCE 404'd exactly there and aborted the whole sync — so, like
/// `move_v3`, this NEVER 404s: every unusable input and settled outcome resolves
/// to `{success, equipmentNo}` with `entriesVO` omitted.
///
/// The copy shares the source's blob (content-addressed; see `Files.copy`) — the
/// duplicate costs no extra bytes and no re-indexing. Request/response reuse the
/// `move_v3` shapes (identical fields).
pub fn copyV3(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const caller = ctx.caller.?; // device scope
    const files = ctx.files orelse return serverError(ctx, req);
    var parsed = json.readBody(MoveReq, ctx.gpa, req) catch return badRequest(ctx, req);
    defer parsed.deinit();

    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const eno = try a.dupe(u8, resolveEquipment(ctx, parsed.value.equipmentNo, &caller));

    // Any unusable input settles as success (never 404) — see `moveV3`.
    const id = parseId(parsed.value.id) orelse
        return json.respond(ctx.gpa, req, .ok, MoveVO{ .equipmentNo = eno }, null);
    const to_path = parsed.value.to_path orelse
        return json.respond(ctx.gpa, req, .ok, MoveVO{ .equipmentNo = eno }, null);
    const split = splitPath(to_path);
    if (split.name.len == 0)
        return json.respond(ctx.gpa, req, .ok, MoveVO{ .equipmentNo = eno }, null);

    // OWNERSHIP GATE — identical to `moveV3`: a foreign / unknown / trashed id
    // reads as null (user-scoped) and settles as success, so the endpoint is no
    // existence oracle and provisions no phantom destination for an id we can't copy.
    const gate = (files.getAnyState(caller.user_id, id) catch return serverError(ctx, req)) orelse
        return json.respond(ctx.gpa, req, .ok, MoveVO{ .equipmentNo = eno }, null);
    ctx.gpa.free(gate.name);
    if (gate.md5) |m| ctx.gpa.free(m);

    // Provision the destination PARENT folder (creating missing ancestors), as
    // `moveV3` and upload/finish do. Root when top-level; a FILE on the parent
    // path is a NameConflict — not a folder we can copy into — so settle as success.
    const parent: ?u64 = if (std.mem.eql(u8, split.parent, "/"))
        null
    else
        files.ensureFolderPath(caller.user_id, split.parent) catch |e| switch (e) {
            error.NameConflict => return json.respond(ctx.gpa, req, .ok, MoveVO{ .equipmentNo = eno }, null),
            else => return serverError(ctx, req),
        };

    const copied = files.copy(caller.user_id, id, parent, split.name, parsed.value.autorename orelse false) catch |e| switch (e) {
        // Every one is a settled, non-retryable outcome; a 404 here aborts the
        // device's sync — so answer success with entriesVO omitted:
        //   NotFound     — the row was trashed / gone by the time we copied it
        //   IsFolder     — a folder copy (deep duplication) we do not perform
        //   NameConflict — a live sibling holds the name and autorename was false,
        //                  so we did NOT clobber it (a copy is never lossy)
        //   NotAFolder   — the destination parent resolved to a file
        //   QuotaExceeded— the copy would push the user over quota
        error.NotFound, error.IsFolder, error.NameConflict, error.NotAFolder, error.QuotaExceeded => return json.respond(ctx.gpa, req, .ok, MoveVO{ .equipmentNo = eno }, null),
        else => return serverError(ctx, req),
    };
    ctx.gpa.free(copied.name);
    if (copied.md5) |m| ctx.gpa.free(m);

    // Report the NEW entry — its authoritative path_display / name (incl. any
    // server autorename choice), which is how the device learns where it landed.
    const node = (files.nodeById(a, caller.user_id, copied.id) catch return serverError(ctx, req)) orelse
        return json.respond(ctx.gpa, req, .ok, MoveVO{ .equipmentNo = eno }, null);
    try json.respond(ctx.gpa, req, .ok, MoveVO{ .equipmentNo = eno, .entriesVO = try entriesVO(a, node) }, null);
}

/// GET /oss/get/:id?t=<token> -> stream the raw blob bytes for file `id`.
///
/// URL-AUTHED (not bearer): the device sends NO `x-access-token` here (OSS
/// downloads are authorized by the URL), so this route is `.public` and the `?t=`
/// query token is the capability. We look it up (file-scoped, unexpired,
/// multi-use within its TTL) to recover the owning user; a missing / expired /
/// mismatched token → **403, never 401** (the device treats a 401 as an invalid
/// session and logs itself out — a stale download token must not do that).
///
/// DELIBERATELY SIMPLE: an in-memory bearer capability for a single-household
/// LAN. To be replaced by proper signed URLs / HTTPS later (see
/// http/download_tokens.zig).
///
/// DELIBERATE / OBSERVATIONAL: the download is served **RAW** — no multipart
/// wrapper. Uploads arrive multipart-wrapped, but we don't yet know whether
/// downloads must be too. Serving raw lets a re-capture decide: the device
/// accepts raw → done; it rejects/retries → we add the wrapper here. The bytes
/// are streamed with a known content-length and never fully buffered (files can
/// be multi-MB — respect the 50 MB RSS budget).
pub fn ossGet(ctx: *Context, req: *Request, params: Params) anyerror!void {
    const files = ctx.files orelse return serverError(ctx, req);
    const id = reply.pathId(params) orelse return reply.notFound(req);

    // Authorize via the URL capability token (403 — NOT 401 — on any failure).
    const tokens = ctx.download_tokens orelse return reply.forbidden(req);
    const t = reply.queryParam(req.head.target, "t") orelse return reply.forbidden(req);
    const now_ms = std.Io.Clock.real.now(ctx.io).toMilliseconds();
    const user_id = tokens.lookup(ctx.io, t, id, now_ms) orelse return reply.forbidden(req);

    // The ONLY DB touch in this handler — the route is `manual_db_lock`, so we
    // take `ctx.db_lock` for exactly this call and nothing more. Everything below
    // (blobs.open + the streaming loop) is filesystem + socket with zero DB
    // access, so a multi-MB download no longer blocks every other request.
    //
    // Safe to use `entry` after the unlock: `Files.rowToEntry` `gpa.dupe`s both
    // `name` and `md5` (that is why we free them below), so they are owned heap
    // copies, NOT slices into SQLite's statement memory that the next query on the
    // shared connection could invalidate.
    const got = blk: {
        ctx.lockDb();
        defer ctx.unlockDb();
        break :blk files.get(user_id, id);
    };
    const entry = (got catch return serverError(ctx, req)) orelse return reply.notFound(req);
    defer ctx.gpa.free(entry.name);
    defer if (entry.md5) |m| ctx.gpa.free(m);
    if (entry.is_folder) return reply.notFound(req);
    const md5 = entry.md5 orelse return reply.notFound(req);

    var file = files.blobs.open(md5) catch return reply.notFound(req);
    defer file.close(ctx.io);

    // Content-Disposition (the filename) is REQUIRED: without it the device
    // fetches the bytes but can't materialize the downloaded note and the sync
    // fails. Confirmed against a live device + the reference OSS download, which
    // sets attachment/filename + Accept-Ranges. The body stays raw (not multipart).
    var cd_buf: [512]u8 = undefined;
    const cd = std.fmt.bufPrint(&cd_buf, "attachment; filename=\"{s}\"", .{entry.name}) catch return serverError(ctx, req);

    var wbuf: [blobstore.chunk_len]u8 = undefined;
    var body = req.respondStreaming(&wbuf, .{
        .content_length = entry.size,
        .respond_options = .{ .extra_headers = &.{
            .{ .name = "content-type", .value = "application/octet-stream" },
            .{ .name = "content-disposition", .value = cd },
            .{ .name = "accept-ranges", .value = "bytes" },
        } },
    }) catch return;

    // Pump EXACTLY `entry.size` (the Content-Length the device is reading against),
    // not "whatever the file holds": a torn blob shorter than `entry.size` would
    // leave the body short, and `streamExact64` turns that into an error instead of
    // a silent shortfall. A mid-stream failure (torn blob, or the device dropping
    // the connection) returns, closing the connection short of `content_length` —
    // the truncation signal — rather than falling through to `body.end()`, which
    // asserts the full length was written and would panic ("reached unreachable
    // code") in a safe build. `end()` runs only when every byte reached the device.
    var rbuf: [blobstore.chunk_len]u8 = undefined;
    var fr = file.reader(ctx.io, &rbuf);
    fr.interface.streamExact64(&body.writer, entry.size) catch return error.StreamTruncated;
    body.end() catch {};
}

// ---- device upload byte-path (M2): apply → /oss/put → finish ----

/// The `Content-Type` request header, copied into `buf` (captured before the body
/// read invalidates head strings). "" if absent.
/// The destination FOLDER for an upload: the apply `path` (a full file path, e.g.
/// `/NOTE/Note/x.note`) with its trailing `file_name` stripped, normalized to
/// Dropbox form (leading slash, no trailing slash; root → "/"). Owned by `a`.
fn uploadFolder(a: std.mem.Allocator, path: []const u8, file_name: []const u8) ![]const u8 {
    var p = path;
    if (std.mem.endsWith(u8, p, file_name)) p = p[0 .. p.len - file_name.len];
    return folderPath(a, p);
}

/// POST …/3/files/upload/apply -> reserve an upload. We mint an opaque 16-hex
/// `inner_name`, pre-check quota, record a session binding the destination folder
/// + file name, and hand back an upload URL pointing at our `/oss/put`.
pub fn uploadApply(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const caller = ctx.caller.?; // device scope
    const files = ctx.files orelse return serverError(ctx, req);

    // Capture Host BEFORE reading the body — reading it invalidates head strings.
    var host_buf: [256]u8 = undefined;
    const host = router.headerCopy(req, "host", &host_buf);

    var parsed = json.readBody(UploadApplyReq, ctx.gpa, req) catch return badRequest(ctx, req);
    defer parsed.deinit();
    const in = parsed.value;
    // Reject a negative or absurd declared size BEFORE any arithmetic: a value
    // near i64max would overflow the quota math and panic the process. A real
    // upload is MB-scale, so anything above the cap is hostile/broken → QUOTA.
    if (in.size < 0 or in.size > max_declared_bytes)
        return fail(ctx, req, .ok, "QUOTA_EXCEEDED", "not enough space");
    const size: u64 = @intCast(in.size);

    // Quota pre-check before we hand out an upload URL.
    const fits = files.wouldFit(caller.user_id, size) catch return serverError(ctx, req);
    if (!fits) return fail(ctx, req, .ok, "QUOTA_EXCEEDED", "not enough space");

    // Mint an opaque upload key: 8 random bytes → 16 lowercase hex.
    var raw: [8]u8 = undefined;
    ctx.io.random(&raw);
    const inner = std.fmt.bytesToHex(raw, .lower); // [16]u8

    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    const a = arena.allocator();

    const folder = uploadFolder(a, in.path, in.fileName) catch return serverError(ctx, req);
    files.createUploadSession(caller.user_id, &inner, folder, in.fileName, size) catch return serverError(ctx, req);

    const eno = try a.dupe(u8, resolveEquipment(ctx, in.equipmentNo, &caller));
    const scheme = if (ctx.config.tls.enabled) "https" else "http";
    const url = try std.fmt.allocPrint(a, "{s}://{s}/oss/put/{s}", .{ scheme, host, &inner });
    try json.respond(ctx.gpa, req, .ok, UploadApplyVO{
        .equipmentNo = eno,
        .innerName = &inner,
        .fullUploadUrl = url,
        .partUploadUrl = url,
    }, null);
}

/// True if `s` is safe to use as the `uploadId` path component of a multipart
/// chunk's temp file: non-empty, within `max_upload_id`, and made only of
/// `[A-Za-z0-9_-]`. The allowlist is what keeps a caller string from carrying a
/// `/` or `..` that would escape the `tmp/` staging directory.
fn validUploadId(s: []const u8) bool {
    if (s.len == 0 or s.len > blobstore.max_upload_id) return false;
    for (s) |c| {
        const ok = std.ascii.isAlphanumeric(c) or c == '-' or c == '_';
        if (!ok) return false;
    }
    return true;
}

/// Refuses an `/oss/put` body that ran past its cap, and tears the reservation
/// down with it.
///
/// **The wire shape is the protocol's, not ours.** The device sync protocol is
/// frozen: its failures are HTTP **200** carrying the coded envelope
/// (`{success:false, errorCode, errorMsg}`), which is exactly what the two
/// sibling steps of this same upload — `upload/apply` and `upload/finish` —
/// answer with when there is no room (`QUOTA_EXCEEDED` / "not enough space").
/// This is the same refusal arriving earlier, so it says the same thing. A 413
/// here would be a status the device never sees on this flow, and a transport-
/// level error mid-sync reads to it as a network failure, not as a decision.
///
/// **The reservation goes too.** `deleteUploadSession` removes the row this
/// `innerName` names, so the refusal leaves no `upload_sessions` row (and, with
/// the caller's `abort`, no blob) behind. `sweepUploadSessions` at startup would
/// eventually reclaim it, but "eventually" is not cleanup on a path we control:
/// a later `upload/finish` for this id now answers `NOT_FOUND` rather than
/// finding a reservation whose bytes were thrown away.
fn refuseOversize(ctx: *Context, req: *Request, files: *filesmod.Files, inner: []const u8) anyerror!void {
    {
        ctx.lockDb();
        defer ctx.unlockDb();
        files.deleteUploadSession(inner) catch {};
    }
    return fail(ctx, req, .ok, "QUOTA_EXCEEDED", "not enough space");
}

/// Adds the bytes a just-staged part contributed to its session's running total,
/// and re-checks that total against the session's whole budget. Returns true when
/// it has already answered the request (a refusal or a 500) and the caller must
/// return immediately.
///
/// **Two checks, not one, and they catch different things.** The `Capped` sink
/// bounds what reaches the FILESYSTEM, using the budget read before the stream
/// started — that is the important one and it is the reason nothing oversized
/// ever lands. This one bounds the ACCOUNTING, using the value the database
/// actually holds now. They differ only when two parts of one session are in
/// flight at the same time: both would read the same "received" figure and both
/// would be granted the whole remaining budget. The device uploads parts
/// sequentially (see `BlobStore.mergeChunks`), so that is a hostile client, and
/// against one this turns an overshoot bounded by `max_connections` into a
/// refusal on the very next part rather than a session that quietly keeps going.
///
/// `error.NotFound` from the service means the session was deleted underneath us
/// (a concurrent refusal, or the startup sweep) — there is nothing to charge and
/// nothing to publish, so it takes the same refusal as running past the cap.
fn chargeSession(
    ctx: *Context,
    req: *Request,
    files: *filesmod.Files,
    user_id: u64,
    inner: []const u8,
    sink: anytype,
    prior_part: u64,
    declared: u64,
) anyerror!bool {
    const delta = @as(i64, @intCast(sink.written)) - @as(i64, @intCast(prior_part));
    const total: ?u64 = blk: {
        ctx.lockDb();
        defer ctx.unlockDb();
        break :blk files.addUploadReceived(user_id, inner, delta) catch |e| switch (e) {
            error.NotFound => null,
            else => {
                try serverError(ctx, req);
                return true;
            },
        };
    };
    const t = total orelse {
        try refuseOversize(ctx, req, files, inner);
        return true;
    };
    if (t > upload_cap.limitFor(declared)) {
        try refuseOversize(ctx, req, files, inner);
        return true;
    }
    return false;
}

/// POST /oss/put/:innerName -> receive the file bytes. The body is
/// `multipart/form-data` with one `name="file"` part; we stream that part's raw
/// bytes into the blob store WITHOUT buffering the whole file (respecting the
/// 50 MB budget) and record the computed md5 on the session. The device sends its
/// `x-access-token` here, so this is `.device`-scoped. The exact success response
/// the device accepts (from the capture) is an empty `200`.
///
/// The body is CAPPED as it arrives, at the session's `declared_size` plus
/// `upload_cap.slack_bytes` — see `refuseOversize` for what a caller that runs
/// past it gets back, and `upload_cap` for why the cap has to be here rather than
/// at the `upload/finish` quota check.
pub fn ossPut(ctx: *Context, req: *Request, params: Params) anyerror!void {
    const caller = ctx.caller.?; // device scope
    const files = ctx.files orelse return serverError(ctx, req);

    // Copy the route param out of the head — the body read invalidates head strings.
    const inner_raw = params.get("innerName") orelse return reply.notFound(req);
    var inner_buf: [64]u8 = undefined;
    if (inner_raw.len == 0 or inner_raw.len > inner_buf.len) return reply.notFound(req);
    @memcpy(inner_buf[0..inner_raw.len], inner_raw);
    const inner = inner_buf[0..inner_raw.len];

    // Parse the multipart boundary from Content-Type BEFORE reading the body.
    var ct_buf: [256]u8 = undefined;
    const ct = router.headerCopy(req, "content-type", &ct_buf);
    var bnd_buf: [multipart.max_term]u8 = undefined;
    const boundary = multipart.boundaryFromContentType(ct, &bnd_buf) orelse return badRequest(ctx, req);

    // Multipart chunk parameters (the device splits a large file into parts).
    // Extract them BEFORE reading the body — reading invalidates the head strings
    // the target slices point into.
    const total_chunks = if (reply.queryParam(req.head.target, "totalChunks")) |s|
        std.fmt.parseInt(u32, s, 10) catch 0
    else
        0;
    const part_number = if (reply.queryParam(req.head.target, "partNumber")) |s|
        std.fmt.parseInt(u32, s, 10) catch 0
    else
        0;

    // `uploadId` names a temp file on disk, so it must be a safe path component:
    // non-empty, bounded, and drawn from a strict allowlist — never a caller
    // string that could contain `/` or `..` and escape the `tmp/` staging dir.
    var uid_buf: [blobstore.max_upload_id]u8 = undefined;
    const upload_id: ?[]const u8 = if (reply.queryParam(req.head.target, "uploadId")) |raw| uid: {
        if (!validUploadId(raw)) return badRequest(ctx, req);
        @memcpy(uid_buf[0..raw.len], raw);
        break :uid uid_buf[0..raw.len];
    } else null;

    // A declared multipart upload (>1 chunk) must carry a valid id and an in-range
    // part number. Rejecting here — rather than falling through to the single-shot
    // path — stops one chunk from being stored as if it were the whole file.
    const chunked = total_chunks > 1;
    if (chunked and (upload_id == null or part_number == 0 or part_number > total_chunks))
        return badRequest(ctx, req);

    // The session must exist and belong to the calling device, and it carries the
    // `declared_size` this body is measured against plus the bytes its earlier
    // parts already staged. DB touch #1 of 3 — the route is `manual_db_lock`, so
    // we hold `ctx.db_lock` for just this lookup.
    var declared: u64 = 0;
    var received: u64 = 0;
    {
        ctx.lockDb();
        defer ctx.unlockDb();
        var arena = std.heap.ArenaAllocator.init(ctx.gpa);
        defer arena.deinit();
        const session = (files.uploadSession(arena.allocator(), caller.user_id, inner) catch return serverError(ctx, req)) orelse
            return reply.notFound(req);
        declared = session.declared_size;
        received = session.received_bytes;
    }

    // What this part already contributed, if it is a RETRY of a part already on
    // disk. A part's temp file is named deterministically, so re-POSTing it
    // replaces rather than appends — charging the session twice for it would
    // eventually refuse a device that did nothing wrong. Zero for a part that is
    // not staged, and for the single-shot path (where the whole body is the one
    // "part", so whatever the session has received is what this request replaces).
    const prior_part: u64 = if (chunked) files.blobs.stagedPartSize(upload_id.?, part_number) else received;

    // THE CAP. The device announced `declared_size` at `upload/apply`, where it was
    // checked against quota before this URL was ever handed out; the bytes now
    // arriving are held to it (plus `slack_bytes`) AS THEY ARRIVE. Without this,
    // quota applied only at `upload/finish` — after the whole body was on disk —
    // so one authenticated request could fill the disk with every quota check
    // still passing, and on a Pi a full disk takes the database with it.
    //
    // PER SESSION, not per part. This used to be `limitFor(declared)` on every
    // request, which each part of a chunked upload passed independently — so with
    // a caller-chosen `?totalChunks=`, N parts staged N × the cap before the merge
    // and the total was as unbounded as it had been before the cap existed. The
    // budget is now what is LEFT of the session's, and a retried part gets its own
    // earlier contribution back first.
    const limit = upload_cap.remainingFor(declared, received -| prior_part);

    // Stream the multipart file part straight into a new blob (incremental md5).
    // UNLOCKED: the ingest is socket → md5 → filesystem only (store/blobs.zig
    // never touches the DB), so a multi-MB upload doesn't hold the global lock.
    var rbuf: [blobstore.chunk_len]u8 = undefined;
    const reader = req.readerExpectContinue(&rbuf) catch return badRequest(ctx, req);

    var wbuf: [blobstore.chunk_len]u8 = undefined;

    if (chunked) {
        var ing = files.blobs.beginChunkIngest(upload_id.?, part_number, &wbuf) catch return serverError(ctx, req);
        var sink = upload_cap.Capped(blobstore.ChunkIngest).init(&ing, limit);
        multipart.extract(reader, boundary, &sink) catch |err| {
            // `ChunkIngest.abort` closes the fd but does NOT unlink the part (its
            // single-shot sibling `Ingest.abort` does) — what it staged is bounded
            // by the cap and reclaimed by the startup `sweepTmp`. Nothing is
            // published either way.
            ing.abort();
            if (err == error.UploadTooLarge) return refuseOversize(ctx, req, files, inner);
            return badRequest(ctx, req);
        };
        ing.finish() catch {
            ing.abort();
            return serverError(ctx, req);
        };
        ing.deinit();

        // Charge the session for what this part staged, net of whatever the same
        // part number held before (a retry replaces its file). DB touch #2.
        if (try chargeSession(ctx, req, files, caller.user_id, inner, &sink, prior_part, declared)) return;

        if (part_number == total_chunks) {
            // Implicitly merge chunks on the final part
            const res = files.blobs.mergeChunks(upload_id.?, total_chunks, &wbuf) catch return serverError(ctx, req);
            {
                ctx.lockDb();
                defer ctx.unlockDb();
                files.setUploadBlob(caller.user_id, inner, &res.md5) catch return serverError(ctx, req);
            }
        }
    } else {
        var ing = files.blobs.beginIngest(&wbuf) catch return serverError(ctx, req);
        var sink = upload_cap.Capped(blobstore.Ingest).init(&ing, limit);
        multipart.extract(reader, boundary, &sink) catch |err| {
            // `abort` closes the fd AND drops the temp file, so an over-cap body
            // leaves nothing behind: the partial blob is gone here, and the
            // session row goes in `refuseOversize`. Neither is left for the sweep.
            ing.abort();
            if (err == error.UploadTooLarge) return refuseOversize(ctx, req, files, inner);
            return badRequest(ctx, req);
        };
        const res = ing.finish(null) catch {
            ing.abort();
            return serverError(ctx, req);
        };
        ing.deinit();

        // The single-shot body IS the session's one part, so it replaces whatever
        // the session had received rather than adding to it.
        if (try chargeSession(ctx, req, files, caller.user_id, inner, &sink, prior_part, declared)) return;

        // Record the stored md5 on the session; finish() verifies it against the
        // device's content_hash. (The on-disk blob has no `blobs` row yet — if finish
        // never arrives it is an orphan collectable by the session sweep.) DB touch
        // #2 of 2 — re-acquire the lock for just this write.
        {
            ctx.lockDb();
            defer ctx.unlockDb();
            files.setUploadBlob(caller.user_id, inner, &res.md5) catch return serverError(ctx, req);
        }
    }

    // The minimal success response the device accepted in the capture: empty 200.
    try req.respond("", .{ .status = .ok });
}

/// POST …/2/files/upload/finish -> commit. We look up the session by
/// `inner_name`, verify our stored blob md5 equals the device's `content_hash`
/// (reject + keep the orphan blob on mismatch), then link the blob into the tree
/// under the SESSION's bound path (not finish's echoed path), charge quota, bump
/// syncVersion, and delete the session. Returns the real created file id.
pub fn uploadFinish(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const caller = ctx.caller.?; // device scope
    const files = ctx.files orelse return serverError(ctx, req);

    var parsed = json.readBody(UploadFinishReq, ctx.gpa, req) catch return badRequest(ctx, req);
    defer parsed.deinit();
    const in = parsed.value;

    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const eno = try a.dupe(u8, resolveEquipment(ctx, in.equipmentNo, &caller));

    const session = (files.uploadSession(a, caller.user_id, in.innerName) catch return serverError(ctx, req)) orelse
        return fail(ctx, req, .ok, "NOT_FOUND", "no such upload");
    const blob_md5 = session.blob_md5 orelse return fail(ctx, req, .ok, "NO_CONTENT", "upload not received");

    // Integrity gate: the bytes we stored must be what the device intended. On a
    // mismatch we do NOT commit and leave the orphan blob for the sweep.
    if (!std.ascii.eqlIgnoreCase(blob_md5, in.content_hash))
        return fail(ctx, req, .ok, "HASH_MISMATCH", "content hash mismatch");

    // Resolve/create the destination folder from the session's authoritative path.
    const parent: ?u64 = if (std.mem.eql(u8, session.path, "/"))
        null
    else
        files.ensureFolderPath(caller.user_id, session.path) catch return serverError(ctx, req);

    // Commit the AUTHORITATIVE ingested size — the real byte count on disk — not
    // the device's apply-time `declared_size`. A device could declare 10 GiB while
    // uploading 100 bytes; trusting that would set `files.size`/quota to 10 GiB and
    // make the control-plane reader try to allocate 10 GiB (OOM) and mis-frame the
    // download. The blob is content-addressed, so its on-disk size IS the truth.
    const real_size = files.blobs.sizeOf(blob_md5) catch return serverError(ctx, req);
    const entry = files.linkBlob(caller.user_id, parent, session.file_name, blob_md5, real_size) catch |e| switch (e) {
        error.QuotaExceeded => return fail(ctx, req, .ok, "QUOTA_EXCEEDED", "not enough space"),
        error.NameConflict => return fail(ctx, req, .ok, "NAME_CONFLICT", "name already used by a folder"),
        else => return serverError(ctx, req),
    };
    ctx.gpa.free(entry.name);
    if (entry.md5) |m| ctx.gpa.free(m);

    files.deleteUploadSession(in.innerName) catch {};

    const id_str = try std.fmt.allocPrint(a, "{d}", .{entry.id});
    try json.respond(ctx.gpa, req, .ok, UploadFinishVO{
        .equipmentNo = eno,
        .id = id_str,
        .name = session.file_name,
        .path_display = in.path orelse session.path, // echo the device's folder, à la capture
        .content_hash = blob_md5,
    }, null);
}

/// POST …/schedule/group/all + …/schedule/task/all -> Planner app; stub empty.
pub fn scheduleGroupAll(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    try json.respond(ctx.gpa, req, .ok, ScheduleGroupAllVO{}, null);
}

pub fn scheduleTaskAll(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    try json.respond(ctx.gpa, req, .ok, ScheduleTaskAllVO{}, null);
}
