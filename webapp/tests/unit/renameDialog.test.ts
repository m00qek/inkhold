import { describe, it, expect } from "vitest";
import { peelName, validateRename } from "../../src/ui/renameDialog";
import { createFakeApi } from "../../src/api/fake";
import { NameTakenError } from "../../src/api/client";

describe("peelName — extension peel by fileType", () => {
  it("peels a single-dot name at its own fileType", () => {
    expect(peelName("Ozymandias.note", "note", false)).toEqual({ stem: "Ozymandias", ext: ".note" });
  });

  it("peels ONLY the trailing extension of a multi-dot name (not a naive last-dot split)", () => {
    // `2026.07.20.note` must keep the date in the stem.
    expect(peelName("2026.07.20.note", "note", false)).toEqual({ stem: "2026.07.20", ext: ".note" });
  });

  it("is case-insensitive and preserves the extension's ACTUAL casing", () => {
    expect(peelName("Sketch.NOTE", "note", false)).toEqual({ stem: "Sketch", ext: ".NOTE" });
  });

  it("treats the whole name as the stem when it does not end in the expected extension", () => {
    expect(peelName("lease agreement", "pdf", false)).toEqual({ stem: "lease agreement", ext: "" });
    expect(peelName("archive.zip", "note", false)).toEqual({ stem: "archive.zip", ext: "" });
  });

  it("a folder (no extension) is all stem, no chip", () => {
    expect(peelName("Projects", "", true)).toEqual({ stem: "Projects", ext: "" });
    expect(peelName("Q3.plans", "", true)).toEqual({ stem: "Q3.plans", ext: "" });
  });

  it("does not peel a bare-dot or empty type", () => {
    expect(peelName(".hidden", "", false)).toEqual({ stem: ".hidden", ext: "" });
  });
});

describe("validateRename — the stem gate", () => {
  const ORIGINAL = "Ozymandias";

  it("disables on an empty or whitespace-only stem, with the helper line", () => {
    expect(validateRename("", ORIGINAL)).toEqual({ ok: false, message: "Enter a name." });
    expect(validateRename("   ", ORIGINAL)).toEqual({ ok: false, message: "Enter a name." });
  });

  it("disables when the stem contains a path separator", () => {
    expect(validateRename("a/b", ORIGINAL)).toEqual({ ok: false, message: "A name can't contain '/'." });
  });

  it("disables on a control character", () => {
    expect(validateRename("line" + String.fromCharCode(0) + "break", ORIGINAL).ok).toBe(false);
    expect(validateRename("tab\tname", ORIGINAL).ok).toBe(false);
  });

  it("disables when the stem is unchanged — quietly (no error line)", () => {
    expect(validateRename(ORIGINAL, ORIGINAL)).toEqual({ ok: false, message: null });
    expect(validateRename("  Ozymandias  ", ORIGINAL)).toEqual({ ok: false, message: null });
  });

  it("allows a non-empty, legal, changed stem", () => {
    expect(validateRename("Kubla Khan", ORIGINAL)).toEqual({ ok: true, message: null });
  });
});

describe("api.rename (fake) — NameTaken on a sibling clash", () => {
  it("renames the fixture entry in place and returns the updated entry", async () => {
    const api = createFakeApi({ latencyMs: 0 });
    const updated = await api.rename("102", "Ideas — reorganised.note");
    expect(updated.name).toBe("Ideas — reorganised.note");

    const listing = await api.listFolder("note");
    expect(listing.entries.some((e) => e.id === "102" && e.name === "Ideas — reorganised.note")).toBe(true);
  });

  it("rejects with NameTakenError when a sibling in the same parent already has the name", async () => {
    const api = createFakeApi({ latencyMs: 0 });
    // `102` and `101` live in the same folder.
    await expect(api.rename("102", "Weekly review")).rejects.toBeInstanceOf(NameTakenError);
  });

  it("allows a name that only clashes with an entry in a DIFFERENT folder", async () => {
    const api = createFakeApi({ latencyMs: 0 });
    // "Cornell notes" lives in `mystyle`, so it is not a sibling of `102`.
    const updated = await api.rename("102", "Cornell notes");
    expect(updated.name).toBe("Cornell notes");
  });
});
