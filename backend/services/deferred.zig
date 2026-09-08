//! Post-upload processing, off the connection and one file at a time.
//!
//! ## Why this exists
//!
//! Indexing ran ON THE UPLOAD PATH (`files.zig`, reached identically by web
//! upload and device sync). It is outside the transaction, but the client holds
//! the connection through all of it, and it scales with the file:
//!
//! | case | Ryzen (release) | Pi 1 B+ (x40-50) |
//! |---|---:|---:|
//! | 5 MB `.txt` | 372 ms | **15-19 s** |
//! | 16 MB `.txt` (`max_file_bytes`) | ~1.2 s | **48-60 s** |
//!
//! A minute of held connection for a file the user is allowed to upload today.
//! This is a repair for shipped behaviour, not groundwork; it was measured first.
//!
//!
//! ## The job store is a QUERY, not a queue
//!
//! Nothing is enqueued. Outstanding work is DERIVABLE — a tenant names the
//! blobs it still owes work on, in SQL. That removes a second source of truth
//! that could disagree with the first, and it buys, for free:
//!
//!   - **restart safety** — nothing to persist, nothing to replay
//!   - **idempotence** — every tenant's write is an upsert
//!   - **live priority** — the ordering is re-evaluated every iteration, so a
//!     note arriving during a long job is taken next; a queue frozen at enqueue
//!     time could not do that
//!
//! It also matches the self-healing posture the index paths already have
//! (`ensureIndexed`): no backfill migration is ever required.
//!
//! ## One worker IS the serialization
//!
//! "If there is no queue, what serializes?" — a queue never serialized
//! anything. A queue with ten consumers is not serialized; one consumer with no
//! queue is. The serializer is the single worker, so there is no claiming, no
//! lease, no `status` column: those exist to stop two workers taking the same
//! row, and there is one worker, in one process, against one SQLite file.
//!
//! **This is also the memory story.** Before this, N concurrent uploads meant N
//! concurrent derives; peak RSS scaled with how many people hit save at once.
//! Now it is one file's cost, whatever the traffic — which is what has to be
//! true for the 50 MB budget on a Pi to hold once bigger formats arrive.
//!
//! ## Adding a tenant
//!
//! Write a `Tenant` and add it to `tenants`. The contract is the whole
//! interface: `pending_sql` says what is outstanding, `run` does one blob's
//! work. Nothing else in here knows what a `.txt` is.

const std = @import("std");
const sqlite = @import("../db/sqlite.zig");
const blobstore = @import("../store/blobs.zig");
const derivedstore = @import("../store/derived.zig");
const derivesearch = @import("derive_search.zig");
const txtindex = @import("txt_index.zig");
const noteindex = @import("note_index.zig");
const pdfindex = @import("pdf_index.zig");
const pdftext = @import("pdf_text.zig");
const pdfprobe = @import("../pdf/probe.zig");
const pdftextpass = @import("../pdf/text.zig");

const log = std.log.scoped(.deferred);

/// How long the worker sleeps when it finds nothing to do.
///
/// THE BACKSTOP, and it is why startup needs no special case: work left behind
/// by a restart, or created by a path that forgot to signal, is found by the
/// next tick rather than waiting for the next upload. Same belt-and-braces
/// reasoning as `startupSweeps`.
pub const idle_tick_ns: u64 = 30 * std.time.ns_per_s;

/// One kind of post-upload work.
///
/// A tenant is two things: a QUESTION (`pending_sql` — what do I still owe?)
/// and an ANSWER (`run` — do one blob's worth). The worker owns the thread, the
/// ordering and the lock discipline; a tenant owns its own format entirely.
pub const Tenant = struct {
    /// For logs. Not an identifier — the SQL and the function are.
    name: []const u8,

    /// Lower runs first. Ties break on blob size ascending (shortest-job-first),
    /// so fifty small files produce fifty quick wins rather than queueing behind
    /// one enormous one.
    priority: u8,

    /// THE PREDICATE: a bare FROM/WHERE naming the blobs this tenant still owes
    /// work on, with `files` aliased `f`, `blobs` aliased `b` and `note_index`
    /// aliased `ni`. It MUST exclude work already done, or the worker spins on
    /// the same blob for ever.
    ///
    /// Bound parameter 1 is the note index version, because every current
    /// tenant's "is it current" question is asked against it.
    ///
    /// **A clause rather than a statement, because there are two readers of it.**
    /// This file takes the next job out of it (`discovery` below, `LIMIT 1`);
    /// `pending.zig` COUNTS over it to tell a user how many of their documents
    /// are still being indexed. Pending-ness is not a second fact about the
    /// worker — it IS the worker's own question, asked with a different verb —
    /// and a hand-written second copy of the clause is precisely how the count
    /// and the worker would come to disagree. A count that says "nothing
    /// pending" while a derive is running is worse than no count at all.
    ///
    /// A reader may only ADD a bound to it (`AND f.user_id = ?`, `AND f.md5 = ?`)
    /// — never narrow or restate what is already there.
    from_where: []const u8,

    /// The next outstanding blob for this tenant, as `(md5, name, size)` — built
    /// from `from_where` by `discovery`, never written out by hand.
    pending_sql: []const u8,

    /// Do one blob's work. Called WITHOUT the DB lock held: the tenant takes it
    /// itself, around its own transaction, after the expensive part is done.
    /// That is the rule this whole file exists to enforce — parse off the lock,
    /// write under it.
    ///
    /// Errors are logged and the blob is left outstanding; the discovery query
    /// will offer it again. A tenant that can never succeed on a given blob
    /// must record that fact itself (the way `txt_index` writes a marker row
    /// for an over-cap file), or it will be retried for ever.
    run: *const fn (Job) anyerror!void,
};

/// One unit of work, plus everything the tenant needs to do it.
pub const Job = struct {
    gpa: std.mem.Allocator,
    db: sqlite.Db,
    blobs: blobstore.BlobStore,
    /// Held for the tenant's write transaction, released immediately after.
    lock: *std.Io.Mutex,
    io: std.Io,
    /// 32 lowercase hex.
    md5: []const u8,
    /// A name the blob is known by. Any holder's name will do — the extension
    /// is the whole gate, and a blob's holders cannot disagree about it.
    name: []const u8,
    // (A `now` used to ride here, threaded into every band mint so a partition's
    // `created_at` and a job's clock agreed. `golden-search.md` §6 step 8 deleted
    // the partitions; nothing a tenant writes is timestamped any more.)
    /// The two derived stores (`golden-search.md` §2.1), or null where this
    /// deployment keeps none — every test that does not wire them, and
    /// `drainNow`. Null means "do not write them", never an error.
    terms: ?derivedstore.DerivedStore = null,
    text: ?derivedstore.DerivedStore = null,

    /// Is this blob's `.txt` work still outstanding, asked under the lock?
    ///
    /// The discovery query already said yes, but it said so before the derive,
    /// and an upload can heal the same blob in between. Cheap — two indexed
    /// single-row selects — and it is what keeps a duplicate derive from
    /// becoming a duplicate write.
    fn check(self: Job) !bool {
        self.lock.lockUncancelable(self.io);
        defer self.lock.unlock(self.io);
        if (!try noteindex.isCurrent(self.db, self.md5)) return false;
        return txtindex.needsDerive(self.db, self.md5);
    }

    /// The same question for the `.pdf` tenant.
    fn pdfNeedsProbe(self: Job) !bool {
        self.lock.lockUncancelable(self.io);
        defer self.lock.unlock(self.io);
        return pdfindex.needsProbe(self.db, self.md5);
    }

    /// And its second question — the text pass.
    fn pdfNeedsText(self: Job) !bool {
        self.lock.lockUncancelable(self.io);
        defer self.lock.unlock(self.io);
        return pdftext.needsText(self.db, self.md5);
    }
};

/// A tenant's predicate turned into the statement the worker runs: the next
/// outstanding blob, smallest first.
///
/// SHORTEST-JOB-FIRST is the `ORDER BY`, and it is this file's business rather
/// than the tenant's — fifty small files produce fifty quick wins instead of
/// queueing behind one enormous one. The tenant supplies WHICH blobs are
/// outstanding and nothing about the order they are taken in.
fn discovery(comptime from_where: []const u8) []const u8 {
    return "SELECT f.md5, f.name, b.size\n" ++ from_where ++
        \\
        \\ ORDER BY b.size ASC
        \\ LIMIT 1;
    ;
}

/// `.txt` paragraph segments (`txt_index.zig`) — the first tenant.
///
/// The predicate lives in `txt_index.pending_from_where`, beside
/// `txtindex.needsDerive`, whose memo it mirrors — and the two are asserted to
/// agree in this file's tests. It is a second expression of the same question,
/// which is a cost; the alternative is a worker that cannot tell finished work
/// from outstanding work without calling into every tenant, which is worse.
const txt_tenant: Tenant = .{
    .name = "txt",
    .priority = 1,
    .from_where = txtindex.pending_from_where,
    .pending_sql = discovery(txtindex.pending_from_where),
    .run = runTxt,
};

fn runTxt(job: Job) anyerror!void {
    // THE THREE-STEP SHAPE EVERY TENANT FOLLOWS, and the reason the lock is
    // passed in rather than taken around the whole call: the middle step is the
    // expensive one and it must not hold the connection.
    //
    // `txt_index` itself stays lock-agnostic — it knows about paragraphs, not
    // about threading — so the discipline lives here, where the threading does.
    //
    // **STEP 3 USED TO BE A CHUNKED WRITE.** A 1,703-segment document written in
    // one transaction held the global `db_lock` 137 ms on the dev box and 13.9 s
    // on the Pi, so the paragraph rows were written reserve / chunk / finish,
    // one transaction per chunk. `golden-search.md` §6 step 8 deleted those rows
    // and every one of those transactions with them: what this tenant writes to
    // the database now is ONE verdict, and §8.5's 98.1 s of held lock per
    // whole-library ingest is what that removes.

    // 1. Re-check under the lock. The discovery query said so a moment ago, but
    //    an upload may have healed it since; `needsDerive` is the authority.
    if (!try job.check()) return;

    // 2. Derive OFF the lock. Ranged reads and chunking, the part that scales
    //    with the file and the whole reason this is not on the upload path.
    var d = (try txtindex.deriveStored(job.gpa, job.blobs, job.md5)) orelse return;
    defer d.deinit();

    // 2b. The two derived FILES, still off the lock — §2.5's *"a file write is
    //     not in a transaction at all"*. They are now the ONLY output of this
    //     pass a reader ever sees, but a failure is still logged rather than
    //     fatal: they are regenerable from the blob, and `reconcileDerived`
    //     finds a document whose files are missing by asking the DISK.
    //
    //     It can be off the lock BECAUSE THE FOLD DOES NOT TOUCH THIS DATABASE.
    //     `temp.token_fold` is a contentless scratch FTS5 table, so folding runs
    //     on a private in-memory connection and the shared one is not involved.
    //     Doing it on `job.db` would have meant holding the global write lock
    //     for the whole compression pass.
    //
    //     BEFORE the verdict, and that ordering is the point — §2.4 makes the
    //     FILE the fact that a document is derived. Write it after and a crash
    //     in between leaves a blob the discovery query will never offer again
    //     and a file nothing will ever write.
    writeTxtFiles(job, d) catch |e| {
        log.warn("derived files failed for {s}: {t}", .{ job.md5, e });
    };

    // 3. The verdict, under the lock, in one transaction. Re-asked first because
    //    the derive above ran without the lock, so an ingest — or a second pass
    //    of this worker — may have answered the same question about the same blob
    //    meanwhile. (It also arbitrated against the listing path's lazy heal,
    //    `txt_index.ensureIndexed`, until that was removed for writing this
    //    verdict WITHOUT the files it stands for.) Every early return above
    //    leaves the blob outstanding, which is safe: a re-run derives it again.
    job.lock.lockUncancelable(job.io);
    defer job.lock.unlock(job.io);
    if (!try txtindex.needsDerive(job.db, job.md5)) return;
    try job.db.exec("BEGIN IMMEDIATE;");
    errdefer job.db.exec("ROLLBACK;") catch {};
    try txtindex.storeVerdict(job.db, job.md5, txtindex.verdictFor(d));
    try job.db.exec("COMMIT;");
}

