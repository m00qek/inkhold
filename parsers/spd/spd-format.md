# Supernote Atelier `.spd` format — verified reference

Scope: what this parser (`parsers/spd/`) relies on, and **only what has been
checked against real files.** Where the widely-circulated spec prose and the PoC
disagreed with the files, the files win and it is called out.

## Provenance

| Source | Device / app | Notes |
| :-- | :-- | :-- |
| `layers_hidden.spd` (committed as `tests/fixtures/layers_hidden.spd`) | Supernote, `appVersion` **1.1.82**, `fmt_ver` **2** | The committed correctness + `tid`-gate anchor. Real device format, SYNTHETIC content (digit scribbles over a hidden layer + a semi-transparent one) — no personal handwriting, so safe to commit. |
| `20260722_190509.spd` | `appVersion` **1.1.82**, `fmt_ver` 2 | A real capture (kept local); layer tree / WAL flag cross-check. |
| 8 synthetic PoC exports (`empty_*`, `layers_*`, `reordered_*`, `extreme_bounds`) | generated | Confirm empty layers, reordering, hidden/opacity variants. |

All ten files are **WAL-mode** SQLite databases (see below).

## Container

A `.spd` is a SQLite 3 database, opened **read-only, in memory** (it is
attacker-supplied — see `src/spd.zig`).

### WAL header (load-bearing, undocumented elsewhere)

Every real `.spd` has SQLite header bytes 18/19 = `02 02` — **WAL journal mode**.
`sqlite3_deserialize` into `:memory:` cannot run WAL (there is no companion
`-wal` file), so the image must have those two bytes rewritten to `01` (legacy
rollback-journal) before deserialize. The file at rest is checkpointed, so its
main image already holds the committed state; the rewrite is a read-time
reinterpretation of the parser's private copy only. Without this step, opening
any genuine `.spd` fails outright.

## `config` table

```sql
CREATE TABLE config(name TEXT PRIMARY KEY NOT NULL, value BLOB);
```

Key/value metadata. Verified keys: `fmt_ver`, `appVersion`, `surface.width`,
`surface.height`, `vp.x`, `vp.y`, `ppi`, `thumbnail`, `ls`.

**Affinity gotcha:** the `thumbnail` value has `typeof = 'text'` yet holds binary
JPEG. It must be read by byte count (`sqlite3_column_blob` + `_column_bytes`);
reading it as text (`_column_text`) stops at the first NUL and reports ~4 bytes.
Numeric config (`surface.width` = `"1404.0"`, `ppi` = `"72"`) is stored as an
ASCII string; read via `CAST(value AS TEXT)` and parse.

`thumbnail` in the real files is a ~15–20 KB JPEG (`FF D8 FF E0 … JFIF`).

## `surface_<id>` tables (layers)

```sql
CREATE TABLE surface_X(tid INTEGER PRIMARY KEY NOT NULL, tile BLOB NOT NULL) WITHOUT ROWID;
```

One table per layer id. Each `tile` is a 128×128 PNG chunk. Layer id `9999` is
the reserved "Reference Layer" (template/background); it commonly has **zero**
tiles and renders as solid white.

### `tid` → tile coordinate — GATE RESULT

The circulated spec prose and the PoC Zig parser said
`x = tid % 4096`, `y = tid / 4096`. **That is wrong** — it is the transpose. The
PoC's own JS viewer used the other assignment, and nobody had checked which was
right. It was settled empirically: compositing a real drawing's tiles under
both mappings, only one reconstructs a coherent, upright image; the spec mapping scrambles it
along the diagonal.

**Verified:**

```
x_tile = tid >> 12       (high bits — horizontal)
y_tile = tid & 0x0FFF    (low 12 bits — vertical, 0..4095)
tid    = (x_tile << 12) | y_tile
```

Consequence for widths: only **12 bits** are reserved for the *vertical* (y)
coordinate, not the horizontal as the prose claimed. The horizontal (x) takes
the high bits and is effectively unbounded, so the `tid/4096` result must be
decoded into a `u32`, not the `u16` the PoC used (which panics on a tall
canvas). Absolute pixels: `x_px = x_tile * 128`, `y_px = y_tile * 128`; align to
the viewport by subtracting `vp.x` / `vp.y`.

Numeric evidence (locked into a test): `surface_2` of `layers_hidden.spd` holds 6
tiles occupying `x ∈ [1950, 1951]`, `y ∈ [1948, 1950]` under the verified
mapping — an asymmetric box that would swap extents under the spec's transpose.

## `ls` — layer-tree protobuf

`config['ls']` is a protobuf blob (the `surface_*` tables carry no names or
order). Structure (confirmed against the real files' decoded trees):

- **root** field 1 = repeated `Layer` (Z-order: **first = topmost**),
  field 2 = total layer count, field 3 = active layer id.
- **Layer** field 1 = id (`int32`), field 2 = name (string),
  field 4 = visibility (`int32`; `0` ⇒ hidden, field absent ⇒ visible),
  field 8 = opacity (`int32`, `0..255`; ÷255 for a fraction).

Tree for `layers_hidden.spd` (top → bottom):
`Layer 3` (vis, 102), `Layer 2` (**hidden**, 255), `Layer 1` (vis, 255),
`Reference Layer` (id 9999, vis, 255).
