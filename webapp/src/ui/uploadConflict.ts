// The name-conflict prompt for a dropped file whose name is already taken.
// Asked before any bytes move, because web upload is mostly for updating a file
// and a silent auto-rename gets that wrong. Replace keeps the displaced file as
// a version, so the body says neither answer destroys anything.

import { el } from "./dom";
import { nextAvailableName } from "../core/fileKind";
import type { UploadConflictMode } from "../api/client";

export type ConflictChoice = UploadConflictMode | "cancel";

export interface ConflictAnswer {
  choice: ConflictChoice;
  /** Apply this answer to the rest of the batch; false when not offered. */
  applyToRest: boolean;
}

export interface ConflictRequest {
  host: HTMLElement;
  name: string;
  taken: readonly string[];
  /** Other conflicts still waiting; `> 0` offers "do the same for the rest". */
  remaining: number;
}

/** Ask about one clashing name; `cancel` means nothing is sent for that file. */
export function openConflictDialog(req: ConflictRequest): Promise<ConflictAnswer> {
  const keptName = nextAvailableName(req.name, req.taken);

  const titleId = "conflict-title";
  const title = el("h2", {
    id: titleId,
    class: "conflict__title",
    text: `'${req.name}' is already here`,
  });
  const body = el("p", {
    class: "conflict__body",
    text: `Keep both saves it as '${keptName}'. Replace makes the file that's there now a version you can restore.`,
  });

  const restId = "conflict-rest";
  const restBox = el("input", { class: "conflict__rest-box", type: "checkbox", id: restId }) as HTMLInputElement;
  const rest =
    req.remaining > 0
      ? el(
          "label",
          { class: "conflict__rest", for: restId },
          restBox,
          el("span", {
            text:
              req.remaining === 1
                ? "Do the same for the other file"
                : `Do the same for the other ${req.remaining} files`,
          }),
        )
      : null;

  const cancel = el("button", { class: "btn conflict__cancel", type: "button", text: "Cancel" }) as HTMLButtonElement;
  const keep = el("button", { class: "btn conflict__keep", type: "button", text: "Keep both" }) as HTMLButtonElement;
  const replace = el("button", { class: "btn conflict__replace", type: "button", text: "Replace" }) as HTMLButtonElement;

  const node = el(
    "dialog",
    { class: "conflict", "aria-labelledby": titleId },
    el(
      "form",
      { method: "dialog" },
      el("div", { class: "conflict__panel" }, title, body, rest),
      el("div", { class: "conflict__actions" }, cancel, keep, replace),
    ),
  ) as HTMLDialogElement;

  // Keep both is the default: it is the answer an accidental Enter should give.
  let choice: ConflictChoice = "cancel";

  return new Promise<ConflictAnswer>((resolve) => {
    const close = (c: ConflictChoice): void => {
      choice = c;
      node.close();
    };
    cancel.addEventListener("click", () => close("cancel"));
    keep.addEventListener("click", () => close("rename"));
    replace.addEventListener("click", () => close("replace"));
    node.addEventListener("close", () => {
      node.remove();
      // The box applies to Cancel too ("stop asking").
      resolve({ choice, applyToRest: restBox.checked });
    });
    req.host.append(node);
    node.showModal();
    keep.focus();
  });
}
