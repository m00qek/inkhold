// Every font embedded in `pdf-decode.wasm` (`webapp/wasm/book_fonts.zig`) is
// named, with its licence, in the notices `webapp/dist` ships: the release
// archive and the container image both carry `dist` whole.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

describe("third-party notices", () => {
  const notices = read("../../public/THIRD-PARTY-NOTICES.txt");
  const embedded = [...read("../../wasm/book_fonts.zig").matchAll(/font\("([^"]+)"\)/g)].map((m) => m[1]!);

  it("finds the embedded fonts", () => {
    expect(embedded.length).toBeGreaterThan(0);
  });

  it("names the family of each embedded font", () => {
    for (const file of embedded) {
      const family = file.replace(/(-[A-Za-z]+)?\.(cff|otf|ttf)$/, "").replace(/([a-z])([A-Z])/g, "$1 $2");
      expect(notices, file).toContain(family);
    }
  });

  it("carries the Open Font License in full", () => {
    expect(notices).toContain("SIL OPEN FONT LICENSE Version 1.1");
    expect(notices).toContain("PERMISSION & CONDITIONS");
    expect(notices).toContain("DISCLAIMER");
  });
});
