// A shared modal confirm <dialog>, built per call and removed on close.
//
// Both the recycle bin's purge/empty confirm and the admin console's
// destructive prompts hand-rolled the SAME native-<dialog> scaffold. This is
// that scaffold, once. The two callers differ only in class names (so their
// existing CSS and e2e selectors carry over untouched) and in what they build
// into the body, both passed in.
//
// The two rules the shape is built around, and why they are the platform's job:
//
//   * A native <dialog> gives the modal focus trap, Escape-to-dismiss, and the
//     inertness of the page behind it — three things not worth re-implementing.
//   * `method="dialog"` puts the pressed button's `value` in `returnValue`, and
//     the FIRST submit button is the one Enter activates. So Cancel comes FIRST
//     in DOM order and takes `autofocus`: the safe answer is the default one, and
//     a stray Return never reaches the destructive button. Escape (and the
//     backdrop) close with an empty `returnValue`, which reads as cancel too.
//
// Built per call and removed on close because the per-invocation pieces (a
// type-to-confirm listener, a disabled state, the focus target) are exactly what
// leak from one prompt into the next when a single node is reused.

import { el } from "./dom";

/** The class names each caller stamps on the dialog's parts, so its own CSS and
 *  e2e selectors keep matching (`confirm*`/`.btn` for the bin, `admin-dialog*`/
 *  `.admin-btn` for the console). */
export interface DialogClasses {
  /** The `<dialog>` element itself. */
  dialog: string;
  /** The body wrapper the `build` callback fills. */
  body: string;
  /** The trailing button row. */
  actions: string;
  /** The Cancel button — space-separated classes allowed. */
  cancel: string;
  /** The confirming ("go") button — space-separated classes allowed. */
  go: string;
}

/** The two action buttons, handed to `build` so a caller can finish wiring them
 *  (e.g. an `aria-label`, or gating `go` on a type-to-confirm field). */
export interface DialogButtons {
  cancel: HTMLButtonElement;
  go: HTMLButtonElement;
}

export interface OpenDialogOptions {
  /** Where to append the dialog (it is removed again on close). */
  host: HTMLElement;
  classes: DialogClasses;
  /** The confirming button's label — always says what it does, never "OK". */
  goLabel: string;
  /** The safe button's label, usually "Cancel". */
  cancelLabel: string;
  /** Fill the body and, if needed, finish wiring the buttons. */
  build: (body: HTMLElement, buttons: DialogButtons) => void;
  /** `aria-labelledby` target id, when the body carries a titled heading. */
  labelledBy?: string;
}

/** Open the dialog. `done` resolves true only when the confirming button was the
 *  one pressed; every other dismissal (Cancel, Escape, the backdrop) is false. */
export function openDialog(opts: OpenDialogOptions): {
  node: HTMLDialogElement;
  done: Promise<boolean>;
} {
  const cancel = el("button", {
    class: opts.classes.cancel,
    type: "submit",
    value: "cancel",
    text: opts.cancelLabel,
    autofocus: true,
  });
  // Cancel must never be blocked by a `required` field it is trying to abandon —
  // without this an empty required box makes Cancel silently do nothing and the
  // only way out is Escape. Harmless where the body has no fields.
  cancel.formNoValidate = true;
  const go = el("button", {
    class: opts.classes.go,
    type: "submit",
    value: "go",
    text: opts.goLabel,
  });
  const body = el("div", { class: opts.classes.body });
  const attrs: Record<string, unknown> = { class: opts.classes.dialog };
  if (opts.labelledBy) attrs["aria-labelledby"] = opts.labelledBy;
  const node = el(
    "dialog",
    attrs,
    el("form", { method: "dialog" }, body, el("div", { class: opts.classes.actions }, cancel, go)),
  );
  opts.build(body, { cancel, go });
  opts.host.append(node);

  const done = new Promise<boolean>((resolve) => {
    node.addEventListener("close", () => {
      const ok = node.returnValue === "go";
      node.remove();
      resolve(ok);
    });
  });
  node.returnValue = "";
  node.showModal();
  return { node, done };
}
