import { describe, it, expect, vi } from "vitest";
import {
  createAdminConsole,
  accountAge,
  deviceMeta,
  deviceTitle,
  displayName,
  failureMessage,
  formatBytes,
  initials,
  memoryCard,
  meterFor,
  GB,
  RETENTION_NEVER_PURGES,
  type AdminApi,
  type AdminState,
  type AdminView,
  type ConfirmSpec,
  type NewPerson,
  type NumberSpec,
} from "../../src/pages/admin";
import { ApiError, RateLimitError } from "../../src/api/client";
import type { AdminDevice, AdminUser } from "../../src/api/adminTypes";

// --- fixtures ----------------------------------------------------------------

const ANA: AdminUser = {
  id: 1,
  email: "ana@household.lan",
  isAdmin: true,
  mustChangePassword: false,
  createdAt: 1_751_500_000,
};
const RUI: AdminUser = {
  id: 2,
  email: "rui@household.lan",
  isAdmin: false,
  mustChangePassword: false,
  createdAt: 1_747_500_000,
};

const elevationRequired = () => new ApiError("ELEVATION_REQUIRED", "Confirm your password to continue.", 428);

/** A fake server where every admin call answers 428 until `elevated`. */
const NOMAD: AdminDevice = {
  equipmentNo: "SN1000A2X",
  name: "Nomad",
  model: "A5X2",
  firmware: "3.20.29",
  active: true,
  createdAt: 1_751_500_000,
};
const RETIRED: AdminDevice = { ...NOMAD, equipmentNo: "SN1000C1M", active: false };

function server(people: AdminUser[] = [ANA, RUI]) {
  const state = {
    elevated: false,
    people: [...people],
    nextId: 9,
    devices: { 1: [NOMAD], 2: [{ ...NOMAD, equipmentNo: "SN1000B7K" }, RETIRED] } as Record<number, AdminDevice[]>,
    quotas: { 1: { usedBytes: 5 * GB, totalBytes: 10 * GB }, 2: { usedBytes: 11 * GB, totalBytes: 10 * GB } } as Record<
      number,
      { usedBytes: number; totalBytes: number }
    >,
    retentionDays: 30,
  };

  const gated = <T>(fn: () => T): Promise<T> =>
    state.elevated ? Promise.resolve(fn()) : Promise.reject(elevationRequired());

  const api = {
    adminListUsers: vi.fn(() => gated(() => state.people.map((p) => ({ ...p })))),
    adminCreateUser: vi.fn((email: string, isAdmin: boolean) =>
      gated(() => {
        state.people.push({ id: state.nextId++, email, isAdmin, mustChangePassword: true, createdAt: 1_760_000_000 });
        return "plum-otter-14";
      }),
    ),
    adminDeleteUser: vi.fn((id: number) =>
      gated(() => void state.people.splice(state.people.findIndex((p) => p.id === id), 1)),
    ),
    adminResetPassword: vi.fn((id: number) =>
      gated(() => {
        const p = state.people.find((x) => x.id === id);
        if (p) p.mustChangePassword = true;
        return "river-copper-08";
      }),
    ),
    adminElevate: vi.fn(async (_account: string, plaintext: string) => {
      if (plaintext !== "correct") throw new ApiError("INVALID_CREDENTIALS", "password incorrect", 200);
      state.elevated = true;
    }),
    adminLock: vi.fn(async () => void (state.elevated = false)),
    adminListDevices: vi.fn((id: number) => gated(() => (state.devices[id] ?? []).map((d) => ({ ...d })))),
    adminUnlinkDevice: vi.fn((id: number, no: string) =>
      gated(() => {
        const d = state.devices[id]?.find((x) => x.equipmentNo === no);
        if (d) d.active = false;
      }),
    ),
    adminGetQuota: vi.fn((id: number) => gated(() => ({ ...(state.quotas[id] ?? { usedBytes: 0, totalBytes: 0 }) }))),
    adminSetQuota: vi.fn((id: number, totalBytes: number) =>
      gated(() => {
        const q = state.quotas[id] ?? { usedBytes: 0, totalBytes: 0 };
        q.totalBytes = totalBytes;
        state.quotas[id] = q;
        return { ...q };
      }),
    ),
    adminGetRetention: vi.fn(() =>
      gated(() => ({ retentionDays: state.retentionDays, defaultDays: 30, minDays: 1, maxDays: 365, changedAt: 0 })),
    ),
    adminSetRetention: vi.fn((days: number) =>
      gated(() => {
        state.retentionDays = days;
        return { retentionDays: days, defaultDays: 30, minDays: 1, maxDays: 365, changedAt: 1_760_000_000 };
      }),
    ),
    adminHealth: vi.fn(() =>
      gated(() => ({
        version: "0.0.1",
        memoryBytes: 31 * 1024 * 1024,
        memoryBudgetBytes: 50 * 1024 * 1024,
        blobBytes: 4 * GB,
        blobCount: 1284,
      })),
    ),
  } satisfies AdminApi;

  return { api, state };
}

