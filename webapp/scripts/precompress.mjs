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
 */
import { gzipSync, brotliCompressSync, constants } from "node:zlib";
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";

const distDir = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");

const COMPRESS = new Set([".js", ".css", ".html", ".svg", ".json", ".wasm", ".map"]);

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

for (const file of walk(distDir)) {
  const ext = extname(file).toLowerCase();
  if (ext === ".gz" || ext === ".br") continue; // never re-compress a variant
  if (!COMPRESS.has(ext)) continue; // skip media / fonts / everything else

  const raw = readFileSync(file);
  count += 1;
  rawTotal += raw.length;

  const gz = gzipSync(raw, { level: 9 });
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
