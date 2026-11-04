// The fake API's admin console: a mutable household, elevation, quotas and health.

import { delay } from "./fake";

export function fakeAdminMethods(latency: number) {
  // Per instance: each fake API gets its own household to mutate.
  const people = [
    { id: 1, email: "ana@household.lan", isAdmin: true, mustChangePassword: false, createdAt: 1_751_500_000 },
    { id: 2, email: "rui@household.lan", isAdmin: false, mustChangePassword: false, createdAt: 1_747_500_000 },
    { id: 3, email: "guest@household.lan", isAdmin: false, mustChangePassword: true, createdAt: 1_753_000_000 },
  ];
  let nextId = 4;

  /** Starts locked, so dev and e2e land on the gate first, as the real console does. */
  let elevated = false;

  /** The only password the fake accepts, so the wrong-password branch is reachable. */
  const PASSWORD = "inkhold";

  /**
   * The real `ApiError`, because `dispatchApiFailure` routes on `instanceof`.
   * Imported dynamically: no top-level import of client.ts here.
   */
  const httpError = async (code: string, message: string, status: number): Promise<Error> => {
    const { ApiError } = await import("./client");
    return new ApiError(code, message, status);
  };
  const needsElevation = () =>
    httpError("ELEVATION_REQUIRED", "Confirm your password to continue.", 428);

  const GB = 1024 * 1024 * 1024;

  /** Rui has a revoked device, so the re-pairable row is on screen. */
  const devices: Record<number, { equipmentNo: string; name: string; model: string | null; firmware: string | null; active: boolean; createdAt: number }[]> = {
    1: [{ equipmentNo: "SN1000A2X", name: "Nomad", model: "A5X2", firmware: "3.20.29", active: true, createdAt: 1_751_500_000 }],
    2: [
      { equipmentNo: "SN1000B7K", name: "Manta", model: "A6X2", firmware: "3.21.02", active: true, createdAt: 1_747_600_000 },
      { equipmentNo: "SN1000C1M", name: "Nomad", model: "A5X2", firmware: "3.19.11", active: false, createdAt: 1_735_700_000 },
    ],
    // Guest has none: the "no device linked yet" state.
    3: [],
  };

  /** Rui is over his allotment, which the meter must draw rather than clamp. */
  const quotas: Record<number, { usedBytes: number; totalBytes: number }> = {
    1: { usedBytes: 5.4 * GB, totalBytes: 10 * GB },
    2: { usedBytes: 11.2 * GB, totalBytes: 10 * GB },
    3: { usedBytes: 0, totalBytes: 2 * GB },
  };

  let retentionDays = 30;
  let retentionChangedAt = 0;

  const notFound = () => httpError("USER_NOT_FOUND", "no such user", 404);

  /** A readable temporary password, in the shape the server generates. */
  const tempPassword = (): string => {
    const nouns = ["plum", "river", "otter", "copper", "linen", "cedar"];
    const pick = () => nouns[Math.floor(Math.random() * nouns.length)]!;
    return `${pick()}-${pick()}-${String(Math.floor(Math.random() * 90) + 10)}`;
  };

  return {
    async adminListUsers() {
      await delay(latency);
      if (!elevated) throw await needsElevation();
      return people.map((p) => ({ ...p }));
    },

    async adminCreateUser(email: string, isAdmin: boolean): Promise<string> {
      await delay(latency);
      if (!elevated) throw await needsElevation();
      const address = email.trim().toLowerCase();
      if (people.some((p) => p.email.toLowerCase() === address)) {
        throw await httpError("EMAIL_EXISTS", "an account with that email already exists", 200);
      }
      // Must-change from birth, as on the real server.
      const id = nextId++;
      people.push({ id, email: address, isAdmin, mustChangePassword: true, createdAt: Date.now() / 1000 });
      // Accounting rows at creation, like the server's `ensureCapacity`.
      quotas[id] = { usedBytes: 0, totalBytes: 2 * GB };
      devices[id] = [];
      return tempPassword();
    },

    async adminDeleteUser(id: number): Promise<void> {
      await delay(latency);
      if (!elevated) throw await needsElevation();
      const at = people.findIndex((p) => p.id === id);
      if (at < 0) return;
      // The server refuses deleting the last administrator.
      if (people[at]!.isAdmin && people.filter((p) => p.isAdmin).length <= 1) {
        throw await httpError("LAST_ADMIN", "cannot remove the last administrator", 200);
      }
      const [gone] = people.splice(at, 1);
      // By hand what the server's FK cascade does, so a recycled id has a clean meter.
      if (gone) {
        delete quotas[gone.id];
        delete devices[gone.id];
      }
    },

    async adminResetPassword(id: number): Promise<string> {
      await delay(latency);
      if (!elevated) throw await needsElevation();
      const person = people.find((p) => p.id === id);
      if (person) person.mustChangePassword = true;
      return tempPassword();
    },

    async adminElevate(_account: string, plaintext: string): Promise<void> {
      await delay(latency);
      if (plaintext !== PASSWORD) {
        throw await httpError("INVALID_CREDENTIALS", "password incorrect", 200);
      }
      elevated = true;
    },

    async adminLock(): Promise<void> {
      await delay(latency);
      elevated = false;
    },

    async adminListDevices(userId: number) {
      await delay(latency);
      if (!elevated) throw await needsElevation();
      const list = devices[userId];
      if (!list) throw await notFound();
      // Revoked bindings included, as the server does.
      return list.map((d) => ({ ...d }));
    },

    async adminUnlinkDevice(userId: number, equipmentNo: string): Promise<void> {
      await delay(latency);
      if (!elevated) throw await needsElevation();
      const device = devices[userId]?.find((d) => d.equipmentNo === equipmentNo && d.active);
      // Unknown and someone else's serial are one error, so serials can't be probed.
      if (!device) throw await httpError("DEVICE_NOT_FOUND", "that user has no such device", 404);
      device.active = false; // a soft flip, exactly as the server does it
    },

    async adminGetQuota(userId: number) {
      await delay(latency);
      if (!elevated) throw await needsElevation();
      const q = quotas[userId];
      if (!q) throw await notFound();
      return { ...q };
    },

    async adminSetQuota(userId: number, totalBytes: number) {
      await delay(latency);
      if (!elevated) throw await needsElevation();
      const q = quotas[userId];
      if (!q) throw await notFound();
      if (totalBytes < 0) throw await httpError("INVALID_QUOTA", "an allotment cannot be negative", 400);
      // Stored verbatim, even below usage: nothing is deleted.
      q.totalBytes = totalBytes;
      return { ...q };
    },

    async adminGetRetention() {
      await delay(latency);
      if (!elevated) throw await needsElevation();
      return { retentionDays, defaultDays: 30, minDays: 1, maxDays: 365, changedAt: retentionChangedAt };
    },

    async adminSetRetention(days: number) {
      await delay(latency);
      if (!elevated) throw await needsElevation();
      if (!Number.isInteger(days) || days < 1 || days > 365) {
        throw await httpError("INVALID_RETENTION", "retention must be between 1 and 365 days", 400);
      }
      retentionDays = days;
      // Not retroactive: nothing is purged; `changedAt` gives existing entries a new window.
      retentionChangedAt = Math.floor(Date.now() / 1000);
      return { retentionDays, defaultDays: 30, minDays: 1, maxDays: 365, changedAt: retentionChangedAt };
    },

    async adminHealth() {
      await delay(latency);
      if (!elevated) throw await needsElevation();
      return {
        version: "0.0.1",
        memoryBytes: 31.4 * 1024 * 1024,
        memoryBudgetBytes: 50 * 1024 * 1024,
        blobBytes: 4.8 * GB,
        blobCount: 1284,
      };
    },
  };
}
