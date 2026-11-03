// How the UI decides what a synced file is, and where to fetch its raw bytes.
// `NoteSummary.fileType` is server-verified; this turns it into a rendering
// decision.

import type { Hash, Id } from "./types";

/** What the UI can do with a file: SNPG reader, native `<img>`, or download only. */
export type FileKind = "note" | "image" | "file";

/**
 * Types we will put in an `<img>`. Mirrors the server's inline allowlist in
 * `handlers/controlplane.zig`; anything else is served as an attachment. `svg`
 * is excluded on both sides because it can carry `<script>` (stored XSS).
 */
export const PREVIEWABLE_IMAGE_TYPES: readonly string[] = ["png", "jpg", "jpeg", "webp", "gif"];

/**
 * Types the `.note` stage can paint. `mark` is the device's PDF-annotation
 * file, a thin `.note` container rendered like a notebook.
 */
const NOTE_STAGE_TYPES: readonly string[] = ["note", "mark"];

/** Classify a server-verified `fileType` (lowercase, no dot). */
export function fileKind(fileType: string): FileKind {
  if (NOTE_STAGE_TYPES.includes(fileType)) return "note";
  return PREVIEWABLE_IMAGE_TYPES.includes(fileType.toLowerCase()) ? "image" : "file";
}

/**
 * Whether a file's version history can be previewed in-app: `.note`/`.mark`,
 * `.spd`, `.txt` (bespoke viewers) and images. Shared by the entry point and
 * the preview dispatch.
 */
export function canPreviewHistory(fileType: string): boolean {
  const t = fileType.trim().toLowerCase();
  return t === "note" || t === "mark" || t === "spd" || t === "txt" || fileKind(t) === "image";
}

/**
 * Whether this type has a viewer of its own: the set `library.viewerFor`
 * dispatches on and the bin's gate between opening a viewer and its in-bin
 * preview. Images are left to the bin's preview.
 */
export function hasDedicatedViewer(fileType: string): boolean {
  const t = (fileType || "").trim().toLowerCase();
  return fileKind(t) === "note" || t === "spd" || t === "txt" || t === "pdf";
}

// --- upload (web → cloud → device) ---
// What the device can open once the file arrives. Shared by the client
// pre-flight, the fake `Api` and the picker's `accept`; the server keeps its own
// copy and is the authority.

/**
 * Extensions the device opens, lowercase, no dot: Ratta's list for Manta/Nomad
 * plus `.spd` (device-authored, restorable from backup) and `.mobi` (opens via
 * the bundled Kindle app).
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
 * A filename's extension, lowercase, no dot, `""` when none. A plain last-dot
 * split: an upload has no server-verified type yet. `.gitignore` has none.
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
 * The name `desired` gets in a folder already holding `taken`: itself, else
 * `notes (2).pdf`, `notes (3).pdf`, … The conflict prompt promises this name
 * before upload, so the fake `Api` uses this function and the server mirrors
 * it. Suffix goes before the extension; matching is case-insensitive.
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

/** The file picker's `accept`: a hint only; drag and drop bypasses it. */
export const UPLOAD_ACCEPT_ATTR: string = UPLOAD_ACCEPT.map((e) => `.${e}`).join(",");

/**
 * The raw-bytes URL `GET /file/{id}?v={hash}`, or null with no hash (the route
 * requires `?v=`, which is what makes it `immutable`). `bin` targets the trashed
 * route instead, since `Files.get` hardcodes `deleted = 0`.
 */
export function rawFileUrl(id: Id, hash: Hash | null, opts: { download?: boolean; bin?: boolean } = {}): string | null {
  if (!hash) return null;
  const q = `v=${encodeURIComponent(hash)}${opts.download ? "&download=1" : ""}`;
  const base = opts.bin ? "/api/controlplane/bin/file" : "/file";
  return `${base}/${encodeURIComponent(id)}?${q}`;
}

/**
 * The raw-bytes URL of a retained version,
 * `GET /api/controlplane/note/{id}/history/{md5}/raw`; content-addressed, so no
 * `?v=`. Null without an md5. `bin` targets the trashed twin route, as in
 * {@link rawFileUrl}.
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
