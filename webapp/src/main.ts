// App bootstrap: routing, the auth guard (`api.me()`, since the HttpOnly
// cookie is invisible to JS), and the one place the dependency graph is wired.

import { onRoute, go, current, type Route } from "./router";
import { mount } from "./ui/dom";
import { applyStoredTheme } from "./ui/theme";
import { readLocal, writeLocal } from "./ui/storage";
import { api as authApi, createHttpApi, dispatchApiFailure, type Me } from "./api/client";
import { session } from "./session";
import { loginPage } from "./pages/login";
import { bootFailurePage } from "./pages/bootFailure";
import { changePasswordPage } from "./pages/changePassword";
import { connectPage } from "./pages/connect";
import { createAppShell, type AppShell } from "./pages/library/library";
import { createWasmRenderer } from "./render/wasm";
import { createTemplateProvider } from "./render/template";
import { createRenderCache } from "./cache/renderCache";
import { openThumbStore } from "./cache/idb";
import { createLiveChannel } from "./sync/live";
import type { Api } from "./api/types";
import type { NoteRenderer } from "./render/types";
import type { LiveChannel } from "./sync/types";

// Re-apply the pinned theme (index.html already did, pre-paint) before the
// shell exists: render cache keys include the theme.
applyStoredTheme();

const app = document.getElementById("app");
if (!app) throw new Error("missing #app mount point");
const root = app;

// --- dependency graph: the one place fakes swap for the real stack ---
// Dev and e2e default to fakes (no backend or wasm needed). `?real`/`?fake`
// override, before or after the `#`, and stick in localStorage.
function useFakes(): boolean {
  const search = new URLSearchParams(location.search);
  const hashQuery = new URLSearchParams(location.hash.split("?")[1] ?? "");
  const has = (k: string): boolean => search.has(k) || hashQuery.has(k);
  const flag = has("fake") ? "fake" : has("real") ? "real" : null;
  if (flag) {
    writeLocal("sn.mode", flag);
    return flag === "fake";
  }
  // readLocal: a raw localStorage read throws in private mode.
  const stored = readLocal("sn.mode");
  if (stored) return stored === "fake";
  return import.meta.env.DEV;
}

const fakes = useFakes();
// Fakes are dynamically imported so Vite keeps them out of the production
// chunk; hence the top-level await before `onRoute` registers.
const dataApi: Api = fakes ? (await import("./api/fake")).createFakeApi() : createHttpApi();
const renderer: NoteRenderer = fakes
  ? (await import("./render/fake")).createFakeRenderer()
  : createWasmRenderer({ getTemplate: createTemplateProvider(dataApi) });
const live: LiveChannel = fakes ? { subscribe: () => () => {} } : createLiveChannel();
// One thumbnail store shared by the render cache and the thumbnail facade: a
// second `openThumbStore()` would open a second IDB connection.
const thumbStore = openThumbStore();
const cache = createRenderCache({ persistent: thumbStore });

// --- app shell lifecycle ---
let shell: AppShell | null = null;
let profile: Me | null = null;
// Teardown for a pre-auth page holding resources (connect's live
// subscription); run on every route change.
let disposePage: (() => void) | null = null;

function onSignOut(): void {
  const finish = () => {
    session.clear();
    go("/login");
  };
  authApi.logout().then(finish, finish);
}

/**
 * The session cookie expired (an API call came back 401/403). Like sign-out
 * minus `logout()`; the login route tears down the shell.
 */
function onSessionExpired(): void {
  session.clear();
  go("/login");
}

function ensureShell(email: string, isAdmin: boolean): AppShell {
  if (!shell) {
    shell = createAppShell({
      api: dataApi,
      renderer,
      cache,
      persistentThumbs: thumbStore,
      live,
      identity: { email, isAdmin },
      onSignOut,
      onSessionExpired,
    });
  }
  return shell;
}

function teardownShell(): void {
  shell?.destroy();
  shell = null;
  profile = null;
}

/** Resolve the signed-in profile, redirecting to login/change-password as needed;
 * null when it has navigated away. */
async function ensureProfile(): Promise<Me | null> {
  if (profile) return profile;
  const me = await authApi.me();
  if (!me) {
    go("/login");
    return null;
  }
  session.markSignedIn();
  if (me.mustChangePassword) {
    go("/change-password");
    return null;
  }
  profile = me;
  return me;
}

async function renderRoute(route: Route): Promise<void> {
  disposePage?.();
  disposePage = null;

  switch (route.name) {
    case "login":
      teardownShell();
      mount(root, loginPage());
      return;
    case "change-password":
      teardownShell();
      mount(root, changePasswordPage());
      return;
    case "connect": {
      // Same guard as the app.
      const me = await ensureProfile();
      if (!me) return;
      // Never keep the shell and connect alive together (reachable via Back).
      teardownShell();
      const page = connectPage({ live });
      disposePage = page.dispose;
      mount(root, page.node);
      return;
    }
    // Every in-app place shares one guarded arm, so a new place can't skip it.
    case "library":
    case "folder":
    case "search":
    case "destination":
    case "account":
    case "note":
    case "note-version":
    case "bin-note": {
      const me = await ensureProfile();
      if (!me) return; // redirected to login / change-password
      const shellInstance = ensureShell(me.email ?? "", me.isAdmin);
      mount(root, shellInstance.el);
      // The shell reacts to the route; it does not decide.
      switch (route.name) {
        case "note":
          await shellInstance.openNote(route.id, route.page, route.q);
          return;
        case "note-version":
          await shellInstance.openNoteVersion(route.id, route.short, route.page);
          return;
        case "bin-note":
          await shellInstance.openBinNote(route.id, route.page);
          return;
        case "folder":
          shellInstance.showFolder(route.id);
          return;
        case "search":
          shellInstance.showSearch(route.q);
          return;
        case "destination":
          shellInstance.showDestination(route.key);
          return;
        case "account":
          shellInstance.showAccount();
          return;
        default:
          shellInstance.showFolder(null);
          return;
      }
    }
  }
}

/**
 * Render a failed route as such. 401/403 goes through `dispatchApiFailure`
 * to login; anything else is a server with no usable answer. The shell is
 * kept so a retry doesn't reload everything.
 */
function showRouteFailure(error: unknown, route: Route): void {
  if (dispatchApiFailure({ onSessionExpired }, error)) return;
  console.error("route failed", route.name, error);
  mount(root, bootFailurePage({ error, onRetry: () => renderRoute(route) }));
}

onRoute(renderRoute, showRouteFailure);

// Backstop for stray rejections, acting only when nothing is mounted (the
// blank-page case). Not the fix: `tests/e2e/boot.spec.ts` has a case only the
// `onRoute` seam can satisfy.
window.addEventListener("unhandledrejection", (e) => {
  if (root.childElementCount > 0) return;
  showRouteFailure(e.reason, current());
});
