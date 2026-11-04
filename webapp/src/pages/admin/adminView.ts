// The admin console's painter: the gate, the people, their devices, quotas and the server panel.

import { el } from "../../ui/dom";
import { openDialog, type DialogButtons } from "../../ui/confirm";
import { field, statusLine } from "../../ui/form";
import { ICONS, svg } from "../../ui/icons";
import { type AdminDevice, type AdminUser } from "../../api/adminTypes";
import { type AdminState, type Person, type Server, type ConfirmSpec, type NewPerson, type NumberSpec, type HandOver, type AdminView } from "./admin";
import { type Meter, displayName, deviceTitle, deviceMeta, accountAge, meterFor, memoryCard, formatBytes, RETENTION_NEVER_PURGES } from "./adminCopy";
import { backupsCard } from "./backupCopy";
import { backupsDetail } from "./adminBackupsView";
import { initials } from "../account/account";

// ---- the painter ----

/**
* The shared `openDialog` (`ui/confirm.ts`) with the console's classes:
* Cancel first and default, built per call.
*/
function dialog(
  host: HTMLElement,
  build: (body: HTMLElement, actions: DialogButtons) => void,
  goLabel: string,
  cancelLabel: string,
): { node: HTMLDialogElement; done: Promise<boolean> } {
  return openDialog({
    host,
    classes: {
      dialog: "admin-dialog",
      body: "admin-dialog__body",
      actions: "admin-dialog__actions",
      cancel: "admin-btn",
      go: "admin-btn admin-btn--go",
    },
    goLabel,
    cancelLabel,
    build,
  });
}

