// The app shell's icon set — the mockup's line glyphs, as raw `<path>` bodies
// plus the one wrapper that gives them a viewBox and a stroke.
//
// Shared rather than owned by library.ts because the rail (rail.ts) and the
// gallery (library.ts) draw from the SAME set: the rail's Document anchor and a
// PDF card's placeholder tile are deliberately one symbol, and a copy of the
// path data in each file is how that stops being true. The reader keeps its own
// toolbar set (`IC` in reader.ts) — a different surface with a different
// vocabulary — with one exception, noted on `ocr` below.

export const ICONS = {
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  // A NOTEBOOK, for the `Note` category anchor — its own glyph rather than the
  // generic `folder` (a folder-in-a-folder), so the Library's pinned Note reads
  // as the thing you write in, not as another container. The mockup's exact path.
  note: '<rect x="5.5" y="4" width="13" height="16" rx="1.5"/><path d="M9.5 4v16"/><path d="M6 8.5h2M6 12h2M6 15.5h2"/>',
  doc: '<path d="M6 3h8l5 5v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M14 3v5h5"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5 9-5z"/><path d="m3 13 9 5 9-5"/>',
  export: '<path d="M12 15V3"/><path d="m8 7 4-4 4 4"/><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m4 18 5-4 4 3 3-2 4 3"/>',
  inbox: '<path d="M4 13h4l2 3h4l2-3h4"/><path d="M4 13 6 5h12l2 8v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  logout: '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="M10 17l5-5-5-5"/><path d="M15 12H3"/>',
  // Deliberately the SAME glyph as the reader toolbar's "Text" toggle (IC.text in
  // reader.ts): the gallery marker and the panel it predicts are one idea, so
  // they must be one symbol.
  // The two destinations' glyphs. Added here, once, ahead of the features that
  // use them: both are rail entries drawn from this shared set, and a glyph
  // defined twice is the duplication this module exists to prevent.
  trash: '<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
  // The overflow menu's two bin-row verbs, added here so the menu component
  // (ui/menu.ts) draws from the same set as the rail and the gallery:
  //  - `restore`: an anticlockwise return arrow — undoing a deletion, not a
  //    refresh. Byte-for-byte the reader toolbar's `IC.restore`, so "Restore" is
  //    one mark across every surface that offers it.
  //  - `trashX`: the bin can with an X where its two vertical bars were, for the
  //    ONE destructive verb "Delete permanently". Distinct from `trash` (move to
  //    bin) at 16px, which a shared glyph with a red tint alone would not be.
  restore: '<path d="M3 4v6h6"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L3 10"/>',
  trashX: '<path d="M4 7h16"/><path d="M10 11l4 6M14 11l-4 6"/><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
  users: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20a6 6 0 0 1 12 0"/><path d="M16.5 5.5a3.2 3.2 0 0 1 0 6"/><path d="M18 14.6A6 6 0 0 1 21 20"/>',
  ocr: '<path d="M4 7V5a1 1 0 0 1 1-1h2M17 4h2a1 1 0 0 1 1 1v2M20 17v2a1 1 0 0 1-1 1h-2M7 20H5a1 1 0 0 1-1-1v-2"/><path d="M8 9h5M8 12h8M8 15h6"/>',
  // The pencil the mockup puts inside every "Change" control. A labelled action
  // in this app reads as glyph-then-words everywhere else (Empty bin, Unlink,
  // Export), and the two Change buttons were the only ones without one.
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  // THE PADLOCK PAIR — the admin console's elevation, on the rail and on its own
  // Lock button. They must differ in SHAPE and not only in colour (the rail
  // paints both in `currentColor`), so the distinction is the shackle: `lock`
  // closes a full arch onto both shoulders of the body, `locked-open` leaves the
  // right leg detached and the arch swung up and away. That reads at 16px; a
  // pair differing only by a small notch does not.
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  unlock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.8-1.2"/>',
};

/** Which glyphs exist — what a declarative entry (a rail row, a card) names. */
export type IconName = keyof typeof ICONS;

export function svg(paths: string, sw = 1.6): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
}
