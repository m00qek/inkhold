// THE UPLOAD ZONE (docs/scratch/upload.md §7) — the drag/drop target over a
// surface, the queue behind it, and the progress rows it draws.
//
// THREE PIECES, SEPARATED ON PURPOSE, because only one of them is about uploads:
//
//   1. `preflightUpload` — the pure gate. Would this file be refused, and in
//      whose words? Shared by the drop path, the picker path and (by reason) the
//      server's own refusal, so a file rejected here and one rejected by the
//      server are described identically.
//   2. `createTransferList` — the progress ROWS: a name, a bar, a state, a
//      Cancel. It knows nothing about uploading. `.spd`/`.txt` DOWNLOAD progress
//      (ui-on-slow-connection.md §2.5) is bytes RECEIVED through a completely
//      different transport, but it is the same component on screen — so it is a
//      seam that takes rows and hands back clicks, and that is all.
//   3. `createUploadZone` — the drag target + the queue model that feeds (2).
//
// IT IS INDEPENDENT OF THE GALLERY. Everything it needs about where it is —
// which folder a drop lands in, whether that folder is the device's TEMPLATE
// folder, how much room the account has left — arrives through `UploadZoneDeps`
// as functions, so a second surface (the reader, a folder picker) can mount one
// without library.ts being involved.
//
// ONE AT A TIME. The queue sends files sequentially rather than in parallel: a
// browser allows about six connections per origin and the server serialises on
// one coarse lock, so a fan-out of eight PDFs would compete with the gallery's
// own reads for no gain in total time.

import { el } from "./dom";
import { formatBytes, isAcceptedUpload, nextAvailableName, uploadExtension } from "../core/fileKind";
import { UploadRefusedError, type UploadConflictMode, type UploadRefusal } from "../api/client";
import type { ConflictAnswer } from "./uploadConflict";
import type { Entry, Id } from "../core/types";

// --- the pure gate -----------------------------------------------------------

/** A file the interface will not send, and the line that says why. */
export interface UploadRefusedResult {
  ok: false;
  reason: UploadRefusal;
  /** The interface-voice line, naming this file's problem specifically. */
  message: string;
}

export type PreflightResult = { ok: true } | UploadRefusedResult;

/**
 * What to SAY about a refusal, in the interface's own voice.
 *
 * ONE VOCABULARY FOR BOTH SIDES. A file the browser refuses before sending and a
 * file the server refuses after receiving it are the same event to the person who
 * dropped it, so the words come from here in both cases — the pre-flight below
 * calls this, and so does the queue when it catches an {@link UploadRefusedError}.
 *
 * The type line NAMES THE EXTENSION rather than listing what is allowed: "The
 * Nomad can't open .xyz" says the one thing that is true about the file in hand,
 * where a wall of accepted extensions would make the reader do the comparison.
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
 * Should this file be sent at all?
 *
 * REFUSED BEFORE THE TRANSFER, which is the whole point: a 200 MB PDF that the
 * account has no room for must fail in the instant it is dropped, not after four
 * minutes of upload. Both checks are facts the browser already holds — the name
 * and the size — so neither costs a round trip.
 *
 * `remaining` is bytes of quota left, or **null when it is not known** (the usage
 * endpoint has not answered, or the account has no quota). Unknown NEVER blocks:
 * refusing on a number we do not have would turn a missing meter into a broken
 * feature, and the server's 413 is the authority regardless.
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

/**
 * Where one file is in its life.
 *
 * `failed` and `cancelled` are DIFFERENT states, not one "didn't finish": a
 * cancelled row is something the user did and needs no explanation, while a
 * failed one owes them a reason. Collapsing them would make the interface
 * apologise for obeying.
 */
export type TransferState = "queued" | "sending" | "done" | "failed" | "cancelled";

/** One row of the transfer list — the whole of what {@link createTransferList} draws. */
export interface TransferRow {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  state: TransferState;
  /** 0..1. Meaningful while `sending`; 1 once `done`. */
  progress: number;
  /** Why it failed, in the interface's voice — null unless `state === "failed"`. */
  message: string | null;
}

export interface TransferListDeps {
  /** Where the list mounts. Created empty and hidden; it never appends anything
   *  while there is nothing to show. */
  host: HTMLElement;
  /** A row's Cancel was pressed. Only shown for `queued`/`sending` rows. */
  onCancel: (id: string) => void;
  /** Dismiss the whole finished list ("Done"). */
  onDismiss: () => void;
}

