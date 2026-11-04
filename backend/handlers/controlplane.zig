//! Control-plane handlers (the browser face): device-management unlink, the
//! browse/read endpoints for the SPA (tree, note meta, per-page bytes), and the
//! live-freshness SSE channel. Thin HTTP shells over the `ControlPlaneService`,
//! one file per feature under `controlplane/`; this file is the route table's view.

const account_handlers = @import("controlplane/account.zig");
const bin_handlers = @import("controlplane/bin.zig");
const writes_handlers = @import("controlplane/writes.zig");
const read_handlers = @import("controlplane/read.zig");
const history_handlers = @import("controlplane/history.zig");
const bytes_handlers = @import("controlplane/bytes.zig");
const search_handlers = @import("controlplane/search.zig");

pub const unlink = account_handlers.unlink;
pub const usage = account_handlers.usage;
pub const account = account_handlers.account;
pub const setVersions = account_handlers.setVersions;
pub const accountStorage = account_handlers.accountStorage;
pub const unlinkMyDevice = account_handlers.unlinkMyDevice;
pub const signOutOthers = account_handlers.signOutOthers;
pub const serverInfo = account_handlers.serverInfo;

pub const bin = bin_handlers.bin;
pub const trash = bin_handlers.trash;
pub const restore = bin_handlers.restore;
pub const purge = bin_handlers.purge;
pub const emptyBin = bin_handlers.emptyBin;
pub const binNote = bin_handlers.binNote;
pub const binPageText = bin_handlers.binPageText;

pub const rename = writes_handlers.rename;
pub const upload = writes_handlers.upload;

pub const tree = read_handlers.tree;
pub const note = read_handlers.note;
pub const page = read_handlers.page;
pub const binPage = read_handlers.binPage;

pub const history = history_handlers.history;
pub const binHistory = history_handlers.binHistory;
pub const historyMeta = history_handlers.historyMeta;
pub const historyPage = history_handlers.historyPage;
pub const binHistoryPage = history_handlers.binHistoryPage;
pub const historyRestore = history_handlers.historyRestore;
pub const historyRaw = history_handlers.historyRaw;
pub const binHistoryRaw = history_handlers.binHistoryRaw;
pub const historyPageText = history_handlers.historyPageText;
pub const binHistoryPageText = history_handlers.binHistoryPageText;

pub const file = bytes_handlers.file;
pub const binFile = bytes_handlers.binFile;
pub const thumbnail = bytes_handlers.thumbnail;
pub const template = bytes_handlers.template;
pub const pageText = bytes_handlers.pageText;
pub const pageLinks = bytes_handlers.pageLinks;

pub const searchIndexManifest = search_handlers.searchIndexManifest;
pub const searchIndexStream = search_handlers.searchIndexStream;
pub const documentText = search_handlers.documentText;
pub const events = search_handlers.events;
