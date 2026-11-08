// Renders the docs' Mermaid diagrams to SVG, so the site ships no diagram
// script (content/contributor/documentation-rules.md, "Diagrams"), and turns a
// page's screenshots (`![alt](screenshots/name.png)`) into their two-theme
// figures ("Screenshots").
//
//   node tools/diagrams.mjs render <content> <out>   each ```mermaid block → <out>/<hash>-{light,dark}.svg
//   node tools/diagrams.mjs watch  <content> <out>   render, then again on every change (make serve)
//   node tools/diagrams.mjs inline <public> <out>    swap each built block for its two SVGs, and each
//                                                    screenshot for its light and dark files (make build)
//
// A diagram is named by the hash of its source, so an unchanged one is never
// rendered twice and the preview (static/diagrams-preview.js) finds it by the
// same hash. Colours come from the app's tokens, light and dark.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync, watch } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const TOKENS = join(here, "../../webapp/src/styles/00-tokens.css");
const FONTS = join(here, "../../webapp/public/fonts");

/** The name a diagram's files carry: also computed by diagrams-preview.js. */
export const hashOf = (source) => createHash("sha256").update(source.trim()).digest("hex").slice(0, 16);

function* files(dir, ext) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* files(p, ext);
    else if (e.name.endsWith(ext)) yield p;
  }
}

// Bumped when the SVGs themselves change (sizing, theming), so cached ones are redrawn.
const RENDER_VERSION = "4";

/** Mermaid sizes its SVG `width="100%"` with a max-width: no size of its own, so as
 *  an <img> (the preview) it collapses. Give it its drawn size; CSS still shrinks it. */
function sized(svg) {
  const box = svg.match(/viewBox="([\d.\-]+) ([\d.\-]+) ([\d.]+) ([\d.]+)"/);
  if (!box) return svg;
  const [w, h] = [Math.ceil(Number(box[3])), Math.ceil(Number(box[4]))];
  return svg.replace(/^<svg([^>]*?) width="100%"/, `<svg$1 width="${w}" height="${h}"`).replace(/ style="max-width: [\d.]+px;"/, "");
}

const FENCE = /^```mermaid[^\n]*\n([\s\S]*?)^```[ \t]*$/gm;
function sources(contentDir) {
  const found = new Map();
  for (const f of files(contentDir, ".md")) {
    for (const m of readFileSync(f, "utf8").matchAll(FENCE)) found.set(hashOf(m[1]), m[1].trim());
  }
  return found;
}

// ---- colours: the app's tokens, a translucent one laid over the sheet ----

function block(css, selector) {
  const at = css.indexOf(selector);
  if (at < 0) throw new Error(`tokens: no ${selector}`);
  return css.slice(at, css.indexOf("}", at));
}
function vars(text) {
  return Object.fromEntries([...text.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}
function rgb(v) {
  const hex = v.match(/^#([0-9a-f]{6})$/i);
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)).concat(1);
  const fn = v.match(/^rgba?\(([^)]+)\)$/);
  if (fn) {
    const [r, g, b, a = 1] = fn[1].split(",").map(Number);
    return [r, g, b, a];
  }
  throw new Error(`tokens: can't read colour ${v}`);
}
function solid(v, under) {
  const [r, g, b, a] = rgb(v);
  const [R, G, B] = rgb(under);
  const mix = (c, C) => Math.round(c * a + C * (1 - a)).toString(16).padStart(2, "0");
  return `#${mix(r, R)}${mix(g, G)}${mix(b, B)}`;
}
function themes() {
  const css = readFileSync(TOKENS, "utf8");
  const light = vars(block(css, ':root[data-theme="light"] {'));
  const dark = vars(block(css, ':root[data-theme="dark"] {\n  --desk'));
  const theme = (t, darkMode) => {
    const c = (name) => solid(t[name], t.sheet);
    return {
      darkMode,
      // The app is flat: no shadows under the boxes.
      dropShadow: "none",
      background: c("sheet"),
      fontFamily: '"Space Grotesk", sans-serif',
      fontSize: "15px",
      primaryColor: c("sheet"),
      primaryTextColor: c("ink"),
      primaryBorderColor: c("ink-soft"),
      secondaryColor: c("desk"),
      tertiaryColor: c("desk"),
      textColor: c("ink"),
      lineColor: c("ink-soft"),
      mainBkg: c("sheet"),
      nodeBorder: c("ink-soft"),
      clusterBkg: c("desk"),
      clusterBorder: c("line"),
      edgeLabelBackground: c("sheet"),
      actorBkg: c("sheet"),
      actorBorder: c("ink-soft"),
      actorTextColor: c("ink"),
      signalColor: c("ink"),
      signalTextColor: c("ink"),
      labelBoxBkgColor: c("desk"),
      noteBkgColor: c("desk"),
      noteTextColor: c("ink"),
      noteBorderColor: c("line"),
      activationBkgColor: c("desk"),
    };
  };
  return { light: theme(light, false), dark: theme(dark, true) };
}

// ---- render ----

