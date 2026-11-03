//! The central route table: every HTTP endpoint and the scopes that may call it.

const std = @import("std");
const router = @import("http/router.zig");
const auth = @import("handlers/auth.zig");
const device = @import("handlers/device.zig");
const controlplane = @import("handlers/controlplane.zig");
const admin = @import("handlers/admin.zig");

/// Smoke-test API version (distinct from the package version).
pub const api_version = auth.api_version;

/// The route table. `scopes` lists the allowed audiences (`.public` = no auth);
/// crossing faces is 403. `read_only` is a claim about the whole call path, not
/// the HTTP method, and the integration tests probe every flagged route.
/// Routes that read a note/spd/txt index stay on the writer: their read path
/// backfills `note_index`, and that write fails silently on a reader.
pub const routes = [_]router.Route{
    .{ .method = .GET, .path = "/api/version", .scopes = &.{.public}, .handler = auth.version, .read_only = true },

    // --- Auth (public: these establish a session) ---
    // Pre-auth, so rate-limited by IP against brute force.
    .{ .method = .POST, .path = "/api/official/user/query/random/code", .scopes = &.{.public}, .handler = auth.randomCode, .rate_limit = .{ .max = 20, .window_s = 60, .by = .ip } },
    .{ .method = .POST, .path = "/api/official/user/account/login/new", .scopes = &.{.public}, .handler = auth.loginNew, .rate_limit = .{ .max = 10, .window_s = 60, .by = .ip } },
    .{ .method = .POST, .path = "/api/official/user/account/login/equipment", .scopes = &.{.public}, .handler = auth.loginNew, .rate_limit = .{ .max = 10, .window_s = 60, .by = .ip } },
    // Reachable by a `pending` first-login token; verifies `currentPassword`, so it
    // is a guessing oracle. Keyed by user, not IP: a household shares one address.
    .{ .method = .PUT, .path = "/api/user/password", .scopes = &.{ .controlplane, .pending }, .handler = auth.changePassword, .rate_limit = .{ .max = 5, .window_s = 300, .by = .user } },
    .{ .method = .POST, .path = "/api/user/logout", .scopes = &.{ .controlplane, .device, .pending }, .handler = auth.logout },
    .{ .method = .GET, .path = "/api/user/me", .scopes = &.{ .controlplane, .pending }, .handler = auth.me },

    // --- Device / sync (the device face) ---
    // Pre-login device calls, IP-rate-limited (check/exists reveals USER_NOT_FOUND).
    .{ .method = .POST, .path = "/api/terminal/equipment/unlink", .scopes = &.{.public}, .handler = device.unlinkEquipmentLenient, .rate_limit = .{ .max = 20, .window_s = 60, .by = .ip } },
    .{ .method = .POST, .path = "/api/official/user/check/exists/server", .scopes = &.{.public}, .handler = device.checkExists, .rate_limit = .{ .max = 20, .window_s = 60, .by = .ip } },
    .{ .method = .GET, .path = "/api/file/query/server", .scopes = &.{.public}, .handler = device.queryServer, .read_only = true },
    // `.public` alongside `.device` only here: the Nomad sends this before storing
    // the token its login returned. The handler requires a live device session for
    // that serial and account instead.
    .{ .method = .POST, .path = "/api/terminal/user/bindEquipment", .scopes = &.{ .device, .public }, .handler = device.bindEquipment },
    .{ .method = .POST, .path = "/api/user/query", .scopes = &.{.device}, .handler = device.userQuery, .read_only = true },
    // The official Android app's post-login calls.
    .{ .method = .POST, .path = "/api/equipment/bind/status", .scopes = &.{.device}, .handler = device.bindStatus, .read_only = true },
    .{ .method = .POST, .path = "/api/file/capacity/query", .scopes = &.{.device}, .handler = device.capacityQuery, .read_only = true },
    // The device's sync-folder screen reads this ~4x per session; a 404 breaks it.
    .{ .method = .POST, .path = "/api/file/2/users/get_space_usage", .scopes = &.{.device}, .handler = device.getSpaceUsage, .read_only = true },
    .{ .method = .POST, .path = "/api/file/2/files/synchronous/start", .scopes = &.{.device}, .handler = device.syncStart },
    .{ .method = .POST, .path = "/api/file/2/files/synchronous/end", .scopes = &.{.device}, .handler = device.syncEnd },
    .{ .method = .POST, .path = "/api/file/query/summary/hash", .scopes = &.{.device}, .handler = device.summaryHash, .read_only = true },
    .{ .method = .POST, .path = "/api/file/query/summary/id", .scopes = &.{.device}, .handler = device.summaryById, .read_only = true },
    .{ .method = .POST, .path = "/api/file/query/summary/group", .scopes = &.{.device}, .handler = device.summaryGroup, .read_only = true },
    // /oss/get is `.public`: the device sends no x-access-token on the download GET;
    // it is authorized by the `?t=` token download_v3 mints, so a tokenless GET is
    // 403, never 401 (a 401 logs the device out). list_folder locks the DB only
    // around its tree query.
    .{ .method = .POST, .path = "/api/file/2/files/list_folder", .scopes = &.{.device}, .handler = device.listFolder, .manual_db_lock = true },
    .{ .method = .POST, .path = "/api/file/3/files/query/by/path_v3", .scopes = &.{.device}, .handler = device.queryByPathV3, .read_only = true },
    .{ .method = .POST, .path = "/api/file/3/files/query_v3", .scopes = &.{.device}, .handler = device.queryV3, .read_only = true },
    .{ .method = .POST, .path = "/api/file/3/files/download_v3", .scopes = &.{.device}, .handler = device.downloadV3 },
    // The device's only delete, for files as well as folders; soft-deletes into the
    // bin. Unimplemented, the device re-downloads what it just deleted.
    .{ .method = .POST, .path = "/api/file/3/files/delete_folder_v3", .scopes = &.{.device}, .handler = device.deleteFolderV3 },
    // Never 404s: a 404 aborts the device's whole sync. `to_path` includes the filename.
    .{ .method = .POST, .path = "/api/file/3/files/move_v3", .scopes = &.{.device}, .handler = device.moveV3 },
    // Used for conflict resolution (`…_CONFLICT_<ts>.note`); never 404s, shares the source blob.
    .{ .method = .POST, .path = "/api/file/3/files/copy_v3", .scopes = &.{.device}, .handler = device.copyV3 },
    // Without it an empty folder made on the Nomad never syncs.
    .{ .method = .POST, .path = "/api/file/2/files/create_folder_v2", .scopes = &.{.device}, .handler = device.createFolderV2 },
    // The /oss byte routes stream multi-MB bodies and lock the DB only around their
    // own DB calls. Set `manual_db_lock` only on a handler audited to do that.
    .{ .method = .GET, .path = "/oss/get/:id", .scopes = &.{.public}, .handler = device.ossGet, .manual_db_lock = true },
    // apply reserves an upload and returns an /oss/put URL; finish commits it. The
    // device sends x-access-token to all three.
    .{ .method = .POST, .path = "/api/file/3/files/upload/apply", .scopes = &.{.device}, .handler = device.uploadApply },
    .{ .method = .POST, .path = "/oss/put/:innerName", .scopes = &.{.device}, .handler = device.ossPut, .manual_db_lock = true },
    .{ .method = .POST, .path = "/api/file/2/files/upload/finish", .scopes = &.{.device}, .handler = device.uploadFinish },
    // Planner/calendar calls, stubbed empty.
    .{ .method = .POST, .path = "/api/file/schedule/group/all", .scopes = &.{.device}, .handler = device.scheduleGroupAll },
    .{ .method = .POST, .path = "/api/file/schedule/task/all", .scopes = &.{.device}, .handler = device.scheduleTaskAll },

    // --- Control plane / browser ---
    // `.public`: the login page reads it before anyone can sign in.
    .{ .method = .GET, .path = "/api/controlplane/server-info", .scopes = &.{.public}, .handler = controlplane.controlplaneServerInfo },
    .{ .method = .POST, .path = "/api/controlplane/equipment/unlink", .scopes = &.{.controlplane}, .handler = controlplane.controlplaneUnlink },
    .{ .method = .GET, .path = "/api/controlplane/tree", .scopes = &.{.controlplane}, .handler = controlplane.controlplaneTree },
    .{ .method = .GET, .path = "/api/controlplane/usage", .scopes = &.{.controlplane}, .handler = controlplane.controlplaneUsage, .read_only = true },

    // --- The account screen: managing yourself ---
    // Nothing here takes a target; the session is the target. Not `require_admin`.
    .{ .method = .GET, .path = "/api/controlplane/account", .scopes = &.{.controlplane}, .handler = controlplane.controlplaneAccount },
    .{ .method = .GET, .path = "/api/controlplane/account/storage", .scopes = &.{.controlplane}, .handler = controlplane.controlplaneAccountStorage, .read_only = true },
    // Unlike `/api/controlplane/equipment/unlink`, 404s for a serial not the caller's.
    .{ .method = .POST, .path = "/api/controlplane/account/devices/unlink", .scopes = &.{.controlplane}, .handler = controlplane.controlplaneUnlinkMyDevice },
    // Not `.pending`: a session owing a password change may not revoke others.
    .{ .method = .POST, .path = "/api/controlplane/account/sign-out-others", .scopes = &.{.controlplane}, .handler = controlplane.controlplaneSignOutOthers },
    // PUT: idempotent set, so a retry does not evict twice.
    .{ .method = .PUT, .path = "/api/controlplane/account/versions", .scopes = &.{.controlplane}, .handler = controlplane.controlplaneSetVersions },
    // Generic per-item metadata, fetched for every previewable kind.
    .{ .method = .GET, .path = "/api/controlplane/file/metadata/:id", .scopes = &.{.controlplane}, .handler = controlplane.controlplaneNote },
    // --- The client-side search index ---
    // Search runs in the browser; the server ships the manifest and per-document
    // term records as raw bytes (no API response is compressed). The manifest
    // heals nothing, so it can be `read_only`; it is `no-cache` + ETag.
    .{ .method = .GET, .path = "/api/controlplane/search-index/manifest", .scopes = &.{.controlplane}, .handler = controlplane.controlplaneSearchIndexManifest, .read_only = true },
    // Not `read_only`: the reader lease would be held for the whole download, and an
    // empty pool degrades to the writer under `db_lock`. The handler borrows a
    // reader around its manifest query only.
    .{ .method = .GET, .path = "/api/controlplane/search-index/stream", .scopes = &.{.controlplane}, .handler = controlplane.controlplaneSearchIndexStream, .manual_db_lock = true },
    // Content-addressed, so gated by `Files.reachesBlob` (live, trashed or retained
    // version). `manual_db_lock` for the stream route's reason.
    .{ .method = .GET, .path = "/api/controlplane/text/:md5", .scopes = &.{.controlplane}, .handler = controlplane.controlplaneDocumentText, .manual_db_lock = true },
    // --- History of a file ---
    // `:md5` must be a retained version of that file (`Files.historyVersion`),
    // otherwise 404. Restore goes through the supersede path and is undoable.
    .{ .method = .GET, .path = "/api/controlplane/note/:id/history", .scopes = &.{.controlplane}, .handler = controlplane.controlplaneHistory },
    // The version's own page geometry, from its retained `note_index`.
    .{ .method = .GET, .path = "/api/controlplane/note/:id/history/:md5/meta", .scopes = &.{.controlplane}, .handler = controlplane.controlplaneHistoryMeta },
    .{ .method = .GET, .path = "/api/controlplane/note/:id/history/:md5/page/:n", .scopes = &.{.controlplane}, .handler = controlplane.controlplaneHistoryPage, .manual_db_lock = true },
    .{ .method = .GET, .path = "/api/controlplane/note/:id/history/:md5/page/:n/text", .scopes = &.{.controlplane}, .handler = controlplane.controlplaneHistoryPageText },
    // Whole-blob bytes of a version, for viewers that fetch a whole file.
    .{ .method = .GET, .path = "/api/controlplane/note/:id/history/:md5/raw", .scopes = &.{.controlplane}, .handler = controlplane.controlplaneHistoryRaw, .manual_db_lock = true },
    .{ .method = .POST, .path = "/api/controlplane/note/:id/history/:md5/restore", .scopes = &.{.controlplane}, .handler = controlplane.controlplaneHistoryRestore },
    // Opening a note fires ~10 of these; the handler locks only its lookup and plan.
    .{ .method = .GET, .path = "/note/:id/page/:n", .scopes = &.{.controlplane}, .handler = controlplane.controlplanePage, .manual_db_lock = true },
    // A page's custom image template, content-addressed and immutable.
    .{ .method = .GET, .path = "/note/:id/template/:hash", .scopes = &.{.controlplane}, .handler = controlplane.controlplaneTemplate, .manual_db_lock = true },
    // Raw bytes for non-`.note` files; only an allowlisted type is served `inline`
    // (`svg` is excluded).
    .{ .method = .GET, .path = "/file/:id", .scopes = &.{.controlplane}, .handler = controlplane.controlplaneFile, .manual_db_lock = true },
    // Embedded thumbnail, stored at `thumbs/<source_md5>`. `manual_db_lock` also
    // because this triggers the on-demand repair, whose lock order (repair mutex,
    // then db lock) needs the handler lock released. Foreign hash is a 404.
    .{ .method = .GET, .path = "/thumbnail/:hash", .scopes = &.{.controlplane}, .handler = controlplane.controlplaneThumbnail, .manual_db_lock = true },
    // Not immutable: `?v=` versions the transcript bytes, not the JSON struct around
    // them, which changes across deploys. A struct-serialized body revalidates.
    .{ .method = .GET, .path = "/note/:id/page/:n/text", .scopes = &.{.controlplane}, .handler = controlplane.controlplanePageText },
    // A page's PDF links; same cache rule as `/text`. Per page, not per document:
    // one capture holds 51,256 records over 1702 pages.
    .{ .method = .GET, .path = "/note/:id/page/:n/links", .scopes = &.{.controlplane}, .handler = controlplane.controlplanePageLinks },
    // SSE: a held connection. Without `manual_db_lock` it would hold the global DB
    // lock for the connection's lifetime and stall device sync. Over the stream cap
    // it degrades to a one-shot frame instead of refusing.
    .{ .method = .GET, .path = "/api/controlplane/events", .scopes = &.{.controlplane}, .handler = controlplane.controlplaneEvents, .manual_db_lock = true },

    // --- Recycle bin ---
    // No CSRF token: the session cookie is `HttpOnly; SameSite=Strict`.
    .{ .method = .GET, .path = "/api/controlplane/bin", .scopes = &.{.controlplane}, .handler = controlplane.controlplaneBin },
    // Previews of trashed items go through `Files.getTrashed`, never a relaxed `Files.get`.
    .{ .method = .GET, .path = "/api/controlplane/bin/file/metadata/:id", .scopes = &.{.controlplane}, .handler = controlplane.controlplaneBinNote },
    .{ .method = .GET, .path = "/api/controlplane/bin/note/:id/page/:n", .scopes = &.{.controlplane}, .handler = controlplane.controlplaneBinPage, .manual_db_lock = true },
    .{ .method = .GET, .path = "/api/controlplane/bin/note/:id/page/:n/text", .scopes = &.{.controlplane}, .handler = controlplane.controlplaneBinPageText },
    // No `/restore` twin for trashed history: restore the file first.
    .{ .method = .GET, .path = "/api/controlplane/bin/note/:id/history", .scopes = &.{.controlplane}, .handler = controlplane.controlplaneBinHistory },
    .{ .method = .GET, .path = "/api/controlplane/bin/note/:id/history/:md5/page/:n", .scopes = &.{.controlplane}, .handler = controlplane.controlplaneBinHistoryPage, .manual_db_lock = true },
    .{ .method = .GET, .path = "/api/controlplane/bin/note/:id/history/:md5/page/:n/text", .scopes = &.{.controlplane}, .handler = controlplane.controlplaneBinHistoryPageText },
    .{ .method = .GET, .path = "/api/controlplane/bin/note/:id/history/:md5/raw", .scopes = &.{.controlplane}, .handler = controlplane.controlplaneBinHistoryRaw, .manual_db_lock = true },
    .{ .method = .GET, .path = "/api/controlplane/bin/file/:id", .scopes = &.{.controlplane}, .handler = controlplane.controlplaneBinFile, .manual_db_lock = true },
    // Restore reports what it actually did (ancestors, descendants, auto-renames).
    .{ .method = .POST, .path = "/api/controlplane/bin/:id/restore", .scopes = &.{.controlplane}, .handler = controlplane.controlplaneRestore },
    // Purge is where blob refcounts drop and quota is refunded.
    .{ .method = .DELETE, .path = "/api/controlplane/bin/:id", .scopes = &.{.controlplane}, .handler = controlplane.controlplanePurge },
    .{ .method = .DELETE, .path = "/api/controlplane/bin", .scopes = &.{.controlplane}, .handler = controlplane.controlplaneEmptyBin },
    // The browser sends one request for a folder, so the subtree walk is server-side.
    .{ .method = .DELETE, .path = "/api/controlplane/entry/:id", .scopes = &.{.controlplane}, .handler = controlplane.controlplaneTrash },

    // A move to its own parent without autorename: a clash is a 409.
    .{ .method = .POST, .path = "/api/controlplane/entry/:id/rename", .scopes = &.{.controlplane}, .handler = controlplane.controlplaneRename },

    // Browser upload into `:id` (`root` = library root); `?onConflict=rename|replace`,
    // default rename. Locks the DB only around its own DB touches.
    .{ .method = .POST, .path = "/api/controlplane/folder/:id/upload", .scopes = &.{.controlplane}, .handler = controlplane.controlplaneUpload, .manual_db_lock = true },

    // --- Admin: re-authentication ("elevation") ---
    // Neither is `require_admin` (elevate would gate itself; lock must work after a
    // lapse) nor `.pending`. elevate is a password oracle, rate-limited per account,
    // not per IP, so one housemate's typos do not lock out the rest.
    .{ .method = .POST, .path = "/api/admin/elevate", .scopes = &.{.controlplane}, .handler = admin.elevate, .rate_limit = .{ .max = 5, .window_s = 300, .by = .user } },
    .{ .method = .POST, .path = "/api/admin/lock", .scopes = &.{.controlplane}, .handler = admin.lock },

    // --- Admin: household user management (control plane, elevated admin only) ---
    // `require_admin` needs `is_admin` and a live elevation; a lapsed one is 428, not 401.
    .{ .method = .POST, .path = "/api/admin/users", .scopes = &.{.controlplane}, .require_admin = true, .handler = admin.createUser },
    .{ .method = .GET, .path = "/api/admin/users", .scopes = &.{.controlplane}, .require_admin = true, .handler = admin.listUsers },
    .{ .method = .DELETE, .path = "/api/admin/users/:id", .scopes = &.{.controlplane}, .require_admin = true, .handler = admin.deleteUser },
    .{ .method = .POST, .path = "/api/admin/users/:id/reset", .scopes = &.{.controlplane}, .require_admin = true, .handler = admin.resetPassword },

    // --- Admin: one person's devices and quota ---
    // These act on another account's resources: a serial owned by a different
    // housemate answers as an unknown one, so an admin cannot probe across accounts.
    .{ .method = .GET, .path = "/api/admin/users/:id/devices", .scopes = &.{.controlplane}, .require_admin = true, .handler = admin.listDevices },
    .{ .method = .POST, .path = "/api/admin/users/:id/devices/unlink", .scopes = &.{.controlplane}, .require_admin = true, .handler = admin.unlinkDevice },
    .{ .method = .GET, .path = "/api/admin/users/:id/quota", .scopes = &.{.controlplane}, .require_admin = true, .handler = admin.getQuota },
    // Lowering below current usage deletes nothing; it stops new syncs.
    .{ .method = .PUT, .path = "/api/admin/users/:id/quota", .scopes = &.{.controlplane}, .require_admin = true, .handler = admin.setQuota },

    // --- Admin: server-wide settings and health ---
    // Retention never purges retroactively: the new window starts at the write.
    .{ .method = .GET, .path = "/api/admin/settings/retention", .scopes = &.{.controlplane}, .require_admin = true, .handler = admin.getRetention },
    .{ .method = .PUT, .path = "/api/admin/settings/retention", .scopes = &.{.controlplane}, .require_admin = true, .handler = admin.setRetention },
    // Household-wide totals only, never per-person activity.
    .{ .method = .GET, .path = "/api/admin/health", .scopes = &.{.controlplane}, .require_admin = true, .handler = admin.health },
};

