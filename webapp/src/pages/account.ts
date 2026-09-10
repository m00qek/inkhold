// YOUR OWN ACCOUNT (approved 2026-07-30).
//
// WHY THIS PAGE EXISTS AT ALL. Administering other people and managing yourself
// are different surfaces, and until now only the first one existed. Every
// account-shaped verb in this app lived in the admin console and pointed
// OUTWARD — reset their password, set their quota, unlink their devices — so a
// person who wanted something for THEMSELVES reached for the tool that does it
// to somebody else. A beta tester did exactly that, aimed "Reset password" at
// their own row, and locked themselves out of their server. The incident is not
// the point; the missing surface is (§1–§2).
//
// WHAT THE SHAPE IS. One column, one readable measure, and the app's own
// material as the signature: the reserved red margin rule runs down the page as
// its spine, with the section labels sitting IN the margin like marginal notes.
// Space Grotesk for headings, Space Mono for EVERY piece of data — the address,
// the byte counts, the timestamps, the version count — which is the rule the
// app already follows everywhere else.
//
// FIVE SECTIONS, EACH LOADING AND FAILING SEPARATELY. Appearance · Signing in ·
// Devices · Storage · Versions. Appearance leads because it is the only one that
// is a preference rather than a fact about the account, it needs no round trip,
// and it is the control a person returns for; the rest you set once. Versions is
// its own section rather than a tail on Storage because Storage REPORTS and that
// one DISCARDS. They come off four different calls, so one unreachable
// endpoint must cost its own section and nothing more — the same reason the
// admin console renders a person whose meter could not be counted. And each
// section states LOADING and KNOWN-EMPTY as different things: "no devices
// linked" is a claim, and a claim painted from data that has not arrived yet is
// worse than a spinner because the reader believes it
// (taxonomy 1).
//
// WHAT IS DELIBERATELY NOT HERE: quota (an admin decides it) and deleting your
// own account (in a household the admin does that, and self-delete is a footgun
// with a recycle bin that does not hold it).
//
// SPLIT LIKE `admin.ts` AND `rail.ts`: the decisions and the copy are pure
// functions at the top of this file, unit-tested in Node with no DOM, and the
// painter below them owns nothing but nodes.

import { el } from "../ui/dom";
import { field, statusLine } from "../ui/form";
import { openDialog } from "../ui/confirm";
import { ICONS, svg, type IconName } from "../ui/icons";
import { relativeTime, absoluteTime } from "../ui/relativeTime";
import { formatBytes } from "../core/fileKind";
import { currentTheme } from "../ui/theme";
import { ApiError, RateLimitError, dispatchApiFailure, type ApiFailureSink } from "../api/client";
import type { AccountSecurity, MyDevice, StorageByKind, StorageBreakdown, VersionPolicy } from "../api/accountTypes";
import type { Api } from "../api/types";
import type { Theme } from "../core/types";

/** The self-service slice of the `Api` seam — all this page may touch. */
export type AccountApi = Pick<
  Api,
  | "accountSecurity"
  | "changePassword"
  | "myDevices"
  | "unlinkMyDevice"
  | "signOutEverywhere"
  | "storageBreakdown"
  | "versionPolicy"
  | "setVersionPolicy"
>;

/** The minimum a new password may be — the same floor the first-login screen
 *  enforces, because it is the same password. */
export const MIN_PASSWORD_LENGTH = 8;

// --- pure logic (no DOM; unit-tested) ----------------------------------------

/**
 * How many retained versions LOWERING `keep` would discard, right now.
 *
 * `Σ max(0, count − keep)` over the per-file counts. PER FILE, NOT A POOL —
 * which is what `K` already means, and the arithmetic has to agree with the copy
 * beside it or the number is a different feature's.
 *
 * Raising `keep` discards nothing, so this floors at zero rather than reporting
 * a negative "gain": versions are not created by a setting, only kept.
 */
export function versionsToDiscard(retainedPerFile: readonly number[], keep: number): number {
  if (!Number.isFinite(keep)) return 0;
  const k = Math.max(0, Math.floor(keep));
  return retainedPerFile.reduce((total, count) => total + Math.max(0, count - k), 0);
}

/**
 * What the control says about a value the user has typed but not yet saved.
 *
 * **A FACT, STATED BEFORE THE CHANGE — not a warning dialog after it.** Discarded
 * versions are gone; the recycle bin does not hold them, so the count has to be
 * on screen while the person still has the option of not doing it. Null when
 * there is nothing to say, which keeps the line from becoming furniture that
 * gets read past.
 *
 * ZERO IS A REAL SETTING, and it says so plainly rather than being refused: some
 * people would rather spend every byte on live files.
 */
export function discardNotice(retainedPerFile: readonly number[], keep: number): string | null {
  const n = versionsToDiscard(retainedPerFile, keep);
  const k = Math.max(0, Math.floor(keep));
  if (n === 0) {
    return k === 0 ? "Nothing to discard, and no new versions will be kept." : null;
  }
  const versions = n === 1 ? "1 version" : `${n} versions`;
  const tail = k === 0 ? " No new versions will be kept." : "";
  return `Keeping ${k} will remove ${versions} now.${tail}`;
}

/** One line of the Storage split. `key` is how the painter finds the one line
 *  that has somewhere to send you. */
export interface StorageRow {
  key: "notebooks" | "sketches" | "documents" | "bin" | "versions";
  label: string;
  hint: string;
  bytes: number;
}

/**
 * The FIVE Storage lines, in the order §7 sets them out.
 *
 * Five, not four: the bin line was missing from the first draft and the live
 * database found it — three live kinds that summed 597,016 bytes short of
 * `used_bytes`, which was two trashed files still charging. They are a PARTITION
 * (see {@link StorageByKind}), so this function only names and orders them; it
 * does not compute, reconcile or total anything, because a client that
 * re-derived one of these figures would be a second opinion about the meter.
 */
