import { describe, it, expect } from "vitest";
import {
  fileKind,
  formatBytes,
  rawFileUrl,
  historyFileUrl,
  canPreviewHistory,
  PREVIEWABLE_IMAGE_TYPES,
} from "../../src/core/fileKind";

describe("fileKind", () => {
  it("classifies a verified note as a note", () => {
    expect(fileKind("note")).toBe("note");
  });

  // A `.mark` is structurally a thin `.note` and paints through the same pipeline.
  it("routes a .mark to the note stage, like the notebook it structurally is", () => {
    expect(fileKind("mark")).toBe("note");
  });

  it("lets a .mark preview its version history, like a note", () => {
    expect(canPreviewHistory("mark")).toBe(true);
  });

  it("classifies the previewable image types as images", () => {
    for (const t of ["png", "jpg", "jpeg", "webp", "gif"]) {
      expect(fileKind(t)).toBe("image");
    }
  });

  it("is case-insensitive about the extension", () => {
    expect(fileKind("PNG")).toBe("image");
    expect(fileKind("JPEG")).toBe("image");
  });

  // Security: SVG can carry <script>, so it is never an image here (stored-XSS risk).
  it("does NOT treat svg as a previewable image", () => {
    expect(fileKind("svg")).toBe("file");
    expect(PREVIEWABLE_IMAGE_TYPES).not.toContain("svg");
  });

  it("treats everything else — including pdf and the unknown — as no-preview", () => {
    for (const t of ["pdf", "spd", "txt", "html", "file", "", "note.png"]) {
      expect(fileKind(t)).toBe("file");
    }
  });
});

describe("rawFileUrl", () => {
  it("builds the versioned URL the endpoint requires", () => {
    expect(rawFileUrl("7", "a".repeat(32))).toBe(`/file/7?v=${"a".repeat(32)}`);
  });

  it("adds download=1 when the caller wants an attachment", () => {
    expect(rawFileUrl("7", "abc", { download: true })).toBe("/file/7?v=abc&download=1");
  });

  it("percent-encodes both the id and the hash", () => {
    expect(rawFileUrl("a b/c", "x&y")).toBe("/file/a%20b%2Fc?v=x%26y");
  });

  // The route 404s without `?v=` (that is what makes it immutable): no hash, no URL.
  it("returns null without a hash, rather than a URL that is certain to 404", () => {
    expect(rawFileUrl("7", null)).toBeNull();
    expect(rawFileUrl("7", "")).toBeNull();
  });

  // The live route 404s for trashed files, so a `"bin"` origin needs the bin route.
  it("mints the bin-scoped route for a trashed file, same contract throughout", () => {
    expect(rawFileUrl("7", "abc", { bin: true })).toBe("/api/controlplane/bin/file/7?v=abc");
    expect(rawFileUrl("7", "abc", { bin: true, download: true })).toBe("/api/controlplane/bin/file/7?v=abc&download=1");
    expect(rawFileUrl("a b/c", "x&y", { bin: true })).toBe("/api/controlplane/bin/file/a%20b%2Fc?v=x%26y");
    expect(rawFileUrl("7", null, { bin: true })).toBeNull();
  });
});

describe("historyFileUrl", () => {
  // A version's bytes come from the version-scoped path, not `/file/:id?v=`.
  it("builds the version-scoped raw route (md5 in the path, no ?v=)", () => {
    expect(historyFileUrl("7", "a".repeat(32))).toBe(`/api/controlplane/note/7/history/${"a".repeat(32)}/raw`);
  });

  it("adds download=1 when the caller wants an attachment", () => {
    expect(historyFileUrl("7", "abc", { download: true })).toBe("/api/controlplane/note/7/history/abc/raw?download=1");
  });

  it("percent-encodes both the id and the md5", () => {
    expect(historyFileUrl("a b/c", "x&y")).toBe("/api/controlplane/note/a%20b%2Fc/history/x%26y/raw");
  });

  it("returns null without an md5", () => {
    expect(historyFileUrl("7", null)).toBeNull();
    expect(historyFileUrl("7", "")).toBeNull();
  });
});

describe("canPreviewHistory", () => {
  it("admits the kinds with a viewer: note, spd, txt, and images", () => {
    for (const t of ["note", "spd", "txt", "png", "jpg", "jpeg", "webp", "gif"]) {
      expect(canPreviewHistory(t)).toBe(true);
    }
  });

  it("is case- and whitespace-insensitive", () => {
    expect(canPreviewHistory(" SPD ")).toBe(true);
    expect(canPreviewHistory("PNG")).toBe(true);
  });

  it("refuses the kinds with no viewer (pdf, svg, unknown)", () => {
    for (const t of ["pdf", "svg", "html", "doc", "", "file"]) {
      expect(canPreviewHistory(t)).toBe(false);
    }
  });
});

describe("formatBytes", () => {
  it("formats across the unit boundaries", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(15 * 1024 * 1024)).toBe("15 MB");
    expect(formatBytes(1024 ** 3)).toBe("1.0 GB");
  });

  it("does not pretend to know a size it wasn't given", () => {
    expect(formatBytes(Number.NaN)).toBe("—");
    expect(formatBytes(-1)).toBe("—");
  });
});
