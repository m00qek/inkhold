import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { api, ApiError, RateLimitError, createHttpApi } from "../../src/api/client";

// A JSON Response shaped like the Zig server's envelope.
function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

// A `fetch` stub that dispatches by URL substring, for multi-request flows.
function routedFetch(map: Record<string, () => Response>): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    for (const [fragment, make] of Object.entries(map)) {
      if (url.includes(fragment)) return make();
    }
    return jsonResponse({ success: true });
  }) as unknown as typeof fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("api client", () => {
  it("returns data on a success envelope", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch({ "random/code": () => jsonResponse({ success: true, randomCode: "deadbeef", timestamp: 1 }) }),
    );
    expect(await api.requestChallenge("ana@household.lan")).toBe("deadbeef");
  });

  it("maps { success:false, errorCode } to an ApiError carrying the code", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch({
        "random/code": () => jsonResponse({ success: true, randomCode: "aa", timestamp: 1 }),
        "login/new": () => jsonResponse({ success: false, errorCode: "INVALID_CREDENTIALS", errorMsg: "nope" }),
      }),
    );
    const err = await api.login("ana", "wrong").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe("INVALID_CREDENTIALS");
  });

  it("turns HTTP 429 + Retry-After into a RateLimitError with the retry seconds", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch({
        "random/code": () => jsonResponse({ success: true, randomCode: "aa", timestamp: 1 }),
        "login/new": () => jsonResponse({ success: false }, { status: 429, headers: { "Retry-After": "42" } }),
      }),
    );
    const err = await api.login("ana", "pw").catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).retryAfterSeconds).toBe(42);
  });

  it("surfaces 401 as an unauthorized ApiError", async () => {
    vi.stubGlobal("fetch", routedFetch({ "user/password": () => jsonResponse({ success: false }, { status: 401 }) }));
    const err = await api.changePassword("newsecret").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe("UNAUTHORIZED");
    expect(err.status).toBe(401);
  });

  it("propagates a network throw as a NETWORK ApiError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("connection refused");
      }),
    );
    const err = await api.requestChallenge("ana").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe("NETWORK");
  });

  describe("me()", () => {
    it("returns the profile on success", async () => {
      vi.stubGlobal(
        "fetch",
        routedFetch({
          "user/me": () => jsonResponse({ success: true, email: "ana@b", isAdmin: true, mustChangePassword: false }),
        }),
      );
      expect(await api.me()).toEqual({ email: "ana@b", isAdmin: true, mustChangePassword: false });
    });

    it("returns null on a 401 status (no session)", async () => {
      vi.stubGlobal("fetch", routedFetch({ "user/me": () => jsonResponse({ success: false }, { status: 401 }) }));
      expect(await api.me()).toBeNull();
    });

    it("returns null on an HTTP 200 envelope failure (no session)", async () => {
      vi.stubGlobal("fetch", routedFetch({ "user/me": () => jsonResponse({ success: false, errorCode: "NO_SESSION" }) }));
      expect(await api.me()).toBeNull();
    });
  });
});

// --- request budgets ---------------------------------------------------------
describe("request budgets", () => {
  function stallingFetch(): typeof fetch {
    return vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    ) as unknown as typeof fetch;
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ends a stalled GET as TIMEOUT rather than waiting for ever", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", stallingFetch());

    const pending = createHttpApi().listFolder(null).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(15_000);

    const err = await pending;
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("TIMEOUT");
  });

  it("does not give up on a GET before its budget is spent", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", stallingFetch());

    let settled = false;
    void createHttpApi()
      .listFolder(null)
      .catch(() => void (settled = true));
    await vi.advanceTimersByTimeAsync(5_000);

    expect(settled).toBe(false);
  });

  it("says a timed-out MUTATION may have applied, never that it failed", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", stallingFetch());

    // The server may have renamed before the answer was lost, so no "couldn't rename".
    const pending = createHttpApi()
      .rename("f1", "new name.note")
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(30_000);

    const err = await pending;
    expect((err as ApiError).code).toBe("TIMEOUT");
    expect((err as ApiError).message).toContain("don't know whether that finished");
    expect((err as ApiError).message).not.toContain("failed");
  });

  it("gives a mutation more room than a GET", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", stallingFetch());

    let settled = false;
    void createHttpApi()
      .rename("f1", "new name.note")
      .catch(() => void (settled = true));
    await vi.advanceTimersByTimeAsync(15_001);

    expect(settled).toBe(false);
  });
});

