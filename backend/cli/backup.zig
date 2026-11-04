//! The backup verbs: `backup create|list|verify|prune` and `restore`. The
//! mechanism is `services/backup.zig`; this file reads the config, picks the
//! defaults a person at a terminal or a cron job expects, and says what
//! happened in words. A summary goes to stdout, problems to stderr, and the
//! exit code is non-zero whenever something needs a person.

const std = @import("std");
const builtin = @import("builtin");
const config = @import("../config.zig");
const backup = @import("../services/backup.zig");
const sqlite = @import("../db/sqlite.zig");
const cli = @import("../cli.zig");
const Invocation = cli.Invocation;
const Style = cli.Style;
const exit_failed = cli.exit_failed;
const exit_ok = cli.exit_ok;
const Io = std.Io;
const Dir = Io.Dir;
const Writer = Io.Writer;

// ---- shared ----

/// The config, refusing an explicit `--config` that does not exist.
fn loadConfig(gpa: std.mem.Allocator, io: Io, inv: Invocation, err: *Writer, st: Style) !?config.Loaded {
    const path = inv.configPath();
    if (inv.config != null) {
        Dir.cwd().access(io, path, .{}) catch {
            try err.print("{s}No config file at:{s} {s}\nNothing was touched. Check the path, then try again.\n", .{ st.bold, st.reset, path });
            return null;
        };
    }
    return config.loadFileOrDefault(gpa, io, path) catch |e| {
        try err.print("Could not read the config at {s}: {t}\n", .{ path, e });
        return null;
    };
}

fn paths(cfg: config.Config) backup.Paths {
    return .{ .db_path = cfg.db_path, .data_dir = cfg.data_dir, .cred_key_path = cfg.cred_key_path };
}

/// Opens `<dir>`, which must exist (a missing one is usually an unmounted share).
fn openDir(io: Io, path: []const u8, err: *Writer, st: Style) !?Dir {
    return Dir.cwd().openDir(io, path, .{ .iterate = true }) catch |e| switch (e) {
        error.FileNotFound => {
            try missingDir(path, err, st);
            return null;
        },
        else => {
            try err.print("Could not open {s}: {t}\n", .{ path, e });
            return null;
        },
    };
}

fn missingDir(path: []const u8, err: *Writer, st: Style) !void {
    try err.print(
        \\{[b]s}No backup directory at:{[r]s} {[p]s}
        \\It must already exist. If it is a NAS share or a USB disk, is it mounted?
        \\Nothing was written.
        \\
    , .{ .b = st.bold, .r = st.reset, .p = path });
}

fn now(io: Io) i64 {
    return Io.Clock.real.now(io).toSeconds();
}

fn hostName(buf: *[std.posix.HOST_NAME_MAX]u8) []const u8 {
    return std.posix.gethostname(buf) catch "unknown";
}

fn pid() i64 {
    return if (builtin.os.tag == .linux) std.os.linux.getpid() else 0;
}

/// `112.1 MiB`, `4.0 KiB`, `512 B`.
fn size(w: *Writer, n: u64) !void {
    const units = [_][]const u8{ "KiB", "MiB", "GiB", "TiB" };
    if (n < 1024) return w.print("{d} B", .{n});
    var v: f64 = @floatFromInt(n);
    var u: usize = 0;
    v /= 1024;
    while (v >= 1024 and u + 1 < units.len) : (u += 1) v /= 1024;
    try w.print("{d:.1} {s}", .{ v, units[u] });
}

/// The directory as recorded: its real path when it exists, so `/backup` and
/// `/backup/` are one destination; as typed when it does not (an unmounted NAS).
fn dirKey(io: Io, path: []const u8, buf: *[Dir.max_path_bytes]u8) []const u8 {
    const n = Dir.cwd().realPathFile(io, path, buf) catch return std.mem.trimEnd(u8, path, "/");
    return buf[0..n];
}

