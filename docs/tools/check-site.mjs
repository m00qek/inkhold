// Checks a built site against the quality bar in
// content/contributor/documentation-rules.md ("The quality bar"):
//
//   node tools/check-site.mjs <built-site> <port>
//
// Every page, at 320, 390, 768 and 1440 px wide, light and dark. Exits 1 with
// the failures listed. The site must have been built with
// --base-url http://127.0.0.1:<port> (make test does).

import { createServer } from "node:http";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { chromium } from "playwright-core";
import AxeBuilder from "@axe-core/playwright";

const [dir, port = "1112"] = process.argv.slice(2);
const BASE = `http://127.0.0.1:${port}`;
const WIDTHS = [320, 390, 768, 1440];
const PHONE = 700; // below it, targets are thumb-sized
const SCREEN_H = 900;

const TYPES = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".xml": "application/xml", ".txt": "text/plain" };
const server = createServer((req, res) => {
  let path = join(dir, decodeURIComponent(new URL(req.url, BASE).pathname));
  if (existsSync(path) && statSync(path).isDirectory()) path = join(path, "index.html");
  if (!existsSync(path)) {
    res.writeHead(404, { "content-type": "text/html" });
    return res.end(readFileSync(join(dir, "404.html")));
  }
  res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" });
  res.end(readFileSync(path));
}).listen(Number(port), "127.0.0.1");

function* pages(d, rel = "") {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (e.isDirectory()) yield* pages(join(d, e.name), `${rel}${e.name}/`);
    else if (e.name === "index.html") yield `/${rel}`;
  }
}

const failures = [];
const fail = (where, what) => failures.push(`${where}: ${what}`);

const browser = await chromium.launch();
try {
  const urls = [...pages(dir)].sort();
  for (const width of WIDTHS) {
    for (const scheme of ["light", "dark"]) {
      const phone = width < PHONE;
      const ctx = await browser.newContext({ viewport: { width, height: SCREEN_H }, colorScheme: scheme, isMobile: phone, hasTouch: phone });
      for (const url of urls) {
        const where = `${url} @${width} ${scheme}`;
        const page = await ctx.newPage();
        page.on("pageerror", (e) => fail(where, `script error: ${e.message}`));
        await page.goto(BASE + url);

        const m = await page.evaluate((minTarget) => {
          const out = {};
          out.sideways = document.documentElement.scrollWidth > innerWidth;
          // Navigation targets (inline links in running text are exempt).
          out.small = [...document.querySelectorAll(".masthead a, .theme, .search input, .toc a, .onthis a, .row, .pager a, .colophon a")]
            .filter((e) => e.checkVisibility())
            .map((e) => [e, e.getBoundingClientRect()])
            .filter(([, r]) => r.height < minTarget || r.width < 24)
            .map(([e, r]) => `"${(e.textContent.trim() || e.getAttribute("aria-label")).slice(0, 30)}" ${Math.round(r.width)}×${Math.round(r.height)}`);
          // Running text: its size, and characters per line on paragraphs that wrap.
          const paras = [...document.querySelectorAll(".prose > p:not([class]), .prose li > p, .prose > ul > li")];
          out.smallText = paras.map((p) => parseFloat(getComputedStyle(p).fontSize)).filter((s) => s < 16).length;
          const ctx2d = document.createElement("canvas").getContext("2d");
          const perLine = [];
          for (const p of document.querySelectorAll(".prose > p:not([class])")) {
            const cs = getComputedStyle(p);
            ctx2d.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
            const text = p.textContent.replace(/\s+/g, " ").trim();
            const lines = ctx2d.measureText(text).width / p.clientWidth;
            if (lines >= 2) perLine.push(text.length / lines);
          }
          out.perLine = perLine.length ? Math.round(perLine.reduce((a, b) => a + b) / perLine.length) : null;
          out.height = document.documentElement.scrollHeight;
          out.index = !!document.querySelector(".prose--index");
          return out;
        }, width < PHONE ? 44 : 24);

        if (m.sideways) fail(where, "scrolls sideways");
        if (m.small.length) fail(where, `targets under ${width < PHONE ? 44 : 24}px: ${m.small.slice(0, 4).join(", ")}`);
        if (m.smallText) fail(where, `${m.smallText} paragraphs under 16px`);
        if (width === 1440) {
          if (m.perLine !== null && (m.perLine < 60 || m.perLine > 75)) fail(where, `${m.perLine} characters per line (60–75)`);
          // A manual's index lists every page with its sentence, in columns: three
          // screens holds the 34-page user manual; more means it became a wall again.
          if (m.index && m.height > 3 * SCREEN_H) fail(where, `index is ${m.height}px, over three screens (${3 * SCREEN_H}px)`);
        }
        if (width === 390 || width === 1440) {
          const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"]).analyze();
          for (const v of axe.violations) fail(where, `axe ${v.id} (${v.nodes.length}): ${v.nodes[0].target.join(" ")}`);
        }
        await page.close();
      }
      await ctx.close();
    }
  }
  // Search works: a query finds its page, and a nonsense one says so.
  {
    const page = await browser.newPage();
    page.on("pageerror", (e) => fail("/search/", `script error: ${e.message}`));
    await page.goto(`${BASE}/search/?q=restore+backup`);
    await page.waitForFunction(() => document.querySelector(".search-count").textContent !== "");
    const titles = await page.locator(".search-results .row b").allTextContents();
    if (!titles.some((t) => t.includes("Restore from a backup"))) fail("/search/?q=restore+backup", `no "Restore from a backup" among ${JSON.stringify(titles)}`);
    await page.goto(`${BASE}/search/?q=zzqx`);
    await page.waitForFunction(() => document.querySelector(".search-count").textContent !== "");
    if (!(await page.locator(".search-count").textContent()).startsWith("No page matches")) fail("/search/?q=zzqx", "no empty result message");
    await page.close();
  }
  console.log(`check-site: ${urls.length} pages × ${WIDTHS.length} widths × 2 themes, and search`);
} finally {
  await browser.close();
  server.close();
}

if (failures.length) {
  console.error(failures.join("\n"));
  console.error(`check-site: ${failures.length} failures`);
  process.exit(1);
}
console.log("check-site: all pass");
