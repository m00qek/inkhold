// ABI check for `sqlite-core.wasm` (`zig build wasm-sqlite-core-test`).
//
// The point is NOT that the module links. Three things are asserted that a
// linking, export-complete shell would fail:
//
//   1. **THE BUILD FLAG.** `-DSQLITE_TEMP_STORE=3` is the most dangerous line in
//      this artifact's flag set — the null VFS cannot open a file, so temp
//      storage that fell back to a temp FILE would fail rather than run slowly.
//      MEASURED while writing this: removing the flag changes NOTHING observable
//      at any scale reachable from here (80,000 documents, an 80,000-row
//      `ORDER BY rank`, hundreds of autocommitted inserts forcing level-0
//      merges). So there is no behavioural test to write, and the module instead
//      refuses to open an index it cannot vouch for. This file asserts the
//      refusal — which is what turns a dropped flag into a red test rather than
//      into a corrupt index in somebody's browser months later.
//   2. **THE FUSION.** One artifact carries both ABIs (`client-side-search-impl.md`
//      §5). The same instance parses the `.spd` fixture and answers a search, so
//      a build that quietly dropped one half fails here.
//   3. **THE RESTORE PATH.** Serialize, then rebuild in a FRESH instance through
//      `idx_image_alloc`/`idx_deserialize` and ask the same questions. That path
//      carries both ABI traps `wasm-search-bench.md` §6 records, and its first
//      call into SQLite is `idx_image_alloc` — which is exactly where
//      `OMIT_AUTOINIT` bites.
//
// Usage: node sqlite_core_abi.mjs <sqlite-core.wasm> <fixture.spd>

import { WASI } from "node:wasi";
import fs from "node:fs";

const [, , wasmPath, spdPath] = process.argv;
if (!wasmPath || !spdPath) {
  console.error("usage: node sqlite_core_abi.mjs <sqlite-core.wasm> <fixture.spd>");
  process.exit(2);
}

let failures = 0;
function check(ok, what, detail) {
  if (ok) return;
  failures += 1;
  console.error(`FAIL: ${what}${detail === undefined ? "" : ` (${detail})`}`);
}
function equal(actual, expected, what) {
  check(actual === expected, what, `expected ${expected}, got ${actual}`);
}

const bytes = fs.readFileSync(wasmPath);
const mod = await WebAssembly.compile(bytes);

// Node's real WASI rather than ENOSYS stubs, for the same reason the PDF ABI
// test uses it: the `OS_OTHER` build should never reach a syscall, and a real
// WASI turns an accidental one into a wrong answer instead of a swallowed error.
async function freshInstance() {
  const wasi = new WASI({ version: "preview1", args: [], env: {} });
  const instance = await WebAssembly.instantiate(mod, wasi.getImportObject());
  wasi.initialize(instance);
  return instance.exports;
}

let e = await freshInstance();

/**
 * Copy a JS string into wasm memory as UTF-8. Returns [ptr, byteLength].
 *
 * One byte more than the text is always allocated, because the empty query is a
 * real case (the search box before anything is typed) and a zero-length
 * allocation has no address worth handing across the boundary.
 */
function put(text) {
  const buf = Buffer.from(text, "utf8");
  const ptr = e.idx_alloc(buf.length + 1);
  new Uint8Array(e.memory.buffer, ptr, buf.length + 1).set(buf, 0);
  return [ptr, buf.length];
}

function drop([ptr, len]) {
  e.idx_free(ptr, len + 1);
}

/** The module's last error message, or "" if it set none. */
function errorText() {
  const n = e.idx_errmsg_len();
  if (n === 0) return "";
  return Buffer.from(new Uint8Array(e.memory.buffer, e.idx_errmsg_ptr(), n)).toString("utf8");
}

/** Run `text` and return { total, hits } — hits capped at `limit`. */
function query(text, limit = 10) {
  const buf = put(text);
  const total = e.idx_query(buf[0], buf[1], limit);
  const hits = [];
  if (total >= 0) {
    for (let i = 0; i < Math.min(total, limit); i++) hits.push(e.idx_hit(i));
  }
  drop(buf);
  return { total, hits };
}

