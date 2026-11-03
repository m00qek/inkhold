// A shared native modal confirm <dialog>, built per call and removed on close
// so per-prompt listeners and state never leak into the next one. Cancel comes
// first in DOM order with `autofocus`, so Enter takes the safe answer; Escape
// and the backdrop close with an empty `returnValue`, also read as cancel.

import { el } from "./dom";

/** Caller class names, so existing CSS and e2e selectors keep matching. */
export interface DialogClasses {
  dialog: string;
  body: string;
  actions: string;
  cancel: string;
  go: string;
}

export interface DialogButtons {
  cancel: HTMLButtonElement;
  go: HTMLButtonElement;
}

export interface OpenDialogOptions {
  host: HTMLElement;
  classes: DialogClasses;
  goLabel: string;
  cancelLabel: string;
  build: (body: HTMLElement, buttons: DialogButtons) => void;
  labelledBy?: string;
}

/** `done` resolves true only when the confirming button was pressed. */
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
  // Cancel must not be blocked by a `required` field it is abandoning.

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
