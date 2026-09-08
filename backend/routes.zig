//! The central route table — the HTTP entrypoint and the auditable auth
//! manifest. One flat table of `router.Route`, grouped by face with section
//! comments. Each route declares its `scope`, which the router enforces (401
//! unauth / 403 wrong audience). Adding an endpoint = one row here plus its
//! handler in `handlers/`. Reusable HTTP plumbing lives in `http/`; the per-face
//! handlers (parse → service → respond) live in `handlers/`.

const std = @import("std");
const router = @import("http/router.zig");
const auth = @import("handlers/auth.zig");
const device = @import("handlers/device.zig");
const controlplane = @import("handlers/controlplane.zig");
const admin = @import("handlers/admin.zig");

/// Smoke-test API version (distinct from the package version).
pub const api_version = auth.api_version;

/// The route table. `scopes` lists who may call each route (`&.{.public}` = no
/// auth; `&.{.controlplane}` etc. = allowed audiences). Crossing faces → 403;
/// `rate_limit` → 429. Every route declares its scopes.
///
/// ## `read_only` — what it claims, and what it is not
///
/// A `read_only` route runs on a pooled `SQLITE_OPEN_READONLY` connection with
/// no `db_lock` held, so a slow read stops being a barrier the whole household
/// queues behind (see db/reader_pool.zig). The flag is a CLAIM ABOUT THE WHOLE
/// CALL PATH, not about the HTTP method — the device face POSTs pure reads, and
/// `download_v3` looks like a write while minting its token in memory.
///
/// **The claim is checked, not reviewed.** `test/http_integration.zig` drives
/// every flagged route twice: once against a real read-only connection (a write
/// fails loudly there) and once against the writer with a row-mutation hook armed
/// (which catches a write that a `catch {}` would otherwise swallow). A flagged
/// route with no probe fails the same test, so the audit grows with the table.
///
/// **The category that is NOT flagged, and why.** Every control-plane route that
/// reads a `.note`/`.spd`/`.txt` INDEX — listings, `file/metadata`, page text,
/// page links, the bin, history metadata — is a SELF-HEALING read: a missing or
/// stale `note_index` row is backfilled on the read path
/// (`ControlPlaneService.indexRowEnsuring` → `noteindex.ensureIndexed`), and that
/// backfill is a write. Its failure is swallowed by design, so on a reader it
/// would not error — it would quietly serve a note as an unindexed placeholder.
/// A silent wrong answer is worse than a slow one, so the whole family keeps the
/// writer until the heal has somewhere else to happen. Search is exempt because
/// it reads the FTS directly and never heals (`search_partition.active` is
/// explicitly the read-only half of that module).
pub const routes = [_]router.Route{
    .{ .method = .GET, .path = "/api/version", .scopes = &.{.public}, .handler = auth.version, .read_only = true },

    // --- Auth (public: these establish a session) ---
    // Login + code issuance are pre-auth, so they are rate-limited by IP to blunt
    // credential stuffing / brute force.
    .{ .method = .POST, .path = "/api/official/user/query/random/code", .scopes = &.{.public}, .handler = auth.randomCode, .rate_limit = .{ .max = 20, .window_s = 60, .by = .ip } },
    .{ .method = .POST, .path = "/api/official/user/account/login/new", .scopes = &.{.public}, .handler = auth.loginNew, .rate_limit = .{ .max = 10, .window_s = 60, .by = .ip } },
    .{ .method = .POST, .path = "/api/official/user/account/login/equipment", .scopes = &.{.public}, .handler = auth.loginNew, .rate_limit = .{ .max = 10, .window_s = 60, .by = .ip } },
    // Reachable by a first-login `pending` token or a full control-plane session;
    // on success it revokes all the user's sessions and mints a fresh
    // control-plane session (new cookie).
    //
    // RATE-LIMITED BY USER, for the same reason `elevate` below is: now that it
    // VERIFIES `currentPassword`, it answers "was that the password?" — a guessing
    // oracle for anyone who reaches an unlocked browser. 5 per 5 minutes per
    // ACCOUNT. Keep `by = .user`: a household shares one address, so IP-keying (or
    // `.both`) would let one person's fumbling block a housemate — and, worse
    // here than on `elevate`, block them mid-way through the FORCED first-login
    // change, which is the one screen they cannot go around.
    .{ .method = .PUT, .path = "/api/user/password", .scopes = &.{ .controlplane, .pending }, .handler = auth.changePassword, .rate_limit = .{ .max = 5, .window_s = 300, .by = .user } },
    // Logout deletes the caller's own token; any authenticated caller may call it:
    .{ .method = .POST, .path = "/api/user/logout", .scopes = &.{ .controlplane, .device, .pending }, .handler = auth.logout },
    // Session restore for the SPA; a pending session may call it (to learn it must change):
    .{ .method = .GET, .path = "/api/user/me", .scopes = &.{ .controlplane, .pending }, .handler = auth.me },

    // --- Device / sync (the device face) ---
    // Pre-login, unauthenticated device calls: the device clears its binding and
    // probes account/server before it holds a token,
    // so these are public + lenient.
    // Pre-auth + IP-rate-limited (like the login routes): throttle unlink-abuse
    // and account enumeration (check/exists distinguishes USER_NOT_FOUND).
    .{ .method = .POST, .path = "/api/terminal/equipment/unlink", .scopes = &.{.public}, .handler = device.unlinkEquipmentLenient, .rate_limit = .{ .max = 20, .window_s = 60, .by = .ip } },
    .{ .method = .POST, .path = "/api/official/user/check/exists/server", .scopes = &.{.public}, .handler = device.checkExists, .rate_limit = .{ .max = 20, .window_s = 60, .by = .ip } },
    .{ .method = .GET, .path = "/api/file/query/server", .scopes = &.{.public}, .handler = device.queryServer, .read_only = true },
    // Post-login device sync + file API (device token via x-access-token).
    // `.public` ALONGSIDE `.device`, uniquely on this route: the Nomad sends this
    // call before it has stored the token its login just handed it, so requiring
    // the header answered 401 to every pairing and the device's own name never
    // arrived (docs/scratch/nomad-login.log). The handler does NOT then trust the
    // body — it requires a live device session for that serial and that account,
    // which is the token's evidence taken from the sessions table. See the long
    // comment there; this is the only route that may do this.
    .{ .method = .POST, .path = "/api/terminal/user/bindEquipment", .scopes = &.{ .device, .public }, .handler = device.bindEquipment },
    .{ .method = .POST, .path = "/api/user/query", .scopes = &.{.device}, .handler = device.userQuery, .read_only = true },
    // The official Android app's two extra post-login calls:
    // `bind/status` confirms the account is paired; `capacity/query` is the storage
    // figure in the app's own envelope. Both device-scope, identified by the token.
    .{ .method = .POST, .path = "/api/equipment/bind/status", .scopes = &.{.device}, .handler = device.bindStatus, .read_only = true },
    .{ .method = .POST, .path = "/api/file/capacity/query", .scopes = &.{.device}, .handler = device.capacityQuery, .read_only = true },
    // Storage figure the device displays, and the gate its "select folders to
    // sync" screen reads — a real Nomad calls it ~4× per sync session, so a 404
    // here breaks that screen. Served from the caller's `capacity` row.
    .{ .method = .POST, .path = "/api/file/2/users/get_space_usage", .scopes = &.{.device}, .handler = device.getSpaceUsage, .read_only = true },
    .{ .method = .POST, .path = "/api/file/2/files/synchronous/start", .scopes = &.{.device}, .handler = device.syncStart },
    .{ .method = .POST, .path = "/api/file/2/files/synchronous/end", .scopes = &.{.device}, .handler = device.syncEnd },
    .{ .method = .POST, .path = "/api/file/query/summary/hash", .scopes = &.{.device}, .handler = device.summaryHash, .read_only = true },
    .{ .method = .POST, .path = "/api/file/query/summary/id", .scopes = &.{.device}, .handler = device.summaryById, .read_only = true },
    .{ .method = .POST, .path = "/api/file/query/summary/group", .scopes = &.{.device}, .handler = device.summaryGroup, .read_only = true },
    // File enumeration (advertise our files to the device) + raw download path.
    // list_folder is the download trigger; download_v3 returns a URL-authed link
    // and /oss/get streams the bytes. /oss/get is .public because the device sends
    // NO x-access-token on the download GET — it is authorized by the `?t=` token
    // download_v3 mints (see http/download_tokens.zig), so a tokenless GET is 403,
    // not 401 (a 401 would make the device log itself out).
    // `manual_db_lock`: the burst-sync monopolizer. Its handler now scopes the
    // query to the requested folder and takes `ctx.db_lock` for ONLY that query
    // (the `resolvePath` + `walkChildren`/`walkSubtree`/`walkTree` block), releasing
    // it before the VO build + `json.respond`. Audited: it touches the DB nowhere
    // else. Was the default whole-handler lock held for the entire ~1 s walk.
    .{ .method = .POST, .path = "/api/file/2/files/list_folder", .scopes = &.{.device}, .handler = device.listFolder, .manual_db_lock = true },
    .{ .method = .POST, .path = "/api/file/3/files/query/by/path_v3", .scopes = &.{.device}, .handler = device.queryByPathV3, .read_only = true },
    .{ .method = .POST, .path = "/api/file/3/files/query_v3", .scopes = &.{.device}, .handler = device.queryV3, .read_only = true },
    .{ .method = .POST, .path = "/api/file/3/files/download_v3", .scopes = &.{.device}, .handler = device.downloadV3 },
    // The device's only delete — for FILES as much as folders, despite the name.
    // It soft-deletes into the recycle bin (see the handler); leaving it
    // unimplemented made the device re-download the notes it had just deleted.
    .{ .method = .POST, .path = "/api/file/3/files/delete_folder_v3", .scopes = &.{.device}, .handler = device.deleteFolderV3 },
    // The device's move/rename. Absent, it 404'd on a note rename and the firmware
    // aborted the whole sync; like delete_folder_v3 it now NEVER 404s (see the
    // handler). `to_path` is the FULL destination path including the filename.
    .{ .method = .POST, .path = "/api/file/3/files/move_v3", .scopes = &.{.device}, .handler = device.moveV3 },
    // The device's copy — the twin of move_v3, used for CONFLICT RESOLUTION (the
    // firmware copies a diverged note aside to a `…_CONFLICT_<ts>.note` name).
    // Absent, it 404'd there and aborted the sync; it too NEVER 404s (see handler).
    // Content-addressed: the copy shares the source's blob. Same body as move_v3.
    .{ .method = .POST, .path = "/api/file/3/files/copy_v3", .scopes = &.{.device}, .handler = device.copyV3 },
    // The device's folder create. Without it a folder made on the Nomad reached
    // the server only when a file was uploaded into it (`upload/apply`
    // provisions the destination path), so an empty folder never synced at all.
    .{ .method = .POST, .path = "/api/file/2/files/create_folder_v2", .scopes = &.{.device}, .handler = device.createFolderV2 },
    // `manual_db_lock`: the two /oss byte-transfer routes stream multi-MB bodies
    // between the filesystem and the socket with only a short DB touch at each
    // end. The default whole-handler DB lock would hold the one global lock for
    // the entire transfer, serializing every other request behind a big
    // upload/download; these handlers take it themselves, only around their own DB
    // calls. Set this ONLY on a handler audited to lock every DB touch itself —
    // see router.Route.manual_db_lock, and the route-table pin in the test suite.
    .{ .method = .GET, .path = "/oss/get/:id", .scopes = &.{.public}, .handler = device.ossGet, .manual_db_lock = true },
    // Upload byte-path (M2): apply reserves an upload + returns an /oss/put URL;
    // /oss/put receives the multipart file bytes; finish commits into the tree.
    // The device sends x-access-token to all three (incl. /oss/put), so all .device.
    .{ .method = .POST, .path = "/api/file/3/files/upload/apply", .scopes = &.{.device}, .handler = device.uploadApply },
    .{ .method = .POST, .path = "/oss/put/:innerName", .scopes = &.{.device}, .handler = device.ossPut, .manual_db_lock = true },
    .{ .method = .POST, .path = "/api/file/2/files/upload/finish", .scopes = &.{.device}, .handler = device.uploadFinish },
    // Planner/calendar app (not note sync) — stubbed empty so it doesn't error.
    .{ .method = .POST, .path = "/api/file/schedule/group/all", .scopes = &.{.device}, .handler = device.scheduleGroupAll },
    .{ .method = .POST, .path = "/api/file/schedule/task/all", .scopes = &.{.device}, .handler = device.scheduleTaskAll },

    // --- Control plane / browser ---
    // Onboarding bootstrap fact, read by the login page BEFORE anyone can sign in
    // — hence `.public`, unlike every other route on this face. Reports the
    // server's own LAN address (which the browser cannot determine itself) and
    // whether this is a brand-new server. On a single-household LAN tool "this
    // server is new" is not a secret; see handlers/controlplane.zig.
    .{ .method = .GET, .path = "/api/controlplane/server-info", .scopes = &.{.public}, .handler = controlplane.controlplaneServerInfo },
    // Control-plane device-management unlink (scoped to the caller's account).
    // Distinct from the device's pre-login `/api/terminal/equipment/unlink` above.
    .{ .method = .POST, .path = "/api/controlplane/equipment/unlink", .scopes = &.{.controlplane}, .handler = controlplane.controlplaneUnlink },
    // Browse/read endpoints for the SPA (see webapp/src/core/types.ts).
    .{ .method = .GET, .path = "/api/controlplane/tree", .scopes = &.{.controlplane}, .handler = controlplane.controlplaneTree },
    // The signed-in user's own storage usage, for the rail's quota bar.
    .{ .method = .GET, .path = "/api/controlplane/usage", .scopes = &.{.controlplane}, .handler = controlplane.controlplaneUsage, .read_only = true },

    // --- The account screen: managing YOURSELF ---
    //
    // The counterpart of `/api/admin/*`, and the distinction is the point: every
    // verb under `/api/admin` is aimed at ANOTHER account and names it with an
    // `:id`; nothing here takes a target at all. The session is the target. That is
    // what stops a person who wants to change their own settings reaching for a
    // tool built to change somebody else's, which is the incident this whole
    // surface came out of.
    //
    // Deliberately NOT `require_admin` — a household member who is not an admin
    // cannot open the console at all, and they are exactly who this is for.
    //
    // No `manual_db_lock` on any of them, including the storage split: it is three
    // index-assisted scans of the caller's own rows (0.65 ms measured on the live
    // beta database), which is ordinary whole-handler-lock work, not streaming.
    .{ .method = .GET, .path = "/api/controlplane/account", .scopes = &.{.controlplane}, .handler = controlplane.controlplaneAccount },
    .{ .method = .GET, .path = "/api/controlplane/account/storage", .scopes = &.{.controlplane}, .handler = controlplane.controlplaneAccountStorage, .read_only = true },
    // Self-service device unlink. Distinct from the caller-scoped
    // `/api/controlplane/equipment/unlink` above: this one asserts the binding is
    // the caller's and 404s when it is not, instead of answering 200 for a serial
    // that matched nothing. Same body.
    .{ .method = .POST, .path = "/api/controlplane/account/devices/unlink", .scopes = &.{.controlplane}, .handler = controlplane.controlplaneUnlinkMyDevice },
    // "Sign out everywhere else" — every session of this account but the one
    // asking. Not `.pending`: a session that still owes a password change has no
    // business revoking the others.
    .{ .method = .POST, .path = "/api/controlplane/account/sign-out-others", .scopes = &.{.controlplane}, .handler = controlplane.controlplaneSignOutOthers },
    // How many versions of each file this account keeps. PUT, not POST: it sets a
    // value to what the body says rather than appending an action, so a retry after
    // a dropped response lands on the same state instead of evicting twice. Not
    // `.pending` — a session that still owes a password change should not be
    // discarding version history.
    .{ .method = .PUT, .path = "/api/controlplane/account/versions", .scopes = &.{.controlplane}, .handler = controlplane.controlplaneSetVersions },
    // Generic per-item metadata (page dims, `fileType`, `fileHash`) — EVERY
    // previewable kind fetches this on open, not just `.note`, so it lives under
    // `/file/metadata/` rather than the `/note/` noun. The genuinely note-only
    // reads (`/note/:id/page`, `/note/:id/search`, `/template`, `/history/...`)
    // stay below.
    .{ .method = .GET, .path = "/api/controlplane/file/metadata/:id", .scopes = &.{.controlplane}, .handler = controlplane.controlplaneNote },
    // Find-in-note: EVERY matching page of ONE note, with a count per page.
    // Complete and unranked — the client auto-drains its cursor to the exact
    // count, which is why it is a route of its own and not a mode of something
    // else. `golden-search.md` §6 step 7 retires it once `text/<md5>` can be
    // searched in the browser.
    .{ .method = .GET, .path = "/api/controlplane/note/:id/search", .scopes = &.{.controlplane}, .handler = controlplane.controlplaneNoteSearch, .read_only = true },
    // Find-in-txt: EVERY matching `.txt` paragraph of ONE file, with a count and
    // byte range per paragraph. Its own route because it answers about paragraphs
    // + byte ranges rather than pages + counts — different fields for a different
    // viewer. Retired alongside its `.note` twin in step 7.
    .{ .method = .GET, .path = "/api/controlplane/note/:id/txt-search", .scopes = &.{.controlplane}, .handler = controlplane.controlplaneTxtSearch, .read_only = true },
    // --- The client-side search index (`golden-search.md` §2/§3) ---
    //
    // GLOBAL SEARCH IS THE BROWSER'S. The server ships the caller's complete live
    // document set (the manifest) and the per-document term records the stream
    // stitches together, and interprets no query at all — §6 step 6 deleted the
    // route that did.
    //
    // Both are BYTES rather than JSON — §9.2 measured the same manifest at 143 KB
    // of JSON against 27 KB of raw md5s, and this server compresses no API
    // response, so that 5.2x is what actually travels.
    //
    // The manifest is `read_only`: it reads `files`, `note_index` and
    // `note_page_index` directly and heals nothing. The self-healing family this
    // section's header excludes is the one that calls `indexRowEnsuring`; this
    // does not, and the read-only probe in `test/http_integration.zig` checks that
    // claim on a connection where a write would fail loudly.
    //
    // It is `no-cache` + ETag — the caller's library is mutable, so the answer is
    // a conditional request per visit; see the handler for why that is the answer
    // to §9.2's open refetch question rather than a polling cadence.
    .{ .method = .GET, .path = "/api/controlplane/search-index/manifest", .scopes = &.{.controlplane}, .handler = controlplane.controlplaneSearchIndexManifest, .read_only = true },
    // The stitched stream (`golden-search.md` §3.2/§3.3, build order step 2), and
    // it is the one route in this family that is NOT `read_only`.
    //
    // Not because it writes — it reads `files` and the two index tables exactly as
    // its neighbours do — but because `read_only` holds its reader lease for the
    // whole dispatch, and this dispatch is a download. A 3G client would park a
    // pooled reader for the length of it, and an EMPTY pool degrades `read_only`
    // to the writer under `db_lock`, so one slow reader would stall device sync
    // for its whole download. `router.readOnlyConflict` names the alternative:
    // "a streaming route that wants a reader needs the reader threaded through
    // its own brackets", which is what the handler does — `ctx.borrowReader()`
    // around the manifest query and nothing else, released before the head goes
    // out. That is also why it takes no read-only probe: the flag is what the
    // probe audits, and this route does not claim it.
    .{ .method = .GET, .path = "/api/controlplane/search-index/stream", .scopes = &.{.controlplane}, .handler = controlplane.controlplaneSearchIndexStream, .manual_db_lock = true },
    // --- Hot-cache versioning: "history of this file" ---
    // All note-scoped by `:id` (the same ownership gate the siblings above use);
    // the per-version routes gate `:md5` on being a RETAINED version of THAT file
    // (`Files.historyVersion`) — a stranger's md5, or one not in this file's
    // history, is a 404. `history` lists versions; `.../page/:n` previews one
    // (reusing the live page path, hence `manual_db_lock` like `/note/:id/page/:n`
    // — it STREAMS); `.../search` is a one-document scan (H8, NOT the FTS);
    // `.../restore` re-points through the supersede path and is undoable (H9).
    .{ .method = .GET, .path = "/api/controlplane/note/:id/history", .scopes = &.{.controlplane}, .handler = controlplane.controlplaneHistory },
    // The version's OWN page geometry (count + dims), read from its retained
    // `note_index` (H7) so a preview of a version with a different page count than
    // the current note renders the version's real pages. A pure index read like
    // `/note/:id` — NOT `manual_db_lock`, non-immutable JSON.
    .{ .method = .GET, .path = "/api/controlplane/note/:id/history/:md5/meta", .scopes = &.{.controlplane}, .handler = controlplane.controlplaneHistoryMeta },
    .{ .method = .GET, .path = "/api/controlplane/note/:id/history/:md5/page/:n", .scopes = &.{.controlplane}, .handler = controlplane.controlplaneHistoryPage, .manual_db_lock = true },
    // The version's page-N recognized transcript + word boxes — the per-version twin
    // of the live `/note/:id/page/:n/text`, read from the version's OWN retained
    // `note_page_index` (H2). SAME `PageTextVO` body shape as the live route; NOT
    // `manual_db_lock` and NOT `immutable`, exactly like it (pure DB + one KB-scale
    // ranged read, and a struct-serialised JSON body whose shape `:md5` cannot pin).
    .{ .method = .GET, .path = "/api/controlplane/note/:id/history/:md5/page/:n/text", .scopes = &.{.controlplane}, .handler = controlplane.controlplaneHistoryPageText },
    // The version's RAW blob bytes — the raw-by-version twin of the live
    // `/file/:id?v=` route, for the client-side viewers that fetch a WHOLE blob
    // (`.spd`/`.txt`/image) rather than per-page SNPG like `.note`. Bytes + headers
    // identical to `/file/:id` for this file's name, keyed by the version `:md5`;
    // `manual_db_lock` because it STREAMS (like `/file/:id`), and `immutable`
    // because `:md5` pins the whole blob (like `/history/:md5/page/:n`).
    .{ .method = .GET, .path = "/api/controlplane/note/:id/history/:md5/raw", .scopes = &.{.controlplane}, .handler = controlplane.controlplaneHistoryRaw, .manual_db_lock = true },
    .{ .method = .GET, .path = "/api/controlplane/note/:id/history/:md5/search", .scopes = &.{.controlplane}, .handler = controlplane.controlplaneHistorySearch, .read_only = true },
    .{ .method = .POST, .path = "/api/controlplane/note/:id/history/:md5/restore", .scopes = &.{.controlplane}, .handler = controlplane.controlplaneHistoryRestore },
    // Immutable per-page byte payload (versioned by content hash; browser-cached).
    // `manual_db_lock` for the same reason as the /oss routes above: the lookup and
    // the page plan are two indexed single-row reads, and then the payload STREAMS
    // off the blob with zero DB access. Opening a note fires ~10 of these (stage +
    // prefetch + filmstrip), so the whole-handler lock made them serialize against
    // each other and stall device sync behind them; the handler takes the lock
    // around just its lookup + plan.
    .{ .method = .GET, .path = "/note/:id/page/:n", .scopes = &.{.controlplane}, .handler = controlplane.controlplanePage, .manual_db_lock = true },
    // A page's custom IMAGE template (PNG/JPG/JPEG/WEBP background), content-
    // addressed by the asset hash and served immutable — a `streamNoteCover`
    // clone. NOTE-SCOPED (`:id` gives the same ownership gate as the page bytes),
    // and `manual_db_lock` for the same streaming reason as `/note/:id/page/:n`:
    // resolve is one indexed read (the byte range is already in the page's
    // `layers` blob — no `.note` parse), then the bytes STREAM off the blob with
    // the lock released. Fetched once per distinct template by the browser reader.
    .{ .method = .GET, .path = "/note/:id/template/:hash", .scopes = &.{.controlplane}, .handler = controlplane.controlplaneTemplate, .manual_db_lock = true },
    // Raw stored bytes of ONE file, for the browser face — the preview/download
    // path for everything that is not a `.note` (an exported PNG, a synced PDF).
    // Preview and download are the same route; only `Content-Disposition` differs,
    // and only an allowlisted type is ever `inline` (see the handler — `svg` is
    // excluded on purpose). Sibling of `/note/:id/page/:n`, versioned by the blob
    // md5 for the same `immutable` reason, and `manual_db_lock` for the same
    // streaming reason: a multi-MB PDF must not hold the global DB lock.
    .{ .method = .GET, .path = "/file/:id", .scopes = &.{.controlplane}, .handler = controlplane.controlplaneFile, .manual_db_lock = true },
    // The embedded thumbnail derived from a blob — a `.spd`'s `config.thumbnail`
    // or a `.note`'s device-rendered cover — stored on disk in
    // `thumbs/<source_md5>` and streamed with a Content-Type sniffed from its
    // own magic. Content-addressed by the source blob md5 and `immutable` for
    // the same reason as `/file/:id`; 404 when the blob ships none (or the
    // caller does not hold it — indistinguishable). `manual_db_lock` for two
    // reasons: the DB is touched only for the ownership check + repair gate
    // before a pure fs→socket stream (the `rawFile` shape), and — sharper —
    // this route is the trigger for the ON-DEMAND repair, which dispatches on
    // the blob's own magic, buffers up to 16 MiB of untrusted SQLite (or runs a
    // full `.note` parse), and whose lock order (repair-mutex → db-lock, see
    // `Files.thumb_repair`) requires the handler lock to be RELEASED before it
    // runs. Only the browser fetches it, so `.controlplane`; ownership is
    // enforced in the service via `Files.holdsBlob` (a foreign hash is a 404,
    // not a probe).
    .{ .method = .GET, .path = "/thumbnail/:hash", .scopes = &.{.controlplane}, .handler = controlplane.controlplaneThumbnail, .manual_db_lock = true },
    // The same page's recognized (on-device OCR) transcript, versioned by its
    // `text_hash` so the URL turns over exactly when recognition does.
    //
    // NOT immutable, unlike its two siblings above, and the difference is the
    // rule: `immutable` is safe only when the cache key covers everything that can
    // change about the response. `?v=` covers the transcript BYTES; it cannot
    // cover the JSON struct they are wrapped in, which gains and loses fields on
    // deploys. It shipped as immutable once and pinned a year of wordless
    // responses the day `words` was added. Serialised-from-a-struct ⇒ revalidate.
    // See the handler, and the cache-policy pin in the test suite.
    //
    // NOT `manual_db_lock`: it is pure DB and KB-scale, so the whole-handler lock
    // costs microseconds — the streaming argument above simply does not apply.
    .{ .method = .GET, .path = "/note/:id/page/:n/text", .scopes = &.{.controlplane}, .handler = controlplane.controlplanePageText },
    // A page's OWN links — the rectangles a PDF used as its template brought
    // with it (`note-format.md` §14). The exact shape and lifetime of the text
    // route above: `?v={linksHash}` from the page list, KB-scale, one ranged
    // read into an address-based container, and `no-cache` for the same reason —
    // it is a struct serialised to JSON, and `?v=` versions the block, not the
    // struct. NOT per-document: the capture that established the format carries
    // 51,256 records over 1702 pages, so this is fetched for the page on screen
    // and no other.
    .{ .method = .GET, .path = "/note/:id/page/:n/links", .scopes = &.{.controlplane}, .handler = controlplane.controlplanePageLinks },
    // Live freshness push (SSE): a HELD connection that emits the caller's
    // syncVersion whenever it changes, plus a heartbeat comment frame.
    //
    // `manual_db_lock` for a reason unlike the streaming routes above, and a
    // sharper one. Those hold the lock too long (a multi-MB transfer); this one
    // would hold it FOREVER — the default whole-handler lock spans the handler,
    // and this handler's lifetime is the connection's. A single parked SSE stream
    // would own the one global DB lock for minutes and block every other request
    // on the server, including device sync: one open browser tab would stop the
    // Nomad. The handler therefore brackets each of its two `files.syncVersion`
    // reads in `ctx.lockDb()`/`unlockDb()` and holds the lock across nothing else
    // — never the poll sleep, never a socket write.
    //
    // Concurrency is capped (see http/event_streams.zig); over the cap the
    // handler DEGRADES to the historical one-shot frame rather than refusing, so
    // an extra tab becomes a poller instead of an error.
    .{ .method = .GET, .path = "/api/controlplane/events", .scopes = &.{.controlplane}, .handler = controlplane.controlplaneEvents, .manual_db_lock = true },

    // --- Recycle bin (control plane) ---
    //
    // The control plane's first WRITE routes. No CSRF token: the session cookie is
    // `HttpOnly; SameSite=Strict`, which is what `controlplaneUnlink` above already
    // relies on — see the header comment in handlers/controlplane.zig.
    //
    // Ordering note: `/bin/note/:id` and `/bin/file/:id` are listed BEFORE
    // `/bin/:id/restore` so a literal segment is never shadowed by a `:id`
    // capture. They cannot actually collide (`bin/note/5` fails `:id/restore`'s
    // third segment), but the order makes that independent of the matcher.
    .{ .method = .GET, .path = "/api/controlplane/bin", .scopes = &.{.controlplane}, .handler = controlplane.controlplaneBin },
    // Preview a trashed item before deciding (U2b). These read through
    // `Files.getTrashed` — NOT a relaxed `Files.get`, which stays the shared
    // ownership boundary for every live read. `manual_db_lock` on the two byte
    // routes for the same streaming reason as their live twins.
    // The bin twin of `/api/controlplane/file/metadata/:id` (generic per-item
    // meta for a TRASHED file); the note-only bin reads stay under `/bin/note/`.
    .{ .method = .GET, .path = "/api/controlplane/bin/file/metadata/:id", .scopes = &.{.controlplane}, .handler = controlplane.controlplaneBinNote },
    .{ .method = .GET, .path = "/api/controlplane/bin/note/:id/page/:n", .scopes = &.{.controlplane}, .handler = controlplane.controlplaneBinPage, .manual_db_lock = true },
    // The bin twins of the live text + find-in-note routes: page-N ovals and
    // find-in-a-trashed-note, keyed on the trashed file's CURRENT md5 (owned,
    // `deleted = 1`). Both non-immutable JSON, both pure-DB (no `manual_db_lock`);
    // a live id on either is a 404, like the sibling bin gates.
    .{ .method = .GET, .path = "/api/controlplane/bin/note/:id/page/:n/text", .scopes = &.{.controlplane}, .handler = controlplane.controlplaneBinPageText },
    .{ .method = .GET, .path = "/api/controlplane/bin/note/:id/search", .scopes = &.{.controlplane}, .handler = controlplane.controlplaneBinNoteSearch, .read_only = true },
    // View-only version history for a TRASHED note (bin-parity phase 2): the same
    // history handlers as the live `/note/:id/history/...` routes, delegated with the
    // trashed scope (`deleted = 1`), reachable because `file_history` follows a file
    // to the bin (H10). There is deliberately NO `/restore` twin — restore the FILE
    // (`/bin/:id/restore`), THEN restore a version in the live viewer. `:md5` must be
    // a retained version of THAT trashed file; a live id/md5 on any of these is a 404
    // (and vice versa on the live routes). Cache/lock policy mirrors each live twin:
    // the page + raw byte streamers are `manual_db_lock` (+ `immutable`), the rest
    // are pure-DB JSON.
    .{ .method = .GET, .path = "/api/controlplane/bin/note/:id/history", .scopes = &.{.controlplane}, .handler = controlplane.controlplaneBinHistory },
    .{ .method = .GET, .path = "/api/controlplane/bin/note/:id/history/:md5/page/:n", .scopes = &.{.controlplane}, .handler = controlplane.controlplaneBinHistoryPage, .manual_db_lock = true },
    .{ .method = .GET, .path = "/api/controlplane/bin/note/:id/history/:md5/page/:n/text", .scopes = &.{.controlplane}, .handler = controlplane.controlplaneBinHistoryPageText },
    .{ .method = .GET, .path = "/api/controlplane/bin/note/:id/history/:md5/raw", .scopes = &.{.controlplane}, .handler = controlplane.controlplaneBinHistoryRaw, .manual_db_lock = true },
    .{ .method = .GET, .path = "/api/controlplane/bin/note/:id/history/:md5/search", .scopes = &.{.controlplane}, .handler = controlplane.controlplaneBinHistorySearch, .read_only = true },
    .{ .method = .GET, .path = "/api/controlplane/bin/file/:id", .scopes = &.{.controlplane}, .handler = controlplane.controlplaneBinFile, .manual_db_lock = true },
    // Restore reports what it ACTUALLY did — the ancestor chain, the descendants,
    // and any auto-rename — because that routinely exceeds what was asked.
    .{ .method = .POST, .path = "/api/controlplane/bin/:id/restore", .scopes = &.{.controlplane}, .handler = controlplane.controlplaneRestore },
    // The only route on this face that reaches `decref`: purge is where blob
    // refcounts drop, blobs leave disk, and quota is finally refunded.
    .{ .method = .DELETE, .path = "/api/controlplane/bin/:id", .scopes = &.{.controlplane}, .handler = controlplane.controlplanePurge },
    .{ .method = .DELETE, .path = "/api/controlplane/bin", .scopes = &.{.controlplane}, .handler = controlplane.controlplaneEmptyBin },
    // U5: the browser's only delete. Soft — it moves the entry (and, for a folder,
    // its whole subtree) into the bin; the device does that subtree walk itself and
    // sends one request per entity, but the browser sends one request, so the walk
    // happens server-side.
    .{ .method = .DELETE, .path = "/api/controlplane/entry/:id", .scopes = &.{.controlplane}, .handler = controlplane.controlplaneTrash },

    // Rename a live entry (file or folder) in place — a `move` to its own parent
    // with `autorename = false`, so a sibling clash is a 409 the dialog surfaces
    // rather than a silent " (2)" suffix. NOT `manual_db_lock`: pure metadata DB
    // work, nothing streams — the same lock convention as the trash route above.
    .{ .method = .POST, .path = "/api/controlplane/entry/:id/rename", .scopes = &.{.controlplane}, .handler = controlplane.controlplaneRename },

    // Upload a file from the browser into `:id` (the literal `root` = the library
    // root). `multipart/form-data`, one file part, whose `filename` names the
    // entry. It does NOT speak the device protocol — the Nomad pulls down
    // whatever the tree says we hold — so it is the device's `upload/finish`
    // tree-link (`Files.placeUpload` → `Files.linkBlob`) without the three-step
    // apply/put/finish dance.
    //
    // `?onConflict=rename|replace` (default, and fallback for anything
    // unrecognised: `rename`) picks what happens when the name is taken — keep
    // both, or supersede the live file, which `linkBlob` retains in
    // `file_history` rather than destroying. See `OnConflict` in the handler.
    //
    // `manual_db_lock` like `/oss/put`, and for exactly its reason: the body is a
    // multi-MB transfer, and the default whole-handler lock would hold the one
    // global DB lock for the entire upload, stalling every other request
    // (including device sync) behind it. Audited: the handler's ONLY DB touches
    // are the destination `files.get` and the final `placeUpload` + `entryVO`,
    // each inside its own `ctx.lockDb()`/`unlockDb()` bracket; the blob ingest
    // between them touches the DB not at all. This is the opposite of `rename`
    // above, which streams nothing and keeps the default lock.
    .{ .method = .POST, .path = "/api/controlplane/folder/:id/upload", .scopes = &.{.controlplane}, .handler = controlplane.controlplaneUpload, .manual_db_lock = true },

    // --- Admin: re-authentication ("elevation") ---
    // `require_admin` below now means "an admin who re-entered their password
    // recently", so these two are the way in and the way out. NEITHER is
    // `require_admin`: `elevate` cannot be (it would gate itself behind the check
    // it exists to satisfy), and `lock` must succeed even for a caller whose
    // elevation already lapsed.
    //
    // `.pending` is absent from both scope sets on purpose: a session that still
    // owes a password change must not be able to elevate around that obligation.
    //
    // RATE-LIMITED BY USER, NOT BY IP. `elevate` is a password oracle, so it needs
    // a limit — but a household shares one address, so IP-keying would let one
    // person's fumbling lock every housemate out of the console. 5 attempts per 5
    // minutes per ACCOUNT (the bucket refills at 1/min). Keep `by = .user`: `.both`
    // would quietly reintroduce exactly the shared-IP lockout.
    .{ .method = .POST, .path = "/api/admin/elevate", .scopes = &.{.controlplane}, .handler = admin.elevate, .rate_limit = .{ .max = 5, .window_s = 300, .by = .user } },
    .{ .method = .POST, .path = "/api/admin/lock", .scopes = &.{.controlplane}, .handler = admin.lock },

    // --- Admin: household user management (control plane, elevated admin only) ---
    // `require_admin` gates on `is_admin` AND a live elevation — including the
    // read-only listing, which otherwise leaks every housemate's email and quota
    // from an unattended tablet. A lapsed elevation answers 428 ELEVATION_REQUIRED,
    // NOT 401: see router.elevation_required_status for why the distinction is
    // load-bearing on the client.
    .{ .method = .POST, .path = "/api/admin/users", .scopes = &.{.controlplane}, .require_admin = true, .handler = admin.createUser },
    .{ .method = .GET, .path = "/api/admin/users", .scopes = &.{.controlplane}, .require_admin = true, .handler = admin.listUsers },
    .{ .method = .DELETE, .path = "/api/admin/users/:id", .scopes = &.{.controlplane}, .require_admin = true, .handler = admin.deleteUser },
    .{ .method = .POST, .path = "/api/admin/users/:id/reset", .scopes = &.{.controlplane}, .require_admin = true, .handler = admin.resetPassword },

    // --- Admin: one person's devices and quota (F6/F7) ---
    // The first admin routes that act on another account's RESOURCES rather than
    // on the account row, so `:id` names whose devices/bytes these are. The
    // ownership check therefore moved from "the caller's" (which the
    // control-plane unlink above gets for free by putting `caller.user_id` in the
    // WHERE clause) to "the named user's" — see `Service.adminUnlinkDevice`, which
    // answers a serial belonging to a DIFFERENT housemate exactly as it answers an
    // unknown one, so an admin cannot probe across accounts by id confusion.
    //
    // No `.manual_db_lock` on any of these: they are indexed single-row DB work
    // with nothing streamed, so the default whole-handler lock costs microseconds.
    .{ .method = .GET, .path = "/api/admin/users/:id/devices", .scopes = &.{.controlplane}, .require_admin = true, .handler = admin.listDevices },
    .{ .method = .POST, .path = "/api/admin/users/:id/devices/unlink", .scopes = &.{.controlplane}, .require_admin = true, .handler = admin.unlinkDevice },
    .{ .method = .GET, .path = "/api/admin/users/:id/quota", .scopes = &.{.controlplane}, .require_admin = true, .handler = admin.getQuota },
    // Lowering the allotment below current usage is ACCEPTED and deletes nothing —
    // it stops new syncs until the owner frees space. See the handler.
    .{ .method = .PUT, .path = "/api/admin/users/:id/quota", .scopes = &.{.controlplane}, .require_admin = true, .handler = admin.setQuota },

    // --- Admin: server-wide settings and health (F8/F9) ---
    // Retention is the one genuinely server-wide setting here, which is why it is
    // not under `/users/:id`. Writing it never purges retroactively: the new
    // window's clock starts at the write (services/settings.zig `sweepCutoff`).
    .{ .method = .GET, .path = "/api/admin/settings/retention", .scopes = &.{.controlplane}, .require_admin = true, .handler = admin.getRetention },
    .{ .method = .PUT, .path = "/api/admin/settings/retention", .scopes = &.{.controlplane}, .require_admin = true, .handler = admin.setRetention },
    // Household-wide totals ONLY — memory against the budget, blob disk, version.
    // No per-person activity of any kind belongs on this route; see services/health.zig.
    .{ .method = .GET, .path = "/api/admin/health", .scopes = &.{.controlplane}, .require_admin = true, .handler = admin.health },
};