function view() {
  const painted: AdminState[] = [];
  const answers = {
    confirm: true as boolean,
    newPerson: null as NewPerson | null,
    number: null as number | null,
  };
  const seen = {
    confirms: [] as ConfirmSpec[],
    handOvers: [] as { email: string; password: string }[],
    numbers: [] as NumberSpec[],
  };

  const v: AdminView = {
    render: vi.fn((s: AdminState) => void painted.push(structuredClone(s))),
    confirm: vi.fn(async (spec: ConfirmSpec) => {
      seen.confirms.push(spec);
      return answers.confirm;
    }),
    askNewPerson: vi.fn(async () => answers.newPerson),
    askNumber: vi.fn(async (spec: NumberSpec) => {
      seen.numbers.push(spec);
      return answers.number;
    }),
    handOver: vi.fn(async (spec) => void seen.handOvers.push({ ...spec })),
    toast: vi.fn(),
  };
  return { view: v, painted, answers, seen, last: () => painted[painted.length - 1] };
}

function build(people?: AdminUser[]) {
  const s = server(people);
  const v = view();
  const onSessionExpired = vi.fn();
  const onElevationChanged = vi.fn();
  const console_ = createAdminConsole({
    api: s.api,
    view: v.view,
    account: "ana@household.lan",
    onSessionExpired,
    onElevationChanged,
  });
  return { ...s, ...v, console: console_, onSessionExpired, onElevationChanged };
}

const shown = (state: AdminState | undefined): string[] =>
  state?.kind === "ready" ? state.people.map((p) => p.user.email) : [];

const rowOf = (state: AdminState, email: string) =>
  state.kind === "ready" ? state.people.find((p) => p.user.email === email) : undefined;

const flush = (): Promise<void> => new Promise((r) => void setTimeout(r, 0));

// --- the gate ----------------------------------------------------------------

