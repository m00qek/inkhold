// The upload panel's transfer list: one row per file, with progress and cancel.

import { el } from "./dom";

/** `cancelled` (user's choice) and `failed` (owes a reason) stay distinct. */
export type TransferState = "queued" | "sending" | "done" | "failed" | "cancelled";

export interface TransferRow {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  state: TransferState;
  /** 0..1, meaningful while `sending`. */
  progress: number;
  message: string | null;
}

export interface TransferListDeps {
  host: HTMLElement;
  onCancel: (id: string) => void;
  onDismiss: () => void;
}

export interface TransferList {
  render(rows: readonly TransferRow[]): void;
  destroy(): void;
}

/**
 * The progress rows. Rebuilt per render except the bar width, which is written
 * in place when only the fraction moved so the CSS transition doesn't restart.
 */
export function createTransferList(deps: TransferListDeps): TransferList {
  const list = el("ol", { class: "transfers__list" });
  const panel = el(
    "section",
    {
      class: "transfers",
      hidden: true,
      // Polite: the per-row text carries the state; the bar is `aria-hidden`.
      "aria-label": "Uploads",
    },
    list,
  );
  deps.host.append(panel);

  /** Bar and label nodes per row id, held in a map to avoid `CSS.escape` selectors. */
  const bars = new Map<string, { fill: HTMLElement; label: HTMLElement }>();
  let painted = "";

  function stateLabel(row: TransferRow): string {
    switch (row.state) {
      case "queued":
        return "Waiting";
      case "sending":
        return `Sending ${Math.round(row.progress * 100)}%`;
      case "done":
        return "Uploaded";
      case "cancelled":
        return "Cancelled";
      case "failed":
        return row.message ?? "Couldn't upload that.";
    }
  }

  function rowNode(row: TransferRow): HTMLElement {
    const bar = el("div", { class: "transfer__fill" });
    bar.style.width = `${Math.round(row.progress * 100)}%`;
    const label = el("span", { class: "transfer__state", text: stateLabel(row) });
    bars.set(row.id, { fill: bar, label });
    const node = el(
      "li",
      { class: `transfer is-${row.state}` },
      el(
        "div",
        { class: "transfer__head" },
        el("span", { class: "transfer__name", text: row.name, title: row.name }),
        label,
      ),
      el("div", { class: "transfer__track", "aria-hidden": "true" }, bar),
    );
    if (row.state === "queued" || row.state === "sending") {
      const cancel = el("button", {
        class: "transfer__cancel",
        type: "button",
        "aria-label": `Cancel upload of ${row.name}`,
        text: "Cancel",
      });
      cancel.addEventListener("click", () => deps.onCancel(row.id));
      node.append(cancel);
    }
    return node;
  }

  return {
    render(rows) {
      if (rows.length === 0) {
        panel.hidden = true;
        list.replaceChildren();
        bars.clear();
        painted = "";
        return;
      }
      panel.hidden = false;
      // The list's shape; unchanged means only fractions moved.
      const shape = rows.map((r) => `${r.id}:${r.state}:${r.message ?? ""}`).join("|");
      if (shape === painted) {
        for (const row of rows) {
          const nodes = bars.get(row.id);
          if (!nodes) continue;
          nodes.fill.style.width = `${Math.round(row.progress * 100)}%`;
          nodes.label.textContent = stateLabel(row);
        }
        return;
      }
      bars.clear();
      list.replaceChildren(...rows.map((row) => rowNode(row)));
      painted = shape;
      // Dismiss only once nothing is in flight, so it can't read as "stop".
      if (rows.every((r) => r.state !== "queued" && r.state !== "sending")) {
        const done = el("button", { class: "transfers__dismiss", type: "button", text: "Dismiss" });
        done.addEventListener("click", () => deps.onDismiss());
        const item = el("li", { class: "transfers__foot" }, done);
        list.append(item);
      }
    },
    destroy() {
      panel.remove();
      bars.clear();
    },
  };
}

// --- the zone ----------------------------------------------------------------
