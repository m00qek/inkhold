import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import { AddressInfo } from "node:net";
import { HttpError, rangeFetcher, fetchWhole, totalFromContentRange } from "../../src/render/pdfTransport";

// The transport, against a REAL server over a REAL `fetch`.
//
// A mocked `fetch` cannot test the thing that was broken here. The bug was that
// `fetch` resolves on HEADERS while the body is still streaming, so a budget
// released in a `finally` around the fetch alone left the body read unguarded —
// and a mock that resolves with a fully-formed `Response` has no such gap to
// expose. Only a server that answers and then STOPS reproduces it.

const servers: http.Server[] = [];

/** A server running `handler`, torn down after the test. Returns its URL. */
async function serve(handler: http.RequestListener): Promise<string> {
  const srv = http.createServer(handler);
  servers.push(srv);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(srv.address() as AddressInfo).port}/`;
}

afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

/** Headers, a token first chunk, then silence forever. */
const stallMidBody: http.RequestListener = (_req, res) => {
  res.writeHead(206, {
    "content-range": "bytes 0-999/100000",
    "content-length": "1000",
    "content-type": "application/pdf",
  });
  res.write("x".repeat(10));
};

describe("the transfer budget", () => {
  // THE REGRESSION, and why it is tested through ABORT rather than through the
  // timer. `budget` funnels the deadline and the caller's signal into ONE
  // `AbortController`, so "does the caller's abort still reach the body?" and
  // "does the deadline still reach the body?" are the same question about the
  // same `b.signal` — and the real deadline is 120 s, which no test should wait
  // for. Releasing the budget after the headers broke both at once: it cleared
  // the timer AND dropped the caller's abort listener.

  it("turns a cancelled transfer into an HttpError, not a raw AbortError", async () => {
    // The viewer prints `PdfLoadError` as "Couldn't load this PDF"; a bare
    // AbortError would surface DOMException text to the user instead.
    const url = await serve(stallMidBody);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    await expect(rangeFetcher(url, ac.signal)(0, 999)).rejects.toBeInstanceOf(HttpError);
  });

  it("cancels an in-flight BODY when the caller aborts, so close() is not a lie", async () => {
    // `release()` aborts `inflight` to stop a transfer the user walked away
    // from. Releasing the budget after the headers dropped the caller's abort
    // listener too, so the download carried on to completion in the background.
    const url = await serve(stallMidBody);
    const ac = new AbortController();
    const pending = rangeFetcher(url, ac.signal)(0, 999);
    await new Promise((r) => setTimeout(r, 100));
    ac.abort();
    await expect(pending).rejects.toBeInstanceOf(HttpError);
  });

  it("reads a whole, healthy range normally", async () => {
    const body = Buffer.from("%PDF-1.7\n" + "y".repeat(91));
    const url = await serve((_req, res) => {
      res.writeHead(206, { "content-range": `bytes 0-99/100`, "content-length": "100" });
      res.end(body);
    });
    const got = await rangeFetcher(url, new AbortController().signal)(0, 99);
    expect(got.bytes.length).toBe(100);
    expect(got.total).toBe(100);
    expect(got.whole).toBe(false);
  });

  it("treats a 200 as the whole file and slices the window out of it", async () => {
    const body = Buffer.alloc(500, 7);
    const url = await serve((_req, res) => {
      res.writeHead(200, { "content-length": "500" });
      res.end(body);
    });
    const got = await rangeFetcher(url, new AbortController().signal)(100, 199);
    expect(got.whole).toBe(true);
    expect(got.total).toBe(500);
    expect(got.bytes.length).toBe(100);
  });

  it("fails a non-OK status with its code, so 401/403 can re-authenticate", async () => {
    const url = await serve((_req, res) => {
      res.writeHead(403);
      res.end();
    });
    await expect(rangeFetcher(url, new AbortController().signal)(0, 99)).rejects.toMatchObject({
      status: 403,
    });
  });

  it("guards fetchWhole's body with the same discipline", async () => {
    const url = await serve(stallMidBody);
    const ac = new AbortController();
    const pending = fetchWhole(url, ac.signal);
    await new Promise((r) => setTimeout(r, 100));
    ac.abort();
    await expect(pending).rejects.toBeInstanceOf(HttpError);
  });
});

describe("content-range parsing", () => {
  it("reads the total off the end", () => {
    expect(totalFromContentRange("bytes 0-99/1234")).toBe(1234);
  });
  it("refuses an unknown total, a missing header and junk", () => {
    expect(totalFromContentRange("bytes 0-99/*")).toBeNull();
    expect(totalFromContentRange(null)).toBeNull();
    expect(totalFromContentRange("nonsense")).toBeNull();
    expect(totalFromContentRange("bytes 0-99/0")).toBeNull();
  });
});
