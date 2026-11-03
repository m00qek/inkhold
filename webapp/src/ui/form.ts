// Shared form primitives for the auth pages: a labelled underline field and an
// accessible status/error region.

import { el } from "./dom";

export interface FieldOpts {
  id: string;
  label: string;
  type?: string;
  autocomplete?: string;
  autofocus?: boolean;
  required?: boolean;
  minLength?: number;
  hint?: string;
}

export interface Field {
  row: HTMLElement;
  input: HTMLInputElement;
}

/** A label + underline input, arranged so the input reads as a line to write on. */
export function field(opts: FieldOpts): Field {
  const input = el("input", {
    id: opts.id,
    class: "field__input",
    type: opts.type ?? "text",
    autocomplete: opts.autocomplete ?? "off",
    required: opts.required ?? true,
    autocapitalize: "off",
    spellcheck: false,
  });
  if (opts.minLength) input.minLength = opts.minLength;
  if (opts.autofocus) {
    input.autofocus = true;
    // `autofocus` only fires for elements present at parse time, not inserted ones.
    queueMicrotask(() => input.focus());
  }

  const label = el("label", { class: "field__label", htmlFor: opts.id, text: opts.label });
  const children: (Node | string)[] = [label, input];
  if (opts.hint) {
    const hintId = `${opts.id}-hint`;
    input.setAttribute("aria-describedby", hintId);
    children.push(el("p", { class: "field__hint", id: hintId, text: opts.hint }));
  }
  return { row: el("div", { class: "field" }, ...children), input };
}

export interface Status {
  node: HTMLElement;
  error(message: string): void;
  info(message: string): void;
  clear(): void;
}

/** A single live region the forms use for progress and error messages. */
export function statusLine(): Status {
  const node = el("p", { class: "status", role: "status", "aria-live": "polite" });
  const set = (message: string, kind: "error" | "info") => {
    node.textContent = message;
    node.classList.toggle("status--error", kind === "error");
    node.setAttribute("aria-live", kind === "error" ? "assertive" : "polite");
  };
  return {
    node,
    error: (m) => set(m, "error"),
    info: (m) => set(m, "info"),
    clear: () => {
      node.textContent = "";
      node.classList.remove("status--error");
    },
  };
}
