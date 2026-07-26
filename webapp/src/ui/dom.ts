// Minimal DOM helpers — enough to build forms without a framework, keeping the
// app shell dependency-free. `el` creates an element, applies attributes/props,
// and appends children (strings become text nodes).

type Child = Node | string | null | undefined | false;

interface Attrs {
  class?: string;
  text?: string;
  html?: string;
  // Event handlers, e.g. { onClick, onSubmit, onInput }.
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
      // Prefer the DOM property (e.g. `value`, `disabled`, `type`, `htmlFor`).
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
