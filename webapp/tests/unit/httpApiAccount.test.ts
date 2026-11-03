// createHttpApi (continued), dispatchApiFailure and the account face.

import { describe, it, expect, vi, afterEach } from "vitest";
import { createHttpApi, ApiError, dispatchApiFailure } from "../../src/api/client";
import type { Listing, NoteMeta, PageRef } from "../../src/core/types";

// The browse `Api` with a stubbed `fetch`: raw JSON, binary pages, `ApiError`.
import { jsonResponse, recordingFetch } from "./httpApi.shared";

afterEach(() => vi.unstubAllGlobals());

describe("createHttpApi", () => {
  describe("getPageLinks", () => {
    const linked = (linksHash: string | null): PageRef => ({
      index: 3,
      hash: "c".repeat(32),
      width: 1404,
      height: 1872,
      textHash: null,
      linksHash,
    });

    it("GETs /note/{id}/page/{index}/links?v={linksHash} and returns the records", async () => {
      const links = [
        { x: 819, y: 614, w: 187, h: 28, page: -1, uri: "https://onplanners.com/x?a=1,2" },
        { x: 96, y: 1680, w: 420, h: 72, page: 11, uri: "none" },
      ];
      const { fn, calls } = recordingFetch(() => jsonResponse({ links }));
      vi.stubGlobal("fetch", fn);

      const got = await createHttpApi().getPageLinks("7", linked("l".repeat(32)));
      expect(calls[0]).toBe("/note/7/page/3/links?v=" + "l".repeat(32));
      expect(got.links).toEqual(links);
    });

    // Same cache-key guard: a re-imported template can change links but not `hash`.
    it("changes the fetch URL when linksHash changes, even though the page hash does not", async () => {
      const { fn, calls } = recordingFetch(() => jsonResponse({ links: [] }));
      vi.stubGlobal("fetch", fn);

      const before = linked("1".repeat(32));
      const after = linked("2".repeat(32));
      expect(before.hash).toBe(after.hash);

      const client = createHttpApi();
      await client.getPageLinks("7", before);
      await client.getPageLinks("7", after);

      expect(calls[0]).not.toBe(calls[1]);
      expect(calls[0]).toContain("v=" + "1".repeat(32));
      expect(calls[1]).toContain("v=" + "2".repeat(32));
    });

    it("returns no links WITHOUT a request when the page has no link block", async () => {
      const { fn, calls } = recordingFetch(() => jsonResponse({ links: [{ x: 1, y: 1, w: 1, h: 1, page: 0, uri: "none" }] }));
      vi.stubGlobal("fetch", fn);

      expect(await createHttpApi().getPageLinks("7", linked(null))).toEqual({ links: [] });
      expect(calls).toHaveLength(0);
    });

    it("treats an omitted `links` field as no links", async () => {
      vi.stubGlobal("fetch", recordingFetch(() => jsonResponse({})).fn);
      expect(await createHttpApi().getPageLinks("7", linked("l".repeat(32)))).toEqual({ links: [] });
    });

    it("drops a record with nothing to draw or nowhere to go", async () => {
      vi.stubGlobal(
        "fetch",
        recordingFetch(() =>
          jsonResponse({
            links: [
              { x: 1, y: 2, w: 3, h: 4, page: -1, uri: "https://ok.example/" },
              { x: 1, y: 2, w: 3, h: 4, page: -1 },
              { x: 1, y: 2, w: 3, h: 4, page: -1, uri: "" },
              { x: 1, y: 2, w: 0, h: 4, page: -1, uri: "https://ok.example/" },
              { x: 1, y: 2, w: 3, h: -4, page: -1, uri: "https://ok.example/" },
            ],
          }),
        ).fn,
      );

      const got = await createHttpApi().getPageLinks("7", linked("l".repeat(32)));
      expect(got.links).toEqual([{ x: 1, y: 2, w: 3, h: 4, page: -1, uri: "https://ok.example/" }]);
    });

    it("maps a stale-version 404 to a STALE_PAGE ApiError, so the reader refetches its metadata", async () => {
      vi.stubGlobal("fetch", recordingFetch(() => jsonResponse({}, { status: 404 })).fn);
      const err = await createHttpApi().getPageLinks("7", linked("l".repeat(32))).catch((e) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect(err.code).toBe("STALE_PAGE");
    });

    it("maps a 401 to UNAUTHORIZED so a dead session reaches the shell", async () => {
      vi.stubGlobal("fetch", recordingFetch(() => jsonResponse({ success: false }, { status: 401 })).fn);
      const err = await createHttpApi().getPageLinks("7", linked("l".repeat(32))).catch((e) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect(err.code).toBe("UNAUTHORIZED");
    });
  });
});

describe("dispatchApiFailure", () => {
  const page: PageRef = { index: 0, hash: "d".repeat(32), width: 1404, height: 1872, textHash: null };
  const sink = () => ({ onSessionExpired: vi.fn(), onStalePage: vi.fn() });

  it("routes UNAUTHORIZED to onSessionExpired", () => {
    const s = sink();
    expect(dispatchApiFailure(s, new ApiError("UNAUTHORIZED", "gone", 401))).toBe(true);
    expect(s.onSessionExpired).toHaveBeenCalledTimes(1);
    expect(s.onStalePage).not.toHaveBeenCalled();
  });

  it("routes STALE_PAGE to onStalePage with the note + page that 404'd", () => {
    const s = sink();
    expect(dispatchApiFailure(s, new ApiError("STALE_PAGE", "stale", 404), "7", page)).toBe(true);
    expect(s.onStalePage).toHaveBeenCalledWith("7", page);
    expect(s.onSessionExpired).not.toHaveBeenCalled();
  });

  it("leaves other failures to the caller (non-fatal, nothing fires)", () => {
    const s = sink();
    expect(dispatchApiFailure(s, new ApiError("NETWORK", "offline", 0))).toBe(false);
    expect(dispatchApiFailure(s, new Error("renderer blew up"))).toBe(false);
    expect(s.onSessionExpired).not.toHaveBeenCalled();
    expect(s.onStalePage).not.toHaveBeenCalled();
  });

  it("does not fire onStalePage without a page to blame", () => {
    const s = sink();
    expect(dispatchApiFailure(s, new ApiError("STALE_PAGE", "stale", 404))).toBe(false);
    expect(s.onStalePage).not.toHaveBeenCalled();
  });
});

// --- the account face: no route takes a target `:id` ---
describe("createHttpApi — the account face", () => {
  const ACCOUNT = {
    email: "ana@household.lan",
    name: "ana",
    isAdmin: false,
    createdAt: 1_700_000_000,
    passwordChangedAt: 1_750_000_000,
    thisSessionSince: 1_760_000_000,
    otherBrowsers: 2,
    devices: [
      {
        equipment_no: "SN1",
        name: "Nomad",
        model: "A5X2",
        firmware: "3.20.29",
        active: true,
        created_at: 1_700_000_000,
        last_seen: 1_760_000_100,
      },
    ],
    versions: { keep: 5, maxKeep: 20, retainedPerFile: [7, 2, 1], bytes: 13_000_000 },
  };

  it("reads the sign-in facts off /account, with no user id anywhere in the URL", async () => {
    const { fn, calls } = recordingFetch(() => jsonResponse(ACCOUNT));
    vi.stubGlobal("fetch", fn);

    const s = await createHttpApi().accountSecurity();

    expect(calls[0]).toContain("/api/controlplane/account");
    expect(calls[0]).not.toMatch(/\/\d+/);
    expect(s).toEqual({ passwordChangedAt: 1_750_000_000, otherSessions: 2, thisSessionSince: 1_760_000_000 });
  });

  it("reads an ABSENT optional as 'the fact does not exist', never as 0", async () => {
    // An omitted `passwordChangedAt` must not read as 0 (1970).
    const { passwordChangedAt, thisSessionSince, ...bare } = ACCOUNT;
    void passwordChangedAt;
    void thisSessionSince;
    vi.stubGlobal("fetch", recordingFetch(() => jsonResponse(bare)).fn);

    const s = await createHttpApi().accountSecurity();
    expect(s.passwordChangedAt).toBeNull();
    expect(s.thisSessionSince).toBeNull();
  });

  it("maps a device row and drops REVOKED bindings", async () => {
    // The admin listing keeps revoked bindings; on your own account they are filtered.
    const withRevoked = {
      ...ACCOUNT,
      devices: [
        ...ACCOUNT.devices,
        { equipment_no: "SN2", name: "Manta", active: false, created_at: 1, last_seen: 2 },
      ],
    };
    vi.stubGlobal("fetch", recordingFetch(() => jsonResponse(withRevoked)).fn);

    const devices = await createHttpApi().myDevices();
    expect(devices).toEqual([
      {
        equipmentNo: "SN1",
        name: "Nomad",
        model: "A5X2",
        firmware: "3.20.29",
        lastSeenAt: 1_760_000_100,
        linkedAt: 1_700_000_000,
      },
    ]);
  });

  it("reads a device never seen as null, not as the epoch", async () => {
    const unseen = { ...ACCOUNT, devices: [{ ...ACCOUNT.devices[0], last_seen: undefined }] };
    vi.stubGlobal("fetch", recordingFetch(() => jsonResponse(unseen)).fn);
    expect((await createHttpApi().myDevices())[0]!.lastSeenAt).toBeNull();
  });

  it("shares ONE /account round trip between the two methods that read it", async () => {
    const { fn, calls } = recordingFetch(() => jsonResponse(ACCOUNT));
    vi.stubGlobal("fetch", fn);

    const api = createHttpApi();
    await Promise.all([api.accountSecurity(), api.myDevices()]);
    expect(calls).toHaveLength(1);

    await api.myDevices();
    expect(calls).toHaveLength(2);
  });

  it("maps the five-way storage split, and re-derives none of it", async () => {
    const { fn, calls } = recordingFetch(() =>
      jsonResponse({
        used_bytes: 15,
        total_bytes: 100,
        notebooks: 5,
        sketches: 4,
        documents: 3,
        recycle_bin: 2,
        versions: 1,
      }),
    );
    vi.stubGlobal("fetch", fn);

    const s = await createHttpApi().storageBreakdown();
    expect(calls[0]).toContain("/api/controlplane/account/storage");
    expect(s.usedBytes).toBe(15);
    expect(s.totalBytes).toBe(100);
    expect(s.byKind).toEqual({
      notebookBytes: 5,
      sketchBytes: 4,
      documentBytes: 3,
      binBytes: 2,
      versionBytes: 1,
    });
  });

  it("reports byKind as NOT KNOWN when the split is absent, rather than as zeros", async () => {
    // An old server can answer the total but not the split: null, not five zeroes.
    vi.stubGlobal("fetch", recordingFetch(() => jsonResponse({ used_bytes: 15, total_bytes: 100 })).fn);
    const s = await createHttpApi().storageBreakdown();
    expect(s.usedBytes).toBe(15);
    expect(s.byKind).toBeNull();
  });

  it("unlinks by POSTing the serial, with no user id in the URL or the body", async () => {
    const bodies: unknown[] = [];
    const fn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return jsonResponse({ success: true });
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fn);

    await createHttpApi().unlinkMyDevice("SN1");
    expect(bodies).toEqual([{ equipmentNo: "SN1" }]);
  });

  it("returns how many sessions signing out everywhere ended", async () => {
    const { fn, calls } = recordingFetch(() => jsonResponse({ success: true, revoked: 3 }));
    vi.stubGlobal("fetch", fn);
    expect(await createHttpApi().signOutEverywhere()).toBe(3);
    expect(calls[0]).toContain("/api/controlplane/account/sign-out-others");
  });

  it("reads the per-file retained counts, which are what let the dial state its cost", async () => {
    vi.stubGlobal("fetch", recordingFetch(() => jsonResponse(ACCOUNT)).fn);

    const p = await createHttpApi().versionPolicy();

    // The fixture still sends `bytes`; `toEqual` fails if unknown fields pass through.
    expect(p).toEqual({ keep: 5, maxKeep: 20, retainedPerFile: [7, 2, 1] });
  });

  it("drops a non-numeric retained count instead of letting the notice read NaN", async () => {
    // One null would make the discard count `NaN` on a destructive control.
    const bad = { ...ACCOUNT, versions: { keep: 1, maxKeep: 9, retainedPerFile: [3, null, -1, 4], bytes: 5 } };
    vi.stubGlobal("fetch", recordingFetch(() => jsonResponse(bad)).fn);

    const p = await createHttpApi().versionPolicy();

    expect(p.retainedPerFile).toEqual([3, 4]);
  });

  it("PUTs the dial and reports what the change ACTUALLY discarded", async () => {
    const { fn, calls } = recordingFetch(() =>
      jsonResponse({
        policy: { keep: 3, maxKeep: 20, retainedPerFile: [3, 2, 1], bytes: 9_000_000 },
        removedVersions: 4,
        freedBytes: 4_000_000,
      }),
    );
    vi.stubGlobal("fetch", fn);

    const r = await createHttpApi().setVersionPolicy(3);

    expect(calls[0]).toContain("/api/controlplane/account/versions");
    expect(r.removedVersions).toBe(4);
    expect(r.freedBytes).toBe(4_000_000);
    expect(r.policy.keep).toBe(3);
  });

  it("sends the CURRENT password as well as the new one", async () => {
    // The server requires and verifies the current password; this pins the client half.
    const bodies: Record<string, unknown>[] = [];
    const fn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return jsonResponse({ success: true });
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fn);

    await createHttpApi().changePassword("old-one", "new-one");
    expect(Object.keys(bodies[0]!).sort()).toEqual(["currentPassword", "newPassword"]);
    // Both hashed at the seam.
    expect(bodies[0]!["currentPassword"]).toMatch(/^[0-9a-f]{32}$/);
    expect(bodies[0]!["newPassword"]).toMatch(/^[0-9a-f]{32}$/);
    expect(bodies[0]!["currentPassword"]).not.toBe(bodies[0]!["newPassword"]);
  });
});
