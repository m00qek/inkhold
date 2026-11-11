//! What the `digest` tests share: an in-memory database with two accounts, and the Nomad's digest.

const std = @import("std");
const sqlite = @import("../../db/sqlite.zig");
const schema = @import("../../db/schema.zig");
const digest = @import("../digest.zig");
const Digest = digest.Digest;
const uidOfMetadata = digest.uidOfMetadata;

pub fn testDb() !sqlite.Db {
    var db = try sqlite.Db.openMemory();
    errdefer db.close();
    try schema.migrate(db);
    try db.exec("INSERT INTO users (id, email, password_md5, created_at) VALUES (1, 'ana', '', 0), (2, 'rui', '', 0);");
    return db;
}

/// The digest the Nomad made on 2026-11-08 (read from the app's log): a
/// highlight in a PDF, Uncategorized, with a typed and a handwritten note.
pub const nomad_metadata =
    \\{"document_location_data":"[{\"chapter\":0,\"endPosition\":50,\"page\":0,\"startPosition\":26}]","source_size":407277,"unique_identifier":"c1ad0a49d44c62dc94b8f71448b3da5a","author":"john"}
;

pub fn nomadDigest(a: std.mem.Allocator) Digest {
    return .{
        .uid = uidOfMetadata(a, nomad_metadata),
        .content = "La phonétique du français",
        .source_path = "MyStyle/Français/La_phonetique_du_francais_Prof_Flavio_Adler.pdf",
        .source_type = 1,
        .metadata = nomad_metadata,
        .comment_str = "yeah",
        .comment_handwrite_name = "6003a8c1725a175c14868baedd7133a1.mark",
        .handwrite_md5 = "245354713d4c121a2368d9295f6379ca",
        .md5_hash = "187a8bd48f89d12a78b3198a166d494a",
        .creation_time = 1794175867249,
        .last_modified_time = 1794176056052,
    };
}
