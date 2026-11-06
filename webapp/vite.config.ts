import { defineConfig, type Plugin } from "vite";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Writes `sw.js` into the build: `sw/sw.js` with this build's files filled in
 * (every bundle file but source maps and the test fakes, and every public file
 * but the wasm decoders, which only reading needs) and a version that changes
 * whenever any of them does. Build only: in dev a worker would hold stale
 * modules.
 */
function inkholdServiceWorker(): Plugin {
  let publicDir = "";
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
  return {
    name: "inkhold-service-worker",
    apply: "build",
    configResolved(c) {
      publicDir = c.publicDir;
    },
    generateBundle(_opts, bundle) {
      const hash = createHash("sha256");
      const fromBundle = Object.keys(bundle).filter((f) => !f.endsWith(".map") && !/(^|\/)fake/i.test(f));
      for (const f of fromBundle.sort()) hash.update(f);
      const fromPublic = publicDir
        ? walk(publicDir)
            .filter((p) => !p.endsWith(".wasm"))
            .map((p) => {
              hash.update(readFileSync(p));
              return relative(publicDir, p).split("\\").join("/");
            })
        : [];
      const files = ["./", ...fromBundle.filter((f) => f !== "index.html"), ...fromPublic].sort();
      const template = readFileSync(new URL("./sw/sw.js", import.meta.url), "utf8");
      // The worker's own code is part of the version too.
      hash.update(template);
      const source = template
        .replace("__INKHOLD_VERSION__", hash.digest("hex").slice(0, 16))
        .replace("__INKHOLD_PRECACHE__", JSON.stringify(files, null, 2));
      this.emitFile({ type: "asset", fileName: "sw.js", source });
    },
  };
}

// Same-origin static assets with hash routing, so relative paths and no SPA
// fallback. Dev proxies to the local Zig server (override with VITE_API_TARGET).
const apiTarget = process.env.VITE_API_TARGET ?? "http://127.0.0.1:8089";

export default defineConfig({
  base: "./",
  plugins: [inkholdServiceWorker()],
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
