// The admin console's dialogs: confirmations, "Add a person", a number in the
// unit it is stated in, and the one-time hand-over of a temporary password.

import { el } from "../../ui/dom";
import { openDialog, type DialogButtons } from "../../ui/confirm";
import { field } from "../../ui/form";
import type { AdminView, ConfirmSpec, HandOver, NewPerson, NumberSpec } from "./adminModel";
import { displayName } from "./adminCopy";

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

export type AdminDialogs = Pick<AdminView, "confirm" | "askNewPerson" | "askNumber" | "handOver">;

/** Dialogs open in `host`, which survives the console's repaints. */
export function createAdminDialogs(host: HTMLElement): AdminDialogs {
  return {
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
  };
}