export function storageRows(byKind: StorageByKind): StorageRow[] {
  return [
    { key: "notebooks", label: "Notebooks", hint: ".note", bytes: byKind.notebookBytes },
    { key: "sketches", label: "Sketches", hint: ".spd", bytes: byKind.sketchBytes },
    // Images fold in here for now — whether they earn a line of their own is an
    // open question in §7, to be decided against a real household's numbers.
    { key: "documents", label: "Documents", hint: "PDF, EPUB, text, images", bytes: byKind.documentBytes },
    // THE ONE LINE WHOSE REMEDY IS A CLICK AWAY, which is why it names what
    // emptying the bin would return rather than just what is in it.
    { key: "bin", label: "Recycle bin", hint: "freed by emptying it", bytes: byKind.binBytes },
    { key: "versions", label: "Versions", hint: "kept copies of edited files", bytes: byKind.versionBytes },
  ];
}

/**
 * "Last changed 3 months ago" — or an honest absence.
 *
 * **THE ABSENCE IS THE COMMON CASE AND MUST NOT READ AS AN ACCUSATION.** Nothing
 * records the change today; `users.password_changed_at` is a column §8 decides
 * to add, and it only becomes true from the day it lands — so every existing
 * account is unrecorded until its owner next changes one. "Never changed" would
 * be a claim about the person's habits made from a column that did not exist;
 * "No change recorded yet" is a claim about the server, which is the true one.
 */
export function passwordAgeLabel(changedAt: number | null, now: number = Date.now()): string {
  if (changedAt === null || !Number.isFinite(changedAt) || changedAt <= 0) return "No change recorded yet";
  return `Last changed ${relativeTime(changedAt * 1000, now)}`;
}

/**
 * "2 other browsers signed in".
 *
 * Counting THIS browser would make the honest answer read as 1, and the figure
 * is only useful as an answer to "is anyone else in my account?".
 */
export function otherSessionsLabel(count: number): string {
  if (count <= 0) return "No other browsers are signed in";
  return count === 1 ? "1 other browser signed in" : `${count} other browsers signed in`;
}

/**
 * "last seen 20 minutes ago", or the absence.
 *
 * **"SEEN", NOT "SYNCED"** — decided against the data rather than the wish (§7).
 * What the server has is the last REQUEST the device made, which is usually a
 * sync and is not the same claim; the wider word would be right almost always
 * and wrong occasionally, which is the exact register this app has spent its
 * time removing.
 *
 * A device paired an hour ago and one that has never spoken are different
 * states, so null says so rather than borrowing an old date.
 */
export function deviceSeenLabel(device: MyDevice, now: number = Date.now()): string {
  if (device.lastSeenAt === null) return "not seen since it was linked";
  return `last seen ${relativeTime(device.lastSeenAt * 1000, now)}`;
}

/** "Signed in here since 3 days ago", or just the plain statement when the
 *  server cannot date this session. */
export function thisBrowserLabel(since: number | null, now: number = Date.now()): string {
  if (since === null || !Number.isFinite(since) || since <= 0) return "Signed in here";
  return `Signed in here since ${relativeTime(since * 1000, now)}`;
}

/**
 * The message a failed section shows.
 *
 * An `ApiError` already carries interface-voice text (including the
 * `NOT_IMPLEMENTED` refusal the unbacked endpoints answer with, which is the
 * common case on a real server today), so it is passed through rather than
 * flattened into one generic line that would hide WHICH part is missing.
 */
export function failureMessage(e: unknown): string {
  if (e instanceof RateLimitError) return "Too many attempts. Wait a moment and try again.";
  if (e instanceof ApiError) return e.message;
  return "Something went wrong. Try again.";
}

/**
 * What changing your password will COST, said before it is changed.
 *
 * **The tablet is the part that matters, and it was missing.** The line used to
 * name only browsers. `revokeAllSessions` is an unqualified DELETE over the
 * user's sessions, so the Supernote's dies with them — and unlike a browser it
 * cannot sign itself back in, because it authenticates with the password it has
 * stored. So sync stops until somebody walks over and types the new one. The
 * binding itself survives (user_options.md §9.1); nothing needs re-pairing.
 *
 * A browser is one click away; the tablet is across the room. Someone who read
 * only the old line would discover their Supernote had stopped syncing hours
 * later with no reason to connect the two, which is the failure §4 asks this
 * screen to prevent by stating the cost BEFORE the change.
 *
 * NAMED, not "your device" — it is the object you have to go and find. And
 * conditional: with nothing bound, a standing warning about hardware you do not
 * own is noise that teaches people to skip the line.
 */
export function passwordChangeConsequence(devices: readonly MyDevice[]): string {
  const browsers = "Other browsers are signed out too; this one stays signed in.";
  // No filtering here: `myDevices` already drops revoked bindings, so everything
  // in this list is a device that is actually syncing and will actually stop.
  if (devices.length === 0) return "Your other browsers will be signed out. This one stays signed in.";
  if (devices.length === 1) {
    const it = devices[0]!.name || devices[0]!.equipmentNo;
    return `${it} will stop syncing until you enter the new password on the device. ${browsers}`;
  }
  return `Your ${devices.length} devices will stop syncing until you enter the new password on each. ${browsers}`;
}

/** What a failed password change says, by the server's reason. */
export function passwordFailureMessage(e: unknown): string {
  if (e instanceof RateLimitError) return "Too many attempts. Wait a moment and try again.";
  if (e instanceof ApiError && e.code === "INVALID_CREDENTIALS") {
    return "That isn't your current password.";
  }
  if (e instanceof ApiError && e.code === "SAME_PASSWORD") {
    return "Choose a password different from your current one.";
  }
  if (e instanceof ApiError) return e.message;
  return "Something went wrong. Try again.";
}

// --- the page ----------------------------------------------------------------

