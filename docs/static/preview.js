// `make serve` only. Zola shows a ```mermaid block as code and a screenshot as
// one <img> with a page-relative path; swap each for what the build makes
// (tools/diagrams.mjs): the SVGs rendered for the block, found by the same
// hash of its source, and the screenshot's light and dark files. A built site
// has both inlined and never loads this.
(async () => {
  const root = new URL(".", document.querySelector('link[href$="site.css"]').href);
  const hashOf = async (text) => {
    const bytes = new TextEncoder().encode(text.trim());
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
  };
  for (const code of document.querySelectorAll('code[data-lang="mermaid"]')) {
    const h = await hashOf(code.textContent);
    const base = new URL(`diagrams/${h}`, root);
    const figure = document.createElement("figure");
    figure.className = "diagram";
    // Both, as a built page has them: the theme (or the toggle) shows one.
    figure.innerHTML = `<img class="diagram__light" alt="" src="${base}-light.svg"><img class="diagram__dark" alt="" src="${base}-dark.svg">`;
    code.closest("pre").replaceWith(figure);
  }
  // Zola writes the image's address under the page's own URL; only the name matters.
  for (const img of document.querySelectorAll('.prose p > img[src*="/screenshots/"]:only-child')) {
    const name = img.getAttribute("src").replace(/^.*\/screenshots\//, "").replace(/\.png$/, "");
    const figure = document.createElement("figure");
    figure.className = "shot";
    const one = (theme) => `<img class="shot__${theme}" alt="${img.alt}" src="${new URL(`screenshots/${name}-${theme}.png`, root)}" loading="lazy">`;
    figure.innerHTML = one("light") + one("dark");
    const light = figure.querySelector(".shot__light");
    light.addEventListener("load", () => { if (light.naturalHeight > light.naturalWidth) figure.classList.add("shot--phone"); });
    img.parentElement.replaceWith(figure);
  }
})();
