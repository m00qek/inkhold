// The admin console: actions, copy, storage, devices, allotment and retention.

import { describe, it, expect } from "vitest";
import { accountAge, deviceMeta, deviceTitle, displayName, failureMessage, formatBytes, initials, memoryCard, meterFor, GB, RETENTION_NEVER_PURGES, type AdminState } from "../../src/pages/admin/admin";
import { ApiError, RateLimitError } from "../../src/api/client";
import type { AdminDevice, AdminUser } from "../../src/api/adminTypes";

// --- fixtures ----------------------------------------------------------------
import { ANA, RUI, elevationRequired, NOMAD, server, build, shown } from "./admin.shared";

const rowOf = (state: AdminState, email: string) =>
  state.kind === "ready" ? state.people.find((p) => p.user.email === email) : undefined;

describe("admin console: actions", () => {
  it("shows the server-generated password after adding someone, once", async () => {
    const t = build();
    await t.console.unlock("correct");
    t.answers.newPerson = { email: "sofia@household.lan", isAdmin: false };

    await t.console.addPerson();

    expect(t.api.adminCreateUser).toHaveBeenCalledWith("sofia@household.lan", false);
    expect(t.seen.handOvers).toEqual([{ email: "sofia@household.lan", password: "plum-otter-14" }]);
    expect(shown(t.console.state())).toContain("sofia@household.lan");
  });

  it("never sends a password the client invented", async () => {
    const t = build();
    await t.console.unlock("correct");
    t.answers.newPerson = { email: "sofia@household.lan", isAdmin: true };
    await t.console.addPerson();
    expect(t.api.adminCreateUser.mock.calls[0]).toEqual(["sofia@household.lan", true]);
  });

  it("cancelling the add dialog creates nobody", async () => {
    const t = build();
    await t.console.unlock("correct");
    t.answers.newPerson = null;
    await t.console.addPerson();
    expect(t.api.adminCreateUser).not.toHaveBeenCalled();
    expect(t.view.handOver).not.toHaveBeenCalled();
  });

  it("surfaces a duplicate address as something the admin can act on", async () => {
    const t = build();
    await t.console.unlock("correct");
    t.answers.newPerson = { email: "rui@household.lan", isAdmin: false };
    t.api.adminCreateUser.mockRejectedValueOnce(new ApiError("EMAIL_EXISTS", "an account with that email already exists", 200));

    await t.console.addPerson();

    expect(t.view.toast).toHaveBeenCalledWith("There is already an account with that address.");
    expect(t.console.state().kind).toBe("ready");
    expect(t.view.handOver).not.toHaveBeenCalled();
  });

  it("resets a password and hands the new one over", async () => {
    const t = build();
    await t.console.unlock("correct");
    await t.console.resetPassword(RUI);
    expect(t.api.adminResetPassword).toHaveBeenCalledWith(RUI.id);
    expect(t.seen.handOvers).toEqual([{ email: "rui@household.lan", password: "river-copper-08" }]);
    const ready = t.console.state();
    expect(ready.kind === "ready" && rowOf(ready, RUI.email)?.user.mustChangePassword).toBe(true);
  });

  it("does not dress a password reset as destruction", async () => {
    const t = build();
    await t.console.unlock("correct");
    await t.console.resetPassword(RUI);
    expect(t.seen.confirms[0]?.danger).toBe(false);
    expect(t.seen.confirms[0]?.confirmWord).toBeUndefined();
  });

  it("declining the reset leaves the account alone", async () => {
    const t = build();
    await t.console.unlock("correct");
    t.answers.confirm = false;
    await t.console.resetPassword(RUI);
    expect(t.api.adminResetPassword).not.toHaveBeenCalled();
    expect(t.view.handOver).not.toHaveBeenCalled();
  });

  it("guards deletion with type-to-confirm, on the address", async () => {
    const t = build();
    await t.console.unlock("correct");
    await t.console.deletePerson(RUI);
    const spec = t.seen.confirms[0]!;
    expect(spec.confirmWord).toBe("rui@household.lan");
    expect(spec.danger).toBe(true);
    expect(spec.label).toBe("Delete permanently");
  });

  it("declining the delete removes nobody", async () => {
    const t = build();
    await t.console.unlock("correct");
    t.answers.confirm = false;
    await t.console.deletePerson(RUI);
    expect(t.api.adminDeleteUser).not.toHaveBeenCalled();
    expect(shown(t.console.state())).toEqual(["ana@household.lan", "rui@household.lan"]);
  });

  it("a refused delete leaves the row exactly where it was", async () => {
    const t = build();
    await t.console.unlock("correct");
    t.api.adminDeleteUser.mockRejectedValueOnce(new ApiError("LAST_ADMIN", "cannot remove the last administrator", 200));

    await t.console.deletePerson(ANA);

    expect(shown(t.console.state())).toContain("ana@household.lan");
    expect(t.view.toast).toHaveBeenCalledWith("That is the last administrator. Make someone else an admin first.");
  });

  it("ignores every action while the gate is up", async () => {
    const t = build();
    await t.console.open();
    await t.console.addPerson();
    await t.console.resetPassword(RUI);
    await t.console.deletePerson(RUI);
    expect(t.view.confirm).not.toHaveBeenCalled();
    expect(t.view.askNewPerson).not.toHaveBeenCalled();
  });
});

