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

const failed: BackupNotice = { kind: "failed", dir: "/mnt/nas", at: T, message: "disk full", check: false };

describe("the library's backup notice", () => {
  it("is hidden while all is well", async () => {
    const t = build({ kind: "none", dir: null, at: null, message: null, check: false });
    await flush();
    expect(t.n.el.hidden).toBe(true);
  });

  it("is the app's banner: a badge, the sentence with its exact time, one shared button", async () => {
    const t = build(failed);
    await flush();
    expect(t.n.el.hidden).toBe(false);
    expect(t.n.el.classList.contains("banner")).toBe(true);
    expect(t.n.el.querySelector(".banner__badge svg")).not.toBeNull();
    const text = t.n.el.querySelector<HTMLElement>(".banner__text")!;
    expect(text.textContent).toBe("The last backup to /mnt/nas failed 1 hour ago: disk full");
    expect(text.title).not.toBe("");
    expect(t.n.el.querySelector("button")!.className).toBe("btn banner__act");
    t.n.el.querySelector("button")!.click();
    expect(t.onOpen).toHaveBeenCalledTimes(1);
  });

  it("wears the danger tint for failed and late, the information tint for nothing yet", async () => {
    const t = build(failed);
    await flush();
    expect(t.n.el.classList.contains("banner--danger")).toBe(true);
    t.set({ kind: "never", dir: null, at: null, message: null, check: false });
    await t.n.refresh();
    expect(t.n.el.hidden).toBe(false);
    expect(t.n.el.classList.contains("banner--danger")).toBe(false);
  });

  it("never asks, and never shows, for someone who is not an admin", async () => {
    const t = build(failed, false);
    await flush();
    expect(t.api.backupNotice).not.toHaveBeenCalled();
    expect(t.n.el.hidden).toBe(true);
  });

  it("a failed request hides it rather than raising an alarm it cannot back", async () => {
    const t = build(new Error("offline"));
    await flush();
    expect(t.n.el.hidden).toBe(true);
  });

  it("stands down while the console is open, and re-asks on leaving it", async () => {
    const t = build(failed);
    await flush();
    t.n.setConsoleOpen(true);
    expect(t.n.el.hidden).toBe(true);
    t.set({ kind: "none", dir: null, at: null, message: null, check: false }); // fixed in the console
    t.n.setConsoleOpen(false);
    await flush();
    expect(t.api.backupNotice).toHaveBeenCalledTimes(2);
    expect(t.n.el.hidden).toBe(true);
    t.n.destroy();
  });
});
