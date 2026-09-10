// The viewer toolbars' glyph set, plus a re-export of the ONE `svg()` impl in
// `ui/icons.ts`, so a viewer takes glyphs and wrapper from a single import.

import { ICONS, svg } from "../ui/icons";

export { svg };

/**
 * The glyph set the reader / `.spd` / `.txt` bars and the shared layers panel
 * all draw. Four entries re-point at an app-shell glyph so the mark is one
 * across every surface; the rest stay distinct on purpose, each noted below.
 */
export const VIEWER_IC = {
  back: '<path d="m15 18-6-6 6-6"/>',
  prev: '<path d="m15 18-6-6 6-6"/>',
  next: '<path d="m9 18 6-6-6-6"/>',
  minus: '<path d="M5 12h14"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  // Two offset sheets, the universal "put this on the clipboard" — deliberately
  // not the `text` glyph, which means "this file is text" in the export menu.
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  // Download-into-tray, deliberately NOT `ICONS.export` (an up-and-out arrow):
  // "download onto my machine" reads differently from "export/share".
  down: '<path d="M12 3v12"/><path d="m8 11 4 4 4-4"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
  // A 3-path stack, deliberately NOT `ICONS.layers` (2-path): the viewer's
  // Layers control and the gallery's Layers marker differ at 16px.
  layers: '<path d="m12 2 9 5-9 5-9-5 9-5z"/><path d="m3 12 9 5 9-5"/><path d="m3 17 9 5 9-5"/>',
  // The "Pages" panel mark: a sheet split into a filmstrip of thumbnails.
  pages: '<rect x="5" y="3" width="14" height="18" rx="1.5"/><path d="M5 9h14M5 15h14"/>',
  // An indented list seen edge on. Deliberately NOT `pages`: the two navigation
  // panels sit side by side in one toolbar zone and share a dock, so a mark
  // either of them could wear would be no mark at all.
  outline: '<path d="M4 6h4M4 12h4M4 18h4"/><path d="M11 6h9M13 12h7M13 18h7"/>',
  // The layers panel's per-row eye / eye-off.
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><path d="M1 1l22 22"/><path d="M6.61 6.61A18.5 18.5 0 0 0 1 12s4 8 11 8a9.12 9.12 0 0 0 5.39-1.61"/>',
  // Byte-identical to an app-shell glyph — re-pointed so it is ONE mark everywhere.
  find: ICONS.search,
  text: ICONS.ocr,
  trash: ICONS.trash,
  restore: ICONS.restore,
};
