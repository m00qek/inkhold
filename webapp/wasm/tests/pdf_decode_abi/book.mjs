// Books (EPUB): laid out as the tablet's reader lays them out (`ink_layout_book`
// in pdf_shim.c), nothing fetched from anywhere, and hostile ones stopped at
// the module's memory ceiling as an ordinary error. Own instances throughout.

import { WASI } from "node:wasi";
import fs from "node:fs";
import zlib from "node:zlib";
import { check, equal, wasmPath } from "./harness.mjs";

const mod = await WebAssembly.compile(fs.readFileSync(wasmPath));
async function instance(fixture) {
  const wasi = new WASI({ version: "preview1", args: [], env: {} });
  let x;
  const inst = await WebAssembly.instantiate(mod, {
    ...wasi.getImportObject(),
    ink: {
      host_read(off, dst, len) {
        const from = Number(off);
        const n = Math.max(0, Math.min(len, fixture.length - from));
        new Uint8Array(x.memory.buffer, dst, n).set(fixture.subarray(from, from + n));
        return n;
      },
    },
  });
  x = inst.exports;
  wasi.initialize(inst);
  return x;
}
const lastError = (x) => {
  const p = x.ink_error_ptr();
  const bytes = new Uint8Array(x.memory.buffer, p, 256);
  return Buffer.from(bytes.subarray(0, bytes.indexOf(0))).toString();
};
const words = (x, doc, page) => {
  const packed = x.ink_page_words(doc, page);
  if (packed <= 0n) return [];
  const json = new TextDecoder().decode(new Uint8Array(x.memory.buffer, Number(packed >> 32n), Number(packed & 0xffffffffn)));
  x.ink_words_free();
  return JSON.parse(json);
};

// ---- the tablet's page ----
const book = fs.readFileSync(new URL("../fixtures/two-chapter.epub", import.meta.url));
{
  const x = await instance(book);
  const doc = x.ink_open_stream(BigInt(book.length));
  check(doc >= 1, "a book opens", `got ${doc} ${lastError(x)}`);
  const pages = x.ink_page_count(doc);
  equal(pages, 9, "two-chapter.epub lays out to the pages it always has");
  const w = x.ink_alloc(4), h = x.ink_alloc(4);
  x.ink_page_size(doc, 0, w, h);
  equal(new Float32Array(x.memory.buffer, w, 1)[0], 1200, "a book's page is 1200 wide (the reader's box)");
  equal(new Float32Array(x.memory.buffer, h, 1)[0], 1600, "and 1600 high");
  // The book's CSS pushes the hgroup down 20em (~667); the tablet's 1.17 knows
  // no hgroup and gives it no margin, and neither does the user stylesheet.
  const title = words(x, doc, 0)[0];
  check(title && title.t === "One" && title.y < 3 * (100 / 3) + 100, "an hgroup title sits at the top, as on the tablet", JSON.stringify(title));
  // U+FEFF takes no width (Noto Serif's zero-width glyph, via the shim's
  // fallback hook): with a stand-in's width it drifted Moby Dick's lines.
  let plain, marked;
  for (let p = 0; p < pages && !(plain && marked); p++) {
    for (const w of words(x, doc, p)) {
      if (w.t === "abcd") plain = w;
      if (w.t.replace("\ufeff", "") === "abcd" && w.t !== "abcd") marked = w;
    }
  }
  check(plain && marked && Math.abs(plain.w - marked.w) < 0.01, "U+FEFF inside a word takes no width", `${plain?.w} vs ${marked?.w}`);
  // Set in Charis SIL, the tablet's book face: a stand-in (the base 14's
  // Times, when TOFU dropped it) gives this word 62.933 and paginates apart.
  check(plain && Math.abs(plain.w - 69.792) < 0.01, "a book is set in Charis SIL", `"abcd" is ${plain?.w} wide`);
  // Lines break at a soft hyphen (U+00AD), as the tablet's 1.17 does:
  // `hyphens: manual` in the tablet stylesheet; `none` would keep every
  // "quix-ot-ic-al-ly" whole.
  const pieces = [];
  for (let p = 0; p < pages; p++) for (const w of words(x, doc, p)) if (/^(quix|ot|ic|al|ly)/.test(w.t)) pieces.push(w.t.replace(/[\u00ad-]/g, ""));
  check(pieces.some((t) => t !== "quixotically"), "a line breaks at a soft hyphen", `${pieces.length} words, all whole`);
}