export interface AccountHost {
  api: AccountApi;
  /** The signed-in address — the nameplate's own text, restated here. */
  account: string;
  /** The shell's content area; the page is an overlay inside it, like `.admin`. */
  content: HTMLElement;
  /** The app root, where a modal mounts — the same host the bin's confirm uses,
   *  so the dialog sits above the whole shell rather than inside a scrolled
   *  panel that would clip it. */
  root: HTMLElement;
  /** Hidden while the page is up (not emptied) — the folder survives the visit. */
  gallery: HTMLElement;
  crumbs: HTMLElement;
  sortWrap: HTMLElement;
  segmented: HTMLElement;
  /** Take the search box away — this is not a folder listing. */
  setMode(open: boolean): void;
  toast(message: string): void;
  /** "Library" in the crumb. */
  onLeave(): void;
  /** The Storage section's one actionable line — the recycle bin. */
  onOpenBin(): void;
  /** Sign out of THIS browser — the shell owns what that means. */
  onSignOut(): void;
  onSessionExpired(): void;
  /** Pin a theme and repaint everything keyed to it. A no-op if already there. */
  onSetTheme(theme: Theme): void;
}

export interface AccountPage {
  open(): void;
  /** Leave. Idempotent. */
  close(): void;
  isOpen(): boolean;
  /** The theme changed elsewhere (the OS flipped while nothing was pinned), so
   *  the Appearance control has to stop claiming the old one. */
  themeChanged(): void;
  destroy(): void;
}

/** A section's data: loading, ready, or failed — three states, never two. */
type Load<T> = { kind: "loading" } | { kind: "ready"; data: T } | { kind: "failed"; message: string };

