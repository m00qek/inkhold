// Inkhold's service worker. It keeps two things on the device:
//
// - the app itself (this build's HTML, scripts, styles, fonts, icons), so the
//   app opens with no network; the list is written in at build time
//   (`vite.config.ts`, `inkholdServiceWorker`);
// - the listings a person finds their way with: who is signed in, the folder
//   tree, each folder's entries, the bin, storage use. Each is fetched from the
//   network first and the stored copy is used only when the network fails.
//
// Never the files: a note's pages, a PDF, an image, a transcript, a to-do
// list. Opening those needs the network (docs/content/contributor/phones-rules.md).
//
// A new build installs beside the old one and WAITS: the page offers a
// reload, and only then does the new one take over (`pwa/register.ts`).

const VERSION = "__INKHOLD_VERSION__";
const SHELL = `inkhold-shell-${VERSION}`;
const LISTINGS = "inkhold-listings";
const PRECACHE = __INKHOLD_PRECACHE__;

// GETs whose answer lets someone browse. Anything else passes through.
const LISTING = [
  /^\/api\/user\/me$/,
  /^\/api\/controlplane\/tree$/,
  /^\/api\/controlplane\/bin$/,
  /^\/api\/controlplane\/usage$/,
];
// Not `server-info`: the sign-in page reads it, so storing it would put a
// listing back right after a sign-out cleared them.

const scopeUrl = new URL(self.registration.scope);
const shellUrls = new Set(PRECACHE.map((p) => new URL(p, scopeUrl).href));
const INDEX = new URL("./", scopeUrl).href;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll([...shellUrls])));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key.startsWith("inkhold-shell-") && key !== SHELL) await caches.delete(key);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  const kind = event.data && event.data.type;
  if (kind === "take-over") self.skipWaiting();
  // Signing out leaves nothing of the account behind.
  if (kind === "forget-listings") event.waitUntil(caches.delete(LISTINGS));
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== scopeUrl.origin) return;

  if (req.mode === "navigate") {
    event.respondWith(fetch(req).catch(() => caches.match(INDEX, { cacheName: SHELL, ignoreVary: true }).then((r) => r || Response.error())));
    return;
  }
  if (LISTING.some((re) => re.test(url.pathname))) {
    event.respondWith(listing(req));
    return;
  }
  const bare = url.origin + url.pathname;
  if (shellUrls.has(bare) && url.search === "") {
    // `ignoreVary`: a module script asks with an `Origin` the install did not
    // send, and a `Vary: Origin` answer would otherwise never match.
    event.respondWith(caches.match(req, { cacheName: SHELL, ignoreVary: true }).then((r) => r || fetch(req)));
  }
});

/** Network first; the stored copy only when there is no network. */
async function listing(req) {
  let res;
  try {
    res = await fetch(req);
  } catch {
    // `caches.match`, not `caches.open(...).match`: opening would create the
    // store again right after a sign-out deleted it.
    return (await caches.match(req, { cacheName: LISTINGS, ignoreVary: true })) || Response.error();
  }
  if (res.ok) {
    await (await caches.open(LISTINGS)).put(req, res.clone());
  } else if (res.status === 401 || res.status === 403) {
    // Signed out elsewhere or expired: what was stored is no longer theirs to see.
    await caches.delete(LISTINGS);
  }
  return res;
}