// A capture beyond `router.Params.max` would be dropped at match time.
comptime {
    @setEvalBranchQuota(100_000); // ~80 routes × per-segment scan
    for (routes) |r| {
        var captures: usize = 0;
        var it = std.mem.splitScalar(u8, r.path, '/');
        while (it.next()) |seg| {
            if (seg.len > 0 and seg[0] == ':') captures += 1;
        }
        if (captures > router.Params.max) {
            @compileError("route '" ++ r.path ++ "' declares more :captures than router.Params.max");
        }
    }
}

// `dispatchLocked` renews admin elevation only on the automatic-lock path, so a
// manual admin route would never slide its elevation window.
comptime {
    if (router.manualAdminRoute(&routes)) |i| {
        @compileError("route '" ++ routes[i].path ++ "' is both manual_db_lock and require_admin; " ++
            "dispatchLocked's manual branch never renews admin elevation (see router.manualAdminRoute)");
    }
}

// A manual handler's `ctx.lockDb()` would lock the writer while it reads a
// reader, and an admin route renews elevation with an UPDATE.
comptime {
    if (router.readOnlyConflict(&routes)) |i| {
        @compileError("route '" ++ routes[i].path ++ "' is read_only together with manual_db_lock or " ++
            "require_admin; neither combination can be made to hold (see router.readOnlyConflict)");
    }
}

test "the route table fits the db_lock histogram's fixed table" {
    // A route past `lock_stats.max_routes` would silently share the overflow slot.
    const lock_stats = @import("http/lock_stats.zig");
    try @import("std").testing.expect(routes.len <= lock_stats.max_routes);
}
