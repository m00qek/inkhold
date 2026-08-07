// How the UI decides what a synced file IS, and where to fetch its raw bytes.
//
// The tree is not all `.note`. The device syncs whatever the user drops in —
// `EXPORT/` in particular is full of PNGs exported from notes — and the reader
// used to open every one of them into a blank canvas, because the backend
// fabricates a placeholder page for any blob it cannot parse and nothing on the
// wire said the page was fake. `NoteSummary.fileType` is now server-verified, so
// this module is the one place that turns it into a rendering decision.

import type { Hash, Id } from "./types";

/**
 * What the UI can do with a file:
 *   - `note`  — the SNPG reader pipeline (the only thing that has real pages);
 *   - `image` — the browser renders it natively from the raw-bytes endpoint;
 *   - `file`  — no preview; show what it is and offer the download.
 */
export type FileKind = "note" | "image" | "file";

/**
 * Types we will put in an `<img>`. **This mirrors the server's inline allowlist**
 * in `handlers/controlplane.zig` and must not drift from it: anything absent here
 * is served `Content-Disposition: attachment`, so pointing an `<img>` at it would
 * paint a broken image instead of a preview.
 *
 * `svg` is deliberately excluded, on both sides. It is an XML document that can
 * carry `<script>`, so the server refuses to serve it inline; treating it as an
 * image here would only produce a broken `<img>` and would put us one careless
 * `<object>`/`<iframe>` away from same-origin stored XSS. An `.svg` gets the
 * honest state and a download, like any other unrecognised type.
 *
 * `pdf` is excluded too, for a different and weaker reason: the server WILL serve
 * it inline, so an `<embed>` preview is available if we ever want it. We do not
 * take it yet — a download is honest, and it keeps the reader from carrying a
 * second, differently-behaved viewer for one file type.
 */
export const PREVIEWABLE_IMAGE_TYPES: readonly string[] = ["png", "jpg", "jpeg", "webp", "gif"];

/**
 * Types the reader's `.note` stage can paint. `mark` is the device's
 * PDF-ANNOTATION sibling — a thin `.note` container, so the SNPG pipeline
 * renders it exactly like a notebook (its ink, on nothing).
 *
 * It has always rendered; until schema v6 the server could not TELL us it was a
 * mark and reported it as `note`. Listing it here is what keeps that behaviour
 * once the server starts telling the truth — dropping it would turn a file the
 * user can read today into "no preview".
 *
 * What it is NOT is a notebook, and the UI may eventually say so (pair it with
 * its PDF, name it "annotations"). That is a labelling question; this is the
 * rendering one.
 */
const NOTE_STAGE_TYPES: readonly string[] = ["note", "mark"];

/** Classify a server-verified `fileType` (lowercase, no dot). */
export function fileKind(fileType: string): FileKind {
  if (NOTE_STAGE_TYPES.includes(fileType)) return "note";
  return PREVIEWABLE_IMAGE_TYPES.includes(fileType.toLowerCase()) ? "image" : "file";
}

/**
 * Whether a file's version HISTORY can be PREVIEWED in-app — the one gate the
 * "Version history" entry point and the preview dispatch share, so they cannot
 * drift. True for the kinds that have a viewer to paint a past version:
 *   - `.note` — the reader's SNPG pipeline (per-page, server-rendered);
 *   - `.spd` / `.txt` — their own viewers, CLIENT-SIDE from the raw version bytes;
 *   - images — the reader's image mode, an `<img>` off the raw version bytes.
 * Everything else (a `.pdf`, an unknown blob) has no viewer to render a version,
 * so its history stays unlisted even though the backend retains it (H6). `.spd`
 * and `.txt` are named explicitly because {@link fileKind} folds them into
 * `"file"` — they are previewable through their bespoke viewers, not the reader.
 */
export function canPreviewHistory(fileType: string): boolean {
  const t = fileType.trim().toLowerCase();
  return t === "note" || t === "mark" || t === "spd" || t === "txt" || fileKind(t) === "image";
}