describe("admin console: the gate", () => {
  it("starts locked and shows no household before the password is confirmed", () => {
    const t = build();
    expect(t.console.state()).toEqual({ kind: "locked", error: null, busy: false });
    expect(t.api.adminListUsers).not.toHaveBeenCalled();
  });

  it("opening while un-elevated asks for the list, is refused, and returns to the gate", async () => {
    const t = build();
    await t.console.open();
    expect(t.api.adminListUsers).toHaveBeenCalledTimes(1);
    expect(t.console.state()).toEqual({ kind: "locked", error: null, busy: false });
    expect(t.last()).toEqual({ kind: "locked", error: null, busy: false });
  });

  it("a wrong password keeps the gate up, says so, and never lists", async () => {
    const t = build();
    await t.console.unlock("nope");
    expect(t.console.state()).toEqual({
      kind: "locked",
      error: "That password doesn't match.",
      busy: false,
    });
    expect(t.api.adminListUsers).not.toHaveBeenCalled();
  });

  it("does not distinguish a wrong password from a caller who is not an admin", async () => {
    // Both are INVALID_CREDENTIALS by design, so the endpoint cannot enumerate admins.
    const t = build();
    t.api.adminElevate.mockRejectedValueOnce(new ApiError("INVALID_CREDENTIALS", "password incorrect", 200));
    await t.console.unlock("whatever");
    expect((t.console.state() as { error: string }).error).toBe("That password doesn't match.");
  });

  it("reports a rate limit as attempts, not as a bad password", async () => {
    const t = build();
    t.api.adminElevate.mockRejectedValueOnce(new RateLimitError(42));
    await t.console.unlock("correct");
    expect((t.console.state() as { error: string }).error).toBe("Too many attempts. Try again in 42s.");
  });

  it("a correct password elevates and lists the household", async () => {
    const t = build();
    await t.console.unlock("correct");
    expect(t.api.adminElevate).toHaveBeenCalledWith("ana@household.lan", "correct");
    expect(shown(t.console.state())).toEqual(["ana@household.lan", "rui@household.lan"]);
  });

  it("marks itself busy while the password is in flight, so it cannot be sent twice", async () => {
    const t = build();
    const inFlight = t.console.unlock("correct");
    expect(t.console.state()).toEqual({ kind: "locked", error: null, busy: true });
    await t.console.unlock("correct");
    await inFlight;
    expect(t.api.adminElevate).toHaveBeenCalledTimes(1);
  });

  it("locking returns to the gate immediately, before the server has answered", async () => {
    const t = build();
    await t.console.unlock("correct");
    let release = (): void => {};
    t.api.adminLock.mockImplementationOnce(() => new Promise<void>((r) => void (release = r)));

    const locking = t.console.lock();
    expect(t.console.state()).toEqual({ kind: "locked", error: null, busy: false });
    release();
    await locking;
    expect(t.api.adminLock).toHaveBeenCalled();
  });

  it("routes a dead session to the shell, never to its own gate", async () => {
    const t = build();
    t.api.adminListUsers.mockRejectedValueOnce(new ApiError("UNAUTHORIZED", "Your session has ended.", 401));
    await t.console.open();
    expect(t.onSessionExpired).toHaveBeenCalledTimes(1);
    // 401 is a dead session; 428 is a live one that needs re-confirming.
    expect(t.view.confirm).not.toHaveBeenCalled();
  });
});

// --- elevation, as seen from outside the console -----------------------------

describe("admin console: elevation, as the rail sees it", () => {
  it("is locked before anything has been asked, and stays locked through a refused open", async () => {
    const t = build();
    expect(t.console.isElevated()).toBe(false);
    expect(t.onElevationChanged).not.toHaveBeenCalled();

    await t.console.open();
    expect(t.console.isElevated()).toBe(false);
    expect(t.onElevationChanged).not.toHaveBeenCalled();
  });

  it("does not read as elevated merely because the console is mid-load", async () => {
    // `open()` paints `loading` before the server answers; that is not elevation.
    const t = build();
    const opening = t.console.open();
    expect(t.console.state().kind).toBe("loading");
    expect(t.console.isElevated()).toBe(false);
    await opening;
  });

  it("opens on a successful unlock and announces it exactly once", async () => {
    const t = build();
    await t.console.unlock("correct");
    expect(t.console.isElevated()).toBe(true);
    expect(t.onElevationChanged).toHaveBeenCalledTimes(1);
  });

  it("closes on lock, and announces that too", async () => {
    const t = build();
    await t.console.unlock("correct");
    t.onElevationChanged.mockClear();
    await t.console.lock();
    expect(t.console.isElevated()).toBe(false);
    expect(t.onElevationChanged).toHaveBeenCalledTimes(1);
  });

  it("closes when the window lapses under the admin and the gate goes back up", async () => {
    const t = build();
    await t.console.unlock("correct");
    t.onElevationChanged.mockClear();

    t.state.elevated = false;
    const deleting = t.console.deletePerson(RUI);
    await flush();
    expect(t.console.state().kind).toBe("locked");
    expect(t.console.isElevated()).toBe(false);
    expect(t.onElevationChanged).toHaveBeenCalledTimes(1);

    await t.console.unlock("correct");
    await deleting;
    expect(t.console.isElevated()).toBe(true);
  });

  it("closes when the session itself dies — elevation cannot outlive it", async () => {
    const t = build();
    await t.console.unlock("correct");
    t.onElevationChanged.mockClear();

    t.api.adminListUsers.mockRejectedValueOnce(new ApiError("UNAUTHORIZED", "Your session has ended.", 401));
    await t.console.open();
    expect(t.console.isElevated()).toBe(false);
    expect(t.onElevationChanged).toHaveBeenCalledTimes(1);
  });

  it("says nothing on a refresh that did not change hands", async () => {
    const t = build();
    await t.console.unlock("correct");
    t.onElevationChanged.mockClear();
    await t.console.open();
    expect(t.console.isElevated()).toBe(true);
    expect(t.onElevationChanged).not.toHaveBeenCalled();
  });

  it("opens without an unlock when the session was ALREADY elevated", async () => {
    const t = build();
    t.state.elevated = true;
    await t.console.open();
    expect(t.console.isElevated()).toBe(true);
    expect(t.onElevationChanged).toHaveBeenCalledTimes(1);
  });
});

