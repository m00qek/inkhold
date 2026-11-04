//! Backups a household can keep with the tools it already has: a folder of
//! plain files on a NAS share, a USB disk or a Dropbox folder. A separate
//! process from the server, run by hand or by cron; it never needs the server
//! stopped. Design and rules: DESIGN.md §2.6.
//!
//! Every snapshot is complete on its own. Blobs are content-addressed and
//! never change, so all snapshots share one `blobs/` store and each names the
//! blobs it needs in its manifest: restoring needs one snapshot and the store,
//! never a chain of earlier runs.

const std = @import("std");

pub const layout = @import("backup/layout.zig");
pub const manifest = @import("backup/manifest.zig");
pub const lock = @import("backup/lock.zig");
pub const pace = @import("backup/pace.zig");
pub const blob_copy = @import("backup/blob_copy.zig");
pub const place = @import("backup/place.zig");
pub const gzfile = @import("backup/gzfile.zig");
pub const status = @import("backup/status.zig");

// ---- create ----
const create_mod = @import("backup/create.zig");
pub const Paths = create_mod.Paths;
pub const CreateOptions = create_mod.Options;
pub const CreateReport = create_mod.Report;
pub const create = create_mod.create;

// ---- list ----
const list_mod = @import("backup/list.zig");
pub const Listing = list_mod.Listing;
pub const ListEntry = list_mod.Entry;
pub const StoreStats = list_mod.StoreStats;
pub const list = list_mod.list;
pub const storeStats = list_mod.storeStats;

// ---- verify ----
const verify_mod = @import("backup/verify.zig");
pub const VerifyOptions = verify_mod.Options;
pub const VerifyResult = verify_mod.Result;
pub const Verified = verify_mod.Verified;
pub const verify = verify_mod.verify;

// ---- prune ----
const prune_mod = @import("backup/prune.zig");
pub const PruneReport = prune_mod.Report;
pub const prune = prune_mod.prune;

// ---- restore ----
const restore_mod = @import("backup/restore.zig");
pub const RestoreOptions = restore_mod.Options;
pub const RestoreReport = restore_mod.Report;
pub const RestoreKey = restore_mod.Key;
pub const restore = restore_mod.restore;
pub const serverAnswers = restore_mod.serverAnswers;

test {
    _ = layout;
    _ = manifest;
    _ = lock;
    _ = pace;
    _ = blob_copy;
    _ = place;
    _ = create_mod;
    _ = list_mod;
    _ = gzfile;
    _ = status;
    _ = verify_mod;
    _ = prune_mod;
    _ = restore_mod;
    _ = @import("backup/restore_test.zig");
    _ = @import("backup/verify_test.zig");
    _ = @import("backup/prune_test.zig");
    _ = @import("backup/create_test.zig");
}
