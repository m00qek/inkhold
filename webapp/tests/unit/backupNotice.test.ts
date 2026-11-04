// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { createBackupNotice } from "../../src/pages/library/backupNotice";
import type { BackupNotice } from "../../src/api/adminTypes";

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const T = 1_793_761_200;

function build(answer: BackupNotice | Error, isAdmin = true) {
  let current: BackupNotice | Error = answer;
  const api = {
    backupNotice: vi.fn(async () => {
      if (current instanceof Error) throw current;
      return current;
    }),
  };
  const onOpen = vi.fn();
  const n = createBackupNotice({ api, isAdmin: () => isAdmin, onOpen, now: () => (T + 3600) * 1000 });
  return { n, api, onOpen, set: (next: BackupNotice | Error) => void (current = next) };
}

describe("the library's backup notice", () => {
  it("is hidden while all is well", async () => {
    const t = build({ kind: "none", dir: null, at: null, message: null });
    await flush();
    expect(t.n.el.hidden).toBe(true);
  });

  it("shows a failure to an admin, and opens the console from its button", async () => {
    const t = build({ kind: "failed", dir: "/mnt/nas", at: T, message: "disk full" });
    await flush();
    expect(t.n.el.hidden).toBe(false);
    expect(t.n.el.dataset.kind).toBe("failed");
    expect(t.n.el.textContent).toContain("The last backup to /mnt/nas failed 1 hour ago: disk full");
    t.n.el.querySelector("button")!.click();
    expect(t.onOpen).toHaveBeenCalledTimes(1);
  });

  it("never asks, and never shows, for someone who is not an admin", async () => {
    const t = build({ kind: "failed", dir: "/mnt/nas", at: T, message: "disk full" }, false);
    await flush();
    expect(t.api.backupNotice).not.toHaveBeenCalled();
    expect(t.n.el.hidden).toBe(true);
  });

  it("a failed request hides it rather than raising an alarm it cannot back", async () => {
    const t = build(new Error("offline"));
    await flush();
    expect(t.n.el.hidden).toBe(true);
  });

  it("refresh follows the server: a fixed backup clears the line", async () => {
    const t = build({ kind: "late", dir: "/mnt/nas", at: T - 72 * 3600, message: null });
    await flush();
    expect(t.n.el.hidden).toBe(false);
    t.set({ kind: "none", dir: null, at: null, message: null });
    await t.n.refresh();
    expect(t.n.el.hidden).toBe(true);
    t.n.destroy();
  });
});
