// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { barRows, onceEach, setMenuRows, SUBMENU_AT, type BarRow } from "../../src/ui/barMenu";

/** A bar like the library's: sort, view, a divider, then actions. */
function bar(): { root: HTMLElement; select: HTMLSelectElement; list: HTMLButtonElement; upload: HTMLButtonElement } {
  const root = document.createElement("div");
  root.innerHTML = `
    <span class="select"><select aria-label="Sort notes"><option value="recent">Recent</option><option value="title">Title</option></select></span>
    <div class="segmented" role="group" aria-label="View">
      <button aria-label="Grid view" aria-pressed="true"><svg><path d="g"/></svg><span class="segmented__label">Grid</span></button>
      <button aria-label="List view" aria-pressed="false"><svg><path d="l"/></svg><span class="segmented__label">List</span></button>
    </div>
    <span class="tools__sep" aria-hidden="true"></span>
    <button class="btn topbar__action" aria-label="Upload a file to this folder"><span class="topbar__action-mark"><svg><path d="u"/></svg></span><span class="topbar__action-label">Upload</span></button>
    <button class="btn topbar__action is-danger" hidden><span>Empty bin</span></button>
    <span class="todo-sync" role="status">Saving…</span>`;
  return {
    root,
    select: root.querySelector("select")!,
    list: root.querySelectorAll("button")[1] as HTMLButtonElement,
    upload: root.querySelectorAll("button")[2] as HTMLButtonElement,
  };
}
const shape = (rows: BarRow[]) =>
  rows.map((r) => (r.kind === "item" ? `${r.label}${r.checked === true ? " ✓" : r.checked === false ? " ○" : ""}` : r.kind === "sep" ? "—" : `[${r.title}]`));

describe("a bar folded into ⋯", () => {
  it("keeps the bar's order and groups; choices are ticked; hidden tools and status lines stay out", () => {
    expect(shape(barRows(bar().root))).toEqual(["[Sort]", "Recent ✓", "Title ○", "—", "[View]", "Grid ✓", "List ○", "—", "Upload"]);
  });

  it("forwards a choice to the bar's own control", () => {
    const b = bar();
    const changed = vi.fn();
    b.select.addEventListener("change", changed);
    const listClick = vi.fn();
    b.list.addEventListener("click", listClick);
    const rows = barRows(b.root);
    const pick = (label: string) => (rows.find((r) => r.kind === "item" && r.label === label) as Extract<BarRow, { kind: "item" }>).onSelect();
    pick("Title");
    expect(b.select.value).toBe("title");
    expect(changed).toHaveBeenCalledOnce();
    pick("List");
    expect(listClick).toHaveBeenCalledOnce();
  });

  it("brings a menu button's own rows in, never a menu inside a menu", () => {
    const root = document.createElement("div");
    const btn = document.createElement("button");
    btn.setAttribute("aria-haspopup", "menu");
    btn.textContent = "List options";
    root.append(btn);
    setMenuRows(btn, () => [{ kind: "section", title: "Actions" }, { kind: "item", label: "Rename list", onSelect: () => {} }]);
    expect(shape(barRows(root))).toEqual(["[Actions]", "Rename list"]);
  });

  it("reads an in-page menu's rows when the button registered none", () => {
    const root = document.createElement("div");
    root.innerHTML = `<div class="menu"><button aria-haspopup="menu" aria-label="Download"></button>
      <div class="menu__pop"><div><div class="menu__head">Whole notebook</div><button class="menu__item"><span>Supernote</span><kbd>.note</kbd></button></div></div></div>`;
    const rows = barRows(root);
    expect(shape(rows)).toEqual(["[Whole notebook]", "Supernote"]);
    expect((rows[1] as Extract<BarRow, { kind: "item" }>).ext).toBe(".note");
  });

  it("lists an action once: a repeat goes, and a section or divider it leaves empty with it", () => {
    const item = (label: string): BarRow => ({ kind: "item", label, onSelect: () => {} });
    const rows: BarRow[] = [item("Version history"), item("Download"), { kind: "sep" }, { kind: "section", title: "Actions" }, item("Version history"), { kind: "sep" }, item("Restore")];
    expect(shape(onceEach(rows))).toEqual(["Version history", "Download", "—", "Restore"]);
  });

  it("keeps rows that share a name in different sections: two views, two files", () => {
    const item = (label: string): BarRow => ({ kind: "item", label, onSelect: () => {} });
    const rows: BarRow[] = [
      { kind: "section", title: "This page — current view" },
      item("PDF document"),
      { kind: "sep" },
      { kind: "section", title: "This page — original view" },
      item("PDF document"),
    ];
    expect(shape(onceEach(rows))).toEqual(["[This page — current view]", "PDF document", "—", "[This page — original view]", "PDF document"]);
  });

  it("brings a short menu's rows in, and puts a long one behind one row", () => {
    const root = document.createElement("div");
    const short = document.createElement("button");
    short.textContent = "List options";
    const long = document.createElement("button");
    long.textContent = "Download";
    root.append(short, long);
    const many = (n: number): BarRow[] => Array.from({ length: n }, (_, i) => ({ kind: "item", label: `Row ${i}`, onSelect: () => {} }));
    setMenuRows(short, () => many(2));
    setMenuRows(long, () => many(SUBMENU_AT + 1));
    const rows = barRows(root);
    expect(shape(rows.filter((r) => r.kind !== "sub"))).toEqual(["Row 0", "Row 1"]);
    const sub = rows.find((r) => r.kind === "sub");
    expect(sub && sub.kind === "sub" ? [sub.label, sub.rows.length] : null).toEqual(["Download", SUBMENU_AT + 1]);
  });
});
