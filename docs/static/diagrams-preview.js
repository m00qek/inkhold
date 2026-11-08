// `make serve` only: Zola shows a ```mermaid block as code, so swap each one
// for the SVGs tools/diagrams.mjs rendered, found by the same hash of its
// source. A built site has them inlined instead and never loads this.
(async () => {
  const hashOf = async (text) => {
    const bytes = new TextEncoder().encode(text.trim());
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
  };
  for (const code of document.querySelectorAll('code[data-lang="mermaid"]')) {
    const h = await hashOf(code.textContent);
    const base = new URL(`diagrams/${h}`, document.querySelector('link[href$="site.css"]').href);
    const figure = document.createElement("figure");
    figure.className = "diagram";
    // Both, as a built page has them: the theme (or the toggle) shows one.
    figure.innerHTML = `<img class="diagram__light" alt="" src="${base}-light.svg"><img class="diagram__dark" alt="" src="${base}-dark.svg">`;
    code.closest("pre").replaceWith(figure);
  }
})();
