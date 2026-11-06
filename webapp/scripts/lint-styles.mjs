#!/usr/bin/env node
/*
 * Design-system drift gate: fails when a raw `font-size` or a raw control-band
 * `height` (>= 30px, outside avatar rules) appears in src/styles/*.css other
 * than 00-tokens.css, or when a type, spacing or control-height token there
 * is not in rem. New sizes go in 00-tokens.css as tokens.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const stylesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "styles");
const files = readdirSync(stylesDir)
  .filter((f) => f.endsWith(".css") && f !== "00-tokens.css")
  .sort();

const FS_RE = /font-size:\s*[0-9]/;
// Excludes min-/max-/line-height.
const H_RE = /(?<![a-z-])height:\s*(\d+)px/;

const problems = [];

for (const file of files) {
  const lines = readFileSync(join(stylesDir, file), "utf8").split("\n");
  let selectorLine = ""; // nearest preceding line that opened a rule
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes("{")) selectorLine = line;

    if (FS_RE.test(line)) {
      problems.push(
        `${file}:${i + 1}  raw font-size — use var(--fs-…):\n    ${line.trim()}`,
      );
    }

    const h = H_RE.exec(line);
    if (h) {
      const px = Number(h[1]);
      const isAvatar = /avatar/i.test(selectorLine);
      if (px >= 30 && !isAvatar) {
        problems.push(
          `${file}:${i + 1}  raw control height ${px}px — use var(--control-h) or var(--control-h-sm):\n    ${line.trim()}`,
        );
      }
    }
  }
}

// The tokens text and spacing come from follow the reader's text size: rem,
// never px (a touch target may floor itself with max(<px>, <rem>)).
const tokens = readFileSync(join(stylesDir, "00-tokens.css"), "utf8").split("\n");
const SCALED = /^\s*--(fs|sp|control-h|row-pad|hit-target)[a-z0-9-]*:\s*([^;]+);/;
for (let i = 0; i < tokens.length; i++) {
  const m = SCALED.exec(tokens[i]);
  if (!m || m[2].startsWith("var(")) continue;
  const value = m[2].trim();
  const floored = /^max\(\s*\d+px\s*,\s*[0-9.]+rem\s*\)$/.test(value);
  if (!floored && !/^[0-9.]+rem$/.test(value)) {
    problems.push(`00-tokens.css:${i + 1}  --${m[1]}… must be in rem so it follows the text size:\n    ${tokens[i].trim()}`);
  }
}

// Dead selectors: every class the styles name must be named by the app. A
// few are built from parts at runtime (`${block}__count`, `is-${state}`); they
// are listed here, so a new one is a decision, not an accident.
const BUILT = new Set([
  "admin-chip--admin", "admin-chip--pending", // adminParts: admin-chip--${kind}
  "is-cancelled", "is-tight", // transferList: is-${state}; adminParts: is-${tone}
  "findbar__ask", "findbar__count", "findbar__field", // findBar: ${block}__…
  "pdfbar__ask", "pdfbar__count", "pdfbar__field",
  "txtbar__ask", "txtbar__count", "txtbar__field",
  "ocr__body", // sidePanel: ${hookPrefix}__body
  "pdf-outline__row--d0", "pdf-outline__row--d1", "pdf-outline__row--d2", "pdf-outline__row--d3", // --d${depth}
]);
const srcDir = join(stylesDir, "..");
const sources = [join(srcDir, "..", "index.html")];
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const f = join(dir, e.name);
    if (e.isDirectory()) walk(f);
    else if (f.endsWith(".ts")) sources.push(f);
  }
};
walk(srcDir);
const code = sources.map((f) => readFileSync(f, "utf8")).join("\n");
for (const file of [...files, "00-tokens.css"]) {
  const css = readFileSync(join(stylesDir, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/url\([^)]*\)/g, "");
  for (const cls of new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]))) {
    if (BUILT.has(cls)) continue;
    if (!new RegExp(`(?<![\\w-])${cls}(?![\\w-])`).test(code)) problems.push(`${file}  .${cls} — no element in the app carries this class (dead, or add it to BUILT)`);
  }
}

if (problems.length) {
  console.error(
    `\nstyle drift: ${problems.length} raw value(s) that must come from 00-tokens.css\n`,
  );
  for (const p of problems) console.error("  " + p);
  console.error(
    "\nFix: add/reuse a token in src/styles/00-tokens.css and reference it as " +
      "var(--fs-…) or var(--control-h[-sm]).\n",
  );
  process.exit(1);
}

console.log(`lint-styles: ${files.length} files clean — every size/height is a token, and text and spacing tokens are rem.`);
