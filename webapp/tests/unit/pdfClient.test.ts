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
  terminated = false;
  postMessage(msg: unknown): void {
    this.sent.push(msg);
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

  it("destroy() terminates the worker and fails anything outstanding", async () => {
    const { worker, s } = session();
    const pending = s.render(0, 1);
    s.destroy();
    expect(worker.terminated).toBe(true);
    await expect(pending).rejects.toThrow(/closed/);
    await expect(within(s.pageSize(0))).rejects.toThrow(/closed/);
  });
});