// ---- nothing is fetched: the module can only read the file it is given ----
{
  const imports = WebAssembly.Module.imports(mod);
  const modules = [...new Set(imports.map((i) => i.module))].sort();
  equal(modules.join(","), "ink,wasi_snapshot_preview1", "the module imports only the host reader and WASI");
  equal(imports.filter((i) => i.module === "ink").map((i) => i.name).join(","), "host_read", "its one host import reads the open file");
  check(!imports.some((i) => i.name.startsWith("sock_")), "and no socket call", imports.filter((i) => i.name.startsWith("sock_")).map((i) => i.name).join(","));
}

// ---- hostile books, stopped at the ceiling ----

/** A zip built by hand, so an entry can state a size its data doesn't have. Entries: `{ name, data, crc, size, method }`. */
function zip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const { name, data, crc, size, method } of entries) {
    const n = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(size, 22); local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(size, 24); central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, n, data);
    centrals.push(central, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
const stored = (name, text) => { const data = Buffer.from(text); return { name, data, crc: zlib.crc32(data), size: data.length, method: 0 }; };
const deflated = (name, text) => { const raw = Buffer.from(text); return { name, data: zlib.deflateRawSync(raw), crc: zlib.crc32(raw), size: raw.length, method: 8 }; };
const container = stored("META-INF/container.xml", '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
const opf = deflated("book.opf", '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">x</dc:identifier><dc:title>x</dc:title></metadata><manifest><item id="c" href="c.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c"/></spine></package>');

async function expectStopped(what, bytes) {
  const x = await instance(bytes);
  let doc, pages, rendered;
  try {
    doc = x.ink_open_stream(BigInt(bytes.length));
    if (doc >= 1) pages = x.ink_page_count(doc);
    if (doc >= 1 && pages > 0) rendered = x.ink_render(doc, 0, 1);
  } catch (err) {
    check(false, `${what}: an error, not a trap`, `${err.constructor.name}: ${err.message}`);
    return;
  }
  const failed = doc < 1 || pages < 0 || rendered < 0n;
  check(failed, `${what}: refused`, `doc ${doc}, pages ${pages}, render ${rendered}`);
  // A fresh instance, as the viewer starts after it, opens a real book.
  const y = await instance(book);
  check(y.ink_open_stream(BigInt(book.length)) >= 1, `${what}: a fresh instance opens the next book`);
}

// A chapter that claims to inflate to 1.5 GiB: MuPDF reads an archive entry
// whole and allocates its stated size first (fitz/unzip.c), so the claim
// alone is what a zip bomb costs; its few real bytes needn't back it.
{
  const chapter = deflated("c.xhtml", '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>x</p></body></html>');
  await expectStopped(
    "a zip bomb",
    zip([stored("mimetype", "application/epub+zip"), container, opf, { ...chapter, size: 1536 * 1024 * 1024 }]),
  );
}

// A 30000 x 30000 picture, a few hundred KB compressed: 900 MB once decoded.
{
  const side = 30000;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(side, 0); ihdr.writeUInt32BE(side, 4); ihdr[8] = 8; ihdr[9] = 0; // 8-bit grey
  const raw = Buffer.alloc(side + 1); // one filter byte and a grey row, repeated
  const rows = [];
  const deflater = zlib.createDeflate({ level: 9 });
  deflater.on("data", (b) => rows.push(b));
  for (let i = 0; i < side; i++) deflater.write(raw);
  await new Promise((r) => deflater.end(r));
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", Buffer.concat(rows)), chunk("IEND", Buffer.alloc(0))]);
  const pic = { name: "big.png", data: png, crc: zlib.crc32(png), size: png.length, method: 0 };
  const opfImg = deflated("book.opf", '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">x</dc:identifier><dc:title>x</dc:title></metadata><manifest><item id="c" href="c.xhtml" media-type="application/xhtml+xml"/><item id="i" href="big.png" media-type="image/png"/></manifest><spine><itemref idref="c"/></spine></package>');
  const bytes = zip([stored("mimetype", "application/epub+zip"), container, opfImg,
    deflated("c.xhtml", '<html xmlns="http://www.w3.org/1999/xhtml"><body><p><img src="big.png" alt=""/></p></body></html>'), pic]);
  // It may be drawn blank or refused; it must never trap.
  const x = await instance(bytes);
  try {
    const doc = x.ink_open_stream(BigInt(bytes.length));
    if (doc >= 1 && x.ink_page_count(doc) > 0) x.ink_render(doc, 0, 1);
    check(true, "a huge image: no trap");
  } catch (err) {
    check(false, "a huge image: an error, not a trap", `${err.constructor.name}: ${err.message}`);
  }
}
