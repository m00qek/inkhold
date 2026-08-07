// The RENAME dialog — a small native-`<dialog>` that
// renames a file or folder. It mirrors the shared `confirm.ts` scaffold (a native
// `<dialog>` for the modal focus trap, Escape-to-dismiss and page inertness for
// free) but does NOT reuse `openDialog`, for two reasons the shape turns on:
//
//   * confirm's action is DESTRUCTIVE, so it autofocuses Cancel and makes Enter
//     activate it. Rename's safe default is "apply what I typed", so it
//     autofocuses the FIELD (selecting the stem, the way every OS rename does)
//     and makes Enter → Rename.
//   * A name clash must keep the dialog OPEN. `openDialog` resolves and removes
//     the node on any close; rename instead runs the write ITSELF and only
//     closes on success — a 409 shows the collision line and stays put.
//
// The one considered touch is the "label" treatment: the editable STEM on a
// ruled paper field with the immutable EXTENSION beside it as a Space Mono `<kbd>`
// chip — the same chip motif the download rows use (cardActions.ts) — so renaming
// reads as re-labelling a notebook's spine. A folder (no extension) gets the
// plain field, no chip. The CSS lives in 17-rename.css.

import { el } from "./dom";
import { NameTakenError } from "../api/client";

/** Escape a string for literal use inside a `RegExp`. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Split a name into the editable STEM and its immutable EXTENSION, by the
 * entry's OWN `fileType` (case-insensitively), the way the `.spd` export peels
 * `.spd` — NOT a naive last-dot split, so `2026.07.20.note` peels to stem
 * `2026.07.20` + ext `.note` rather than losing the date.
 *
 * The returned `ext` is the ACTUAL trailing text of the name (its real casing,
 * e.g. `.NOTE`), so re-assembling `stem + ext` never silently changes the
 * extension's case. A folder, an entry with no `fileType`, or a name that does
 * not end in the expected extension yields the whole name as the stem with an
 * empty `ext` (no chip) — the defensive path the spec calls for.
 */
export function peelName(name: string, fileType: string, isFolder: boolean): { stem: string; ext: string } {
  const type = (fileType || "").trim();
  if (isFolder || type === "") return { stem: name, ext: "" };
  const m = name.match(new RegExp("\\." + escapeRegExp(type) + "$", "i"));
  if (!m) return { stem: name, ext: "" };
  const ext = m[0]; // the real trailing ".note"/".NOTE", casing preserved
  return { stem: name.slice(0, name.length - ext.length), ext };
}

/** The outcome of validating the stem field, and the inline line to show. */
export interface RenameValidation {
  /** Whether Rename may fire — a non-empty, legal, CHANGED stem. */
  ok: boolean;
  /**
   * The interface-voice helper/error line, or null when there is nothing to say
   * (a valid change, or an unchanged stem — disabled but not an error). Exactly
   * the copy the rename dialog was specified with.
   */
  message: string | null;
}

/**
 * Whether a stem carries something a name may not: the path separator, or any
 * control character. Written as a codepoint scan rather than a regex with
 * literal control bytes, so the source stays plain text.
 */
