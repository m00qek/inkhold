// ABI + render check for `pdf-decode.wasm` (`zig build wasm-pdf-decode-test`).
// Real pixels from a real PDF: the fixture's page 0 is 200x100 pt with a 60x40
// pt black rectangle at (20,20), so its black-pixel count is something a stub
// cannot fake. Exports are round-tripped through the same module and
// pixel-diffed against the source page.
//
// Usage: node pdf_decode_abi.mjs <pdf-decode.wasm> <fixture.pdf>


import "./pdf_decode_abi/harness.mjs";
import "./pdf_decode_abi/render.mjs";
import "./pdf_decode_abi/stream.mjs";
import "./pdf_decode_abi/fixtures.mjs";
import "./pdf_decode_abi/export_page.mjs";
import "./pdf_decode_abi/export_doc.mjs";
import "./pdf_decode_abi/links.mjs";
import "./pdf_decode_abi/words.mjs";
import "./pdf_decode_abi/outline.mjs";
import { failureCount } from "./pdf_decode_abi/harness.mjs";
import { pdf } from "./pdf_decode_abi/harness.mjs";
import { width, height } from "./pdf_decode_abi/render.mjs";

if (failureCount() > 0) {
  console.error(`\n${failureCount()} check(s) failed`);
  process.exit(1);
}
console.log(`pdf-decode.wasm OK — rendered ${width}x${height} RGBA from ${pdf.length} PDF bytes`);
