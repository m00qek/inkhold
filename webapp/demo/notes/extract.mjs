// Re-creates the demo notebooks' data from a real Inkhold server, so the demo
// shows real ink through the real decoder (webapp/src/api/demoNotes.ts):
//
//   node demo/notes/extract.mjs <server-url> <email> <password> <dir-with-.note-files>
//
// Upload each .note, wait until it is indexed, and save exactly what the server
// serves: the note's metadata, each page's SNPG payload, each page's
// recognised text. Only the pages' CURRENT layers leave the file: a .note is
// append-only and keeps older page versions inside, which never ship here.
// The .note files themselves are not kept in the repository.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";

const [base, email, password, src] = process.argv.slice(2);
const out = new URL(".", import.meta.url).pathname;
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(base);
await page.locator('input[type="email"], input[name="email"], input[autocomplete="username"]').first().fill(email);
await page.locator('input[type="password"]').first().fill(password);
await page.keyboard.press("Enter");
// First sign-in asks for a new password: give it one.
const fresh = password + "-demo-notes";
await page.waitForTimeout(1500);
const pwds = page.locator('input[type="password"]');
if ((await pwds.count()) >= 2) {
  const n = await pwds.count();
  for (let i = 0; i < n; i++) await pwds.nth(i).fill(i === 0 && n === 3 ? password : fresh);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1500);
}
await page.waitForURL((u) => !u.hash.includes("login"), { timeout: 15000 });

for (const file of readdirSync(src).filter((f) => f.endsWith(".note")).sort()) {
  const slug = basename(file, ".note");
  const bytes = [...readFileSync(join(src, file))];
  const entry = await page.evaluate(async ({ name, bytes }) => {
    const form = new FormData();
    form.append("file", new File([new Uint8Array(bytes)], name), name);
    const r = await fetch("/api/controlplane/folder/root/upload", { method: "POST", body: form, credentials: "include" });
    return r.json();
  }, { name: file, bytes });
  const id = entry.id ?? entry.entry?.id;
  let meta;
  for (let i = 0; i < 60; i++) {
    meta = await page.evaluate(async (id) => (await fetch(`/api/controlplane/file/metadata/${id}`, { credentials: "include" })).json(), id);
    if (meta.pages?.length && meta.pages.every((p) => p.hash)) break;
    await page.waitForTimeout(500);
  }
  const dir = join(out, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
  for (const p of meta.pages) {
    const snpg = await page.evaluate(async ({ id, p }) => [...new Uint8Array(await (await fetch(`/note/${id}/page/${p.index}?v=${p.hash}`, { credentials: "include" })).arrayBuffer())], { id, p });
    writeFileSync(join(dir, `page-${p.index}.snpg`), Buffer.from(snpg));
    if (p.textHash) {
      const text = await page.evaluate(async ({ id, p }) => (await fetch(`/note/${id}/page/${p.index}/text?v=${p.textHash}`, { credentials: "include" })).json(), { id, p });
      writeFileSync(join(dir, `page-${p.index}.text.json`), JSON.stringify(text) + "\n");
    }
  }
  console.log(slug, id, meta.pages.length, "pages");
}
await browser.close();
