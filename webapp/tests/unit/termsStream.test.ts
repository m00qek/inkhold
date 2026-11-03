import { describe, it, expect } from "vitest";
import { parseTermsJsonl, textChunks, type TermsDocument } from "../../src/search/termsStream";
import { SearchWireError } from "../../src/search/manifestCodec";

const A = "0123456789abcdef0123456789abcdef";
const B = "fedcba9876543210fedcba9876543210";

/** One document, spelled exactly as `derive_search.zig`'s `writeHeader` spells it. */
function doc(md5: string, v: number, n: number, pages: [number, string][]): string {
  let out = `{"md5":"${md5}","v":${v},"n":${n}}\n`;
  for (const [p, t] of pages) out += `{"p":${p},"t":"${t}"}\n`;
  return out;
}

async function* chunked(...chunks: string[]): AsyncGenerator<string> {
  for (const chunk of chunks) yield chunk;
}

async function collect(chunks: AsyncIterable<string>): Promise<TermsDocument[]> {
  const out: TermsDocument[] = [];
  for await (const d of parseTermsJsonl(chunks)) out.push(d);
  return out;
}

describe("parseTermsJsonl", () => {
  it("reads the §2.2 record: a header line, then one line per page WITH TEXT", () => {
    const body = doc(A, 7, 14055, [
      [0, "reuniao orcamento projeto"],
      [3, "reuniao acta"],
    ]);
    return expect(collect(chunked(body))).resolves.toEqual([
      {
        md5: A,
        indexVersion: 7,
        // `n` is the address space, not the row count.
        pageCount: 14055,
        pages: [
          { p: 0, t: "reuniao orcamento projeto" },
          { p: 3, t: "reuniao acta" },
        ],
      },
    ]);
  });

  it("closes a document on the NEXT header, and at the end of the stream", async () => {
    const body = doc(A, 7, 1, [[0, "alpha"]]) + doc(B, 7, 2, [[1, "beta"]]);
    const docs = await collect(chunked(body));
    expect(docs.map((d) => d.md5)).toEqual([A, B]);
    expect(docs[1]!.pages).toEqual([{ p: 1, t: "beta" }]);
  });

  it("accepts a header with NO page lines — a fully derived, wholly textless document", async () => {
    // A document that folds to nothing still arrived, so it is derived.
    const docs = await collect(chunked(doc(A, 7, 12, [])));
    expect(docs).toEqual([{ md5: A, indexVersion: 7, pageCount: 12, pages: [] }]);
  });

  it("yields a document BEFORE the rest of the stream has arrived", async () => {
    // Released on the next header: pulling document one reads two chunks and stops.
    let pulled = 0;
    async function* slow(): AsyncGenerator<string> {
      for (const chunk of [
        doc(A, 7, 1, [[0, "alpha"]]),
        doc(B, 7, 1, [[0, "beta"]]),
        doc("a".repeat(32), 7, 1, [[0, "gama"]]),
      ]) {
        pulled += 1;
        yield chunk;
      }
    }
    const it = parseTermsJsonl(slow());
    const first = await it.next();
    expect(first.value?.md5).toBe(A);
    expect(pulled).toBe(2);
    const second = await it.next();
    expect(second.value?.md5).toBe(B);
    expect(pulled).toBe(3);
  });

  it("reassembles records split across chunk boundaries, mid-line and mid-token", async () => {
    const body = doc(A, 7, 2, [
      [0, "alpha beta"],
      [1, "gamma"],
    ]);
    // Every possible split point: a TCP segment lands anywhere.
    for (let cut = 1; cut < body.length; cut += 1) {
      const docs = await collect(chunked(body.slice(0, cut), body.slice(cut)));
      expect(docs).toHaveLength(1);
      expect(docs[0]!.pages).toEqual([
        { p: 0, t: "alpha beta" },
        { p: 1, t: "gamma" },
      ]);
    }
  });

  it("refuses a body that ends mid-line — truncation is the silent corruption", async () => {
    // A stream that merely ran out would decode as a shorter, plausible answer.
    const body = doc(A, 7, 1, [[0, "alpha"]]) + '{"md5":"fedcba98765432';
    await expect(collect(chunked(body))).rejects.toThrow(SearchWireError);
  });

  it("keeps the documents it already yielded when the tail is truncated", async () => {
    const body = doc(A, 7, 1, [[0, "alpha"]]) + doc(B, 7, 1, [[0, "beta"]]) + '{"md5":"fedcba98';
    const got: TermsDocument[] = [];
    await expect(
      (async () => {
        for await (const d of parseTermsJsonl(chunked(body))) got.push(d);
      })(),
    ).rejects.toThrow(SearchWireError);
    expect(got.map((d) => d.md5)).toEqual([A]);
  });

  it("refuses a page line with no header before it", async () => {
    await expect(collect(chunked('{"p":0,"t":"alpha"}\n'))).rejects.toThrow(SearchWireError);
  });

  it("refuses a header missing any of md5, v or n rather than defaulting one", async () => {
    // Refused, not coerced: defaulting `n` to the row count is wrong by construction.
    await expect(collect(chunked(`{"md5":"${A}","v":7}\n`))).rejects.toThrow(SearchWireError);
    await expect(collect(chunked(`{"md5":"${A}","n":3}\n`))).rejects.toThrow(SearchWireError);
    await expect(collect(chunked('{"md5":"not-hex","v":7,"n":3}\n'))).rejects.toThrow(SearchWireError);
  });

  it("refuses a line that is not JSON, and a page line with no terms", async () => {
    await expect(collect(chunked("not json at all\n"))).rejects.toThrow(SearchWireError);
    await expect(collect(chunked(doc(A, 7, 1, []) + '{"p":0}\n'))).rejects.toThrow(SearchWireError);
  });

  it("ignores blank lines between fragments", async () => {
    const body = doc(A, 7, 1, [[0, "alpha"]]) + "\n" + doc(B, 7, 1, [[0, "beta"]]);
    expect((await collect(chunked(body))).map((d) => d.md5)).toEqual([A, B]);
  });
});

describe("textChunks", () => {
  it("decodes a byte stream progressively, without buffering the body", async () => {
    const bytes = new TextEncoder().encode(doc(A, 7, 1, [[0, "reuniao"]]));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(0, 20));
        controller.enqueue(bytes.subarray(20));
        controller.close();
      },
    });
    const docs = await collect(textChunks(body));
    expect(docs).toEqual([{ md5: A, indexVersion: 7, pageCount: 1, pages: [{ p: 0, t: "reuniao" }] }]);
  });

  it("splits multi-byte UTF-8 across chunks without a replacement character", async () => {
    const bytes = new TextEncoder().encode(doc(A, 7, 1, [[0, "reuniaoão"]]));
    // Straight through the middle of the two-byte "ã".
    const cut = bytes.length - 5;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(0, cut));
        controller.enqueue(bytes.subarray(cut));
        controller.close();
      },
    });
    const docs = await collect(textChunks(body));
    expect(docs[0]!.pages[0]!.t).toBe("reuniaoão");
  });
});
