//! Control-plane handlers (the browser face): device-management unlink, the
//! browse/read endpoints for the SPA (tree, note meta, per-page bytes), and the
//! live-freshness SSE channel. Thin HTTP shells over the `ControlPlaneService`,
//! one file per feature under `controlplane/`; this file is the route table's view.

const account = @import("controlplane/account.zig");
const bin = @import("controlplane/bin.zig");
const writes = @import("controlplane/writes.zig");
const read = @import("controlplane/read.zig");
const history = @import("controlplane/history.zig");
const bytes = @import("controlplane/bytes.zig");
const search = @import("controlplane/search.zig");

pub const controlplaneUnlink = account.controlplaneUnlink;
pub const controlplaneUsage = account.controlplaneUsage;
pub const controlplaneAccount = account.controlplaneAccount;
pub const controlplaneSetVersions = account.controlplaneSetVersions;
pub const controlplaneAccountStorage = account.controlplaneAccountStorage;
pub const controlplaneUnlinkMyDevice = account.controlplaneUnlinkMyDevice;
pub const controlplaneSignOutOthers = account.controlplaneSignOutOthers;
pub const controlplaneServerInfo = account.controlplaneServerInfo;

pub const controlplaneBin = bin.controlplaneBin;
pub const controlplaneTrash = bin.controlplaneTrash;
pub const controlplaneRestore = bin.controlplaneRestore;
pub const controlplanePurge = bin.controlplanePurge;
pub const controlplaneEmptyBin = bin.controlplaneEmptyBin;
pub const controlplaneBinNote = bin.controlplaneBinNote;
pub const controlplaneBinPageText = bin.controlplaneBinPageText;

pub const controlplaneRename = writes.controlplaneRename;
pub const controlplaneUpload = writes.controlplaneUpload;

pub const controlplaneTree = read.controlplaneTree;
pub const controlplaneNote = read.controlplaneNote;
pub const controlplanePage = read.controlplanePage;
pub const controlplaneBinPage = read.controlplaneBinPage;

pub const controlplaneHistory = history.controlplaneHistory;
pub const controlplaneBinHistory = history.controlplaneBinHistory;
pub const controlplaneHistoryMeta = history.controlplaneHistoryMeta;
pub const controlplaneHistoryPage = history.controlplaneHistoryPage;
pub const controlplaneBinHistoryPage = history.controlplaneBinHistoryPage;
pub const controlplaneHistoryRestore = history.controlplaneHistoryRestore;
pub const controlplaneHistoryRaw = history.controlplaneHistoryRaw;
pub const controlplaneBinHistoryRaw = history.controlplaneBinHistoryRaw;
pub const controlplaneHistoryPageText = history.controlplaneHistoryPageText;
pub const controlplaneBinHistoryPageText = history.controlplaneBinHistoryPageText;

pub const controlplaneFile = bytes.controlplaneFile;
pub const controlplaneBinFile = bytes.controlplaneBinFile;
pub const controlplaneThumbnail = bytes.controlplaneThumbnail;
pub const controlplaneTemplate = bytes.controlplaneTemplate;
pub const controlplanePageText = bytes.controlplanePageText;
pub const controlplanePageLinks = bytes.controlplanePageLinks;

pub const controlplaneSearchIndexManifest = search.controlplaneSearchIndexManifest;
pub const controlplaneSearchIndexStream = search.controlplaneSearchIndexStream;
pub const controlplaneDocumentText = search.controlplaneDocumentText;
pub const controlplaneEvents = search.controlplaneEvents;
