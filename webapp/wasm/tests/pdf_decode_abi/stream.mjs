// The callback stream (`ink_open_stream`) against the whole-file path.

import { check, e, equal, host, pdf } from "./harness.mjs";

// ---- the callback stream (`ink_open_stream`) ----
// Byte-for-byte equality: an off-by-a-window stream still renders something.
host.reads.length = 0;
export const sdoc = e.ink_open_stream(BigInt(pdf.length));
check(sdoc >= 1, "ink_open_stream returned a handle", `got ${sdoc}`);
equal(e.ink_page_count(sdoc), 2, "ink_page_count over the stream");

const spacked = e.ink_render(sdoc, 0, 2);
check(spacked > 0n, "ink_render over the stream succeeded", `got ${spacked}`);
equal(e.ink_render_width(), 400, "streamed page 0 width");
equal(e.ink_render_height(), 200, "streamed page 0 height");
const streamed = Buffer.from(
  new Uint8Array(e.memory.buffer, Number(spacked >> 32n), Number(spacked & 0xffffffffn)),
);

const bufS = e.ink_alloc(pdf.length);
new Uint8Array(e.memory.buffer, bufS, pdf.length).set(pdf);
const wdoc = e.ink_open(bufS, pdf.length);
const wpacked = e.ink_render(wdoc, 0, 2);
const wholeFile = Buffer.from(
  new Uint8Array(e.memory.buffer, Number(wpacked >> 32n), Number(wpacked & 0xffffffffn)),
);
check(streamed.equals(wholeFile), "streamed pixels are identical to whole-file pixels");
e.ink_close(wdoc);

// Without the in-window seek this fixture cost seven host reads.
check(host.reads.length <= 2, "the stream does not re-read what it holds", `${host.reads.length} reads`);
e.ink_close(sdoc);

// A failing host read (an aborted range fetch) is a MuPDF error, and the module
// stays usable.
host.fails = true;
check(e.ink_open_stream(BigInt(pdf.length)) < 0, "a failing host_read fails the open");
host.fails = false;
const sdoc2 = e.ink_open_stream(BigInt(pdf.length));
check(sdoc2 >= 1, "the module still opens a stream afterwards", `got ${sdoc2}`);
e.ink_close(sdoc2);
check(e.ink_open_stream(0n) < 0, "a zero length is refused");