/// Records a run for the admin notice (`backup/status.zig`). Best effort: a
/// database that cannot be reached changes nothing about the run's own result.
fn record(gpa: std.mem.Allocator, cfg: config.Config, err: *Writer, comptime f: anytype, args: anytype) void {
    const z = gpa.dupeSentinel(u8, cfg.db_path, 0) catch return;
    defer gpa.free(z);
    const db = sqlite.Db.openNoCreate(z, 256) catch return; // no install here: nothing to tell
    defer db.close();
    @call(.auto, f, .{db} ++ args) catch |e| {
        err.print("(could not record this run for the admin notice: {t})\n", .{e}) catch {};
    };
}

fn plural(n: u64, one: []const u8, many: []const u8) []const u8 {
    return if (n == 1) one else many;
}

// ---- backup create ----

pub fn create(gpa: std.mem.Allocator, io: Io, inv: Invocation, out: *Writer, err: *Writer, st: Style) !u8 {
    var loaded = (try loadConfig(gpa, io, inv, err, st)) orelse return exit_failed;
    defer loaded.deinit();
    const cfg = loaded.config;

    backup.pace.lowerPriority();
    var hbuf: [std.posix.HOST_NAME_MAX]u8 = undefined;
    var kbuf: [Dir.max_path_bytes]u8 = undefined;
    const key = dirKey(io, inv.backup_dir, &kbuf);
    const started = now(io);
    var report: backup.CreateReport = .{};
    backup.create(gpa, io, paths(cfg), inv.backup_dir, started, .{
        .keep = inv.flags.keep,
        .compress = !inv.flags.no_compress,
        .include_cred_key = inv.flags.include_cred_key,
        .rate = inv.flags.max_rate orelse backup.pace.default_rate,
        .host = hostName(&hbuf),
        .pid = pid(),
        .version = cli.version,
    }, &report) catch |e| {
        // The plain text is what the admin notice shows; the styled one is printed.
        var plain: Writer.Allocating = .init(gpa);
        defer plain.deinit();
        _ = createFailed(e, inv, cfg, &report, &plain.writer, Style.plain) catch {};
        record(gpa, cfg, err, backup.status.recordCreate, .{ key, started, backup.status.CreateResult{ .failed = plain.written() } });
        return createFailed(e, inv, cfg, &report, err, st);
    };
    record(gpa, cfg, err, backup.status.recordCreate, .{ key, started, backup.status.CreateResult{ .ok = .{
        .snapshot = &report.name,
        .blobs = report.blobs,
        .bytes = report.bytes,
    } } });

    try out.print("Snapshot {s}: {d} {s} (", .{ &report.name, report.blobs, plural(report.blobs, "file", "files") });
    try size(out, report.bytes);
    try out.print("), {d} new.\n", .{report.copied});
    const p = report.pruned;
    if (p.removed_snapshots > 0 or p.removed_blobs > 0) {
        try out.print("Removed {d} old {s} and {d} {s} no snapshot needs (", .{
            p.removed_snapshots, plural(p.removed_snapshots, "snapshot", "snapshots"),
            p.removed_blobs,     plural(p.removed_blobs, "file", "files"),
        });
        try size(out, p.freed_bytes);
        try out.writeAll(").\n");
    }
    if (report.same_filesystem) {
        try err.print(
            \\{[b]s}Warning:{[r]s} the backup is on the same disk as the live data. If that disk
            \\fails, the backup goes with it; a NAS share or another disk keeps it safe.
            \\
        , .{ .b = st.bold, .r = st.reset });
    }
    return exit_ok;
}