async function render(contentDir, outDir) {
  mkdirSync(outDir, { recursive: true });
  const stamp = join(outDir, ".version");
  if (!existsSync(stamp) || readFileSync(stamp, "utf8") !== RENDER_VERSION) {
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    writeFileSync(stamp, RENDER_VERSION);
  }
  const wanted = sources(contentDir);
  // Diagrams no page holds any more go.
  for (const f of readdirSync(outDir)) {
    if (f !== ".version" && !wanted.has(f.slice(0, 16))) rmSync(join(outDir, f));
  }
  const todo = [...wanted].filter(([h]) => !existsSync(join(outDir, `${h}-light.svg`)) || !existsSync(join(outDir, `${h}-dark.svg`)));
  if (todo.length === 0) return;

  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    // The site's fonts, so labels are measured as they will be drawn.
    const faces = readdirSync(FONTS)
      .filter((f) => f.endsWith(".woff2"))
      .map((f) => {
        const family = f.startsWith("space-mono") ? "Space Mono" : "Space Grotesk";
        const weight = f.match(/-(\d{3})\.woff2$/)[1];
        const data = readFileSync(join(FONTS, f)).toString("base64");
        return `@font-face{font-family:"${family}";font-weight:${weight};src:url(data:font/woff2;base64,${data}) format("woff2")}`;
      })
      .join("\n");
    await page.setContent(`<style>${faces}</style><div id="probe" style="font-family:'Space Grotesk'">x</div>`);
    await page.evaluate(() => document.fonts.ready);
    await page.addScriptTag({ path: require.resolve("mermaid/dist/mermaid.min.js") });
    const t = themes();
    for (const [h, source] of todo) {
      for (const [name, vars] of Object.entries(t)) {
        const svg = await page.evaluate(
          async ({ id, source, vars }) => {
            window.mermaid.initialize({ startOnLoad: false, theme: "base", themeVariables: vars, securityLevel: "strict" });
            const { svg } = await window.mermaid.render(id, source);
            // Mermaid's labels are HTML (`<br>` unclosed): parse and write it back as
            // well-formed XML, or an <img> (the preview) refuses the whole file.
            const holder = document.createElement("div");
            holder.innerHTML = svg;
            return new XMLSerializer().serializeToString(holder.firstElementChild);
          },
          { id: `d${h}${name[0]}`, source, vars },
        );
        writeFileSync(join(outDir, `${h}-${name}.svg`), sized(svg));
      }
      console.log(`diagrams: rendered ${h}`);
    }
  } finally {
    await browser.close();
  }
}

// ---- inline (after `zola build`) ----

const BUILT = /<pre[^>]*>\s*<code[^>]*data-lang="mermaid"[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/g;
// A Markdown image of a screenshot, alone in its paragraph. Zola makes the
// path absolute under the page's own URL; only the name matters here.
const SHOT = /<p>\s*<img src="[^"]*?screenshots\/([\w-]+)\.png" alt="([^"]*)"\s*\/?>\s*<\/p>/g;

/** A PNG's width and height, from its header. */
function pngSize(path) {
  const b = readFileSync(path);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

/** The screenshot figure: both themes, the page's shows one (site.css `.shot`). */
function shotFigure(publicDir, htmlFile, name, alt) {
  const light = join(publicDir, "screenshots", `${name}-light.png`);
  const dark = join(publicDir, "screenshots", `${name}-dark.png`);
  if (!existsSync(light) || !existsSync(dark)) throw new Error(`${htmlFile}: no screenshot ${name} (npm run screenshots in webapp/)`);
  const { w, h } = pngSize(light);
  // Relative to the page, so the site works under any base path.
  const depth = htmlFile.slice(publicDir.length).split("/").filter(Boolean).length - 1;
  const up = "../".repeat(depth);
  const img = (theme) => `<img class="shot__${theme}" src="${up}screenshots/${name}-${theme}.png" alt="${alt}" width="${w}" height="${h}" loading="lazy" decoding="async">`;
  return `<figure class="shot${h > w ? " shot--phone" : ""}">${img("light")}${img("dark")}</figure>`;
}
const unescape = (s) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'").replace(/&amp;/g, "&");

function inline(publicDir, outDir) {
  let n = 0;
  for (const f of files(publicDir, ".html")) {
    const html = readFileSync(f, "utf8");
    let shots = 0;
    const out = html
      .replace(BUILT, (_, code) => {
        const h = hashOf(unescape(code));
        const read = (name) => readFileSync(join(outDir, `${h}-${name}.svg`), "utf8");
        n++;
        return `<figure class="diagram"><div class="diagram__light">${read("light")}</div><div class="diagram__dark">${read("dark")}</div></figure>`;
      })
      .replace(SHOT, (_, name, alt) => {
        shots++;
        return shotFigure(publicDir, f, name, alt);
      });
    if (shots) console.log(`screenshots: ${shots} in ${f.slice(publicDir.length)}`);
    if (out !== html) writeFileSync(f, out);
  }
  // The built pages carry them inline; the files are only for the preview.
  rmSync(join(publicDir, "diagrams"), { recursive: true, force: true });
  if (n) console.log(`diagrams: inlined ${n}`);
}

const [cmd, a, b] = process.argv.slice(2);
if (cmd === "render") await render(a, b);
else if (cmd === "inline") inline(a, b);
else if (cmd === "watch") {
  let timer = null;
  let running = Promise.resolve();
  watch(a, { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      running = running.then(() => render(a, b)).catch((e) => console.error(`diagrams: ${e.message}`));
    }, 200);
  });
} else {
  console.error("usage: diagrams.mjs render|watch <content> <out> | inline <public> <out>");
  process.exit(2);
}
