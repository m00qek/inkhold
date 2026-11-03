#!/usr/bin/env node
/*
 * Postbuild: writes `.gz` (level 9) and `.br` (quality 11) siblings for
 * compressible files in dist/, so the Pi's static server (backend/http/static.zig)
 * never compresses on the fly. A variant not smaller than the raw file is
 * skipped. Fails the build when a pinned asset's gzip size exceeds its ceiling.
 */
import { gzipSync, brotliCompressSync, constants } from "node:zlib";
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname, basename } from "node:path";

const distDir = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");

const COMPRESS = new Set([".js", ".css", ".html", ".svg", ".json", ".wasm", ".map"]);

/**
 * Gzip ceilings in bytes, as measured by this script (node's zlib differs from
 * `gzip -9` by hundreds of bytes). Exceeding one fails the build.
 *
 * sqlite-core.wasm, 369,000: measured 365,858 after the typo ladder moved in
 * (+3,171). The ~3 KB headroom covers a few ordinary ABI additions (~600 B
 * each) but not a dropped `sqlite_core_wasm_flags` omission (`OMIT_JSON` alone
 * is +14,638), so flag-level regressions cannot hide. Raise a ceiling only
 * with a note here saying what bought the bytes.
 */
const CEILINGS = new Map([["sqlite-core.wasm", 369_000]]);

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

let count = 0;
let rawTotal = 0;
let gzTotal = 0;
let brTotal = 0;
const overweight = [];
/** Pinned names seen, so a renamed asset cannot silently lose its pin. */
const pinsSeen = new Set();

for (const file of walk(distDir)) {
  const ext = extname(file).toLowerCase();
  if (ext === ".gz" || ext === ".br") continue;
  if (!COMPRESS.has(ext)) continue;

  const raw = readFileSync(file);
  count += 1;
  rawTotal += raw.length;

  const gz = gzipSync(raw, { level: 9 });

  // Gzip is the floor every client supports, so the budget is measured in it.
  const ceiling = CEILINGS.get(basename(file));
  if (ceiling !== undefined) {
    pinsSeen.add(basename(file));
    if (gz.length > ceiling) overweight.push([basename(file), gz.length, ceiling]);
  }

  if (gz.length < raw.length) {
    writeFileSync(file + ".gz", gz);
    gzTotal += gz.length;
  } else {
    gzTotal += raw.length; // server would fall back to raw
  }

  const br = brotliCompressSync(raw, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 11,
      [constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
    },
  });
  if (br.length < raw.length) {
    writeFileSync(file + ".br", br);
    brTotal += br.length;
  } else {
    brTotal += raw.length; // server would fall back to raw
  }
}

const kb = (n) => (n / 1024).toFixed(1) + " KB";
console.log(
  `precompress: ${count} file(s)  raw ${kb(rawTotal)} → gzip ${kb(gzTotal)} → brotli ${kb(brTotal)}`,
);
for (const name of CEILINGS.keys()) {
  if (pinsSeen.has(name)) continue;
  // A pin whose file is missing (likely renamed) protects nothing.
  console.error(`precompress: FAIL — ${name} is pinned but was not found in dist/`);
  overweight.push([name, 0, CEILINGS.get(name)]);
}
if (overweight.length > 0) {
  for (const [name, actual, ceiling] of overweight) {
    if (actual === 0) continue;
    console.error(
      `precompress: FAIL — ${name} is ${actual} bytes gzipped, ceiling ${ceiling}` +
        ` (over by ${actual - ceiling}).`,
    );
  }
  console.error(
    "precompress: the ceiling is in scripts/precompress.mjs with the reasoning" +
      " that set it. Raise it deliberately, and say there what bought the bytes.",
  );
  process.exit(1);
}
