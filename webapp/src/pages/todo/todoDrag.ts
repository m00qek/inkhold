// Dragging a task by its grip. The row hops in the DOM as its middle passes a
// neighbour's, or into another list's group (in All); between hops a transform
// keeps it under the pointer. Only the DOM moves here: where it landed is
// reported once, on release, and the page saves it.

/** Where a dragged task was let go. */
export interface Drop {
  /** The list whose group it ended in (null: the Inbox). */
  listId: string | null;
  /** The task now just below it there; undefined: it is last. */
  nextShown: string | undefined;
  /** False when it was put back where it started. */
  changed: boolean;
}

/** A group's list, from its `data-list` ("" is the Inbox). */
function listOf(group: HTMLElement): string | null {
  return group.dataset.list ? group.dataset.list : null;
}

const ids = (group: HTMLElement) => [...group.children].map((c) => (c as HTMLElement).dataset.id ?? "");
const middle = (n: Element) => n.getBoundingClientRect().top + (n as HTMLElement).offsetHeight / 2;

/**
 * Follows `row` from the press `e` until release, among `groups` (the
 * `[data-list]` containers on screen), then calls `done` with where it landed.
 */
export function dragRow(row: HTMLElement, e: PointerEvent, groups: readonly HTMLElement[], done: (drop: Drop) => void): void {
  let group = row.parentElement;
  if (!group) return;
  const startList = listOf(group);
  const startOrder = ids(group).join();
  row.classList.add("is-dragging");
  row.setPointerCapture(e.pointerId);

  const dragY = () => parseFloat(row.style.getPropertyValue("--drag-y") || "0");
  /** Where the row would sit without the transform. */
  const home = () => row.getBoundingClientRect().top - dragY();
  const grabbed = e.clientY - home();

  const onMove = (ev: PointerEvent) => {
    const y = ev.clientY;
    const center = y - grabbed + row.offsetHeight / 2;
    const over = groups.find((g) => {
      if (g === group) return false;
      const r = g.getBoundingClientRect();
      return y >= r.top && y <= r.bottom;
    });
    if (over) {
      over.insertBefore(row, [...over.children].find((c) => c !== row && center < middle(c)) ?? null);
      group = over;
    } else {
      const prev = row.previousElementSibling;
      const next = row.nextElementSibling;
      if (prev && center < middle(prev)) group!.insertBefore(row, prev);
      else if (next && center > middle(next)) group!.insertBefore(next, row);
    }
    row.style.setProperty("--drag-y", `${y - grabbed - home()}px`);
  };

  const onUp = () => {
    row.removeEventListener("pointermove", onMove);
    row.removeEventListener("pointerup", onUp);
    row.removeEventListener("pointercancel", onUp);
    row.classList.remove("is-dragging");
    row.style.removeProperty("--drag-y");
    const listId = listOf(group!);
    const order = ids(group!);
    const next = order[order.indexOf(row.dataset.id ?? "") + 1];
    done({ listId, nextShown: next === "" ? undefined : next, changed: listId !== startList || order.join() !== startOrder });
  };

  row.addEventListener("pointermove", onMove);
  row.addEventListener("pointerup", onUp);
  row.addEventListener("pointercancel", onUp);
}