fn createFailed(e: anyerror, inv: Invocation, cfg: config.Config, r: *const backup.CreateReport, err: *Writer, st: Style) !u8 {
    switch (e) {
        error.BackupDirMissing => try missingDir(inv.backup_dir, err, st),
        error.InsideLiveData => try err.print(
            \\{[b]s}{[d]s} is inside the live data{[r]s} (beside {[db]s}).
            \\A backup there would back itself up, and dies with the same disk. Choose a
            \\directory elsewhere. Nothing was written.
            \\
        , .{ .b = st.bold, .r = st.reset, .d = inv.backup_dir, .db = cfg.db_path }),
        error.Locked => try err.print(
            \\{[b]s}Another backup is running on {[d]s}{[r]s} (pid {[pid]d} on {[host]s}).
            \\Try again when it finishes. A lock older than six hours is taken over.
            \\
        , .{ .b = st.bold, .r = st.reset, .d = inv.backup_dir, .pid = r.holder.pid, .host = r.holder.host() }),
        error.NoDatabase => try err.print("{s}No database at:{s} {s}\nNothing was written. Is --config pointing at this install?\n", .{ st.bold, st.reset, cfg.db_path }),
        error.NoBlobStore => try err.print("{s}No file store at:{s} {s}/blobs\nNothing was written. Is --config pointing at this install?\n", .{ st.bold, st.reset, cfg.data_dir }),
        error.NoCredKey => try err.print("{s}--include-cred-key, but there is no key at:{s} {s}\nNothing was written.\n", .{ st.bold, st.reset, cfg.cred_key_path }),
        error.SnapshotExists => try err.print("A snapshot named {s} already exists. Wait a second and run again.\n", .{&r.name}),
        error.BlobLost => try err.print(
            \\{[b]s}No snapshot was written.{[r]s} The database names file {[m]s}, but it is
            \\not in the file store, on every try. The server may have been cleaning up:
            \\run again. If this repeats, the live data is damaged.
            \\
        , .{ .b = st.bold, .r = st.reset, .m = &r.md5 }),
        error.SourceCorrupt => try err.print(
            \\{[b]s}No snapshot was written.{[r]s} File {[m]s} in the live store does not
            \\match its own checksum: the live data is damaged. The snapshots already in
            \\{[d]s} are untouched; restore one rather than back this up.
            \\
        , .{ .b = st.bold, .r = st.reset, .m = &r.md5, .d = inv.backup_dir }),
        error.BadManifest => try err.print(
            \\The snapshot was written, but nothing was pruned: the manifest of {[s]s}
            \\cannot be read to its end. Run `inkhold backup verify {[d]s}`.
            \\
        , .{ .s = if (r.pruned.bad) |*b| b[0..] else "?", .d = inv.backup_dir }),
        error.FileTooBig => try err.print("{s} refused a file larger than it can hold (FAT32 stops at 4 GB). Format the disk exFAT or ext4.\n", .{inv.backup_dir}),
        error.NoSpaceLeft => try err.print("{s} is full. Free space, or prune with --keep, and run again.\n", .{inv.backup_dir}),
        else => try err.print("Backup failed: {t}\n", .{e}),
    }
    return exit_failed;
}

// ---- backup list ----

pub fn list(gpa: std.mem.Allocator, io: Io, inv: Invocation, out: *Writer, err: *Writer, st: Style) !u8 {
    var dir = (try openDir(io, inv.backup_dir, err, st)) orelse return exit_failed;
    defer dir.close(io);
    var l = try backup.list(gpa, io, dir);
    defer l.deinit(gpa);

    if (l.entries.items.len == 0) {
        try out.print("No snapshots in {s} yet.\n", .{inv.backup_dir});
        return exit_ok;
    }
    try out.print("{s}Snapshots in {s}{s}, oldest first:\n\n", .{ st.bold, inv.backup_dir, st.reset });
    for (l.entries.items) |e| {
        try out.print("  {s}  ", .{&e.name});
        const h = e.header orelse {
            try out.print("{s}incomplete: no manifest{s}\n", .{ st.dim, st.reset });
            continue;
        };
        try out.print("{d:>6} {s}  ", .{ h.blobs, plural(h.blobs, "file ", "files") });
        try size(out, h.bytes);
        if (h.has_cred_key) try out.print("  {s}with cred.key{s}", .{ st.dim, st.reset });
        try out.writeAll("\n");
    }
    const stats = try backup.storeStats(io, dir);
    try out.print("\nShared file store: {d} {s}, ", .{ stats.blobs, plural(stats.blobs, "file", "files") });
    try size(out, stats.bytes);
    try out.writeAll(" on disk.\n");
    if (l.partials > 0 or stats.temps > 0) {
        try out.print("{s}An interrupted run left files behind; `inkhold backup prune` removes them.{s}\n", .{ st.dim, st.reset });
    }
    return exit_ok;
}

