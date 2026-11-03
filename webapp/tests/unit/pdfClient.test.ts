import { describe, it, expect } from "vitest";
import { createPdfSession, PdfLoadError } from "../../src/render/pdfClient";
import type { PdfResponse } from "../../src/render/pdfWorkerTypes";

// Driven by a fake worker: real `error` events (compile failure, killed instance)
// cannot be staged.

class FakeWorker extends EventTarget {
  readonly sent: unknown[] = [];
  /** The transfer list of each message, in step with `sent`. */
  readonly transfers: Transferable[][] = [];
  terminated = false;
  postMessage(msg: unknown, transfer: Transferable[] = []): void {
    this.sent.push(msg);
    this.transfers.push(transfer);
  }
  terminate(): void {
    this.terminated = true;
  }
  /** Answer request `id` as the worker would. */
  reply(res: PdfResponse): void {
    this.dispatchEvent(Object.assign(new Event("message"), { data: res }));
  }
  /** Die the way a broken module dies: an `error` event, and no reply, ever. */
  die(message = "boom"): void {
    this.dispatchEvent(Object.assign(new Event("error"), { message }));
  }
}

function session() {
  const worker = new FakeWorker();
  return { worker, s: createPdfSession(() => worker as unknown as Worker) };
}

/** Reject if `p` has not settled within `ms` — a HANG is the failure under test. */
function within<T>(p: Promise<T>, ms = 500): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error("still pending — it hung")), ms)),
  ]);
}

describe("a PDF session whose worker dies", () => {
  it("fails the requests that were in flight", async () => {
    const { worker, s } = session();
    const pending = s.open("/file/x", 100);
    worker.die("the module would not compile");
    await expect(pending).rejects.toThrow(/would not compile/);
  });

  it("fails EVERY LATER request too, rather than hanging on one that cannot be answered", async () => {
    // Regression: after a worker death the next `send` hung forever.
    const { worker, s } = session();
    const first = s.open("/file/x", 100);
    worker.die();
    await expect(first).rejects.toThrow();

    await expect(within(s.open("/file/y", 100))).rejects.toThrow(/closed/);
    await expect(within(s.pageSize(0))).rejects.toThrow(/closed/);
    await expect(within(s.pageLinks(0))).rejects.toThrow(/closed/);
    await expect(within(s.render(0, 1))).rejects.toThrow(/closed/);
    await expect(within(s.stats())).rejects.toThrow(/closed/);
  });

  it("still lets close() be called without throwing, so teardown is safe", async () => {
    const { worker, s } = session();
    worker.die();
    await expect(within(s.close())).resolves.toBeUndefined();
  });
});

describe("a healthy PDF session", () => {
  it("matches replies to requests by id and returns their payloads", async () => {
    const { worker, s } = session();
    const opened = s.open("/file/x", 100);
    const req = worker.sent[0] as { id: number; kind: string; url: string };
    expect(req.kind).toBe("open");
    expect(req.url).toBe("/file/x");
    worker.reply({ kind: "opened", id: req.id, pageCount: 7, mode: "stream" });
    await expect(opened).resolves.toEqual({ pageCount: 7, mode: "stream" });
  });

  it("keeps an HTTP status on the error so the shell can re-authenticate", async () => {
    const { worker, s } = session();
    const opening = s.open("/file/x", 100);
    const { id } = worker.sent[0] as { id: number };
    worker.reply({ kind: "error", id, message: "nope", status: 401 });
    await expect(opening).rejects.toBeInstanceOf(PdfLoadError);
    await expect(opening).rejects.toMatchObject({ status: 401 });
  });

  it("asks for a page's links and hands the records straight back", async () => {
    const { worker, s } = session();
    const asking = s.pageLinks(4);
    const req = worker.sent[0] as { id: number; kind: string; page: number };
    expect(req.kind).toBe("pageLinks");
    expect(req.page).toBe(4);
    expect(worker.transfers[0]).toEqual([]);
    const links = [{ x: 1, y: 2, w: 3, h: 4, page: -1, uri: "https://a.invalid/" }];
    worker.reply({ kind: "pageLinks", id: req.id, links });
    await expect(asking).resolves.toEqual(links);
  });

  it("refuses a wrong-kind reply to a links request rather than reading `undefined`", async () => {
    const { worker, s } = session();
    const asking = s.pageLinks(0);
    const { id } = worker.sent[0] as { id: number };
    worker.reply({ kind: "closed", id });
    await expect(asking).rejects.toThrow(/expected pageLinks/);
  });

  it("refuses a reply of the wrong kind rather than reading another shape's fields", async () => {
    const { worker, s } = session();
    const sizing = s.pageSize(3);
    const { id } = worker.sent[0] as { id: number };
    worker.reply({ kind: "closed", id });
    await expect(sizing).rejects.toThrow(/expected pageSize/);
  });

  it("refuses a wrong-kind reply to an EXPORT too, rather than downloading undefined", async () => {
    // A reply without `bytes` would save an empty `.pdf` that looks like success.
    const { worker, s } = session();
    const exporting = s.exportPage(0, {
      alpha: new Uint8Array(1),
      width: 1,
      height: 1,
      matrix: [1, 0, 0, 1, 0, 0],
    });
    const { id } = worker.sent[0] as { id: number };
    worker.reply({ kind: "closed", id });
    await expect(exporting).rejects.toThrow(/expected exportedPage/);
  });

  it("HANDS OVER the ink mask rather than copying it, and answers with the PDF's bytes", async () => {
    // The mask is megabytes, so it is transferred, not structured-cloned.
    const { worker, s } = session();
    const alpha = new Uint8Array(12);
    const exporting = s.exportPage(3, { alpha, width: 4, height: 3, matrix: [2, 0, 0, 2, 0, 0] });
    const req = worker.sent[0] as { id: number; kind: string; page: number };
    expect(req.kind).toBe("exportPage");
    expect(req.page).toBe(3);
    expect(worker.transfers[0]).toEqual([alpha.buffer]);

    worker.reply({ kind: "exportedPage", id: req.id, bytes: new Uint8Array([0x25, 0x50]) });
    await expect(exporting).resolves.toEqual(new Uint8Array([0x25, 0x50]));
  });

  it("refuses a mask whose buffer disagrees with its own dimensions", async () => {
    // The module reads `width * height` bytes from a raw pointer; a short buffer is an OOB read.
    const { worker, s } = session();
    const bad = { alpha: new Uint8Array(5), width: 4, height: 3, matrix: [1, 0, 0, 1, 0, 0] as const };
    await expect(s.exportPage(0, bad)).rejects.toThrow(/does not match/);
    for (const dims of [{ width: 0, height: 3 }, { width: 4, height: -1 }]) {
      await expect(s.exportPage(0, { ...bad, ...dims })).rejects.toThrow(/does not match/);
    }
    expect(worker.sent).toEqual([]);
  });

  it("surfaces a decoder that refuses the export, rather than resolving with nothing", async () => {
    const { worker, s } = session();
    const exporting = s.exportPage(0, {
      alpha: new Uint8Array(1),
      width: 1,
      height: 1,
      matrix: [1, 0, 0, 1, 0, 0],
    });
    const { id } = worker.sent[0] as { id: number };
    worker.reply({ kind: "error", id, message: "cannot graft page 1", status: null });
    await expect(exporting).rejects.toThrow(/cannot graft/);
  });

  it("destroy() terminates the worker and fails anything outstanding", async () => {
    const { worker, s } = session();
    const pending = s.render(0, 1);
    s.destroy();
    expect(worker.terminated).toBe(true);
    await expect(pending).rejects.toThrow(/closed/);
    await expect(within(s.pageSize(0))).rejects.toThrow(/closed/);
  });
});

