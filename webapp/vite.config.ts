import { defineConfig } from "vite";

// Same-origin static assets with hash routing, so relative paths and no SPA
// fallback. Dev proxies to the local Zig server (override with VITE_API_TARGET).
const apiTarget = process.env.VITE_API_TARGET ?? "http://127.0.0.1:8089";

export default defineConfig({
  base: "./",
  server: {
    port: 5180,
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: true,
        secure: false,
      },
      // Page bytes (`/note/{id}/page/{n}`); the trailing slash keeps the
      // `/note-decode.wasm` public asset local.
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
