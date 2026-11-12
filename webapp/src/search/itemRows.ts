// The index's rows that are not document pages: what the browser holds
// itself (names, to-dos, digests), one row each. A rowid's top bits are its
// kind (`webapp/wasm/sqlite_core.zig`), so one query answers every kind with
// an exact total of its own; pages are kind 0. A row has up to four fields,
// each its own column, so a quoted phrase never runs from one into the next.

/** A kind of row the browser writes itself. */
export type ItemKind = "name" | "todo" | "digest";

export const ITEM_KINDS: readonly ItemKind[] = ["name", "todo", "digest"];

/** Rowids per kind: `rowid >> 28` is the kind, the wasm's `kind_shift`. */
export const KIND_SIZE = 1 << 28;

const CODE: Record<ItemKind, number> = { name: 1, todo: 2, digest: 3 };

/** The wasm's `field_separator`, between a row's fields in `idx_add`'s text. */
const FIELD_SEPARATOR = "\x1f";

/** The wasm's `columns`: fields a row may have. */
const MAX_FIELDS = 4;

/** A row's text from its fields, the missing ones skipped; a field never holds the separator. */
export function fields(...parts: readonly (string | null | undefined)[]): string {
  const kept = parts.filter((p): p is string => !!p).map((p) => p.replaceAll(FIELD_SEPARATOR, " "));
  if (kept.length > MAX_FIELDS) throw new Error(`a row has at most ${MAX_FIELDS} fields`);
  return kept.join(FIELD_SEPARATOR);
}

/** One row: its key within its kind (an id) and its text (`fields`). */
export interface ItemRow {
  readonly key: string;
  readonly text: string;
}

/** What a change to one kind's rows asks of the index. */
interface ItemDiff {
  readonly remove: readonly number[];
  readonly add: readonly { rowid: number; text: string }[];
}

/** One kind's rows: key to rowid and text, and back. Rowids are never reused. */
class KindRows {
  readonly byKey = new Map<string, { rowid: number; text: string }>();
  readonly byRowid = new Map<number, string>();
  private next: number;
  private readonly end: number;

  constructor(code: number) {
    // From 1 above the kind's base, so no rowid is the base itself.
    this.next = code * KIND_SIZE + 1;
    this.end = (code + 1) * KIND_SIZE;
  }

  /** Every row not in `rows` goes, every new or changed one is (re)written. Nothing changes when rowids would run out. */
  diff(rows: readonly ItemRow[]): ItemDiff {
    const want = new Map(rows.map((r) => [r.key, r.text]));
    const stale = [...this.byKey].filter(([key, held]) => want.get(key) !== held.text);
    const fresh = [...want].filter(([key, text]) => this.byKey.get(key)?.text !== text);
    if (this.next + fresh.length > this.end) throw new Error("no rowids left for this kind of row");
    for (const [key, held] of stale) {
      this.byKey.delete(key);
      this.byRowid.delete(held.rowid);
    }
    const add = fresh.map(([key, text]) => {
      const rowid = this.next++;
      this.byKey.set(key, { rowid, text });
      this.byRowid.set(rowid, key);
      return { rowid, text };
    });
    return { remove: stale.map(([, held]) => held.rowid), add };
  }

  rows(): { rowid: number; text: string }[] {
    return [...this.byKey.values()];
  }
}

/** Every kind's rows, kept beside the index so a rebuild writes them again. */
export class ItemTable {
  private readonly kinds = new Map<ItemKind, KindRows>(ITEM_KINDS.map((k) => [k, new KindRows(CODE[k])]));

  diff(kind: ItemKind, rows: readonly ItemRow[]): ItemDiff {
    return this.kinds.get(kind)!.diff(rows);
  }

  /** Every row of every kind, for writing into a fresh index. */
  all(): { rowid: number; text: string }[] {
    return [...this.kinds.values()].flatMap((k) => k.rows());
  }

  /** The key behind an item rowid; null for a page or a rowid not held. */
  lookup(rowid: number): { kind: ItemKind; key: string } | null {
    const code = Math.floor(rowid / KIND_SIZE);
    const kind = ITEM_KINDS.find((k) => CODE[k] === code);
    if (!kind) return null;
    const key = this.kinds.get(kind)!.byRowid.get(rowid);
    return key === undefined ? null : { kind, key };
  }
}
