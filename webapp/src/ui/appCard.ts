// A tablet app's overview card: To-Do's lists and Digest's categories and
// sources, one card per place, like a folder's contents in the library. Its
// name is the link, stretched over the card; the ⋯ sits above that link, so a
// button never nests inside a link. Styles: `styles/25-app-cards.css`.

import { el } from "./dom";
import { onPlainClick } from "./link";
import { ICONS, svg, type IconName } from "./icons";

export interface AppCardSpec {
  name: string;
  icon: IconName;
  href: string;
  /** A plain click: the app goes there itself. */
  onOpen(): void;
  /** The line under the name: counts, and what is late; dotted apart. */
  counts: (Node | string | null)[];
  /** The first few things inside, a row each (To-Do's tasks). */
  peek: (Node | null)[][];
  /** Or the newest thing inside, whole, and where it came from (a Digest category's passage). */
  quote?: { text: string; from: string } | null;
  /** How many more there are than `peek` or `quote` shows. */
  more: number;
  /** The card's ⋯ (`createMenu`); null: a place nothing can be done to. */
  menu: HTMLElement | null;
  /** A picture of what is inside, above the name. */
  thumb?: HTMLElement | null;
  /** The app's own class beside `app-card`. */
  kind: string;
}

/** One card, as the list item an `app-cards` list holds. */
export function appCard(c: AppCardSpec): HTMLElement {
  const link = el("a", { class: "app-card__link", href: c.href, text: c.name });
  onPlainClick(link, c.onOpen);
  const card = el(
    "div",
    { class: `app-card ${c.kind}` },
    c.thumb ?? null,
    el(
      "span",
      { class: "app-card__head" },
      el("span", { class: "app-card__ico", "aria-hidden": "true", html: svg(ICONS[c.icon]) }),
      el("span", { class: "app-card__name" }, link),
    ),
    el("span", { class: "app-card__counts" }, ...c.counts),
    c.quote
      ? el(
          "figure",
          { class: "app-card__quote" },
          el("blockquote", {}, el("p", { text: `“${c.quote.text}”` })),
          el("figcaption", { class: "app-card__from", text: c.quote.from }),
        )
      : null,
    c.peek.length
      ? el(
          "ul",
          { class: "app-card__peek" },
          ...c.peek.map((row) => el("li", {}, ...row)),
          c.more > 0 ? el("li", { class: "app-card__more", text: `and ${c.more} more` }) : null,
        )
      : null,
    c.quote && c.more > 0 ? el("span", { class: "app-card__more", text: `and ${c.more} more` }) : null,
    c.menu,
  );
  return el("li", {}, card);
}

/** The cards' list, named for screen readers. */
export function appCards(label: string, cards: HTMLElement[]): HTMLElement {
  return el("ul", { class: "app-cards", "aria-label": label }, ...cards);
}
