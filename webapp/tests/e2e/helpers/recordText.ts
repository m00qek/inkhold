import type { Page } from "@playwright/test";

// Recording what the UI SAID, as opposed to sampling what it says now.
//
// WHY THIS EXISTS, and why reaching for `expect(locator)` instead is a trap.
// Playwright's assertions auto-retry until they pass: they are built to wait for
// a SETTLED state. Most loading-state bugs are the opposite shape — a claim that
// must never have been made at any point ("Loading…" flashing between two good
// paints; "No matches" while the walk is still running; "Not recognised on the
// device" over a note whose page list has not arrived). You cannot prove that by
// looking afterwards:
//
//   - `toHaveCount(0)` passes happily against a flash that came and went;
//   - a retrying matcher keeps polling until a held response lands, then records
//     the settled state and reports success;
//   - a claim OVERWRITTEN a moment later (a counter repainting) leaves no trace
//     at all for a snapshot to find.
//
// All three produced tests that passed against genuinely broken code. So the
// window has to be RECORDED as it happens, and asserted over afterwards.
//
// READS FROM THE MUTATION RECORDS, NOT THE ELEMENT. This is the subtle part and
// the reason this is shared code rather than a snippet each test rewrites: when
// two mutations land in the same task the observer callback runs ONCE with both
// records, so reading `el.textContent` inside it yields only the final value and
// the intermediate one — usually the wrong claim under test — is lost. Every
// value is therefore taken from the records themselves: an added node still
// carries the text it displayed even after a later node replaces it.

/** A live recording of everything a selector's subtree ever displayed. */
export interface TextRecorder {
  /** Every value recorded, oldest first. */
  history(): Promise<string[]>;
  /** Did any recorded value contain `needle`? The "it must never have said this"
   *  assertion, and the reason a bare `toHaveCount(0)` is not enough. */
  everShowed(needle: string): Promise<boolean>;
}

let recorderSeq = 0;

/**
 * Start recording every value rendered inside `selector`, from before the page
 * loads (installed via `addInitScript`, so nothing painted during boot is
 * missed — several of these bugs happen on the FIRST paint).
 *
 * Call it before `page.goto`. The selector may match an element that does not
 * exist yet; matching is re-evaluated per mutation.
 */
export async function recordText(page: Page, selector: string): Promise<TextRecorder> {
  const key = `__textRec${++recorderSeq}`;
  await page.addInitScript(
    ([k, sel]) => {
      const w = window as unknown as Record<string, string[]>;
      w[k] = [];
      const inScope = (n: Node | null): boolean => {
        const el = n instanceof Element ? n : (n?.parentElement ?? null);
        return el !== null && el.closest(sel) !== null;
      };
      const push = (text: string | null): void => {
        if (text !== null && text !== "") w[k]!.push(text);
      };
      new MutationObserver((records) => {
        for (const r of records) {
          if (!inScope(r.target)) continue;
          // The records, not the element: a node replaced later in this same
          // task still carries the text it showed while it was on screen.
          for (const n of Array.from(r.addedNodes)) push(n.textContent);
          if (r.type === "characterData") push(r.target.textContent);
        }
      }).observe(document, { childList: true, subtree: true, characterData: true });
    },
    [key, selector] as const,
  );

  return {
    history: () => page.evaluate((k) => (window as unknown as Record<string, string[]>)[k] ?? [], key),
    async everShowed(needle: string) {
      const seen = await page.evaluate(
        (k) => (window as unknown as Record<string, string[]>)[k] ?? [],
        key,
      );
      return seen.some((t) => t.includes(needle));
    },
  };
}
