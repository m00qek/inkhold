// Reading `GET /api/controlplane/digests` as the server writes it: null
// optionals omitted, ids as numbers.

import { describe, it, expect } from "vitest";
import { digestsOf } from "../../src/api/httpDigest";

/** The Nomad's two digests on the hub (2026-11-10), as `handlers/digest.zig` lists them. */
const body = {
  success: true,
  enabled: true,
  categories: [{ uid: "kb-phon", name: "Phonétique" }, { name: "no uid" }],
  digests: [
    {
      id: 13, text: "La phonétique du français", comment: "yeah", categoryUid: "", author: "john",
      createdAt: 1794175867249, modifiedAt: 1794176056052,
      source: { kind: "document", path: "MyStyle/Français/La_phonetique_du_francais_Prof_Flavio_Adler.pdf", fileId: 57, page: 1 },
      note: "245354713d4c121a2368d9295f6379ca",
    },
    {
      id: 17, text: "This is a test note.", categoryUid: "kb-phon", createdAt: 1794354714865, modifiedAt: 1794354714866,
      source: { kind: "note", path: "Note/20261109_060644.note", page: 2 },
    },
    { text: "no id" },
  ],
};

describe("the digests' wire", () => {
  it("reads every field, absent optionals as null", () => {
    const s = digestsOf(body);
    expect(s.enabled).toBe(true);
    expect(s.categories).toEqual([{ uid: "kb-phon", name: "Phonétique" }]);
    expect(s.digests).toEqual([
      {
        id: "13", text: "La phonétique du français", comment: "yeah", categoryUid: "", author: "john", createdAt: 1794175867249,
        source: { kind: "document", path: "MyStyle/Français/La_phonetique_du_francais_Prof_Flavio_Adler.pdf", fileId: "57", page: 1 },
        note: "245354713d4c121a2368d9295f6379ca",
      },
      {
        id: "17", text: "This is a test note.", comment: null, categoryUid: "kb-phon", author: null, createdAt: 1794354714865,
        source: { kind: "note", path: "Note/20261109_060644.note", fileId: null, page: 2 },
        note: null,
      },
    ]);
  });

  it("reads off as off, an unknown kind as other, and a manual entry as having no path", () => {
    expect(digestsOf({ success: true, enabled: false } as never)).toEqual({ enabled: false, categories: [], digests: [] });
    const s = digestsOf({
      enabled: true,
      digests: [
        { id: 1, text: "x", source: { kind: "scroll", path: "Document/a.epub", page: 0 } },
        { id: 2, text: "y", source: { kind: "manual", path: "stray" } },
      ],
    });
    expect(s.digests.map((d) => d.source)).toEqual([
      { kind: "other", path: "Document/a.epub", fileId: null, page: null },
      { kind: "manual", path: null, fileId: null, page: null },
    ]);
  });
});
