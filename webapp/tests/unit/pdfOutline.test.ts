// `parseOutline` (src/render/pdfWire.ts) — the outline payload's REFUSALS.
//
// The parse itself is three field reads; what is worth a test is the asymmetry
// between what it drops and what it keeps, because that asymmetry is a product
// decision rather than a defensive habit:
//
//   - a title or a depth that is not what it claims to be DROPS the entry —
//     neither can be guessed, and a row with no text says nothing;
//   - a destination that will not resolve KEEPS the entry, at `page: null`.
//     Dropping it would put a hole in a table of contents, which reads as "this
//     document has no Chapter Four" about a chapter that is right there.
//
// The wire is `{ d, t, p }` and `p` is OMITTED when the shim could not resolve
// the destination, so `undefined` is an expected shape here and not a defect.

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
    // Most documents have no outline at all, so this is the common answer and
    // the caller's response to it (a dimmed opener) is a normal state.
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
    // The panel's whole content is the title. There is nothing to draw without
    // one, and inventing a placeholder would put a row in the contents that the
    // document does not contain.
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
    // A depth that is not a non-negative integer would mean `ink_load_outline`
    // is broken, and the ABI test says so before a user does. It costs an
    // indent, never a row — so the entry is admitted, and this pins that as a
    // decision. The TITLE is the document's and is still checked, above.
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
    // The shim omits `p` for a destination it could not resolve — a named
    // destination whose target was dropped on a re-save, an external uri. The
    // line is still one the author wrote, so it is drawn (inert).
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
    // Same rule for a payload that is WRONG about the destination rather than
    // silent: a float, a negative index, a string, a NaN. None of them names a
    // page, and none of them is a reason to lose the line.
    const json = '[{"d":0,"t":"Float","p":1.5},{"d":0,"t":"Negative","p":-1},{"d":0,"t":"Stringly","p":"3"},{"d":0,"t":"NaN","p":null}]';
    expect(parseOutline(json)).toEqual([
      { depth: 0, title: "Float", page: null },
      { depth: 0, title: "Negative", page: null },
      { depth: 0, title: "Stringly", page: null },
      { depth: 0, title: "NaN", page: null },
    ]);
  });

  it("keeps an EMPTY title, unlike an empty word", () => {
    // `parsePageWords` drops an empty `t` because a word with no text can match
    // no term and could only ever be drawn by mistake. An outline entry with no
    // text is a real (if unhelpful) line, and it still carries a page and a
    // place in the nesting.
    expect(parseOutline('[{"d":1,"t":"","p":4}]')).toEqual([{ depth: 1, title: "", page: 4 }]);
  });

  it("skips records that are not objects at all", () => {
    expect(parseOutline('[null,7,"x",[],{"d":0,"t":"Kept","p":0}]')).toEqual([
      { depth: 0, title: "Kept", page: 0 },
    ]);
  });
});
