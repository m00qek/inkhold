import { defineConfig, type Plugin } from "vite";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fakeFileHash } from "./src/api/fakeHash";
import { DatabaseSync } from "node:sqlite";

/**
 * Writes `sw.js` into the build: `sw/sw.js` with this build's files filled in
 * (every bundle file but source maps and the test fakes, and every public file
 * but the wasm, which only reading needs (`note-decode`, `pdf-decode`), all
 * except `sqlite-core.wasm`, search's and the `.spd` viewer's, kept so search
 * answers offline) and a version that changes whenever any of them does. Build only: in dev a worker would hold stale
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
            .filter((p) => !p.endsWith(".wasm") || p.endsWith("sqlite-core.wasm"))
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

/**
 * `npm run demo` only: answer `/file/:id` (a file's raw bytes) for the fake
 * library's `.txt`, `.spd` and `.pdf` entries with committed fixtures, so
 * their viewers show real content instead of this page's own HTML, and
 * `/thumbnail/:hash` for the sketches' cards.
 */
function demoFiles(): Plugin {
  const at = (rel: string) => new URL(rel, import.meta.url);
  const txt = { path: at("./tests/fixtures/demo/readme.txt"), type: "text/plain; charset=utf-8" };
  const spd = { path: at("../parsers/spd/tests/fixtures/layers_hidden.spd"), type: "application/octet-stream" };
  const pdf = { path: at("./wasm/tests/fixtures/two-page.pdf"), type: "application/pdf" };
  const grammar = { path: at("./tests/fixtures/demo/deutsch-lernen.pdf"), type: "application/pdf" };
  // Ids from `src/api/fakeFixtures.ts`, and the German grammar sheet's from `src/api/demoNotes.ts`.
  const files: Record<string, { path: URL; type: string }> = {
    "142": pdf,
    "193": grammar,
    "174": spd,
    "175": spd,
    "176": spd,
    "177": txt,
    "178": pdf,
  };
  // A sketch's library card shows the preview the server pulls from the file
  // (the JPEG in its `config` table), keyed by the file's hash. Only for the
  // 3:4 Kitchen sketch: cropped to the panorama's or the receipt's extreme
  // shape, the same picture would be a blank strip.
  const sketchHashes = new Set([fakeFileHash("174")]);
  let thumbBytes: Uint8Array | null = null;
  const sketchThumb = (): Uint8Array => {
    if (thumbBytes) return thumbBytes;
    // From a copy: the fixture is a WAL database, and opening it in place
    // leaves `-shm`/`-wal` files beside the committed one.
    const dir = mkdtempSync(join(tmpdir(), "inkhold-demo-"));
    const copy = join(dir, "sketch.spd");
    copyFileSync(spd.path, copy);
    try {
      const db = new DatabaseSync(copy, { readOnly: true });
      const row = db.prepare("SELECT CAST(value AS BLOB) AS v FROM config WHERE name = 'thumbnail'").get() as { v: Uint8Array };
      db.close();
      return (thumbBytes = row.v);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  return {
    name: "inkhold-demo-files",
    apply: () => process.env.VITE_DEMO === "1",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const thumb = /^\/thumbnail\/([^/?]+)/.exec(req.url ?? "");
        if (thumb && sketchHashes.has(decodeURIComponent(thumb[1]!))) {
          res.setHeader("content-type", "image/jpeg");
          res.end(sketchThumb());
          return;
        }
        const m = /^\/file\/([^/?]+)/.exec(req.url ?? "");
        const f = m ? files[decodeURIComponent(m[1]!)] : undefined;
        if (!f) return next();
        const download = /[?&]download=1/.test(req.url ?? "");
        res.setHeader("content-type", download ? "application/octet-stream" : f.type);
        res.setHeader("x-content-type-options", "nosniff");
        if (download) res.setHeader("content-disposition", "attachment");
        res.end(readFileSync(f.path));
      });
    },
  };
}

/**
 * Any dev server (the demo, the e2e and screenshot runs): `/demo-notes/` serves
 * the demo notebooks' page payloads and text (`src/api/demoNotes.ts`). Never in
 * a build: the Pi serves no demo data.
 */
function demoNotes(): Plugin {
  const root = new URL("./demo/notes/", import.meta.url).pathname;
  return {
    name: "inkhold-demo-notes",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = /^\/demo-notes\/([a-z]+)\/(page-\d+\.(?:snpg|text\.json))(?:\?|$)/.exec(req.url ?? "");
        if (!m) return next();
        const path = join(root, m[1]!, m[2]!);
        if (!existsSync(path)) return next();
        res.setHeader("content-type", m[2]!.endsWith(".json") ? "application/json" : "application/octet-stream");
        res.end(readFileSync(path));
      });
    },
  };
}

// Same-origin static assets with hash routing, so relative paths and no SPA
// fallback. Dev proxies to the local Zig server (override with VITE_API_TARGET).
const apiTarget = process.env.VITE_API_TARGET ?? "http://127.0.0.1:8089";

export default defineConfig({
  base: "./",
  plugins: [inkholdServiceWorker(), demoFiles(), demoNotes()],
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
