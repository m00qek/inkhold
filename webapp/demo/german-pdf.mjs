// Writes the demo's German grammar sheet, the PDF the demo's digests quote
// (webapp/src/api/fakeDigest.ts), so "Open at page" lands on the passage:
//
//   node demo/german-pdf.mjs
//
// A plain PDF with no dependencies: Helvetica in WinAnsi, which has the
// umlauts and ß, one text object per page. The sentences the digests quote
// are each on one line, as a tablet's selection of them would be.
import { writeFileSync } from "node:fs";

const PAGES = [
  {
    title: "Deutsch lernen: Grammatik kurz erklärt",
    head: "1. Die Artikel",
    lines: [
      "Im Deutschen hat jedes Nomen ein Geschlecht: der, die oder das.",
      "Der Artikel zeigt auch den Fall: Nominativ, Akkusativ, Dativ oder Genitiv.",
      "Lerne jedes Nomen immer zusammen mit seinem Artikel.",
      "Der Plural hat für alle drei Geschlechter denselben Artikel: die.",
    ],
  },
  {
    head: "2. Die Wortstellung",
    lines: [
      "Im Hauptsatz steht das Verb an zweiter Stelle.",
      "Morgen fahre ich nach Hamburg.",
      "Im Nebensatz steht das Verb am Ende.",
      "Ich komme nicht, weil ich heute keine Zeit habe.",
      "Trennbare Verben teilen sich: Ich rufe dich morgen an.",
    ],
  },
  {
    head: "3. Das Perfekt",
    lines: [
      "Das Perfekt bildet man mit haben oder sein und dem Partizip II.",
      "Wir haben gestern Kaffee getrunken.",
      "Verben der Bewegung bilden das Perfekt meist mit sein.",
      "Ich bin nach Berlin gefahren.",
    ],
  },
];

/** A PDF string in WinAnsi: Latin-1 bytes, with the delimiters escaped. */
function pdfText(s) {
  return "(" + s.replace(/[\\()]/g, (c) => "\\" + c) + ")";
}

function content(p, n) {
  const ops = ["BT"];
  let y = 770;
  const line = (font, size, text, gap) => {
    ops.push(`/${font} ${size} Tf 1 0 0 1 72 ${y} Tm ${pdfText(text)} Tj`);
    y -= gap;
  };
  if (p.title) line("F2", 20, p.title, 44);
  line("F2", 14, p.head, 28);
  for (const l of p.lines) line("F1", 12, l, 22);
  ops.push(`/F1 9 Tf 1 0 0 1 72 48 Tm ${pdfText(`Seite ${n}`)} Tj`, "ET");
  return ops.join("\n");
}

const objects = [];
/** Adds an object; returns its number (1-based). */
const add = (body) => objects.push(body);
const font = (name) => `<< /Type /Font /Subtype /Type1 /BaseFont /${name} /Encoding /WinAnsiEncoding >>`;
const f1 = add(font("Helvetica"));
const f2 = add(font("Helvetica-Bold"));
// The page tree comes after each page's content and page objects.
const pagesNum = objects.length + 1 + PAGES.length * 2;
const kids = [];
PAGES.forEach((p, i) => {
  const stream = Buffer.from(content(p, i + 1), "latin1");
  const c = add(`<< /Length ${stream.length} >>\nstream\n${stream.toString("latin1")}\nendstream`);
  kids.push(add(`<< /Type /Page /Parent ${pagesNum} 0 R /MediaBox [0 0 595 842] /Contents ${c} 0 R /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> >>`));
});
add(`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`);
const catalog = add(`<< /Type /Catalog /Pages ${pagesNum} 0 R >>`);
const info = add(`<< /Title ${pdfText("Deutsch lernen: Grammatik")} >>`);

let out = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
const offsets = [];
objects.forEach((body, i) => {
  offsets.push(Buffer.byteLength(out, "latin1"));
  out += `${i + 1} 0 obj\n${body}\nendobj\n`;
});
const xref = Buffer.byteLength(out, "latin1");
out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

const target = new URL("../tests/fixtures/demo/deutsch-lernen.pdf", import.meta.url);
writeFileSync(target, Buffer.from(out, "latin1"));
console.log(`wrote ${target.pathname} (${PAGES.length} pages)`);
