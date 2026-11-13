// A tablet app's two dialogs: a name asked for (a new list or category, or a
// rename), and the confirmation before a place goes with what it holds. Built
// on the shared `confirm` dialog and the rename field; To-Do and Digest say
// their own words through them. Styles: `styles/17-rename.css`.

import { el } from "./dom";
import { openDialog } from "./confirm";

const DIALOG = { dialog: "confirm name-dialog", body: "confirm__body", actions: "confirm__actions", cancel: "btn", go: "btn" };

export interface NameAsk {
  title: string;
  goLabel: string;
  initial: string;
  /** The longest name the app takes, in characters; the field stops there. */
  maxLength?: number;
  /** Why a name can't be used, in a sentence (said as the person types); null when it can. */
  problem?: (name: string) => string | null;
  /** A quiet line under the field while the name is fine (its length, what happens next). */
  hint?: (name: string) => string;
}

/** A name, trimmed, or null when cancelled or left as it was. */
export function askName(o: NameAsk): Promise<string | null> {
  const input = el("input", {
    class: "rename__field",
    type: "text",
    id: "name-dialog-field",
    "aria-label": "Name",
    "aria-describedby": "name-dialog-problem name-dialog-hint",
    autocomplete: "off",
    spellcheck: "false",
    maxlength: o.maxLength ? String(o.maxLength) : null,
    value: o.initial,
  }) as HTMLInputElement;
  // Only what is wrong is announced; the count under it is read when asked for, not at every key.
  const problemLine = el("p", { class: "name-dialog__problem", id: "name-dialog-problem", "aria-live": "polite" });
  const hintLine = el("p", { class: "name-dialog__hint", id: "name-dialog-hint" });
  const { done } = openDialog({
    host: document.body,
    classes: DIALOG,
    goLabel: o.goLabel,
    cancelLabel: "Cancel",
    labelledBy: "name-dialog-title",
    build: (content, { go }) => {
      content.append(el("h2", { id: "name-dialog-title", text: o.title }), input, problemLine, hintLine);
      const check = () => {
        const name = input.value.trim();
        const problem = name === "" ? null : (o.problem?.(name) ?? null);
        // Always there, empty when the name is fine: a live region that appears
        // and speaks in one moment is seldom read out.
        if (problemLine.textContent !== (problem ?? "")) problemLine.textContent = problem ?? "";
        hintLine.textContent = problem === null && o.hint ? o.hint(name) : "";
        hintLine.hidden = hintLine.textContent === "";
        go.disabled = name === "" || name === o.initial || problem !== null;
      };
      input.addEventListener("input", check);
      check();
      input.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        if (!go.disabled) go.click();
      });
    },
  });
  // The name is what is being asked for: focus it, not Cancel.
  input.focus();
  input.select();
  return done.then((ok) => (ok ? input.value.trim() : null));
}

/** True when the person confirmed; the go button is the danger one. */
export function confirmDelete(o: { title: string; body: string; goLabel: string }): Promise<boolean> {
  return openDialog({
    host: document.body,
    classes: { ...DIALOG, go: "btn is-danger" },
    goLabel: o.goLabel,
    cancelLabel: "Cancel",
    labelledBy: "name-dialog-title",
    build: (content) => content.append(el("h2", { id: "name-dialog-title", text: o.title }), el("p", { text: o.body })),
  }).done;
}