// --- the elevate-and-retry loop ----------------------------------------------

describe("admin console: elevate and retry", () => {
  it("resumes the call that hit the gate, rather than making the admin re-click it", async () => {
    const t = build();
    await t.console.unlock("correct");
    t.state.elevated = false;

    const deleting = t.console.deletePerson(RUI);
    await flush();
    expect(t.console.state().kind).toBe("locked");

    await t.console.unlock("correct");
    await deleting;

    expect(t.api.adminDeleteUser).toHaveBeenCalledTimes(2);
    expect(t.api.adminDeleteUser).toHaveBeenCalledWith(RUI.id);
    expect(shown(t.console.state())).toEqual(["ana@household.lan"]);
    expect(t.view.confirm).toHaveBeenCalledTimes(1);
  });

  it("retries exactly once — a second refusal is not retried again", async () => {
    const t = build();
    await t.console.unlock("correct");
    // The server keeps refusing after a successful elevate (clock skew, revoked session).
    t.api.adminDeleteUser.mockRejectedValue(elevationRequired());

    const deleting = t.console.deletePerson(RUI);
    await flush();
    await t.console.unlock("correct");
    await deleting;

    expect(t.api.adminDeleteUser).toHaveBeenCalledTimes(2);
    expect(t.console.state().kind).toBe("locked");
  });

  it("a gate that is locked instead of satisfied abandons the call, changing nothing", async () => {
    const t = build();
    await t.console.unlock("correct");
    t.state.elevated = false;

    const deleting = t.console.deletePerson(RUI);
    await flush();
    await t.console.lock();

    await deleting;
    expect(t.api.adminDeleteUser).toHaveBeenCalledTimes(1);
    expect(t.console.state().kind).toBe("locked");
  });

  it("parks several refused calls on one gate and releases them all", async () => {
    const t = build();
    await t.console.unlock("correct");
    t.state.elevated = false;

    const a = t.console.deletePerson(RUI);
    const b = t.console.resetPassword(ANA);
    await flush();
    await t.console.unlock("correct");
    await Promise.all([a, b]);

    expect(t.api.adminDeleteUser).toHaveBeenCalledTimes(2);
    expect(t.api.adminResetPassword).toHaveBeenCalledTimes(2);
    expect(t.console.state().kind).toBe("ready");
  });

  it("opening the console does not park on the gate, so walking away leaks nothing", async () => {
    const t = build();
    await t.console.open();
    expect(t.console.state().kind).toBe("locked");
    expect(t.api.adminListUsers).toHaveBeenCalledTimes(1);
  });
});

// --- the actions -------------------------------------------------------------

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