// A route may declare no more `:name` captures than `router.Params` can hold —
// a 9th would be silently dropped at match time (and now trips `Params.put`'s
// assert). Catch it at COMPILE time, here where the table is edited, so an
// over-capacity route can never ship.
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

// No route may be BOTH `manual_db_lock` and `require_admin`. `dispatchLocked`
// renews the admin elevation window only on the automatic-locking path — the
// manual branch returns before it — so such a route would silently stop sliding
// elevation and hand admins a surprise 428 with nothing pointing at the flag.
//
// An assert rather than renewing in both branches, deliberately: the second is a
// silent behaviour someone has to remember exists in two places under two lock
// disciplines, while this one cannot be got wrong. Adding the flag pair is a
// build error, here, where the table is edited. See `router.manualAdminRoute`.
comptime {
    if (router.manualAdminRoute(&routes)) |i| {
        @compileError("route '" ++ routes[i].path ++ "' is both manual_db_lock and require_admin; " ++
            "dispatchLocked's manual branch never renews admin elevation (see router.manualAdminRoute)");
    }
}

// No route may be `read_only` together with `manual_db_lock` or `require_admin`.
// A manual handler brackets its own `ctx.lockDb()`, which under a reader lease
// would lock the writer while the handler read a different connection — the lock
// silently stops meaning anything. An admin route renews its elevation window
// with an UPDATE, which a reader refuses. See `router.readOnlyConflict`.
comptime {
    if (router.readOnlyConflict(&routes)) |i| {
        @compileError("route '" ++ routes[i].path ++ "' is read_only together with manual_db_lock or " ++
            "require_admin; neither combination can be made to hold (see router.readOnlyConflict)");
    }
}

test "the route table fits the db_lock histogram's fixed table" {
    // `http/lock_stats.zig` sizes its per-route histogram at compile time, and a
    // route past the end degrades silently into the shared overflow slot — the
    // measurement would keep working and would quietly stop attributing the new
    // routes. Fail here instead, where the table is edited.
    const lock_stats = @import("http/lock_stats.zig");
    try @import("std").testing.expect(routes.len <= lock_stats.max_routes);
}
