// The upload zone: a pure pre-flight gate (`preflightUpload`), a progress-row
// component that knows nothing about uploads (`createTransferList`), and the
// drag target + queue (`createUploadZone`). Location facts arrive through deps,
// so it is independent of the gallery. Files go one at a time: the server
// serialises on one lock and parallel sends would starve the gallery's reads.

import { el } from "./dom";
import { formatBytes, isAcceptedUpload, nextAvailableName, uploadExtension } from "../core/fileKind";
import { UploadRefusedError, type UploadConflictMode, type UploadRefusal } from "../api/client";
import type { ConflictAnswer } from "./uploadConflict";
import type { Entry, Id } from "../core/types";
import { type TransferRow, createTransferList } from "./transferList";
export { createTransferList } from "./transferList";
export type { TransferState, TransferRow, TransferListDeps, TransferList } from "./transferList";

// --- the pure gate -----------------------------------------------------------

export interface UploadRefusedResult {
  ok: false;
  reason: UploadRefusal;
  message: string;
}

export type PreflightResult = { ok: true } | UploadRefusedResult;

/**
 * Refusal copy, shared by the pre-flight and a server-side
 * {@link UploadRefusedError} so both read identically. Names the extension.
 */
export function uploadRefusalMessage(reason: UploadRefusal, file: { name: string; size: number }): string {
  if (reason === "type") {
    const ext = uploadExtension(file.name);
    return ext === "" ? "The Nomad can't open a file with no extension." : `The Nomad can't open .${ext}`;
  }
  if (reason === "quota") return `There isn't room for '${file.name}' (${formatBytes(file.size)}).`;
  return `'${file.name}' isn't a name this can be saved under.`;
}

/**
 * Should this file be sent at all? Refused before the transfer, from name and
 * size. `remaining` null (unknown quota) never blocks; the server's 413 is the
 * authority.
 */
export function preflightUpload(file: { name: string; size: number }, remaining: number | null): PreflightResult {
  if (!isAcceptedUpload(file.name)) {
    return { ok: false, reason: "type", message: uploadRefusalMessage("type", file) };
  }
  if (file.name.trim() === "" || file.name.includes("/")) {
    return { ok: false, reason: "name", message: uploadRefusalMessage("name", file) };
  }
  if (remaining !== null && file.size > remaining) {
    return { ok: false, reason: "quota", message: uploadRefusalMessage("quota", file) };
  }
  return { ok: true };
}

// --- the queue model ---------------------------------------------------------

export interface UploadDestination {
  id: Id | null;
  /** The device's template folder (`NOTE/MyStyle`); changes only the copy. */
  templates: boolean;
}

export interface UploadZoneDeps {
  target: HTMLElement;
  overlayHost: HTMLElement;
  listHost: HTMLElement;
  /** Where a drop lands now, or null; read per event so mid-drag navigation is safe. */
  destination: () => UploadDestination | null;
  remainingBytes: () => number | null;
  /**
   * Names already in a folder, or null if unknown (then the zone doesn't ask and
   * the server's default `rename` applies).
   */
  existingNames: (folderId: Id | null) => readonly string[] | null;
  /** Injected so the queue's branching is testable without a real `<dialog>`. */
  confirmConflict: (req: { name: string; taken: readonly string[]; remaining: number }) => Promise<ConflictAnswer>;
  upload: (
    folderId: Id | null,
    file: File,
    onProgress: (fraction: number) => void,
    signal: AbortSignal,
    onConflict: UploadConflictMode,
  ) => Promise<Entry>;
  onUploaded: (entry: Entry, destination: UploadDestination) => void;
  toast: (message: string) => void;
  /** Route a failure the shell owns (a dead session). True = already handled. */
  handled?: (e: unknown) => boolean;
}

export interface UploadZone {
  /** Queue files; the picker and drop paths both land here. */
  add(files: readonly File[]): void;
  rows(): readonly TransferRow[];
  cancel(id: string): void;
  isDragging(): boolean;
  destroy(): void;
}

function carriesFiles(e: DragEvent): boolean {
  const types = e.dataTransfer?.types;
  if (!types) return false;
  return Array.from(types).includes("Files");
}

