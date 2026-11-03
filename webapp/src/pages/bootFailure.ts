// The sheet shown when a main.ts route arm rejects (usually the first
// `api.me()`), instead of a blank page. Not the signed-out screen: 401/403
// already route to `#/login`; only a server with no usable answer lands here.

import { el } from "../ui/dom";
import { authView } from "../ui/chrome";
import { statusLine } from "../ui/form";
import { ApiError } from "../api/client";

interface Cause {
  title: string;
  detail: string;
}

/** Says what happened without guessing. Exported for the unit test. */
export function bootFailureCause(e: unknown): Cause {
  if (e instanceof ApiError && e.code === "NETWORK") {
    return {
      title: "Can't reach the server",
      detail:
        "This page is already loaded, but the server behind it isn't answering. It may have stopped, or the network to it may be down.",
    };
  }
  if (e instanceof ApiError && e.code === "TIMEOUT") {
    return {
      title: "The server isn't answering",
      detail: "The connection went through, but nothing came back in time. The server may still be starting up.",
    };
  }
  if (e instanceof ApiError) {
    // A real but unusable answer (5xx, bad envelope); the client already phrased it.
    return { title: "The server couldn't answer", detail: e.message };
  }
  return {
    title: "The app couldn't start",
    detail: "Something went wrong before the library was on screen.",
  };
}

function retryFailureMessage(e: unknown): string {
  if (e instanceof ApiError && e.code === "NETWORK") return "Still can't reach the server.";
  if (e instanceof ApiError && e.code === "TIMEOUT") return "Still no answer from the server.";
  if (e instanceof ApiError) return e.message;
  return "Still failing. Try again in a moment.";
}

export interface BootFailureOpts {
  error: unknown;
  /**
  * Resolving means the route mounted something else; rejecting keeps the page
  * and reports on its status line rather than replaying the sheet.
  */
  onRetry: () => Promise<void>;
}

export function bootFailurePage(opts: BootFailureOpts): HTMLElement {
  const { title, detail } = bootFailureCause(opts.error);
  const status = statusLine();
  const retry = el("button", { class: "button", type: "button", text: "Try again" });

  retry.addEventListener("click", () => {
    if (retry.disabled) return;
    status.clear();
    retry.disabled = true;
    retry.textContent = "Trying again…";
    opts.onRetry().then(
      () => {
        retry.disabled = false;
        retry.textContent = "Try again";
      },
      (e: unknown) => {
        retry.disabled = false;
        retry.textContent = "Try again";
        status.error(retryFailureMessage(e));
      },
    );
  });

  return authView(
    el(
      "div",
      { class: "form" },
      el("h1", { class: "title", text: title }),
      el("p", { class: "subtitle", text: detail }),
      retry,
      status.node,
    ),
  );
}