/// `terms/<md5>.<v>` and `text/<md5>.<v>` for one `.txt`. All of the work is in
/// `derive_search.writeDerived` and `txt_index.Pages`; what is left here is the
/// decision that this tenant writes them at all.
fn writeTxtFiles(job: Job, d: txtindex.Derived) !void {
    const terms_store = job.terms orelse return;
    const text_store = job.text orelse return;
    var src = txtindex.Pages.init(d);
    try derivesearch.writeDerived(
        job.gpa,
        terms_store,
        text_store,
        job.md5,
        @intCast(txtindex.rowCount(d)),
        &src,
    );
}

/// A `.pdf`'s shape (`pdf_index.zig`) and then its TEXT (`pdf_text.zig`) — page
/// count, the page-1 box, whether the file opens at all, and what it says.
///
/// AFTER `.txt` on purpose, and now for a second reason as well. A note or a
/// text file is what somebody just synced and is about to look for; a PDF's tile
/// shape can wait a beat. The costs run the same way round: probing a
/// 1,703-page document is 13.2 MB and walks its page tree, and the text pass
/// behind it is ~2 minutes on the deployment target — the biggest and least
/// urgent job this worker has.
///
/// ONE tenant asking two questions, not two tenants — see
/// `pdf_index.pending_from_where` for why the forward-progress guard makes that
/// the only shape that works.
const pdf_tenant: Tenant = .{
    .name = "pdf",
    .priority = 2,
    .from_where = pdfindex.pending_from_where,
    .pending_sql = discovery(pdfindex.pending_from_where),
    .run = runPdf,
};

fn runPdf(job: Job) anyerror!void {
    try runPdfProbe(job);
    try runPdfText(job);
}

fn runPdfProbe(job: Job) anyerror!void {
    // 1. Ask under the lock. The discovery query said so, but an upload or a
    //    heal may have answered it since.
    if (!try job.pdfNeedsProbe()) return;

    // 2. Probe OFF the lock — MuPDF walking the page tree, which is the part
    //    that scales with the document and must not hold the connection.
    const file = job.blobs.open(job.md5) catch return; // blob gone: nothing to record
    defer file.close(job.io);
    const shape: ?pdfprobe.Shape = pdfprobe.probeFile(file) catch |e| blk: {
        const v = pdfindex.Verdict.of(e) orelse return; // transient — try again later
        // A VERDICT IS A RESULT, not an error: recorded so this file is never
        // probed again. Left unrecorded, the discovery query would hand back the
        // same broken PDF for ever.
        job.lock.lockUncancelable(job.io);
        defer job.lock.unlock(job.io);
        try job.db.exec("BEGIN IMMEDIATE;");
        errdefer job.db.exec("ROLLBACK;") catch {};
        try pdfindex.storeVerdict(job.db, job.md5, v);
        try job.db.exec("COMMIT;");
        break :blk null;
    };

    // 3. Write under the lock, in one transaction.
    if (shape) |sh| {
        job.lock.lockUncancelable(job.io);
        defer job.lock.unlock(job.io);
        if (!try pdfindex.needsProbe(job.db, job.md5)) return; // raced while probing
        try job.db.exec("BEGIN IMMEDIATE;");
        errdefer job.db.exec("ROLLBACK;") catch {};
        try pdfindex.store(job.db, job.md5, sh);
        try job.db.exec("COMMIT;");
    }
}

/// The PDF text pass — the tenant's second question, and back inside the
/// three-step shape.
///
/// **IT USED TO BE THE EXCEPTION, AND `golden-search.md` §6 step 8 ENDED THAT.**
/// A 1,450-page PDF's `kind = 2` rows written in one transaction held the global
/// `db_lock` for 13.9-24.4 s (`mupdf.md` §9.8), so the row write was CHUNKED —
/// extract off the lock, commit under it, around a band of masked rowids
/// reserved up front — and the derived files were a SECOND MuPDF walk of the
/// same book, ~0.10 s/page on the target, accepted because the two consumers
/// could not share one pull loop. Step 8 deleted the rows, the bands and the
/// chunked write, and with them the second walk: what is left is one extraction,
/// straight into `derive_search.writeDerived`, and one transaction for the
/// verdict.
///
/// **Every early return leaves the blob outstanding**, which is safe because the
/// whole pass is simply redone: `pdf_text` is still NULL, so the discovery query
/// offers the blob again.
fn runPdfText(job: Job) anyerror!void {
    // 1. Ask under the lock, as every tenant does.
    if (!try job.pdfNeedsText()) return;

    // 2. Open OFF the lock. Everything expensive is on this side of it.
    const file = job.blobs.open(job.md5) catch return; // blob gone: nothing to record
    defer file.close(job.io);
    var ex = pdftextpass.Extractor.open(file) catch |e| {
        const v = pdftext.Verdict.of(e) orelse return; // transient — try again later
        // The probe already said this file opens. If the text pass disagrees,
        // that is a verdict about the file: unrecorded, the discovery query
        // would hand back the same document for ever.
        job.lock.lockUncancelable(job.io);
        defer job.lock.unlock(job.io);
        try job.db.exec("BEGIN IMMEDIATE;");
        errdefer job.db.exec("ROLLBACK;") catch {};
        try pdftext.storeVerdict(job.db, job.md5, v);
        try job.db.exec("COMMIT;");
        return;
    };
    defer ex.close();

    const doc_pages = ex.pages;
    // `nextChunk` is the sole authority on where the walk stops
    // (`min(pages, max_pages)`); this is the same arithmetic, for the verdict.
    const to_index = @min(doc_pages, pdftext.max_pages);

    // 2b. THE WALK, off the lock: one page at a time out of MuPDF and straight
    //     into the two derived files. Failure is logged, never fatal — the files
    //     are regenerable and `reconcileDerived` asks the DISK for them.
    //
    //     BEFORE the verdict, and that ordering is the point. §2.4 makes the
    //     FILE the fact that a document is derived; write it after the verdict
    //     and a crash in between leaves a blob the discovery query will never
    //     offer again and a file nothing will ever write.
    var src = pdftext.Pages.init(job.gpa, &ex);
    defer src.deinit();
    writePdfFiles(job, &src, doc_pages) catch |e| {
        log.warn("derived files failed for {s}: {t}", .{ job.md5, e });
    };
    // The verdict has to know whether ANY page had text, and that is a fact
    // about the walk. Two cases reach here without one: a deployment with no
    // derived stores (`writePdfFiles` returns before touching the source), and a
    // failure part-way. Draining finishes the walk in both, and costs nothing
    // when `writeDerived` already exhausted it.
    while (try src.next()) |_| {}

    // 3. The verdict, under the lock, in one transaction. Re-asked first, as
    //    every tenant step is: the walk above ran without the lock, and a heal or
    //    an upload can answer the same question about the same blob in between.
    job.lock.lockUncancelable(job.io);
    defer job.lock.unlock(job.io);
    if (!try pdftext.needsText(job.db, job.md5)) return;
    try job.db.exec("BEGIN IMMEDIATE;");
    errdefer job.db.exec("ROLLBACK;") catch {};
    try pdftext.finish(job.db, job.md5, to_index, pdftext.verdictFor(doc_pages, to_index, src.any_text));
    try job.db.exec("COMMIT;");
}

/// `terms/<md5>.<v>` and `text/<md5>.<v>` for one `.pdf`.
///
/// The page source is the CALLER'S, and that is the change §6 step 8 made here.
///
/// This used to own the source and walk the extractor a SECOND time — ~0.10
/// s/page on the deployment target, taking the 1,703-page harshest subject on
/// record from ~2 minutes to ~4. It was accepted rather than overlooked: the
/// chunked `kind = 2` write and `writeDerived` are both PULL loops, and fusing
/// them meant either inverting `writeDerived` into a callback (exactly the shape
/// §2.2's per-page record removed) or putting `job.db`, the lock and the
/// reserved bands inside a format-blind page source. Step 8 deleted the other
/// loop, so the source moved out to the caller and the second extraction is
/// simply gone.
///
/// **A SCAN needs no special case any more.** Its source yields nothing, and
/// `writeDerived` over an empty source writes exactly the header-only pair the
/// old `NoPages` shortcut wrote by hand — the right artifact, not an omission:
/// §2.4 makes the file's existence the fact that the document is derived, and a
/// scan genuinely is.
fn writePdfFiles(job: Job, src: *pdftext.Pages, doc_pages: u32) !void {
    const terms_store = job.terms orelse return;
    const text_store = job.text orelse return;
    try derivesearch.writeDerived(job.gpa, terms_store, text_store, job.md5, doc_pages, src);
}

/// Every tenant, in one named place so the SET of them can be tested rather
/// than only the individual tenants — the same reason `startupSweeps` exists.
/// A sweep that nothing calls is a sweep that silently never runs.
pub const tenants = [_]Tenant{ txt_tenant, pdf_tenant };

// ---------------------------------------------------------------------------
// Reconcile — the backfill the tenant predicates structurally cannot do
// ---------------------------------------------------------------------------

