// @vitest-environment happy-dom
// The excerpt line: a result never waits for it, and it lands on its page.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createSearchExcerpts } from "../../src/pages/searchExcerpts";
import type { StoredDocumentText } from "../../src/cache/textStore";

const MD5 = "a".repeat(32);
const DOC = {
  md5: MD5,
  indexVersion: 16,
  segmentCount: 3,
  segments: [
    { p: 0, o: null, l: null, t: "capa" },
    { p: 2, o: null, l: null, t: "a reunião de pais foi ótima" },
  ],
} as unknown as StoredDocumentText;

/** A store whose read finishes only when the test says so. */
function slowStore() {
  let release: (d: StoredDocumentText | null) => void = () => {};
  let reads = 0;
  return {
    store: {
      get: () => {
        reads++;
        return new Promise<StoredDocumentText | null>((r) => (release = r));
      },
    },
    release: (d: StoredDocumentText | null) => release(d),
    reads: () => reads,
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("the excerpt line", () => {
  let saved: typeof IntersectionObserver | undefined;
  beforeEach(() => {
    // No observer: lines are filled at once, which is what the test can see.
    saved = globalThis.IntersectionObserver;
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = undefined;
  });
  afterEach(() => {
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = saved;
  });

  it("is handed back at once, empty, while the text is still being read", async () => {
    const s = slowStore();
    const x = createSearchExcerpts({ store: s.store, indexVersion: () => 16 });
    const line = x.slot({ md5: MD5, pages: [0, 2] }, "reuniao pais", [], "p.", () => {});
    document.body.append(line);
    expect(line.textContent).toBe("");
    s.release(DOC);
    await tick();
    expect(line.textContent).toBe("p. 3a reunião de pais foi ótima");
    expect([...line.querySelectorAll("mark")].map((m) => m.textContent)).toEqual(["reunião", "pais"]);
    line.remove();
  });

  it("tells the result which page it is from, so opening it lands there", async () => {
    const s = slowStore();
    let opened: number | null = null;
    const x = createSearchExcerpts({ store: s.store, indexVersion: () => 16 });
    const line = x.slot({ md5: MD5, pages: [0, 2] }, "reuniao pais", [], "p.", (p) => (opened = p));
    document.body.append(line);
    s.release(DOC);
    await tick();
    expect(opened).toBe(2);
    line.remove();
  });

  it("does no work for a result a newer search replaced", async () => {
    const s = slowStore();
    let opened = false;
    const x = createSearchExcerpts({ store: s.store, indexVersion: () => 16 });
    const line = x.slot({ md5: MD5, pages: [2] }, "reuniao", [], "p.", () => (opened = true));
    document.body.append(line);
    line.remove();
    s.release(DOC);
    await tick();
    expect(line.textContent).toBe("");
    expect(opened).toBe(false);
  });

  it("lines built together and attached after are all filled (one repaint builds every card first)", async () => {
    // An observer that sees every line as soon as it is watched, as a screen would.
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = class {
      constructor(private readonly cb: (e: { isIntersecting: boolean; target: Element }[]) => void) {}
      observe(target: Element) {
        setTimeout(() => this.cb([{ isIntersecting: true, target }]), 0);
      }
      unobserve() {}
    };
    const x = createSearchExcerpts({ store: { get: async () => DOC }, indexVersion: () => 16 });
    const one = x.slot({ md5: MD5, pages: [2] }, "reuniao", [], "p.", () => {});
    const two = x.slot({ md5: MD5, pages: [2] }, "pais", [], "p.", () => {});
    // Attached only after both were built, in the same task.
    document.body.append(one, two);
    await tick();
    await tick();
    expect(one.querySelector("mark")?.textContent).toBe("reunião");
    expect(two.querySelector("mark")?.textContent).toBe("pais");
    one.remove();
    two.remove();
  });

  it("shows nothing, and reads nothing, when the text version is unknown", async () => {
    const s = slowStore();
    const x = createSearchExcerpts({ store: s.store, indexVersion: () => null });
    const line = x.slot({ md5: MD5, pages: [2] }, "reuniao", [], "p.", () => {});
    await tick();
    expect(s.reads()).toBe(0);
    expect(line.textContent).toBe("");
  });

  it("reads a document once for the same query", async () => {
    const s = slowStore();
    const x = createSearchExcerpts({ store: s.store, indexVersion: () => 16 });
    const one = x.slot({ md5: MD5, pages: [2] }, "reuniao", [], "p.", () => {});
    document.body.append(one);
    s.release(DOC);
    await tick();
    const two = x.slot({ md5: MD5, pages: [2] }, "reuniao", [], "p.", () => {});
    document.body.append(two);
    await tick();
    expect(s.reads()).toBe(1);
    expect(two.querySelector("mark")?.textContent).toBe("reunião");
    one.remove();
    two.remove();
  });
});
