// A bad title drops the entry; an unresolvable destination keeps it at `page: null`.
// The shim omits `p` when it could not resolve, so `undefined` is expected.

import { describe, it, expect } from "vitest";
import { parseOutline } from "../../src/render/pdfWire";

describe("parseOutline", () => {
  it("reads a good payload in document order, with its depths and pages", () => {
    const json = JSON.stringify([
      { d: 0, t: "Part One", p: 0 },
      { d: 1, t: "Chapter A", p: 1 },
      { d: 1, t: "Chapter B", p: 2 },
      { d: 0, t: "Part Two", p: 3 },
      { d: 2, t: "Section C.1", p: 5 },
    ]);
    expect(parseOutline(json)).toEqual([
      { depth: 0, title: "Part One", page: 0 },
      { depth: 1, title: "Chapter A", page: 1 },
      { depth: 1, title: "Chapter B", page: 2 },
      { depth: 0, title: "Part Two", page: 3 },
      { depth: 2, title: "Section C.1", page: 5 },
    ]);
  });

  it("answers [] for a document with no outline — a SUCCESS, not a failure", () => {
    expect(parseOutline("[]")).toEqual([]);
  });

  it("answers [] for a payload that is not an array, and for one that is not JSON", () => {
    expect(parseOutline("{}")).toEqual([]);
    expect(parseOutline('"Part One"')).toEqual([]);
    expect(parseOutline("17")).toEqual([]);
    expect(parseOutline("null")).toEqual([]);
    expect(parseOutline("not json at all")).toEqual([]);
    expect(parseOutline("")).toEqual([]);
  });

  it("drops an entry whose title is not a string, and keeps the rest", () => {
    const json = JSON.stringify([
      { d: 0, t: "Part One", p: 0 },
      { d: 1, t: 42, p: 1 },
      { d: 1, p: 2 },
      { d: 1, t: null, p: 3 },
      { d: 0, t: "Part Two", p: 4 },
    ]);
    expect(parseOutline(json)).toEqual([
      { depth: 0, title: "Part One", page: 0 },
      { depth: 0, title: "Part Two", page: 4 },
    ]);
  });

  it("no longer re-checks the DEPTH, which is our own shim's shape (§2.7)", () => {
    // A bad depth means `ink_load_outline` is broken; it costs an indent, so it is admitted.
    const json = JSON.stringify([
      { d: 0.5, t: "Fractional", p: 0 },
      { d: 0, t: "Kept", p: 4 },
    ]);
    expect(parseOutline(json)).toEqual([
      { depth: 0.5, title: "Fractional", page: 0 },
      { depth: 0, title: "Kept", page: 4 },
    ]);
  });

  it("KEEPS an entry whose `p` is absent, at page null", () => {
    const json = JSON.stringify([
      { d: 0, t: "Part One", p: 0 },
      { d: 1, t: "Unresolvable" },
      { d: 1, t: "Chapter B", p: 2 },
    ]);
    expect(parseOutline(json)).toEqual([
      { depth: 0, title: "Part One", page: 0 },
      { depth: 1, title: "Unresolvable", page: null },
      { depth: 1, title: "Chapter B", page: 2 },
    ]);
  });

  it("KEEPS an entry whose `p` is unusable, at page null", () => {
    const json = '[{"d":0,"t":"Float","p":1.5},{"d":0,"t":"Negative","p":-1},{"d":0,"t":"Stringly","p":"3"},{"d":0,"t":"NaN","p":null}]';
    expect(parseOutline(json)).toEqual([
      { depth: 0, title: "Float", page: null },
      { depth: 0, title: "Negative", page: null },
      { depth: 0, title: "Stringly", page: null },
      { depth: 0, title: "NaN", page: null },
    ]);
  });

  it("keeps an EMPTY title, unlike an empty word", () => {
    expect(parseOutline('[{"d":1,"t":"","p":4}]')).toEqual([{ depth: 1, title: "", page: 4 }]);
  });

  it("skips records that are not objects at all", () => {
    expect(parseOutline('[null,7,"x",[],{"d":0,"t":"Kept","p":0}]')).toEqual([
      { depth: 0, title: "Kept", page: 0 },
    ]);
  });
});
