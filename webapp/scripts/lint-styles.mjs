#!/usr/bin/env node
/*
 * Design-system drift gate: fails when a raw `font-size` or a raw control-band
 * `height` (>= 30px, outside avatar rules) appears in src/styles/*.css other
 * than 00-tokens.css. New sizes go in 00-tokens.css as tokens.
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

console.log(`lint-styles: ${files.length} files clean — every size/height is a token.`);
