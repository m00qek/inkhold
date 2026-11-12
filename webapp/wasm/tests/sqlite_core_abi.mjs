// ABI check for `sqlite-core.wasm` (`zig build wasm-sqlite-core-test`): the
// TEMP_STORE refusal (a dropped flag is otherwise unobservable), both ABIs in
// one instance, rowid kinds, fields and phrases, and the typo ladder (its only
// description since it left the server).
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

// Real WASI, so an accidental syscall from the OS_OTHER build is a wrong answer
// rather than a swallowed error.
async function freshInstance() {
  const wasi = new WASI({ version: "preview1", args: [], env: {} });
  const instance = await WebAssembly.instantiate(mod, wasi.getImportObject());
  wasi.initialize(instance);
  return instance.exports;
}

let e = await freshInstance();

/**
 * Copies a string into wasm memory as UTF-8; returns [ptr, byteLength]. One
 * extra byte, since the empty query is real and needs an address.
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

function errorText() {
  const n = e.idx_errmsg_len();
  if (n === 0) return "";
  return Buffer.from(new Uint8Array(e.memory.buffer, e.idx_errmsg_ptr(), n)).toString("utf8");
}

function query(text, limit = 10) {
  const buf = put(text);
  const total = e.idx_query(buf[0], buf[1], limit);
  const hits = [];
  if (total >= 0) {
    // Up to `limit` of each kind: read until the -1 past the last.
    for (let i = 0, h = e.idx_hit(0); i < total && h >= 0; h = e.idx_hit(++i)) hits.push(h);
  }
  drop(buf);
  return { total, hits, expansion: expansionText() };
}

function fuzzy(text, limit = 10) {
  const buf = put(text);
  const total = e.idx_fuzzy(buf[0], buf[1], limit);
  const hits = [];
  if (total >= 0) {
    // Up to `limit` of each kind: read until the -1 past the last.
    for (let i = 0, h = e.idx_hit(0); i < total && h >= 0; h = e.idx_hit(++i)) hits.push(h);
  }
  drop(buf);
  return { total, hits, expansion: expansionText() };
}

/**
 * What the ladder substituted, as `typed>matched` pairs joined by `,`; "" when
 * nothing. Copied out right away: `memory` can grow on any call.
 */
function expansionText() {
  const n = e.idx_expansion_len();
  if (n === 0) return "";
  return Buffer.from(new Uint8Array(e.memory.buffer, e.idx_expansion_ptr(), n))
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t").join(">"))
    .join(",");
}

// ---- exports (both ABIs, one module) ----
for (const name of [
  "idx_alloc", "idx_free",
  "idx_open", "idx_close", "idx_begin", "idx_add", "idx_commit",
  "idx_query", "idx_hit", "idx_kind_total", "idx_delete",
  "idx_fuzzy", "idx_expansion_ptr", "idx_expansion_len",
  "idx_errmsg_ptr", "idx_errmsg_len",
  "spd_alloc", "spd_free", "spd_open", "spd_close",
  "spd_layer_count", "spd_layer_id", "spd_tiles_begin", "spd_tile_next",
  "memory",
]) {
  check(e[name] !== undefined, `export \`${name}\` is present`);
}
if (failures > 0) process.exit(1);

// ---- the build flag ----
// -100: built without -DSQLITE_TEMP_STORE=3.
const opened = e.idx_open();
check(
  opened !== -100,
  "the artifact was built with -DSQLITE_TEMP_STORE=3",
  errorText(),
);
equal(opened, 0, "an index opens on a fresh instance");
if (failures > 0) process.exit(1);


// ---- build ----
// Real diacritics: documents 1 and 2 spell the same word differently.
const CORPUS = [
  [11, "reunião de caligrafia às terças"],
  [12, "reuniao semanal do projeto"],
  [13, "caligrafia japonesa"],
  [14, "notas sobre o projeto de dados"],
  // `tset` is one edit from both `test` and `set`.
  [15, "test do set"],
];

equal(e.idx_begin(), 0, "a build transaction opens");
for (const [id, body] of CORPUS) {
  const buf = put(body);
  equal(e.idx_add(id, buf[0], buf[1]), 0, `document ${id} is indexed`);
  drop(buf);
}
equal(e.idx_commit(), 0, "the build transaction commits");

// A repeated document id must be refused, not overwrite.
{
  const buf = put("outro documento");
  check(e.idx_add(11, buf[0], buf[1]) !== 0, "a repeated document id is refused, not overwritten");
  check(/UNIQUE|constraint/i.test(errorText()), "...and says why", errorText());
  drop(buf);
}

// ---- query ----
// "reunião" and "reuniao" are one term: pins `tokenize=` to the server's.
{
  const a = query("reunião ");
  const b = query("REUNIAO ");
  equal(a.total, 2, "an accented query finds the unaccented document too");
  equal(b.total, 2, "an uppercase unaccented query finds the accented one");
  equal(a.hits.slice().sort().join(","), "11,12", "...and they are the right two documents");
}

