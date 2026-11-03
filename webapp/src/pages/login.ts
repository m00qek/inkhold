// The login page. The password is hashed in the browser and never sent. A
// first-run server (`api.serverInfo`) upgrades the form in place to onboarding;
// if the probe fails, the plain form stays.

import { el } from "../ui/dom";
import { authView, stepDots } from "../ui/chrome";
import { field, statusLine } from "../ui/form";
import { api, ApiError, RateLimitError } from "../api/client";
import { session } from "../session";
import { go } from "../router";

const RETURNING_SUBTITLE = "Your household's private Supernote cloud.";
const FIRST_RUN_SUBTITLE =
  "First time here — with no account yet, the server created one for you and printed its temporary password in the terminal you started it from.";

// The client never receives the temporary password (server stdout only).
const TERMINAL_GUIDANCE = `== First run ==
An admin account was created for you.
Its temporary password was printed in the
terminal you started the server from — copy
it from there to sign in.`;

export function loginPage(): HTMLElement {
  const account = field({
    id: "account",
    label: "Account",
    type: "email",
    autocomplete: "username",
    autofocus: true,
  });
  const password = field({
    id: "password",
    label: "Password",
    type: "password",
    autocomplete: "current-password",
    hint: "Hashed in your browser — the password itself never leaves this machine.",
  });
  const status = statusLine();
  const submit = el("button", { class: "button", type: "submit", text: "Sign in" });

  const subtitle = el("p", { class: "subtitle", text: RETURNING_SUBTITLE });

  const form = el(
    "form",
    { class: "form", novalidate: false },
    el("h1", { class: "title", text: "Sign in" }),
    subtitle,
    account.row,
    password.row,
    submit,
    status.node,
  );

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (submit.disabled) return;

    status.clear();
    submit.disabled = true;
    submit.textContent = "Signing in…";

    try {
      const result = await api.login(account.input.value.trim(), password.input.value);
      session.markSignedIn();
      go(result.mustChangePassword ? "/change-password" : "/");
    } catch (err) {
      submit.disabled = false;
      submit.textContent = "Sign in";
      password.input.value = "";
      if (err instanceof RateLimitError) {
        const wait = err.retryAfterSeconds ? ` Try again in ${err.retryAfterSeconds}s.` : "";
        status.error(`Too many attempts.${wait}`);
      } else if (err instanceof ApiError) {
        // Bad account and bad password look the same, so it can't confirm an account.
        status.error(
          err.code === "INVALID_CREDENTIALS" || err.code === "NO_CHALLENGE"
            ? "That account and password don't match."
            : err.message,
        );
        password.input.focus();
      } else {
        status.error("Something went wrong. Try again.");
      }
    }
  });

  const view = authView(form);

  void api.serverInfo().then((info) => {
    if (!info?.firstRun) return;
    subtitle.textContent = FIRST_RUN_SUBTITLE;

    const label = password.row.querySelector(".field__label");
    if (label) label.textContent = "Temporary password";
    password.input.setAttribute("autocomplete", "one-time-code");

    const banner = el("pre", {
      class: "terminal",
      "aria-label": "Server terminal, first run",
      text: TERMINAL_GUIDANCE,
    });
    form.insertBefore(banner, account.row);

    view.querySelector(".sheet")?.append(stepDots(1));
  });

  return view;
}
