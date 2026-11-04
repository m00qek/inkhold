// The outline (`ink_load_outline`).

import fs from "node:fs";
import { check, e, equal, fixturePath, host, pdfPath, savedFixture } from "./harness.mjs";
import { doc, packed } from "./render.mjs";
import { buildPdf, openBytes } from "./fixtures.mjs";

// ---- the outline (`ink_load_outline`) ----
// The whole list is compared as one string: pre-order with `d` from 0,
// 0-based `p`, and an unresolved destination omits `p` but keeps the row.

function outlineOf(handle) {
  const packed = e.ink_load_outline(handle);
  if (packed < 0n) return packed;
  const json = Buffer.from(
    new Uint8Array(e.memory.buffer, Number(packed >> 32n), Number(packed & 0xffffffffn)),
  ).toString("utf8");
  e.ink_outline_free();
  return { json, entries: JSON.parse(json) };
}

const rowOfEntry = (o) => `${o.d}|${o.t}|${"p" in o ? o.p : "-"}`;

{
  // Six 300x200pt pages, three levels (two would pass a non-recursive walk).
  const bytes = fs.readFileSync(fixturePath("outlined-six-page.pdf"));
  const doc = openBytes(bytes);
  check(doc >= 1, "outline: the fixture opens", `got ${doc}`);
  equal(e.ink_page_count(doc), 6, "outline: the fixture has six pages");

  const got = outlineOf(doc);
  check(typeof got === "object", "outline: ink_load_outline succeeds", `got ${got}`);

  equal(
    got.entries.map(rowOfEntry).join(" "),
    "0|Part One|0 1|Chapter A|1 1|Chapter B|2 0|Part Two|3 1|Chapter C|4 2|Section C.1|5",
    "outline: the flat list carries the tree's order, depth and pages",
  );

  check(
    got.entries.every((o) => Number.isInteger(o.d) && o.d >= 0),
    "outline: every entry carries an integer `d` >= 0",
    got.json,
  );
  equal(got.entries[0].d, 0, "outline: the first entry is at depth 0");

  // A child is at most one level below its predecessor.
  check(
    got.entries.every((o, i) => i === 0 || o.d <= got.entries[i - 1].d + 1),
    "outline: depth never jumps by more than one",
    got.json,
  );

  check(
    got.entries.every((o) => Number.isInteger(o.p) && o.p >= 0 && o.p < 6),
    "outline: every `p` is a 0-based index into this document's pages",
    got.json,
  );
  equal(got.entries.at(-1).p, 5, "outline: the last entry names the last page, 0-based");

  host.fixture = bytes;
  const sdocOutline = e.ink_open_stream(BigInt(bytes.length));
  check(sdocOutline >= 1, "outline: the fixture opens as a stream", `got ${sdocOutline}`);
  equal(outlineOf(sdocOutline).json, got.json, "outline: the streamed answer is byte-identical");
  e.ink_close(sdocOutline);
  host.fixture = savedFixture;

  e.ink_close(doc);
  equal(e.ink_load_outline(doc), -1n, "outline: a dead handle is refused");
}

/* --- no outline answers [], a success --- */
{
  const doc = openBytes(fs.readFileSync(pdfPath));
  const got = outlineOf(doc);
  check(typeof got === "object", "outline: an outline-free document is not an error", `got ${got}`);
  equal(got.json, "[]", "outline: a document with no outline answers []");
  e.ink_close(doc);
}

/* --- an unresolved destination omits `p` --- */
// An external URI, a named destination naming nothing, and an empty /Title:
// each is still a row.
{
  const doc = openBytes(
    buildPdf([
      "<< /Type /Catalog /Pages 2 0 R /Outlines 3 0 R >>",
      "<< /Type /Pages /Kids [4 0 R] /Count 1 >>",
      "<< /Type /Outlines /First 5 0 R /Last 7 0 R /Count 3 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] >>",
      "<< /Title (Home) /Parent 3 0 R /Dest [4 0 R /Fit] /Next 6 0 R >>",
      "<< /Title (Website) /Parent 3 0 R /A << /S /URI /URI (https://example.com/) >>" +
        " /Prev 5 0 R /Next 7 0 R >>",
      "<< /Title () /Parent 3 0 R /Dest (nowhere-at-all) /Prev 6 0 R >>",
    ]),
  );
  check(doc >= 1, "unresolved outline: the fixture opens", `got ${doc}`);
  const got = outlineOf(doc);
  check(typeof got === "object", "unresolved outline: ink_load_outline succeeds", `got ${got}`);

  equal(
    got.entries.map(rowOfEntry).join(" "),
    "0|Home|0 0|Website|- 0||-",
    "unresolved outline: an unfollowable entry is still a row, and a blank title still a row",
  );
  // Asserted on the key: `-1` and `null` would pass a value check.
  check(
    !("p" in got.entries[1]) && !("p" in got.entries[2]),
    "unresolved outline: `p` is absent, not -1 and not null",
    got.json,
  );
  check("p" in got.entries[0], "unresolved outline: ...while a resolvable entry keeps it");
  equal(got.entries[2].t, "", "unresolved outline: an empty title arrives as \"\"");
  e.ink_close(doc);
}

/* --- deeper than the emitted depth clamps rather than drops --- */
// Forty levels: all arrive, the last eight at depth 32.
{
  const levels = 40;
  const bodies = [
    "<< /Type /Catalog /Pages 2 0 R /Outlines 3 0 R >>",
    "<< /Type /Pages /Kids [4 0 R] /Count 1 >>",
    "<< /Type /Outlines /First 5 0 R /Last 5 0 R /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] >>",
  ];
  for (let i = 0; i < levels; i++) {
    const self = 5 + i;
    const child = i + 1 < levels ? ` /First ${self + 1} 0 R /Last ${self + 1} 0 R /Count 1` : "";
    const parent = i === 0 ? 3 : self - 1; // the root's parent is /Outlines itself
    bodies.push(`<< /Title (L${i}) /Parent ${parent} 0 R /Dest [4 0 R /Fit]${child} >>`);
  }
  const doc = openBytes(buildPdf(bodies));
  check(doc >= 1, "deep outline: the fixture opens", `got ${doc}`);
  const got = outlineOf(doc);
  check(typeof got === "object", "deep outline: ink_load_outline succeeds", `got ${got}`);

  equal(got.entries.length, levels, "deep outline: every nested entry is listed");
  equal(
    got.entries.map((o) => o.t).join(","),
    Array.from({ length: levels }, (_, i) => `L${i}`).join(","),
    "deep outline: in order, with none dropped",
  );
  equal(
    got.entries.map((o) => o.d).join(","),
    Array.from({ length: levels }, (_, i) => Math.min(i, 32)).join(","),
    "deep outline: the depth CLAMPS at 32 — the deep rows stay, flattened",
  );
  e.ink_close(doc);
}

/* --- refusals and hygiene -------------------------------------------------- */
{
  equal(e.ink_load_outline(0), -1n, "outline: handle 0 is refused");
  equal(e.ink_load_outline(-1), -1n, "outline: a negative handle is refused");
  equal(e.ink_load_outline(99), -1n, "outline: an out-of-range handle is refused");
  e.ink_outline_free();
  e.ink_outline_free();
}
