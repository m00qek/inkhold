// The installable app's page side: registers the service worker (`sw/sw.js`,
// written into the build by `vite.config.ts`), offers a new version when one
// is waiting, and forgets the stored listings on sign-out.
//
// Production builds only: in dev a worker would serve stale modules.

import { el } from "../ui/dom";

const LISTINGS = "inkhold-listings";

export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  const sw = navigator.serviceWorker;
  let tookOver = false;
  sw.addEventListener("controllerchange", () => {
    if (tookOver) return;
    // First install: this page loaded before the worker was there, so who is
    // signed in and the top of the library were never stored. Ask again
    // through it, so the app can open offline from now on.
    for (const path of ["/api/user/me", "/api/controlplane/tree"]) fetch(path, { credentials: "same-origin" }).catch(() => {});
  });
  sw.register("./sw.js").then(
    (reg) => {
      const offer = (worker: ServiceWorker) =>
        offerUpdate(() => {
          tookOver = true;
          // Reload once the new version is fully in charge: a reload while it
          // is still activating waits on it, and the page can stall.
          worker.addEventListener("statechange", () => {
            if (worker.state === "activated") location.reload();
          });
          worker.postMessage({ type: "take-over" });
        });
      // A controller means this is an update, not the first install.
      if (reg.waiting && sw.controller) offer(reg.waiting);
      reg.addEventListener("updatefound", () => {
        const worker = reg.installing;
        worker?.addEventListener("statechange", () => {
          if (worker.state === "installed" && sw.controller) offer(worker);
        });
      });
      // An installed app can stay open for days: look again on coming back.
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") reg.update().catch(() => {});
      });
    },
    (e) => console.warn("Service worker not registered", e),
  );
}

/** Signing out (or a session ending) leaves no listing of the account behind. */
export function forgetListings(): void {
  if (typeof caches === "undefined") return;
  caches.delete(LISTINGS).catch(() => {});
}

let offered = false;
/** The recycle bin's toast, with Reload: the new version waits until then. */
function offerUpdate(reload: () => void): void {
  if (offered) return;
  offered = true;
  const action = el("button", { class: "bin-toast__action", type: "button", text: "Reload" });
  const bar = el(
    "div",
    { class: "bin-toast" },
    el("span", { class: "bin-toast__lines", role: "status" }, el("span", { class: "bin-toast__msg", text: "A new version of Inkhold is ready." })),
    action,
  );
  action.addEventListener("click", () => {
    action.disabled = true;
    reload();
  });
  document.body.append(bar);
  void bar.offsetWidth; // so it slides in rather than appearing
  bar.classList.add("is-shown");
}
