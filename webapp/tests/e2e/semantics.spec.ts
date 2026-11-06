import { test, expect } from "@playwright/test";
import { signedIn } from "./helpers/app";
import { checkPage } from "./helpers/semantics";
import { SCREENS, VARIANTS, settle } from "./helpers/screens";

// Every main screen, at desktop in both themes and at phone width, against
// axe-core (WCAG 2.2 AA and best practice) and the structure checks
// (`helpers/semantics.ts`). Each must find nothing. SEMANTICS_SHOW=<rule>
// prints a rule's elements on every screen, for chasing a finding.

const SHOW = process.env.SEMANTICS_SHOW;

for (const v of VARIANTS) {
  test.describe(`semantics, ${v.name}`, () => {
    // No motion: axe would measure a card's colour halfway through its fade-in.
    test.use({ viewport: { width: v.width, height: v.height }, colorScheme: v.dark ? "dark" : "light", hasTouch: v.touch, reducedMotion: "reduce" });
    for (const s of SCREENS) {
      test(s.name, async ({ page }) => {
        await signedIn(page);
        await s.open(page);
        await settle(page);
        const found = await checkPage(page, { ownTitle: s.ownTitle, minTarget: v.minTarget });
        const key = `${s.name}@${v.name}`;
        if (SHOW && found[SHOW]) console.log(`${key} ${SHOW}: ${found[SHOW].samples.join(" | ")}`);
        const findings = Object.entries(found).map(([rule, f]) => `${rule}: ${f.count}, e.g. ${f.samples.join(" | ")}`);
        expect(findings, key).toEqual([]);
      });
    }
  });
}
