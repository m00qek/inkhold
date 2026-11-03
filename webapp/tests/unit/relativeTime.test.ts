import { describe, it, expect } from "vitest";
import { relativeTime, absoluteTime } from "../../src/ui/relativeTime";

const S = 1000;
const M = 60 * S;
const H = 60 * M;
const D = 24 * H;
const NOW = 1_752_800_000_000;

describe("relativeTime", () => {
  it("clamps just-now, sub-minute, and FUTURE stamps to 'just now'", () => {
    expect(relativeTime(NOW, NOW)).toBe("just now");
    expect(relativeTime(NOW - 10 * S, NOW)).toBe("just now");
    expect(relativeTime(NOW + 5 * M, NOW)).toBe("just now");
  });

  it("minutes, hours, and days — singular and plural", () => {
    expect(relativeTime(NOW - M, NOW)).toBe("1 minute ago");
    expect(relativeTime(NOW - 5 * M, NOW)).toBe("5 minutes ago");
    expect(relativeTime(NOW - H, NOW)).toBe("1 hour ago");
    expect(relativeTime(NOW - 3 * H, NOW)).toBe("3 hours ago");
    expect(relativeTime(NOW - D, NOW)).toBe("yesterday");
    expect(relativeTime(NOW - 2 * D, NOW)).toBe("2 days ago");
  });

  it("months and years", () => {
    expect(relativeTime(NOW - 60 * D, NOW)).toBe("2 months ago");
    expect(relativeTime(NOW - 400 * D, NOW)).toBe("1 year ago");
    expect(relativeTime(NOW - 800 * D, NOW)).toBe("2 years ago");
  });

  it("a malformed (0) stamp reads as 'just now' rather than an epoch date", () => {
    // An unusable createdAt normalizes to 0 and must clamp, not print "55 years ago".
    expect(relativeTime(0, 0)).toBe("just now");
  });
});

describe("absoluteTime", () => {
  it("renders a full date and time (the row's title tooltip)", () => {
    const s = absoluteTime(NOW);
    expect(s).toMatch(/\d{4}/);
    expect(s).toContain(",");
  });
});
