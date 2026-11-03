import { describe, it, expect, vi } from "vitest";
import { runRestore } from "../../src/pages/historyPanel";
import { ApiError } from "../../src/api/client";
import type { RestoredVersion } from "../../src/core/types";

const RESTORED: RestoredVersion = { md5: "abc", size: 100, createdAt: 5, current: true };

function opts(over: Partial<Parameters<typeof runRestore>[0]> = {}) {
  return {
    api: { restoreVersion: vi.fn(async () => RESTORED) },
    noteId: "n1",
    md5: "abc",
    confirm: vi.fn(async () => true),
    toast: vi.fn(),
    handled: vi.fn(() => false),
    onRestored: vi.fn(),
    ...over,
  };
}

describe("runRestore", () => {
  it("a DECLINED confirm is a pure no-op — no call, no toast, no refresh", async () => {
    const o = opts({ confirm: vi.fn(async () => false) });
    const ok = await runRestore(o);
    expect(ok).toBe(false);
    expect(o.api.restoreVersion).not.toHaveBeenCalled();
    expect(o.toast).not.toHaveBeenCalled();
    expect(o.onRestored).not.toHaveBeenCalled();
  });

  it("SUCCESS restores, hands the new current to onRestored, and toasts the UNDOABLE framing", async () => {
    const o = opts();
    const ok = await runRestore(o);
    expect(ok).toBe(true);
    expect(o.api.restoreVersion).toHaveBeenCalledWith("n1", "abc");
    expect(o.onRestored).toHaveBeenCalledWith(RESTORED);
    expect(o.toast).toHaveBeenCalledTimes(1);
    expect(String(o.toast.mock.calls[0]![0])).toMatch(/history/i);
  });

  it("a 507 (over quota) gets its OWN message and never calls onRestored", async () => {
    const o = opts({
      api: { restoreVersion: vi.fn(async () => { throw new ApiError("QUOTA_EXCEEDED", "x", 507); }) },
    });
    const ok = await runRestore(o);
    expect(ok).toBe(false);
    expect(o.onRestored).not.toHaveBeenCalled();
    expect(String(o.toast.mock.calls[0]![0])).toMatch(/quota/i);
  });

  it("a DEAD SESSION routes to the shell (handled) — no failure toast, no refresh", async () => {
    const handled = vi.fn(() => true);
    const o = opts({
      api: { restoreVersion: vi.fn(async () => { throw new ApiError("UNAUTHORIZED", "x", 401); }) },
      handled,
    });
    const ok = await runRestore(o);
    expect(ok).toBe(false);
    expect(handled).toHaveBeenCalled();
    expect(o.toast).not.toHaveBeenCalled();
    expect(o.onRestored).not.toHaveBeenCalled();
  });

  it("a generic failure toasts a retry and does not refresh", async () => {
    const o = opts({
      api: { restoreVersion: vi.fn(async () => { throw new ApiError("SERVER", "x", 500); }) },
    });
    const ok = await runRestore(o);
    expect(ok).toBe(false);
    expect(o.onRestored).not.toHaveBeenCalled();
    expect(String(o.toast.mock.calls[0]![0])).toMatch(/try again/i);
  });
});