/// `terms/<md5>.<v>` and `text/<md5>.<v>` for one `.note`, the reconcile twin of
/// `files.writeNoteDerived`. The `.note` format has no tenant of its own: it
/// derives inside the upload path (§2.4), so this is the ONLY code that can give
/// a note that predates the feature its files.
///
/// `!p.indexable` returns rather than writing header-only files, and that is
/// deliberate agreement with the ingest side: a blob the note parser rejects is
/// not a note at all, whatever it is called, and the two callers must not
/// disagree about what a `.note` artifact is.
fn writeNoteFiles(job: Job, p: *const noteindex.Parsed) !void {
    if (!p.indexable) return;
    const terms_store = job.terms orelse return;
    const text_store = job.text orelse return;
    var src = noteindex.Pages.init(p);
    try derivesearch.writeDerived(
        job.gpa,
        terms_store,
        text_store,
        job.md5,
        // The ADDRESS SPACE — every page, not the recognised ones the source
        // will yield. See `derive_search.writeHeader`.
        p.note.page_count,
        &src,
    );
}

/// THE RECONCILE PREDICATE — and the whole point of it is what it does NOT say.
///
/// **The bug it repairs.** The derived-file writes were hung off the tenants'
/// `pending_from_where`, which ask *"does this blob still owe INDEX work?"*.
/// Every blob indexed before the feature existed answers **no**, so it is never
/// offered and never gets its files. MEASURED against the dev database: **0 of 4
/// `.txt` blobs would be offered — all four are already indexed** — and the 22
/// `.note` blobs fail from the other side, deriving at ingest with a dedup'd
/// re-link taking no fresh parse. `golden-search.md` §2.4 states the rule the
/// old question violates: *"derived is the existence of the file, for every
/// format, with no tenant predicate involved."*
///
/// So there is no `txt_index IS NULL`, no `pdf_probe IS NULL`, no index state of
/// any kind here. This clause says only **"a live document of a format we can
/// derive"**; whether its files exist is asked of the DISK, one `has` per
/// document, because §2.4 makes the file the authority and a column would be a
/// second opinion that needs a migration to acquire.
///
/// **`ni.indexable` is the FORMAT question, not a work question**, and it is
/// how both tenants already spell "is this really a note" (*"a real `.note` is
/// never chunked, whatever it is called"*). Taking it from the parsed content
/// rather than from the name is strictly better here than an extension test
/// would be: a `.note` whose bytes do not parse is correctly not a candidate
/// (nothing to derive, so an extension rule would re-parse it every tick for
/// ever), and a note living under some other name is correctly still one.
///
/// **The `note_index` join is `txt_index.pending_from_where`'s ORDER CONTRACT,
/// inherited on purpose.** A blob with no row, or a stale one, is not offered —
/// it cannot be, because `indexable` is what picks the parser. It becomes
/// visible once `ensureIndexed` heals the row, which is the same self-healing
/// posture the rest of this file rests on.
///
/// Bound 1 is the index version; bound 2 is the CURSOR — see `nextCandidate`.
const reconcile_sql =
    \\SELECT f.md5, f.name, ni.indexable
    \\  FROM files f
    \\  JOIN blobs b ON b.md5 = f.md5
    \\  JOIN note_index ni ON ni.blob_md5 = f.md5
    \\ WHERE f.is_folder = 0
    \\   AND f.deleted = 0
    \\   AND f.md5 IS NOT NULL
    \\   AND ni.index_version = ?1
    \\   AND (ni.indexable = 1
    \\        OR LOWER(f.name) LIKE '%_.txt'
    \\        OR LOWER(f.name) LIKE '%_.pdf')
    \\   AND f.md5 > ?2
    \\ ORDER BY f.md5 ASC
    \\ LIMIT 1;
;

/// One document the reconcile pass may owe files for.
const Candidate = struct {
    md5: [32]u8,
    /// Owned by the caller's allocator. Only its EXTENSION is read — the
    /// dispatch rule `Job.name` states: any holder's name will do.
    name: []u8,
    /// The note parser verified the bytes. Chooses the page source.
    indexable: bool,
};

/// Derive one document's two files from its stored blob, dispatching on format.
///
/// Called WITHOUT the DB lock, like every `Tenant.run`, and for the same reason:
/// this is the parse, and the parse is the expensive half. Unlike a tenant it
/// writes nothing to the database at all, so there is no transaction to take the
/// lock back for.
fn deriveOne(job: Job, indexable: bool) !void {
    if (indexable) return deriveNote(job);
    if (txtindex.wants(job.name)) return deriveTxt(job);
    if (pdfindex.wants(job.name)) return derivePdf(job);
    // Unreachable via `reconcile_sql`, whose LIKE clauses are the same rule
    // `wants` is. Silence rather than an error: a row that got here is a
    // disagreement between the two spellings, and the test below pins them.
}

fn deriveNote(job: Job) !void {
    var p = (try noteindex.parseStoredBlob(job.gpa, job.io, job.blobs, job.md5)) orelse return;
    defer p.deinit();
    try writeNoteFiles(job, &p);
}

fn deriveTxt(job: Job) !void {
    var d = (try txtindex.deriveStored(job.gpa, job.blobs, job.md5)) orelse return;
    defer d.deinit();
    try writeTxtFiles(job, d);
}

fn derivePdf(job: Job) !void {
    const file = job.blobs.open(job.md5) catch return; // blob gone: nothing to derive
    defer file.close(job.io);
    var ex = pdftextpass.Extractor.open(file) catch return;
    defer ex.close();
    var src = pdftext.Pages.init(job.gpa, &ex);
    defer src.deinit();
    try writePdfFiles(job, &src, ex.pages);
}

/// What the worker found on one pass.
pub const Found = struct {
    tenant: *const Tenant,
    md5: [32]u8,
    /// Owned by the caller's allocator.
    name: []u8,
};

/// The next outstanding job, or null when everything is current.
///
/// PRIORITY IS AN `ORDER BY`, re-evaluated here on every pass rather than fixed
/// when work was created. Tenants are asked in priority order and the first with
/// anything outstanding wins.
pub fn nextJob(gpa: std.mem.Allocator, db: sqlite.Db) !?Found {
    // Ask in priority order. `tenants` is comptime-known and tiny, so a sort
    // would be ceremony; assert the order instead (see the test below).
    for (&tenants) |*t| {
        var r = (try db.row(t.pending_sql, &.{.{ .int = noteindex.index_version }})) orelse continue;
        defer r.finalize();
        const md5_text = r.text(0);
        if (md5_text.len != 32) continue;
        var found: Found = .{ .tenant = t, .md5 = undefined, .name = undefined };
        @memcpy(&found.md5, md5_text);
        found.name = try gpa.dupe(u8, r.text(1));
        return found;
    }
    return null;
}