export function createAccountPage(host: AccountHost): AccountPage {
  const failureSink: ApiFailureSink = { onSessionExpired: host.onSessionExpired };
  /** True when the error was a dead session and has already been routed. */
  const handled = (e: unknown): boolean => dispatchApiFailure(failureSink, e);

  // --- state ---------------------------------------------------------------
  let open_ = false;
  /**
   * Bumped on every open. A response from a previous visit must not paint over
   * this one — the page is an overlay whose teardown races its own fetches, and
   * four of them are in flight at once.
   */
  let generation = 0;
  let security: Load<AccountSecurity> = { kind: "loading" };
  let devices: Load<MyDevice[]> = { kind: "loading" };
  let storage: Load<StorageBreakdown> = { kind: "loading" };
  let policy: Load<VersionPolicy> = { kind: "loading" };
  /** In-flight guards, so a second click cannot fire a second write. */
  let signingOutEverywhere = false;
  let savingPolicy = false;
  const unlinking = new Set<string>();

  // --- DOM: the shell of the page, built once -------------------------------
  //
  // BUILT ONCE AND FILLED, rather than re-rendered wholesale, and that is not an
  // optimisation: the change-password form and the versions input live inside
  // sections whose data arrives later, and a repaint triggered by a late
  // response would wipe what somebody was halfway through typing.

  const name = (host.account || "").split("@")[0] || "You";

  const securityBody = el("div", { class: "acct-rows" });
  const devicesBody = el("div", { class: "acct-rows" });
  const storageBody = el("div", { class: "acct-rows" });
  const versionsBody = el("div", { class: "acct-versions" });
  const appearanceBody = el("div", { class: "acct-rows" });

  function section(label: string, ...children: (Node | null)[]): HTMLElement {
    return el(
      "section",
      { class: "acct-sec" },
      // The label sits IN the margin — the page's one piece of theatre, and the
      // app's own material rather than an invented ornament.
      el("h2", { class: "acct-sec__label", text: label }),
      el("div", { class: "acct-sec__body" }, ...children),
    );
  }

  const body = el(
    "div",
    { class: "acct__body" },
    el(
      "header",
      { class: "acct__head" },
      el("span", { class: "avatar acct__avatar", "aria-hidden": "true", text: initials(host.account) }),
      el(
        "div",
        {},
        el("h1", { class: "acct__title", text: name }),
        // An address is DATA, so it is mono — and `text`, never markup.
        el("p", { class: "acct__mail acct-data", text: host.account }),
      ),
    ),
    // APPEARANCE FIRST. It is the only section that is a preference rather than a
    // fact about the account, it needs no round trip, and it is the one control
    // here a person comes back for — the rest you set once. It also means the
    // page opens with something already resolved instead of four "Loading…"
    // lines, which is a better first frame on a slow link.
    section("Appearance", appearanceBody),
    section("Signing in", securityBody),
    section("Devices", devicesBody, deviceHint()),
    section("Storage", storageBody),
    // VERSIONS IS ITS OWN SECTION, not a tail on Storage. Storage REPORTS — five
    // figures you read and leave. This is the one control on the page that
    // discards data, and burying it under another section's label made it read as
    // a footnote to a readout rather than the decision it is. It keeps its own
    // margin label for the same reason every other section has one: the margin is
    // how this page says what you are looking at.
    section("Versions", versionsBody),
  );

  const panel = el("section", { class: "acct", "aria-label": "Your account", hidden: true }, body);
  host.content.append(panel);

  function deviceHint(): HTMLElement {
    return el("p", {
      class: "acct-hint",
      // Said HERE, beside the control, rather than only in a confirmation:
      // the person deciding needs both halves — that sync stops, and that
      // nothing they already have goes anywhere.
      text: "Unlinking stops sync until the device is paired again. Nothing already synced is removed.",
    });
  }

  // --- generic row ----------------------------------------------------------
  interface Row {
    node: HTMLElement;
    value: HTMLElement;
    actions: HTMLElement;
  }

  function row(label: string): Row {
    const value = el("div", { class: "acct-row__v acct-data" });
    const actions = el("div", { class: "acct-row__acts" });
    return {
      node: el("div", { class: "acct-row" }, el("div", { class: "acct-row__k", text: label }), value, actions),
      value,
      actions,
    };
  }

  function button(label: string, onClick: () => void, opts: { danger?: boolean; ariaLabel?: string } = {}): HTMLButtonElement {
    const b = el("button", {
      class: opts.danger ? "acct-btn acct-btn--danger" : "acct-btn",
      type: "button",
      text: label,
    });
    if (opts.ariaLabel) b.setAttribute("aria-label", opts.ariaLabel);
    b.addEventListener("click", onClick);
    return b;
  }

  /** The one line a section shows while it is still being fetched. NEVER a
   *  zero, an empty list or a dash — see the taxonomy note in the header. */
  function pending(): HTMLElement {
    return el("p", { class: "acct-pending", text: "Loading…" });
  }

  function failed(message: string): HTMLElement {
    return el("p", { class: "acct-failed", role: "status", text: message });
  }

  // --- Signing in -----------------------------------------------------------

  const passwordRow = row("Password");
  const passwordForm = buildPasswordForm();
  const sessionsRow = row("Other sessions");
  const thisBrowserRow = row("This browser");

  // A DISCLOSURE, so it says so. It opens and closes the form below it, and a
  // plain button that looks identical either way leaves you guessing whether the
  // click landed — especially since pressing it again is how you back out.
  // `aria-expanded` states it for a screen reader; `.is-open` gives it the same
  // held-down look the topbar's view toggle uses for its active segment, which
  // is the app's existing idiom for "this control is currently on".
  const passwordToggle = button("Change", () => togglePasswordForm(passwordForm.node.hidden), {
    ariaLabel: "Change your password",
  });
  // A CHEVRON, because the fill alone could not carry it. The topbar's view
  // toggle reads as pressed only because its unpressed sibling sits beside it —
  // a lone button has nothing to be compared against, so the same `--hover` fill
  // reads as no state at all. The chevron is the app's own disclosure motif (the
  // rail nameplate rotates this identical path), and it points down closed, up
  // open, which is legible with no second control to compare to.
  passwordToggle.append(
    // `html:`, NOT a child — `svg()` returns MARKUP, and passing it as a child
    // makes `el` insert the path data as a text node. It renders as a diagonal
    // smear of coordinates across the page, which is how this was caught.
    el("span", { class: "acct-btn__chevron", "aria-hidden": "true", html: svg(ICONS.chevron) }),
  );
  passwordToggle.setAttribute("aria-expanded", "false");
  passwordToggle.setAttribute("aria-controls", "acct-pw-form");
  passwordRow.actions.append(passwordToggle);
  thisBrowserRow.actions.append(
    // SIGN OUT DID NOT DISAPPEAR when it left the rail — it moved here, and it
    // is the last row of the section about signing in, which is where a person
    // looks for it.
    button("Sign out", () => host.onSignOut()),
  );

  securityBody.append(passwordRow.node, passwordForm.node, sessionsRow.node, thisBrowserRow.node);

  function renderSecurity(): void {
    if (security.kind === "loading") {
      passwordRow.value.textContent = "Loading…";
      sessionsRow.value.textContent = "Loading…";
      thisBrowserRow.value.textContent = "Loading…";
      sessionsRow.actions.replaceChildren();
      return;
    }
    if (security.kind === "failed") {
      passwordRow.value.textContent = security.message;
      sessionsRow.value.textContent = security.message;
      // SIGN OUT STAYS REACHABLE THROUGH A FAILURE. It needs nothing this call
      // was going to tell us, and a page that could not read its own sessions is
      // exactly when somebody wants the way out.
      thisBrowserRow.value.textContent = "Signed in here";
      sessionsRow.actions.replaceChildren();
      return;
    }
    const data = security.data;
    passwordRow.value.textContent = passwordAgeLabel(data.passwordChangedAt);
    if (data.passwordChangedAt !== null && data.passwordChangedAt > 0) {
      passwordRow.value.title = absoluteTime(data.passwordChangedAt * 1000);
    } else {
      passwordRow.value.removeAttribute("title");
    }
    sessionsRow.value.textContent = otherSessionsLabel(data.otherSessions);
    thisBrowserRow.value.textContent = thisBrowserLabel(data.thisSessionSince);
    if (data.thisSessionSince !== null && data.thisSessionSince > 0) {
      thisBrowserRow.value.title = absoluteTime(data.thisSessionSince * 1000);
    }
    sessionsRow.actions.replaceChildren();
    // OFFERED ONLY WHEN IT WOULD DO SOMETHING. With nothing else signed in, a
    // live "Sign out everywhere" is a control whose whole effect is to reassure
    // you about a state the line above already states.
    if (data.otherSessions > 0) {
      const b = button("Sign out everywhere", () => void signOutEverywhere(), { danger: true });
      b.disabled = signingOutEverywhere;
      sessionsRow.actions.append(b);
    }
  }

  async function signOutEverywhere(): Promise<void> {
    if (signingOutEverywhere) return;
    signingOutEverywhere = true;
    renderSecurity();
    const mine = generation;
    try {
      const ended = await host.api.signOutEverywhere();
      if (mine !== generation) return;
      security = { kind: "ready", data: { ...currentSecurity(), otherSessions: 0 } };
      host.toast(ended === 1 ? "Signed out 1 other browser." : `Signed out ${ended} other browsers.`);
    } catch (e) {
      if (mine !== generation) return;
      if (!handled(e)) host.toast(failureMessage(e));
    } finally {
      signingOutEverywhere = false;
      if (mine === generation) renderSecurity();
    }
  }

  function currentSecurity(): AccountSecurity {
    return security.kind === "ready"
      ? security.data
      : { passwordChangedAt: null, otherSessions: 0, thisSessionSince: null };
  }

  // --- change password ------------------------------------------------------
  //
  // THE TRADITIONAL PATH: current password, new, confirm (§4). Not a reset, not
  // a temporary credential — those are the admin console's shape, aimed at
  // somebody else, and reaching for one of them on yourself is what started all
  // of this.
  //
  // THE CURRENT PASSWORD IS REQUIRED BECAUSE A SESSION IS NOT A PASSWORD PROMPT.
  // A borrowed laptop, an unlocked screen, a shared browser: without the check,
  // anyone who reaches a signed-in window can lock the owner out of their own
  // household cloud. It also catches the accidental version — the person who is
  // not sure which account this browser is signed into.
  //
  // ITS COPY IS ITS OWN. `pages/changePassword.ts` is the FIRST-LOGIN screen; its
  // words ("Save and continue", "not the temporary one") describe a flow that
  // has nothing to do with this one. What is genuinely shared — `field`,
  // `statusLine`, the minimum length — is shared; the voice is not.
  //
  // WHAT IT SAYS, AND WHAT IT REFUSES TO SAY. It states plainly that other
  // browsers are signed out, because they are (`changePassword` mints a new
  // session and revokes the rest). It says NOTHING about the Supernote's sync
  // binding: whether changing the password breaks it is an open question being
  // tested against a real device (§9.1), and a guess here would either alarm
  // people for nothing or leave them to discover silently-stopped sync.
  interface PasswordForm {
    node: HTMLFormElement;
    reset(): void;
    focus(): void;
    /** Restate what the change will cost, now that the devices are known. */
    syncConsequence(devices: readonly MyDevice[]): void;
  }

  function buildPasswordForm(): PasswordForm {
    const current = field({
      id: "acct-current-password",
      label: "Current password",
      type: "password",
      autocomplete: "current-password",
    });
    const next = field({
      id: "acct-new-password",
      label: "New password",
      type: "password",
      autocomplete: "new-password",
      minLength: MIN_PASSWORD_LENGTH,
      // BOTH CONSTRAINTS WHERE THE CHOICE IS MADE. The tablet advice used to
      // hang off "Confirm new password", where it arrives one field too late to
      // act on — by then you have already chosen, and the only thing left to do
      // is retype it. A hint that cannot change what you type is decoration.
      hint: `At least ${MIN_PASSWORD_LENGTH} characters, and you'll type it on the Supernote too — pick something easy on a tablet keyboard.`,
    });
    const confirm = field({
      id: "acct-confirm-password",
      label: "Confirm new password",
      type: "password",
      autocomplete: "new-password",
      minLength: MIN_PASSWORD_LENGTH,
    });
    const status = statusLine();
    // Built empty and filled by `syncConsequence`: the device list arrives on its
    // own request, so this sentence cannot be decided when the form is built.
    const consequence = el("p", { class: "acct-hint" });
    const submit = el("button", { class: "acct-btn acct-btn--go", type: "submit", text: "Change password" });
    const cancel = el("button", { class: "acct-btn", type: "button", text: "Cancel" });

    const node = el(
      "form",
      { class: "acct-pw", id: "acct-pw-form", hidden: true },
      current.row,
      next.row,
      confirm.row,
      consequence,
      el("div", { class: "acct-pw__acts" }, submit, cancel),
      status.node,
    );

    const reset = (): void => {
      current.input.value = "";
      next.input.value = "";
      confirm.input.value = "";
      status.clear();
      submit.disabled = false;
      submit.textContent = "Change password";
    };

    cancel.addEventListener("click", () => togglePasswordForm(false));

    node.addEventListener("submit", (e) => {
      e.preventDefault();
      if (submit.disabled) return;
      status.clear();
      if (current.input.value === "") {
        status.error("Enter your current password.");
        current.input.focus();
        return;
      }
      const value = next.input.value;
      if (value.length < MIN_PASSWORD_LENGTH) {
        status.error(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
        next.input.focus();
        return;
      }
      if (value !== confirm.input.value) {
        status.error("The two passwords don't match.");
        confirm.input.focus();
        return;
      }
      submit.disabled = true;
      submit.textContent = "Changing…";
      const mine = generation;
      void host.api
        .changePassword(current.input.value, value)
        .then(() => {
          if (mine !== generation) return;
          togglePasswordForm(false);
          // The other sessions really are gone, so the line above must stop
          // saying otherwise the moment this returns.
          security = {
            kind: "ready",
            data: { ...currentSecurity(), passwordChangedAt: Math.floor(Date.now() / 1000), otherSessions: 0 },
          };
          renderSecurity();
          host.toast("Password changed. Your other browsers are signed out.");
        })
        .catch((err: unknown) => {
          if (mine !== generation) return;
          submit.disabled = false;
          submit.textContent = "Change password";
          if (handled(err)) return;
          status.error(passwordFailureMessage(err));
          if (err instanceof ApiError && err.code === "INVALID_CREDENTIALS") current.input.focus();
        });
    });

    const syncConsequence = (list: readonly MyDevice[]): void => {
      consequence.textContent = passwordChangeConsequence(list);
    };
    syncConsequence([]);

    return { node, reset, focus: () => current.input.focus(), syncConsequence };
  }

  function togglePasswordForm(show: boolean): void {
    passwordForm.node.hidden = !show;
    passwordToggle.setAttribute("aria-expanded", String(show));
    passwordToggle.classList.toggle("is-open", show);
    // The Password row's own bottom rule is SUPPRESSED while the form is open.
    // That rule is the row's boundary, and with the form sitting directly under
    // it the line landed BETWEEN the row and its own form — so the form read as
    // belonging to "Other sessions" below rather than to the password above.
    // Closing the row's underline makes the two one block, and the card's own
    // border becomes the boundary.
    passwordRow.node.classList.toggle("is-expanded", show);
    if (show) {
      passwordForm.reset();
      passwordForm.focus();
    }
  }

  // --- Devices --------------------------------------------------------------

  function renderDevices(): void {
    if (devices.kind === "loading") {
      devicesBody.replaceChildren(pending());
      return;
    }
    if (devices.kind === "failed") {
      devicesBody.replaceChildren(failed(devices.message));
      return;
    }
    if (devices.data.length === 0) {
      // ONLY CLAIMED ONCE THE DATA THAT COULD DISPROVE IT HAS ARRIVED.
      devicesBody.replaceChildren(
        el("p", { class: "acct-empty", text: "No Supernote is linked to this account yet." }),
      );
      return;
    }
    devicesBody.replaceChildren(...devices.data.map(deviceRow));
    // The password form's warning names the tablet, so it has to learn about it
    // here — the two sections load from different calls and this is the one that
    // knows. Unlinking the last device retracts the sentence for the same reason.
    passwordForm.syncConsequence(devices.data);
  }

  function deviceRow(device: MyDevice): HTMLElement {
    const unlink = button("Unlink", () => void unlinkDevice(device), {
      danger: true,
      ariaLabel: `Unlink ${device.name || device.equipmentNo}`,
    });
    unlink.disabled = unlinking.has(device.equipmentNo);
    const seen = el("span", { class: "acct-device__sync acct-data", text: deviceSeenLabel(device) });
    if (device.lastSeenAt !== null) seen.title = absoluteTime(device.lastSeenAt * 1000);
    return el(
      "div",
      { class: "acct-row acct-device" },
      // NAMED AS AN OBJECT, not as a serial: "Nomad", the thing on the desk.
      // A device that logged in but never sent its `bindEquipment` details has
      // no name, and the serial is then the only true thing to call it — better
      // than a blank row or an invented "Supernote".
      el(
        "div",
        { class: "acct-row__k acct-device__name" },
        el("span", { text: device.name || device.equipmentNo }),
        el("span", { class: "acct-device__dot", "aria-hidden": "true", text: "·" }),
        seen,
      ),
      // Not repeated when it is already standing in as the name.
      el("div", { class: "acct-row__v acct-data acct-device__serial", text: device.name ? device.equipmentNo : "" }),
      el("div", { class: "acct-row__acts" }, unlink),
    );
  }

  async function unlinkDevice(device: MyDevice): Promise<void> {
    if (unlinking.has(device.equipmentNo)) return;

    // CONFIRMED, because the webapp cannot put it back. Every other action on
    // this page is reversible from this page — a password can be changed again,
    // a session signed back into, `keep` raised, the theme flipped. Unlinking is
    // the one that ends here: re-pairing happens ON THE TABLET, so a mis-click
    // sends you across the room with a login code, and if the tablet is not to
    // hand it sends you nowhere at all.
    //
    // This is exactly what the shared `confirm.ts` is for, and it earns the
    // modal on the terms the app's other dialogs do: it acts on a TARGET OBJECT
    // (this device), it is DESTRUCTIVE of something you cannot restore here, and
    // Cancel is the autofocused default so a stray Return never unlinks. Note
    // the change-password form deliberately is NOT a dialog by the same rule —
    // it has no target object and nothing it does is unrecoverable from here.
    const name = device.name || device.equipmentNo;
    const ok = await openDialog({
      host: host.root,
      classes: { dialog: "confirm", body: "confirm__body", actions: "confirm__actions", cancel: "btn", go: "btn is-danger" },
      goLabel: "Unlink",
      cancelLabel: "Cancel",
      labelledBy: "acct-unlink-title",
      build: (body, { go }) => {
        go.setAttribute("aria-label", `Unlink ${name}`);
        body.append(
          el("h2", { id: "acct-unlink-title", text: `Unlink ${name}?` }),
          // BOTH HALVES, the same two the standing hint gives: what stops, and
          // what is safe. A confirmation that only names the loss reads as a
          // threat and gets clicked through.
          el("p", {
            text: `${name} will stop syncing until you pair it again from the device itself. Nothing already synced is removed.`,
          }),
        );
      },
    }).done;
    if (!ok) return;

    unlinking.add(device.equipmentNo);
    renderDevices();
    const mine = generation;
    try {
      await host.api.unlinkMyDevice(device.equipmentNo);
      if (mine !== generation) return;
      host.toast(`${device.name || device.equipmentNo} won't sync until it's paired again.`);
      // RE-READ RATHER THAN SPLICE THE ROW OUT. What is bound is the server's
      // answer, not this list's, and a row removed locally would keep saying so
      // even if the unlink had quietly done nothing. It also costs the one round
      // trip that makes the list right when a second device was paired while
      // this page was open.
      await loadDevices(mine);
    } catch (e) {
      if (mine !== generation) return;
      if (!handled(e)) host.toast(failureMessage(e));
    } finally {
      unlinking.delete(device.equipmentNo);
      if (mine === generation) renderDevices();
    }
  }

  // --- Storage --------------------------------------------------------------

  function renderStorage(): void {
    if (storage.kind === "loading") {
      storageBody.replaceChildren(pending());
      return;
    }
    if (storage.kind === "failed") {
      storageBody.replaceChildren(failed(storage.message));
      return;
    }
    const data = storage.data;
    const total = el(
      "div",
      { class: "acct-total" },
      el("span", { class: "acct-total__v acct-data", text: formatBytes(data.usedBytes) }),
      el("span", { class: "acct-total__k", text: `of ${formatBytes(data.totalBytes)}` }),
    );
    if (data.byKind === null) {
      // A REAL STATE, not an error: the total is known and the split is not.
      storageBody.replaceChildren(
        total,
        el("p", { class: "acct-hint", text: "This server can't break the total down by kind yet." }),
      );
      return;
    }
    storageBody.replaceChildren(
      total,
      ...storageRows(data.byKind).map((r) =>
        el(
          "div",
          { class: "acct-row acct-kind" },
          el(
            "div",
            { class: "acct-row__k" },
            el("span", { text: r.label }),
            el("span", { class: "acct-kind__hint", text: r.hint }),
          ),
          el("div", { class: "acct-row__v acct-data", text: formatBytes(r.bytes) }),
          // THE ONE LINE WITH SOMEWHERE TO SEND YOU. Every other figure is a
          // fact about what you have chosen to keep; this one is a number you
          // can act on in a click, which is a large part of why §7 added it.
          el(
            "div",
            { class: "acct-row__acts" },
            r.key === "bin" ? button("Open", () => host.onOpenBin(), { ariaLabel: "Open the recycle bin" }) : null,
          ),
        ),
      ),
    );
  }

  // --- the versions control -------------------------------------------------
  //
  //     Keep the last  [−][ 5 ][+]  of each file            [ Save ]
  //
  // NO BYTE FIGURE ON THIS LINE. It carried the current version total, and sat
  // where `Save` appears — so next to a pending change it read as what the
  // change would cost, a delta, which it never was. A number that is right and
  // reads as something else is worse here than no number, because the one thing
  // this control must not do is misstate the price of pressing it.
  //
  // The total still has a home: the Versions line in Storage, a few rows up,
  // where it sits among the other four and reads as the total it is.
  //
  // BOUNDED ABOVE BY THE SERVER, so one person cannot set the household's disk
  // policy; the global `max_bytes` stays a backstop behind that.

  // A STEPPER, not a bare number box. The value is a small integer nobody types
  // in full — it moves by one, and a person deciding this is comparing "5" with
  // "4", not entering a quantity. The native spinners are unusable at this size
  // and vanish on some platforms, so the two buttons are real controls: they take
  // a tap on a tablet, they show their disabled edges, and the field stays
  // editable for whoever would rather type.
  const keepInput = el("input", {
    class: "acct-keep acct-data",
    id: "acct-keep",
    type: "number",
    inputmode: "numeric",
    min: "0",
    step: "1",
    "aria-describedby": "acct-keep-note",
  }) as HTMLInputElement;
  const keepDown = el("button", {
    class: "acct-step",
    type: "button",
    "aria-label": "Keep one fewer",
    text: "−", // MINUS SIGN, not a hyphen — it sits on the digits' baseline
  }) as HTMLButtonElement;
  const keepUp = el("button", {
    class: "acct-step",
    type: "button",
    "aria-label": "Keep one more",
    text: "+",
  }) as HTMLButtonElement;
  const keepStepper = el("div", { class: "acct-stepper" }, keepDown, keepInput, keepUp);

  /** Nudges the field and runs the same path typing does, so the notice, the
   *  Save button and the bounds cannot behave differently by route. */
  function step(by: number): void {
    if (policy.kind !== "ready") return;
    const from = typedKeep() ?? policy.data.keep;
    const next = Math.min(Math.max(from + by, 0), policy.data.maxKeep);
    keepInput.value = String(next);
    updateKeepNote();
  }
  keepDown.addEventListener("click", () => step(-1));
  keepUp.addEventListener("click", () => step(1));
  const keepNote = el("p", { class: "acct-keep__note", id: "acct-keep-note", role: "status", "aria-live": "polite" });
  const keepSave = el("button", { class: "acct-btn acct-btn--go acct-keep__save", type: "button", text: "Save", hidden: true });
  const keepLine = el(
    "div",
    { class: "acct-keep__line" },
    el("label", { class: "acct-keep__label", htmlFor: "acct-keep", text: "Keep the last" }),
    keepStepper,
    el("span", { class: "acct-keep__of", text: "of each file" }),
    keepSave,
  );

  keepInput.addEventListener("input", () => updateKeepNote());
  keepSave.addEventListener("click", () => void savePolicy());

  function typedKeep(): number | null {
    const raw = keepInput.value.trim();
    if (raw === "") return null;
    const n = Number.parseInt(raw, 10);
    return Number.isSafeInteger(n) ? n : null;
  }

  function updateKeepNote(): void {
    if (policy.kind !== "ready") return;
    const p = policy.data;
    const typed = typedKeep();
    if (typed === null) {
      keepNote.textContent = "";
      keepSave.hidden = true;
      return;
    }
    if (typed > p.maxKeep) {
      keepNote.textContent = `This server keeps at most ${p.maxKeep} for each file.`;
      keepSave.hidden = true;
      return;
    }
    if (typed < 0) {
      keepNote.textContent = "The fewest you can keep is 0.";
      keepSave.hidden = true;
      return;
    }
    keepNote.textContent = typed === p.keep ? "" : (discardNotice(p.retainedPerFile, typed) ?? "");
    keepSave.hidden = typed === p.keep;
  }

  function renderPolicy(): void {
    if (policy.kind === "loading") {
      versionsBody.replaceChildren(pending());
      return;
    }
    if (policy.kind === "failed") {
      versionsBody.replaceChildren(failed(policy.message));
      return;
    }
    const p = policy.data;
    keepInput.max = String(p.maxKeep);
    // Only reassert the value when the user is not mid-edit, so a late refresh
    // cannot rewrite a number somebody is typing.
    if (document.activeElement !== keepInput) keepInput.value = String(p.keep);
    keepSave.disabled = savingPolicy;
    versionsBody.replaceChildren(
      keepLine,
      keepNote,
      el("p", {
        class: "acct-hint",
        // PER FILE, NOT A POOL — said in the copy as well as in the control's
        // own wording, because that is the one thing about `K` a reader can get
        // wrong and never find out.
        text: "This applies to each file on its own, not to a shared total. Discarded versions can't be recovered — the recycle bin doesn't hold them.",
      }),
    );
    updateKeepNote();
  }

  async function savePolicy(): Promise<void> {
    if (savingPolicy || policy.kind !== "ready") return;
    const typed = typedKeep();
    if (typed === null || typed < 0 || typed > policy.data.maxKeep) return;
    savingPolicy = true;
    keepSave.disabled = true;
    keepSave.textContent = "Saving…";
    const mine = generation;
    try {
      const result = await host.api.setVersionPolicy(typed);
      if (mine !== generation) return;
      policy = { kind: "ready", data: result.policy };
      host.toast(
        result.removedVersions === 0
          ? `Keeping the last ${result.policy.keep} of each file.`
          : `Removed ${result.removedVersions === 1 ? "1 version" : `${result.removedVersions} versions`}, freeing ${formatBytes(result.freedBytes)}.`,
      );
      // The Versions line in Storage is now wrong by exactly what was freed, so
      // re-read it rather than doing the arithmetic in two places.
      void loadStorage(mine);
    } catch (e) {
      if (mine !== generation) return;
      if (!handled(e)) host.toast(failureMessage(e));
    } finally {
      savingPolicy = false;
      keepSave.textContent = "Save";
      if (mine === generation) renderPolicy();
    }
  }

  // --- Appearance -----------------------------------------------------------
  //
  // THE THEME TOGGLE MOVED HERE FROM THE RAIL, and it is the same one control
  // rather than a second copy. The argument for keeping it in the footer — that
  // people flip it often — does not survive the fact that the app already
  // follows `prefers-color-scheme`: this is a SET-ONCE OVERRIDE for someone
  // whose system says one thing and who wants another here. It was already
  // listed under Appearance, so leaving it in the rail was one control in two
  // places (§7).
  //
  // A TWO-OPTION CONTROL, not a toggle button, because a toggle has to be read
  // as "the state you are in" or "the state you would go to" and it is never
  // obvious which. Nothing is pinned until one is pressed, so somebody who has
  // never chosen keeps following their system.

  const themeButtons = new Map<Theme, HTMLButtonElement>();
  function themeChoice(theme: Theme, label: string, icon: IconName): HTMLButtonElement {
    const b = el("button", {
      class: "acct-theme__opt",
      type: "button",
      "aria-pressed": "false",
      html: svg(ICONS[icon]),
    });
    b.append(el("span", { text: label }));
    b.addEventListener("click", () => host.onSetTheme(theme));
    themeButtons.set(theme, b);
    return b;
  }

  appearanceBody.append(
    el(
      "div",
      { class: "acct-row" },
      el("div", { class: "acct-row__k", text: "Theme" }),
      el(
        "div",
        { class: "acct-row__v acct-theme", role: "group", "aria-label": "Theme" },
        // PAPER, not Light. The app's whole surface is a sheet on a desk — the
        // tokens are literally `--desk`, `--sheet`, `--ink` — and naming the
        // themes after that material is the one place the interface can say so
        // out loud. "Light/Dark" is what every other app calls it; this one has
        // its own word for the thing and should use it.
        themeChoice("light", "Paper", "sun"),
        themeChoice("dark", "Paper Dark", "moon"),
      ),
    ),
  );

  function renderTheme(): void {
    const active = currentTheme();
    for (const [theme, b] of themeButtons) b.setAttribute("aria-pressed", String(theme === active));
  }
  renderTheme();

  // --- loading --------------------------------------------------------------
  //
  // FOUR INDEPENDENT CALLS, fired together and painted as each lands. Serial
  // fetching would put the whole page behind the slowest of them, and a shared
  // failure state would lose three readable sections to one missing endpoint.

  function loadSecurity(mine: number): Promise<void> {
    return host.api.accountSecurity().then(
      (data) => {
        if (mine !== generation) return;
        security = { kind: "ready", data };
        renderSecurity();
      },
      (e: unknown) => {
        if (mine !== generation) return;
        if (handled(e)) return;
        security = { kind: "failed", message: failureMessage(e) };
        renderSecurity();
      },
    );
  }

  function loadDevices(mine: number): Promise<void> {
    return host.api.myDevices().then(
      (data) => {
        if (mine !== generation) return;
        devices = { kind: "ready", data };
        renderDevices();
      },
      (e: unknown) => {
        if (mine !== generation) return;
        if (handled(e)) return;
        devices = { kind: "failed", message: failureMessage(e) };
        renderDevices();
      },
    );
  }

  function loadStorage(mine: number): Promise<void> {
    return host.api.storageBreakdown().then(
      (data) => {
        if (mine !== generation) return;
        storage = { kind: "ready", data };
        renderStorage();
      },
      (e: unknown) => {
        if (mine !== generation) return;
        if (handled(e)) return;
        storage = { kind: "failed", message: failureMessage(e) };
        renderStorage();
      },
    );
  }

  function loadPolicy(mine: number): Promise<void> {
    return host.api.versionPolicy().then(
      (data) => {
        if (mine !== generation) return;
        policy = { kind: "ready", data };
        renderPolicy();
      },
      (e: unknown) => {
        if (mine !== generation) return;
        if (handled(e)) return;
        policy = { kind: "failed", message: failureMessage(e) };
        renderPolicy();
      },
    );
  }

  /**
   * Take over (or hand back) the topbar — the same three things the console
   * does, for the same reasons: sort and the view toggle describe a folder
   * listing and this is not one, and the destination mode takes the search box
   * away rather than leaving a control that navigates out of the page it sits on.
   */
  function chrome(mine: boolean): void {
    host.sortWrap.hidden = mine;
    host.segmented.hidden = mine;
    host.setMode(mine);
    if (!mine) return;
    // "Library / You" — the path the URL spells, with Library still a way out.
    const home = el("button", { type: "button", text: "Library" });
    home.addEventListener("click", () => host.onLeave());
    host.crumbs.replaceChildren(
      home,
      el("span", { class: "crumbs__sep", text: "/" }),
      el("span", { class: "crumbs__here", text: "You" }),
    );
  }

  return {
    open(): void {
      const mine = ++generation;
      if (!open_) {
        open_ = true;
        panel.hidden = false;
        // HIDDEN rather than emptied, exactly as the console does it: the
        // shell's listing, its lazy engine and every bitmap already drawn
        // survive, so leaving lands back on the folder without a refetch.
        host.gallery.hidden = true;
      }
      chrome(true);
      // Re-entering re-reads: a housemate's tablet may have synced, and a
      // version may have been evicted, while you were away. The previous
      // answers stay on screen meanwhile — this is the same page, not the next
      // one, so there is no wrong view to leave up.
      if (security.kind !== "ready") renderSecurity();
      if (devices.kind !== "ready") renderDevices();
      if (storage.kind !== "ready") renderStorage();
      if (policy.kind !== "ready") renderPolicy();
      renderTheme();
      void loadSecurity(mine);
      void loadDevices(mine);
      void loadStorage(mine);
      void loadPolicy(mine);
    },

    close(): void {
      if (!open_) return;
      open_ = false;
      generation++; // orphan everything still in flight
      panel.hidden = true;
      host.gallery.hidden = false;
      togglePasswordForm(false);
      chrome(false);
    },

    isOpen: () => open_,

    themeChanged: renderTheme,

    destroy(): void {
      generation++;
      panel.remove();
      host.gallery.hidden = false;
      if (open_) chrome(false);
      open_ = false;
    },
  };
}

/** Initials for the page's avatar — the same derivation the rail's nameplate
 *  uses, so the two never disagree about who you are. */
function initials(email: string): string {
  const name = (email || "").split("@")[0] ?? "";
  const parts = name.split(/[.\-_]+/).filter(Boolean);
  const a = parts[0]?.[0] ?? "?";
  const b = parts[1]?.[0] ?? parts[0]?.[1] ?? "";
  return (a + b).toUpperCase();
}
