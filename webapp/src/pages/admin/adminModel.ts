// The admin console's model: what the controller (`admin.ts`) holds, what it
// asks the view (`adminView.ts`), and the API slice it calls. Types only.

import type { AdminBackups, AdminDevice, AdminHealth, AdminQuota, AdminRetention, AdminUser } from "../../api/adminTypes";
import type { Api } from "../../api/types";

export type AdminApi = Pick<
  Api,
  | "adminListUsers"
  | "adminCreateUser"
  | "adminDeleteUser"
  | "adminResetPassword"
  | "adminElevate"
  | "adminLock"
  | "adminListDevices"
  | "adminUnlinkDevice"
  | "adminGetQuota"
  | "adminSetQuota"
  | "adminGetRetention"
  | "adminSetRetention"
  | "adminHealth"
  | "adminBackups"
  | "adminSetBackupDismissed"
  | "adminForgetBackupDir"
>;

/** `locked` is the entry state, not an error; a lapsed elevation returns here. */
export type AdminState =
  | { kind: "locked"; error: string | null; busy: boolean }
  | { kind: "loading" }
  | { kind: "ready"; people: Person[]; server: Server; busy: boolean }
  | { kind: "failed"; message: string };

/** `quota` and `devices` are separately nullable: separate endpoints, separate failures. */
export interface Person {
  user: AdminUser;
  quota: AdminQuota | null;
  devices: AdminDevice[] | null;
}

export interface Server {
  health: AdminHealth | null;
  retention: AdminRetention | null;
  backups: AdminBackups | null;
}

export interface ConfirmSpec {
  title: string;
  text: string;
  /** Never "OK". */
  label: string;
  danger?: boolean;
  /**
  * Type-to-confirm, used only for deleting a person: the one action where the
  * person clicking is not the one who loses data.
  */
  confirmWord?: string;
}

export interface NewPerson {
  email: string;
  isAdmin: boolean;
}

/** In the units the value is stated in (GB, days), never raw bytes. */
export interface NumberSpec {
  title: string;
  text: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  confirmLabel: string;
  hint?: string;
}

/** Shown once and never again. */
export interface HandOver {
  email: string;
  password: string;
}

/** Questions and paints only; no decisions. */
export interface AdminView {
  render(state: AdminState): void;
  confirm(spec: ConfirmSpec): Promise<boolean>;
  askNewPerson(): Promise<NewPerson | null>;
  askNumber(spec: NumberSpec): Promise<number | null>;
  handOver(spec: HandOver): Promise<void>;
  toast(message: string): void;
}

export interface AdminDeps {
  api: AdminApi;
  view: AdminView;
  account: string;
  onSessionExpired(): void;
  /** Fired only on a real change; the rail's padlock repaints on it. */
  onElevationChanged(): void;
  /** A dismissal or a forgotten directory: the library's notice re-asks. */
  onBackupsChanged(): void;
}

export interface AdminConsole {
  /**
  * Lists the household, which also opens the gate (428 until elevated). No
  * separate elevation probe: the server is the authority.
  */
  open(): Promise<void>;
  unlock(password: string): Promise<void>;
  lock(): Promise<void>;
  addPerson(): Promise<void>;
  resetPassword(person: AdminUser): Promise<void>;
  deletePerson(person: AdminUser): Promise<void>;
  setQuota(person: Person): Promise<void>;
  unlinkDevice(person: Person, device: AdminDevice): Promise<void>;
  setRetention(): Promise<void>;
  /** "I back up another way", or take it back. */
  setBackupDismissed(dismissed: boolean): Promise<void>;
  /** Forget a directory no longer in use, after asking. */
  forgetBackupDir(dir: string): Promise<void>;
  state(): AdminState;
  /**
  * Tracked from server evidence (a listing succeeded, or a 428), not from
  * `AdminState`: `loading` on first paint would otherwise flash an unlocked padlock.
  */
  isElevated(): boolean;
}
