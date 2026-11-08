// The search page: scores Zola's index (search_index.en.json, a plain list of
// {url, title, description, body}) itself, no library. Every word must match
// the start of a word somewhere in the page; a title match counts most, then
// the description, then the body. Accents and case are ignored, as the app's
// own search ignores them.
(async () => {
  const data = JSON.parse(document.getElementById("search-data").textContent);
  // data: { index: the index's URL, planned: permalinks of planned pages }
  const field = document.getElementById("search-q");
  const count = document.querySelector(".search-count");
  const list = document.querySelector(".search-results");
  const planned = new Set(data.planned);

  /** Lowercase, accents dropped, with each folded character's index in the original. */
  function fold(text) {
    let out = "";
    const at = [];
    for (let i = 0; i < text.length; i++) {
      const f = text[i].normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
      out += f;
      for (let k = 0; k < f.length; k++) at.push(i);
    }
    return { text: out, at };
  }
  const escape = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const words = (q) => fold(q).text.split(/[^\p{L}\p{N}.]+/u).filter(Boolean);
  const startsOfWord = (hay, w) => {
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "gu");
    return [...hay.matchAll(re)].map((m) => m.index + m[1].length);
  };

  let docs = [];
  try {
    const raw = await (await fetch(data.index)).json();
    docs = raw.map((d) => {
      // The body as read: no heading anchors ("#"), and not the page's own title again.
      let body = d.body.replace(/#(?=\s|$)/g, "").replace(/\s+/g, " ").trim();
      if (body.startsWith(d.title)) body = body.slice(d.title.length).trim();
      return { ...d, body, f: { title: fold(d.title).text, description: fold(d.description || "").text, body: fold(body) } };
    });
  } catch {
    count.textContent = "Search couldn't load its index. Reload the page to try again.";
    return;
  }

  /** A sentence of the body around the first match, the matched words marked. */
  function snippet(doc, ws) {
    const { text, at } = doc.f.body;
    const hits = ws.flatMap((w) => startsOfWord(text, w).map((i) => [i, w.length]));
    if (!hits.length) return escape(doc.description || doc.body.slice(0, 160));
    hits.sort((a, b) => a[0] - b[0]);
    const first = at[hits[0][0]];
    const from = Math.max(0, doc.body.lastIndexOf(" ", Math.max(0, first - 60)) + 1);
    const to = Math.min(doc.body.length, doc.body.indexOf(" ", first + 120) === -1 ? doc.body.length : doc.body.indexOf(" ", first + 120));
    let html = "";
    let pos = from;
    for (const [i, len] of hits) {
      const s = at[i];
      const e = at[i + len - 1] + 1;
      if (s < pos || e > to) continue;
      html += escape(doc.body.slice(pos, s)) + "<mark>" + escape(doc.body.slice(s, e)) + "</mark>";
      pos = e;
    }
    html += escape(doc.body.slice(pos, to));
    return (from > 0 ? "… " : "") + html.replace(/\s+/g, " ") + (to < doc.body.length ? " …" : "");
  }

  function run(q) {
    const ws = words(q);
    list.replaceChildren();
    if (!ws.length) {
      count.textContent = "";
      return;
    }
    const found = [];
    for (const d of docs) {
      let score = 0;
      let all = true;
      for (const w of ws) {
        const t = startsOfWord(d.f.title, w).length;
        const s = startsOfWord(d.f.description, w).length;
        const b = startsOfWord(d.f.body.text, w).length;
        if (!t && !s && !b) {
          all = false;
          break;
        }
        score += (t ? 10 : 0) + (s ? 3 : 0) + Math.min(b, 5);
      }
      if (all) found.push([score, d]);
    }
    found.sort((a, b) => b[0] - a[0] || a[1].title.localeCompare(b[1].title));
    const shown = `“${q.trim()}”`;
    count.textContent = found.length
      ? `${found.length} ${found.length === 1 ? "page matches" : "pages match"} ${shown}.`
      : `No page matches ${shown}. Try fewer words, or browse the manuals.`;
    for (const [, d] of found.slice(0, 50)) {
      const li = document.createElement("li");
      const stub = planned.has(d.url);
      li.innerHTML =
        `<a class="row${stub ? " is-stub" : ""}" href="${escape(d.url)}">` +
        `<b>${stub ? '<span class="ring" aria-hidden="true"></span>' : ""}${escape(d.title)}${stub ? '<span class="sr-only"> (planned)</span>' : ""}</b>` +
        `<span>${snippet(d, ws)}</span></a>`;
      list.append(li);
    }
  }

  const params = new URLSearchParams(location.search);
  field.value = params.get("q") ?? "";
  let timer;
  field.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const url = new URL(location.href);
      if (field.value.trim()) url.searchParams.set("q", field.value);
      else url.searchParams.delete("q");
      history.replaceState(null, "", url);
      run(field.value);
    }, 120);
  });
  // Enter searches in place; the form only matters without this script.
  field.closest("form").addEventListener("submit", (e) => e.preventDefault());
  run(field.value);
  if (!field.value) field.focus();
})();
