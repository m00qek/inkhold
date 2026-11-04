// The account page's Versions control: keep the last N of each file, with the
// discard notice before saving. Owns its policy state.

import { el } from "../../ui/dom";
import { formatBytes } from "../../core/fileKind";
import type { VersionPolicy } from "../../api/accountTypes";
import type { AccountApi } from "./account";
import { failed, pending, type Load } from "./accountDom";
import { discardNotice, failureMessage } from "./accountCopy";

export interface VersionsDeps {
  api: Pick<AccountApi, "setVersionPolicy">;
  body: HTMLElement;
  toast: (message: string) => void;
  handled: (e: unknown) => boolean;
  generation: () => number;
  /** After a save; the storage figures moved. */
  onSaved: (generation: number) => void;
}

export interface VersionsControl {
  set(policy: Load<VersionPolicy>): void;
  render(): void;
  isReady(): boolean;
}

export function createVersionsControl(deps: VersionsDeps): VersionsControl {
  const body = deps.body;
  let policy: Load<VersionPolicy> = { kind: "loading" };
  let savingPolicy = false;

  // No byte figure on this line: beside a pending change it read as the cost.
  // Bounded above by the server; global `max_bytes` is a backstop.

  // A stepper: the value moves by one, and native spinners vanish on some platforms.
  const keepInput = el("input", {
    class: "acct-keep acct-data",
    id: "acct-keep",
    type: "number",
    inputmode: "numeric",
    min: "0",
    step: "1",
    "aria-describedby": "acct-keep-note",
  }) as HTMLInputElement;
  const keepDown = el("button", {
    class: "acct-step",
    type: "button",
    "aria-label": "Keep one fewer",
    text: "−", // MINUS SIGN, not a hyphen — it sits on the digits' baseline
  }) as HTMLButtonElement;
  const keepUp = el("button", {
    class: "acct-step",
    type: "button",
    "aria-label": "Keep one more",
    text: "+",
  }) as HTMLButtonElement;
  const keepStepper = el("div", { class: "acct-stepper" }, keepDown, keepInput, keepUp);

  /** Same path as typing, so notice, Save and bounds behave the same. */
  function step(by: number): void {
    if (policy.kind !== "ready") return;
    const from = typedKeep() ?? policy.data.keep;
    const next = Math.min(Math.max(from + by, 0), policy.data.maxKeep);
    keepInput.value = String(next);
    updateKeepNote();
  }
  keepDown.addEventListener("click", () => step(-1));
  keepUp.addEventListener("click", () => step(1));
  const keepNote = el("p", { class: "acct-keep__note", id: "acct-keep-note", role: "status", "aria-live": "polite" });
  const keepSave = el("button", { class: "acct-btn acct-btn--go acct-keep__save", type: "button", text: "Save", hidden: true });
  const keepLine = el(
    "div",
    { class: "acct-keep__line" },
    el("label", { class: "acct-keep__label", htmlFor: "acct-keep", text: "Keep the last" }),
    keepStepper,
    el("span", { class: "acct-keep__of", text: "of each file" }),
    keepSave,
  );

  keepInput.addEventListener("input", () => updateKeepNote());
  keepSave.addEventListener("click", () => void savePolicy());

  function typedKeep(): number | null {
    const raw = keepInput.value.trim();
    if (raw === "") return null;
    const n = Number.parseInt(raw, 10);
    return Number.isSafeInteger(n) ? n : null;
  }

  function updateKeepNote(): void {
    if (policy.kind !== "ready") return;
    const p = policy.data;
    const typed = typedKeep();
    if (typed === null) {
      keepNote.textContent = "";
      keepSave.hidden = true;
      return;
    }
    if (typed > p.maxKeep) {
      keepNote.textContent = `This server keeps at most ${p.maxKeep} for each file.`;
      keepSave.hidden = true;
      return;
    }
    if (typed < 0) {
      keepNote.textContent = "The fewest you can keep is 0.";
      keepSave.hidden = true;
      return;
    }
    keepNote.textContent = typed === p.keep ? "" : (discardNotice(p.retainedPerFile, typed) ?? "");
    keepSave.hidden = typed === p.keep;
  }

  function renderPolicy(): void {
    if (policy.kind === "loading") {
      body.replaceChildren(pending());
      return;
    }
    if (policy.kind === "failed") {
      body.replaceChildren(failed(policy.message));
      return;
    }
    const p = policy.data;
    keepInput.max = String(p.maxKeep);
    // Not while the user is mid-edit.
    if (document.activeElement !== keepInput) keepInput.value = String(p.keep);
    keepSave.disabled = savingPolicy;
    body.replaceChildren(
      keepLine,
      keepNote,
      el("p", {
        class: "acct-hint",
        // Per file, not a pool: the one thing about `keep` a reader can get wrong.
        text: "This applies to each file on its own, not to a shared total. Discarded versions can't be recovered — the recycle bin doesn't hold them.",
      }),
    );
    updateKeepNote();
  }

  async function savePolicy(): Promise<void> {
    if (savingPolicy || policy.kind !== "ready") return;
    const typed = typedKeep();
    if (typed === null || typed < 0 || typed > policy.data.maxKeep) return;
    savingPolicy = true;
    keepSave.disabled = true;
    keepSave.textContent = "Saving…";
    const mine = deps.generation();
    try {
      const result = await deps.api.setVersionPolicy(typed);
      if (mine !== deps.generation()) return;
      policy = { kind: "ready", data: result.policy };
      deps.toast(
        result.removedVersions === 0
          ? `Keeping the last ${result.policy.keep} of each file.`
          : `Removed ${result.removedVersions === 1 ? "1 version" : `${result.removedVersions} versions`}, freeing ${formatBytes(result.freedBytes)}.`,
      );
      // Re-read rather than doing the arithmetic in two places.
      deps.onSaved(mine);
    } catch (e) {
      if (mine !== deps.generation()) return;
      if (!deps.handled(e)) deps.toast(failureMessage(e));
    } finally {
      savingPolicy = false;
      keepSave.textContent = "Save";
      if (mine === deps.generation()) renderPolicy();
    }
  }

  return {
    set(p) {
      policy = p;
      renderPolicy();
    },
    render: renderPolicy,
    isReady: () => policy.kind === "ready",
  };
}