// --- what the console will not say -------------------------------------------

describe("admin console: what it does not show", () => {
  it("carries no per-person activity on a row", async () => {
    const t = build();
    await t.console.unlock("correct");
    const ready = t.console.state();
    expect(ready.kind).toBe("ready");
    const person = ready.kind === "ready" ? ready.people[0]!.user : ANA;
    expect(Object.keys(person).sort()).toEqual(["createdAt", "email", "id", "isAdmin", "mustChangePassword"]);
  });
});

// --- the pure helpers --------------------------------------------------------

describe("admin console: naming and dates", () => {
  it("names a person by the local part, the same way the rail's footer does", () => {
    expect(displayName("ana@household.lan")).toBe("ana");
    expect(displayName("@household.lan")).toBe("@household.lan");
    expect(displayName("root")).toBe("root");
  });

  it("takes initials from the separated parts", () => {
    expect(initials("ana.oliveira@household.lan")).toBe("AO");
    expect(initials("rui@household.lan")).toBe("RU");
    expect(initials("x@household.lan")).toBe("X");
  });

  it("renders an absent creation date as nothing, never as 1970", () => {
    // The server omits null optionals, so `0` means not sent, not the epoch.
    expect(accountAge(0)).toBe("");
    expect(accountAge(Number.NaN)).toBe("");
    expect(accountAge(-1)).toBe("");
    expect(accountAge(1_751_500_000)).toMatch(/2025/);
  });

  it("keeps the client's own message for anything it has no better word for", () => {
    expect(failureMessage(new ApiError("NETWORK", "Can't reach the server.", 0))).toBe("Can't reach the server.");
    expect(failureMessage(new Error("boom"))).toBe("Something went wrong. Try again.");
    expect(failureMessage(new RateLimitError(null))).toBe("Too many attempts.");
  });
});

// --- the three shapes the UI must draw honestly ------------------------------

describe("admin console: storage, drawn honestly", () => {
  it("reads used against allotted, in units a person reasons about", () => {
    const m = meterFor({ usedBytes: 5.4 * GB, totalBytes: 10 * GB });
    expect(m.label).toBe("5.4 GB of 10.0 GB");
    expect(m.tone).toBe("normal");
    expect(m.fill).toBe(54);
    expect(m.overBytes).toBe(0);
  });

  it("turns tight at 90%, because a device at 96% is about to fail a sync", () => {
    expect(meterFor({ usedBytes: 8.9 * GB, totalBytes: 10 * GB }).tone).toBe("normal");
    expect(meterFor({ usedBytes: 9 * GB, totalBytes: 10 * GB }).tone).toBe("tight");
    expect(meterFor({ usedBytes: 9.6 * GB, totalBytes: 10 * GB }).tone).toBe("tight");
  });

  it("NAMES the over-quota state instead of clamping the bar and saying nothing", () => {
    const m = meterFor({ usedBytes: 11.2 * GB, totalBytes: 10 * GB });
    expect(m.tone).toBe("over");
    expect(m.overBytes).toBeCloseTo(1.2 * GB, -6);
    expect(m.label).toContain("over");
    expect(m.label).toContain("1.2 GB");
    expect(m.fill).toBe(100);
  });

  it("treats a zero allotment as a limit of nothing, never as no limit", () => {
    expect(meterFor({ usedBytes: 0, totalBytes: 0 })).toMatchObject({ tone: "normal", label: "No allotment set" });
    const stored = meterFor({ usedBytes: 2 * GB, totalBytes: 0 });
    expect(stored.tone).toBe("over");
    expect(stored.label).toContain("no allotment");
  });

  it("formats bytes in the largest unit that leaves a number worth reading", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(5 * 1024 ** 2)).toBe("5 MB");
    expect(formatBytes(1.25 * GB)).toBe("1.3 GB");
    expect(formatBytes(-1)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
  });
});

