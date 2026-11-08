// The site's one script: the light/dark toggle, and keyboard reach for what
// scrolls sideways. The pages read the same without it.

// Light or dark. Until the toggle is pressed the page follows the system; a
// press saves the choice, which the inline script in base.html applies before
// the first paint on every page.
(() => {
  const root = document.documentElement;
  const button = document.querySelector(".theme");
  const system = matchMedia("(prefers-color-scheme: dark)");
  const isDark = () => (root.dataset.theme ? root.dataset.theme === "dark" : system.matches);
  const show = () => button.setAttribute("aria-pressed", String(isDark()));
  button.addEventListener("click", () => {
    const next = isDark() ? "light" : "dark";
    root.dataset.theme = next;
    try {
      localStorage.setItem("theme", next);
    } catch {
      /* private mode: the choice lasts for this page only */
    }
    show();
  });
  system.addEventListener("change", show);
  show();
  // Without this script there is nothing to toggle: it stays hidden.
  button.hidden = false;
})();

// A code block, table or diagram wider than the column scrolls sideways; one
// that does is a stop for the keyboard (arrow keys scroll it) and is named.
(() => {
  const NAMES = { PRE: "Code", TABLE: "Table", FIGURE: "Diagram" };
  const reach = () => {
    for (const el of document.querySelectorAll(".prose pre, .prose table, .prose .diagram")) {
      if (el.scrollWidth > el.clientWidth + 1) {
        el.tabIndex = 0;
        el.setAttribute("role", "region");
        el.setAttribute("aria-label", `${NAMES[el.tagName]}, scrolls sideways`);
      } else if (el.hasAttribute("tabindex")) {
        el.removeAttribute("tabindex");
        el.removeAttribute("role");
        el.removeAttribute("aria-label");
      }
    }
  };
  let timer;
  addEventListener("resize", () => {
    clearTimeout(timer);
    timer = setTimeout(reach, 150);
  });
  reach();
})();