// A prefix on the last token, but not after a trailing space.
equal(query("cali").total, 2, "an unfinished last word matches as a prefix");
equal(query("cali ").total, 0, "...and a trailing space turns that off");
equal(query("caligrafia ").total, 2, "a completed word still matches exactly");

{
  const r = query("projeto reuni");
  equal(r.total, 1, "two tokens narrow rather than widen");
  equal(r.hits[0], 12, "...to the document that has both");
}

// These fold to no terms; each would be a plausible FTS5 syntax error.
for (const junk of ["", "   ", "-", "\"", "\"\"", "...", "( )", "*"]) {
  equal(query(junk).total, 0, `\`${JSON.stringify(junk)}\` is no results rather than an error`);
}
equal(query('"caligrafia" ').total, 2, "a quoted word searches for the word");

// The total is exact and independent of `limit`.
{
  const r = query("caligrafia ", 1);
  equal(r.total, 2, "the total counts every match, not just the ones returned");
  equal(r.hits.length, 1, "...while `limit` caps what is buffered");
  equal(e.idx_hit(1), -1, "a hit past the buffered ones is -1");
  equal(e.idx_hit(99), -1, "an out-of-range hit index is -1");
}

// ---- the typo ladder ----

// A query that matched is answered exactly, with an empty expansion.
{
  const r = fuzzy("caligrafia ");
  equal(r.total, 2, "a query that matches is answered by the exact pass");
  equal(r.expansion, "", "...and nothing is reported as substituted");
  equal(fuzzy("reuniao ").total, 2, "an accented-fold match needs no ladder either");
  equal(fuzzy("reuniao ").expansion, "", "...and reports no substitution");
}

// `idx_query` never expands.
{
  const r = query("reunaio ");
  equal(r.total, 0, "`idx_query` alone still answers a typo with nothing");
  equal(r.expansion, "", "...and sets no expansion");
}

// A swap is one edit, so "reunaio" reaches "reuniao".
{
  const r = fuzzy("reunaio ");
  equal(r.total, 2, "a transposed query falls back onto the real word");
  equal(r.expansion, "reunaio>reuniao", "...and says what it searched instead");
  equal(r.hits.slice().sort().join(","), "11,12", "...finding the same two documents");
}

// The ≤3 rung: "das" gets nothing, "nota" reaches "notas".
{
  const short = fuzzy("das ");
  equal(short.total, 0, "a 3-character token gets no expansion");
  equal(short.expansion, "", "...even though `as` is one edit away");
  const long = fuzzy("nota ");
  equal(long.total, 1, "a 4-character token is one rung up and does expand");
  equal(long.expansion, "nota>notas", "...to the vocabulary term one edit away");
}

// Only the best tier: `tset` gets `test` (swap, delta 0), not `set` (delta 1).
{
  const r = fuzzy("tset ");
  equal(r.expansion, "tset>test", "the closest reading wins outright");
  equal(r.total, 1, "...and only its document comes back");
  equal(r.hits[0], 15, "...which is the one holding `test`");
}

// A multi-token query still narrows (explicit AND around the OR-group).
{
  const r = fuzzy("projeto reunaio ");
  equal(r.total, 1, "an expanded token still ANDs with the token beside it");
  equal(r.hits[0], 12, "...to the document that has both");
  equal(r.expansion, "reunaio>reuniao", "...and only the misspelt token expands");
}

// Mid-typing, "calugraf" is compared with "caligrafia"[0..8]: one edit.
{
  const r = fuzzy("calugraf");
  equal(r.total, 2, "a typo inside a half-typed word is still corrected");
  equal(r.expansion, "calugraf>caligrafia", "...to the term it was truncated against");
}

// No space after it, but typed in full and a letter short: the whole term answers.
{
  const r = fuzzy("caligafia");
  equal(r.total, 2, "a whole word missing a letter, not yet followed by a space, is still corrected");
  equal(r.expansion, "caligafia>caligrafia", "...to the whole term");
}

for (const junk of ["", "   ", "-", "..."]) {
  equal(fuzzy(junk).total, 0, `fuzzy ${JSON.stringify(junk)} is no results rather than an error`);
  equal(fuzzy(junk).expansion, "", `...and substitutes nothing`);
}
equal(fuzzy("xilofone ").total, 0, "a word the vocabulary cannot approach stays unmatched");
equal(fuzzy("xilofone ").expansion, "", "...and reports no substitution");

// The fold table is reset with 'delete-all' (DELETE leaves FTS5 tombstones),
// so the 200th query answers like the first.
{
  let drifted = 0;
  for (let i = 0; i < 200; i++) {
    if (query(i % 2 === 0 ? "reunião " : "japonesa ").total !== (i % 2 === 0 ? 2 : 1)) drifted += 1;
  }
  equal(drifted, 0, "the query fold does not accumulate across 200 searches");
}