// ---- exports ----------------------------------------------------------------
// Both ABIs, from one module. `spd_*` is the `.spd` viewer's and predates this
// file; it is listed here because the whole point of the artifact is that the
// two travel together.
for (const name of [
  "idx_alloc", "idx_free", "idx_schema_version",
  "idx_open", "idx_close", "idx_begin", "idx_add", "idx_commit",
  "idx_query", "idx_hit",
  "idx_serialize", "idx_image_ptr", "idx_image_alloc", "idx_deserialize",
  "idx_errmsg_ptr", "idx_errmsg_len",
  "spd_alloc", "spd_free", "spd_open", "spd_close",
  "spd_layer_count", "spd_layer_id", "spd_tiles_begin", "spd_tile_next",
  "memory",
]) {
  check(e[name] !== undefined, `export \`${name}\` is present`);
}
if (failures > 0) process.exit(1);

// ---- the build flag ---------------------------------------------------------
// -100 is the module's "this artifact was built without -DSQLITE_TEMP_STORE=3".
// Reported with its message, because a bare code here would send a reader to the
// wrong place entirely — nothing is wrong at runtime, the binary is wrong.
const opened = e.idx_open();
check(
  opened !== -100,
  "the artifact was built with -DSQLITE_TEMP_STORE=3",
  errorText(),
);
equal(opened, 0, "an index opens on a fresh instance");
if (failures > 0) process.exit(1);

check(e.idx_schema_version() >= 1, "the module reports a schema version for the stored image to carry");

// ---- build ------------------------------------------------------------------
// Portuguese with real diacritics on purpose: `remove_diacritics 2` is the half
// of the tokenizer contract that a wrong `tokenize=` would silently change, and
// document 1 and document 2 spell the same word differently.
const CORPUS = [
  [11, "reunião de caligrafia às terças"],
  [12, "reuniao semanal do projeto"],
  [13, "caligrafia japonesa"],
  [14, "notas sobre o projeto de dados"],
];

equal(e.idx_begin(), 0, "a build transaction opens");
for (const [id, body] of CORPUS) {
  const buf = put(body);
  equal(e.idx_add(id, buf[0], buf[1]), 0, `document ${id} is indexed`);
  drop(buf);
}
equal(e.idx_commit(), 0, "the build transaction commits");

// A repeated document id is a collision between two manifests, so it must be
// refused rather than silently replacing a document the caller still believes in.
{
  const buf = put("outro documento");
  check(e.idx_add(11, buf[0], buf[1]) !== 0, "a repeated document id is refused, not overwritten");
  check(/UNIQUE|constraint/i.test(errorText()), "...and says why", errorText());
  drop(buf);
}

// ---- query ------------------------------------------------------------------
// THE DIACRITIC ASSERTION, and it is the one that pins `tokenize=` to the
// server's: "reunião" and "reuniao" are one term, so both documents come back
// however the query is spelt.
{
  const a = query("reunião ");
  const b = query("REUNIAO ");
  equal(a.total, 2, "an accented query finds the unaccented document too");
  equal(b.total, 2, "an uppercase unaccented query finds the accented one");
  equal(a.hits.slice().sort().join(","), "11,12", "...and they are the right two documents");
}

// THE PREFIX RULE, asserted from BOTH sides. A prefix on the last token is what
// makes search answer while the user is still typing; a trailing space is the
// user saying the word is finished, and prefix-matching anyway would leave
// "cali " matching "caligrafia" for ever.
equal(query("cali").total, 2, "an unfinished last word matches as a prefix");
equal(query("cali ").total, 0, "...and a trailing space turns that off");
equal(query("caligrafia ").total, 2, "a completed word still matches exactly");

// Multiple tokens are ANDed: "projeto" is in 12 and 14, "reuni*" only in 11/12.
{
  const r = query("projeto reuni");
  equal(r.total, 1, "two tokens narrow rather than widen");
  equal(r.hits[0], 12, "...to the document that has both");
}

// THE REASON THE FOLD LIVES IN WASM. A JS-side escaper would have to decide what
// FTS5 makes of these; the tokenizer already knows, and the answer is "no terms".
// Each of these was a plausible syntax error on a keystroke.
for (const junk of ["", "   ", "-", "\"", "\"\"", "...", "( )", "*"]) {
  equal(query(junk).total, 0, `\`${JSON.stringify(junk)}\` is no results rather than an error`);
}
// ...and a quote mixed with real text must still find the real text.
equal(query('"caligrafia" ').total, 2, "a quoted word searches for the word");

// The total is EXACT and independent of `limit` — §9.5 retires the server's
// "N+" floors precisely because a client holding the index can say the number.
{
  const r = query("caligrafia ", 1);
  equal(r.total, 2, "the total counts every match, not just the ones returned");
  equal(r.hits.length, 1, "...while `limit` caps what is buffered");
  equal(e.idx_hit(1), -1, "a hit past the buffered ones is -1");
  equal(e.idx_hit(99), -1, "an out-of-range hit index is -1");
}

