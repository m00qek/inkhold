// @vitest-environment happy-dom
//
// The upload feature's pure logic and its queue, as
// units:
//   - the ACCEPT LIST and the extension reading behind it (`core/fileKind`);
//   - the PRE-FLIGHT — the gate that refuses a file BEFORE any bytes move, and
//     the interface-voice line each refusal carries;
//   - the QUEUE's state machine: queued → sending(%) → done / failed / cancelled,
//     including that a cancel really aborts the transfer rather than only
//     relabelling the row;
//   - the FAKE `Api`'s upload, which is where the 415/413 refusal paths are
//     exercisable with no server — the reference for what the real endpoint must
//     do.
//
// It needs a document (the zone draws its rows), so it opts this one file into
// happy-dom the way `toolbar.test.ts` does.

import { describe, it, expect, afterEach } from "vitest";
import {
  UPLOAD_ACCEPT,
  isAcceptedUpload,
  nextAvailableName,
  uploadExtension,
} from "../../src/core/fileKind";
import type { ConflictAnswer } from "../../src/ui/uploadConflict";
import {
  createUploadZone,
  preflightUpload,
  uploadRefusalMessage,
  type UploadDestination,
  type TransferRow,
} from "../../src/ui/uploadZone";
import { UploadRefusedError } from "../../src/api/client";
import { createFakeApi, FAKE_UPLOAD_HEADROOM } from "../../src/api/fake";
import type { Entry } from "../../src/core/types";

/** A `File` of `size` bytes with the given name — real bytes, so `.size` is honest. */
function fileOf(name: string, size = 1024): File {
  return new File([new Uint8Array(size)], name);
}

describe("the accept list", () => {
  it("reads an extension lowercase, without the dot", () => {
    expect(uploadExtension("Lease.PDF")).toBe("pdf");
    expect(uploadExtension("2026.07.20.note")).toBe("note");
  });

  it("has no extension for a bare name or a dotfile", () => {
    // A leading-dot name is not a file OF that type — `.gitignore` is its whole
    // name — so the honest answer is "none", which the accept list then refuses.
    expect(uploadExtension("README")).toBe("");
    expect(uploadExtension(".gitignore")).toBe("");
    expect(uploadExtension("trailing.")).toBe("");
  });

  it("accepts what the device opens, including .spd", () => {
    for (const name of ["a.pdf", "a.note", "a.spd", "a.epub", "a.docx", "a.PNG", "a.mobi"]) {
      expect(isAcceptedUpload(name)).toBe(true);
    }
  });

  it("refuses anything else, and never an extensionless file", () => {
    for (const name of ["a.xyz", "a.exe", "a.svg", "a.zip", "README"]) {
      expect(isAcceptedUpload(name)).toBe(false);
    }
    // `.svg` stays out on purpose — the server refuses to serve it inline, and it
    // is an XML document that can carry script.
    expect(UPLOAD_ACCEPT).not.toContain("svg");
  });
});

describe("nextAvailableName — the name Keep both promises", () => {
  it("leaves a free name alone", () => {
    expect(nextAvailableName("notes.pdf", ["other.pdf"])).toBe("notes.pdf");
  });

  it("suffixes BEFORE the extension, counting up past each taken name", () => {
    expect(nextAvailableName("notes.pdf", ["notes.pdf"])).toBe("notes (2).pdf");
    expect(nextAvailableName("notes.pdf", ["notes.pdf", "notes (2).pdf"])).toBe("notes (3).pdf");
  });

  it("matches case-insensitively, like the tree's own collision rule", () => {
    expect(nextAvailableName("Notes.PDF", ["notes.pdf"])).toBe("Notes (2).PDF");
  });

  it("handles a name with no extension", () => {
    expect(nextAvailableName("scan", ["scan"])).toBe("scan (2)");
  });
});

