import { test, expect } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { signedIn } from "./helpers/app";
import { checkPage, type Findings } from "./helpers/semantics";
import { SCREENS, VARIANTS, settle } from "./helpers/screens";

// Every main screen, at desktop in both themes and at phone width, against
// axe-core and the structure checks (`helpers/semantics.ts`). What each still
// fails is recorded in `semantics-baseline/`, as counts per rule: a new rule
// or a higher count fails, and so does a lower one until the record is
// lowered (`SEMANTICS_UPDATE=1`), so the record only ever shrinks on purpose.
// The goal is an empty record.

const BASELINE = fileURLToPath(new URL("./semantics-baseline/", import.meta.url));
const UPDATE = process.env.SEMANTICS_UPDATE === "1";
/** SEMANTICS_SHOW=<rule> prints that rule's samples on every screen. */
const SHOW = process.env.SEMANTICS_SHOW;



function recorded(key: string): Record<string, number> {
  const f = `${BASELINE}${key}.json`;
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as Record<string, number>) : {};
}

function compare(found: Findings, was: Record<string, number>): string[] {
  const out: string[] = [];
  for (const [rule, f] of Object.entries(found)) {
    const before = was[rule] ?? 0;
    if (f.count > before) out.push(`${rule}: ${f.count} (recorded ${before}) e.g. ${f.samples.join(" | ")}`);
    else if (f.count < before) out.push(`${rule}: down to ${f.count} from ${before}; lower the record (SEMANTICS_UPDATE=1)`);
  }
  for (const [rule, n] of Object.entries(was)) if (!(rule in found)) out.push(`${rule}: fixed (recorded ${n}); lower the record (SEMANTICS_UPDATE=1)`);
  return out;
}

for (const v of VARIANTS) {
  test.describe(`semantics, ${v.name}`, () => {
    test.use({ viewport: { width: v.width, height: v.height }, colorScheme: v.dark ? "dark" : "light", hasTouch: v.name === "phone" });
    for (const s of SCREENS) {
      test(s.name, async ({ page }) => {
        await signedIn(page);
        await s.open(page);
        await settle(page);
        const found = await checkPage(page, { ownTitle: s.ownTitle, minTarget: v.minTarget });
        const key = `${s.name}@${v.name}`;
        if (SHOW && found[SHOW]) console.log(`${key} ${SHOW}: ${found[SHOW].samples.join(" | ")}`);
        if (UPDATE) {
          mkdirSync(BASELINE, { recursive: true });
          const counts = Object.fromEntries(Object.entries(found).map(([r, f]) => [r, f.count]).sort());
          writeFileSync(`${BASELINE}${key}.json`, JSON.stringify(counts, null, 1) + "\n");
          return;
        }
        expect(compare(found, recorded(key)), key).toEqual([]);
      });
    }
  });
}