// ---- rowids and fields ----
{
  const buf = put("x");
  equal(e.idx_add(2 ** 31, buf[0], buf[1]), -25, "a rowid past the last kind is refused (SQLITE_RANGE)");
  check(/out of range/.test(errorText()), "...and says why", errorText());
  const five = put("a\x1fb\x1fc\x1fd\x1fe");
  equal(e.idx_add(2 ** 28 + 99, five[0], five[1]), -25, "an item row with more fields than columns is refused");
  drop(buf);
  drop(five);
  // A page is one field, whatever its text holds: find in a document indexes it raw.
  const page = put("a\x1fb\x1fc\x1fd\x1fe word");
  equal(e.idx_add(98, page[0], page[1]), 0, "a page's text is never split, separators and all");
  drop(page);
  equal(e.idx_delete(98), 0, "...and goes like any row");
}

// ---- kinds of row ----
// A rowid's top bits are its kind (`rowid >> 28`); kind 0 is a document page,
// a set of words, and the others are running text.
const TEXT = 1 << 28;
const TODO = 2 << 28;
{
  e.idx_begin();
  for (const [id, body] of [
    // A page whose words are those of the phrase, out of order.
    [16, "set chart color"],
    [TEXT + 1, "color chart for the kitchen"],
    [TODO + 1, "chart the color of the kitchen"],
    [TODO + 2, "paint the kitchen"],
    // Two fields: a phrase never runs from one into the next.
    [TODO + 3, "buy milk\x1finbox"],
  ]) {
    const buf = put(body);
    equal(e.idx_add(id, buf[0], buf[1]), 0, `row ${id} is indexed`);
    drop(buf);
  }
  e.idx_commit();

  const all = query("kitchen ");
  equal(all.total, 3, "one query answers every kind of row");
  equal(e.idx_kind_total(0), 0, "...and counts each kind on its own: no page says kitchen");
  equal(e.idx_kind_total(1), 1, "...one text row");
  equal(e.idx_kind_total(2), 2, "...two to-dos");
  equal(e.idx_kind_total(9), 0, "a kind past the last is none");

  const capped = query("kitchen ", 1);
  equal(capped.total, 3, "the limit caps what is buffered, per kind, not the total");
  equal(capped.hits.length, 2, "...one hit of each kind that has any");

  // In order on text rows; only the words on a page (phrase.ts checks there).
  const phrase = query('"color chart" ');
  equal(phrase.hits.slice().sort((a, b) => a - b).join(","), `16,${TEXT + 1}`, "a quoted phrase finds the text row holding it in order, and every page with its words");
  equal(e.idx_kind_total(2), 0, "...but not the to-do with the words apart");
  equal(query('"color char').hits.includes(TEXT + 1), true, "a phrase still being typed matches its last word as a start");
  equal(query('"color char" ').hits.includes(TEXT + 1), false, "...and a closed one matches it whole");
  equal(query('"kitchen" paint').total, 1, "a single quoted word is just a word");
  equal(query('"the kitchen" paint').hits[0], TODO + 2, "a phrase ANDs with the words beside it");
  equal(query('"milk inbox" ').total, 0, "a phrase is held within one field");
  equal(query("milk inbox ").hits[0], TODO + 3, "...while the words alone may come from any of them");

  // The typo ladder keeps the order: its best near-miss stands in.
  {
    const r = fuzzy('"colour chart" ');
    equal(r.expansion, "colour>color", "a misspelt word in a phrase is corrected");
    check(r.hits.includes(TEXT + 1) && !r.hits.includes(TODO + 1), "...and the phrase still holds its order", r.hits.join(","));
    equal(e.idx_kind_total(1), 1, "...and the widened pass counts each kind too");
    equal(e.idx_kind_total(2), 0, "...a kind it found nothing in, as none");
  }

  equal(e.idx_delete(TODO + 1), 0, "a row is deleted by its rowid");
  equal(query("kitchen ").total, 2, "...and no longer answers");
  equal(e.idx_delete(TODO + 1), 0, "deleting a row already gone is no error");
  for (const id of [16, TEXT + 1, TODO + 2, TODO + 3]) e.idx_delete(id);
  equal(query("kitchen ").total, 0, "the kinds' rows are gone again");
}

// ---- the .spd half of the same instance ----
// Values match `parsers/spd/tests/spd_test.zig`.
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

equal(query("reunião ").total, 2, "the search index still answers after a .spd parse");

// ---- closed ----
e.idx_close();
// -21 is SQLITE_MISUSE: no open database.
equal(query("reunião ").total, -21, "a query with no open index is refused");
equal(fuzzy("reunaio ").total, -21, "...and so is a fuzzy one, with the same code");
equal(e.idx_delete(11), -21, "...and so is a delete");

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("sqlite-core ABI: all checks passed");
