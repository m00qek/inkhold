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
