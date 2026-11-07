// The library on a phone (below 700px, the breakpoint in `00-tokens.css`):
// the rail becomes a drawer opened from the bar's ☰, the bar's tools open
// from ⋯ (shown only while the place has a tool), and a tab bar at the bottom
// holds the four places a thumb goes most (Library, To-Do, Search, You);
// its Search opens the search box across the bar. Wider than
// that, none of this shows and nothing here acts: the CSS hides the buttons
// and the tab bar, and every state is dropped when the window widens.
//
// The drawer is a modal: the rest of the app is inert while it is open, focus
// moves into it and comes back to ☰, and Escape, the scrim or following a link
// closes it.

import { el } from "../../ui/dom";
import { ICONS, svg, type IconName } from "../../ui/icons";
import { onPlainClick } from "../../ui/link";
import { accountHref, folderHref, go, searchHref, todoHref } from "../../router";
import type { Topbar } from "./libraryTopbar";
import { PHONE_QUERY } from "../../ui/breakpoints";
import { barMenuOpenFrom, barRows, openBarMenu } from "../../ui/barMenu";
import { closeOpenPopover } from "../../ui/popover";


export interface PhoneShellDeps {
  /** `.sn-root`: carries the state classes the CSS reads. */
  root: HTMLElement;
  app: HTMLElement;
  rail: HTMLElement;
  header: HTMLElement;
  main: HTMLElement;
  topbar: Topbar;
  searchInput: HTMLInputElement;
  /** Which tab is the current place. */
  section(): "library" | "todo" | "you";
  /** One level up from here (a folder's parent, To-Do's Lists, the folder a
   *  search started from); null on a top-level place, which keeps ☰. */
  up(): { href: string; label: string } | null;
}

export interface PhoneShell {
  /** The tab bar, placed after <main> by the shell. */
  readonly tabbar: HTMLElement;
  /** Re-mark the current tab and keep search open while it has a query. */
  sync(): void;
  destroy(): void;
}

