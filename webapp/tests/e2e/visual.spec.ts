import { test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { signedIn } from "./helpers/app";
import { SCREENS, VARIANTS, settle } from "./helpers/screens";

// Screenshots of every screen and size into VISUAL_DIR, for a before/after
// pixel comparison when a change must not move anything (`scripts/visual-diff.sh`).
// Skipped unless VISUAL_DIR is set.

const DIR = process.env.VISUAL_DIR;

for (const v of VARIANTS) {
  test.describe(`visual, ${v.name}`, () => {
    test.skip(!DIR, "VISUAL_DIR not set");
    test.use({ viewport: { width: v.width, height: v.height }, colorScheme: v.dark ? "dark" : "light", hasTouch: v.name === "phone" });
    for (const s of SCREENS) {
      test(s.name, async ({ page }) => {
        // Times shown relative to now ("21:01") must not move between runs.
        await page.clock.setFixedTime(new Date("2026-11-05T12:00:00Z"));
        await signedIn(page);
        await page.emulateMedia({ reducedMotion: "reduce" });
        await s.open(page);
        await settle(page);
        // Animations and the caret would differ between two runs.
        await page.addStyleTag({ content: "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}" });
        // Hover states depend on where the last click left the mouse.
        await page.mouse.move(v.width - 1, v.height - 1);
        await page.waitForTimeout(300);
        mkdirSync(DIR!, { recursive: true });
        await page.screenshot({ path: `${DIR}/${s.name}@${v.name}.png` });
      });
    }
  });
}