// ---- backup verify ----

pub fn verify(gpa: std.mem.Allocator, io: Io, inv: Invocation, out: *Writer, err: *Writer, st: Style) !u8 {
    var loaded = (try loadConfig(gpa, io, inv, err, st)) orelse return exit_failed;
    defer loaded.deinit();
    const cfg = loaded.config;
    var kbuf: [Dir.max_path_bytes]u8 = undefined;
    const key = dirKey(io, inv.backup_dir, &kbuf);
    const started = now(io);
    var dir = (try openDir(io, inv.backup_dir, err, st)) orelse {
        record(gpa, cfg, err, backup.status.recordVerify, .{ key, started, @as(?[]const u8, "No backup directory there: is it mounted?") });
        return exit_failed;
    };
    defer dir.close(io);
    backup.pace.lowerPriority();

    // `--deep` inflates a database to check it: beside the live data when there
    // is some, never inside the folder a sync client watches.
    const tmp = try verifyTmp(gpa, io, loaded.config, inv.backup_dir);
    defer gpa.free(tmp);
    var v = backup.verify(gpa, io, dir, inv.snapshot, .{
        .deep = inv.flags.deep,
        .rate = inv.flags.max_rate orelse backup.pace.default_rate,
        .tmp_dir = tmp,
    }) catch |e| switch (e) {
        error.NoSnapshots => {
            record(gpa, cfg, err, backup.status.recordVerify, .{ key, started, @as(?[]const u8, "No snapshots to verify.") });
            try err.print("No snapshots in {s} to verify.\n", .{inv.backup_dir});
            return exit_failed;
        },
        error.NoSuchSnapshot => {
            try err.print("No snapshot named {s} in {s}. `inkhold backup list {s}` shows them.\n", .{ inv.snapshot.?, inv.backup_dir, inv.backup_dir });
            return exit_failed;
        },
        else => return e,
    };
    defer v.deinit(gpa);

    for (v.results.items) |r| {
        if (r.ok()) {
            try out.print("  {s}  ok      {d} {s}\n", .{ &r.name, r.blobs, plural(r.blobs, "file", "files") });
            continue;
        }
        try out.print("  {s}  {s}FAILED{s} ", .{ &r.name, st.bold, st.reset });
        if (!r.manifest_ok) try out.writeAll(" manifest unreadable;");
        if (!r.db_ok) try out.writeAll(" database damaged;");
        if (r.missing > 0) try out.print(" {d} missing;", .{r.missing});
        if (r.corrupt > 0) try out.print(" {d} damaged;", .{r.corrupt});
        if (r.first_bad) |*m| try out.print(" first: {s}", .{m});
        try out.writeAll("\n");
    }
    if (inv.flags.deep) try out.print("\nRe-read {d} {s} in the shared store.\n", .{ v.hashed, plural(v.hashed, "file", "files") });
    // A verify of one named snapshot says nothing about the rest: not recorded.
    if (inv.snapshot == null) {
        var line_buf: [160]u8 = undefined;
        record(gpa, cfg, err, backup.status.recordVerify, .{ key, started, verifyFailure(&v, &line_buf) });
    }
    if (v.allOk()) return exit_ok;
    try err.print("\n{s}Some snapshots cannot be restored as they are.{s} Restore an older one that passed, and keep this backup's disk under watch.\n", .{ st.bold, st.reset });
    return exit_failed;
}

/// The first failing snapshot as one line, or null when all passed.
fn verifyFailure(v: *const backup.Verified, buf: []u8) ?[]const u8 {
    var bad: u32 = 0;
    var first: ?backup.VerifyResult = null;
    for (v.results.items) |r| if (!r.ok()) {
        bad += 1;
        if (first == null) first = r;
    };
    const r = first orelse return null;
    var w: Writer = .fixed(buf);
    w.print("{d} of {d} snapshots cannot be restored; {s}:", .{ bad, v.results.items.len, &r.name }) catch {};
    if (!r.manifest_ok) w.writeAll(" manifest unreadable;") catch {};
    if (!r.db_ok) w.writeAll(" database damaged;") catch {};
    if (r.missing > 0) w.print(" {d} missing;", .{r.missing}) catch {};
    if (r.corrupt > 0) w.print(" {d} damaged;", .{r.corrupt}) catch {};
    return std.mem.trimEnd(u8, w.buffered(), ";");
}