/** `host` holds dialogs, `body` the state; a `<dialog>` must survive repaint. */
export function createAdminView(opts: {
  host: HTMLElement;
  body: HTMLElement;
  /** So "Reset password" is never offered on your own row. */
  account: string;
  toast(message: string): void;
  onUnlock(password: string): void;
  onAdd(): void;
  onReset(person: AdminUser): void;
  onDelete(person: AdminUser): void;
  onQuota(person: Person): void;
  onUnlink(person: Person, device: AdminDevice): void;
  onRetention(): void;
  onBackupDismiss(dismissed: boolean): void;
  onBackupForget(dir: string): void;
}): AdminView & { revealBackups(): void } {
  const { host, body } = opts;

  /** Set by "Open backups": the next ready paint scrolls there and focuses it. */
  let revealPending = false;

  function reveal(): void {
    // The Server panel when there is no backup record to show.
    const target = body.querySelector<HTMLElement>(".admin-backups__title") ?? body.querySelector<HTMLElement>(".admin-server");
    // Still hidden (the console reopening) or not drawn yet: keep the wish.
    if (!target || target.getClientRects().length === 0) return;
    revealPending = false;
    target.scrollIntoView({ block: "start" });
    target.focus({ preventScroll: true });
  }

  function gate(state: Extract<AdminState, { kind: "locked" }>): HTMLElement {
    // The app's real auth field, from `ui/form.ts`.
    const password = field({
      id: "admin-elevate",
      label: "Password",
      type: "password",
      autocomplete: "current-password",
      autofocus: true,
    });
    const status = statusLine();
    if (state.error) status.error(state.error);

    // Not the auth pages' `.button`: the shell's control reset
    // (`.sn-root :where(button, input, select) { color: inherit }`) has the same
    // specificity and comes later, painting ink on ink. The console's sheet is last.
    const submit = el("button", {
      class: "admin-gate__submit",
      type: "submit",
      text: state.busy ? "Confirming…" : "Unlock console",
      disabled: state.busy,
    });

    const form = el(
      "form",
      { class: "admin-gate__form" },
      el("p", { class: "admin-gate__mark", text: "Admin console" }),
      el("h1", { class: "admin-gate__title", text: "Confirm your password" }),
      el("p", {
        class: "admin-gate__why",
        text:
          "This console can delete another person's notes and reset their password, " +
          "so it asks again — a tablet left signed in on a table cannot reach it.",
      }),
      password.row,
      submit,
      status.node,
      el("p", {
        class: "admin-gate__note",
        // The server's `elevation_idle_s` and `elevation_absolute_s`.
        text: "Access ends after 15 minutes of inactivity, an hour at the most, or when you lock it.",
      }),
    );
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      opts.onUnlock(password.input.value);
      password.input.value = "";
    });
    return el("section", { class: "admin-gate" }, form);
  }

  function chip(text: string, kind: "admin" | "pending"): HTMLElement {
    return el("span", { class: `admin-chip admin-chip--${kind}`, text });
  }

  /** Same idiom as the bin's retention countdown. */
  function meterEl(meter: Meter, label: string, control: HTMLElement | null, bare = false): HTMLElement {
    const fill = el("div", { class: "admin-meter__fill" });
    fill.style.width = `${meter.fill}%`;
    return el(
      "div",
      { class: `admin-meter is-${meter.tone}` },
      el(
        "div",
        {
          class: "admin-meter__track",
          role: "img",
          "aria-label": `${label}: ${meter.label}`,
        },
        fill,
      ),
      // `bare` in a stat card, whose value already says it.
      bare ? null : el("div", { class: "admin-meter__label" }, el("span", { text: meter.label }), control),
    );
  }

  /** Glyph then words, like every labelled action; the pencil is `aria-hidden`. */
  function changeBtn(ariaLabel: string, onClick: () => void): HTMLButtonElement {
    const b = el(
      "button",
      { class: "admin-change", type: "button" },
      el("span", { class: "admin-change__mark", "aria-hidden": "true", html: svg(ICONS.edit, 1.9) }),
      el("span", { text: "Change" }),
    );
    b.setAttribute("aria-label", ariaLabel);
    b.addEventListener("click", onClick);
    return b;
  }

  /**
  * Unlink is a labelled button, not a chip's "×": it cuts a tablet off and
  * re-linking needs the device in hand.
  */
  function deviceRow(person: Person, device: AdminDevice, busy: boolean): HTMLElement {
    const name = displayName(person.user.email);
    // A revoked binding stays on the row (soft revoke allows re-pairing), with no Unlink.
    const action = device.active
      ? (() => {
          const b = el("button", { class: "admin-device__cut", type: "button", text: "Unlink", disabled: busy });
          b.setAttribute("aria-label", `Unlink ${deviceTitle(device)} from ${name}`);
          b.title = "Stop this device syncing";
          b.addEventListener("click", () => opts.onUnlink(person, device));
          return b;
        })()
      : el("span", { class: "admin-chip admin-chip--muted", text: "unlinked" });

    return el(
      "div",
      { class: `admin-device${device.active ? "" : " is-revoked"}` },
      el("span", { class: "admin-device__name", text: deviceTitle(device) }),
      el("span", { class: "admin-device__meta", text: deviceMeta(device) }),
      action,
    );
  }

  function devicesEl(person: Person, busy: boolean): HTMLElement {
    // Null is not empty: a failed call must not read "no device linked yet".
    if (person.devices === null) {
      return el("div", { class: "admin-devices__none", text: "Devices could not be listed." });
    }
    if (person.devices.length === 0) {
      return el("div", {
        class: "admin-devices__none",
        text: "No device linked yet. One appears here after their first sync.",
      });
    }
    return el("div", { class: "admin-devices" }, ...person.devices.map((d) => deviceRow(person, d, busy)));
  }

  /** `busy` disables every control as feedback; the controller has the real guard. */
  function personRow(person: Person, busy: boolean): HTMLElement {
    const user = person.user;
    const name = displayName(user.email);
    const added = accountAge(user.createdAt);
    // No "Reset password" on your own row (it once locked a tester out); a pointer
    // to the account page instead of a disabled button.
    const isSelf = user.email === opts.account;
    const reset = isSelf
      ? el("span", {
          class: "admin-selfnote",
          text: "on your account page",
          title: "Change your own password from Library / You",
        })
      : el("button", { class: "admin-btn", type: "button", text: "Reset password", disabled: busy });
    if (!isSelf) {
      reset.setAttribute("aria-label", `Reset the password for ${name}`);
      reset.addEventListener("click", () => opts.onReset(user));
    }

    // No Delete on your own row: `LastAdmin` protects the household, not you.
    const remove = isSelf
        ? null
        : el("button", { class: "admin-btn admin-btn--danger", type: "button", text: "Delete", disabled: busy });
    if (remove) {
      remove.setAttribute("aria-label", `Delete ${name}`);
      remove.addEventListener("click", () => opts.onDelete(user));
    }

    // An unreadable quota renders as absent, never a zero meter.
    const storage = person.quota
      ? meterEl(
          meterFor(person.quota),
          `Storage for ${name}`,
          busy ? null : changeBtn(`Change the allotment for ${name}`, () => opts.onQuota(person)),
        )
      : el("div", { class: "admin-devices__none", text: "Storage could not be counted." });

    return el(
      "article",
      { class: "admin-person" },
      el("span", { class: "admin-avatar", "aria-hidden": "true", text: initials(user.email) }),
      el(
        "div",
        { class: "admin-person__id" },
        el(
          "div",
          { class: "admin-person__name" },
          el("span", { text: name }),
          user.isAdmin && chip("admin", "admin"),
          user.mustChangePassword && chip("must set password", "pending"),
        ),
        el("div", { class: "admin-person__mail", text: user.email }),
        added ? el("div", { class: "admin-person__since", text: `Added ${added}` }) : null,
        storage,
        devicesEl(person, busy),
      ),
      el("div", { class: "admin-person__acts" }, reset, remove),
    );
  }

  /** `danger`: the value reads in the console's danger colour, like an overfull meter's label. */
  function statCard(k: string, value: string, sub: string, meter: Meter | null, control: HTMLElement | null, danger = false): HTMLElement {
    return el(
      "div",
      { class: danger ? "admin-stat admin-stat--danger" : "admin-stat" },
      el("div", { class: "admin-stat__k", text: k }),
      el("div", { class: "admin-stat__v" }, el("span", { text: value }), control),
      el("div", { class: "admin-stat__sub", text: sub }),
      meter ? meterEl(meter, k, null, true) : null,
    );
  }

  /** Household totals only; no uptime or last-sync cards (activity surveillance). */
  function serverPanel(server: Server, busy: boolean): HTMLElement | null {
    const { health, retention, backups } = server;
    if (!health && !retention && !backups) return null; // nothing readable: draw no panel at all

    const cards: (HTMLElement | null)[] = [];
    if (health) {
      const mem = memoryCard(health);
      cards.push(statCard("Memory", mem.value, mem.sub, mem.meter, null));
      // States its denominator so it doesn't read as free space.
      cards.push(
        statCard(
          "Disk used",
          formatBytes(health.blobBytes),
          `across ${health.blobCount.toLocaleString("en-GB")} stored files, deduplicated`,
          null,
          null,
        ),
      );
    }
    if (retention) {
      cards.push(
        statCard(
          "Recycle bin",
          `${retention.retentionDays} ${retention.retentionDays === 1 ? "day" : "days"}`,
          "before deleted notes are removed for good",
          null,
          busy ? null : changeBtn("Change how long the recycle bin holds a note", () => opts.onRetention()),
        ),
      );
    }

    if (backups) {
      const card = backupsCard(backups);
      cards.push(statCard("Backups", card.value, card.sub, null, null, card.danger));
    }

    return el(
      "section",
      { class: "admin-server" },
      el(
        "div",
        { class: "admin-head" },
        el("h2", { class: "admin-head__title", text: "Server" }),
        health ? el("span", { class: "admin-head__ver", text: health.version }) : null,
        el("span", { class: "admin-head__rule", "aria-hidden": "true" }),
      ),
      el("div", { class: "admin-stats" }, ...cards),
      // Right under the cards: it is about the Recycle bin card, not the backups below.
      retention
        ? el("p", {
            class: "admin-server__note",
            // Also on the card: the reader of the number needs to know lowering it is safe.
            text: RETENTION_NEVER_PURGES,
          })
        : null,
      backups
        ? backupsDetail(backups, busy, { onDismiss: opts.onBackupDismiss, onForget: opts.onBackupForget })
        : null,
    );
  }

  function ready(state: Extract<AdminState, { kind: "ready" }>): HTMLElement {
    const add = el("button", { class: "admin-btn", type: "button", text: "Add person", disabled: state.busy });
    add.addEventListener("click", () => opts.onAdd());
    // Lock console lives in the topbar (`lockAdminBtn` in library.ts): view-level.

    return el(
      "section",
      { class: "admin-wrap", "aria-busy": String(state.busy) },
      el(
        "div",
        { class: "admin-head" },
        el("h2", { class: "admin-head__title", text: "People" }),
        el("span", { class: "admin-head__rule", "aria-hidden": "true" }),
        el("div", { class: "admin-head__acts" }, add),
      ),
      el("div", { class: "admin-people" }, ...state.people.map((p) => personRow(p, state.busy))),
      serverPanel(state.server, state.busy),
    );
  }

  function notice(title: string, text: string): HTMLElement {
    return el(
      "section",
      { class: "admin-notice" },
      el("h2", { class: "admin-notice__title", text: title }),
      el("p", { class: "admin-notice__text", text }),
    );
  }

  return {
    render(state: AdminState): void {
      if (state.kind === "locked") body.replaceChildren(gate(state));
      else if (state.kind === "loading") body.replaceChildren(notice("Loading…", "Fetching the household."));
      else if (state.kind === "ready") {
        body.replaceChildren(ready(state));
        if (revealPending) reveal();
      } else body.replaceChildren(notice("The console could not be loaded", state.message));
    },

    /** Now if the household is on screen, else at the next ready paint (after unlocking). */
    revealBackups(): void {
      revealPending = true;
      reveal();
    },

    confirm(spec: ConfirmSpec): Promise<boolean> {
      const { done } = dialog(
        host,
        (content, { go }) => {
          content.append(
            el("h2", { class: "admin-dialog__title", text: spec.title }),
            el("p", { class: "admin-dialog__text", text: spec.text }),
          );
          go.classList.toggle("admin-btn--danger", spec.danger === true);
          if (!spec.confirmWord) return;

          const word = spec.confirmWord;
          // Not autofocused: focus stays on Cancel, the way out.
          const typed = field({ id: "admin-confirm-word", label: "Type the address to confirm" });
          // The literal is shown separately because the label is uppercased.
          typed.row.insertBefore(el("code", { class: "admin-dialog__word", text: word }), typed.input);
          go.disabled = true;
          typed.input.addEventListener("input", () => {
            // Trimmed (pasted spaces), case-exact.
            go.disabled = typed.input.value.trim() !== word;
          });
          content.append(typed.row);
        },
        spec.label,
        "Cancel",
      );
      return done;
    },

    async askNewPerson(): Promise<NewPerson | null> {
      // Address only: the server stores no name.
      const email = field({ id: "admin-new-email", label: "Email", type: "email", autofocus: true });
      email.input.placeholder = "name@household.lan";
      const makeAdmin = el("input", { id: "admin-new-admin", type: "checkbox" });

      const { done } = dialog(
        host,
        (content) => {
          content.append(
            el("h2", { class: "admin-dialog__title", text: "Add a person" }),
            el("p", {
              class: "admin-dialog__text",
              text: "They get a temporary password and choose their own the first time they sign in.",
            }),
            email.row,
            el(
              "label",
              { class: "admin-check" },
              makeAdmin,
              el("span", { text: "Also an administrator" }),
              el("small", { text: "Administrators can add, reset and delete household accounts." }),
            ),
          );
        },
        "Add person",
        "Cancel",
      );
      // Read the field before the dialog leaves the DOM.
      const ok = await done;
      const address = email.input.value.trim();
      if (!ok || address === "") return null;
      return { email: address, isAdmin: makeAdmin.checked };
    },

    async askNumber(spec: NumberSpec): Promise<number | null> {
      const input = field({ id: "admin-number", label: spec.label, type: "number", hint: spec.hint });
      input.input.value = String(spec.value);
      input.input.min = String(spec.min);
      input.input.max = String(spec.max);
      input.input.step = String(spec.step);
      input.input.inputMode = "decimal";

      const { done } = dialog(
        host,
        (content, { go }) => {
          content.append(
            el("h2", { class: "admin-dialog__title", text: spec.title }),
            el("p", { class: "admin-dialog__text", text: spec.text }),
            input.row,
          );
          // Disabled out of the server's own bounds (`minDays`/`maxDays`), not a 400 later.
          const check = (): void => {
            const v = Number(input.input.value);
            go.disabled = input.input.value.trim() === "" || !Number.isFinite(v) || v < spec.min || v > spec.max;
          };
          input.input.addEventListener("input", check);
          check();
        },
        spec.confirmLabel,
        "Cancel",
      );

      const ok = await done;
      const value = Number(input.input.value);
      if (!ok || !Number.isFinite(value) || value < spec.min || value > spec.max) return null;
      return value;
    },

    handOver(spec: HandOver): Promise<void> {
      const { done } = dialog(
        host,
        (content) => {
          content.append(
            el("h2", { class: "admin-dialog__title", text: `Temporary password for ${displayName(spec.email)}` }),
            el("p", {
              class: "admin-dialog__text",
              // True: only the hash is stored.
              text:
                "Give them this. They choose their own the first time they sign in. " +
                "It cannot be shown again.",
            }),
            // `user-select: all` in the CSS: one click selects the whole secret.
            el("code", { class: "admin-secret", text: spec.password }),
          );
        },
        "Done",
        "Close",
      );
      return done.then(() => undefined);
    },

    toast: opts.toast,
  };
}
