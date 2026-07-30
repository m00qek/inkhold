import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { api, ApiError, RateLimitError, createHttpApi } from "../../src/api/client";

// Build a JSON Response the way the Zig server does (envelope + optional status
// and headers). Node provides `Response` globally.
function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

// A `fetch` stub that dispatches by URL substring, so a single stub can answer
// the multi-request flows (e.g. login = random/code then login/new).
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

  // The search cursor at the seam: an opaque token that must survive the trip
  // verbatim in both directions, with ABSENT (the `emit_null_optional_fields`
  // omission) normalized to `undefined` — the same "one shape for the UI" rule
  // as every optional on this surface.
  describe("searchText cursor", () => {
    const http = createHttpApi();
    const searchResponse = (body: Record<string, unknown>) =>
      routedFetch({ "/api/controlplane/search": () => jsonResponse(body) });

    it("carries a served cursor through, and echoes a given one into the request", async () => {
      const fetchStub = searchResponse({ query: "map", hits: [], usedFuzzy: false, cursor: "k-next" });
      vi.stubGlobal("fetch", fetchStub);

      const r = await http.searchText("map", 20, "k-prev");
      expect(r.cursor).toBe("k-next");

      const url = String((fetchStub as ReturnType<typeof vi.fn>).mock.calls[0]![0]);
      // VERBATIM — the token belongs to the server; the client neither parses
      // nor rewrites it, only hands it back.
      expect(url).toContain("cursor=k-prev");
    });

    it("normalizes an absent cursor to undefined — the end-of-results reading", async () => {
      vi.stubGlobal("fetch", searchResponse({ query: "map", hits: [], usedFuzzy: false }));
      const r = await http.searchText("map");
      expect(r.cursor).toBeUndefined();
    });

    it("degrades a malformed cursor to undefined rather than paging into nonsense", async () => {
      for (const bad of ["", 7, null, {}] as const) {
        vi.stubGlobal("fetch", searchResponse({ query: "map", hits: [], usedFuzzy: false, cursor: bad }));
        expect((await http.searchText("map")).cursor).toBeUndefined();
      }
    });

    it("sends no cursor parameter on a first page", async () => {
      const fetchStub = searchResponse({ query: "map", hits: [], usedFuzzy: false });
      vi.stubGlobal("fetch", fetchStub);
      await http.searchText("map", 20);
      const url = String((fetchStub as ReturnType<typeof vi.fn>).mock.calls[0]![0]);
      expect(url).not.toContain("cursor=");
    });
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
//
// A STALLED connection — one that neither delivers nor errors — used to leave
// every surface in its loading state forever, because `NETWORK` only fires on an
// actual rejection. These pin the two halves of the policy that matter: that a
// stall ends, and that a MUTATION's ending never claims to know what happened.
describe("request budgets", () => {
  /** A fetch that never answers, and rejects the way a real one does on abort. */
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
    // Well past a naive "a second or two" cap, nowhere near the real budget.
    await vi.advanceTimersByTimeAsync(5_000);

    expect(settled).toBe(false);
  });

  it("says a timed-out MUTATION may have applied, never that it failed", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", stallingFetch());

    // A rename is the sharp case: the server may have renamed the file before
    // the answer was lost, so "couldn't rename" would be a lie — and a caller
    // that believed it might retry a purge into deleting twice.
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
    // The GET budget has been spent; a mutation's has not.
    await vi.advanceTimersByTimeAsync(15_001);

    expect(settled).toBe(false);
  });
});

// --- upload: bounded by SILENCE, not by total time -------------------------
//
// An upload is the one request where a total cap is actively wrong: a large PDF
// over household wifi to a Pi can legitimately outlast any cap worth setting,
// and aborting it there punishes it for succeeding slowly. So the budget is a
// STALL — bytes must keep moving, however slowly — and these pin both halves of
// that, because a stall timeout that also kills healthy slow uploads is no
// better than the total cap it replaced.
describe("upload budget", () => {
  /** The parts of XMLHttpRequest the client touches, driven by hand. */
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
    /** Simulate bytes leaving the machine. */
    progress(loaded: number, total: number): void {
      this.upload.onprogress?.({ lengthComputable: true, loaded, total } as ProgressEvent);
    }
    /** Simulate the last byte having gone; the server is now working. */
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

    // Ten minutes of genuine progress, each report arriving just inside the
    // window. A total cap would have killed this long ago; a stall must not.
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

    // Past the STALL window: the server is hashing and linking, and no further
    // progress event can arrive — aborting here would kill a healthy commit.
    await vi.advanceTimersByTimeAsync(45_000);
    expect(settled).toBe(false);

    // But the answer is not unbounded either.
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

    // Same abort path as a stall, so the reason has to be carried out of band —
    // otherwise a dead link would tell the user they cancelled.
    expect((await pending as ApiError).code).toBe("CANCELLED");
  });
});
