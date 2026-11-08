// The light/dark toggle. Until it is pressed the page follows the system; a
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
