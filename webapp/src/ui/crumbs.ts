// The top bar's breadcrumbs, shared by the library and the destinations that
// borrow its bar (the bin, admin, the account page): links back up, a drawn
// separator, and the current place.

import { el } from "./dom";
import { onPlainClick } from "./link";

/** A crumb back up to `href`; a plain click runs `onOpen`, which may do more than navigate. */
export function crumbLink(label: string, href: string, onOpen: () => void): HTMLElement {
  const a = el("a", { href, text: label });
  onPlainClick(a, onOpen);
  return a;
}

/** The separator is drawing, not words. */
export function crumbSep(): HTMLElement {
  return el("span", { class: "crumbs__sep", "aria-hidden": "true", text: "/" });
}

/** Where you are: the last crumb, not a link. */
export function crumbHere(text: string): HTMLElement {
  return el("span", { class: "crumbs__here", "aria-current": "page", text });
}

/** "Library / <here>", the trail of a destination one step from the library. */
export function libraryTrail(here: string, onLibrary: () => void, libraryHref: string): HTMLElement[] {
  return [crumbLink("Library", libraryHref, onLibrary), crumbSep(), crumbHere(here)];
}