describe("preflightUpload — refused before anything is sent", () => {
  it("refuses an off-list type, naming the extension", () => {
    const r = preflightUpload({ name: "recording.xyz", size: 10 }, null);
    expect(r).toEqual({ ok: false, reason: "type", message: "The Nomad can't open .xyz" });
  });

  it("refuses a file with no extension at all, without inventing one", () => {
    const r = preflightUpload({ name: "notes", size: 10 }, null);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.message).toBe("The Nomad can't open a file with no extension.");
  });

  it("refuses a file bigger than the room left, naming the size", () => {
    const r = preflightUpload({ name: "big.pdf", size: 5_000_000 }, 1_000_000);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe("quota");
    expect(r.ok === false && r.message).toContain("big.pdf");
  });

  it("NEVER blocks when the quota is unknown", () => {
    // Null is "we have not been told", not "no room" — a missing usage endpoint
    // must not turn into a broken feature. The server's 413 is the authority.
    expect(preflightUpload({ name: "huge.pdf", size: 9e12 }, null)).toEqual({ ok: true });
  });

  it("passes a file that fits", () => {
    expect(preflightUpload({ name: "lease.pdf", size: 100 }, 1000)).toEqual({ ok: true });
  });

  it("refuses a name carrying a path separator", () => {
    const r = preflightUpload({ name: "a/b.pdf", size: 10 }, null);
    expect(r.ok === false && r.reason).toBe("name");
  });

  it("speaks the same words for a SERVER refusal as for its own", () => {
    // The point of the shared vocabulary: a file refused after transfer must not
    // be explained differently from one refused before it.
    const file = { name: "recording.xyz", size: 10 };
    expect(uploadRefusalMessage("type", file)).toBe("The Nomad can't open .xyz");
  });
});

// --- the queue ---------------------------------------------------------------

interface Harness {
  zone: ReturnType<typeof createUploadZone>;
  rows: () => readonly TransferRow[];
  toasts: string[];
  uploaded: Entry[];
  /** Every conflict prompt raised, in order — the "it must not have asked" and
   *  "it must have asked once, not N times" assertions both read this. */
  asked: { name: string; remaining: number }[];
  /** The `onConflict` mode each call to the seam carried. */
  modes: string[];
  /** Resolve/reject the upload currently in flight, and the progress hook. */
  pending: () => {
    resolve: (e: Entry) => void;
    reject: (e: unknown) => void;
    progress: (f: number) => void;
    signal: AbortSignal;
  } | null;
}

function entry(name: string): Entry {
  return {
    kind: "note",
    id: `x-${name}`,
    name,
    pageCount: 1,
    firstPage: { index: 0, hash: "h", width: 10, height: 10, textHash: null },
    updatedAt: 0,
    fileType: "pdf",
    fileHash: null,
    hasRecognizedText: false,
  };
}

interface HarnessOpts {
  dest?: UploadDestination | null;
  remaining?: number | null;
  /** What is already in the destination folder, or null for "never listed". */
  existing?: readonly string[] | null;
  /** What the conflict prompt answers. Default: never asked to answer. */
  answer?: ConflictAnswer;
}

function harness(opts: HarnessOpts = {}): Harness {
  const dest = opts.dest === undefined ? { id: "note" as const, templates: false } : opts.dest;
  const host = document.createElement("div");
  document.body.append(host);
  const toasts: string[] = [];
  const uploaded: Entry[] = [];
  const asked: { name: string; remaining: number }[] = [];
  const modes: string[] = [];
  let inFlight: ReturnType<Harness["pending"]> = null;

  const zone = createUploadZone({
    target: host,
    overlayHost: host,
    listHost: host,
    destination: () => dest,
    remainingBytes: () => opts.remaining ?? null,
    existingNames: () => (opts.existing === undefined ? [] : opts.existing),
    confirmConflict: async (req) => {
      asked.push({ name: req.name, remaining: req.remaining });
      return opts.answer ?? { choice: "cancel", applyToRest: false };
    },
    upload: (_folderId, _file, onProgress, signal, onConflict) => {
      modes.push(onConflict);
      return new Promise<Entry>((resolve, reject) => {
        inFlight = { resolve, reject, progress: onProgress, signal };
      });
    },
    onUploaded: (e) => uploaded.push(e),
    toast: (m) => toasts.push(m),
  });

  return { zone, rows: () => zone.rows(), toasts, uploaded, asked, modes, pending: () => inFlight };
}

