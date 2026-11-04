// The account page's Storage section: the total, then each kind.

import { el } from "../ui/dom";
import { formatBytes } from "../core/fileKind";
import type { StorageBreakdown } from "../api/accountTypes";
import { button, failed, pending, type Load } from "./accountDom";
import { storageRows } from "./accountCopy";

export function renderStorage(storageBody: HTMLElement, storage: Load<StorageBreakdown>, onOpenBin: () => void): void {
  if (storage.kind === "loading") {
    storageBody.replaceChildren(pending());
    return;
  }
  if (storage.kind === "failed") {
    storageBody.replaceChildren(failed(storage.message));
    return;
  }
  const data = storage.data;
  const total = el(
    "div",
    { class: "acct-total" },
    el("span", { class: "acct-total__v acct-data", text: formatBytes(data.usedBytes) }),
    el("span", { class: "acct-total__k", text: `of ${formatBytes(data.totalBytes)}` }),
  );
  if (data.byKind === null) {
    // A real state, not an error: the total is known, the split is not.
    storageBody.replaceChildren(
      total,
      el("p", { class: "acct-hint", text: "This server can't break the total down by kind yet." }),
    );
    return;
  }
  storageBody.replaceChildren(
    total,
    ...storageRows(data.byKind).map((r) =>
      el(
        "div",
        { class: "acct-row acct-kind" },
        el(
          "div",
          { class: "acct-row__k" },
          el("span", { text: r.label }),
          el("span", { class: "acct-kind__hint", text: r.hint }),
        ),
        el("div", { class: "acct-row__v acct-data", text: formatBytes(r.bytes) }),
        el(
          "div",
          { class: "acct-row__acts" },
          r.key === "bin" ? button("Open", () => onOpenBin(), { ariaLabel: "Open the recycle bin" }) : null,
        ),
      ),
    ),
  );
}
