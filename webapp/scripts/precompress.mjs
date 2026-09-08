#!/usr/bin/env node
/*
 * precompress.mjs — build-time static asset compression.
 *
 * The RPi serving this SPA has no CPU to spare compressing responses on the fly,
 * so we do it ONCE here (postbuild) and let the static server pick the right
 * pre-made variant per request's Accept-Encoding. For every COMPRESSIBLE file
 * under dist/ we write two siblings next to it:
 *
 *   <file>.gz  — gzip, level 9
 *   <file>.br  — brotli, quality 11, with the exact size hint
 *
 * The server (backend/http/static.zig) prefers <file>.br, then <file>.gz,
 * then the raw file, negotiating on Accept-Encoding. dist/ is gitignored, so
 * these variants are build output — only THIS script is committed.
 *
 * Rules:
 *   - Compress:  .js .css .html .svg .json .wasm .map
 *   - Skip:      already-compressed media (.woff2 .woff .png .jpg .jpeg .webp
 *                .gif .ico .avif) and never re-compress a .gz/.br.
 *   - Don't write a variant that isn't actually smaller than the raw file — that
 *     way the server correctly falls back to raw for tiny inputs.
 *   - FAIL THE BUILD when a pinned asset's gzip size exceeds its ceiling. See
 *     CEILINGS below.
 */
import { gzipSync, brotliCompressSync, constants } from "node:zlib";
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname, basename } from "node:path";

const distDir = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");

const COMPRESS = new Set([".js", ".css", ".html", ".svg", ".json", ".wasm", ".map"]);

/**
 * Gzip ceilings, by file name, in bytes. Exceeding one FAILS THE BUILD.
 *
 * `client-side-search.md` §9.6 — *"size is the cost, not CPU"* — and
 * `wasm-search-bench.md` §10 — *"every risk left in the plan is a size risk"*.
 * Both are true and neither is enforceable by reading. A budget nobody checks is
 * not a budget, so it is checked here, where the number actually exists.
 *
 * ## sqlite-core.wasm — 366,000
 *
 * MEASURED at 362,687 gzip (828,562 raw) when the pin was written — measured BY
 * THIS SCRIPT, which is the number that matters because this script is the gate.
 * Note that `gzip -9` on the command line answers 362,009 for the same bytes;
 * node's zlib and GNU gzip make different deflate choices, and quoting one
 * against the other is a 678-byte mistake waiting to happen. The deltas below
 * are all command-line figures, so they are consistent with each other.
 *
 * The headroom is 3,313 bytes, chosen against two measurements rather than
 * picked for roundness:
 *
 *   - **Above ordinary growth.** Replacing the benchmark's `fb_*` ABI with the
 *     shipping `idx_*` one — a whole new ABI, sixteen exports, a query builder,
 *     a tokenizer fold and the build-flag guard — cost 617 bytes over the
 *     826,206 / 361,392 the bench measured. The headroom is five of those.
 *   - **Below the cheapest regression it exists to catch.** Dropping ONE
 *     omission from `sqlite_core_wasm_flags` costs far more: `-DSQLITE_OMIT_JSON`
 *     alone measured +14,638 bytes, 4.4x the headroom. Turning FTS5 off entirely
 *     is -71,130. So every flag-level change trips this, in either direction of
 *     intent, and none of them can land unnoticed.
 *
 * The absolute number matters because this module is the dominant term in the
 * first-visit budget (`client-side-search.md` §6: ~537 KB), and it is downloaded
 * by anyone who searches or opens a `.spd`.
 *
 * **Raising a ceiling is a legitimate act** — a feature may be worth its bytes.
 * Raising it without saying what bought the bytes is not; the number above is
 * the record.
 */
const CEILINGS = new Map([["sqlite-core.wasm", 366_000]]);

/** Recursively yield every file path under `dir`. */
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
/** Pinned assets that came in over their ceiling, reported together at the end. */
const overweight = [];
/** Pinned names actually seen, so a RENAMED asset cannot silently lose its pin. */
const pinsSeen = new Set();

for (const file of walk(distDir)) {
  const ext = extname(file).toLowerCase();
  if (ext === ".gz" || ext === ".br") continue; // never re-compress a variant
  if (!COMPRESS.has(ext)) continue; // skip media / fonts / everything else

  const raw = readFileSync(file);
  count += 1;
  rawTotal += raw.length;

  const gz = gzipSync(raw, { level: 9 });

  // THE SIZE PIN. Gzip rather than brotli because gzip is the floor every client
  // supports, so it is the size the budget was measured in.
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
  // A pin whose file is not in dist/ is a pin that stopped protecting anything —
  // most likely because the asset was renamed, which is exactly when a size
  // budget goes quiet without anybody deciding to drop it.
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
