// Ad-hoc smoke harness: drive spd-decode.wasm through its C-ABI against the
// committed `.spd` fixture and check the layer tree + tile geometry match the
// parser's Zig tests. Not part of CI. Run:
//   node scripts/spd_wasm_smoke.mjs zig-out/bin/spd-decode.wasm parsers/spd/tests/fixtures/layers_hidden.spd
import fs from "node:fs";

const [wasmPath, spdPath] = process.argv.slice(2);
const wasmBuf = fs.readFileSync(wasmPath);
const spd = fs.readFileSync(spdPath);

// Reactor with zero imports: instantiate, run _initialize once.
const { instance } = await WebAssembly.instantiate(wasmBuf, {});
const e = instance.exports;
e._initialize();

const mem = () => new Uint8Array(e.memory.buffer);
const dec = new TextDecoder();

// Copy the .spd into wasm memory and open it.
const ptr = e.spd_alloc(spd.length);
if (ptr === 0) throw new Error("spd_alloc OOM");
mem().set(spd, ptr);
const rc = e.spd_open(ptr, spd.length);
e.spd_free(ptr, spd.length);
if (rc !== 0) throw new Error(`spd_open failed: ${rc}`);

console.log(`doc: ${e.spd_doc_width()} x ${e.spd_doc_height()} px`);

const n = e.spd_layer_count();
console.log(`layers: ${n}`);
const layers = [];
for (let i = 0; i < n; i++) {
  const np = e.spd_layer_name_ptr(i);
  const nl = e.spd_layer_name_len(i);
  const name = dec.decode(mem().slice(np, np + nl));
  const layer = {
    id: e.spd_layer_id(i),
    name,
    visible: e.spd_layer_visible(i) === 1,
    opacity: e.spd_layer_opacity(i),
  };
  layers.push(layer);
  console.log(`  [${i}] id=${layer.id} "${layer.name}" vis=${layer.visible} op=${layer.opacity}`);
}

// Iterate layer 2's tiles and measure the bounding box + PNG-magic on each,
// mirroring the Zig "tid gate" test.
if (e.spd_tiles_begin(2) !== 0) throw new Error("tiles_begin(2) failed");
let count = 0,
  minX = Infinity,
  maxX = -Infinity,
  minY = Infinity,
  maxY = -Infinity,
  allPng = true;
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
let r;
while ((r = e.spd_tile_next()) === 1) {
  count++;
  const x = e.spd_tile_x(),
    y = e.spd_tile_y();
  minX = Math.min(minX, x);
  maxX = Math.max(maxX, x);
  minY = Math.min(minY, y);
  maxY = Math.max(maxY, y);
  const pp = e.spd_tile_png_ptr(),
    pl = e.spd_tile_png_len();
  const head = mem().slice(pp, pp + 8);
  if (!PNG.every((b, i) => head[i] === b)) allPng = false;
}
if (r < 0) throw new Error(`tile_next error: ${r}`);
console.log(`surface_2: ${count} tiles, x[${minX}..${maxX}] y[${minY}..${maxY}], allPNG=${allPng}`);

// Assert against the values locked into parsers/spd/tests/spd_test.zig.
function eq(got, want, label) {
  if (got !== want) throw new Error(`MISMATCH ${label}: got ${got}, want ${want}`);
}
eq(n, 4, "layer_count");
eq(layers.map((l) => l.id).join(","), "3,2,1,9999", "layer ids (Z-order)");
eq(layers[1].visible, false, "layer 2 hidden");
eq(layers[0].opacity, 102, "layer 3 opacity");
eq(layers[3].name, "Reference Layer", "reference layer name");
eq(count, 6, "surface_2 tile count");
eq(minX, 1950, "minX");
eq(maxX, 1951, "maxX");
eq(minY, 1948, "minY");
eq(maxY, 1950, "maxY");
eq(allPng, true, "every tile is a PNG");

// The empty reference layer must yield zero tiles, not an error.
if (e.spd_tiles_begin(9999) !== 0) throw new Error("tiles_begin(9999) failed");
eq(e.spd_tile_next(), 0, "reference layer yields 0 tiles");

// A non-SQLite blob must be rejected (WAL/bad-input path still lives in the parser).
const bad = e.spd_alloc(8);
mem().set([1, 2, 3, 4, 5, 6, 7, 8], bad);
eq(e.spd_open(bad, 8), -1, "non-SQLite blob rejected");
e.spd_free(bad, 8);

e.spd_close();
console.log("\nALL WASM-ABI CHECKS PASSED");
