// THE NAME-CONFLICT PROMPT — what the interface asks
// when a dropped file is already in the folder.
//
// WHY IT ASKS AT ALL, since the server can silently auto-rename: the main use of
// web upload is to UPDATE a file — you edit a PDF on your laptop and drop it back
// — and a silent `notes (2).pdf` gets that exactly wrong, twice over. You end up
// with two files, and both of them sync to a device where clutter is expensive.
//
// WHY THE CHOICE IS SAFE TO OFFER, which is the fact the copy has to carry:
// replacing supersedes the occupant through the same path a device re-uploading
// an edited note takes, so the displaced file is kept as a VERSION and can be
// restored from the version history the app already ships. Neither answer
// destroys anything — and a user who does not know that will always pick "Keep
// both", so the dialog says it in the body rather than leaving it to be inferred.
//
// IT ASKS BEFORE ANY BYTES MOVE. The clash is detected against the listing the
// app already holds, so the alternative — upload, take a 409, upload again — is
// never paid for. On a slow link that is the difference between one transfer and
// two.
//
// The scaffold mirrors `renameDialog.ts` (a native `<dialog>` for the modal focus
// trap, Escape-to-dismiss and page inertness for free); the CSS lives in
// 18-upload.css.

import { el } from "./dom";
import { nextAvailableName } from "../core/fileKind";
import type { UploadConflictMode } from "../api/client";

/** What the person chose. `cancel` is Escape and the Cancel button alike. */
export type ConflictChoice = UploadConflictMode | "cancel";

export interface ConflictAnswer {
  choice: ConflictChoice;
  /**
   * Apply this same answer to every remaining conflict in this batch, instead of
   * asking again. False when the box was not offered (a single conflict).
   */
  applyToRest: boolean;
}

export interface ConflictRequest {
  /** Where the dialog mounts (removed again on close). */
  host: HTMLElement;
  /** The dropped file's name — the one that clashes. */
  name: string;
  /** Every name already in the destination, so the "Keep both" preview is real. */
  taken: readonly string[];
  /** How many OTHER conflicts are still waiting in this batch. `> 0` offers the
   *  "do the same for the rest" box — a drop of ten files must not become ten
   *  dialogs. */
  remaining: number;
}

/**
 * Ask what to do about one clashing name. Resolves with the choice; `cancel`
 * means nothing at all is sent for that file.
 */
export function openConflictDialog(req: ConflictRequest): Promise<ConflictAnswer> {
  const keptName = nextAvailableName(req.name, req.taken);

  const titleId = "conflict-title";
  const title = el("h2", {
    id: titleId,
    class: "conflict__title",
    text: `'${req.name}' is already here`,
  });
  // The two facts that make the choice easy, in the order they are needed: what
  // "Keep both" would produce (so the outcome is not a surprise), and that
  // "Replace" is reversible (so it is not scary).
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

  // KEEP BOTH IS THE DEFAULT, and deliberately not Replace. Both are safe, but
  // only one of them leaves the file that is already there exactly as it was, so
  // it is the answer an accidental Enter should give.
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
      // The box applies to CANCEL too — "do the same for the other files" reads
      // as "stop asking", and someone who dropped the wrong folder wants one
      // click, not eight.
      resolve({ choice, applyToRest: restBox.checked });
    });
    req.host.append(node);
    node.showModal();
    keep.focus();
  });
}
