#!/usr/bin/env node
/*
 * lint-styles.mjs — the drift gate for the design system.
 *
 * The coherence pass put every font-size on a six-step scale and every control
 * on two heights, all declared ONCE in src/styles/00-tokens.css. This script
 * fails the build the moment a raw value reappears anywhere else, so the system
 * can't quietly erode back into the 19 ad-hoc sizes and 10 scattered heights it
 * replaced.
 *
 * HOW TO ADD A SIZE OR HEIGHT: you don't add a raw px in a component file — you
 * add (or reuse) a step in 00-tokens.css and reference it as `var(--fs-…)` /
 * `var(--control-h[-sm])`. That is the whole rule. If a genuinely one-off value
 * is unavoidable, it belongs in 00-tokens.css as a named token too.
 *
 * Two checks, over src/styles/*.css EXCEPT 00-tokens.css (the one file allowed
 * raw values — it defines them):
 *   1. font-size   — no `font-size: <number>`; every size must be a token.
 *   2. control height — no raw `height: <n>px` in the control band (>= 30px),
 *      which is where the two system heights (34 / 28) live and where a
 *      re-hardcoded control height would hide. Avatars (round initials tiles,
 *      not controls) are exempt; icon glyph sizes are all < 30px and so are
 *      naturally out of band. `min-height` / `max-height` / `line-height` are
 *      not matched.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const stylesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "styles");
const files = readdirSync(stylesDir)
  .filter((f) => f.endsWith(".css") && f !== "00-tokens.css")
  .sort();

const FS_RE = /font-size:\s*[0-9]/;
// `height:` not preceded by a letter or `-` (excludes min-/max-/line-height),
// capturing a raw px value.
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