export interface TransferList {
  /** Repaint from the current rows. Cheap and idempotent — call it per change. */
  render(rows: readonly TransferRow[]): void;
  destroy(): void;
}

/**
 * The progress ROWS, as a component that knows nothing about what is being
 * transferred (see this file's header — `.spd`/`.txt` download progress is meant
 * to reuse exactly this).
 *
 * Rows are rebuilt per render rather than diffed: the list is at most a handful
 * of items and lives for seconds. The one thing that is NOT rebuilt is the bar's
 * width, which is written as a style on the existing node when only the fraction
 * moved — a `replaceChildren` on every progress event would restart the CSS
 * transition sixty times a second and make the bar stutter instead of glide.
 */
export function createTransferList(deps: TransferListDeps): TransferList {
  const list = el("ol", { class: "transfers__list" });
  const panel = el(
    "section",
    {
      class: "transfers",
      hidden: true,
      // POLITE, not assertive: a progress bar that interrupts whatever a screen
      // reader is saying every time a percentage moves is unusable. The per-row
      // text carries the state; the bar itself is `aria-hidden` decoration.
      "aria-label": "Uploads",
    },
    list,
  );
  deps.host.append(panel);

  /** The bar + state-line nodes per row id, so a fraction change can be written
   *  in place. Held as a map rather than re-queried by selector: row ids are ours,
   *  but a `querySelector` over an attribute value is one escaping rule away from
   *  a bug and needs `CSS.escape`, which not every test DOM implements. */
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
      // The bar is the SAME fact as the state line beside it, so it is hidden
      // from assistive tech rather than announced twice.
      el("div", { class: "transfer__track", "aria-hidden": "true" }, bar),
    );
    if (row.state === "queued" || row.state === "sending") {
      const cancel = el("button", {
        class: "transfer__cancel",
        type: "button",
        // Named per row: a list of identical "Cancel" buttons tells a screen
        // reader nothing about which transfer it is on.
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
      // The SHAPE of the list — which rows, in which state — as one string. When
      // only a fraction moved the shape is unchanged, and the bars are nudged in
      // place instead of the DOM being rebuilt under a running transition.
      const shape = rows.map((r) => `${r.id}:${r.state}:${r.message ?? ""}`).join("|");
      if (shape === painted) {
        for (const row of rows) {
          const nodes = bars.get(row.id);
          if (!nodes) continue;
          nodes.fill.style.width = `${Math.round(row.progress * 100)}%`;
          // The percentage in the state line is text, so it moves with the bar.
          nodes.label.textContent = stateLabel(row);
        }
        return;
      }
      bars.clear();
      list.replaceChildren(...rows.map((row) => rowNode(row)));
      painted = shape;
      // Only once nothing is in flight: a Dismiss control beside a running
      // transfer invites the reading that it would stop it.
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

/** Where a drop would land, and what that place MEANS. */
export interface UploadDestination {
  /** The folder id, or null for the library root. */
  id: Id | null;
  /**
   * This folder is the device's TEMPLATE folder (`NOTE/MyStyle`) — resolved by
   * the rail's category identity, never by name. It changes only what the
   * interface SAYS: the dropzone offers a template, the toast names one. Nothing
   * is filtered or routed differently, so a `.txt` dropped here still uploads
   * normally with the generic copy.
   */
  templates: boolean;
}

export interface UploadZoneDeps {
  /**
   * The element a drop is accepted over — the gallery. Listeners are attached
   * here, and the overlay is drawn into {@link UploadZoneDeps.overlayHost}.
   */
  target: HTMLElement;
  /** Where the drag overlay mounts (a positioned ancestor of `target`). */
  overlayHost: HTMLElement;
  /** Where the progress rows mount. */
  listHost: HTMLElement;
  /**
   * Where a drop would land RIGHT NOW, or null when this surface cannot take one
   * (a search, a destination, a category with no folder yet). Read per event, so
   * navigating mid-drag can never upload into the folder you left.
   */
  destination: () => UploadDestination | null;
  /** Bytes of quota left, or null when unknown — see {@link preflightUpload}. */
  remainingBytes: () => number | null;
  /**
   * The names already in a destination folder, or null when the caller does not
   * know them (that folder has never been listed).
   *
   * This is what makes the conflict prompt cost NOTHING: the clash is found
   * against a listing the app already holds, so the alternative — send the file,
   * take a 409, send it again — is never paid for. Null means "cannot tell", and
   * the zone then simply does not ask: the server's default (`rename`) is the
   * safe answer, and inventing a prompt from an unknown is worse than not asking.
   */
  existingNames: (folderId: Id | null) => readonly string[] | null;
  /**
   * Ask what to do about one name that is already taken. Injected rather than
   * imported so the queue's branching is testable without a real `<dialog>` —
   * `ui/uploadConflict.ts` is what library.ts passes.
   */
  confirmConflict: (req: { name: string; taken: readonly string[]; remaining: number }) => Promise<ConflictAnswer>;
  /** The seam call. Separate from `Api` so the zone can be tested (and reused)
   *  without one. */
  upload: (
    folderId: Id | null,
    file: File,
    onProgress: (fraction: number) => void,
    signal: AbortSignal,
    onConflict: UploadConflictMode,
  ) => Promise<Entry>;
  /** A file landed. The caller splices the row into its listing and repaints. */
  onUploaded: (entry: Entry, destination: UploadDestination) => void;
  toast: (message: string) => void;
  /** Route a failure the shell owns (a dead session). True = already handled. */
  handled?: (e: unknown) => boolean;
}

export interface UploadZone {
  /**
   * Queue files for upload — the picker path and the drop path both land here,
   * so pre-flight, refusal copy and the queue are shared by construction rather
   * than duplicated per entry point.
   */
  add(files: readonly File[]): void;
  /** The queue, for tests and for anything that wants to render it elsewhere. */
  rows(): readonly TransferRow[];
  /** Stop a queued or in-flight transfer. */
  cancel(id: string): void;
  /** Whether the dropzone overlay is currently up (drag in progress). */
  isDragging(): boolean;
  destroy(): void;
}

/** Does this drag carry FILES (rather than a text selection or a card)? */
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
    // `aria-hidden`: the overlay is pure feedback for a pointer gesture already
    // in progress. The KEYBOARD path to the same capability is the toolbar's
    // Upload button, which is a real focusable control.
    { class: "dropzone", hidden: true, "aria-hidden": "true" },
    el("div", { class: "dropzone__sheet" }, zoneTitle, zoneHint),
  );
  deps.overlayHost.append(overlay);

  // --- the queue ---
  const queue: TransferRow[] = [];
  /** The `File` per row — kept OUT of {@link TransferRow} so the row type stays a
   *  pure view model the download half can produce too. */
  const files = new Map<string, File>();
  /** Where each row is going, captured when it was queued — so a queue that
   *  outlives a navigation still uploads into the folder it was dropped on. */
  const destinations = new Map<string, UploadDestination>();
  /** What was ANSWERED about this row's name clash, if there was one. Never
   *  `replace` unless the person said so. */
  const modes = new Map<string, UploadConflictMode>();
  /** Rows that replaced an existing file, so the toast can name the version
   *  rather than claim something new arrived. */
  const replaced = new Set<string>();
  const controllers = new Map<string, AbortController>();
  /** Rows the user cancelled, so the abort's rejection is read as a choice
   *  rather than as a failure to explain. */
  const cancelled = new Set<string>();
  /**
   * Rows that are queued but must NOT be sent yet: their name clashes and the
   * question has not been answered.
   *
   * They are real rows from the moment of the drop (the list has to show the
   * batch in the order it arrived), so "queued" alone cannot mean "ready to
   * send" any more — anything that nudges the pump, including cancelling a
   * different row, would otherwise start a transfer whose conflict mode has not
   * been decided, which is precisely the `replace`-without-being-asked hazard.
   */
  const holding = new Set<string>();
  let seq = 0;
  let running = false;
  let destroyed = false;

  const list = createTransferList({
    host: deps.listHost,
    onCancel: (id) => cancel(id),
    onDismiss: () => {
      // Only what is finished: a dismiss during a later upload must not drop the
      // row that is still running.
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
    // A row cancelled while merely QUEUED never enters `send`, so the pump has to
    // be nudged or the queue would stall behind a row nobody is sending.
    void pump();
  }

  /** The next transfer, one at a time. Re-entrant-safe via `running`. */
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
          // A superseded/cancelled row must not be re-painted as sending by a
          // progress event that was already in flight when it was aborted.
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
      // A REPLACE IS A DIFFERENT EVENT, so it gets its own sentence — and the
      // sentence names the version, because "Replaced 'X'" on its own reads as a
      // loss to anyone who has not been told otherwise.
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
        // The shell has taken it (a dead session): the row stops, and there is
        // nothing left for this list to explain.
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
    // Charged against the SAME headroom as the files ahead of it in this batch:
    // three 4 MB files into 5 MB of space is two refusals, not three successes
    // and a server error.
    let budget = deps.remainingBytes();
    const planned: { id: string; file: File }[] = [];
    // EVERY FILE GETS ITS ROW HERE, IN DROP ORDER, refused ones included. The
    // conflict prompt below is async, so building the rows as its answers arrive
    // would list a batch in the order it was ANSWERED — the second file above the
    // first because the first was the one that had to be asked about.
    for (const file of incoming) {
      const id = `u${++seq}`;
      const check = preflightUpload(file, budget);
      if (!check.ok) {
        // A refusal is still a ROW. It could have been only a toast, but then a
        // batch of eight where two are refused would report the refusals one at a
        // time in a control that disappears — and the person would have to
        // remember which two. The row stays until dismissed.
        queue.push({ id, name: file.name, size: file.size, state: "failed", progress: 0, message: check.message });
        deps.toast(check.message);
        continue;
      }
      if (budget !== null) budget -= file.size;
      files.set(id, file);
      destinations.set(id, dest);
      // HELD until its name question is settled — see `holding`.
      holding.add(id);
      queue.push({ id, name: file.name, size: file.size, state: "queued", progress: 0, message: null });
      planned.push({ id, file });
    }
    repaint();
    if (planned.length > 0) void resolveConflicts(planned, dest);
  }

  /**
   * Settle what happens to each queued file whose name is already taken, then
   * release the batch to the pump (see `ui/uploadConflict.ts` for why it asks at
   * all rather than letting the server auto-rename).
   *
   * ALL OF THIS HAPPENS BEFORE A SINGLE BYTE MOVES: the clash is found in the
   * listing the app already holds, so a re-dropped file is never uploaded once to
   * discover what to do with it and then uploaded again — which on a slow link is
   * the difference between one transfer and two.
   *
   * ONE ANSWER CAN COVER THE REST. A drop of ten files where six clash must not
   * be ten dialogs, so the prompt offers "do the same for the other N" and
   * `sticky` carries that answer through the remainder — cancel included, which
   * is what someone who dropped the wrong folder wants.
   */
  async function resolveConflicts(planned: readonly { id: string; file: File }[], dest: UploadDestination): Promise<void> {
    // Read ONCE for the batch and updated locally as names are claimed, so two
    // files called `notes.pdf` in one drop do not both preview as `notes (2).pdf`.
    const known = deps.existingNames(dest.id);
    const taken = known === null ? null : [...known];
    const clashing = (name: string): boolean =>
      taken !== null && taken.some((n) => n.toLowerCase() === name.toLowerCase());
    let sticky: ConflictAnswer["choice"] | null = null;

    for (let i = 0; i < planned.length; i++) {
      const { id, file } = planned[i]!;
      const row = queue.find((r) => r.id === id);
      // Cancelled from the list while the dialog was up, or the shell went away.
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
          // NOTHING IS SENT. The row records that, so a batch does not silently
          // shrink between what was dropped and what is in flight.
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
      // A kept-both file claims its new name for the rest of the batch; a replace
      // claims nothing, because the name was already there.
      if (taken !== null && mode === "rename") taken.push(nextAvailableName(file.name, taken));
      holding.delete(id);
      void pump();
    }
  }

  // --- drag handling ---
  //
  // COUNTED, not toggled. `dragleave` fires every time the pointer crosses into a
  // CHILD of the target — every card, every caption — so a boolean would make the
  // overlay flicker off and on across a gallery of forty tiles. The depth counter
  // is the standard fix: enter increments, leave decrements, zero means gone.
  let depth = 0;

  function showOverlay(): void {
    const dest = deps.destination();
    if (!dest) return;
    // THE MYSTYLE MOMENT (upload.md §7). Dropping an image or PDF into MyStyle is
    // not a generic upload — it is adding a template you can then write on, a
    // capability that otherwise needs a cable. The interface knows where it is,
    // so it says so. Confirmed real: a template placed here does reach the device.
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
    // WITHOUT THIS THERE IS NO DROP. The default action of `dragover` is to
    // refuse the drag, so a target that does not preventDefault every one of them
    // never receives a `drop` at all — and the browser navigates to the file.
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

  // A file dropped OUTSIDE the target would otherwise navigate the whole tab to
  // it, throwing the app away mid-session. Swallowed at the document, which is
  // the only place that catches "somewhere else".
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
