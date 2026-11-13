// A passage of text made to fit a control or a sentence: on one line, and
// short. A digest's passage in a card, a menu or the bin's words. No DOM.

/** A passage on one line: its line breaks and runs of space as single spaces. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** At most `max` characters of `text`, cut at a word, with "…" when cut: a control's text, not a whole passage. */
export function shorten(text: string, max = 240): string {
  const flat = oneLine(text);
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
