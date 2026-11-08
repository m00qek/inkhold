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
    figure.innerHTML = `<picture><source media="(prefers-color-scheme: dark)" srcset="${base}-dark.svg"><img alt="" src="${base}-light.svg"></picture>`;
    code.closest("pre").replaceWith(figure);
  }
})();
