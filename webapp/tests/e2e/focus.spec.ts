import { test, expect } from "@playwright/test";
import { signedIn } from "./helpers/app";
import { settle } from "./helpers/screens";

// Every stop a keyboard reaches shows where it is: an outline or a ring
// (box-shadow) on the element or on a part of it (a card draws its ring on
// its thumbnail).

const SCREENS = ["/#/folder/files", "/#/todo/list/" + "1".padStart(32, "0"), "/#/note/101", "/#/account", "/#/bin"];

test.use({ reducedMotion: "reduce" });

for (const path of SCREENS) {
  test(`every Tab stop shows focus: ${path}`, async ({ page }) => {
    await signedIn(page);
    await page.goto(path);
    await settle(page);
    const missing = new Set<string>();
    let stops = 0;
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press("Tab");
      const r = await page.evaluate(() => {
        const e = document.activeElement;
        if (!e || e === document.body) return null;
        const ring = (el: Element) => {
          const cs = getComputedStyle(el);
          return (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0) || (cs.boxShadow !== "" && cs.boxShadow !== "none");
        };
        const label = `${e.tagName.toLowerCase()}.${String((e as HTMLElement).className).split(" ")[0]} "${(e.getAttribute("aria-label") ?? e.textContent ?? "").trim().slice(0, 24)}"`;
        return { ok: ring(e) || [...e.querySelectorAll("*")].some(ring) || (e.parentElement !== null && ring(e.parentElement)), label };
      });
      if (!r) continue;
      stops++;
      if (!r.ok) missing.add(r.label);
    }
    expect(stops).toBeGreaterThan(10);
    expect([...missing]).toEqual([]);
  });
}
