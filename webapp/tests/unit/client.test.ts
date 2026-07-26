import { describe, it, expect, vi, afterEach } from "vitest";
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
