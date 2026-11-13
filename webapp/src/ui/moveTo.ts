// A tablet app's Move to… menu, as one list of choices both apps render in
// their own menus: every place but the one the thing is in, then a way to make
// a new place and move it there at once. To-Do's task and Digest's digest.

import type { IconName } from "./icons";

export interface MovePlace {
  /** The place's id; null where the app has one (To-Do's Inbox). */
  id: string | null;
  name: string;
  icon: IconName;
}

export type MoveChoice =
  | { kind: "place"; label: string; icon: IconName; onSelect(): void }
  | { kind: "sep" }
  | { kind: "new"; label: string; icon: IconName; onSelect(): void };

/** The places to move to (not `current`), then "New …" after a rule. */
export function moveChoices(o: {
  places: readonly MovePlace[];
  current: string | null;
  move(place: MovePlace): void;
  /** "New list…", "New category…". */
  newLabel: string;
  makeNew(): void;
}): MoveChoice[] {
  return [
    ...o.places.filter((p) => p.id !== o.current).map((p): MoveChoice => ({ kind: "place", label: p.name, icon: p.icon, onSelect: () => o.move(p) })),
    { kind: "sep" },
    { kind: "new", label: o.newLabel, icon: "plus", onSelect: o.makeNew },
  ];
}
