// Two real notebooks for the demo and the docs' screenshots: their pages are
// the SNPG payloads a real server served (webapp/demo/notes/, made by
// demo/notes/extract.mjs), drawn by the real decoder (render/fake.ts hands
// them to the wasm renderer). Real ink where the fake library otherwise paints
// zigzags, and real recognised text for search.
//
// On in `npm run demo`, or where `sn.demo-notes` is "1" in localStorage (the
// screenshot run sets it). Off in the e2e suite, whose counts they would move.
// The bytes come from `/demo-notes/`, which only the dev server answers
// (vite.config.ts), so nothing here reaches a production build.

import type { Id, NoteMeta, NoteSummary, PageRef, PageText } from "../core/types";
import { normalizePage } from "./normalize";
import welcome from "../../demo/notes/welcome/meta.json" with { type: "json" };
import ozymandias from "../../demo/notes/ozymandias/meta.json" with { type: "json" };

interface DemoNote {
  id: Id;
  slug: string;
  name: string;
  /** Hours before now: its place in "Recent". */
  ageHours: number;
  meta: { pages: PageRef[]; fileHash?: string; size?: number; pxPerMm?: number };
}

/** The saved JSON is the wire shape (optional fields omitted); `normalizePage` fills them, as the HTTP client does. */
const wire = (json: unknown): DemoNote["meta"] => json as DemoNote["meta"];

const NOTES: DemoNote[] = [
  { id: "191", slug: "welcome", name: "Welcome to Inkhold", ageHours: 2, meta: wire(welcome) },
  { id: "192", slug: "ozymandias", name: "Ozymandias", ageHours: 26, meta: wire(ozymandias) },
];

/**
 * The demo's German grammar sheet: a real three-page PDF
 * (`demo/german-pdf.mjs`) that the demo's digests quote, so opening one
 * lands on its passage. The dev server serves its bytes (vite.config.ts).
 */
export const DEMO_GRAMMAR_ID: Id = "193";

/** Whether the demo notebooks are in the library. */
export function demoNotesOn(): boolean {
  if (import.meta.env.VITE_DEMO === "1") return true;
  try {
    return localStorage.getItem("sn.demo-notes") === "1";
  } catch {
    return false;
  }
}

const byId = new Map(NOTES.map((n) => [n.id, n]));
const pageHashes = new Set(NOTES.flatMap((n) => n.meta.pages.map((p) => p.hash)));

export const isDemoNote = (id: Id): boolean => byId.has(String(id));
/** A page whose bytes are a real SNPG payload, for the real decoder. */
export const isDemoPage = (hash: string): boolean => pageHashes.has(hash);

const pagesOf = (n: DemoNote): PageRef[] => n.meta.pages.map((p) => normalizePage(p));

/** Listing rows, newest first relative to `now`. */
export function demoSummaries(now: number): NoteSummary[] {
  return NOTES.map((n) => {
    const pages = pagesOf(n);
    return {
      kind: "note",
      id: n.id,
      name: n.name,
      pageCount: pages.length,
      firstPage: pages[0]!,
      updatedAt: now - n.ageHours * 3_600_000,
      fileType: "note",
      fileHash: n.meta.fileHash ?? null,
      hasRecognizedText: pages.some((p) => p.textHash !== null),
      thumbAspect: { w: pages[0]!.width, h: pages[0]!.height },
      annotationsId: null,
    } as NoteSummary;
  });
}

export function demoMeta(id: Id): NoteMeta {
  const n = byId.get(String(id))!;
  return {
    id: n.id,
    name: n.name,
    pages: pagesOf(n),
    fileType: "note",
    fileHash: n.meta.fileHash ?? null,
    size: n.meta.size ?? 0,
    annotationsId: null,
    pxPerMm: typeof n.meta.pxPerMm === "number" && n.meta.pxPerMm > 0 ? n.meta.pxPerMm : null,
  };
}

export async function demoPageBytes(id: Id, page: PageRef): Promise<ArrayBuffer> {
  const n = byId.get(String(id))!;
  const r = await fetch(`/demo-notes/${n.slug}/page-${page.index}.snpg`);
  if (!r.ok) throw new Error(`demo note page ${n.slug}/${page.index}: ${r.status}`);
  return r.arrayBuffer();
}

export async function demoPageText(id: Id, page: PageRef): Promise<PageText> {
  const n = byId.get(String(id))!;
  if (page.textHash === null) return { text: "", words: [] };
  const r = await fetch(`/demo-notes/${n.slug}/page-${page.index}.text.json`);
  if (!r.ok) throw new Error(`demo note text ${n.slug}/${page.index}: ${r.status}`);
  return (await r.json()) as PageText;
}
