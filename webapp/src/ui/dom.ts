// Minimal DOM helpers for building UI without a framework.

type Child = Node | string | null | undefined | false;

interface Attrs {
  class?: string;
  text?: string;
  html?: string;
  [key: string]: unknown;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = String(value);
    else if (key === "text") node.textContent = String(value);
    else if (key === "html") node.innerHTML = String(value);
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key in node) {
      (node as Record<string, unknown>)[key] = value;
    } else {
      node.setAttribute(key, String(value));
    }
  }
  for (const child of children) {
    if (child == null || child === false) continue;
    node.append(child);
  }
  return node;
}

/** Replaces the contents of a mount point with a single node. */
export function mount(root: HTMLElement, node: Node): void {
  root.replaceChildren(node);
}

/**
 * An element's box less its padding, in CSS px: the room its content has. A
 * viewer's stage pads itself clear of bars and sheets, so Fit measures this,
 * not the bare rect. `w` is 0 while the element is not laid out.
 */
export function contentBox(e: HTMLElement): { w: number; h: number } {
  const rect = e.getBoundingClientRect();
  const cs = getComputedStyle(e);
  const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
  const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
  return { w: rect.width <= 0 ? 0 : rect.width - padX, h: rect.height - padY };
}

/**
 * Scroll `scroller` so `target` is in its visible box: centred when it was
 * off-screen, left alone when it is already in view. Moves only `scroller`,
 * never the page around it (`scrollIntoView` would).
 */
export function revealIn(target: Element, scroller: HTMLElement): void {
  const t = target.getBoundingClientRect();
  const s = scroller.getBoundingClientRect();
  const cs = getComputedStyle(scroller);
  const top = s.top + (parseFloat(cs.paddingTop) || 0);
  const bottom = s.bottom - (parseFloat(cs.paddingBottom) || 0);
  const left = s.left + (parseFloat(cs.paddingLeft) || 0);
  const right = s.right - (parseFloat(cs.paddingRight) || 0);
  if (t.top >= top && t.bottom <= bottom && t.left >= left && t.right <= right) return;
  scroller.scrollTop += t.top + t.height / 2 - (top + bottom) / 2;
  scroller.scrollLeft += t.left + t.width / 2 - (left + right) / 2;
}

/**
 * Which control an element is, so the same one can be found after its
 * container is rebuilt: a link by where it leads (its text grows as search
 * results fill in), anything else by its label and text.
 */
function controlIdentity(e: Element): string {
  const href = e.getAttribute("href");
  const what = href !== null ? href : `${e.getAttribute("aria-label") ?? ""}|${(e.textContent ?? "").trim()}`;
  return `${e.tagName}|${e.className}|${what}`;
}

/**
 * Rebuild `container` with `rebuild`, and give focus back to the same control
 * if it was inside: a repaint must not throw a keyboard user out of a list
 * (a late search answer rebuilds the results under them).
 */
export function keepingFocus(container: HTMLElement, rebuild: () => void): void {
  const had = document.activeElement;
  const id = had instanceof HTMLElement && had !== container && container.contains(had) ? controlIdentity(had) : null;
  rebuild();
  if (id === null || container.contains(document.activeElement)) return;
  for (const e of container.querySelectorAll<HTMLElement>(had!.tagName)) {
    if (controlIdentity(e) === id) {
      e.focus({ preventScroll: true });
      return;
    }
  }
}