describe("the whole-document export, across the worker boundary", () => {
  it("HANDS OVER each page's mask, one `annotatePage` at a time", async () => {
    const { worker, s } = session();
    const alpha = new Uint8Array(12);
    const annotating = s.annotatePage(5, { alpha, width: 4, height: 3, matrix: [2, 0, 0, 2, 0, 0] });
    const req = worker.sent[0] as { id: number; kind: string; page: number };
    expect(req.kind).toBe("annotatePage");
    expect(req.page).toBe(5);
    expect(worker.transfers[0]).toEqual([alpha.buffer]);
    worker.reply({ kind: "annotatedPage", id: req.id });
    await expect(annotating).resolves.toBeUndefined();
  });

  it("refuses a mask whose buffer disagrees with its dimensions, before posting", async () => {
    // Same guard on both doors: `annotatePage` also passes a raw pointer.
    const { worker, s } = session();
    await expect(
      s.annotatePage(0, { alpha: new Uint8Array(5), width: 4, height: 3, matrix: [1, 0, 0, 1, 0, 0] }),
    ).rejects.toThrow(/does not match/);
    expect(worker.sent).toEqual([]);
  });

  it("LENDS the original as a Blob — not transferred, not read", async () => {
    // A Blob crosses `postMessage` by reference; not transferred, since this side
    // concatenates it with the delta afterwards.
    const { worker, s } = session();
    const original = new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])]);
    const exporting = s.exportDocument(original);
    const req = worker.sent[0] as { id: number; kind: string; original: Blob };
    expect(req.kind).toBe("exportDocument");
    expect(req.original).toBe(original);
    expect(worker.transfers[0]).toEqual([]);

    const delta = new Uint8Array([1, 2, 3]);
    worker.reply({ kind: "exportedDocument", id: req.id, delta });
    await expect(exporting).resolves.toEqual(delta);
  });

  it("refuses a wrong-kind reply to the document export", async () => {
    // A reply without `delta` would save a file that opens as the original, ink lost.
    const { worker, s } = session();
    const exporting = s.exportDocument(new Blob([new Uint8Array([1])]));
    const { id } = worker.sent[0] as { id: number };
    worker.reply({ kind: "closed", id });
    await expect(exporting).rejects.toThrow(/expected exportedDocument/);
  });

  it("surfaces a decoder that REFUSES the document, rather than resolving with nothing", async () => {
    const { worker, s } = session();
    const exporting = s.exportDocument(new Blob([new Uint8Array([1])]));
    const { id } = worker.sent[0] as { id: number };
    worker.reply({
      kind: "error",
      id,
      message: "this PDF had to be repaired to open, so it cannot be updated in place",
      status: null,
    });
    await expect(exporting).rejects.toThrow(/repaired/);
  });
});