/**
 * Whether this type has a viewer of its OWN — the set `library.viewerFor`
 * dispatches on, and the gate the recycle bin uses to decide whether a row opens
 * a real viewer or its small in-bin "is this the one I meant?" preview.
 *
 * SHARED SO THE TWO CANNOT DRIFT, which is not hypothetical: the bin had this
 * set written out inline as `note || spd || txt`, under a comment claiming it
 * was "the same set `library.viewerFor` dispatches on". It stopped being true
 * the day the PDF viewer was added — `viewerFor` gained a `pdf` case and the
 * bin's copy did not — so a trashed PDF fell into the preview panel and could be
 * neither restored nor deleted from the place you were looking at it.
 *
 * `.spd`, `.txt` and `.pdf` are named explicitly because {@link fileKind} folds
 * them into `"file"`: they are viewable through their bespoke viewers, not the
 * reader. Images deliberately are NOT here — the reader's image mode paints a
 * live one, but a trashed image is exactly the "is this the screenshot I meant?"
 * question the bin's own preview answers better.
 */
export function hasDedicatedViewer(fileType: string): boolean {
  const t = (fileType || "").trim().toLowerCase();
  return fileKind(t) === "note" || t === "spd" || t === "txt" || t === "pdf";
}

// --- UPLOAD (web → cloud → device) -------------------------------------------
//
// What the WEB may send INTO the tree. A different
// question from `fileKind` above — that one asks what the browser can DO with a
// file already in the library; this one asks what the NOMAD can open once the
// file gets there, because the device is the reader for most of these and the
// web is only the way in.
//
// SHARED BY THREE CALLERS, which is why it lives in `core/` rather than beside
// the dropzone: the client-side pre-flight (refuse before transferring), the
// fake `Api` (so the 415 path is exercisable with no server), and the file
// picker's `accept` attribute. The real server keeps its own copy — this is a
// courtesy gate that saves a doomed upload, never the authority.

/**
 * Extensions the device opens, lowercase and without the dot.
 *
 * Ratta's published list for the Manta/Nomad — `.note`, PDF, EPUB, Word, text,
 * PNG/JPG/WebP, CBZ, FB2, XPS — plus two deliberate additions:
 *
 *  - `.spd` is absent from that list because it is device-AUTHORED rather than
 *    an advertised import type. It is accepted anyway: restoring a sketch from a
 *    backup is a real case, and Inkhold has its own `.spd` viewer, so the file is
 *    first-class on the WEB even where the device treats it as its own.
 *  - `.mobi` is uploadable but reads through the bundled Kindle app rather than
 *    natively — accepted, with nothing in the UI implying a native open.
 */
export const UPLOAD_ACCEPT: readonly string[] = [
  "note",
  "spd",
  "pdf",
  "epub",
  "doc",
  "docx",
  "txt",
  "png",
  "jpg",
  "jpeg",
  "webp",
  "cbz",
  "fb2",
  "xps",
  "mobi",
];

/**
 * A filename's extension, lowercase and WITHOUT the dot — `""` when it has none.
 *
 * Deliberately a plain last-dot split, unlike `renameDialog.peelName`: there the
 * entry's own server-verified `fileType` says where the name ends, and here there
 * is no such answer yet — an uploaded file is only its name until the server has
 * sniffed it. A leading-dot name (`.gitignore`) has no extension by this reading,
 * which is the honest answer: it is not a `.gitignore`-typed file.
 */
export function uploadExtension(name: string): string {
  const base = name.slice(name.lastIndexOf("/") + 1).trim();
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
}

/** Whether the device could open a file with this name (see {@link UPLOAD_ACCEPT}). */
export function isAcceptedUpload(name: string): boolean {
  return UPLOAD_ACCEPT.includes(uploadExtension(name));
}

/**
 * The name `desired` would actually get in a folder that already holds `taken` —
 * itself if it is free, else `notes (2).pdf`, `notes (3).pdf`, …
 *
 * THE SAME RULE ON BOTH SIDES OF THE WIRE, which is the only reason it is here
 * rather than inside either caller: the conflict prompt PROMISES a name ("Keep
 * both saves it as 'notes (2).pdf'") before anything is sent, and the server
 * then picks one. A promise made by one algorithm and kept by another is a
 * promise that will eventually be broken, so the fake `Api` resolves collisions
 * through this exact function and the real endpoint mirrors it.
 *
 * The suffix goes before the EXTENSION, never after it — `notes (2).pdf`, not
 * `notes.pdf (2)` — or the device would stop recognising what the file is.
 * Matching is case-insensitive, because the tree's own collision rule is.
 */
