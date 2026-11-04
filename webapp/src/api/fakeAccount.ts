// The fake API's account face: one member, one Nomad, a verifying password change.

import { delay } from "./fake";

export function fakeAccountMethods(latency: number) {
  // Per instance, like the admin block. `changePassword` verifies the current
  // password, as the real route does. One member's account, one Nomad.
  const MB = 1024 * 1024;

  /** One named tablet; `lastSeenAt` relative to build time so the row never ages. */
  const now = () => Math.floor(Date.now() / 1000);
  let devices = [
    {
      equipmentNo: "SN1000A2X",
      name: "Nomad",
      model: "A5X2",
      firmware: "3.20.29",
      lastSeenAt: now() - 20 * 60,
      linkedAt: now() - 190 * 86_400,
    },
  ];

  /** A partition: the kinds plus bin plus versions sum to `usedBytes` (214+46+178+12+13 = 463 MB). */
  const kinds = { notebookBytes: 214 * MB, sketchBytes: 46 * MB, documentBytes: 178 * MB, binBytes: 12 * MB };
  const totalBytes = 10 * 1024 * MB;

  /** Retained versions per file; `keep = 3` removes 8, the design's own example. */
  let retainedPerFile: number[] = [5, 5, 5, 5, 3, 2];
  let keep = 5;
  /** The admin's ceiling on `keep`. */
  const maxKeep = 20;
  const bytesPerVersion = (13 * MB) / 25; // the 25 retained versions above ≈ 13 MB
  const versionBytes = () => Math.round(retainedPerFile.reduce((a, b) => a + b, 0) * bytesPerVersion);

  /** Same as the admin gate's; mutable so the new password is the one the next change must prove. */
  let password = "inkhold";

  /** The real error class, imported dynamically like the admin block's. */
  const httpError = async (code: string, message: string, status: number): Promise<Error> => {
    const { ApiError } = await import("./client");
    return new ApiError(code, message, status);
  };

  let otherSessions = 2;
  /** A date rather than null so dev and e2e exercise the common rendering. */
  let passwordChangedAt: number | null = now() - 97 * 86_400;
  const thisSessionSince = now() - 3 * 86_400;

  const policy = () => ({ keep, maxKeep, retainedPerFile: [...retainedPerFile] });

  return {
    async myDevices() {
      await delay(latency);
      return devices.map((d) => ({ ...d }));
    },

    async unlinkMyDevice(equipmentNo: string): Promise<void> {
      await delay(latency);
      const found = devices.some((d) => d.equipmentNo === equipmentNo);
      // Unknown and someone else's serial are one error.
      if (!found) throw await httpError("DEVICE_NOT_FOUND", "no such device on this account", 404);
      // Removed, unlike the admin listing: your list is the tablets that sync.
      devices = devices.filter((d) => d.equipmentNo !== equipmentNo);
    },

    async signOutEverywhere(): Promise<number> {
      await delay(latency);
      const ended = otherSessions;
      otherSessions = 0;
      return ended;
    },

    async storageBreakdown() {
      await delay(latency);
      const byKind = { ...kinds, versionBytes: versionBytes() };
      // Summed, so the lines always add up to the meter.
      const usedBytes =
        byKind.notebookBytes +
        byKind.sketchBytes +
        byKind.documentBytes +
        byKind.binBytes +
        byKind.versionBytes;
      return { usedBytes, totalBytes, byKind };
    },

    async versionPolicy() {
      await delay(latency);
      return policy();
    },

    async setVersionPolicy(next: number) {
      await delay(latency);
      // Clamped by the server, not just the control.
      const target = Math.max(0, Math.min(maxKeep, Math.floor(next)));
      const before = retainedPerFile.reduce((a, b) => a + b, 0);
      retainedPerFile = retainedPerFile.map((c) => Math.min(c, target));
      const removedVersions = before - retainedPerFile.reduce((a, b) => a + b, 0);
      keep = target;
      return {
        policy: policy(),
        removedVersions,
        freedBytes: Math.round(removedVersions * bytesPerVersion),
      };
    },

    async accountSecurity() {
      await delay(latency);
      return { passwordChangedAt, otherSessions, thisSessionSince };
    },

    async changePassword(currentPlaintext: string, newPlaintext: string): Promise<void> {
      await delay(latency);
      // `INVALID_CREDENTIALS` at status 200, before anything changes, as the server.
      if (currentPlaintext !== password) {
        throw await httpError("INVALID_CREDENTIALS", "current password incorrect", 200);
      }
      if (newPlaintext === password) {
        throw await httpError("SAME_PASSWORD", "that is already your password", 200);
      }
      password = newPlaintext;
      // The real route revokes every other session.
      otherSessions = 0;
      passwordChangedAt = now();
    },
  };
}
