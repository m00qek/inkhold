// The admin console's painter: the gate, the household (`adminPeopleView.ts`)
// and the Server panel (`adminServerView.ts`); dialogs are `adminDialogs.ts`.

import { el } from "../../ui/dom";
import { field, statusLine } from "../../ui/form";
import type { AdminState, AdminView } from "./adminModel";
import { createAdminDialogs } from "./adminDialogs";
import { personRow, type PersonHandlers } from "./adminPeopleView";
import { serverPanel, type ServerHandlers } from "./adminServerView";

export interface AdminViewOptions extends PersonHandlers, ServerHandlers {
  /** Holds the dialogs: a `<dialog>` must survive a repaint of `body`. */
  host: HTMLElement;
  /** Repainted with each state. */
  body: HTMLElement;
  toast(message: string): void;
  onUnlock(password: string): void;
  onAdd(): void;
}

export function createAdminView(opts: AdminViewOptions): AdminView & { revealBackups(): void } {
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
      el("h2", { class: "admin-gate__title", text: "Confirm your password" }),
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
      el("div", { class: "admin-people" }, ...state.people.map((p) => personRow(p, state.busy, opts))),
      serverPanel(state.server, state.busy, opts),
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

    ...createAdminDialogs(host),
    toast: opts.toast,
  };
}
