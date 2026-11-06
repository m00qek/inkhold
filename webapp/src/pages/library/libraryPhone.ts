// The library on a phone (below 700px, the breakpoint in `00-tokens.css`):
// the rail becomes a drawer opened from the bar's ☰, the search box and the
// bar's tools open from their own buttons, and a tab bar at the bottom holds
// the four places a thumb goes most (Library, To-Do, Search, You). Wider than
// that, none of this shows and nothing here acts: the CSS hides the buttons
// and the tab bar, and every state is dropped when the window widens.
//
// The drawer is a modal: the rest of the app is inert while it is open, focus
// moves into it and comes back to ☰, and Escape, the scrim or following a link
// closes it.

import { el } from "../../ui/dom";
import { ICONS, svg, type IconName } from "../../ui/icons";
import { onPlainClick } from "../../ui/link";
import { accountHref, folderHref, go, todoHref } from "../../router";
import type { Topbar } from "./libraryTopbar";
import { PHONE_QUERY } from "../../ui/breakpoints";


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
  const { menuBtn, searchToggle, moreBtn } = d.topbar;
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
  function openSearch(): void {
    d.root.classList.add("is-search-open");
    searchToggle.setAttribute("aria-expanded", "true");
    tabSearch.setAttribute("aria-expanded", "true");
    d.searchInput.focus();
  }
  function closeSearch(): void {
    // A query on screen keeps the box: it says what the results are for.
    if (d.searchInput.value.trim() !== "") return;
    d.root.classList.remove("is-search-open");
    searchToggle.setAttribute("aria-expanded", "false");
    tabSearch.setAttribute("aria-expanded", "false");
  }
  searchToggle.addEventListener("click", openSearch);
  d.searchInput.addEventListener("blur", () => setTimeout(closeSearch, 0));

  // ---- the bar's tools ----
  function setTools(open: boolean): void {
    d.root.classList.toggle("is-tools-open", open);
    moreBtn.setAttribute("aria-expanded", String(open));
  }
  moreBtn.addEventListener("click", () => setTools(!d.root.classList.contains("is-tools-open")));
  const onOutside = (e: Event) => {
    const t = e.target as Element;
    if (!t.closest?.(".tools, .topbar__more, .menu__pop")) setTools(false);
  };
  document.addEventListener("click", onOutside, true);

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

  function sync(): void {
    const here = d.section();
    for (const a of tabbar.querySelectorAll<HTMLElement>("a[data-tab]")) {
      if (a.dataset["tab"] === here) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    }
    if (d.searchInput.value.trim() !== "") {
      d.root.classList.add("is-search-open");
      searchToggle.setAttribute("aria-expanded", "true");
    }
  }

  // ---- Escape, navigation, and leaving phone width ----
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    if (d.root.classList.contains("is-drawer-open")) {
      e.preventDefault();
      closeDrawer();
    } else if (d.root.classList.contains("is-tools-open")) {
      setTools(false);
      moreBtn.focus();
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
      document.removeEventListener("click", onOutside, true);
      window.removeEventListener("hashchange", onRoute);
      mq.removeEventListener("change", onWidth);
    },
  };
}