export function nextAvailableName(desired: string, taken: readonly string[]): string {
  const lower = new Set(taken.map((t) => t.toLowerCase()));
  if (!lower.has(desired.toLowerCase())) return desired;
  const dot = desired.lastIndexOf(".");
  const stem = dot > 0 ? desired.slice(0, dot) : desired;
  const ext = dot > 0 ? desired.slice(dot) : "";
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!lower.has(candidate.toLowerCase())) return candidate;
  }
}

/**
 * The `accept` attribute for the file picker — a HINT the OS dialog uses to filter,
 * never a check. The picker can always be talked into returning anything (drag and
 * drop bypasses it outright), so the pre-flight runs on every file regardless.
 */
export const UPLOAD_ACCEPT_ATTR: string = UPLOAD_ACCEPT.map((e) => `.${e}`).join(",");

/**
 * The raw-bytes URL for a file: `GET /file/{id}?v={hash}`, optionally forced to a
 * download. Null when we have no content hash — the route REQUIRES `?v=` (that is
 * what makes its year-long `immutable` response honest), so a hashless entry has
 * no addressable URL and the caller must render without one rather than request a
 * guaranteed 404.
 *
 * `bin` mints the TRASHED twin instead: `GET /api/controlplane/bin/file/{id}`,
 * same `?v=` contract. The live route goes through `Files.get`, which hardcodes
 * `deleted = 0` as the shared ownership boundary, so it 404s for anything in the
 * recycle bin — a viewer opened with a `"bin"` origin has to say so here. One
 * option on one function, rather than a second URL builder per caller, so the
 * two routes cannot drift apart in shape (see `binFileUrl` in pages/bin.ts,
 * which delegates here).
 */
export function rawFileUrl(id: Id, hash: Hash | null, opts: { download?: boolean; bin?: boolean } = {}): string | null {
  if (!hash) return null;
  const q = `v=${encodeURIComponent(hash)}${opts.download ? "&download=1" : ""}`;
  const base = opts.bin ? "/api/controlplane/bin/file" : "/file";
  return `${base}/${encodeURIComponent(id)}?${q}`;
}

/**
 * The version-scoped raw-bytes URL for a RETAINED version of a file:
 * `GET /api/controlplane/note/{id}/history/{md5}/raw`. The HISTORY twin of
 * `binFileUrl` — same job (fetch a blob the plain `/file/{id}?v=` route will not
 * serve), a different route. Where `bin` reroutes because `Files.get` hardcodes
 * `deleted = 0`, this reroutes because the live route only ever serves the
 * CURRENT blob; the `:md5` names an immutable retained version instead, so it is
 * content-addressed on its own and needs no `?v=`. `download=1` forces the
 * attachment disposition, exactly as `rawFileUrl` does. Null when there is no
 * md5 — a caller with no version then has no URL rather than a guaranteed 404,
 * the same contract `rawFileUrl` keeps for a hashless entry.
 *
 * This is the one URL builder the raw-based history preview shares: `.spd`
 * (`spdViewer`), `.txt` (`txtViewer`) and the reader's image mode all fetch a
 * version's bytes through it, the structural mirror of how they fetch the live
 * bytes through `rawFileUrl(id, hash, { bin })`.
 *
 * `bin` mints the TRASHED twin — `GET /api/controlplane/bin/note/:id/history/:md5/raw`
 * — for previewing a past version of a file that is IN the recycle bin: the live
 * history route is gated on `deleted = 0` and 404s for a trashed file, exactly as
 * `/file/:id?v=` does, so a raw viewer previewing a trashed file's version has to
 * say so here (the same `bin` seam `rawFileUrl` grew). One option on one function,
 * so the live and trashed history-raw routes cannot drift in shape.
 */
export function historyFileUrl(id: Id, md5: Hash | null, opts: { download?: boolean; bin?: boolean } = {}): string | null {
  if (!md5) return null;
  const prefix = opts.bin ? "/api/controlplane/bin/note" : "/api/controlplane/note";
  const base = `${prefix}/${encodeURIComponent(id)}/history/${encodeURIComponent(md5)}/raw`;
  return opts.download ? `${base}?download=1` : base;
}

/** A short human size for the "no preview" state. Binary units, one decimal. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