describe("admin console: memory, which can be unknown", () => {
  it("says unknown rather than 0 B where the platform cannot report it", () => {
    const card = memoryCard({
      version: "0.0.1",
      memoryBytes: null,
      memoryBudgetBytes: 50 * 1024 ** 2,
      blobBytes: 0,
      blobCount: 0,
    });
    expect(card.value).toBe("unknown");
    expect(card.value).not.toContain("0");
    expect(card.meter).toBeNull();
  });

  it("never shows memory alone — always against the budget it is measured on", () => {
    const card = memoryCard({
      version: "0.0.1",
      memoryBytes: 31 * 1024 ** 2,
      memoryBudgetBytes: 50 * 1024 ** 2,
      blobBytes: 0,
      blobCount: 0,
    });
    expect(card.value).toBe("31 MB");
    expect(card.sub).toBe("of 50 MB budget");
    expect(card.meter?.fill).toBe(62);
  });
});

describe("admin console: devices", () => {
  it("drops a part it does not have rather than printing a dash that looks like one", () => {
    expect(deviceTitle(NOMAD)).toBe("Nomad (A5X2)");
    expect(deviceTitle({ ...NOMAD, model: null })).toBe("Nomad");
    expect(deviceMeta(NOMAD)).toContain("fw 3.20.29");
    expect(deviceMeta({ ...NOMAD, firmware: null })).not.toContain("fw");
    expect(deviceMeta({ ...NOMAD, firmware: null, createdAt: 0 })).toBe("SN1000A2X");
  });

  it("keeps a revoked binding in the list — it is what makes re-pairing possible", async () => {
    const t = build();
    await t.console.unlock("correct");
    const rui = rowOf(t.console.state(), RUI.email);
    expect(rui?.devices).toHaveLength(2);
    expect(rui?.devices?.some((d) => !d.active)).toBe(true);
  });

  it("unlinks after confirming, and states what re-linking costs", async () => {
    const t = build();
    await t.console.unlock("correct");
    const rui = rowOf(t.console.state(), RUI.email)!;
    const device = rui.devices!.find((d) => d.active)!;

    await t.console.unlinkDevice(rui, device);

    expect(t.api.adminUnlinkDevice).toHaveBeenCalledWith(RUI.id, device.equipmentNo);
    const spec = t.seen.confirms[0]!;
    expect(spec.danger).toBe(true);
    expect(spec.text).toContain("device in hand");
    const after = rowOf(t.console.state(), RUI.email);
    expect(after?.devices).toHaveLength(2);
    expect(after?.devices?.find((d) => d.equipmentNo === device.equipmentNo)?.active).toBe(false);
  });

  it("declining the unlink leaves the device syncing", async () => {
    const t = build();
    await t.console.unlock("correct");
    const rui = rowOf(t.console.state(), RUI.email)!;
    t.answers.confirm = false;
    await t.console.unlinkDevice(rui, rui.devices!.find((d) => d.active)!);
    expect(t.api.adminUnlinkDevice).not.toHaveBeenCalled();
  });

  it("a person whose devices could not be listed still renders", async () => {
    const t = build();
    t.api.adminListDevices.mockRejectedValueOnce(new ApiError("SERVER", "boom", 500));
    await t.console.unlock("correct");
    expect(rowOf(t.console.state(), ANA.email)?.devices).toBeNull();
    expect(shown(t.console.state())).toHaveLength(2);
  });
});

