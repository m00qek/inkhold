// The admin console's household actions: each asks the view, calls the API
// through the controller's elevate-and-retry `run`, then re-lists. The gate,
// the listing and the state live in the controller (`admin.ts`).

import type { AdminDevice, AdminUser } from "../../api/adminTypes";
import { displayName, RETENTION_NEVER_PURGES, GB, formatBytes, deviceTitle } from "./adminCopy";
import type { AdminApi, AdminConsole, AdminState, AdminView, Person } from "./adminModel";

/** What the actions need from the controller. */
export interface ActionContext {
  api: AdminApi;
  view: AdminView;
  state(): AdminState;
  /** Paints every control disabled (or enabled again); the guard is `idle`. */
  busy(on: boolean): void;
  /** The elevate-and-retry wrapper; null means the call did not happen. */
  run<T>(op: () => Promise<T>): Promise<T | null>;
  refresh(): Promise<void>;
  onBackupsChanged(): void;
}

export type AdminActions = Pick<
  AdminConsole,
  | "addPerson"
  | "resetPassword"
  | "deletePerson"
  | "setQuota"
  | "unlinkDevice"
  | "setRetention"
  | "setBackupDismissed"
  | "forgetBackupDir"
>;

export function adminActions(c: ActionContext): AdminActions {
  /** The household on screen and nothing in flight, or null. */
  function idle(): Extract<AdminState, { kind: "ready" }> | null {
    const s = c.state();
    return s.kind === "ready" && !s.busy ? s : null;
  }

  return {
    async addPerson(): Promise<void> {
      if (!idle()) return;
      const person = await c.view.askNewPerson();
      if (!person) return;
      c.busy(true);
      const password = await c.run(() => c.api.adminCreateUser(person.email, person.isAdmin));
      if (password === null) {
        c.busy(false);
        return;
      }
      await c.refresh();
      // The server stores only a hash, so this is the one moment the password can be read.
      await c.view.handOver({ email: person.email, password });
    },

    async resetPassword(person: AdminUser): Promise<void> {
      if (!idle()) return;
      const ok = await c.view.confirm({
        title: `Reset the password for ${displayName(person.email)}?`,
        text:
          "They will be signed out everywhere and must choose a new password the next time they sign in. " +
          "Their notes are untouched.",
        label: "Reset password",
        // Not destructive: nothing is lost.
        danger: false,
      });
      if (!ok) return;
      c.busy(true);
      const password = await c.run(() => c.api.adminResetPassword(person.id));
      if (password === null) {
        c.busy(false);
        return;
      }
      await c.refresh();
      await c.view.handOver({ email: person.email, password });
    },

    async deletePerson(person: AdminUser): Promise<void> {
      if (!idle()) return;
      const ok = await c.view.confirm({
        title: `Delete ${displayName(person.email)} permanently?`,
        text:
          "This removes the account and everything in it. It cannot be undone, and the recycle bin does not hold it.",
        label: "Delete permanently",
        danger: true,
        // The address: unambiguous, and printed on the row above.
        confirmWord: person.email,
      });
      if (!ok) return;
      c.busy(true);
      const done = await c.run(() => c.api.adminDeleteUser(person.id));
      if (done === null) {
        c.busy(false);
        return;
      }
      await c.refresh();
      c.view.toast(`Deleted ${displayName(person.email)}`);
    },

    async setQuota(person: Person): Promise<void> {
      if (!idle()) return;
      const name = displayName(person.user.email);
      const current = person.quota;
      const gb = await c.view.askNumber({
        title: `Allotment for ${name}`,
        text:
          "How much of the server they may fill. Lowering it below what they already store " +
          "does not delete anything — it stops new syncs until they free space.",
        label: "Gigabytes",
        // One decimal, matching what the meter displays.
        value: current ? round1(current.totalBytes / GB) : 0,
        min: 0,
        max: 65536,
        step: 0.1,
        hint: current ? `They are storing ${formatBytes(current.usedBytes)} today.` : undefined,
        confirmLabel: "Save allotment",
      });
      if (gb === null) return;
      c.busy(true);
      const saved = await c.run(() => c.api.adminSetQuota(person.user.id, Math.round(gb * GB)));
      if (saved === null) {
        c.busy(false);
        return;
      }
      await c.refresh();
      // Says if they're now over it and their next sync will be refused.
      const over = saved.usedBytes > saved.totalBytes;
      c.view.toast(
        over
          ? `${name} is now ${formatBytes(saved.usedBytes - saved.totalBytes)} over their allotment`
          : `Allotment for ${name} is now ${formatBytes(saved.totalBytes)}`,
      );
    },

    async unlinkDevice(person: Person, device: AdminDevice): Promise<void> {
      if (!idle()) return;
      const name = displayName(person.user.email);
      const ok = await c.view.confirm({
        title: `Unlink ${deviceTitle(device)} from ${name}?`,
        text:
          "It stops syncing immediately. Their notes stay on the server, and the copies already " +
          "on the tablet stay there too. Linking it again needs the device in hand.",
        label: "Unlink device",
        danger: true,
      });
      if (!ok) return;
      c.busy(true);
      const done = await c.run(() => c.api.adminUnlinkDevice(person.user.id, device.equipmentNo));
      if (done === null) {
        c.busy(false);
        return;
      }
      await c.refresh();
      c.view.toast(`Unlinked ${deviceTitle(device)}`);
    },

    async setRetention(): Promise<void> {
      const ready = idle();
      if (!ready) return;
      const current = ready.server.retention;
      if (!current) return; // no window to edit; the card is not drawn either
      const days = await c.view.askNumber({
        title: "How long should the recycle bin hold a note?",
        text:
          "Deleted notes stay recoverable for this long, then they are removed for good. " +
          "They keep counting against their owner's allotment while they wait.",
        label: "Days",
        value: current.retentionDays,
        min: current.minDays,
        max: current.maxDays,
        step: 1,
        hint: RETENTION_NEVER_PURGES,
        confirmLabel: "Save",
      });
      if (days === null) return;
      c.busy(true);
      const saved = await c.run(() => c.api.adminSetRetention(Math.round(days)));
      if (saved === null) {
        c.busy(false);
        return;
      }
      await c.refresh();
      c.view.toast(`Notes now wait ${saved.retentionDays} days before being removed`);
    },

    async setBackupDismissed(dismissed: boolean): Promise<void> {
      if (!idle()) return;
      c.busy(true);
      if ((await c.run(() => c.api.adminSetBackupDismissed(dismissed))) === null) return c.busy(false);
      await c.refresh();
      c.onBackupsChanged();
      c.view.toast(dismissed ? "Inkhold will stop asking about backups" : "Inkhold will remind you again if nothing is backed up");
    },

    async forgetBackupDir(dir: string): Promise<void> {
      if (!idle()) return;
      const ok = await c.view.confirm({
        title: `Forget ${dir}?`,
        text: "Its record goes, and so does any warning about it. The backup files themselves are not touched.",
        label: "Forget",
      });
      if (!ok) return;
      c.busy(true);
      if ((await c.run(() => c.api.adminForgetBackupDir(dir))) === null) return c.busy(false);
      await c.refresh();
      c.onBackupsChanged();
      c.view.toast(`Forgot ${dir}`);
    },
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