fn verifyTmp(gpa: std.mem.Allocator, io: Io, cfg: config.Config, backup_dir: []const u8) ![]u8 {
    if (Dir.cwd().access(io, cfg.data_dir, .{})) |_| {
        return std.fmt.allocPrint(gpa, "{s}/backup-verify-tmp", .{cfg.data_dir});
    } else |_| return std.fmt.allocPrint(gpa, "{s}/.verify-tmp", .{backup_dir});
}

// ---- backup prune ----

pub fn prune(gpa: std.mem.Allocator, io: Io, inv: Invocation, out: *Writer, err: *Writer, st: Style) !u8 {
    var dir = (try openDir(io, inv.backup_dir, err, st)) orelse return exit_failed;
    defer dir.close(io);
    backup.pace.lowerPriority();
    var hbuf: [std.posix.HOST_NAME_MAX]u8 = undefined;
    var r: backup.PruneReport = .{};
    backup.prune(gpa, io, dir, inv.flags.keep.?, now(io), hostName(&hbuf), pid(), &r) catch |e| switch (e) {
        error.Locked => {
            try err.print("Another backup is running on {s} (pid {d} on {s}). Try again when it finishes.\n", .{ inv.backup_dir, r.holder.pid, r.holder.host() });
            return exit_failed;
        },
        error.BadManifest => {
            try err.print("{s}Nothing was removed.{s} The manifest of {s} cannot be read to its end. Run `inkhold backup verify {s}`.\n", .{ st.bold, st.reset, if (r.bad) |*b| b[0..] else "?", inv.backup_dir });
            return exit_failed;
        },
        else => return e,
    };
    try out.print("Removed {d} {s} and {d} {s} no snapshot needs (", .{
        r.removed_snapshots, plural(r.removed_snapshots, "snapshot", "snapshots"),
        r.removed_blobs,     plural(r.removed_blobs, "file", "files"),
    });
    try size(out, r.freed_bytes);
    try out.writeAll(").\n");
    if (r.removed_partials > 0 or r.removed_temps > 0) try out.print("Cleared what {d} interrupted {s} left behind.\n", .{ r.removed_partials + r.removed_temps, plural(r.removed_partials + r.removed_temps, "run", "runs") });
    if (r.incomplete > 0) try out.print("{s}Left {d} incomplete {s} alone (no manifest); remove by hand once you are sure.{s}\n", .{ st.dim, r.incomplete, plural(r.incomplete, "snapshot", "snapshots"), st.reset });
    return exit_ok;
}

// ---- restore ----