/// The background worker: one thread, one job at a time.
pub const Worker = struct {
    gpa: std.mem.Allocator,
    db: sqlite.Db,
    blobs: blobstore.BlobStore,
    lock: *std.Io.Mutex,
    io: std.Io,
    /// Handed to every `Job`. Set by `app.run`; null everywhere else.
    terms: ?derivedstore.DerivedStore = null,
    text: ?derivedstore.DerivedStore = null,

    thread: ?std.Thread = null,

    /// Bumped by `signal`. The worker waits on THIS, with a timeout — which is
    /// why it is a bare futex word rather than an `Io.Condition`: a condition
    /// variable here has `wait` but no `timedWait`, and the timeout is not
    /// optional. It is the backstop that makes a missed signal cost latency
    /// instead of correctness.
    epoch: std.atomic.Value(u32) = .init(0),

    /// Set once, by `stop`. Checked between jobs so a shutdown lands BETWEEN
    /// two files rather than after all of them.
    stopping: std.atomic.Value(bool) = .init(false),

    /// Jobs completed. Test observability today; the natural source for a
    /// pending count in the admin console later.
    ///
    /// `usize`, NOT `u64`, and the difference is not cosmetic: a 32-bit target
    /// has no lock-free 64-bit atomic, so `Value(u64)` is a hard compile error
    /// there ("expected 32-bit integer type or smaller"). That took out all four
    /// release artifacts — including `arm-linux-musleabihf`, which IS the Pi 1
    /// this server is designed for — while every test on the 64-bit builder
    /// stayed green. A counter of completed jobs has no use for the extra range.
    done: std.atomic.Value(usize) = .init(0),

    pub fn start(self: *Worker) !void {
        self.thread = try std.Thread.spawn(.{}, loop, .{self});
    }

    /// New work may exist. Cheap, non-blocking, and safe to call while holding
    /// the DB lock — it touches nothing but an atomic and a futex.
    pub fn signal(self: *Worker) void {
        _ = self.epoch.fetchAdd(1, .release);
        self.io.futexWake(u32, &self.epoch.raw, 1);
    }

    /// Stop and JOIN — never detach.
    ///
    /// The worker writes to the database, so the process must not close the
    /// connection out from under it. That is exactly the opposite of the
    /// per-connection threads (`transport.zig`), which are detached precisely
    /// because they own nothing that outlives the request.
    pub fn stop(self: *Worker) void {
        const t = self.thread orelse return;
        self.stopping.store(true, .release);
        self.signal();
        t.join();
        self.thread = null;
    }

    fn loop(self: *Worker) void {
        nice19();

        // ONCE AT START, and on THIS thread rather than the boot path. Deriving
        // a library that has none is minutes of MuPDF and note parsing on a Pi
        // 1 B+, and boot must not wait for it — where `nice19` above has already
        // put this thread at the priority `mupdf.md` §9.8 measured at 1.4 ms of
        // foreground cost. It is the same argument `sweepTmp` makes for running
        // at startup, applied to work too big to run at startup.
        self.reconcileDerived();

        while (!self.stopping.load(.acquire)) {
            // Read the epoch BEFORE draining. A signal that arrives while we are
            // working then leaves the word changed, so the wait below returns
            // immediately instead of sleeping on work that already exists.
            const seen = self.epoch.load(.acquire);
            self.drain();
            if (self.stopping.load(.acquire)) return;
            self.io.futexWaitTimeout(
                u32,
                &self.epoch.raw,
                seen,
                .{ .duration = .{ .raw = .{ .nanoseconds = idle_tick_ns }, .clock = .awake } },
            ) catch {};

            // AN UNCHANGED EPOCH IS THE IDLE TICK, and the word is the only
            // witness: `futexWaitTimeout` reports a timeout by returning, not by
            // erroring, so its error set cannot tell us. Reconciling on every
            // wake instead would put a full library scan behind every upload —
            // which is precisely the traffic pattern that has the least need of
            // one, since an upload derives its own files on the way in.
            if (self.epoch.load(.acquire) == seen) self.reconcileDerived();
        }
    }

    /// Give every live document its two derived files, whatever the index thinks.
    ///
    /// **The backfill `reconcile_sql` explains, and the reason it cannot be a
    /// tenant.** A tenant is discovered through its own "what do I still owe?"
    /// clause; this pass exists precisely because that question has the wrong
    /// answer for every blob derived — or indexed — before the files existed.
    /// It asks the DISK instead, once per document.
    ///
    /// **ONE DOCUMENT AT A TIME, through a CURSOR rather than a batch.** The
    /// candidate list is read `LIMIT 1` at a time under the lock, keyed on the
    /// last md5 seen, so the pass holds no list, allocates nothing per library
    /// size, and re-reads a live table between documents instead of acting on a
    /// snapshot that a trash or a purge may have invalidated. `files_md5` makes
    /// the whole pass one walk of that index however many steps it takes.
    ///
    /// **The common case never opens a blob.** Two `stat`s say the files are
    /// there and the document is skipped; only a genuine miss pays a parse. That
    /// is what makes running this every idle tick affordable — 1,222 documents
    /// is 2,444 warm `stat`s per 30 s, against the seconds-to-minutes a single
    /// missing document costs.
    ///
    /// **BOTH stores are asked, not just `terms`.** `writeDerived` commits terms
    /// first and text second, so a crash between the two leaves a terms file
    /// whose twin is missing — a document that reports derived for ever and
    /// 404s the text every viewer opens. One extra `stat` closes it.
    ///
    /// Failures are per-document and never fatal: one unparseable blob must not
    /// cost the other 999 their files. `stopping` is checked between documents,
    /// so a shutdown lands between two of them rather than after all of them.
    pub fn reconcileDerived(self: *Worker) void {
        // Null stores are "this deployment keeps none" — `drainNow`, and every
        // test that does not wire them. A no-op, never an error.
        const terms = self.terms orelse return;
        const text = self.text orelse return;

        var cursor_buf: [32]u8 = undefined;
        var cursor: []const u8 = ""; // every hex md5 sorts after the empty string
        var missing: usize = 0;

        while (!self.stopping.load(.acquire)) {
            const c = self.nextCandidate(cursor) catch |e| {
                log.warn("reconcile discovery failed: {t}", .{e});
                return;
            } orelse break;
            defer self.gpa.free(c.name);

            // ADVANCE FIRST. Everything below is allowed to fail, and a cursor
            // moved only on success would re-offer the failing document for ever
            // — a hot loop on the one core this server is allowed to have, which
            // is the same hazard `drain`'s forward-progress guard exists for.
            cursor_buf = c.md5;
            cursor = &cursor_buf;

            if (terms.has(&c.md5, derivesearch.index_version) and
                text.has(&c.md5, derivesearch.index_version)) continue;

            deriveOne(.{
                .gpa = self.gpa,
                .db = self.db,
                .blobs = self.blobs,
                .lock = self.lock,
                .io = self.io,
                .md5 = &c.md5,
                .name = c.name,
                .terms = terms,
                .text = text,
            }, c.indexable) catch |e| {
                log.warn("reconcile failed for {s}: {t}", .{ &c.md5, e });
                continue;
            };
            missing += 1;
        }

        if (missing != 0) log.info("reconcile derived {d} document(s)", .{missing});
    }

    /// The next candidate after `after`, read under the lock like any other
    /// reader of the shared connection. The name is duped because the row's
    /// memory dies with the statement, and the statement dies with the lock.
    fn nextCandidate(self: *Worker, after: []const u8) !?Candidate {
        self.lock.lockUncancelable(self.io);
        defer self.lock.unlock(self.io);

        var r = (try self.db.row(reconcile_sql, &.{
            .{ .int = noteindex.index_version },
            .{ .text = after },
        })) orelse return null;
        defer r.finalize();

        const md5_text = r.text(0);
        if (md5_text.len != 32) return null; // a corrupt row; `nextJob` is as wary
        var c: Candidate = .{ .md5 = undefined, .name = undefined, .indexable = r.int(2) != 0 };
        @memcpy(&c.md5, md5_text);
        c.name = try self.gpa.dupe(u8, r.text(1));
        return c;
    }

    /// Run outstanding jobs until there are none, or until asked to stop.
    ///
    /// Re-queries between jobs rather than taking a batch: that is what makes
    /// priority live, and what lets a shutdown land between two files.
    pub fn drain(self: *Worker) void {
        // THE FORWARD-PROGRESS GUARD, and it belongs here rather than in any
        // tenant. A tenant is allowed to decline a blob — the file has vanished
        // under its `files` row, the probe hit a transient failure — and when it
        // does, it records nothing, so the discovery query hands back the SAME
        // blob on the next turn of this loop. That is not a slow loop, it is a
        // hot one: on a single-core Pi it is the whole machine.
        //
        // So a blob is offered at most once per drain. If it comes back
        // unchanged we stop and let the idle tick pace the retry, which is the
        // same posture as a failed job.
        var last: ?[32]u8 = null;
        while (!self.stopping.load(.acquire)) {
            const found = self.next() catch |e| {
                log.warn("discovery failed: {t}", .{e});
                return;
            } orelse return;
            defer self.gpa.free(found.name);

            if (last) |prev| {
                if (std.mem.eql(u8, &prev, &found.md5)) {
                    log.warn("{s} made no progress on {s}; leaving it for the next tick", .{
                        found.tenant.name, &found.md5,
                    });
                    return;
                }
            }
            last = found.md5;

            found.tenant.run(.{
                .gpa = self.gpa,
                .db = self.db,
                .blobs = self.blobs,
                .lock = self.lock,
                .io = self.io,
                .md5 = &found.md5,
                .name = found.name,
                .terms = self.terms,
                .text = self.text,
            }) catch |e| {
                // LEFT OUTSTANDING ON PURPOSE: the discovery query will offer it
                // again. Returning rather than continuing is what stops a blob
                // that always fails from becoming a hot loop — the idle tick
                // paces the retry instead.
                log.warn("{s} job failed for {s}: {t}", .{ found.tenant.name, &found.md5, e });
                return;
            };

            _ = self.done.fetchAdd(1, .release);
        }
    }

    /// Discovery reads the shared connection, so it takes the lock like any
    /// other reader.
    fn next(self: *Worker) !?Found {
        self.lock.lockUncancelable(self.io);
        defer self.lock.unlock(self.io);
        return nextJob(self.gpa, self.db);
    }
};

/// Drops the CALLING THREAD to nice 19 — the other half of the scheduling
/// answer, and the half `search-index.md` §4 got the wrong way round.
///
/// **MEASURED on the Pi** (`mupdf.md` §9.8). A CPU-bound background pass against
/// the single ARM1176 core doubles foreground latency at nice 0 (19.8 → 40.0 ms
/// p50); at nice 19 it costs **1.4 ms** (19.8 → 21.2). That one call is the
/// whole reason the PDF parse does not have to be resumable — and resumability
/// would be expensive, because each reopen costs ~1 s and yielding often would
/// add tens of seconds per document.
///
/// It applies to the PARSE, which is CPU and off the lock. It does nothing for
/// the WRITE, which is a lock; that half is chunked instead (`runPdfText`).
///
/// ON THE WORKER THREAD ONLY, which is exactly the scope wanted: nice on Linux
/// is per-TASK, not per-process, and `who = 0` means the calling thread. The
/// request threads keep their priority. `drainNow` deliberately does NOT call
/// this — it runs on the caller's thread, and a test or a startup sweep is not
/// background work.
///
/// A RAW SYSCALL because Zig 0.16's std has no wrapper: `setpriority` appears in
/// `std/os/linux/syscalls.zig` as a NUMBER only, with no `std.os.linux.
/// setpriority` function to call. Best-effort — the return value is ignored,
/// because a worker that cannot lower its own priority should still do the work.
fn nice19() void {
    if (@import("builtin").os.tag != .linux) return;
    const PRIO_PROCESS = 0; // …which, for `who = 0`, means this THREAD
    _ = std.os.linux.syscall3(.setpriority, PRIO_PROCESS, 0, 19);
}