// --- upload: bounded by stall, not by total time -----------------------------
describe("upload budget", () => {
  class FakeXhr {
    static last: FakeXhr | null = null;
    upload: { onprogress?: (e: ProgressEvent) => void; onload?: () => void } = {};
    onload?: () => void;
    onerror?: () => void;
    onabort?: () => void;
    ontimeout?: () => void;
    status = 200;
    responseText = "";
    withCredentials = false;
    responseType = "";
    timeout = 0;
    aborted = false;
    constructor() {
      FakeXhr.last = this;
    }
    open(): void {}
    send(): void {}
    abort(): void {
      this.aborted = true;
      this.onabort?.();
    }
    progress(loaded: number, total: number): void {
      this.upload.onprogress?.({ lengthComputable: true, loaded, total } as ProgressEvent);
    }
    bodySent(): void {
      this.upload.onload?.();
    }
  }

  const bigFile = (): File => new File(["x".repeat(4096)], "big.pdf", { type: "application/pdf" });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("XMLHttpRequest", FakeXhr as unknown as typeof XMLHttpRequest);
  });
  afterEach(() => {
    vi.useRealTimers();
    FakeXhr.last = null;
  });

  it("ends an upload that sends NOTHING at all", async () => {
    const pending = createHttpApi()
      .upload("f1", bigFile())
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(30_000);

    const err = await pending;
    expect((err as ApiError).code).toBe("TIMEOUT");
  });

  it("never aborts an upload that is merely SLOW — every byte buys another window", async () => {
    let settled = false;
    void createHttpApi()
      .upload("f1", bigFile())
      .catch(() => void (settled = true));

    for (let i = 1; i <= 24; i++) {
      await vi.advanceTimersByTimeAsync(25_000);
      FakeXhr.last!.progress(i * 100, 4096);
      expect(settled).toBe(false);
    }
    expect(settled).toBe(false);
  });

  it("switches to a plain budget once the body is sent, since progress stops by definition", async () => {
    let settled = false;
    const pending = createHttpApi()
      .upload("f1", bigFile())
      .catch((e: unknown) => {
        settled = true;
        return e;
      });
    FakeXhr.last!.progress(4096, 4096);
    FakeXhr.last!.bodySent();

    // Past the stall window: the server is committing and sends no more progress.
    await vi.advanceTimersByTimeAsync(45_000);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(20_000);
    expect((await pending as ApiError).code).toBe("TIMEOUT");
  });

  it("a stall reads as a timeout; a user's cancel still reads as cancelled", async () => {
    const ctl = new AbortController();
    const pending = createHttpApi()
      .upload("f1", bigFile(), undefined, ctl.signal)
      .catch((e: unknown) => e);
    FakeXhr.last!.progress(100, 4096);
    ctl.abort();

    // Same abort path as a stall, so the reason is carried out of band.
    expect((await pending as ApiError).code).toBe("CANCELLED");
  });
});

describe("PageRef.sourcePage off the wire", () => {
  // The server omits `sourcePage` where it would be `index + 1`; absence is `null`.
  const page = (over: Record<string, unknown>) => ({
    index: 0,
    hash: "a".repeat(32),
    width: 1404,
    height: 1872,
    ...over,
  });

  async function metaWith(pages: unknown[]) {
    vi.stubGlobal(
      "fetch",
      routedFetch({
        "file/metadata": () =>
          jsonResponse({ success: true, id: "n-1", name: "annotated.pdf.mark", pages }),
      }),
    );
    return createHttpApi().getNoteMeta("n-1" as never);
  }

  it("keeps a real page number", async () => {
    const api = await metaWith([page({ sourcePage: 2 }), page({ index: 1, sourcePage: 5 })]);
    expect(api.pages.map((p) => p.sourcePage)).toEqual([2, 5]);
  });

  it("turns an omitted field into null, the notebook case", async () => {
    const api = await metaWith([page({}), page({ index: 1 })]);
    expect(api.pages.map((p) => p.sourcePage)).toEqual([null, null]);
  });

  it("refuses a value that is not a page number", async () => {
    // Pre-v7 rows and `.txt` rows carry 0; there is no page 0.
    const api = await metaWith([
      page({ sourcePage: 0 }),
      page({ index: 1, sourcePage: -3 }),
      page({ index: 2, sourcePage: "5" }),
    ]);
    expect(api.pages.map((p) => p.sourcePage)).toEqual([null, null, null]);
  });
});

