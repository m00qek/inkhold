// App bootstrap: hash routing + a light auth guard, and THE one place the whole
// dependency graph is wired. Login and change-password are always reachable; the
// library/reader are guarded — we resolve the session profile via `api.me()`
// (the HttpOnly cookie is invisible to JS) before building the app shell.
//
// In dev + e2e the browse/render/live seams are the fakes; P4 swaps `dataApi` for
// the real HTTP `Api`, P5 swaps `renderer` for the WASM decoder, and P4 also swaps
// `live` for the SSE `createLiveChannel` — each is a one-line change right here.

import { onRoute, go } from "./router";
import { mount } from "./ui/dom";
import { applyStoredTheme } from "./ui/theme";
import { readLocal, writeLocal } from "./ui/storage";
import { api as authApi, createHttpApi, type Me } from "./api/client";
import { session } from "./session";
import { loginPage } from "./pages/login";
import { changePasswordPage } from "./pages/changePassword";
import { connectPage } from "./pages/connect";
import { createAppShell, type AppShell } from "./pages/library";
import { createWasmRenderer } from "./render/wasm";
import { createTemplateProvider } from "./render/template";
import { createRenderCache } from "./cache/renderCache";
import { openThumbStore } from "./cache/idb";
import { createLiveChannel } from "./sync/live";
import type { Api } from "./api/types";
import type { NoteRenderer } from "./render/types";
import type { LiveChannel } from "./sync/types";

// Re-apply the pinned theme. index.html already did this inline before first
// paint (that's what avoids the flash); this is the belt-and-braces copy for any
// host page without that snippet. Idempotent, and it must run before the shell is
// built so every render is keyed to the right theme from the very first paint —
// the render cache is keyed by {hash, size, theme}, so a late flip would leave
// off-theme bitmaps on screen.
applyStoredTheme();

const app = document.getElementById("app");
if (!app) throw new Error("missing #app mount point");
const root = app;

// --- the dependency graph — THE one place fakes swap for the real stack ------
// The shipped app talks to the real control-plane `Api`, the WASM decoder, and the SSE
// live channel. Dev + e2e default to the fakes so `npm run dev`/`npm test` need
// no backend or wasm build; `?real` forces the real stack in dev (against a
// proxied backend), and `?fake` forces the fakes in a production build.
// The flag is accepted whether it lands before or after the `#` (hash routing
// otherwise makes `?real` easy to lose), and the choice is remembered in
// localStorage so it survives reloads/navigation that drop the query string.
function useFakes(): boolean {
  const search = new URLSearchParams(location.search);
  const hashQuery = new URLSearchParams(location.hash.split("?")[1] ?? "");
  const has = (k: string): boolean => search.has(k) || hashQuery.has(k);
  const flag = has("fake") ? "fake" : has("real") ? "real" : null;
  if (flag) {
    writeLocal("sn.mode", flag);
    return flag === "fake";
  }
  // Via readLocal, not localStorage directly: this runs at module scope, and a
  // raw read throws outright in private mode — which would take boot down here.
  const stored = readLocal("sn.mode");
  if (stored) return stored === "fake";
  return import.meta.env.DEV;
}

const fakes = useFakes();
// The fakes are DYNAMICALLY imported, and only in the fakes branch, so Vite
// splits `./api/fake` + `./render/fake` (~1,700 lines) into their own lazy
// chunk instead of bundling them into the production entry the real stack ships.
// Prod never takes this branch, so it never fetches that chunk. The `import()`
// makes wiring async — hence the top-level `await` here (ES2022 module target),
// which blocks boot until `dataApi`/`renderer` exist, before `onRoute` registers.
const dataApi: Api = fakes ? (await import("./api/fake")).createFakeApi() : createHttpApi();
const renderer: NoteRenderer = fakes
  ? (await import("./render/fake")).createFakeRenderer()
  : createWasmRenderer({ getTemplate: createTemplateProvider(dataApi) });
