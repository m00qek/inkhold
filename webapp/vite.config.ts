import { defineConfig } from "vite";

// The built SPA is served as static assets by the Zig server from the same
// origin as the API, so we use relative asset paths and route via the URL hash
// (no server-side SPA fallback needed). In dev, `/api` is proxied to the local
// Zig server — override the target with VITE_API_TARGET if it runs elsewhere.
const apiTarget = process.env.VITE_API_TARGET ?? "http://127.0.0.1:8089";

export default defineConfig({
  base: "./",
  server: {
    port: 5180,
    proxy: {
      // Auth + control-plane JSON + SSE (`/api/controlplane/tree`, `/api/controlplane/note`, `/api/controlplane/events`).
      "/api": {
        target: apiTarget,
        changeOrigin: true,
        // The dev backend is plaintext; allow self-signed if you enable TLS.
        secure: false,
      },
      // Immutable per-page byte payloads (`GET /note/{id}/page/{n}?v=`). The `^`
      // makes this a RegExp with a trailing slash, so it proxies `/note/123/page/0`
      // to the backend but NOT the `/note-decode.wasm` public asset Vite serves.
      "^/note/": {
        target: apiTarget,
        changeOrigin: true,
        secure: false,
      },
    },
  },
  build: {
    outDir: "dist",
    target: "es2022",
    sourcemap: true,
  },
});
