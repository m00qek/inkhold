import type { Page } from "@playwright/test";

// Records everything a subtree ever displayed, for "must never have said X"
// assertions that auto-retrying matchers cannot prove. Values come from the
// mutation records, not the element: two mutations in one task reach the
// observer once, and reading `textContent` would lose the intermediate one.

/** A live recording of everything a selector's subtree ever displayed. */
export interface TextRecorder {
  /** Every value recorded, oldest first. */
  history(): Promise<string[]>;
  /** Did any recorded value contain `needle`? */
  everShowed(needle: string): Promise<boolean>;
}

let recorderSeq = 0;

/**
 * Call before `page.goto`; installed via `addInitScript` so boot paints are
 * captured. The selector may match an element that does not exist yet.
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
