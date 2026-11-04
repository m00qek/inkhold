// The page's words (`ink_page_words`).

import fs from "node:fs";
import { check, e, equal, host, pdfPath, savedFixture } from "./harness.mjs";
import { doc, packed } from "./render.mjs";
import { buildPdf, openBytes } from "./fixtures.mjs";

// ---- the page's words (`ink_page_words`) ----
// Boxes in page-size space (checked on /Rotate 90, where a word becomes tall),
// split near the index's tokenizer (`avaliação` is one word), and no matching:
// every word on the page comes back.

function pageWords(handle, page) {
  const packed = e.ink_page_words(handle, page);
  if (packed < 0n) return packed;
  const json = Buffer.from(
    new Uint8Array(e.memory.buffer, Number(packed >> 32n), Number(packed & 0xffffffffn)),
  ).toString("utf8");
  e.ink_words_free();
  return { json, words: JSON.parse(json) };
}

/**
 * Two pages, the first with `text` in 12pt Helvetica, the second blank.
 * `/WinAnsiEncoding` is explicit: in StandardEncoding 0xE7 is not `ç`.
 */
function textPdf(mediaBox, extra, text) {
  const content = `BT /F1 12 Tf 10 50 Td (${text}) Tj ET`;
  return buildPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [${mediaBox.join(" ")}]${extra}` +
      " /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [${mediaBox.join(" ")}]${extra}` +
      " /Contents 7 0 R /Resources << >> >>",
    "<< /Length 9 >>\nstream\n0 0 0 rg\n\nendstream",
  ]);
}

// `\347` is ç, `\343` is ã in WinAnsi; parentheses escaped.
const WORDS_TEXT = String.raw`Marmalade, avalia\347\343o \(quince\) page-range`;

let uprightWords = null;
{
  const doc = openBytes(textPdf([0, 0, 300, 100], "", WORDS_TEXT));
  check(doc >= 1, "words: the host.fixture opens", `got ${doc}`);
  const got = pageWords(doc, 0);
  check(typeof got === "object", "words: ink_page_words succeeds", `got ${got}`);

  // Five runs: comma, parentheses and hyphen split; cedilla and tilde do not.
  equal(
    got.words.map((w) => w.t).join(" "),
    "Marmalade avaliação quince page range",
    "words: punctuation splits a run and an accented letter does not",
  );

  const at = e.ink_alloc(8);
  e.ink_page_size(doc, 0, at, at + 4);
  const sz = new DataView(e.memory.buffer);
  equal(sz.getFloat32(at, true), 300, "words: the page measures 300pt wide");
  equal(sz.getFloat32(at + 4, true), 100, "words: the page measures 100pt tall");
  e.ink_free(at, 8);
  check(
    got.words.every((w) => w.x >= 0 && w.y >= 0 && w.x + w.w <= 300 && w.y + w.h <= 100),
    "words: every box lies inside the page ink_page_size describes",
    got.json,
  );
  const first = got.words[0];
  check(first.x >= 9 && first.x <= 11, "words: the first run starts at the text's own x", first.x);
  check(
    first.y > 35 && first.y + first.h < 55,
    "words: y is measured DOWN from the top (PDF y 50 -> display ~41)",
    `${first.y}..${first.y + first.h}`,
  );
  check(
    got.words.every((w, i) => i === 0 || w.x > got.words[i - 1].x),
    "words: the runs arrive in reading order",
    got.json,
  );
  uprightWords = got.words;

  equal(pageWords(doc, 1).json, "[]", "words: a page with no text answers []");

  host.fixture = textPdf([0, 0, 300, 100], "", WORDS_TEXT);
  const swords = e.ink_open_stream(BigInt(host.fixture.length));
  check(swords >= 1, "words: the host.fixture opens as a stream", `got ${swords}`);
  equal(pageWords(swords, 0).json, got.json, "words: the streamed answer is byte-identical");
  e.ink_close(swords);
  host.fixture = savedFixture;

  e.ink_close(doc);
  equal(e.ink_page_words(doc, 0), -1n, "words: a dead handle is refused");
}

/* --- /Rotate 90: a horizontal word becomes a tall box --- */
if (uprightWords) {
  const doc = openBytes(textPdf([0, 0, 300, 100], " /Rotate 90", WORDS_TEXT));
  check(doc >= 1, "rotated words: the host.fixture opens", `got ${doc}`);
  const at = e.ink_alloc(8);
  e.ink_page_size(doc, 0, at, at + 4);
  const sz = new DataView(e.memory.buffer);
  equal(sz.getFloat32(at, true), 100, "rotated words: /Rotate 90 swaps the reported width");
  equal(sz.getFloat32(at + 4, true), 300, "rotated words: ...and the height");
  e.ink_free(at, 8);

  const got = pageWords(doc, 0);
  equal(
    got.words.map((w) => w.t).join(" "),
    uprightWords.map((w) => w.t).join(" "),
    "rotated words: the same runs, in the same order",
  );
  const up = uprightWords[0];
  const rot = got.words[0];
  check(up.w > up.h, "rotated words: the upright box is wide", `${up.w}x${up.h}`);
  check(rot.h > rot.w, "rotated words: the rotated box is TALL", `${rot.w}x${rot.h}`);
  check(
    Math.abs(rot.w - up.h) < 0.5 && Math.abs(rot.h - up.w) < 0.5,
    "rotated words: the box's axes are swapped, not merely different",
    `upright ${up.w}x${up.h}, rotated ${rot.w}x${rot.h}`,
  );
  check(
    got.words.every((w) => w.x >= 0 && w.y >= 0 && w.x + w.w <= 100 && w.y + w.h <= 300),
    "rotated words: every box lies inside the ROTATED page",
    got.json,
  );
  e.ink_close(doc);
}

