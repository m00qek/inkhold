// Normalizers that make server VOs safe for the UI: defaults, slots, aspects.

import type { Entry, FileVersion, LayerSlot, PageLayer, PageRef, WordBox } from "../core/types";

/**
 * Fill in the optionals the server omits (`emit_null_optional_fields = false`).
 * `textHash` is absent on pages without recognized text.
 */
export function normalizePage(p: PageRef): PageRef {
  return {
    index: p.index,
    hash: p.hash,
    width: p.width,
    height: p.height,
    textHash: p.textHash ?? null,
    linksHash: p.linksHash ?? null,
    // Omitted wherever it would be `index + 1`; 0 or below is not a page.
    sourcePage: typeof p.sourcePage === "number" && p.sourcePage > 0 ? p.sourcePage : null,
    // Three-state, so `undefined`, not `null`: true, false, or "not scanned yet"
    // (key omitted). A mark is drawn only on a positive.
    hasInk: typeof p.hasInk === "boolean" ? p.hasInk : undefined,
    layers: normalizeLayers(p.layers),
  };
}

const LAYER_SLOTS: ReadonlySet<string> = new Set(["main", "layer1", "layer2", "layer3", "background"]);

/**
 * Validate `layers` or degrade to `null` (no panel). All-or-nothing: entries
 * pair with the payload's SNPG records by slot, and a row on the wrong pixels is
 * worse than the composite. Exported for tests.
 */
export function normalizeLayers(layers: PageLayer[] | null | undefined): PageLayer[] | null {
  if (!Array.isArray(layers) || layers.length === 0) return null;
  const seen = new Set<string>();
  const out: PageLayer[] = [];
  for (const l of layers) {
    if (typeof l?.slot !== "string" || !LAYER_SLOTS.has(l.slot)) return null;
    if (seen.has(l.slot)) return null;
    seen.add(l.slot);
    out.push({
      slot: l.slot as LayerSlot,
      // Device-authored; `""` means no display name.
      name: typeof l.name === "string" ? l.name : "",
      // A missing flag reads as visible-and-not-current, claiming nothing extra.
      visible: typeof l.visible === "boolean" ? l.visible : true,
      isCurrent: l.isCurrent === true,
    });
  }
  return out;
}

/** Drop malformed device-authored word boxes before they reach the PDF generator as `NaN`. */
export function normalizeWords(words: WordBox[] | undefined): WordBox[] {
  if (!Array.isArray(words)) return [];
  return words
    .filter(
      (w): w is WordBox =>
        typeof w?.text === "string" &&
        [w.xMm, w.yMm, w.wMm, w.hMm].every((v) => typeof v === "number" && Number.isFinite(v)),
    )
    .map((w) => ({ text: w.text, xMm: w.xMm, yMm: w.yMm, wMm: w.wMm, hMm: w.hMm }));
}

export function fileTypeFromName(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "file";
  return name.slice(dot + 1).toLowerCase();
}

/**
 * A safe preview-shape pair, or `undefined` (layout falls back to 3:4). A bad
 * pair would reach CSS as `aspect-ratio: NaN` and silently disable the property.
 */
export function normalizeAspect(a: { w?: number; h?: number } | undefined | null): { w: number; h: number } | undefined {
  if (!a || typeof a.w !== "number" || typeof a.h !== "number") return undefined;
  if (!Number.isFinite(a.w) || !Number.isFinite(a.h) || a.w <= 0 || a.h <= 0) return undefined;
  return { w: a.w, h: a.h };
}

/** Fill in the optionals the server omits on a listing entry. */
export function normalizeEntry(e: Entry): Entry {
  return e.kind === "note"
    ? {
        ...e,
        firstPage: normalizePage(e.firstPage),
        fileType: e.fileType ?? fileTypeFromName(e.name),
        // No hash → no raw-bytes URL (the route requires `?v=`).
        fileHash: e.fileHash ?? null,
        hasRecognizedText: e.hasRecognizedText ?? false,
        // Absent for most entries; only `.note`/`.spd` state a shape.
        thumbAspect: normalizeAspect(e.thumbAspect),
        // Absent or unusable reads as `null`.
        annotationsId:
          typeof e.annotationsId === "string" && e.annotationsId !== "" ? e.annotationsId : null,
      }
    : {
        ...e,
        // `undefined`, not `0`: absent is "not counted", `0` is "counted, empty".
        itemCount: typeof e.itemCount === "number" && e.itemCount >= 0 ? e.itemCount : undefined,
      };
}

/**
 * `current` is emitted only on the live version. A malformed `createdAt`
 * becomes 0; a row with no md5 is dropped by the caller.
 */
export function normalizeVersion(v: {
  md5?: unknown;
  size?: unknown;
  createdAt?: unknown;
  current?: unknown;
  pageCount?: unknown;
}): FileVersion | null {
  if (typeof v?.md5 !== "string" || v.md5 === "") return null;
  return {
    md5: v.md5,
    size: typeof v.size === "number" && Number.isFinite(v.size) && v.size > 0 ? Math.floor(v.size) : 0,
    createdAt: typeof v.createdAt === "number" && Number.isFinite(v.createdAt) && v.createdAt > 0 ? v.createdAt : 0,
    current: v.current === true,
    // Sent only for a `.note`; otherwise 0, and the UI falls back to byte size.
    pageCount:
      typeof v.pageCount === "number" && Number.isFinite(v.pageCount) && v.pageCount > 0
        ? Math.floor(v.pageCount)
        : 0,
  };
}
