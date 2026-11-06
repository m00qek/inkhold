import type { Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// The semantic checks every screen must pass (`tests/e2e/semantics.spec.ts`):
// axe-core's WCAG 2.2 AA and best-practice rules, plus the structure axe does
// not judge (one main, headings, links for navigation, lists for
// collections, hidden icons, a title per screen, tap targets). Each finding is
// a rule and the elements it names; the spec compares counts per rule.

export interface Finding {
  readonly count: number;
  /** A few of the elements, for the failure message. */
  readonly samples: string[];
}

export type Findings = Record<string, Finding>;

export interface CheckOptions {
  /** The screen should have its own title, not just the app's. */
  readonly ownTitle: boolean;
  /** The smallest tap target in CSS px: 24 (WCAG 2.2 AA), 44 on touch. */
  readonly minTarget: number;
}

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

/** axe-core's findings, one rule per entry. */
async function axe(page: Page): Promise<Findings> {
  const res = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  const out: Findings = {};
  for (const v of res.violations) {
    out[`axe/${v.id}`] = { count: v.nodes.length, samples: v.nodes.slice(0, 4).map((n) => n.target.join(" ")) };
  }
  return out;
}

/** The structure checks, run in the page. Kept as one function: it is serialized. */
function structure(opts: CheckOptions): Record<string, string[]> {
  const found: Record<string, string[]> = {};
  const add = (rule: string, e: Element | string) => {
    const d0 =
      typeof e === "string"
        ? e
        : (e.tagName.toLowerCase() + (e.id ? `#${e.id}` : "") + (typeof e.className === "string" && e.className.trim() ? "." + e.className.trim().split(/\s+/).slice(0, 2).join(".") : "")).slice(0, 80);
    const d = typeof e === "string" ? d0 : `${d0} "${(e.textContent ?? "").trim().slice(0, 16)}"`;
    (found[rule] ??= []).push(d);
  };
  const shown = (e: Element) => {
    if (e.closest("[hidden],[inert],[aria-hidden=true]")) return false;
    const r = e.getBoundingClientRect();
    const cs = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
  };
  const inAccessibilityTree = (e: Element) => !e.closest("[hidden],[inert],[aria-hidden=true]") && getComputedStyle(e).display !== "none";

  // Landmarks.
  const mains = [...document.querySelectorAll("main,[role=main]")].filter(inAccessibilityTree);
  if (mains.length !== 1) add("one-main", `${mains.length} main landmarks`);
  if (![...document.querySelectorAll("header,[role=banner]")].some((e) => inAccessibilityTree(e) && !e.closest("main,article,section,aside,nav,dialog"))) add("banner-landmark", "no top-level <header>");
  for (const e of document.querySelectorAll("input[type=search]")) if (shown(e) && !e.closest("search,[role=search]")) add("search-landmark", e);
  for (const e of document.querySelectorAll("aside,[role=complementary]")) if (inAccessibilityTree(e) && e.querySelector("nav")) add("nav-in-aside", e);

  // Live regions: small announcers only, never a whole screen.
  for (const e of document.querySelectorAll("[aria-live]:not([aria-live=off]),[role=status],[role=alert],[role=log]")) {
    if (e.querySelectorAll("*").length > 12 || e.querySelector("a[href],button,input,select,textarea")) add("live-region-too-big", e);
  }

  // Headings: one h1, no skipped levels.
  const heads = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")].filter(inAccessibilityTree);
  const h1s = heads.filter((h) => h.tagName === "H1" && !h.closest("dialog"));
  if (h1s.length !== 1) add("one-h1", `${h1s.length} h1 outside dialogs`);
  let last = 0;
  for (const h of heads) {
    if (h.closest("dialog")) continue;
    const level = Number(h.tagName[1]);
    if (last > 0 && level > last + 1) add("heading-skip", `${h.tagName} after H${last}: ${(h.textContent ?? "").trim().slice(0, 30)}`);
    last = level;
  }

  // Title.
  if (opts.ownTitle && document.title.trim() === "Inkhold") add("own-title", `title is "${document.title}"`);

  // Navigation is a link; an action is a button. These controls go somewhere;
  // `data-no-address` marks a place that has none (a category not created yet).
  for (const e of document.querySelectorAll("nav button,button.card__open,.coverage button")) {
    if (e.hasAttribute("data-no-address") || e.hasAttribute("aria-expanded") || e.hasAttribute("aria-pressed") || e.hasAttribute("aria-haspopup")) continue;
    if (shown(e) && !e.closest("[role=menu]")) add("navigates-by-button", e);
  }

  // Collections are lists.
  for (const e of document.querySelectorAll(".card,.todo-hit,.coverage__list > *")) if (shown(e) && !e.closest("li")) add("collection-not-list", e);
  for (const l of document.querySelectorAll("li")) if (!["UL", "OL", "MENU"].includes(l.parentElement?.tagName ?? "")) add("li-outside-list", l);

  // Decorative icons are hidden.
  for (const s of document.querySelectorAll("svg")) {
    if (shown(s) && s.getAttribute("aria-hidden") !== "true" && !s.closest("[aria-hidden=true]") && !(s.getAttribute("role") === "img" && s.getAttribute("aria-label"))) add("icon-not-hidden", s.parentElement ?? s);
  }

  // References name something that exists.
  for (const e of document.querySelectorAll("[aria-labelledby],[aria-describedby],[aria-controls],[for]")) {
    for (const a of ["aria-labelledby", "aria-describedby", "aria-controls", "for"]) {
      for (const id of (e.getAttribute(a) ?? "").split(/\s+/).filter(Boolean)) if (!document.getElementById(id)) add("broken-reference", `${a}=${id}`);
    }
  }

  // Tap targets: inline links in running text are exempt (WCAG 2.5.8).
  for (const e of document.querySelectorAll("a[href],button,[role=button],input:not([type=hidden]),select,summary,[role=menuitem]")) {
    if (!shown(e)) continue;
    if (e.tagName === "A" && e.closest("p")) continue;
    // A stretched link: its absolutely placed ::after covers its containing
    // block (a whole card), and that is what a finger hits.
    const after = getComputedStyle(e, "::after");
    const stretched = after.content !== "none" && after.position === "absolute";
    const box = stretched ? (getComputedStyle(e).position !== "static" ? e : (e as HTMLElement).offsetParent ?? e) : e;
    const r = box.getBoundingClientRect();
    if (r.width < opts.minTarget || r.height < opts.minTarget) add("target-size", `${(e.getAttribute("aria-label") ?? e.textContent ?? e.tagName).trim().slice(0, 24)} ${Math.round(r.width)}x${Math.round(r.height)}`);
  }

  // A skip link first, so keyboard users can pass the panel and the bar.
  const first = document.querySelector("a[href],button,input,select,textarea,[tabindex]:not([tabindex='-1'])");
  if (!first || first.tagName !== "A" || !(first.getAttribute("href") ?? "").startsWith("#")) add("skip-link", "the first focusable element is not a skip link");

  return found;
}

export async function checkPage(page: Page, opts: CheckOptions): Promise<Findings> {
  const out = await axe(page);
  const mine = await page.evaluate(structure, opts);
  for (const [rule, els] of Object.entries(mine)) out[rule] = { count: els.length, samples: els.slice(0, process.env.SEMANTICS_SHOW ? 100 : 4) };
  return out;
}
