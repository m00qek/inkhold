// The canvas painter's palettes and the `.txt` head reader.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { textHead, THUMB_PALETTES } from "../../src/render/thumbSeams";

/** A token's value in the first block opened by `selector` (in 00-tokens.css) that sets it. */
function token(css: string, selector: string, name: string): string {
  for (let at = css.indexOf(selector); at >= 0; at = css.indexOf(selector, at + 1)) {
    const block = css.slice(at, css.indexOf("}", at));
    const m = block.match(new RegExp(`--${name}:\\s*([^;]+);`));
    if (m) return m[1]!.trim();
  }
  throw new Error(`--${name} not set under ${selector}`);
}

describe("the thumbnail palettes", () => {
  // Regression: the painter read the page's tokens, not the asked theme's, and
  // stored dark .txt cards under the light theme for good.
  it("are the tokens of each theme, so a thumbnail drawn for one never wears the other", () => {
    const css = readFileSync(new URL("../../src/styles/00-tokens.css", import.meta.url), "utf8");
    for (const theme of ["light", "dark"] as const) {
      const sel = `:root[data-theme="${theme}"] {`;
      const p = THUMB_PALETTES[theme];
      const pairs: [string, string][] = [["sheet", p.paper], ["ink", p.ink], ["margin", p.margin], ["paper-rule", p.rule]];
      for (const [name, value] of pairs) expect(value, `${theme} --${name}`).toBe(token(css, sel, name));
    }
  });
});

describe("textHead", () => {
  const enc = (s: string) => new TextEncoder().encode(s);

  it("is the whole text when the bytes reached the end of the file", () => {
    expect(textHead(enc("one\ntwo"), false)).toBe("one\ntwo");
  });

  it("drops the last, possibly half, line when the read stopped short", () => {
    expect(textHead(enc("one\ntwo\nthr"), true)).toBe("one\ntwo");
  });

  it("never shows half a character cut at the boundary", () => {
    // "é" is two bytes; cut after the first one.
    const bytes = enc("Béjar\nCaballero, é").slice(0, -1);
    expect(textHead(bytes, true)).toBe("Béjar");
  });
});
