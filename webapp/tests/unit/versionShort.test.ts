import { describe, it, expect } from "vitest";
import { SHORT_LEN, shortMd5, resolveVersionShort } from "../../src/pages/versionShort";
import type { FileVersion } from "../../src/core/types";

// A 7-hex md5 prefix resolved against the newest-first version list; live first, so a
// restored past md5 resolves as current.

const v = (md5: string, current = false): FileVersion => ({
  md5,
  size: 1000,
  createdAt: 1_700_000_000_000,
  current,
});

const CURRENT = "aaaaaaa0000000000000000000000000";
const PAST_1 = "bbbbbbb1111111111111111111111111";
const PAST_2 = "ccccccc2222222222222222222222222";
const list: FileVersion[] = [v(CURRENT, true), v(PAST_1), v(PAST_2)];

describe("shortMd5", () => {
  it("takes the first 7 hex chars, lower-cased", () => {
    expect(SHORT_LEN).toBe(7);
    expect(shortMd5(CURRENT)).toBe("aaaaaaa");
    expect(shortMd5("ABC123Fdeadbeef")).toBe("abc123f");
  });
});

describe("resolveVersionShort", () => {
  it("resolves a PAST version's prefix to that version", () => {
    const r = resolveVersionShort(list, shortMd5(PAST_1));
    expect(r).toEqual({ kind: "past", version: list[1] });
  });

  it("resolves the CURRENT blob's prefix to current (live-first, never 404)", () => {
    const r = resolveVersionShort(list, shortMd5(CURRENT));
    expect(r).toEqual({ kind: "current", version: list[0] });
  });

  it("returns none for a prefix that aged out of the hot cache / is unknown", () => {
    expect(resolveVersionShort(list, "9999999")).toEqual({ kind: "none" });
    expect(resolveVersionShort([], "aaaaaaa")).toEqual({ kind: "none" });
  });

  it("is case-insensitive on the prefix", () => {
    expect(resolveVersionShort(list, "BBBBBBB")).toEqual({ kind: "past", version: list[1] });
  });

  it("resolves an ambiguous prefix to the NEWEST match (list is newest-first)", () => {
    const shared = [v("deadbee_newer".padEnd(32, "0"), true), v("deadbee_older".padEnd(32, "0"))];
    expect(resolveVersionShort(shared, "deadbee")).toEqual({ kind: "current", version: shared[0] });
  });
});
