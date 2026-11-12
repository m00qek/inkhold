// @vitest-environment happy-dom
// The apps' groups in the library's search (`pages/library/appResults.ts`):
// only from the index's answer, each while its app keeps data, digests first,
// and whether the typo ladder's notice belongs over them.

import { describe, it, expect } from "vitest";
import { appResults, type AppResultsDeps } from "../../src/pages/library/appResults";
import type { SearchState } from "../../src/pages/noteSearch";
import type { DigestSnapshot } from "../../src/api/digestTypes";
import type { TodoSnapshot } from "../../src/api/todoTypes";

const todo: TodoSnapshot = {
  enabled: true,
  lists: [],
  tasks: [{ id: "t1", listId: null, title: "Comprar pão", done: false, due: null, completedAt: null, sort: 0, sortTime: 0, linked: false, link: null, waiting: false }],
  tabletSyncedAt: null,
  waiting: false,
};
const digest: DigestSnapshot = {
  enabled: true,
  categories: [],
  digests: [{ id: "d1", text: "Comprar o pão", comment: null, categoryUid: "", author: null, createdAt: 1, modifiedAt: 1, note: null, waiting: false, source: { kind: "manual", path: null, fileId: null, page: null, changed: false } }],
  tabletSyncedAt: null,
  waiting: false,
};
const answer = (q: string, expansions: { typed: string; matched: string }[] = []): SearchState => ({
  kind: "results",
  query: q,
  documents: [],
  expansions,
  items: { name: [], todo: ["t:t1"], digest: ["d1"] },
});

function deps(over: Partial<AppResultsDeps> = {}) {
  const asked = { todo: 0, digest: 0 };
  const d: AppResultsDeps = {
    state: () => answer("pao"),
    todo: () => todo,
    digest: () => digest,
    freshenTodo: () => void asked.todo++,
    freshenDigest: () => void asked.digest++,
    openDigest: () => {},
    openTask: () => {},
    openList: () => {},
    chip: () => null,
    now: () => 0,
    ...over,
  };
  return { d, asked };
}

const groups = (r: ReturnType<typeof appResults>) => (r ? [...(r.node as DocumentFragment).children].map((c) => c.getAttribute("aria-label")) : null);

describe("the apps' groups in search", () => {
  it("digests, then to-dos, from the index's answer to this query", () => {
    const { d } = deps();
    const r = appResults(d, "pao");
    expect(groups(r)).toEqual(["Digests", "To-dos"]);
    expect(r?.corrected).toBe(false);
  });

  it("none before the index answered this query, or after it failed", () => {
    expect(appResults(deps({ state: () => ({ kind: "searching", query: "pao" }) }).d, "pao")).toBeNull();
    expect(appResults(deps({ state: () => ({ kind: "error", query: "pao" }) }).d, "pao")).toBeNull();
    expect(appResults(deps().d, "other")).toBeNull();
  });

  it("an app that keeps nothing shows no group, and digests off are not asked for again", () => {
    const { d, asked } = deps({ digest: () => ({ ...digest, enabled: false }), todo: () => ({ ...todo, enabled: false }) });
    expect(appResults(d, "pao")).toBeNull();
    expect(asked).toEqual({ todo: 1, digest: 0 });
  });

  it("says the typo ladder found them when it answered", () => {
    const { d } = deps({ state: () => answer("pai", [{ typed: "pai", matched: "pao" }]), todo: () => null });
    expect(appResults(d, "pai")?.corrected).toBe(true);
  });
});
