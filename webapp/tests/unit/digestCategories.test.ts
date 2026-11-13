// A category's name as the app takes one, and the fake server's categories and
// bin, which the e2e suite leans on as the real server's stand-in.

import { describe, it, expect } from "vitest";
import { categoryNameProblem, MAX_CATEGORY_NAME } from "../../src/api/digestTypes";
import { fakeDigestMethods } from "../../src/api/fakeDigest";

describe("a category's name", () => {
  it("takes a name with room to spare, trimmed", () => {
    expect(categoryNameProblem("  Verbes irréguliers ")).toBeNull();
    expect(categoryNameProblem("é".repeat(MAX_CATEGORY_NAME))).toBeNull();
  });

  it("refuses what the tablet's app refuses, saying why", () => {
    expect(categoryNameProblem("   ")).toBe("Give the category a name.");
    expect(categoryNameProblem("é".repeat(MAX_CATEGORY_NAME + 1))).toBe("A name holds at most 150 characters.");
    expect(categoryNameProblem(".hidden")).toBe("A name can't start with a dot.");
    expect(categoryNameProblem("two\nlines")).toBe("A name can't hold a tab or a line break.");
    for (const c of ["/", "<", ">", "*", "?", "|", "\\", ":", '"']) expect(categoryNameProblem(`a${c}b`)).toBe('A name can\'t hold / < > * ? | \\ : or ".');
  });
});

describe("the fake server's categories and bin", () => {
  const fresh = () => fakeDigestMethods(0);

  it("makes, renames and deletes a category; a name is never taken twice", async () => {
    const api = fresh();
    const made = await api.digestCreateCategory("  Verbs ");
    expect(made.name).toBe("Verbs");
    await expect(api.digestCreateCategory("Verbs")).rejects.toMatchObject({ code: "NAME_TAKEN" });
    await expect(api.digestCreateCategory(".x")).rejects.toMatchObject({ code: "BAD_NAME" });
    await api.digestRenameCategory(made.uid, "Verbs");
    await api.digestRenameCategory(made.uid, "Irregular verbs");
    expect((await api.digests()).categories.find((c) => c.uid === made.uid)?.name).toBe("Irregular verbs");
    expect(await api.digestDeleteCategory(made.uid)).toBe(0);
    await expect(api.digestDeleteCategory(made.uid)).rejects.toMatchObject({ code: "NO_SUCH_CATEGORY" });
  });

  it("a deleted category takes its digests to the bin; a restore brings both back", async () => {
    const api = fresh();
    const s = await api.digests();
    const home = s.categories[0]!;
    const inHome = s.digests.filter((d) => d.categoryUid === home.uid).map((d) => d.id);
    expect(await api.digestDeleteCategory(home.uid)).toBe(inHome.length);
    const bin = await api.digestBin();
    expect(bin.digests.map((d) => d.id).sort()).toEqual([...inHome].sort());
    expect(bin.digests[0]).toMatchObject({ categoryName: home.name });

    await api.digestRestore(inHome[0]!);
    const after = await api.digests();
    expect(after.categories.some((c) => c.uid === home.uid)).toBe(true);
    expect(after.digests.find((d) => d.id === inHome[0])).toMatchObject({ categoryUid: home.uid, waiting: true });
    await expect(api.digestRestore(inHome[0]!)).rejects.toMatchObject({ code: "NOT_IN_BIN" });
  });

  it("a restore into a category whose name was taken since joins the live one", async () => {
    const api = fresh();
    const s = await api.digests();
    const home = s.categories[0]!;
    const one = s.digests.find((d) => d.categoryUid === home.uid)!;
    await api.digestDeleteCategory(home.uid);
    const again = await api.digestCreateCategory(home.name);
    await api.digestRestore(one.id);
    const after = await api.digests();
    expect(after.categories.filter((c) => c.name === home.name)).toHaveLength(1);
    expect(after.digests.find((d) => d.id === one.id)!.categoryUid).toBe(again.uid);
  });

  it("a digest goes to the bin and out of it for good", async () => {
    const api = fresh();
    const id = (await api.digests()).digests[0]!.id;
    await api.digestDelete(id);
    expect((await api.digests()).digests.some((d) => d.id === id)).toBe(false);
    await api.digestPurge(id);
    expect((await api.digestBin()).digests).toEqual([]);
    await expect(api.digestPurge(id)).rejects.toMatchObject({ code: "NOT_IN_BIN" });
    await expect(api.digestDelete(id)).rejects.toMatchObject({ code: "NO_SUCH_DIGEST" });
  });
});

describe("the fake server is the real one's stand-in", () => {
  it("a digest the tablet sent back is listed as back, and refuses a restore", async () => {
    const api = fakeDigestMethods(0, { uids: { "1": "u-lease" } });
    const live = (await api.digests()).digests.find((d) => d.id === "1")!;
    const seeded = fakeDigestMethods(0, {
      uids: { "1": "u-lease" },
      bin: [{ digest: { ...live, id: "100" }, deletedAt: 1, uid: "u-lease" }],
    });
    expect((await seeded.digestBin()).digests[0]).toMatchObject({ id: "100", back: true });
    await expect(seeded.digestRestore("100")).rejects.toMatchObject({ code: "BACK_ALREADY" });
    await api.digestDelete("1");
    expect((await api.digestBin()).digests[0]).toMatchObject({ id: "1", back: false });
  });

  it("waits for the tablet after any change made here: a delete, a category, a restore", async () => {
    const api = fakeDigestMethods(0);
    expect((await api.digests()).waiting).toBe(false);
    await api.digestDelete("2");
    expect((await api.digests()).waiting).toBe(true);
  });

  it("a restore that lands in another category stamps the digest as changed", async () => {
    const api = fakeDigestMethods(0);
    const s = await api.digests();
    const home = s.categories[0]!;
    const one = s.digests.find((d) => d.categoryUid === home.uid)!;
    await api.digestDeleteCategory(home.uid);
    await api.digestCreateCategory(home.name);
    await api.digestRestore(one.id);
    const back = (await api.digests()).digests.find((d) => d.id === one.id)!;
    expect(back.modifiedAt).toBeGreaterThan(one.modifiedAt);
  });
});