pub fn restore(gpa: std.mem.Allocator, io: Io, inv: Invocation, out: *Writer, err: *Writer, st: Style) !u8 {
    var loaded = (try loadConfig(gpa, io, inv, err, st)) orelse return exit_failed;
    defer loaded.deinit();
    const cfg = loaded.config;

    if (backup.serverAnswers(io, cfg.host, cfg.port)) {
        try err.print(
            \\{[b]s}Something answers on {[h]s}:{[p]d}.{[r]s} Stop the server before restoring;
            \\nothing was touched.
            \\
        , .{ .b = st.bold, .r = st.reset, .h = cfg.host, .p = cfg.port });
        return exit_failed;
    }
    var dir = (try openDir(io, inv.backup_dir, err, st)) orelse return exit_failed;
    defer dir.close(io);

    var r: backup.RestoreReport = .{};
    defer r.deinit(gpa);
    backup.restore(gpa, io, paths(cfg), dir, .{
        .snapshot = inv.snapshot,
        .rate = inv.flags.max_rate orelse 0,
    }, &r) catch |e| return restoreFailed(e, inv, cfg, &r, err, st);

    try out.print("{s}Restored {s}:{s} {d} {s}, ", .{ st.bold, &r.name, st.reset, r.blobs, plural(r.blobs, "file", "files") });
    try size(out, r.bytes);
    try out.writeAll(".\n\n");
    switch (r.key) {
        .from_backup => try out.writeAll("The credential key came with the backup; every password still works.\n"),
        .kept_existing => try out.print("The credential key already at {s} opens these accounts; every password still works.\n", .{cfg.cred_key_path}),
        .generated => {
            try out.print(
                \\{[b]s}No credential key came with this backup{[r]s}, so a new one was made and
                \\every account has a temporary password. Shown once, not stored anywhere:
                \\
                \\
            , .{ .b = st.bold, .r = st.reset });
            var width: usize = 0;
            for (r.resets.items) |x| width = @max(width, x.email.len);
            // Unstyled: an escape code surviving a copy makes a password wrong.
            for (r.resets.items) |x| {
                try out.print("    {s}", .{x.email});
                try out.splatByteAll(' ', width - x.email.len + 4);
                try out.print("{s}\n", .{x.temp.slice()});
            }
            try out.writeAll("\nEach must be changed at the next sign-in.\n");
        },
    }
    try out.print(
        \\
        \\{[b]s}Every tablet was signed out.{[r]s} Before one signs in again, back it up:
        \\it last synced with a newer server than this snapshot, and may delete files
        \\it holds that the snapshot does not have.
        \\
        \\Start the server when ready: inkhold serve
        \\
    , .{ .b = st.bold, .r = st.reset });
    return exit_ok;
}

fn restoreFailed(e: anyerror, inv: Invocation, cfg: config.Config, r: *const backup.RestoreReport, err: *Writer, st: Style) !u8 {
    switch (e) {
        error.TargetNotEmpty => try err.print(
            \\{[b]s}A database already exists at {[db]s}.{[r]s}
            \\restore never writes over one. To replace it, stop the server and move that
            \\file (and its -wal) away first. Nothing was touched.
            \\
        , .{ .b = st.bold, .r = st.reset, .db = cfg.db_path }),
        error.NoSnapshots => try err.print("No complete snapshot in {s} to restore.\n", .{inv.backup_dir}),
        error.NoSuchSnapshot => try err.print("No snapshot named {s} in {s}. `inkhold backup list {s}` shows them.\n", .{ inv.snapshot orelse "?", inv.backup_dir, inv.backup_dir }),
        error.SnapshotDamaged => {
            const d = r.damage.?;
            try err.print("{s}Snapshot {s} cannot be restored as it is:{s}", .{ st.bold, &r.name, st.reset });
            if (!d.manifest_ok) try err.writeAll(" manifest unreadable;");
            if (!d.db_ok) try err.writeAll(" database damaged;");
            if (d.missing > 0) try err.print(" {d} files missing;", .{d.missing});
            try err.print("\nNothing was written. Try an older snapshot: inkhold restore {s} <snapshot>\n", .{inv.backup_dir});
        },
        error.NewerSchema => try err.print("Snapshot {s} comes from a newer Inkhold than this one ({s}). Restore it with that version or later.\n", .{ &r.name, cli.version }),
        error.CredKeyConflict => try err.print(
            \\{[b]s}The backup carries a credential key, and {[k]s} holds a different one.{[r]s}
            \\Move that file away if it belongs to another install, then run again.
            \\
        , .{ .b = st.bold, .r = st.reset, .k = cfg.cred_key_path }),
        error.CredKeyMismatch => try err.print(
            \\{[b]s}The credential key at {[k]s} cannot open the accounts in this backup.{[r]s}
            \\If it is not the key this backup was made with, move it away and run again:
            \\every account then gets a temporary password. Nothing was written.
            \\
        , .{ .b = st.bold, .r = st.reset, .k = cfg.cred_key_path }),
        else => try err.print("Restore failed: {t}. Nothing was put in place at {s}.\n", .{ e, cfg.db_path }),
    }
    return exit_failed;
}

test {
    _ = @import("backup_test.zig");
}