/// Run every outstanding job to completion, ON THIS THREAD.
///
/// The synchronous face of the worker, for callers that need the queue empty
/// before they can assert anything — every test that uploads a file and then
/// looks for what the upload used to produce inline. It runs the same discovery
/// query and the same tenants, so a test that passes here is a test of the real
/// path and not of a stub.
pub fn drainNow(
    gpa: std.mem.Allocator,
    db: sqlite.Db,
    blobs: blobstore.BlobStore,
    lock: *std.Io.Mutex,
    io: std.Io,
) void {
    var w: Worker = .{ .gpa = gpa, .db = db, .blobs = blobs, .lock = lock, .io = io };
    w.drain();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const schema = @import("../db/schema.zig");
const testing = std.testing;
const thumbstore = @import("../store/thumbs.zig");
const filesvc = @import("files.zig");

/// A server's worth of moving parts, minus the thread: a real database, a real
/// blob store and the real ingest path, so a test that passes here is a test of
/// the shipped code and not of a stand-in.
const Fixture = struct {
    db: sqlite.Db,
    files: filesvc.Files,
    tmp: testing.TmpDir,
    lock: std.Io.Mutex = .init,

    fn init() !Fixture {
        var db = try sqlite.Db.openMemory();
        try schema.migrate(db);
        var s = try db.prepare(
            "INSERT INTO users(id, email, password_md5, created_at) VALUES(1, 'a@b.c', '0123456789abcdef0123456789abcdef', 0);",
        );
        defer s.finalize();
        _ = try s.step();
        var c = try db.prepare("INSERT INTO capacity(user_id, used_bytes, total_bytes) VALUES(1, 0, 1000000000);");
        defer c.finalize();
        _ = try c.step();

        const tmp = testing.tmpDir(.{});
        const blobs = try blobstore.BlobStore.init(testing.io, tmp.dir);
        const thumbs_dir = try tmp.dir.createDirPathOpen(testing.io, "thumbs", .{});
        const thumbs = try thumbstore.ThumbStore.init(testing.io, thumbs_dir);
        return .{
            .db = db,
            .files = filesvc.Files.init(testing.allocator, testing.io, db, blobs, thumbs),
            .tmp = tmp,
        };
    }

    fn deinit(f: *Fixture) void {
        f.db.close();
        f.tmp.cleanup();
    }

    /// Upload, exactly as a client does. Deliberately does NOT drain — what is
    /// under test here is which side of the upload the work happens on.
    fn put(f: *Fixture, name: []const u8, bytes: []const u8) ![32]u8 {
        var r = std.Io.Reader.fixed(bytes);
        const e = try f.files.putFile(1, null, name, &r, null);
        defer testing.allocator.free(e.name);
        defer if (e.md5) |m| testing.allocator.free(m);
        var md5: [32]u8 = undefined;
        @memcpy(&md5, e.md5.?[0..32]);
        return md5;
    }

    fn drain(f: *Fixture) void {
        drainNow(testing.allocator, f.db, f.files.blobs, &f.lock, testing.io);
    }

    /// The two derived stores, on this fixture's tmp dir. Every reconcile test
    /// wants both; the older tests spell them out inline.
    fn stores(f: *Fixture) !struct { terms: derivedstore.DerivedStore, text: derivedstore.DerivedStore } {
        const terms_dir = try f.tmp.dir.createDirPathOpen(testing.io, "terms", .{});
        const text_dir = try f.tmp.dir.createDirPathOpen(testing.io, "text", .{});
        return .{
            .terms = try derivedstore.DerivedStore.init(testing.io, terms_dir),
            .text = try derivedstore.DerivedStore.init(testing.io, text_dir),
        };
    }

    /// Has the `.txt` tenant finished with this blob? The VERDICT, which is what
    /// the tenant writes to the database and the only thing it writes.
    ///
    /// It used to count the blob's `kind = 1` paragraph rows; `golden-search.md`
    /// §6 step 8 deleted them, and the derived FILES the tenant now produces are
    /// asserted directly in the tests that wire the stores.
    fn txtDone(f: *Fixture, md5: []const u8) !bool {
        return !(try txtindex.needsDerive(f.db, md5));
    }
};

const two_paragraphs = "First paragraph, with words in it.\n\nSecond paragraph, also with words.\n";

test "the .txt tenant writes BOTH derived files, and they inflate to the §2.2 record" {
    // The wiring test for `writeTxtFiles`: the two stores exist, the worker is
    // given them, and a drain leaves real files behind. Everything upstream of
    // this is unit-tested in `store/derived.zig` and `services/derive_search.zig`;
    // what is only testable here is that the tenant actually calls them.
    var f = try Fixture.init();
    defer f.deinit();

    const terms_dir = try f.tmp.dir.createDirPathOpen(testing.io, "terms", .{});
    const text_dir = try f.tmp.dir.createDirPathOpen(testing.io, "text", .{});
    const terms = try derivedstore.DerivedStore.init(testing.io, terms_dir);
    const text = try derivedstore.DerivedStore.init(testing.io, text_dir);

    const md5 = try f.put("notes.txt", two_paragraphs);
    try testing.expect(!terms.has(&md5, derivesearch.index_version));

    var w: Worker = .{
        .gpa = testing.allocator,
        .db = f.db,
        .blobs = f.files.blobs,
        .lock = &f.lock,
        .io = testing.io,
        .terms = terms,
        .text = text,
    };
    w.drain();

    try testing.expect(try f.txtDone(&md5));
    try testing.expect(terms.has(&md5, derivesearch.index_version));
    try testing.expect(text.has(&md5, derivesearch.index_version));

    const t = try derivedstore.readPlain(testing.allocator, terms, &md5, derivesearch.index_version);
    defer testing.allocator.free(t);
    var lines = std.mem.tokenizeScalar(u8, t, '\n');
    const head = lines.next().?;
    try testing.expect(std.mem.indexOf(u8, head, "\"n\":2") != null);
    // Folded, deduplicated, vocabulary order -- and "with" and "words" appear on
    // both paragraphs, which is exactly the per-page shape §2.2 ships.
    try testing.expectEqualStrings(
        "{\"p\":0,\"t\":\"first in it paragraph with words\"}",
        lines.next().?,
    );
    try testing.expectEqualStrings(
        "{\"p\":1,\"t\":\"also paragraph second with words\"}",
        lines.next().?,
    );
    try testing.expect(lines.next() == null);

    // The text file carries the real paragraph AND its byte range into the raw
    // blob -- the address `txtFind.ts` deep-links to.
    const x = try derivedstore.readPlain(testing.allocator, text, &md5, derivesearch.index_version);
    defer testing.allocator.free(x);
    var xlines = std.mem.tokenizeScalar(u8, x, '\n');
    _ = xlines.next();
    const p0 = try std.json.parseFromSlice(std.json.Value, testing.allocator, xlines.next().?, .{});
    defer p0.deinit();
    try testing.expectEqualStrings("First paragraph, with words in it.", p0.value.object.get("t").?.string);
    try testing.expectEqual(@as(i64, 0), p0.value.object.get("o").?.integer);
    try testing.expectEqual(@as(i64, 34), p0.value.object.get("l").?.integer);
}

test "no stores wired means no files and no failure" {
    // `drainNow` and every older test take this path; it must stay a no-op
    // rather than an error, because a deployment without the stores is exactly
    // the state the tree was in before them.
    var f = try Fixture.init();
    defer f.deinit();
    const md5 = try f.put("notes.txt", two_paragraphs);
    f.drain();
    // The verdict still lands, so the worker settles rather than re-offering the
    // blob every idle tick. There is simply nothing to write it to disk.
    try testing.expect(try f.txtDone(&md5));
}

test "an upload does NOT derive the .txt, and a drain does" {
    // The whole point. `putFile` used to chunk the file while the client held
    // the connection — 15-19 s for 5 MB on the deployment target.
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.put("notes.txt", two_paragraphs);
    try std.testing.expect(!try f.txtDone(&md5));

    f.drain();
    try std.testing.expect(try f.txtDone(&md5));
}

test "a second drain finds nothing — the query excludes finished work, so the worker cannot spin" {
    // A discovery query that still matched a completed blob would make `drain`
    // an infinite loop pinning the core, which on one CPU is the whole machine.
    var f = try Fixture.init();
    defer f.deinit();

    _ = try f.put("notes.txt", two_paragraphs);
    f.drain();

    var w: Worker = .{ .gpa = testing.allocator, .db = f.db, .blobs = f.files.blobs, .lock = &f.lock, .io = testing.io };
    w.drain();
    try std.testing.expectEqual(@as(usize, 0), w.done.load(.acquire));
}

test "`pending_sql` and `needsDerive` agree — the two expressions of one predicate" {
    // The SQL is a second statement of `txtindex.needsDerive`, which is a real
    // cost; this is what stops the two drifting into disagreeing about whether a
    // file is done. Checked on BOTH sides of the work.
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.put("notes.txt", two_paragraphs);

    try std.testing.expect(try txtindex.needsDerive(f.db, &md5));
    {
        const found = (try nextJob(testing.allocator, f.db)).?;
        defer testing.allocator.free(found.name);
        try std.testing.expectEqualStrings(&md5, &found.md5);
    }

    f.drain();

    try std.testing.expect(!try txtindex.needsDerive(f.db, &md5));
    try std.testing.expectEqual(@as(?Found, null), try nextJob(testing.allocator, f.db));
}

/// 120 paragraphs, one line each — THREE chunks at `txt_index.chunk_segments`,
/// so a single job here really does cross two chunk boundaries.
fn manyParagraphs(a: std.mem.Allocator, n: usize) ![]const u8 {
    var out: std.ArrayList(u8) = .empty;
    for (0..n) |i| {
        if (i != 0) try out.appendSlice(a, "\n\n");
        try out.print(a, "paragraph {d} rutabaga leaf{d:0>3}", .{ i, i });
    }
    return out.items;
}

test "THE .txt DERIVE WRITES IN READING ORDER, and the verdict comes AFTER the files" {
    // Both halves matter and both are silent when wrong:
    //
    //   - **forward from ordinal 0**, so a document's records are one ascending
    //     run and a client can address any paragraph by its ordinal;
    //   - **the verdict after the two files**, because §2.4 makes the FILE the
    //     fact that a document is derived, and a memo that lands first calls an
    //     un-derived blob finished for ever — the discovery query would never
    //     offer it again and nothing would ever write its files.
    //
    // This used to assert the same two things about a CHUNKED ROW WRITE, through
    // triggers on `note_page_index` and `note_index` — the only honest observer
    // of order from outside those transactions. `golden-search.md` §6 step 8
    // deleted the rows and the chunking, so the order is now observable directly:
    // the records are in the file, and the verdict is in the row.
    var f = try Fixture.init();
    defer f.deinit();
    const s = try f.stores();

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const md5 = try f.put("book.txt", try manyParagraphs(arena.allocator(), 120));

    var w: Worker = .{
        .gpa = testing.allocator,
        .db = f.db,
        .blobs = f.files.blobs,
        .lock = &f.lock,
        .io = testing.io,
        .terms = s.terms,
        .text = s.text,
    };
    w.drain();

    // The verdict is the LAST thing: both files exist by the time it is true.
    try testing.expect(try f.txtDone(&md5));
    try testing.expect(s.terms.has(&md5, derivesearch.index_version));
    try testing.expect(s.text.has(&md5, derivesearch.index_version));

    // Reading order: ordinal 0 first, every ordinal exactly once, never a step
    // back — and the header's address space agrees with what followed.
    const raw = try derivedstore.readPlain(arena.allocator(), s.text, &md5, derivesearch.index_version);
    var lines = std.mem.tokenizeScalar(u8, raw, '\n');
    const head = try std.json.parseFromSlice(std.json.Value, arena.allocator(), lines.next().?, .{});
    try testing.expectEqual(@as(i64, 120), head.value.object.get("n").?.integer);

    var expect_ordinal: i64 = 0;
    while (lines.next()) |line| : (expect_ordinal += 1) {
        const v = try std.json.parseFromSlice(std.json.Value, arena.allocator(), line, .{});
        try testing.expectEqual(expect_ordinal, v.value.object.get("p").?.integer);
    }
    try testing.expectEqual(@as(i64, 120), expect_ordinal);
}

test "a trashed .txt is not offered — the bin is not a work queue" {
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.put("notes.txt", two_paragraphs);
    try f.db.exec("UPDATE files SET deleted = 1 WHERE md5 IS NOT NULL;");
    try std.testing.expectEqual(@as(?Found, null), try nextJob(testing.allocator, f.db));

    // And it comes back the moment it is restored, without anything re-signalling.
    try f.db.exec("UPDATE files SET deleted = 0 WHERE md5 IS NOT NULL;");
    const found = (try nextJob(testing.allocator, f.db)).?;
    defer testing.allocator.free(found.name);
    try std.testing.expectEqualStrings(&md5, &found.md5);
}

test "a leading-dot name is not a text file, here as in `wants`" {
    // `LIKE '%_.txt'` has to mean what `txtindex.wants` means: `_` demands a
    // character before the dot, so a bare `.txt` has no extension at all.
    var f = try Fixture.init();
    defer f.deinit();

    _ = try f.put(".txt", two_paragraphs);
    try std.testing.expect(!txtindex.wants(".txt"));
    try std.testing.expectEqual(@as(?Found, null), try nextJob(testing.allocator, f.db));
}

test "the worker thread starts, does the work, and JOINS on stop" {
    // Shutdown ordering is the one thing a background writer can get fatally
    // wrong: the connection must not close under it. `stop` joins.
    var f = try Fixture.init();
    defer f.deinit();

    var w: Worker = .{ .gpa = testing.allocator, .db = f.db, .blobs = f.files.blobs, .lock = &f.lock, .io = testing.io };
    try w.start();
    f.files.deferred = &w;

    const md5 = try f.put("notes.txt", two_paragraphs);

    // The upload signalled it; wait for the verdict rather than for a duration.
    var spins: usize = 0;
    while (spins < 2000) : (spins += 1) {
        f.lock.lockUncancelable(testing.io);
        const done = f.txtDone(&md5) catch false;
        f.lock.unlock(testing.io);
        if (done) break;
        std.Io.sleep(testing.io, .{ .nanoseconds = std.time.ns_per_ms }, .awake) catch {};
    }
    w.stop();
    try std.testing.expect(w.thread == null);
    try std.testing.expect(try f.txtDone(&md5));
}

/// A 200x100 page with `/Rotate 90` — so the honest answer is 100x200.
const rotate90_pdf = @embedFile("../pdf/testdata/rotate90.pdf");

test "a PDF gets its shape from the worker, and ROTATION survives into the row" {
    // End to end: upload, drain, read the row the gallery reads. The rotated
    // fixture is the point — a `/MediaBox` reader would store 200x100 here, and
    // every tile of that document would be laid out on its side.
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.put("doc.pdf", rotate90_pdf);
    {
        var r = (try f.db.row("SELECT pdf_probe FROM note_index WHERE blob_md5 = ?1;", &.{.{ .text = &md5 }})).?;
        defer r.finalize();
        try std.testing.expectEqual(@as(?i64, null), r.intOpt(0)); // the upload does not probe
    }

    f.drain();

    var r = (try f.db.row(
        "SELECT page_count, width, height, pdf_probe FROM note_index WHERE blob_md5 = ?1;",
        &.{.{ .text = &md5 }},
    )).?;
    defer r.finalize();
    try std.testing.expectEqual(@as(i64, 1), r.int(0));
    try std.testing.expectEqual(@as(i64, 100), r.int(1));
    try std.testing.expectEqual(@as(i64, 200), r.int(2));
    try std.testing.expectEqual(@as(i64, 0), r.int(3)); // Verdict.ok
}

test "a file that is not a PDF records a verdict, so it is never probed twice" {
    // `Tenant.run`'s contract: a tenant that cannot record its own dead ends is
    // handed the same blob for ever, and one core is the whole machine here.
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.put("broken.pdf", "this is definitely not a pdf");
    f.drain();

    {
        var r = (try f.db.row("SELECT pdf_probe FROM note_index WHERE blob_md5 = ?1;", &.{.{ .text = &md5 }})).?;
        defer r.finalize();
        try std.testing.expectEqual(@as(?i64, 1), r.intOpt(0)); // Verdict.unopenable
    }

    var w: Worker = .{ .gpa = testing.allocator, .db = f.db, .blobs = f.files.blobs, .lock = &f.lock, .io = testing.io };
    w.drain();
    try std.testing.expectEqual(@as(usize, 0), w.done.load(.acquire));
}

test "`pending_sql` and `needsProbe` agree, on both sides of the work" {
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.put("doc.pdf", rotate90_pdf);
    try std.testing.expect(try pdfindex.needsProbe(f.db, &md5));

    f.drain();

    try std.testing.expect(!try pdfindex.needsProbe(f.db, &md5));
    try std.testing.expectEqual(@as(?Found, null), try nextJob(testing.allocator, f.db));
}

test "a .pdf.mark is not a PDF — the extension rule, not a substring" {
    var f = try Fixture.init();
    defer f.deinit();
    _ = try f.put("doc.pdf.mark", rotate90_pdf);
    try std.testing.expect(!pdfindex.wants("doc.pdf.mark"));
    try std.testing.expectEqual(@as(?Found, null), try nextJob(testing.allocator, f.db));
}

test "a blob whose FILE is gone cannot spin the worker" {
    // A `files` row whose blob is missing on disk — a failed GC, a hand-edited
    // data dir. The tenant declines (nothing to probe) and records nothing, so
    // the discovery query offers the same blob again. Without the forward
    // progress guard in `drain` that is a hot loop on the one core this server
    // is allowed to have; with it, the blob is offered once and left for the
    // idle tick.
    const saved = testing.log_level;
    testing.log_level = .err; // the warning below is the POINT of this test
    defer testing.log_level = saved;

    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.put("doc.pdf", rotate90_pdf);
    f.files.blobs.remove(&md5); // the row survives, the bytes do not

    var w: Worker = .{ .gpa = testing.allocator, .db = f.db, .blobs = f.files.blobs, .lock = &f.lock, .io = testing.io };
    w.drain(); // must RETURN. Without the guard this never does.

    // Offered once, then abandoned — not once per turn of the loop.
    try std.testing.expect(w.done.load(.acquire) <= 1);
    // And still outstanding, so a later tick can retry once the blob is back.
    try std.testing.expect(try pdfindex.needsProbe(f.db, &md5));
}

/// 120 pages of text, one line each — three chunks at `pdf_text.chunk_pages`,
/// so a single job here really does cross two chunk boundaries.
const book_pdf = @embedFile("../pdf/testdata/text-120-page.pdf");
/// Three bare `/MediaBox` pages: a scan, minus the image.
const scan_pdf = @embedFile("../pdf/testdata/three-page.pdf");

test "ONE JOB answers both of the .pdf tenant's questions — the shape, then the text" {
    // The forward-progress guard offers a blob at most once per drain, so a
    // tenant that only probed would leave the text waiting for the idle tick.
    // One drain has to leave the document fully indexed.
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.put("book.pdf", book_pdf);
    f.drain();

    var r = (try f.db.row(
        "SELECT page_count, pdf_probe, pdf_text FROM note_index WHERE blob_md5 = ?1;",
        &.{.{ .text = &md5 }},
    )).?;
    defer r.finalize();
    try std.testing.expectEqual(@as(i64, 120), r.int(0));
    try std.testing.expectEqual(@as(?i64, 0), r.intOpt(1)); // pdfindex.Verdict.ok
    try std.testing.expectEqual(@as(?i64, 0), r.intOpt(2)); // pdftext.Verdict.ok

    // And the text pass wrote no rows. It used to leave 120 `kind = 2` rows here;
    // §6 step 8 made the two derived files its whole output, and those are
    // asserted against real bytes in "the .pdf tenant writes BOTH derived files".
    var pages = (try f.db.row(
        "SELECT COUNT(*) FROM note_page_index WHERE blob_md5 = ?1;",
        &.{.{ .text = &md5 }},
    )).?;
    defer pages.finalize();
    try std.testing.expectEqual(@as(i64, 0), pages.int(0));
}

test "a second drain finds nothing for a finished PDF either — text is done work, not outstanding" {
    // The same "the worker cannot spin" property the `.txt` tenant is pinned
    // for, over the question that was added to this one.
    var f = try Fixture.init();
    defer f.deinit();

    _ = try f.put("book.pdf", book_pdf);
    f.drain();

    var w: Worker = .{ .gpa = testing.allocator, .db = f.db, .blobs = f.files.blobs, .lock = &f.lock, .io = testing.io };
    w.drain();
    try std.testing.expectEqual(@as(usize, 0), w.done.load(.acquire));
}

test "`pending_sql`, `needsProbe` and `needsText` agree on both sides of the text pass" {
    // Three expressions of one predicate now, which is a real cost; this is what
    // stops them drifting into disagreeing about whether a PDF is done.
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.put("book.pdf", book_pdf);
    try std.testing.expect(try pdfindex.needsProbe(f.db, &md5));
    try std.testing.expect(!try pdftext.needsText(f.db, &md5)); // never before the probe

    f.drain();

    try std.testing.expect(!try pdfindex.needsProbe(f.db, &md5));
    try std.testing.expect(!try pdftext.needsText(f.db, &md5));
    try std.testing.expectEqual(@as(?Found, null), try nextJob(testing.allocator, f.db));
}

test "a SCANNED PDF records its verdict and is never offered again" {
    // `Tenant.run`'s contract, over the one dead end this pass can reach that is
    // not a broken file: a document that opens perfectly and says nothing. Left
    // unrecorded, the worker re-reads a 1,450-page scan every idle tick.
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.put("scan.pdf", scan_pdf);
    f.drain();

    {
        var r = (try f.db.row("SELECT pdf_text FROM note_index WHERE blob_md5 = ?1;", &.{.{ .text = &md5 }})).?;
        defer r.finalize();
        try std.testing.expectEqual(@as(?i64, 1), r.intOpt(0)); // pdftext.Verdict.no_text
    }

    var w: Worker = .{ .gpa = testing.allocator, .db = f.db, .blobs = f.files.blobs, .lock = &f.lock, .io = testing.io };
    w.drain();
    try std.testing.expectEqual(@as(usize, 0), w.done.load(.acquire));
}

test "the .pdf tenant writes BOTH derived files, ACROSS CHUNK BOUNDARIES" {
    // The wiring test for `writePdfFiles`, and the one place the chunked source
    // is driven end to end: 120 pages is three `pdf_text.chunk_pages` chunks, so
    // a source that only ever handed out its first chunk — or that released a
    // chunk while `writeDerived` was still reading a page out of it — fails here
    // and nowhere else.
    var f = try Fixture.init();
    defer f.deinit();

    const terms_dir = try f.tmp.dir.createDirPathOpen(testing.io, "terms", .{});
    const text_dir = try f.tmp.dir.createDirPathOpen(testing.io, "text", .{});
    const terms = try derivedstore.DerivedStore.init(testing.io, terms_dir);
    const text = try derivedstore.DerivedStore.init(testing.io, text_dir);

    const md5 = try f.put("book.pdf", book_pdf);
    var w: Worker = .{
        .gpa = testing.allocator,
        .db = f.db,
        .blobs = f.files.blobs,
        .lock = &f.lock,
        .io = testing.io,
        .terms = terms,
        .text = text,
    };
    w.drain();

    try testing.expect(terms.has(&md5, derivesearch.index_version));
    try testing.expect(text.has(&md5, derivesearch.index_version));

    const t = try derivedstore.readPlain(testing.allocator, terms, &md5, derivesearch.index_version);
    defer testing.allocator.free(t);
    var lines = std.mem.tokenizeScalar(u8, t, '\n');
    try testing.expect(std.mem.indexOf(u8, lines.next().?, "\"n\":120") != null);
    // Folded, vocabulary order. Every page carries `rutabaga`; exactly one
    // carries its own `leafNNN`, which is what makes the ordinal assertable.
    var seen: usize = 0;
    while (lines.next()) |line| : (seen += 1) {
        var buf: [64]u8 = undefined;
        try testing.expectEqualStrings(
            try std.fmt.bufPrint(
                &buf,
                "{{\"p\":{d},\"t\":\"{d} leaf{d:0>3} recipe rutabaga\"}}",
                .{ seen, seen, seen },
            ),
            line,
        );
    }
    try testing.expectEqual(@as(usize, 120), seen); // the last two chunks, too

    // The text file carries the page's real text, addressed by ORDINAL alone —
    // a PDF page has no byte range in the blob, so `o`/`l` are absent.
    const x = try derivedstore.readPlain(testing.allocator, text, &md5, derivesearch.index_version);
    defer testing.allocator.free(x);
    var xlines = std.mem.tokenizeScalar(u8, x, '\n');
    _ = xlines.next();
    const p0 = try std.json.parseFromSlice(std.json.Value, testing.allocator, xlines.next().?, .{});
    defer p0.deinit();
    try testing.expectEqual(@as(i64, 0), p0.value.object.get("p").?.integer);
    try testing.expect(p0.value.object.get("o") == null);
    try testing.expect(p0.value.object.get("l") == null);
    try testing.expect(std.mem.indexOf(u8, p0.value.object.get("t").?.string, "Recipe 0 rutabaga leaf000") != null);
}

test "a SCANNED PDF still gets its two files, and they are the header alone" {
    // Two properties in one, and both are load-bearing. §2.4 makes the FILE the
    // fact that a document is derived, so a scan has to leave one behind or it
    // reports pending for ever; and an image-only page is SKIPPED rather than
    // written as an empty row, so what it leaves behind is a header and nothing
    // else. It is also the one document `writePdfFiles` declines to walk twice.
    var f = try Fixture.init();
    defer f.deinit();

    const terms_dir = try f.tmp.dir.createDirPathOpen(testing.io, "terms", .{});
    const text_dir = try f.tmp.dir.createDirPathOpen(testing.io, "text", .{});
    const terms = try derivedstore.DerivedStore.init(testing.io, terms_dir);
    const text = try derivedstore.DerivedStore.init(testing.io, text_dir);

    const md5 = try f.put("scan.pdf", scan_pdf);
    var w: Worker = .{
        .gpa = testing.allocator,
        .db = f.db,
        .blobs = f.files.blobs,
        .lock = &f.lock,
        .io = testing.io,
        .terms = terms,
        .text = text,
    };
    w.drain();

    try testing.expect(terms.has(&md5, derivesearch.index_version));
    try testing.expect(text.has(&md5, derivesearch.index_version));

    for ([_]derivedstore.DerivedStore{ terms, text }) |store| {
        const got = try derivedstore.readPlain(testing.allocator, store, &md5, derivesearch.index_version);
        defer testing.allocator.free(got);
        var lines = std.mem.tokenizeScalar(u8, got, '\n');
        // `n` is the ADDRESS SPACE: three pages, none of which says anything.
        try testing.expect(std.mem.indexOf(u8, lines.next().?, "\"n\":3") != null);
        try testing.expect(lines.next() == null);
    }
}

test "NICE 19 IS PER-THREAD — the worker yields the core, the request threads do not" {
    // The scheduling half of the answer (`mupdf.md` §9.8): a CPU-bound pass at
    // nice 0 doubles foreground latency on the single ARM1176 core, at nice 19 it
    // costs 1.4 ms. The property that makes that safe is that nice on Linux is
    // per-TASK — so this asserts BOTH halves: the spawned thread really moved,
    // and the thread that spawned it did not.
    if (@import("builtin").os.tag != .linux) return error.SkipZigTest;
    // The kernel returns `20 - nice`, so nice 19 reads back as 1 and the
    // suite's own (nice 0) thread reads back as 20.
    const nice = struct {
        fn read() usize {
            return std.os.linux.syscall2(.getpriority, 0, 0);
        }
        fn lowerAndRead(out: *usize) void {
            nice19();
            out.* = read();
        }
    };
    const before = nice.read();

    var worker_nice: usize = 0;
    const t = try std.Thread.spawn(.{}, nice.lowerAndRead, .{&worker_nice});
    t.join();

    try std.testing.expectEqual(@as(usize, 1), worker_nice); // nice 19
    try std.testing.expectEqual(before, nice.read()); // this thread is untouched
}

test "the tenant table is ordered by priority, so `nextJob` can take the first match" {
    // `nextJob` asks in array order and returns the first tenant with work.
    // That is only "priority order" if the array IS sorted — asserted here
    // rather than by sorting at runtime, because the table is comptime-known.
    var prev: u8 = 0;
    for (&tenants) |*t| {
        try std.testing.expect(t.priority >= prev);
        prev = t.priority;
        try std.testing.expect(t.name.len > 0);
        try std.testing.expect(t.pending_sql.len > 0);
        try std.testing.expect(t.from_where.len > 0);
    }
}

test "every tenant's pending_sql is valid SQL against the real schema" {
    // A tenant whose query does not compile would only fail at runtime, in a
    // background thread, as a log line nobody reads.
    var db = try sqlite.Db.openMemory();
    defer db.close();
    try schema.migrate(db);
    for (&tenants) |*t| {
        const s = try db.prepare(t.pending_sql);
        s.finalize();
    }
}

test "a tenant's discovery statement CONTAINS its predicate, so a second reader cannot drift from it" {
    // The structural half of the no-drift argument, and the reason `from_where`
    // is a field rather than a convention. `pending.zig` counts over exactly
    // these bytes; if a tenant ever hand-writes its `pending_sql` again, the
    // count and the worker are free to disagree about what is outstanding, and
    // the symptom is a UI that says "nothing pending" while a derive is running.
    // Behavioural agreement is asserted separately (`pending.zig`'s tests, and
    // the `needsDerive`/`needsProbe` tests above); this pins that there is
    // literally ONE copy of the clause.
    for (&tenants) |*t| {
        try std.testing.expect(std.mem.indexOf(u8, t.pending_sql, t.from_where) != null);
    }
}

test "the predicate answers PER BLOB as well as per install — one bound parameter, not a fourth copy" {
    // `docs/scratch/pending-ness.md` §4.1 needs "is THIS blob still being
    // derived?" for a cache decision, and getting it wrong loses data silently:
    // a client that caches a not-yet-derived blob's empty term set never asks
    // again. That endpoint is not built here, but the predicate it will be built
    // ON is — so this asserts the shape composes, rather than leaving the next
    // author to discover it does not and write the rule out a fourth time.
    var f = try Fixture.init();
    defer f.deinit();

    const txt = try f.put("notes.txt", two_paragraphs);
    const pdf = try f.put("doc.pdf", rotate90_pdf);

    const per_blob = struct {
        fn ask(db: sqlite.Db, from_where: []const u8, md5: []const u8) !bool {
            const sql = try std.fmt.allocPrint(
                testing.allocator,
                "SELECT 1\n{s}\n   AND f.md5 = ?2\n LIMIT 1;",
                .{from_where},
            );
            defer testing.allocator.free(sql);
            var r = (try db.row(sql, &.{
                .{ .int = noteindex.index_version },
                .{ .text = md5 },
            })) orelse return false;
            r.finalize();
            return true;
        }
    }.ask;

    // Before the work: each tenant's predicate names its own blob and not the
    // other's — the per-blob answer is not merely "is anything pending".
    try std.testing.expect(try per_blob(f.db, txt_tenant.from_where, &txt));
    try std.testing.expect(!try per_blob(f.db, txt_tenant.from_where, &pdf));
    try std.testing.expect(try per_blob(f.db, pdf_tenant.from_where, &pdf));
    try std.testing.expect(!try per_blob(f.db, pdf_tenant.from_where, &txt));

    f.drain();

    // And after it, both are done — the same authority `needsDerive` /
    // `needsProbe` report, reached through the shared clause.
    try std.testing.expect(!try per_blob(f.db, txt_tenant.from_where, &txt));
    try std.testing.expect(!try per_blob(f.db, pdf_tenant.from_where, &pdf));
}

// ---------------------------------------------------------------------------
// Reconcile
// ---------------------------------------------------------------------------

/// Two pages, page 0 recognised — so the derived record has one page line over a
/// two-page address space, which is the `.note` shape `derive_search` writes.
const sample2_note = @embedFile("sample-2.note");

test "RECONCILE: an ALREADY-INDEXED .txt gets its files, and a drain cannot give them" {
    // THE BUG, stated as a test. The library was indexed before the derived
    // stores existed, so every tenant predicate answers "nothing owed" — and
    // hanging the file writes off those predicates means the document never gets
    // its files, for ever, with no error. MEASURED on the dev database: 0 of 4
    // `.txt` blobs would be offered. Both halves are asserted, because only the
    // second one is new: the drain must NOT produce the files, the reconcile
    // pass must.
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.put("notes.txt", two_paragraphs);
    f.drain(); // derived by a worker with no stores wired: the shipped state
    try testing.expect(try f.txtDone(&md5));
    try testing.expectEqual(@as(?Found, null), try nextJob(testing.allocator, f.db));

    const s = try f.stores();
    var w: Worker = .{
        .gpa = testing.allocator,
        .db = f.db,
        .blobs = f.files.blobs,
        .lock = &f.lock,
        .io = testing.io,
        .terms = s.terms,
        .text = s.text,
    };

    // The tenants have nothing to say about this blob — which is the defect,
    // not an accident of the fixture.
    w.drain();
    try testing.expectEqual(@as(usize, 0), w.done.load(.acquire));
    try testing.expect(!s.terms.has(&md5, derivesearch.index_version));

    w.reconcileDerived();

    try testing.expect(s.terms.has(&md5, derivesearch.index_version));
    try testing.expect(s.text.has(&md5, derivesearch.index_version));

    // And what it wrote is the real §2.2 record, not an empty placeholder — a
    // backfill that left header-only files behind would satisfy `has` for ever.
    const t = try derivedstore.readPlain(testing.allocator, s.terms, &md5, derivesearch.index_version);
    defer testing.allocator.free(t);
    var lines = std.mem.tokenizeScalar(u8, t, '\n');
    try testing.expect(std.mem.indexOf(u8, lines.next().?, "\"n\":2") != null);
    try testing.expectEqualStrings(
        "{\"p\":0,\"t\":\"first in it paragraph with words\"}",
        lines.next().?,
    );
    try testing.expectEqualStrings(
        "{\"p\":1,\"t\":\"also paragraph second with words\"}",
        lines.next().?,
    );
    try testing.expect(lines.next() == null);
}

test "RECONCILE: a .note gets its files, which NOTHING else in the worker can do" {
    // The other half of the same bug, failing from the opposite side: a `.note`
    // derives inside the upload transaction (§2.4), so it is never pending and
    // has no tenant at all. A note uploaded before the stores existed — or
    // arriving through a dedup'd re-link, which takes no fresh parse — is
    // reachable only here. MEASURED on the dev database: 22 such blobs.
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.put("n.note", sample2_note);
    f.drain();
    try testing.expectEqual(@as(?Found, null), try nextJob(testing.allocator, f.db));

    const s = try f.stores();
    var w: Worker = .{
        .gpa = testing.allocator,
        .db = f.db,
        .blobs = f.files.blobs,
        .lock = &f.lock,
        .io = testing.io,
        .terms = s.terms,
        .text = s.text,
    };
    w.reconcileDerived();

    try testing.expect(s.terms.has(&md5, derivesearch.index_version));
    try testing.expect(s.text.has(&md5, derivesearch.index_version));

    const t = try derivedstore.readPlain(testing.allocator, s.terms, &md5, derivesearch.index_version);
    defer testing.allocator.free(t);
    var lines = std.mem.tokenizeScalar(u8, t, '\n');
    // `n` is the ADDRESS SPACE: two pages, one of which has a finished
    // transcript. The unrecognised page is skipped, not written empty.
    try testing.expect(std.mem.indexOf(u8, lines.next().?, "\"n\":2") != null);
    try testing.expect(std.mem.startsWith(u8, lines.next().?, "{\"p\":0,\"t\":\""));
    try testing.expect(lines.next() == null);
}

test "RECONCILE: a .pdf gets its files through the chunked source" {
    // 120 pages is three `pdf_text.chunk_pages` chunks, so this drives the one
    // page source that is not already in hand — and it does it WITHOUT the
    // `any_text` shortcut `runPdfText` takes, which is the only thing the
    // reconcile path does differently from the tenant.
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.put("book.pdf", book_pdf);
    f.drain();
    try testing.expectEqual(@as(?Found, null), try nextJob(testing.allocator, f.db));

    const s = try f.stores();
    var w: Worker = .{
        .gpa = testing.allocator,
        .db = f.db,
        .blobs = f.files.blobs,
        .lock = &f.lock,
        .io = testing.io,
        .terms = s.terms,
        .text = s.text,
    };
    w.reconcileDerived();

    try testing.expect(s.terms.has(&md5, derivesearch.index_version));
    try testing.expect(s.text.has(&md5, derivesearch.index_version));

    const t = try derivedstore.readPlain(testing.allocator, s.terms, &md5, derivesearch.index_version);
    defer testing.allocator.free(t);
    var lines = std.mem.tokenizeScalar(u8, t, '\n');
    try testing.expect(std.mem.indexOf(u8, lines.next().?, "\"n\":120") != null);
    var seen: usize = 0;
    while (lines.next()) |line| : (seen += 1) {
        var buf: [64]u8 = undefined;
        try testing.expectEqualStrings(
            try std.fmt.bufPrint(&buf, "{{\"p\":{d},\"t\":\"{d} leaf{d:0>3} recipe rutabaga\"}}", .{ seen, seen, seen }),
            line,
        );
    }
    try testing.expectEqual(@as(usize, 120), seen); // past both chunk boundaries
}

test "RECONCILE: a document that HAS its files is not derived again" {
    // The pass runs on every idle tick, so the skip is what makes it affordable:
    // two `stat`s and no blob read. Asserted by CONTENT rather than by timing —
    // the files are overwritten with a sentinel that a re-derive would destroy.
    var f = try Fixture.init();
    defer f.deinit();

    const s = try f.stores();
    const md5 = try f.put("notes.txt", two_paragraphs);
    var w: Worker = .{
        .gpa = testing.allocator,
        .db = f.db,
        .blobs = f.files.blobs,
        .lock = &f.lock,
        .io = testing.io,
        .terms = s.terms,
        .text = s.text,
    };
    w.drain(); // the tenant writes them on the way past
    try testing.expect(s.terms.has(&md5, derivesearch.index_version));

    const sentinel = "not a fragment";
    try s.terms.put(&md5, derivesearch.index_version, sentinel);
    try s.text.put(&md5, derivesearch.index_version, sentinel);

    w.reconcileDerived();

    for ([_]derivedstore.DerivedStore{ s.terms, s.text }) |store| {
        const got = try rawStored(store, &md5);
        defer testing.allocator.free(got);
        try testing.expectEqualStrings(sentinel, got);
    }
}

test "RECONCILE: a HALF-WRITTEN pair is completed — terms alone is not derived" {
    // `writeDerived` commits terms first and text second, so a crash between the
    // two leaves a terms file whose twin is missing. Asking `terms.has` alone
    // would call that document derived for ever, and every viewer opening it
    // would 404 the text. One extra `stat` is the whole fix.
    var f = try Fixture.init();
    defer f.deinit();

    const s = try f.stores();
    const md5 = try f.put("notes.txt", two_paragraphs);
    var w: Worker = .{
        .gpa = testing.allocator,
        .db = f.db,
        .blobs = f.files.blobs,
        .lock = &f.lock,
        .io = testing.io,
        .terms = s.terms,
        .text = s.text,
    };
    w.drain();
    s.text.remove(&md5, derivesearch.index_version); // the torn commit

    w.reconcileDerived();

    try testing.expect(s.text.has(&md5, derivesearch.index_version));
    const x = try derivedstore.readPlain(testing.allocator, s.text, &md5, derivesearch.index_version);
    defer testing.allocator.free(x);
    try testing.expect(std.mem.indexOf(u8, x, "First paragraph") != null);
}

test "RECONCILE: null stores are a no-op, not an error" {
    // `drainNow`, and every deployment and test that keeps no derived stores.
    // The pass must decline silently — that is the state the tree was in before
    // the stores existed, and it is not a failure.
    var f = try Fixture.init();
    defer f.deinit();

    _ = try f.put("notes.txt", two_paragraphs);
    var w: Worker = .{ .gpa = testing.allocator, .db = f.db, .blobs = f.files.blobs, .lock = &f.lock, .io = testing.io };
    w.reconcileDerived();
    try testing.expectEqual(@as(usize, 0), w.done.load(.acquire));
}

test "RECONCILE: the bin is not a backfill queue either" {
    // `files` VISIBILITY, the same rule the tenant predicates carry: a trashed
    // document is in nobody's manifest, so deriving it spends a parse on
    // something nothing can ever stream. And it comes back the moment it is
    // restored, without anything re-signalling.
    var f = try Fixture.init();
    defer f.deinit();

    const s = try f.stores();
    const md5 = try f.put("notes.txt", two_paragraphs);
    try f.db.exec("UPDATE files SET deleted = 1 WHERE md5 IS NOT NULL;");

    var w: Worker = .{
        .gpa = testing.allocator,
        .db = f.db,
        .blobs = f.files.blobs,
        .lock = &f.lock,
        .io = testing.io,
        .terms = s.terms,
        .text = s.text,
    };
    w.reconcileDerived();
    try testing.expect(!s.terms.has(&md5, derivesearch.index_version));

    try f.db.exec("UPDATE files SET deleted = 0 WHERE md5 IS NOT NULL;");
    w.reconcileDerived();
    try testing.expect(s.terms.has(&md5, derivesearch.index_version));
}

test "RECONCILE: the cursor visits EVERY document, and a second pass reads no blob" {
    // The pass walks `LIMIT 1` at a time keyed on the last md5 seen, so a cursor
    // that failed to advance would spin on one document and a cursor that
    // advanced too far would skip its neighbours — both silent, and both fatal
    // to a backfill. Three formats in one pass, in md5 order, whatever that is.
    var f = try Fixture.init();
    defer f.deinit();

    const txt = try f.put("notes.txt", two_paragraphs);
    const note = try f.put("n.note", sample2_note);
    const pdf = try f.put("doc.pdf", rotate90_pdf);
    f.drain();

    const s = try f.stores();
    var w: Worker = .{
        .gpa = testing.allocator,
        .db = f.db,
        .blobs = f.files.blobs,
        .lock = &f.lock,
        .io = testing.io,
        .terms = s.terms,
        .text = s.text,
    };
    w.reconcileDerived();

    for ([_][32]u8{ txt, note, pdf }) |md5| {
        try testing.expect(s.terms.has(&md5, derivesearch.index_version));
        try testing.expect(s.text.has(&md5, derivesearch.index_version));
    }

    // Idempotent: everything is present, so the second pass opens nothing.
    // Proved the same way as the skip test — a sentinel a re-derive would eat.
    const sentinel = "still here";
    try s.terms.put(&txt, derivesearch.index_version, sentinel);
    w.reconcileDerived();
    const got = try rawStored(s.terms, &txt);
    defer testing.allocator.free(got);
    try testing.expectEqualStrings(sentinel, got);
}

test "RECONCILE: the SQL compiles, and carries NO index state" {
    // Two readers of one extension rule — this clause and `deriveOne`'s dispatch
    // — which is a real cost, paid for the same reason the tenants pay it. A
    // name the SQL admits and `wants` rejects is a document the pass offers and
    // then silently declines to derive, every tick, for ever.
    var db = try sqlite.Db.openMemory();
    defer db.close();
    try schema.migrate(db);
    const s = try db.prepare(reconcile_sql);
    s.finalize();

    try testing.expect(std.mem.indexOf(u8, reconcile_sql, "LIKE '%_.txt'") != null);
    try testing.expect(std.mem.indexOf(u8, reconcile_sql, "LIKE '%_.pdf'") != null);
    // `_` demands a character before the dot, exactly as `wants` does.
    try testing.expect(txtindex.wants("a.txt") and pdfindex.wants("a.pdf"));
    try testing.expect(!txtindex.wants(".txt") and !pdfindex.wants(".pdf"));
    // And no work predicate leaked in — asking one is the bug this pass repairs.
    for ([_][]const u8{ "txt_index", "pdf_probe", "pdf_text" }) |column| {
        try testing.expect(std.mem.indexOf(u8, reconcile_sql, column) == null);
    }
}

/// A stored file's bytes as they sit on disk — no header skip, no inflate. For
/// the sentinel tests, which write something that is neither.
fn rawStored(store: derivedstore.DerivedStore, md5: []const u8) ![]u8 {
    var file = try store.open(md5, derivesearch.index_version);
    defer file.close(store.io);
    var buf: [1 << 12]u8 = undefined;
    const n = try file.readPositionalAll(store.io, &buf, 0);
    return testing.allocator.dupe(u8, buf[0..n]);
}
