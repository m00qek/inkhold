// The account page's change-password form: current, new and confirm. The
// current password is required because a session is not a password prompt
// (borrowed laptop, unlocked screen).

import { el } from "../../ui/dom";
import { field, statusLine } from "../../ui/form";
import { ApiError } from "../../api/client";
import type { MyDevice } from "../../api/accountTypes";
import { MIN_PASSWORD_LENGTH, type AccountApi } from "./account";
import { passwordChangeConsequence, passwordFailureMessage } from "./accountCopy";

export interface PasswordFormDeps {
  api: Pick<AccountApi, "changePassword">;
  handled: (e: unknown) => boolean;
  /** The page's visit counter; a response for an older visit is dropped. */
  generation: () => number;
  onCancel: () => void;
  /** After the server accepted the change. */
  onChanged: () => void;
}

// Current, new and confirm; the current password is required because a
// session is not a password prompt (borrowed laptop, unlocked screen). Copy is
// separate from the first-login screen's.
export interface PasswordForm {
  node: HTMLFormElement;
  reset(): void;
  focus(): void;
  syncConsequence(devices: readonly MyDevice[]): void;
}

export function createPasswordForm(deps: PasswordFormDeps): PasswordForm {
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
    // Both constraints where the choice is made, not one field too late.
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
  // Filled by `syncConsequence` once devices arrive.
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

  cancel.addEventListener("click", () => deps.onCancel());

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
    const mine = deps.generation();
    void deps.api
      .changePassword(current.input.value, value)
      .then(() => {
        if (mine !== deps.generation()) return;
        deps.onChanged();
      })
      .catch((err: unknown) => {
        if (mine !== deps.generation()) return;
        submit.disabled = false;
        submit.textContent = "Change password";
        if (deps.handled(err)) return;
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
