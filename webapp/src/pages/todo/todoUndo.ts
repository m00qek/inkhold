// The Undo after deleting a task: the recycle bin's toast, reused as is. It is
// in the document only while it shows, so the bin's own toast stays the only
// `.bin-toast` anywhere else.

import { el } from "../../ui/dom";

/** Matches the toast's slide-out transition in 08-bin.css. */
const SLIDE_MS = 260;

export interface UndoToast {
  show(title: string): void;
  hide(): void;
  destroy(): void;
}

export function createUndoToast(onUndo: () => void): UndoToast {
  const msg = el("span", { class: "bin-toast__msg" });
  const sub = el("span", { class: "bin-toast__sub", text: "It leaves the tablet at its next sync." });
  const undo = el("button", { class: "bin-toast__action", type: "button", text: "Undo" });
  const bar = el("div", { class: "bin-toast todo-undo", role: "status", "aria-live": "polite" }, el("span", { class: "bin-toast__lines" }, msg, sub), undo);
  undo.addEventListener("click", onUndo);
  let gone: ReturnType<typeof setTimeout> | undefined;

  return {
    show(title) {
      clearTimeout(gone);
      msg.textContent = `Deleted "${title}"`;
      if (!bar.isConnected) {
        document.body.append(bar);
        void bar.offsetWidth; // so it slides in rather than appearing
      }
      bar.classList.add("is-shown");
    },
    hide() {
      bar.classList.remove("is-shown");
      clearTimeout(gone);
      gone = setTimeout(() => bar.remove(), SLIDE_MS);
    },
    destroy() {
      clearTimeout(gone);
      bar.remove();
    },
  };
}
