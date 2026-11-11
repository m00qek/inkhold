// The index's rows that are not document pages: what the browser holds
// itself (names, to-dos, digests) as running text, one row each. A rowid's
// top bits are its kind (`webapp/wasm/sqlite_core.zig`), so one query
// answers every kind with an exact total of its own; pages are kind 0.

/** A kind of row the browser writes itself. */
export type ItemKind = "name" | "todo" | "digest";

export const ITEM_KINDS: readonly ItemKind[] = ["name", "todo", "digest"];

/** `rowid >> KIND_SHIFT` is the kind; the wasm's `kind_shift`. */
export const KIND_SHIFT = 28;
const KIND_SIZE = 1 << KIND_SHIFT;

const CODE: Record<ItemKind, number> = { name: 1, todo: 2, digest: 3 };

export function kindCode(kind: ItemKind): number {
  return CODE[kind];
}

/** The kind of a rowid; null for a page. */
export function kindOf(rowid: number): ItemKind | null {
  const code = Math.floor(rowid / KIND_SIZE);
  return ITEM_KINDS.find((k) => CODE[k] === code) ?? null;
}

/** One row: its key within its kind (an id) and the text it is found by. */
export interface ItemRow {
  readonly key: string;
  readonly text: string;
}

/** What a change to one kind's rows asks of the index. */
export interface ItemDiff {
  readonly remove: readonly number[];
  readonly add: readonly { rowid: number; text: string }[];
}

/** One kind's rows: key to rowid and text, and back. */
class KindRows {
  readonly byKey = new Map<string, { rowid: number; text: string }>();
  readonly byRowid = new Map<number, string>();
  private next: number;

  constructor(readonly code: number) {
    // From 1 above the kind's base, so no rowid is the base itself.
    this.next = code * KIND_SIZE + 1;
  }

  /** Every row not in `rows` goes, every new or changed one is (re)written. */
  diff(rows: readonly ItemRow[]): ItemDiff {
    const want = new Map(rows.map((r) => [r.key, r.text]));
    const remove: number[] = [];
    const add: { rowid: number; text: string }[] = [];
    for (const [key, held] of this.byKey) {
      if (want.get(key) === held.text) continue;
      remove.push(held.rowid);
      this.byKey.delete(key);
      this.byRowid.delete(held.rowid);
    }
    for (const [key, text] of want) {
      if (this.byKey.has(key)) continue;
      const rowid = this.next++;
      if (rowid >= (this.code + 1) * KIND_SIZE) throw new Error(`no rowids left for kind ${this.code}`);
      this.byKey.set(key, { rowid, text });
      this.byRowid.set(rowid, key);
      add.push({ rowid, text });
    }
    return { remove, add };
  }

  rows(): { rowid: number; text: string }[] {
    return [...this.byKey.values()];
  }

  entries(): { key: string; rowid: number; text: string }[] {
    return [...this.byKey].map(([key, r]) => ({ key, ...r }));
  }

  /** A row as a snapshot held it. */
  restore(key: string, rowid: number, text: string): void {
    if (Math.floor(rowid / KIND_SIZE) !== this.code || this.byRowid.has(rowid)) throw new Error(`snapshot row ${rowid} is not a fresh kind-${this.code} rowid`);
    this.byKey.set(key, { rowid, text });
    this.byRowid.set(rowid, key);
    this.next = Math.max(this.next, rowid + 1);
  }
}

/** One item row as a snapshot keeps it. */
export interface SnapshotItem {
  kind: ItemKind;
  key: string;
  rowid: number;
  text: string;
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
    const kind = kindOf(rowid);
    if (!kind) return null;
    const key = this.kinds.get(kind)!.byRowid.get(rowid);
    return key === undefined ? null : { kind, key };
  }

  count(kind: ItemKind): number {
    return this.kinds.get(kind)!.byKey.size;
  }

  snapshot(): SnapshotItem[] {
    return ITEM_KINDS.flatMap((kind) => this.kinds.get(kind)!.entries().map((r) => ({ kind, ...r })));
  }

  static from(items: readonly SnapshotItem[]): ItemTable {
    const t = new ItemTable();
    for (const r of items) t.kinds.get(r.kind)!.restore(r.key, r.rowid, r.text);
    return t;
  }
}