describe("admin console: the allotment", () => {
  it("edits in gigabytes and sends bytes", async () => {
    const t = build();
    await t.console.unlock("correct");
    const rui = rowOf(t.console.state(), RUI.email)!;
    t.answers.number = 20;

    await t.console.setQuota(rui);

    expect(t.api.adminSetQuota).toHaveBeenCalledWith(RUI.id, 20 * GB);
    expect(t.seen.numbers[0]?.label).toBe("Gigabytes");
    expect(t.seen.numbers[0]?.value).toBe(10);
  });

  it("allows an allotment below current usage, and says what that did", async () => {
    const t = build();
    await t.console.unlock("correct");
    const ana = rowOf(t.console.state(), ANA.email)!;
    t.answers.number = 1;

    await t.console.setQuota(ana);

    expect(t.api.adminSetQuota).toHaveBeenCalledWith(ANA.id, GB);
    const after = rowOf(t.console.state(), ANA.email)!;
    expect(after.quota).toEqual({ usedBytes: 5 * GB, totalBytes: GB });
    expect(t.view.toast).toHaveBeenCalledWith(expect.stringContaining("over their allotment"));
  });

  it("tells the admin what they are working against before they type", async () => {
    const t = build();
    await t.console.unlock("correct");
    await t.console.setQuota(rowOf(t.console.state(), ANA.email)!);
    expect(t.seen.numbers[0]?.hint).toContain("5.0 GB");
    expect(t.seen.numbers[0]?.text).toContain("does not delete anything");
  });

  it("cancelling changes nothing", async () => {
    const t = build();
    await t.console.unlock("correct");
    t.answers.number = null;
    await t.console.setQuota(rowOf(t.console.state(), ANA.email)!);
    expect(t.api.adminSetQuota).not.toHaveBeenCalled();
  });

  it("a person whose quota could not be counted still renders, without a meter", async () => {
    const t = build();
    t.api.adminGetQuota.mockRejectedValueOnce(new ApiError("SERVER", "boom", 500));
    await t.console.unlock("correct");
    expect(rowOf(t.console.state(), ANA.email)?.quota).toBeNull();
    expect(shown(t.console.state())).toHaveLength(2);
  });
});

describe("admin console: retention", () => {
  it("carries the server's own bounds into the field", async () => {
    const t = build();
    await t.console.unlock("correct");
    await t.console.setRetention();
    const spec = t.seen.numbers[0]!;
    expect(spec).toMatchObject({ label: "Days", value: 30, min: 1, max: 365, step: 1 });
  });

  it("promises, where the control is, that lowering it purges nothing", async () => {
    const t = build();
    await t.console.unlock("correct");
    await t.console.setRetention();
    expect(t.seen.numbers[0]?.hint).toBe(RETENTION_NEVER_PURGES);
    expect(RETENTION_NEVER_PURGES).toContain("full new window");
  });

  it("saves the new window", async () => {
    const t = build();
    await t.console.unlock("correct");
    t.answers.number = 7;
    await t.console.setRetention();
    expect(t.api.adminSetRetention).toHaveBeenCalledWith(7);
    expect(t.console.state().kind === "ready" && (t.console.state() as { server: { retention: { retentionDays: number } | null } }).server.retention?.retentionDays).toBe(7);
    expect(t.view.toast).toHaveBeenCalledWith("Notes now wait 7 days before being removed");
  });
});

describe("admin console: the server panel", () => {
  it("loads health and retention alongside the people", async () => {
    const t = build();
    await t.console.unlock("correct");
    const s = t.console.state();
    expect(s.kind).toBe("ready");
    if (s.kind !== "ready") return;
    expect(s.server.health?.version).toBe("0.0.1");
    expect(s.server.retention?.retentionDays).toBe(30);
    expect(Object.keys(s.server.health!).sort()).toEqual([
      "blobBytes",
      "blobCount",
      "memoryBudgetBytes",
      "memoryBytes",
      "version",
    ]);
  });

  it("still shows the household when health cannot be read", async () => {
    const t = build();
    t.api.adminHealth.mockRejectedValueOnce(new ApiError("SERVER", "boom", 500));
    await t.console.unlock("correct");
    const s = t.console.state();
    expect(s.kind === "ready" && s.server.health).toBeNull();
    expect(shown(s)).toHaveLength(2);
  });

  it("routes a lapsed elevation from a DETAIL call to the gate, not to a blank panel", async () => {
    const t = build();
    await t.console.unlock("correct");
    t.api.adminGetQuota.mockRejectedValueOnce(elevationRequired());
    await t.console.open();
    expect(t.console.state().kind).toBe("locked");
  });
});