export function createPhoneShell(d: PhoneShellDeps): PhoneShell {
  const mq = window.matchMedia(PHONE_QUERY);
  const { menuBtn, moreBtn, tools, backLink } = d.topbar;
  onPlainClick(backLink, () => go(backLink.getAttribute("href") ?? "#/"));
  const scrim = el("div", { class: "drawer-scrim", "aria-hidden": "true" });
  d.app.append(scrim);

  // ---- the drawer ----
  const others = () => [d.header, d.main, tabbar];
  function openDrawer(): void {
    d.root.classList.add("is-drawer-open");
    menuBtn.setAttribute("aria-expanded", "true");
    for (const o of others()) o.inert = true;
    d.rail.querySelector<HTMLElement>("a[href], button")?.focus();
  }
  function closeDrawer(focusMenu = true): void {
    if (!d.root.classList.contains("is-drawer-open")) return;
    d.root.classList.remove("is-drawer-open");
    menuBtn.setAttribute("aria-expanded", "false");
    for (const o of others()) o.inert = false;
    if (focusMenu && mq.matches) menuBtn.focus();
  }
  menuBtn.addEventListener("click", openDrawer);
  scrim.addEventListener("click", () => closeDrawer());
  // A link in the drawer goes somewhere: the drawer has done its job.
  d.rail.addEventListener("click", (e) => {
    if ((e.target as Element).closest("a[href]")) closeDrawer(false);
  });

  // ---- search across the bar ----
  /**
   * Whether this place shows the search box: a folder, results, To-Do's lists.
   * A destination page (your account, the bin, the admin console) does not, so
   * search mode there would hide the title and show nothing in its place.
   */
  const boxHere = (): boolean =>
    !(d.root.classList.contains("is-destination") && !d.root.classList.contains("is-todo-browse"));
  /** The Search tab, tapped where there is no box: open it once search is on screen. */
  let openOnArrival = false;

  function openSearch(): void {
    if (!boxHere()) {
      openOnArrival = true;
      go(searchHref(d.searchInput.value.trim()));
      return;
    }
    d.root.classList.add("is-search-open");
    tabSearch.setAttribute("aria-expanded", "true");
    d.searchInput.focus();
  }
  function closeSearch(): void {
    // A query on screen keeps the box: it says what the results are for.
    if (d.searchInput.value.trim() !== "") return;
    d.root.classList.remove("is-search-open");
    tabSearch.setAttribute("aria-expanded", "false");
  }
  d.searchInput.addEventListener("blur", () => setTimeout(closeSearch, 0));

  // ---- the bar's tools ----
  // ⋯ opens them as one menu, the bar's groups as its groups (`ui/barMenu.ts`);
  // the popover registry closes it on a choice, Escape or a click outside.
  function setTools(open: boolean): void {
    if (!open && barMenuOpenFrom(moreBtn)) closeOpenPopover();
  }
  moreBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (barMenuOpenFrom(moreBtn)) {
      closeOpenPopover();
      return;
    }
    openBarMenu(moreBtn, barRows(tools));
  });
  // Each place shows and hides its own tools (sort over a folder, Lock console
  // on an unlocked admin console, To-Do's list tools...). A place with none
  // has no ⋯: an empty panel is a button that does nothing.
  const hasTools = () =>
    Array.from(tools.children).some((c) => c instanceof HTMLElement && !c.hidden && !c.classList.contains("tools__sep"));
  const syncMore = () => {
    const any = hasTools();
    moreBtn.hidden = !any;
    if (!any) setTools(false);
  };
  const toolsWatch = new MutationObserver(syncMore);
  toolsWatch.observe(tools, { subtree: true, childList: true, attributes: true, attributeFilter: ["hidden"] });
  syncMore();

  // ---- the tab bar ----
  const tab = (href: string, label: string, icon: IconName, key: "library" | "todo" | "you") => {
    const a = el("a", { class: "tabbar__tab", href, "data-tab": key }, el("span", { class: "tabbar__mark", html: svg(ICONS[icon], 1.7) }), el("span", { text: label }));
    onPlainClick(a, () => go(href));
    return a;
  };
  const tabSearch = el(
    "button",
    { class: "tabbar__tab", type: "button", "aria-expanded": "false", "aria-controls": "search-box" },
    el("span", { class: "tabbar__mark", html: svg(ICONS.search, 1.7) }),
    el("span", { text: "Search" }),
  );
  tabSearch.addEventListener("click", openSearch);
  const tabbar = el(
    "nav",
    { class: "tabbar", "aria-label": "Sections" },
    tab(folderHref(null), "Library", "folder", "library"),
    tab(todoHref(""), "To-Do", "todo", "todo"),
    tabSearch,
    tab(accountHref(), "You", "person", "you"),
  );

  /** ‹ in ☰'s place below a top-level place; iPhones have no back button. */
  function syncUp(): void {
    const up = d.up();
    backLink.hidden = up === null;
    menuBtn.hidden = up !== null;
    if (up) {
      backLink.href = up.href;
      backLink.setAttribute("aria-label", `Back to ${up.label}`);
      backLink.title = `Back to ${up.label}`;
    }
  }
  // The crumbs carry a folder's parent, and arrive with its listing.
  const crumbWatch = new MutationObserver(syncUp);
  crumbWatch.observe(d.topbar.crumbs, { childList: true, subtree: true, characterData: true });

  function sync(): void {
    syncUp();
    const here = d.section();
    for (const a of tabbar.querySelectorAll<HTMLElement>("a[data-tab]")) {
      if (a.dataset["tab"] === here) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    }
    // A query kept for Back holds the box open, where there is one; a place
    // without it keeps its title.
    const open = boxHere() && (openOnArrival || d.searchInput.value.trim() !== "");
    d.root.classList.toggle("is-search-open", open);
    tabSearch.setAttribute("aria-expanded", String(open));
    if (openOnArrival && boxHere()) {
      openOnArrival = false;
      d.searchInput.focus();
    }
  }

  // ---- Escape, navigation, and leaving phone width ----
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    if (d.root.classList.contains("is-drawer-open")) {
      e.preventDefault();
      closeDrawer();
    }
  };
  document.addEventListener("keydown", onKey);
  const onRoute = () => {
    closeDrawer(false);
    setTools(false);
    // After the router has moved: the destination is what the tab follows.
    setTimeout(sync, 0);
  };
  window.addEventListener("hashchange", onRoute);
  const onWidth = () => {
    if (mq.matches) return;
    closeDrawer(false);
    setTools(false);
    d.root.classList.remove("is-search-open");
  };
  mq.addEventListener("change", onWidth);
  sync();

  return {
    tabbar,
    sync,
    destroy() {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("hashchange", onRoute);
      mq.removeEventListener("change", onWidth);
      toolsWatch.disconnect();
      crumbWatch.disconnect();
    },
  };
}