/** Let the queue's microtasks run. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// Each harness mounts its own host; without this every later DOM assertion would
// be counting the rows of every earlier test as well.
afterEach(() => document.body.replaceChildren());

describe("the upload queue", () => {
  it("walks queued → sending(%) → done, and names the payoff", async () => {
    const h = harness();
    h.zone.add([fileOf("lease.pdf")]);
    // The FIRST file starts sending in the same turn it was queued — the pump
    // runs synchronously up to the seam call — so `queued` is observable on the
    // ones behind it (see "sends ONE AT A TIME"), not on this one.
    await settle();
    expect(h.rows()[0]!.state).toBe("sending");

    h.pending()!.progress(0.4);
    expect(h.rows()[0]!.progress).toBeCloseTo(0.4);

    h.pending()!.resolve(entry("lease.pdf"));
    await settle();
    expect(h.rows()[0]!.state).toBe("done");
    expect(h.uploaded).toHaveLength(1);
    expect(h.toasts).toContain("Uploaded 'lease.pdf'. It'll be on your Nomad after the next sync.");
  });

  it("says TEMPLATE when the destination is the device's template folder", async () => {
    const h = harness({ dest: { id: "mystyle", templates: true } });
    h.zone.add([fileOf("grid.png")]);
    await settle();
    h.pending()!.resolve(entry("grid.png"));
    await settle();
    expect(h.toasts).toContain("Added 'grid.png' as a template. Pick it on your Nomad after the next sync.");
  });

  it("a NON-template type dropped in the template folder still uploads, with generic copy", async () => {
    // The interface never blocks — it only names the likely intent.
    const h = harness({ dest: { id: "mystyle", templates: true } });
    h.zone.add([fileOf("notes.txt")]);
    await settle();
    expect(h.rows()[0]!.state).toBe("sending");
  });

  it("refuses an off-list file WITHOUT calling upload at all", async () => {
    const h = harness();
    h.zone.add([fileOf("clip.xyz")]);
    await settle();
    // Never sent: no transfer was ever started for it.
    expect(h.pending()).toBeNull();
    expect(h.rows()[0]!.state).toBe("failed");
    expect(h.rows()[0]!.message).toBe("The Nomad can't open .xyz");
    expect(h.toasts).toContain("The Nomad can't open .xyz");
  });

  it("charges a BATCH against one budget, so the second of two big files is refused", async () => {
    const h = harness({ remaining: 6_000 });
    h.zone.add([fileOf("a.pdf", 4_000), fileOf("b.pdf", 4_000)]);
    await settle();
    expect(h.rows()[0]!.state).toBe("sending");
    expect(h.rows()[1]!.state).toBe("failed");
    expect(h.rows()[1]!.message).toContain("b.pdf");
  });

  it("CANCEL aborts the transfer, not just the row", async () => {
    const h = harness();
    h.zone.add([fileOf("big.pdf")]);
    await settle();
    const flight = h.pending()!;
    expect(flight.signal.aborted).toBe(false);

    h.zone.cancel(h.rows()[0]!.id);
    // The seam was really told to stop — a row relabelled while the bytes kept
    // going would still have created the file.
    expect(flight.signal.aborted).toBe(true);
    expect(h.rows()[0]!.state).toBe("cancelled");

    // The rejection the abort produces must not re-read as a failure.
    flight.reject(new Error("aborted"));
    await settle();
    expect(h.rows()[0]!.state).toBe("cancelled");
    expect(h.uploaded).toHaveLength(0);
  });

  it("a failure explains itself once, in the interface's voice", async () => {
    const h = harness();
    h.zone.add([fileOf("lease.pdf")]);
    await settle();
    h.pending()!.reject(new Error("boom"));
    await settle();
    expect(h.rows()[0]!.state).toBe("failed");
    expect(h.rows()[0]!.message).toBe("Couldn't upload 'lease.pdf'. Try again.");
  });

  it("a SERVER refusal is phrased with the same words as the pre-flight's", async () => {
    const h = harness();
    h.zone.add([fileOf("odd.pdf")]);
    await settle();
    h.pending()!.reject(new UploadRefusedError("quota", 413));
    await settle();
    expect(h.rows()[0]!.message).toContain("There isn't room for 'odd.pdf'");
  });

  it("sends ONE AT A TIME rather than fanning out", async () => {
    const h = harness();
    h.zone.add([fileOf("a.pdf"), fileOf("b.pdf")]);
    await settle();
    expect(h.rows()[0]!.state).toBe("sending");
    expect(h.rows()[1]!.state).toBe("queued");
    h.pending()!.resolve(entry("a.pdf"));
    await settle();
    expect(h.rows()[1]!.state).toBe("sending");
  });

  it("refuses everything when the surface has nowhere to put a file", () => {
    const h = harness({ dest: null });
    h.zone.add([fileOf("a.pdf")]);
    expect(h.rows()).toHaveLength(0);
    expect(h.toasts).toContain("There's nowhere to put a file here.");
  });

  it("draws a row per file, with a cancel only while it can still be stopped", async () => {
    const h = harness();
    h.zone.add([fileOf("a.pdf")]);
    await settle();
    expect(document.querySelectorAll(".transfer")).toHaveLength(1);
    expect(document.querySelector(".transfer__cancel")).not.toBeNull();
    h.pending()!.resolve(entry("a.pdf"));
    await settle();
    // Finished: there is nothing left to cancel, so the control goes.
    expect(document.querySelector(".transfer__cancel")).toBeNull();
  });
});

// --- the name conflict -------------------------------------------------------
//
// The behaviour CHANGE: a clash is a question, not a silent " (2)". The main use
// of web upload is to update a file you edited on your laptop, and quietly
// keeping both gets that exactly wrong — twice, since both copies then sync to
// the device.

describe("a name that is already taken", () => {
  it("ASKS rather than silently renaming", async () => {
    const h = harness({ existing: ["notes.pdf"], answer: { choice: "rename", applyToRest: false } });
    h.zone.add([fileOf("notes.pdf")]);
    await settle();
    expect(h.asked).toEqual([{ name: "notes.pdf", remaining: 0 }]);
  });

  it("never asks when the name is free", async () => {
    const h = harness({ existing: ["something else.pdf"] });
    h.zone.add([fileOf("notes.pdf")]);
    await settle();
    expect(h.asked).toEqual([]);
    expect(h.modes).toEqual(["rename"]);
  });

  it("never asks — and never replaces — when the folder's contents are unknown", async () => {
    // Null is "we have never listed that folder". Inventing a prompt from an
    // unknown would be worse than not asking, and the server's default is safe.
    const h = harness({ existing: null });
    h.zone.add([fileOf("notes.pdf")]);
    await settle();
    expect(h.asked).toEqual([]);
    expect(h.modes).toEqual(["rename"]);
  });

  it("Keep both sends the DEFAULT mode, so the occupant is untouched", async () => {
    const h = harness({ existing: ["notes.pdf"], answer: { choice: "rename", applyToRest: false } });
    h.zone.add([fileOf("notes.pdf")]);
    await settle();
    expect(h.modes).toEqual(["rename"]);
  });

  it("Replace sends `replace`, and the toast names the version", async () => {
    const h = harness({ existing: ["notes.pdf"], answer: { choice: "replace", applyToRest: false } });
    h.zone.add([fileOf("notes.pdf")]);
    await settle();
    expect(h.modes).toEqual(["replace"]);
    h.pending()!.resolve(entry("notes.pdf"));
    await settle();
    expect(h.toasts).toContain("Replaced 'notes.pdf'. The previous file is in its version history.");
  });

  it("CANCEL sends nothing at all", async () => {
    const h = harness({ existing: ["notes.pdf"], answer: { choice: "cancel", applyToRest: false } });
    h.zone.add([fileOf("notes.pdf")]);
    await settle();
    // Not "it failed" — the seam was never called.
    expect(h.modes).toEqual([]);
    expect(h.pending()).toBeNull();
    expect(h.rows()[0]!.state).toBe("cancelled");
  });

  it("asks ONCE for a batch when the answer is applied to the rest", async () => {
    const h = harness({
      existing: ["a.pdf", "b.pdf", "c.pdf"],
      answer: { choice: "replace", applyToRest: true },
    });
    h.zone.add([fileOf("a.pdf"), fileOf("b.pdf"), fileOf("c.pdf")]);
    await settle();
    // One dialog, not three — and it said how many others it would cover.
    expect(h.asked).toEqual([{ name: "a.pdf", remaining: 2 }]);
    expect(h.modes).toEqual(["replace"]); // one in flight; the rest are queued behind it
    expect(h.rows().map((r) => r.name)).toEqual(["a.pdf", "b.pdf", "c.pdf"]);
  });

  it("keeps the batch in DROP order even though the prompt is async", async () => {
    const h = harness({ existing: ["b.pdf"], answer: { choice: "rename", applyToRest: false } });
    h.zone.add([fileOf("a.pdf"), fileOf("b.pdf"), fileOf("c.pdf")]);
    await settle();
    expect(h.rows().map((r) => r.name)).toEqual(["a.pdf", "b.pdf", "c.pdf"]);
  });

  it("holds a clashing file OUT of the pump until it has been answered", async () => {
    // The hazard this guards: a row is queued from the instant of the drop (so
    // the list reads in order), and anything that nudges the pump meanwhile —
    // cancelling a different row — must not send a file whose mode is undecided.
    let answer: ((a: ConflictAnswer) => void) | null = null;
    const host = document.createElement("div");
    document.body.append(host);
    const modes: string[] = [];
    const zone = createUploadZone({
      target: host,
      overlayHost: host,
      listHost: host,
      destination: () => ({ id: "note", templates: false }),
      remainingBytes: () => null,
      existingNames: () => ["clash.pdf"],
      confirmConflict: () => new Promise<ConflictAnswer>((r) => (answer = r)),
      upload: (_f, _file, _p, _s, mode) => {
        modes.push(mode);
        return new Promise<Entry>(() => {});
      },
      onUploaded: () => {},
      toast: () => {},
    });
    zone.add([fileOf("clash.pdf")]);
    await settle();
    // The dialog is still open: nothing has been sent.
    expect(modes).toEqual([]);
    zone.cancel("nope"); // a stray pump nudge must not release it
    await settle();
    expect(modes).toEqual([]);
    answer!({ choice: "replace", applyToRest: false });
    await settle();
    expect(modes).toEqual(["replace"]);
  });
});

// --- the fake seam -----------------------------------------------------------

describe("the fake Api's upload", () => {
  it("puts the file in the folder it was sent to", async () => {
    const api = createFakeApi({ latencyMs: 0 });
    const created = await api.upload("projects", fileOf("lease.pdf"));
    expect(created.name).toBe("lease.pdf");
    const listing = await api.listFolder("projects");
    expect(listing.entries.some((e) => e.id === created.id)).toBe(true);
  });

  it("reports progress in steps, ending at 1", async () => {
    const api = createFakeApi({ latencyMs: 0 });
    const seen: number[] = [];
    await api.upload("projects", fileOf("a.pdf", 400_000), (f) => seen.push(f));
    expect(seen.length).toBeGreaterThan(1);
    expect(seen[seen.length - 1]).toBe(1);
    // Monotonic — a bar that goes backwards is worse than no bar.
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
  });

  it("refuses an off-list extension with the real 415 shape", async () => {
    const api = createFakeApi({ latencyMs: 0 });
    await expect(api.upload("projects", fileOf("clip.xyz"))).rejects.toMatchObject({
      name: "UploadRefusedError",
      reason: "type",
      status: 415,
    });
  });

  it("refuses a file over the fixture's headroom with the real 413 shape", async () => {
    const api = createFakeApi({ latencyMs: 0 });
    await expect(
      api.upload("projects", fileOf("huge.pdf", FAKE_UPLOAD_HEADROOM + 1)),
    ).rejects.toMatchObject({ name: "UploadRefusedError", reason: "quota", status: 413 });
  });

  it("404s for a destination that is not there", async () => {
    const api = createFakeApi({ latencyMs: 0 });
    await expect(api.upload("no-such-folder", fileOf("a.pdf"))).rejects.toMatchObject({ status: 404 });
  });

  it("KEEP BOTH (the default) suffixes rather than failing, as the device path does", async () => {
    const api = createFakeApi({ latencyMs: 0 });
    const first = await api.upload("projects", fileOf("dup.pdf"));
    const second = await api.upload("projects", fileOf("dup.pdf"));
    expect(first.name).toBe("dup.pdf");
    expect(second.name).toBe("dup (2).pdf");
    // Two files, both still there.
    const listing = await api.listFolder("projects");
    expect(listing.entries.filter((e) => e.name.startsWith("dup"))).toHaveLength(2);
  });

  it("REPLACE supersedes in place: one row, same id, nothing added", async () => {
    const api = createFakeApi({ latencyMs: 0 });
    const first = await api.upload("projects", fileOf("paper.pdf"));
    const before = (await api.listFolder("projects")).entries.length;

    const second = await api.upload("projects", fileOf("paper.pdf"), undefined, undefined, "replace");
    // SAME ID is the whole meaning of supersede: the file kept its identity and
    // gained a version, so every link to it still resolves.
    expect(second.id).toBe(first.id);
    const after = await api.listFolder("projects");
    expect(after.entries.length).toBe(before);
    expect(after.entries.filter((e) => e.name === "paper.pdf")).toHaveLength(1);
  });

  it("replace on a name that is NOT there just creates it", async () => {
    const api = createFakeApi({ latencyMs: 0 });
    const created = await api.upload("projects", fileOf("brand new.pdf"), undefined, undefined, "replace");
    expect(created.name).toBe("brand new.pdf");
  });

  it("stops when the caller aborts", async () => {
    const api = createFakeApi({ latencyMs: 1 });
    const ctl = new AbortController();
    const p = api.upload("projects", fileOf("big.pdf", 1_000_000), () => ctl.abort(), ctl.signal);
    await expect(p).rejects.toMatchObject({ code: "CANCELLED" });
  });

  it("uploads at the library ROOT", async () => {
    const api = createFakeApi({ latencyMs: 0 });
    const created = await api.upload(null, fileOf("root.pdf"));
    const listing = await api.listFolder(null);
    expect(listing.entries.some((e) => e.id === created.id)).toBe(true);
  });
});

describe("the drag target", () => {
  it("raises the dropzone only for a drag that CARRIES FILES", () => {
    const h = harness();
    const target = document.querySelector("div")!;
    const drag = (types: string[]): void => {
      const e = new Event("dragenter", { bubbles: true, cancelable: true }) as DragEvent;
      Object.defineProperty(e, "dataTransfer", { value: { types } });
      target.dispatchEvent(e);
    };
    // A text selection or a dragged card is not an upload, and must not put a
    // "drop files here" sheet over the gallery.
    drag([]);
    expect(h.zone.isDragging()).toBe(false);
    drag(["Files"]);
    expect(h.zone.isDragging()).toBe(true);
  });

  it("says TEMPLATE on the dropzone when hovering the device's template folder", () => {
    const h = harness({ dest: { id: "mystyle", templates: true } });
    const target = document.querySelector("div")!;
    const e = new Event("dragenter", { bubbles: true, cancelable: true }) as DragEvent;
    Object.defineProperty(e, "dataTransfer", { value: { types: ["Files"] } });
    target.dispatchEvent(e);
    expect(document.querySelector(".dropzone__title")!.textContent).toBe(
      "Drop an image or PDF to add a template",
    );
    expect(h.zone.isDragging()).toBe(true);
  });
});
