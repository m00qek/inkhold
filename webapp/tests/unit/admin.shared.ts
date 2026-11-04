// Helpers shared by the admin tests.

import { vi } from "vitest";
import { createAdminConsole, GB, type AdminApi, type AdminState, type AdminView, type ConfirmSpec, type NewPerson, type NumberSpec } from "../../src/pages/admin/admin";
import { ApiError } from "../../src/api/client";
import type { AdminDevice, AdminUser } from "../../src/api/adminTypes";

// --- fixtures ----------------------------------------------------------------

export const ANA: AdminUser = {
  id: 1,
  email: "ana@household.lan",
  isAdmin: true,
  mustChangePassword: false,
  createdAt: 1_751_500_000,
};

export const RUI: AdminUser = {
  id: 2,
  email: "rui@household.lan",
  isAdmin: false,
  mustChangePassword: false,
  createdAt: 1_747_500_000,
};

export const elevationRequired = () => new ApiError("ELEVATION_REQUIRED", "Confirm your password to continue.", 428);

/** A fake server where every admin call answers 428 until `elevated`. */
export const NOMAD: AdminDevice = {
  equipmentNo: "SN1000A2X",
  name: "Nomad",
  model: "A5X2",
  firmware: "3.20.29",
  active: true,
  createdAt: 1_751_500_000,
};

export const RETIRED: AdminDevice = { ...NOMAD, equipmentNo: "SN1000C1M", active: false };

export function server(people: AdminUser[] = [ANA, RUI]) {
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

export function view() {
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

export function build(people?: AdminUser[]) {
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

export const shown = (state: AdminState | undefined): string[] =>
  state?.kind === "ready" ? state.people.map((p) => p.user.email) : [];
