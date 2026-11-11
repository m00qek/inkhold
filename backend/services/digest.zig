//! The tablet's Digest app (schema v23): digests and their categories, stored
//! exactly as the app sends them. The app decides every merge from the md5s
//! it compares (decompiled `KnowledgeSyncRepository.processKnowledgeHash`);
//! the server keeps what it was given, assigns ids and lists it back.
//!
//! The rule everything here serves: the app DELETES a synced digest whose id
//! the manifest lacks, and an empty manifest deletes all of them. So the
//! manifest and the category list are always complete, never paged, never
//! filtered beyond "live"; ids are never reused (AUTOINCREMENT), so a stale id
//! on a tablet can never name a different digest; and a delete of something
//! already gone succeeds.
//!
//! A category is a row with `is_group`; a digest names its category by the
//! category's `uid` in `parent_uid`, and '' is the app's built-in
//! Uncategorized, which is never a row. Deleting a category deletes its
//! digests, as the official server and the app's guide both do.

const std = @import("std");
const sqlite = @import("../db/sqlite.zig");
const digests_part = @import("digest/digests.zig");
const categories_part = @import("digest/categories.zig");
const listings_part = @import("digest/listings.zig");
const tags_part = @import("digest/tags.zig");
const web_edit_part = @import("digest/web_edit.zig");
const retention_part = @import("digest/retention.zig");

pub const Error = sqlite.Error || std.mem.Allocator.Error;

/// The app's own limits are 15 000 characters of content, 2 000 of comment
/// and 150 of category name (`KnowledgeFieldNameConstants`). The server's caps
/// sit well above them: a refused add would abort the app's whole sync, so
/// they only keep out what no tablet sends.
pub const max_content_bytes = 15_000 * 4 * 4;
pub const max_comment_bytes = 2_000 * 4 * 4;
pub const max_field_bytes = 64 * 1024;

/// A digest or a category, as the app sends and reads it (`SummaryDO`).
pub const Digest = struct {
    id: u64 = 0,
    is_group: bool = false,
    /// A category's `uniqueIdentifier`; for a digest, the
    /// `unique_identifier` inside its metadata (null when it has none).
    uid: ?[]const u8 = null,
    /// The category's uid; '' is Uncategorized.
    parent_uid: []const u8 = "",
    name: ?[]const u8 = null,
    description: ?[]const u8 = null,
    content: ?[]const u8 = null,
    source_path: ?[]const u8 = null,
    source_type: ?i64 = null,
    data_source: ?[]const u8 = null,
    author: ?[]const u8 = null,
    tags: ?[]const u8 = null,
    /// JSON text, kept byte for byte.
    metadata: ?[]const u8 = null,
    comment_str: ?[]const u8 = null,
    comment_handwrite_name: ?[]const u8 = null,
    handwrite_inner_name: ?[]const u8 = null,
    handwrite_md5: ?[]const u8 = null,
    md5_hash: []const u8 = "",
    creation_time: i64 = 0,
    last_modified_time: i64 = 0,
    /// Server times, ms: the official `createTime`/`updateTime`.
    created_at: i64 = 0,
    updated_at: i64 = 0,
};

/// One row of the manifest (`SummaryInfoVO`).
pub const HashRow = struct {
    id: u64,
    md5_hash: []const u8,
    handwrite_md5: ?[]const u8,
    comment_handwrite_name: ?[]const u8,
    last_modified_time: i64,
};

pub const Tag = struct {
    id: u64,
    name: []const u8,
    created_at: i64,
};

/// A digest's handwritten note as the server holds it. `inner_name` is set
/// only when the server took a reference to the note's blob (a claimed
/// upload): only then is there something to release or serve.
pub const Handwriting = struct { md5: ?[]const u8, inner_name: ?[]const u8 };

/// What the browser may change in a digest: its typed comment and its
/// category. Absent fields stay as they are.
pub const WebEdit = struct {
    comment: ?[]const u8 = null,
    /// A category's uid, '' for Uncategorized; the caller checks it is live.
    parent_uid: ?[]const u8 = null,
};

// ---- digests (`digest/digests.zig`) ----

pub const uidOfMetadata = digests_part.uidOfMetadata;
pub const addDigest = digests_part.addDigest;
pub const putDigest = digests_part.putDigest;
pub const deleteDigest = digests_part.deleteDigest;
pub const handwriting = digests_part.handwriting;
pub const liveDigestId = digests_part.liveDigestId;

// ---- categories (`digest/categories.zig`) ----

pub const addGroup = categories_part.addGroup;
pub const putGroup = categories_part.putGroup;
pub const deleteGroup = categories_part.deleteGroup;
pub const categoryExists = categories_part.categoryExists;

// ---- listings (`digest/listings.zig`) ----

pub const manifest = listings_part.manifest;
pub const groups = listings_part.groups;
pub const digestsByIds = listings_part.digestsByIds;
pub const digestsPage = listings_part.digestsPage;
pub const digestCount = listings_part.digestCount;

// ---- tags (`digest/tags.zig`) ----

pub const addTag = tags_part.addTag;
pub const renameTag = tags_part.renameTag;
pub const deleteTag = tags_part.deleteTag;
pub const tags = tags_part.tags;

// ---- the browser's edit, and what a tablet has fetched (`digest/web_edit.zig`) ----

pub const applyWebEdit = web_edit_part.applyWebEdit;
pub const markTabletListed = web_edit_part.markTabletListed;
pub const tabletListedAt = web_edit_part.tabletListedAt;
pub const changedSince = web_edit_part.changedSince;

// ---- retention (`digest/retention.zig`) ----

pub const purgeDeleted = retention_part.purgeDeleted;

test {
    _ = @import("digest/digests_test.zig");
    _ = @import("digest/listings_test.zig");
    _ = @import("digest/categories_test.zig");
    _ = @import("digest/tags_test.zig");
    _ = @import("digest/web_edit_test.zig");
}