describe("PageRef.hasInk off the wire", () => {
  // Three-state: `undefined` means the server's back-fill has not reached it yet.
  const page = (over: Record<string, unknown>) => ({
    index: 0,
    hash: "b".repeat(32),
    width: 1404,
    height: 1872,
    ...over,
  });

  async function metaWith(pages: unknown[]) {
    vi.stubGlobal(
      "fetch",
      routedFetch({
        "file/metadata": () =>
          jsonResponse({ success: true, id: "n-2", name: "written.note", pages }),
      }),
    );
    return createHttpApi().getNoteMeta("n-2" as never);
  }

  it("carries both answers through", async () => {
    // Regression: `normalizePage` rebuilds field by field and silently dropped this one.
    const api = await metaWith([page({ hasInk: true }), page({ index: 1, hasInk: false })]);
    expect(api.pages.map((p) => p.hasInk)).toEqual([true, false]);
  });

  it("keeps an omitted field UNDEFINED, not null and not false", async () => {
    const api = await metaWith([page({}), page({ index: 1 })]);
    expect(api.pages.map((p) => p.hasInk)).toEqual([undefined, undefined]);
    expect(api.pages[0]?.hasInk).not.toBeNull();
  });

  it("treats a non-boolean as not yet known", async () => {
    const api = await metaWith([
      page({ hasInk: 1 }),
      page({ index: 1, hasInk: "true" }),
      page({ index: 2, hasInk: null }),
    ]);
    expect(api.pages.map((p) => p.hasInk)).toEqual([undefined, undefined, undefined]);
  });
});

describe("Entry.annotationsId off the wire", () => {
  // A paired `.mark` has no listing row, so this field is the only way to its versions.
  const entry = (over: Record<string, unknown>) => ({
    kind: "note",
    id: "e-1",
    name: "Appliance manual.pdf",
    pageCount: 4,
    firstPage: { index: 0, hash: "c".repeat(32), width: 612, height: 792 },
    updatedAt: 0,
    fileType: "pdf",
    fileHash: "d".repeat(32),
    ...over,
  });

  async function listWith(entries: unknown[]) {
    vi.stubGlobal(
      "fetch",
      routedFetch({
        "controlplane/tree": () =>
          jsonResponse({ success: true, folderId: "files", path: [], entries, syncVersion: 1 }),
      }),
    );
    return createHttpApi().listFolder("files" as never);
  }

  it("carries the paired mark's id through", async () => {
    // Regression: `normalizeEntry` rebuilds field by field and silently dropped this one.
    const listing = await listWith([entry({ annotationsId: "179" })]);
    expect(listing.entries.map((e) => (e.kind === "note" ? e.annotationsId : "folder"))).toEqual(["179"]);
  });

  it("turns an omitted field into null — the case almost every entry is", async () => {
    const listing = await listWith([entry({}), entry({ id: "e-2", annotationsId: null })]);
    expect(listing.entries.map((e) => (e.kind === "note" ? e.annotationsId : "folder"))).toEqual([
      null,
      null,
    ]);
  });

  it("refuses a value that cannot address a file", async () => {
    const listing = await listWith([
      entry({ annotationsId: 179 }),
      entry({ id: "e-2", annotationsId: "" }),
      entry({ id: "e-3", annotationsId: { id: "179" } }),
    ]);
    expect(listing.entries.map((e) => (e.kind === "note" ? e.annotationsId : "folder"))).toEqual([
      null,
      null,
      null,
    ]);
  });

  it("says nothing about a folder row", async () => {
    const listing = await listWith([{ kind: "folder", id: "sub", name: "Manuals", updatedAt: 0 }]);
    expect(listing.entries[0]?.kind).toBe("folder");
    expect(listing.entries[0]).not.toHaveProperty("annotationsId");
  });
});
