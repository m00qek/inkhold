// The PDF worker after its decoder runs out of memory at the ceiling
// (`max_memory` in build.zig): the failing request says so, the instance is
// replaced, and the same document keeps working on the fresh one.

import { describe, it, expect, beforeAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { PdfRequest, PdfResponse } from "../../src/render/pdfWorkerTypes";

const here = dirname(fileURLToPath(import.meta.url));
const wasm = readFileSync(join(here, "../../public/pdf-decode.wasm"));

/** One 14400 x 14400 pt page: at scale 1 its pixmap (~830 MB) can't fit under the ceiling. */
function hugePagePdf(): Uint8Array {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 14400 14400] >>",
  ];
  let out = "%PDF-1.4\n";
  const offs: number[] = [];
  objs.forEach((o, i) => {
    offs.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 4\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

let send: (req: PdfRequest) => void;
const replies: PdfResponse[] = [];
const fetches = vi.fn(async (url: string) =>
  url.endsWith(".wasm")
    ? new Response(wasm, { headers: { "Content-Type": "application/wasm" } })
    : new Response(hugePagePdf()),
);

beforeAll(async () => {
  // The whole-file path: no JSPI here, as in a browser without it.
  delete (WebAssembly as unknown as { Suspending?: unknown }).Suspending;
  delete (WebAssembly as unknown as { promising?: unknown }).promising;
  const g = globalThis as unknown as Record<string, unknown>;
  g.addEventListener = (_: string, cb: (ev: { data: PdfRequest }) => void) => (send = (data) => cb({ data }));
  g.postMessage = (msg: PdfResponse) => replies.push(msg);
  vi.stubGlobal("fetch", fetches);
  await import("../../src/render/pdfWorker");
});

/** Sends a request and waits for its reply. */
async function ask(req: PdfRequest): Promise<PdfResponse> {
  send(req);
  await vi.waitFor(() => expect(replies.some((r) => (r as { id: number }).id === req.id)).toBe(true), { timeout: 20_000 });
  return replies.find((r) => (r as { id: number }).id === req.id)!;
}

describe("the PDF worker past its memory ceiling", () => {
  it("fails that request, replaces the instance, and keeps the document open", async () => {
    const pdf = hugePagePdf();
    expect(await ask({ kind: "open", id: 1, url: "/doc.pdf", size: pdf.length } as PdfRequest)).toMatchObject({ kind: "opened", pageCount: 1 });

    const failed = await ask({ kind: "render", id: 2, page: 0, scale: 1 } as PdfRequest);
    expect(failed).toMatchObject({ kind: "error" });
    expect((failed as { message: string }).message).toMatch(/malloc \(\d+ bytes\) failed/);

    // The same document, on a fresh instance: a second fetch of the module.
    expect(await ask({ kind: "pageSize", id: 3, page: 0 } as PdfRequest)).toMatchObject({ kind: "pageSize", width: 14400, height: 14400 });
    expect(fetches.mock.calls.filter(([url]) => String(url).endsWith(".wasm"))).toHaveLength(2);
  }, 60_000);
});