const live: LiveChannel = fakes ? { subscribe: () => () => {} } : createLiveChannel();
// ONE persistent thumbnail store (`sn-thumbs`), opened here and SHARED by both the
// render cache (note-page renders) and the thumbnail facade (`.spd`/`.txt`/cover/
// image tiles). Opened exactly once — a second `openThumbStore()` would be a
// second IDB connection to the same database — so every thumbnail lives in one
// store, under one byte budget, with one lifetime that survives reloads uniformly.
const thumbStore = openThumbStore();
const cache = createRenderCache({ persistent: thumbStore });

// --- app shell lifecycle ---------------------------------------------------
let shell: AppShell | null = null;
let profile: Me | null = null;
// A teardown for the current pre-auth page, when it holds resources that must not
// outlive the screen (the connect step's live-channel subscription). Run on every
// route change before the next page mounts, so leaving by ANY means — a button, a
// redirect, the Back button — closes it.
let disposePage: (() => void) | null = null;

function onSignOut(): void {
  const finish = () => {
    session.clear();
    go("/login");
  };
  authApi.logout().then(finish, finish);
}

/**
 * The `sn_session` cookie expired while the shell was open — the shell told us so
 * after an API call came back 401/403. Same landing as sign-out (clear the auth
 * hint, route to login), and the same teardown: `go("/login")` fires the login
 * route, whose handler calls `teardownShell()`, so no stale listing/reader state
 * survives into the next sign-in. Unlike sign-out there's no `logout()` call — the
 * session the server would revoke is already gone.
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

/** Resolve the signed-in profile, redirecting to login/change-password as needed.
 * Returns null when it has already navigated away. */
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

onRoute(async (route) => {
  // Close the previous page's resources (see `disposePage`) before anything else.
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
      // The connect step is behind the same guard as the app: only a fully
      // signed-in user (past the mandatory password change) reaches it, and
      // `ensureProfile` sends everyone else back to login/change-password.
      const me = await ensureProfile();
      if (!me) return;
      // Like the other pre-auth arms: tear down any shell so it and the connect
      // screen are never both alive (reachable via Back after "Open the library").
      teardownShell();
      const page = connectPage({ live });
      disposePage = page.dispose;
      mount(root, page.node);
      return;
    }
    // EVERY PLACE INSIDE THE APP, and the auth guard is in front of all of them
    // at once. Routing more places must not open a path around it, so the guard
    // stays on the shared arm rather than being repeated per destination: a new
    // `case` added below without a matching `ensureProfile()` would be a signed
    // -out screen, and there is no `case` to add.
    case "library":
    case "folder":
    case "search":
    case "destination":
    case "note":
    case "note-version":
    case "bin-note": {
      const me = await ensureProfile();
      if (!me) return; // redirected to login / change-password
      const shellInstance = ensureShell(me.email ?? "", me.isAdmin);
      mount(root, shellInstance.el);
      // THE SHELL REACTS; IT DOES NOT DECIDE. Which folder is listed, which
      // destination is up, what is in the search box and where the reader is
      // open all come off the route — so a reload, a copied link and a
      // re-dispatch land on exactly the same screen, and Back means the same
      // thing wherever you are.
      switch (route.name) {
        case "note":
          await shellInstance.openNote(route.id, route.page, route.q);
          return;
        case "note-version":
          // The version deep link resolves client-side (past → preview, current →
          // canonicalise to the live note, none → live note + notice). See
          // `AppShell.openNoteVersion`.
          await shellInstance.openNoteVersion(route.id, route.short, route.page);
          return;
        case "bin-note":
          // The recycle-bin deep link: ensure the bin listing is loaded, find the
          // trashed file and open it with a `bin` origin at `route.page`; a file no
          // longer in the bin falls back to the listing + a notice. See
          // `AppShell.openBinNote`.
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
        default:
          shellInstance.showFolder(null);
          return;
      }
    }
  }
});
