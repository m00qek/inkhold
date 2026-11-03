// The rename dialog. Not built on `openDialog`: it autofocuses the field (stem
// selected) so Enter applies the rename, and a 409 clash must keep it open.

import { el } from "./dom";
import { NameTakenError } from "../api/client";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Split a name into editable stem and immutable extension by the entry's own
 * `fileType` (so `2026.07.20.note` keeps its date); `ext` keeps its real casing.
 * No match yields the whole name as stem and an empty `ext`.
 */
export function peelName(name: string, fileType: string, isFolder: boolean): { stem: string; ext: string } {
  const type = (fileType || "").trim();
  if (isFolder || type === "") return { stem: name, ext: "" };
  const m = name.match(new RegExp("\\." + escapeRegExp(type) + "$", "i"));
  if (!m) return { stem: name, ext: "" };
  const ext = m[0]; // casing preserved
  return { stem: name.slice(0, name.length - ext.length), ext };
}

export interface RenameValidation {
  ok: boolean;
  message: string | null;
}

/** Path separator or any control character. */
function hasIllegalChar(s: string): boolean {
  if (s.includes("/")) return true;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

/** Validate a typed stem; empty, illegal or unchanged stems disable Rename. */
export function validateRename(input: string, originalStem: string): RenameValidation {
  const trimmed = input.trim();
  if (trimmed === "") return { ok: false, message: "Enter a name." };
  if (hasIllegalChar(input)) return { ok: false, message: "A name can't contain '/'." };
  // Unchanged is disabled but silent.
  if (trimmed === originalStem.trim()) return { ok: false, message: null };
  return { ok: true, message: null };
}

export interface RenameEntry {
  name: string;
  fileType?: string;
  isFolder: boolean;
}

export interface RenameDialogOptions {
  host: HTMLElement;
  entry: RenameEntry;
  /**
   * Rename to the assembled full name. Resolving closes the dialog; throwing
   * {@link NameTakenError} keeps it open with the collision line; any other
   * throw closes it (the caller has already reported it).
   */
  submit: (fullName: string) => Promise<void>;
}

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
  // Every button is `type="button"` and Enter is intercepted, so only the async
  // write decides when the dialog closes.
  const form = el("form", { method: "dialog" }, body, actions);
  const node = el("dialog", { class: "rename", "aria-labelledby": titleId }, form) as HTMLDialogElement;

  let renamed = false;
  let busy = false;

  function render(v: RenameValidation): void {
    go.disabled = !v.ok;
    help.textContent = v.message ?? "";
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
        // The server is the authority on a clash; the listing may be partial.
        help.textContent = "That name's already used here.";
        node.classList.add("is-error");
        input.focus();
        input.select();
        go.disabled = false;
      } else {
        node.close();
      }
    }
  }

  input.addEventListener("input", () => render(validateRename(input.value, stem)));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
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
    input.focus();
    input.select();

    render(validateRename(input.value, stem));
  });
}
