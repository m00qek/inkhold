import { describe, it, expect } from "vitest";
import { contentSignal } from "../../src/pages/historyPanel";
import { formatBytes } from "../../src/core/fileKind";
import type { FileVersion } from "../../src/core/types";

function v(pageCount: number, size = 100_000): FileVersion {
  return { md5: `m${pageCount}-${size}`, size, createdAt: 0, current: false, pageCount };
}

describe("contentSignal", () => {
  it("a .note version shows its page count plus a signed delta vs the next-older", () => {
    const sig = contentSignal(v(17), v(15), true);
    expect(sig.pagesLabel).toBe("17 pages");
    expect(sig.deltaLabel).toBe("+2");
    expect(sig.deltaIsFirst).toBe(false);
    expect(sig.sizeLabel).toBeNull();
  });

  it("the OLDEST .note version (no older row) shows `created`, flagged first", () => {
    const sig = contentSignal(v(8), undefined, true);
    expect(sig.pagesLabel).toBe("8 pages");
    expect(sig.deltaLabel).toBe("created");
    expect(sig.deltaIsFirst).toBe(true);
  });

  it("singular page count reads `1 page`", () => {
    expect(contentSignal(v(1), undefined, true).pagesLabel).toBe("1 page");
  });

  it("a shrinking .note shows a minus delta; an unchanged one shows ±0", () => {
    expect(contentSignal(v(12), v(14), true).deltaLabel).toBe("−2");
    expect(contentSignal(v(12), v(12), true).deltaLabel).toBe("±0");
  });

  it("a NON-note kind (isNote false) shows the byte size, never pages, even with a pageCount", () => {
    // `pageCount` counts a .txt's paragraphs / a .spd's index rows, so non-notes show bytes.
    const sig = contentSignal(v(42, 2048), v(40, 1024), false);
    expect(sig.pagesLabel).toBeNull();
    expect(sig.deltaLabel).toBeNull();
    expect(sig.sizeLabel).toBe(formatBytes(2048));
  });

  it("a .note whose count did not resolve (pageCount 0) falls back to byte size", () => {
    const sig = contentSignal(v(0, 4096), v(0, 4096), true);
    expect(sig.pagesLabel).toBeNull();
    expect(sig.sizeLabel).toBe(formatBytes(4096));
  });
});
