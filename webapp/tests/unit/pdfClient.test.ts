import { describe, it, expect } from "vitest";
import { createPdfSession, PdfLoadError } from "../../src/render/pdfClient";
import type { PdfResponse } from "../../src/render/pdfWorkerTypes";

// The main-thread half of the worker protocol, driven by a FAKE worker.
//
// A real one only fires `error` for a module that will not compile or an
// instance the engine killed — neither of which a test can stage, and both of
// which are exactly what this has to survive.

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
    // THE REGRESSION. The death handler rejected the in-flight requests and
    // stopped there, so the NEXT `send` posted to a worker that would never
    // answer and had no one left to reject it. The viewer sat on "Opening this
    // PDF…" forever — the exact state the handler exists to prevent, for every
    // request after the first.
    const { worker, s } = session();
    const first = s.open("/file/x", 100);
    worker.die();
    await expect(first).rejects.toThrow();

    await expect(within(s.open("/file/y", 100))).rejects.toThrow(/closed/);
    await expect(within(s.pageSize(0))).rejects.toThrow(/closed/);
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

  it("refuses a reply of the wrong kind rather than reading another shape's fields", async () => {
    const { worker, s } = session();
    const sizing = s.pageSize(3);
    const { id } = worker.sent[0] as { id: number };
    worker.reply({ kind: "closed", id });
    await expect(sizing).rejects.toThrow(/expected pageSize/);
  });

  it("refuses a wrong-kind reply to an EXPORT too, rather than downloading undefined", async () => {
    // The same guard, on the one call whose payload leaves the app as a FILE: a
    // reply of another shape has no `bytes`, and reading through it would save an
    // empty `.pdf` that looks exactly like a successful export until it is opened.
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
    // The mask is `width * height` bytes — 2.5 MB for an A4 page at the ink's own
    // resolution, against a 50 MB app-wide budget — so it crosses the thread
    // boundary by transfer, exactly as a rendered bitmap crosses back. Without
    // the transfer list it is structured-CLONED, which costs the same megabytes
    // twice and leaves a detached-looking buffer nobody freed.
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
    // The module reads `width * height` bytes from the pointer it is given, so a
    // short buffer is an out-of-bounds read inside wasm — a torn-down instance,
    // not a failed export. Nothing is posted at all.
    const { worker, s } = session();
    const bad = { alpha: new Uint8Array(5), width: 4, height: 3, matrix: [1, 0, 0, 1, 0, 0] as const };
    await expect(s.exportPage(0, bad)).rejects.toThrow(/does not match/);
    for (const dims of [{ width: 0, height: 3 }, { width: 4, height: -1 }]) {
      await expect(s.exportPage(0, { ...bad, ...dims })).rejects.toThrow(/does not match/);
    }
    expect(worker.sent).toEqual([]);
  });

  it("surfaces a decoder that refuses the export, rather than resolving with nothing", async () => {
    // The wasm can refuse — a source that is not a PDF, a page it cannot graft.
    // The menu turns a rejection into a toast; a quiet resolve would download an
    // empty file called `<page>.pdf`.
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
