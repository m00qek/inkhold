// First-login (mandatory) change-password page — step 2 of first-run onboarding.
// Reached with a limited "pending" session that can touch nothing else. On
// success the server revokes all sessions and issues a fresh full session as a
// new cookie, and we continue to the connect-device step. This is the ONLY way
// into this page: there is no voluntary "change my password" entry in the app,
// so every visit is onboarding, and continuing to `/connect` is unambiguous.

import { el } from "../ui/dom";
import { authView, stepDots } from "../ui/chrome";
import { field, statusLine } from "../ui/form";
import { api, ApiError, RateLimitError } from "../api/client";
import { session } from "../session";
import { go } from "../router";

const MIN_LENGTH = 8;

export function changePasswordPage(): HTMLElement {
  const next = field({
    id: "new-password",
    label: "New password",
    type: "password",
    autocomplete: "new-password",
    autofocus: true,
    minLength: MIN_LENGTH,
    hint: `At least ${MIN_LENGTH} characters, and not the temporary one.`,
  });
  const confirm = field({
    id: "confirm-password",
    label: "Confirm password",
    type: "password",
    autocomplete: "new-password",
    minLength: MIN_LENGTH,
    hint: "You'll type this on the Supernote too — pick something easy on a tablet keyboard.",
  });
  const status = statusLine();
  const submit = el("button", { class: "button", type: "submit", text: "Save and continue" });

  const form = el(
    "form",
    { class: "form" },
    el("h1", { class: "title", text: "Choose your password" }),
    el("p", {
      class: "subtitle",
      text: "The temporary one can do exactly one thing — replace itself. It stops working the moment you set your own.",
    }),
    next.row,
    confirm.row,
    submit,
    status.node,
  );

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (submit.disabled) return;
    status.clear();

    const value = next.input.value;
    if (value.length < MIN_LENGTH) {
      status.error(`Use at least ${MIN_LENGTH} characters.`);
      next.input.focus();
      return;
    }
    if (value !== confirm.input.value) {
      status.error("The two passwords don't match.");
      confirm.input.focus();
      return;
    }

    submit.disabled = true;
    submit.textContent = "Saving…";
    try {
      await api.changePassword(value);
      session.markSignedIn();
      go("/connect");
    } catch (err) {
      submit.disabled = false;
      submit.textContent = "Save and continue";
      if (err instanceof RateLimitError) {
        status.error("Too many attempts. Wait a moment and try again.");
      } else if (err instanceof ApiError && err.code === "SAME_PASSWORD") {
        status.error("Choose a password different from your temporary one.");
        next.input.focus();
      } else if (err instanceof ApiError && err.status === 401) {
        // The pending session expired before the change completed.
        status.error("Your sign-in expired. Sign in again to continue.");
        setTimeout(() => go("/login"), 1500);
      } else if (err instanceof ApiError) {
        status.error(err.message);
      } else {
        status.error("Something went wrong. Try again.");
      }
    }
  });

  const view = authView(form);
  view.querySelector(".sheet")?.append(stepDots(2));
  return view;
}
