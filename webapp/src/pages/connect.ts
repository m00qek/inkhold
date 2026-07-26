// Step 3 of first-run onboarding: connect the Supernote. Reached only after the
// mandatory password change (see changePassword.ts). Shows the address to point
// the device at, then waits for real evidence the device arrived — a syncVersion
// bump on the live channel — before offering to open the freshly-synced library.
//
// Two ways forward, both landing in the library: "Open the library" lights up the
// moment the device syncs; "I'll connect it later" is always there for someone
// who will pair the device another time.
//
// Returns a disposer as well as the node: the page holds a live-channel
// subscription (an open SSE connection), and main.ts runs the disposer when the
// route changes so the connection never outlives the screen.

import { el } from "../ui/dom";
import { authView, stepDots } from "../ui/chrome";
import { api } from "../api/client";
import { go } from "../router";
import type { LiveChannel } from "../sync/types";

export interface ConnectPage {
  node: HTMLElement;
  dispose: () => void;
}

/** The address the browser is currently on — the honest fallback when the server
 * can't tell us its own LAN address (or the endpoint isn't there yet). */
function browserAddress(): string {
  return `${window.location.protocol}//${window.location.host}`;
}

export function connectPage(opts: { live: LiveChannel }): ConnectPage {
  const addrCode = el("span", { class: "addr__code", id: "addr", text: browserAddress() });
  const copy = el("button", {
    class: "button button--quiet",
    type: "button",
    text: "Copy",
    onClick: async () => {
      try {
        await navigator.clipboard.writeText(addrCode.textContent ?? "");
      } catch {
        /* clipboard blocked (no permission / insecure context) — the address is
           on screen to copy by hand; a failed copy is not an error worth raising */
      }
      const prev = copy.textContent;
      copy.textContent = "Copied";
      window.setTimeout(() => {
        copy.textContent = prev;
      }, 1400);
    },
  });

  const waitDot = el("span", { class: "wait__dot", "aria-hidden": "true" });
  const waitText = el("span", { id: "wait-text", text: "Waiting for your Supernote to sync…" });
  const wait = el("div", { class: "wait" }, waitDot, waitText);

  const open = el("button", {
    class: "button",
    type: "submit",
    text: "Open the library",
    disabled: true,
  });
  const skip = el("button", {
    class: "skip",
    type: "button",
    text: "I'll connect it later",
    onClick: () => leave(),
  });

  const form = el(
    "form",
    { class: "form" },
    el("h1", { class: "title", text: "Connect your Supernote" }),
    el("p", {
      class: "subtitle",
      text: "On the device, open Private Cloud settings, enter this address, and sign in with the account you just set up.",
    }),
    el("div", { class: "addr" }, addrCode, copy),
    el(
      "p",
      { class: "aside" },
      el("b", { text: "Use this address, not localhost." }),
      " The Supernote reaches this machine across your network — an address meaning “me” on your computer means the tablet itself on the tablet.",
    ),
    wait,
    open,
    skip,
  );
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    leave();
  });

  const view = authView(form);
  view.querySelector(".sheet")?.append(stepDots(3));

  // Prefer the server's own LAN address; fall back to wherever the browser is.
  void api.serverInfo().then((info) => {
    if (info?.address) addrCode.textContent = `${window.location.protocol}//${info.address}`;
  });

  // The step resolves on the device's own evidence: the first syncVersion the
  // channel reports is the baseline (the empty pre-sync state); a later, higher
  // version means a device just synced onto this account while we watched.
  let baseline: number | undefined;
  let done = false;
  const markConnected = () => {
    if (done) return;
    done = true;
    wait.classList.add("is-live");
    waitText.textContent = "Your Supernote connected — your notes are on their way.";
    open.disabled = false;
    open.focus();
  };
  const unsubscribe = opts.live.subscribe((version) => {
    if (baseline === undefined) {
      baseline = version;
      return;
    }
    if (version > baseline) markConnected();
  });

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    unsubscribe();
  };
  function leave(): void {
    dispose();
    go("/");
  }

  return { node: view, dispose };
}