export function createUploadZone(deps: UploadZoneDeps): UploadZone {
  // --- the overlay ---
  const zoneTitle = el("p", { class: "dropzone__title" });
  const zoneHint = el("p", { class: "dropzone__hint" });
  const overlay = el(
    "div",
    // `aria-hidden`: pointer feedback only; the toolbar Upload button is the
    // keyboard path.
    { class: "dropzone", hidden: true, "aria-hidden": "true" },
    el("div", { class: "dropzone__sheet" }, zoneTitle, zoneHint),
  );
  deps.overlayHost.append(overlay);

  // --- the queue ---
  const queue: TransferRow[] = [];
  /** The `File` per row, kept out of {@link TransferRow} so rows stay a pure view model. */
  const files = new Map<string, File>();
  /** Captured at queue time, so a queue outliving a navigation keeps its folder. */
  const destinations = new Map<string, UploadDestination>();
  /** The answered clash mode; never `replace` unless the person chose it. */
  const modes = new Map<string, UploadConflictMode>();
  const replaced = new Set<string>();
  const controllers = new Map<string, AbortController>();
  /** User-cancelled rows, so the abort's rejection isn't reported as a failure. */
  const cancelled = new Set<string>();
  /**
   * Queued rows whose name clash is not answered yet. Anything that nudges the
   * pump must skip them, or they'd send with an undecided (possibly `replace`)
   * mode.
   */
  const holding = new Set<string>();
  let seq = 0;
  let running = false;
  let destroyed = false;

  const list = createTransferList({
    host: deps.listHost,
    onCancel: (id) => cancel(id),
    onDismiss: () => {
      // Only finished rows; a running one must survive a dismiss.
      for (let i = queue.length - 1; i >= 0; i--) {
        const row = queue[i]!;
        if (row.state !== "queued" && row.state !== "sending") queue.splice(i, 1);
      }
      list.render(queue);
    },
  });

  function repaint(): void {
    if (!destroyed) list.render(queue);
  }

  function cancel(id: string): void {
    const row = queue.find((r) => r.id === id);
    if (!row || (row.state !== "queued" && row.state !== "sending")) return;
    cancelled.add(id);
    row.state = "cancelled";
    holding.delete(id);
    controllers.get(id)?.abort();
    controllers.delete(id);
    repaint();
    // A row cancelled while queued never enters `send`; nudge the pump.
    void pump();
  }

  /** The next transfer, one at a time; re-entrant-safe via `running`. */
  async function pump(): Promise<void> {
    if (running || destroyed) return;
    running = true;
    try {
      for (;;) {
        const row = queue.find((r) => r.state === "queued" && !holding.has(r.id));
        if (!row) return;
        await send(row);
        if (destroyed) return;
      }
    } finally {
      running = false;
    }
  }

  async function send(row: TransferRow): Promise<void> {
    const file = files.get(row.id);
    if (!file) {
      row.state = "failed";
      row.message = "Couldn't read that file.";
      repaint();
      return;
    }
    const dest = destinations.get(row.id);
    if (!dest) {
      row.state = "failed";
      row.message = "There's nowhere to put that here.";
      repaint();
      return;
    }
    const ctl = new AbortController();
    controllers.set(row.id, ctl);
    row.state = "sending";
    row.progress = 0;
    repaint();
    try {
      const entry = await deps.upload(
        dest.id,
        file,
        (fraction) => {
          // Ignore a progress event that was in flight when the row was aborted.
          if (row.state !== "sending") return;
          row.progress = fraction;
          repaint();
        },
        ctl.signal,
        modes.get(row.id) ?? "rename",
      );
      if (cancelled.has(row.id)) return; // aborted after the server had answered
      row.state = "done";
      row.progress = 1;
      repaint();
      deps.onUploaded(entry, dest);
      // A replace names the version, so it doesn't read as a loss.
      deps.toast(
        replaced.has(row.id)
          ? `Replaced '${entry.name}'. The previous file is in its version history.`
          : dest.templates
            ? `Added '${entry.name}' as a template. Pick it on your Nomad after the next sync.`
            : `Uploaded '${entry.name}'. It'll be on your Nomad after the next sync.`,
      );
    } catch (e) {
      if (cancelled.has(row.id)) {
        row.state = "cancelled";
        repaint();
        return;
      }
      if (deps.handled?.(e)) {
        row.state = "failed";
        row.message = null;
        repaint();
        return;
      }
      row.state = "failed";
      row.message =
        e instanceof UploadRefusedError
          ? uploadRefusalMessage(e.reason, file)
          : `Couldn't upload '${file.name}'. Try again.`;
      repaint();
      deps.toast(row.message);
    } finally {
      controllers.delete(row.id);
      files.delete(row.id);
    }
  }

  function add(incoming: readonly File[]): void {
    if (destroyed || incoming.length === 0) return;
    const dest = deps.destination();
    if (!dest) {
      deps.toast("There's nowhere to put a file here.");
      return;
    }
    // Charged against the same headroom as earlier files in the batch.
    let budget = deps.remainingBytes();
    const planned: { id: string; file: File }[] = [];
    // Every file gets its row here in drop order, before the async prompts.
    for (const file of incoming) {
      const id = `u${++seq}`;
      const check = preflightUpload(file, budget);
      if (!check.ok) {
        // A refusal stays as a row until dismissed, so a batch's refusals stay visible.
        queue.push({ id, name: file.name, size: file.size, state: "failed", progress: 0, message: check.message });
        deps.toast(check.message);
        continue;
      }
      if (budget !== null) budget -= file.size;
      files.set(id, file);
      destinations.set(id, dest);
      holding.add(id);
      queue.push({ id, name: file.name, size: file.size, state: "queued", progress: 0, message: null });
      planned.push({ id, file });
    }
    repaint();
    if (planned.length > 0) void resolveConflicts(planned, dest);
  }

  /**
   * Settle each clashing name before any byte moves, then release the batch to
   * the pump. "Do the same for the rest" carries one answer (cancel included)
   * through the remainder via `sticky`.
   */
  async function resolveConflicts(planned: readonly { id: string; file: File }[], dest: UploadDestination): Promise<void> {
    // Read once per batch and updated as names are claimed, so two `notes.pdf`
    // in one drop don't both preview as `notes (2).pdf`.
    const known = deps.existingNames(dest.id);
    const taken = known === null ? null : [...known];
    const clashing = (name: string): boolean =>
      taken !== null && taken.some((n) => n.toLowerCase() === name.toLowerCase());
    let sticky: ConflictAnswer["choice"] | null = null;

    for (let i = 0; i < planned.length; i++) {
      const { id, file } = planned[i]!;
      const row = queue.find((r) => r.id === id);
      if (destroyed) return;
      if (!row || row.state !== "queued") {
        holding.delete(id);
        continue;
      }
      let mode: UploadConflictMode = "rename";

      if (clashing(file.name)) {
        let answer: ConflictAnswer["choice"];
        if (sticky !== null) {
          answer = sticky;
        } else {
          const others = planned.slice(i + 1).filter((p) => clashing(p.file.name)).length;
          const given = await deps.confirmConflict({ name: file.name, taken: taken!, remaining: others });
          if (given.applyToRest) sticky = given.choice;
          answer = given.choice;
        }
        if (answer === "cancel") {
          // The row records that nothing was sent.
          row.state = "cancelled";
          holding.delete(id);
          files.delete(id);
          repaint();
          continue;
        }
        mode = answer;
      }

      modes.set(id, mode);
      if (mode === "replace") replaced.add(id);
      if (taken !== null && mode === "rename") taken.push(nextAvailableName(file.name, taken));
      holding.delete(id);
      void pump();
    }
  }

  // --- drag handling ---
  // Counted, not toggled: `dragleave` fires on every child crossed.
  let depth = 0;

  function showOverlay(): void {
    const dest = deps.destination();
    if (!dest) return;
    // In MyStyle a dropped image or PDF becomes a device template, so say so.
    zoneTitle.textContent = dest.templates
      ? "Drop an image or PDF to add a template"
      : "Drop files to add them here";
    zoneHint.textContent = dest.templates
      ? "It'll be on your Nomad's template list after the next sync."
      : "PDFs, EPUBs, images, notes — they'll be on your Nomad after the next sync.";
    overlay.hidden = false;
  }

  function hideOverlay(): void {
    depth = 0;
    overlay.hidden = true;
  }

  const onDragEnter = (e: DragEvent): void => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    depth++;
    showOverlay();
  };
  const onDragOver = (e: DragEvent): void => {
    if (!carriesFiles(e)) return;
    // Without preventDefault on every `dragover` there is no `drop`; the browser
    // navigates to the file instead.
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    if (overlay.hidden) showOverlay();
  };
  const onDragLeave = (e: DragEvent): void => {
    if (!carriesFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) hideOverlay();
  };
  const onDrop = (e: DragEvent): void => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    hideOverlay();
    const dropped = Array.from(e.dataTransfer?.files ?? []);
    if (dropped.length > 0) add(dropped);
  };

  deps.target.addEventListener("dragenter", onDragEnter);
  deps.target.addEventListener("dragover", onDragOver);
  deps.target.addEventListener("dragleave", onDragLeave);
  deps.target.addEventListener("drop", onDrop);

  // A file dropped outside the target would navigate the tab away; swallow it.

  const swallow = (e: DragEvent): void => {
    if (!carriesFiles(e)) return;
    if (deps.target.contains(e.target as Node)) return;
    e.preventDefault();
    if (e.type === "drop") hideOverlay();
  };
  document.addEventListener("dragover", swallow);
  document.addEventListener("drop", swallow);

  return {
    add,
    rows: () => queue,
    cancel,
    isDragging: () => !overlay.hidden,
    destroy() {
      destroyed = true;
      for (const ctl of controllers.values()) ctl.abort();
      controllers.clear();
      deps.target.removeEventListener("dragenter", onDragEnter);
      deps.target.removeEventListener("dragover", onDragOver);
      deps.target.removeEventListener("dragleave", onDragLeave);
      deps.target.removeEventListener("drop", onDrop);
      document.removeEventListener("dragover", swallow);
      document.removeEventListener("drop", swallow);
      overlay.remove();
      list.destroy();
    },
  };
}
