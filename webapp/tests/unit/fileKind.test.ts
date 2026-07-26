import { describe, it, expect } from "vitest";
import {
  fileKind,
  formatBytes,
  rawFileUrl,
  historyFileUrl,
  canPreviewHistory,
  PREVIEWABLE_IMAGE_TYPES,
} from "../../src/core/fileKind";

// The rule that decides what the reader does with a file. It is small, but it is
// the whole fix for "a PNG opens a blank canvas" — and one half of it (the SVG
// exclusion) is a security decision that has to stay pinned.

describe("fileKind", () => {
  it("classifies a verified note as a note", () => {
    expect(fileKind("note")).toBe("note");
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

  // THE SECURITY CASE, and the reason this is a test rather than a comment.
  // SVG is an image by every intuition and an XML *document* in fact: it can
  // carry <script>, so the server refuses to serve it `inline` (see
  // inline_types in handlers/controlplane.zig). Classifying it as an image here
  // would put a broken <img> on screen at best, and would be one careless
  // <object>/<iframe> away from same-origin stored XSS at worst.
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

  // The route 404s a missing `?v=` by design — that is what lets it answer
  // `immutable`. So "no hash" must mean "no URL", not "a URL that always fails".
  it("returns null without a hash, rather than a URL that is certain to 404", () => {
    expect(rawFileUrl("7", null)).toBeNull();
    expect(rawFileUrl("7", "")).toBeNull();
  });

  // The bin option mints the TRASHED twin: the live route goes through
  // `Files.get` (`deleted = 0`) and 404s for anything in the recycle bin, so a
  // viewer with a `"bin"` origin has to fetch from the bin-scoped route — with
  // the same `?v=` contract, download flag and null-without-hash honesty.
  it("mints the bin-scoped route for a trashed file, same contract throughout", () => {
    expect(rawFileUrl("7", "abc", { bin: true })).toBe("/api/controlplane/bin/file/7?v=abc");
    expect(rawFileUrl("7", "abc", { bin: true, download: true })).toBe("/api/controlplane/bin/file/7?v=abc&download=1");
    expect(rawFileUrl("a b/c", "x&y", { bin: true })).toBe("/api/controlplane/bin/file/a%20b%2Fc?v=x%26y");
    expect(rawFileUrl("7", null, { bin: true })).toBeNull();
  });
});

describe("historyFileUrl", () => {
  // The HISTORY twin of the bin route: a version's raw bytes come off a
  // version-scoped path (the `:md5` pins the immutable blob), NOT `/file/:id?v=`
  // which only ever serves the current blob. This is the one URL the `.spd`/`.txt`/
  // image history preview fetches through.
  it("builds the version-scoped raw route (md5 in the path, no ?v=)", () => {
    expect(historyFileUrl("7", "a".repeat(32))).toBe(`/api/controlplane/note/7/history/${"a".repeat(32)}/raw`);
  });

  it("adds download=1 when the caller wants an attachment", () => {
    expect(historyFileUrl("7", "abc", { download: true })).toBe("/api/controlplane/note/7/history/abc/raw?download=1");
  });

  it("percent-encodes both the id and the md5", () => {
    expect(historyFileUrl("a b/c", "x&y")).toBe("/api/controlplane/note/a%20b%2Fc/history/x%26y/raw");
  });

  // Same null-without-a-hash honesty as `rawFileUrl`: no md5 means no addressable
  // URL, not a URL that is certain to 404.
  it("returns null without an md5", () => {
    expect(historyFileUrl("7", null)).toBeNull();
    expect(historyFileUrl("7", "")).toBeNull();
  });
});

describe("canPreviewHistory", () => {
  // The shared gate behind the "Version history" card item and the preview
  // dispatch. It admits every kind with a viewer to paint a past version…
  it("admits the kinds with a viewer: note, spd, txt, and images", () => {
    for (const t of ["note", "spd", "txt", "png", "jpg", "jpeg", "webp", "gif"]) {
      expect(canPreviewHistory(t)).toBe(true);
    }
  });

  it("is case- and whitespace-insensitive", () => {
    expect(canPreviewHistory(" SPD ")).toBe(true);
    expect(canPreviewHistory("PNG")).toBe(true);
  });

  // …and nothing else — a pdf, an svg (never a previewable image), the unknown.
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