/* --- the line id (`l`) --- */
// Selection joins words with spaces within a line and newlines between lines,
// and baselines are not a reliable grouping key. Asserts a word never carries
// another line's id. The `FZ_STEXT_BLOCK_STRUCT` recursion is unreachable
// (no `FZ_STEXT_COLLECT_STRUCTURE`), so it is not covered.

/**
 * Text on four baselines 20pt apart (too far for MuPDF to merge), the third
 * blank, so contiguity of ids is a real claim.
 */
function multiLinePdf(lines) {
  const content = lines
    .map(([text, y]) => `BT /F1 12 Tf 10 ${y} Td (${text}) Tj ET`)
    .join("\n");
  return buildPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 120]" +
      " /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  ]);
}

{
  const doc = openBytes(
    multiLinePdf([
      ["Alpha beta", 90],
      ["gamma delta", 70],
      ["   ", 50], // whitespace only: a line that contributes no word at all
      ["epsilon", 30],
    ]),
  );
  check(doc >= 1, "line ids: the host.fixture opens", `got ${doc}`);
  const got = pageWords(doc, 0);
  check(typeof got === "object", "line ids: ink_page_words succeeds", `got ${got}`);

  check(
    got.words.every((w) => Number.isInteger(w.l) && w.l >= 0),
    "line ids: every word carries a finite integer `l` >= 0",
    got.json,
  );

  // Non-decreasing: a reset counter would go backwards.
  check(
    got.words.every((w, i) => i === 0 || w.l >= got.words[i - 1].l),
    "line ids: `l` never goes backwards in emission order",
    got.json,
  );

  equal(
    got.words.map((w) => `${w.t}@${w.l}`).join(" "),
    "Alpha@0 beta@0 gamma@1 delta@1 epsilon@2",
    "line ids: words share an id with their line and with no other",
  );

  // Same id means same baseline; a higher id is lower on the page.
  const rowOf = (l) => got.words.filter((w) => w.l === l);
  check(
    [0, 1, 2].every((l) => {
      const row = rowOf(l);
      return row.length > 0 && row.every((w) => Math.abs(w.y - row[0].y) < 0.5);
    }),
    "line ids: every word sharing an id also shares a baseline",
    got.json,
  );
  check(
    rowOf(0)[0].y < rowOf(1)[0].y && rowOf(1)[0].y < rowOf(2)[0].y,
    "line ids: a higher id sits lower on the page",
    got.words.map((w) => `${w.l}:${w.y}`).join(" "),
  );

  // Contiguous from 0: the blank baseline spends no id, so `epsilon` is 2.
  const ids = [...new Set(got.words.map((w) => w.l))];
  equal(
    ids.join(","),
    ids.map((_, i) => i).join(","),
    "line ids: the ids are contiguous from 0 — a wordless line spends none",
  );

  // The run drained by a line ending belongs to the line that is ending.
  equal(got.words.at(-1).l, 2, "line ids: the last word on the page names the last line");

  host.fixture = multiLinePdf([
    ["Alpha beta", 90],
    ["gamma delta", 70],
    ["   ", 50],
    ["epsilon", 30],
  ]);
  const sline = e.ink_open_stream(BigInt(host.fixture.length));
  check(sline >= 1, "line ids: the host.fixture opens as a stream", `got ${sline}`);
  equal(pageWords(sline, 0).json, got.json, "line ids: the streamed answer is byte-identical");
  e.ink_close(sline);
  host.fixture = savedFixture;

  e.ink_close(doc);
}

/* --- refusals and hygiene -------------------------------------------------- */
{
  const doc = openBytes(fs.readFileSync(pdfPath));
  equal(e.ink_page_words(doc, 99), -2n, "words: a missing page is refused");
  check(e.ink_error_len() > 0, "words: ...with a message");
  equal(e.ink_page_words(doc, -1), -1n, "words: a negative page is refused");
  equal(e.ink_page_words(doc + 100, 0), -1n, "words: an out-of-range handle is refused");
  equal(pageWords(doc, 0).json, "[]", "words: a text-free document answers []");
  e.ink_close(doc);
  e.ink_words_free();
  e.ink_words_free();
}
