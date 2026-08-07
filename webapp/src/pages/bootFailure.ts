// THE APP COULD NOT START.
//
// Every route arm in main.ts is async, and every one of them can reject — the
// auth guard's `api.me()` most of all, because it is the FIRST request the app
// makes and the only one that runs while `#app` is still empty. That rejection
// used to be a discarded promise: no catch on the arm, no global handler, and
// nothing mounted. The result was a permanently blank page — the degenerate
// case of the failure class audits, where
// a screen that has no data claims something anyway. Claiming *nothing at all*
// is the worst version of it: no explanation, and no way forward.
//
// This is the state that replaces it. It is dressed as a pre-auth sheet because
// that is what the app looks like before the shell exists, and it carries the
// two things worth carrying: WHICH failure this is, and the one action that can
// change it.
//
// IT IS NOT THE SIGNED-OUT SCREEN, and keeping those apart is the point. "No
// session" already has a landing — `api.me()` answers null for 401/403 and the
// guard routes to `#/login`. Sending someone there because the server is merely
// off would ask them to type a password into a form that cannot check it, and
// would blame them for a machine being down. Only errors that got no usable
// answer out of the server reach this page.

import { el } from "../ui/dom";
import { authView } from "../ui/chrome";
import { statusLine } from "../ui/form";
import { ApiError } from "../api/client";

/** The headline + explanation for one cause. The two are written together
 *  because the explanation is what makes the headline non-generic. */
interface Cause {
  title: string;
  detail: string;
}

/**
 * Name the failure, in the app's register: say what happened, do not apologise,
 * and do not guess at a cause the error does not support.
 *
 * The NETWORK copy answers the question the situation actually raises — "this
 * page came from that server, so how can it be unreachable?" — because leaving
 * it unanswered reads as the app being confused rather than the server being
 * down. Exported for the unit test, which pins the two cases apart.
 */
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
    // A real answer that we could not use (a 5xx, an unreadable envelope). The
    // client already phrased it once; re-phrasing it here would drift.
    return { title: "The server couldn't answer", detail: e.message };
  }
  return {
    title: "The app couldn't start",
    detail: "Something went wrong before the library was on screen.",
  };
}

/** What a FAILED retry says on the line under the button. Short, because the
 *  full explanation is still on screen directly above it. */
function retryFailureMessage(e: unknown): string {
  if (e instanceof ApiError && e.code === "NETWORK") return "Still can't reach the server.";
  if (e instanceof ApiError && e.code === "TIMEOUT") return "Still no answer from the server.";
  if (e instanceof ApiError) return e.message;
  return "Still failing. Try again in a moment.";
}

export interface BootFailureOpts {
  /** What the route arm rejected with — it chooses the copy. */
  error: unknown;
  /**
   * Run the route again. Resolving means the route mounted something else and
   * this page is already gone; rejecting leaves the page up and reports why on
   * its status line, rather than replaying the whole sheet (and its entry
   * animation) to say the same thing a second time.
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
        // A success has replaced this node; restoring the label only matters for
        // the case where the route resolved without navigating away.
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