// THE LONG-LIVED-INSTANCE DISCIPLINE (`optimizations.md` entry 11b). The query
// fold is a contentless FTS5 table reset with 'delete-all' rather than DELETE,
// because FTS5 records a deletion as a new entry in a new segment — so a worker
// that stayed open would otherwise get slower and, worse, keep folding against
// the residue. 200 queries, and the last must answer like the first.
{
  let drifted = 0;
  for (let i = 0; i < 200; i++) {
    if (query(i % 2 === 0 ? "reunião " : "japonesa ").total !== (i % 2 === 0 ? 2 : 1)) drifted += 1;
  }
  equal(drifted, 0, "the query fold does not accumulate across 200 searches");
}

// ---- the .spd half of the SAME instance ------------------------------------
// The fusion, asserted rather than assumed: one SQLite, two features, and an
// open search index does not disturb the viewer. Values are the ones locked into
// `parsers/spd/tests/spd_test.zig`.
{
  const spd = fs.readFileSync(spdPath);
  const ptr = e.spd_alloc(spd.length);
  check(ptr !== 0, "spd_alloc returned a buffer");
  new Uint8Array(e.memory.buffer, ptr, spd.length).set(spd);
  equal(e.spd_open(ptr, spd.length), 0, "the .spd fixture opens in the fused module");
  e.spd_free(ptr, spd.length);

  equal(e.spd_layer_count(), 4, "the fixture's four layers are found");
  const ids = [];
  for (let i = 0; i < e.spd_layer_count(); i++) ids.push(e.spd_layer_id(i));
  equal(ids.join(","), "3,2,1,9999", "the layers are in Z-order");
  equal(e.spd_layer_visible(1), 0, "layer 2 is hidden");

  equal(e.spd_tiles_begin(2), 0, "layer 2's tiles iterate");
  let tiles = 0;
  while (e.spd_tile_next() === 1) tiles += 1;
  equal(tiles, 6, "layer 2 has six tiles");
  e.spd_close();
}

// ...and the search index survived the `.spd` traffic beside it.
equal(query("reunião ").total, 2, "the search index still answers after a .spd parse");

// ---- serialize / restore ----------------------------------------------------
// The second visit. `idx_serialize` hands over bytes an IndexedDB record would
// hold; a FRESH instance restores them and must be warm immediately.
const imageLen = e.idx_serialize();
check(imageLen > 0, "the index serializes to an image", `got ${imageLen} (${errorText()})`);
const image = Buffer.from(new Uint8Array(e.memory.buffer, e.idx_image_ptr(), imageLen));
e.idx_close();

// A closed module answers nothing rather than dereferencing a stale handle.
// -21 is SQLITE_MISUSE: no database, as distinct from a statement that failed.
equal(query("reunião ").total, -21, "a query with no open index is refused");

{
  e = await freshInstance();
  // TRAP 1 and TRAP 2 in one call (`wasm-search-bench.md` §6). The target must
  // come from SQLite's own heap, or FREEONCLOSE frees a Zig-allocated pointer;
  // and on a fresh instance `sqlite3_malloc64` traps outright until
  // `sqlite3_initialize` has run, because OMIT_AUTOINIT leaves the memory
  // subsystem's vtable null. THIS is that first call — nothing else has run.
  const dst = e.idx_image_alloc(image.length);
  check(dst !== 0, "idx_image_alloc works as the FIRST call into a fresh instance");
  new Uint8Array(e.memory.buffer, dst, image.length).set(image);
  equal(e.idx_deserialize(dst, image.length), 0, "the image deserializes");

  // The restored index must be fully warm on its first query — the bench measured
  // 0.4 ms and the whole droppability invariant (§4.1) rests on it.
  equal(query("reunião ").total, 2, "the restored index answers the accented query");
  equal(query("cali").total, 2, "...and still expands a prefix");
  equal(query("projeto reuni").hits[0], 12, "...and still ANDs two tokens");

  // Restoring does not have to re-create the fold table by hand: the module's
  // `IF NOT EXISTS` DDL runs per query, so a deserialized connection folds too.
  equal(query("-").total, 0, "...and still folds punctuation to nothing");

  // The image round-trips: serializing the restored index gives the same bytes.
  const again = e.idx_serialize();
  equal(again, imageLen, "the restored index serializes back to the same length");
  e.idx_close();
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("sqlite-core ABI: all checks passed");