function hasIllegalChar(s: string): boolean {
  if (s.includes("/")) return true;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

/**
 * Validate a typed stem against the one it started as. Disables Rename when the
 * stem is empty/whitespace, contains a `/` or a control character, or is
 * unchanged (nothing to do). The messages are the interface's own words.
 */
export function validateRename(input: string, originalStem: string): RenameValidation {
  const trimmed = input.trim();
  if (trimmed === "") return { ok: false, message: "Enter a name." };
  if (hasIllegalChar(input)) return { ok: false, message: "A name can't contain '/'." };
  // Unchanged is disabled but SILENT — the field simply holds what it always
  // held, which is not an error to narrate.
  if (trimmed === originalStem.trim()) return { ok: false, message: null };
  return { ok: true, message: null };
}

export interface RenameEntry {
  /** The current FULL name, extension included. */
  name: string;
  /** The entry's verified type (`"note"`, `"pdf"`, …); ignored for a folder. */
  fileType?: string;
  isFolder: boolean;
}

export interface RenameDialogOptions {
  /** Where to append the dialog (removed again on close). */
  host: HTMLElement;
  entry: RenameEntry;
  /**
   * Perform the rename with the assembled full name (`stem.trim() + ext`, or
   * just `stem.trim()` for a folder). Resolving CLOSES the dialog (a success).
   * Throwing {@link NameTakenError} keeps it OPEN with the collision line and
   * re-selects the field. Any other throw closes it — the caller is expected to
   * have already routed that failure (session expiry, a toast) before it lands
   * here, so there is nothing left for the dialog to say.
   */
  submit: (fullName: string) => Promise<void>;
}

/**
 * Open the rename dialog. Resolves `true` when the rename went through, `false`
 * on cancel/Escape (or a non-clash failure the caller already handled).
 */
export function openRenameDialog(opts: RenameDialogOptions): Promise<boolean> {
  const { stem, ext } = peelName(opts.entry.name, opts.entry.fileType ?? "", opts.entry.isFolder);

  const titleId = "rename-title";
  const helpId = "rename-help";
  const input = el("input", {
    class: "rename__field",
    type: "text",
    value: stem,
    autocomplete: "off",
    spellcheck: "false",
    "aria-label": "Name",
    "aria-describedby": helpId,
  }) as HTMLInputElement;
  // The immutable extension, as the Space Mono chip beside the field — the same
  // `<kbd>` motif the download rows carry. Folders (no extension) get no chip.
  const chip = ext ? el("kbd", { class: "rename__ext", text: ext }) : null;
  const field = el("div", { class: "rename__row" }, input, chip);
  const help = el("p", { class: "rename__help", id: helpId, "aria-live": "polite" });

  const cancel = el("button", { class: "btn rename__cancel", type: "button", text: "Cancel" }) as HTMLButtonElement;
  const go = el("button", { class: "btn rename__go", type: "button", text: "Rename" }) as HTMLButtonElement;
  const actions = el("div", { class: "rename__actions" }, cancel, go);

  const body = el(
    "div",
    { class: "rename__body" },
    el("h2", { id: titleId, class: "rename__title", text: "Rename" }),
    field,
    help,
  );
  // `method="dialog"` is kept for the platform close semantics, but every button
  // is `type="button"` and Enter is intercepted, so a submit never closes the
  // dialog behind the async write — the write decides.
  const form = el("form", { method: "dialog" }, body, actions);
  const node = el("dialog", { class: "rename", "aria-labelledby": titleId }, form) as HTMLDialogElement;

  let renamed = false;
  let busy = false;

  function render(v: RenameValidation): void {
    go.disabled = !v.ok;
    help.textContent = v.message ?? "";
    // Only a real problem (empty / illegal / clash) colours the line; an
    // unchanged stem is disabled but says nothing, so it carries no error tint.
    node.classList.toggle("is-error", v.message !== null);
  }

  async function attempt(): Promise<void> {
    if (busy) return;
    const v = validateRename(input.value, stem);
    if (!v.ok) {
      render(v);
      input.focus();
      return;
    }
    const trimmed = input.value.trim();
    const full = opts.entry.isFolder || ext === "" ? trimmed : trimmed + ext;
    busy = true;
    go.disabled = true;
    cancel.disabled = true;
    input.disabled = true;
    try {
      await opts.submit(full);
      renamed = true;
      node.close();
    } catch (e) {
      busy = false;
      input.disabled = false;
      cancel.disabled = false;
      if (e instanceof NameTakenError) {
        // The SERVER is the authority on a clash (the client's listing may be
        // partial), so this line only appears once the write comes back 409.
        help.textContent = "That name's already used here.";
        node.classList.add("is-error");
        input.focus();
        input.select();
        // Leave Rename enabled so a single edit can re-fire; `input` re-validates.
        go.disabled = false;
      } else {
        // The caller already handled it (routed a dead session, toasted a
        // failure); there is nothing to keep the dialog open for.
        node.close();
      }
    }
  }

  input.addEventListener("input", () => render(validateRename(input.value, stem)));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault(); // never let a form submit close the dialog itself
      void attempt();
    }
  });
  go.addEventListener("click", (e) => {
    e.preventDefault();
    void attempt();
  });
  cancel.addEventListener("click", () => node.close());

  return new Promise<boolean>((resolve) => {
    node.addEventListener("close", () => {
      node.remove();
      resolve(renamed);
    });
    opts.host.append(node);
    node.showModal();
    // The safe default is "apply what I typed": land on the field with the stem
    // selected (type-to-replace, or click to edit — every OS rename).
    input.focus();
    input.select();
    // Prime the disabled state: an unchanged stem starts with Rename disabled.
    render(validateRename(input.value, stem));
  });
}
