# Reference — the `.note` binary format

The Supernote `.note` container: block layout, metadata keys, bitmap encodings,
vector stroke data, recognition data, and the parts still uncharted.

Ratta publishes no specification. Everything on this page is reverse-engineered,
and every non-obvious claim carries an [evidence marker](#evidence-markers) that
says how far it can be trusted.

This page describes the *file format only*. It is meant to be sufficient to write
a parser in any language.

---

## Evidence markers

This is a reverse-engineered format. A claim that has been checked against a real
file and a claim that was copied from somebody else's notes are both written in
the same neutral voice, so the marker is the only thing distinguishing them.
Building on **I** or **?** as though it were **C** is how a decoder acquires a
silent bug.

| Marker | Meaning |
|---|---|
| **C** | **Confirmed.** Observed in a file we hold, *and* the interpretation checked — by decoding it and comparing the result against an independent implementation's output, or against the device's own rendering. |
| **I** | **Inherited.** Taken from a third-party reverse-engineering effort (see [Sources](#sources)) and never checked against a file we hold. Plausible, internally coherent, unconfirmed. |
| **?** | **Unverified.** Believed, guessed, or simply unknown. |

### What the corpus is

A **C** means "true of the files below", not "true of the format".

| Tier | Corpus |
|---|---|
| Container, metadata keys, recognition | **Two files**, both from one device class and one firmware: **Nomad (`APPLY_EQUIPMENT = N6`), firmware Chauvet 3.29.42, signature `SN_FILE_VER_20260016`**. |
| `RATTA_RLE` decoding and layer compositing | The two files above, plus **14 community sample files** distributed with [`snlib`](https://github.com/Walnut356/snlib) covering multi-layer pages, bitmap backgrounds, marker colours, erase/move, pressure, tilt and rotation. Decoding these reproduced `supernote-tool`'s output byte-for-byte. |

Landscape (`ORIENTATION = 1090`) storage was settled against a third Nomad
capture (`horizontal_layers.note`: 2 pages, both `1090`, 4 ink layers on
page 2) — see [§9.3](#93-orientation). A fourth capture (`one_thumb.note`:
2 pages, the user tapped "set as cover") settled the **cover** subtree
([§5](#5-keyword-title-link-and-cover-objects)). A fifth
(`layers_edited.note`: the user hid a layer, renamed another and reordered the
stack in the device's layer panel) settled `LAYERSEQ` semantics (hidden AND
deleted layers omitted; hidden bitmaps persist) and everything about
`LAYERINFO` — its two encodings, the `layerId` map and where display names
live ([§4.3](#43-page)).

`TOTALPATH` vector strokes ([§10](#10-totalpath-vector-strokes)) were settled
against a **third `.mark` capture** (689,161 B; 7 annotated pages; 189 strokes),
made deliberately to exercise this work: it contains erasures, four different
pens, pen strokes running off both side margins, and pages labelled in the
author's own handwriting with the pen used. Decoded strokes were re-rasterised
and compared against the same pages' `LAYERBITMAP` — the device's own final
picture — at IoU 0.967.

Everything outside those tiers — the A-series family, the `N5`/Manta device
class, keyword/title/link blocks, `RECOGNFILE` — is **I** or **?**. No file we
hold exercises any of them.

!!! warning "One device, one firmware"
    Every **C** above, `TOTALPATH` included, rests on N6 hardware running one
    firmware. Unexercised even now: `"straightLine"` strokes (all 189 are
    `"others"`), any non-`N6` equipment, a width-limited (landscape or wide)
    page, and `TOTALPATH` inside a multi-layer `.note` rather than a `.mark`.

---

## 1. Container primitives

**C**

A `.note` is an **address-based container**, not a linear stream. Nothing is
scanned; every structure is reached by absolute byte offset. Any single page or
layer can therefore be located and read without touching the rest of the file.

| Property | Value |
|---|---|
| Integer byte order | little-endian |
| Address size | 4 bytes (`u32`) |
| Length-prefix size | 4 bytes (`u32`) |
| Address `0` | means "absent" |
| Block shape | `[u32 length][length bytes of payload]` |
| Footer address | stored in the **last 4 bytes** of the file |

A block's **address** is the offset of its length prefix. Its payload begins four
bytes later.

Two block kinds share that shape:

- **Metadata block** — payload is ASCII `<KEY:VALUE>` pairs, concatenated with no
  separator, e.g. `<PAGE1:138538><FILE_FEATURE:9179>`. Footer, header, page,
  layer, keyword, title and link blocks are all metadata blocks.
- **Content block** — payload is raw bytes: a `RATTA_RLE` stream, base64 JSON, a
  ZIP, an image.

### 1.1 How the pieces nest

```mermaid
flowchart TD
    EOF["last 4 bytes of file<br/>= footer address"] --> FOOTER

    FOOTER["<b>Footer</b> — metadata block<br/>the index"]
    FOOTER -->|FILE_FEATURE| HEADER["<b>Header</b> — metadata block<br/>device + file-level facts"]
    FOOTER -->|"PAGE, PAGE1, PAGE2 …"| PAGE["<b>Page</b> — metadata block<br/>one per page"]
    FOOTER -->|"COVER_1 / COVER_2"| COVER[["Cover image<br/>content block"]]
    FOOTER -->|"KEYWORD_* / TITLE_* / LINK*"| OBJ["Keyword / title / link<br/>metadata blocks"]

    PAGE -->|"MAINLAYER, LAYER1-3, BGLAYER"| LAYER["<b>Layer</b> — metadata block<br/>up to 5 per page"]
    PAGE -->|TOTALPATH| PATHS[["Vector strokes<br/>content block"]]
    PAGE -->|RECOGNTEXT| RTEXT[["base64 JSON transcript<br/>content block"]]
    PAGE -->|RECOGNFILE| RFILE[["MyScript iink ZIP<br/>content block"]]

    LAYER -->|LAYERBITMAP| BITMAP[["Bitmap<br/>content block"]]

    OBJ -->|"KEYWORDSITE / TITLEBITMAP / LINKBITMAP"| OBJIMG[["Image / text<br/>content block"]]
```

Every arrow is a `u32` address read out of a `<KEY:VALUE>` pair. Double-bordered
nodes are content blocks (raw bytes); the rest are metadata blocks.

### 1.2 Metadata pair grammar

**C**

- A pair is `<`, a key, `:`, a value, `>`.
- The value runs from the first `:` to the next `>`. It may contain `:`, `,`,
  `#`, quotes — anything but `>`. `LAYERINFO` exploits this by writing JSON with
  `#` where a `:` would go (its newer base64 encoding sidesteps the grammar
  entirely — see [§4.3](#43-page)).
- **Keys may repeat.** Entries form an ordered list, not a map. `PAGE`,
  `KEYWORD_*` and `LINK*` all recur. A parser that builds a map loses data.
- Values are untyped text. `APPLY_EQUIPMENT:N6` is a string, not a number; a
  value that looks numeric is not guaranteed to be one.
- Order is significant for `PAGE*` keys: footer order is page order.

!!! note "Two grammars are in circulation"
    `supernote-tool` parses pairs with the regex `<([^:<>]+):(.*?)>`, which
    forbids both `>` **and** `<` inside a key. A looser grammar rejecting only
    `<` also parses every file observed. No known file distinguishes the two, so
    either is safe today.

---

## 2. Signatures and file families

**C** for the X-series detection rule and the `SN_FILE_VER_20260016` entry;
**I** for the rest of the table.

The first 4 bytes are a file-type marker (the ASCII bytes `note` in every file
observed). A signature string then identifies the format family and version.

| Family | Signature offset | Signature pattern | Bitmaps | Layers |
|---|---|---|---|---|
| X-series (A5X, A6X, A5X2, Manta, Nomad …) | 4 | `SN_FILE_VER_` + 8 digits | `RATTA_RLE` | yes, up to 5 |
| Original (A-series) | 0 | `SN_FILE_ASA_` + 8 digits | `SN_ASA_COMPRESS` (zlib) | no |

Detection order is X-series first, original second. The X-series is the
mainstream format; the original family predates it and appears not to be
produced by current firmware.

The trailing 8 digits are a **monotonic version key** and are usable as an
ordered integer.

| Predicate | Rule | Marker |
|---|---|---|
| High-resolution grayscale supported | `version >= 20230015` | **I** for the exact threshold; **C** that `20260016` carries high-resolution (X2) data |

Known X-series signatures and their firmware, newest last. All **I** except
`20260016`, which is **C**:

| Signature | Firmware | | Signature | Firmware |
|---|---|---|---|---|
| `SN_FILE_VER_20200001` | C.053 | | `SN_FILE_VER_20210010` | Chauvet 2.1.6 |
| `SN_FILE_VER_20200005` | C.077 | | `SN_FILE_VER_20220011` | Chauvet 2.5.17 |
| `SN_FILE_VER_20200006` | C.130 | | `SN_FILE_VER_20220013` | Chauvet 2.6.19 |
| `SN_FILE_VER_20200007` | C.159 | | `SN_FILE_VER_20230014` | Chauvet 2.10.25 |
| `SN_FILE_VER_20200008` | C.237 | | `SN_FILE_VER_20230015` | Chauvet 3.14.27 |
| `SN_FILE_VER_20210009` | C.291 | | `SN_FILE_VER_20260016` | Chauvet 3.29.42 |

The Note app's own library (`libratta_sn_process.so`, firmware
Chauvet.E103.2610191001, 2026-11-09) also names `SN_FILE_VER_20200002`,
`20200003`, `20200004` and `20220012`, with upgrade steps between them, and
none newer than `20260016`: that firmware still writes `20260016` (**C**, 22
notes on a Nomad).

Only `SN_FILE_ASA_20190529` is known for the original family (**I**).

An unknown but pattern-matching signature is safely treated as "latest": no
observed version has removed a field.

---

## 3. Resolution order

**C**

```
1.  footer_address = u32le(file_size - 4)
2.  footer  = metadata_block(footer_address)
3.  header  = metadata_block(int(footer["FILE_FEATURE"]))
4.  for each footer key starting with "PAGE", in footer order:
5.      page = metadata_block(int(value))
6.      for slot in [MAINLAYER, LAYER1, LAYER2, LAYER3, BGLAYER]:
7.          addr = int(page[slot]) or 0;  skip when 0
8.          layer = metadata_block(addr)
9.  resolve cover / keyword / title / link blocks from the footer (§5)
```

Properties of this path:

- Every step is a small absolutely-addressed read. Peak memory is the parsed
  metadata plus the single largest metadata block — **never the file size**.
  Bitmap and recognition content blocks can be read lazily afterwards, by
  address.
- Page selection is a prefix match on **footer** keys: `PAGE`, `PAGE1`, `PAGE2` …
  all match, in file order. A parser matching only `PAGE\d+` would miss a
  single-page file's bare `PAGE`.
- Layers are collected in the fixed slot order above, **not** in `LAYERSEQ`
  order. `LAYERSEQ` affects drawing only ([§8](#8-compositing)).
- Every offset in the file was written by a device. A parser reading untrusted
  files must bounds-check each address and length against the file size, with
  overflow-checked arithmetic: a hostile or corrupt length is otherwise an
  out-of-bounds read.

---

## 4. Metadata keys

### 4.1 Footer

| Key | Meaning | Marker |
|---|---|---|
| `FILE_FEATURE` | address of the header block. Required; a file without it cannot be resolved. | **C** |
| `PAGE`, `PAGE1`, `PAGE2`, … | address of each page block; footer order is page order | **C** |
| `COVER_1`, `COVER_2`, `COVER_3` | cover image content address. The suffix is a TYPE, not a page number: `COVER_3` and `COVER_2` are both user-set (`COVER_3` is the newer key current firmware writes for a user-set cover), `COVER_1` ≈ automatic. Preference is **newest-wins** — `COVER_3` → `COVER_2` → `COVER_1` — extending the reference's `COVER_2`-over-`COVER_1` order (supernote-tool `parser.py:181-184`, whose `manipulator.py` writes `COVER_2` for an injected custom cover) to the later key. | **C** for `COVER_3` (`user_cover.note`: `<COVER_3:429>` written by "set as cover" on current firmware) and `COVER_2` (`one_thumb.note`); **I** for `COVER_1` — no capture carries one |
| `COVER_0` | the "no cover set" placeholder: the device writes an explicit `<COVER_0:0>` while no cover is chosen, and REPLACES it with a `COVER_2`/`COVER_3` address when one is set. Absent on older files. All no-cover shapes mean the same thing. | **C** — scan of 9 live notes: seven `<COVER_0:0>`, one real `COVER_2`, one (older) file with no COVER key at all |
| `KEYWORD_*` | keyword metadata block addresses ([§5](#5-keyword-title-link-and-cover-objects)) | **I** |
| `TITLE_*` | title metadata block addresses. The digits encode a page number: `int(key[6:10]) - 1`. | **I** |
| `LINK*` | link metadata block addresses; page number encoded the same way | **I** |

### 4.2 Header

| Key | Meaning | Marker |
|---|---|---|
| `APPLY_EQUIPMENT` | device class code; determines page dimensions and the millimetre scale ([§9](#9-hardware-bound-constants)) | **C** for `N6`; **I** for `N5` |
| `FILE_ID` | notebook id | **C** |
| `FILE_RECOGN_TYPE` | `"1"` ⇒ realtime handwriting recognition enabled for this file | **C** that the key exists; **I** for the value's meaning |
| `FILE_RECOGN_LANGUAGE` | recognition language tag, e.g. `pt_BR` | **C** that the key exists and carries a POSIX-style locale tag; **I** for the full value space |

### 4.3 Page

| Key | Meaning | Marker |
|---|---|---|
| `MAINLAYER`, `LAYER1`, `LAYER2`, `LAYER3`, `BGLAYER` | address of each layer's metadata block. `0` or absent ⇒ that slot is unused. `BGLAYER` is the background/template layer. | **C** |
| `LAYERSEQ` | comma-separated layer keys, **top-to-bottom** draw order — the authoritative draw list. It is `LAYERINFO`'s stack order **filtered to drawn layers**: both HIDDEN (`isVisible:false`) and DELETED (`isDeleted:true`) layers are omitted from the sequence. A hidden layer's bitmap block PERSISTS in the file — only the draw list drops it — where a deleted layer's slot key is absent entirely. | **C** — the device DOES write non-default sequences: `horizontal_layers.note` / `layers_edited.note` page 2 carry `LAYERSEQ:LAYER3,LAYER1,MAINLAYER,BGLAYER` while `LAYERINFO` places the HIDDEN `LAYER2` between `LAYER1` and `MAINLAYER` (`isVisible:false, isDeleted:false`) and its bitmap decodes fine. A device reorder rewrites both keys consistently. The golden composite hashes in `tests/content_test.zig` pin the omission behaviour. (An earlier revision of this row read page 2's omission as *deletion* — that came from a STALE page-block generation the append-only container still holds; only footer-referenced blocks are current.) |
| `PAGESTYLE` | template/background style name, e.g. `style_white`, `style_5mm_dots` | **C** |
| `PAGESTYLEMD5` | hash of the style asset; `"0"` = none | **I** |
| `ORIENTATION` | `"1000"` vertical, `"1090"` horizontal (per page; a `1090` page's raster is stored natively landscape) | **C** — both values observed; see [§9.3](#93-orientation) |
| `PAGEID` | page id | **I** |
| `RECOGNSTATUS` | `0` none, `1` finished, `2` running | **C** — all three values observed |
| `RECOGNTEXT` | address of the base64-JSON transcript content block; `0`/absent when unfinished | **C** — [§11](#11-handwriting-recognition) |
| `RECOGNFILE` | address of a MyScript iink package | **I** — [§11.2](#112-recognfile) |
| `TOTALPATH` | address of the page's vector stroke data | **C** that the key exists and holds a non-zero address on a page with ink; **I** for the block's contents — [§10](#10-totalpath-vector-strokes) |
| `LAYERINFO` | the layer panel's state: a JSON array covering the **full stack in top-to-bottom order, hidden and deleted entries included** (`LAYERSEQ` is this order filtered to drawn layers). Fields per entry: `layerId`, `name`, `isBackgroundLayer`, `isAllowAdd`, `isCurrentLayer`, `isVisible`, `isDeleted`, `isAllowUp`, `isAllowDown`. See the note below for the TWO encodings, the `layerId` map and the name semantics. | **C** — both encodings, the id map, hidden-vs-deleted and the rename/reorder behaviour are all pinned by `layers_edited.note` (a deliberate on-device panel-edit capture) and parsed by `src/layerinfo.zig` |
| `PROTOCOL` | bitmap encoding name for **non-layered** pages | **I** |
| `DATA` | bitmap content address for **non-layered** pages | **I** |
| `PAGENO` | page number | **?** |
| `LAYERPATH`, `LAYERVECTORGRAPH`, `LAYERRECOGN` | observed alongside `LAYERBITMAP` in a third-party structural spec | **?** — meaning unconfirmed |

!!! note "`LAYERINFO`: two encodings, the id map, and where names live"
    **All C** — established from `layers_edited.note` (`4239d7c9…`), a capture
    made by hiding Layer 2, renaming the top layer and reordering the stack in
    the device's layer panel, then syncing.

    **Two encodings, mixed per page within one file.** Detect by the value's
    FIRST BYTE:

    - `[` or `{` → **`#`-JSON** (legacy): literal JSON with `#` standing in
      wherever JSON syntax expects `:` (the `:` would not survive the device's
      own `<KEY:VALUE>` parsing). The substitution is structural: undo it only
      OUTSIDE JSON strings (tracking quote/escape state), or a name containing
      a literal `#` is corrupted by a global replace.
    - anything else → **base64 of plain, ordinary JSON**. An on-device layer-
      panel edit REWRITES that page's `LAYERINFO` in this form; untouched pages
      keep `#`-JSON, so `layers_edited.note` carries `#`-JSON on page 1 and
      base64 on page 2 simultaneously. (supernote-tool v0.7.1 *does* decode the
      base64 form — `converter.py:190-193`, as a fallback — but then still runs
      its global `#`→`:` replace over the decoded JSON, so a name containing a
      literal `#` is corrupted; our tokenizer-level fixup is the difference,
      not the base64 awareness. Corrected 2026-07-24 from an earlier claim that
      it did not know the form at all.)

    **`layerId` ↔ slot:** `0` = `MAINLAYER`, `1`–`3` = `LAYER1`–`LAYER3`,
    **`-1` = `BGLAYER`** (the same entry says `isBackgroundLayer:true`, name
    "Background Layer").

    **Display names live ONLY here.** `name` is the user-visible, renamable
    label ("Layer Renamed"); the layer block's `LAYERNAME` stays the slot
    constant (`LAYER3`) through a rename. Never show `LAYERNAME`.

    **Hidden ≠ deleted.** `isVisible:false, isDeleted:false` = hidden: omitted
    from `LAYERSEQ` (so not drawn) but the bitmap block persists and decodes.
    `isDeleted:true` = deleted: no layer block at all. Slots that were never
    created also read `isDeleted:true` — "deleted" covers "not present".

    **Order.** The array is the full stack top-to-bottom; a reorder in the
    panel rewrites `LAYERINFO` and `LAYERSEQ` consistently, `LAYERSEQ` being
    the drawn-layer filter of this order.

!!! note "Non-layered pages"
    A page may carry `PROTOCOL` + `DATA` — a single bitmap, no layer slots —
    instead of the five layer keys. A parser that only looks for layer slots will
    resolve such a page to **zero layers** and produce a blank result rather than
    an error. No file we hold uses this form; it is **I**, from
    `supernote-tool`.

### 4.4 Layer

| Key | Meaning | Marker |
|---|---|---|
| `LAYERBITMAP` | address of the layer's bitmap content block; `0` ⇒ no content | **C** |
| `LAYERNAME` | the SLOT CONSTANT (`MAINLAYER`, `LAYER3`, …) — **not** a display name. It does not change when the user renames the layer; the user-visible name lives only in the page's `LAYERINFO`. | **C** — `layers_edited.note` page 2: `LAYERNAME:LAYER3` beside `LAYERINFO` name "Layer Renamed" |
| `LAYERPROTOCOL` | encoding name, e.g. `RATTA_RLE` | **C** that the key exists and reads `RATTA_RLE`; see the warning |
| `LAYERTYPE` | layer type, e.g. `NOTE` | **I** |

For a layered page, `supernote-tool` takes the page's effective `PROTOCOL` from
`MAINLAYER`'s `LAYERPROTOCOL` (**I**).

!!! danger "`LAYERPROTOCOL` does not reliably name the encoding"
    Files observed declaring `LAYERPROTOCOL: RATTA_RLE` carry **X2-variant**
    data, which uses a different colour table ([§7.2](#72-the-x2-variant)).
    Decoding such a layer with the base `RATTA_RLE` table succeeds — the stream
    is structurally valid either way — and silently produces wrong greys.

    **The file signature is the reliable discriminator**: `version >= 20230015`
    selects the X2 colour table. Treat `LAYERPROTOCOL` as informational until a
    file proves otherwise.

### 4.5 Keys present but not read

Real files carry these keys, and Inkhold reads none of them (**C** that they
occur: every key in 22 notes from a Nomad, firmware Chauvet.E103.2610191001;
**I** for any meaning beyond the name).

| Where | Keys |
|---|---|
| Header | `APP_VERSION`, `DEVICE_DPI`, `SOFT_DPI`, `FILE_PARSE_TYPE`, `IS_OLD_APPLY_EQUIPMENT`, `ANTIALIASING_CONVERT`, `FINALOPERATION_LAYER`, `MODULE_LABEL`, `STYLEUSAGETYPE`, `PDFSTYLELIST`, `RATTA_ETMD` |
| Page | `RECOGNTYPE`, `RECOGNLANGUAGE`, `RECOGNFILESTATUS`, `IDTABLE` |

`PAGETEXTBOX` and `DISABLE`, once in this list, are read now: they go with
text boxes ([§10.5](#105-text-boxes)).

---

## 5. Keyword, title, link and cover objects

Keyword/title/link: **I**, entirely — described by `supernote-tool`; no file we
hold has been examined for them, and their content-block encodings (PNG vs RLE,
and whether that varies by version) are unknown. The **cover** is now **C**
(2026-07-23, two captures — see below).

**Cover** — a content block at `COVER_3`, falling back to `COVER_2`, then
`COVER_1` (newest user-set key wins). **C**: verified against `one_thumb.note`
(Nomad, Chauvet 3.29.42): `<COVER_2:429>` resolves to a **complete pre-rendered
PNG at full device resolution** (1404×1872, ~37 KB), background template and ink
already composited by the firmware — extracting it is a block copy, no
rendering. Covers are **NOT auto-generated**: the key appears when the user sets
a cover; current firmware writes `COVER_3` for this (the real `user_cover.note`
incident — a 6.5 MB PNG at `<COVER_3:429>` — is what added the key here), older
firmware wrote `COVER_2`. Until a cover is set the footer carries the explicit
`<COVER_0:0>` placeholder (`horizontal_layers.note` and six other live notes),
or — on older files — no COVER key at all (`sample.note`). The per-page
`THUMBNAILTYPE:0` is unrelated/vestigial: it stays `0` with a cover present.
`COVER_1` (≈ automatic) remains **I** — no capture carries one; the preference
order is pinned synthetically in `tests/note_test.zig`. Note a cover block is
NOT the ~37 KB the first capture suggested — `COVER_3` covers run to several MB,
which is why the indexer records the block's *address + length* and the serve
path STREAMS it straight from the immutable blob rather than buffering it.

**Keyword block** (address from a `KEYWORD_*` footer key):

| Key | Meaning |
|---|---|
| `KEYWORD` | the keyword text — but the authoritative copy is re-read from the `KEYWORDSITE` content block |
| `KEYWORDPAGE` | page number, **1-based** |
| `KEYWORDRECT` | `left,top,width,height` |
| `KEYWORDRECTORI` | `left,top,width,height`, original orientation |
| `KEYWORDSITE` | content block address |

**Title block** (address from a `TITLE_*` footer key; the page number comes from
the *key*, as `int(key[6:10]) - 1`):

| Key | Meaning |
|---|---|
| `TITLEBITMAP` | content address of the title strip image |
| `TITLERECTORI` | `left,top,width,height` |

**Link block** (address from a `LINK*` footer key; page number encoded as for
titles):

| Key | Meaning |
|---|---|
| `LINKBITMAP` | content block address |
| `LINKRECT` | `left,top,width,height` |
| `LINKTYPE` | `0` = page, `1` = file, `4` = web |
| `LINKINOUT` | `0` = outbound, `1` = inbound |
| `LINKFILE` | Base64-encoded path or URL |
| `LINKFILEID`, `PAGEID` | target ids; the literal string `"none"` means null |
| `LINKTIMESTAMP` | timestamp |

---

## 6. Layout of a minimal container

A synthetic, hand-authored example: one page, one main layer, a two-byte bitmap.
Offsets are decimal. Total file size 232 bytes.

| Offset | Size | Bytes / payload | Role |
|---|---|---|---|
| 0 | 4 | `note` | file-type marker |
| 4 | 20 | `SN_FILE_VER_20260016` | signature |
| 24 | 4 | `02 00 00 00` | bitmap block length |
| 28 | 2 | `61 00` | `RATTA_RLE`: colour `0x61` (black), run of 1 |
| 30 | 4 | `4E 00 00 00` | layer block length (78) |
| 34 | 78 | `<LAYERNAME:MAINLAYER><LAYERPROTOCOL:RATTA_RLE><LAYERTYPE:NOTE><LAYERBITMAP:24>` | layer metadata |
| 112 | 4 | `37 00 00 00` | page block length (55) |
| 116 | 55 | `<PAGESTYLE:style_white><ORIENTATION:1000><MAINLAYER:30>` | page metadata |
| 171 | 4 | `14 00 00 00` | header block length (20) |
| 175 | 20 | `<APPLY_EQUIPMENT:N6>` | header metadata |
| 195 | 4 | `1D 00 00 00` | footer block length (29) |
| 199 | 29 | `<FILE_FEATURE:171><PAGE1:112>` | footer index |
| 228 | 4 | `C3 00 00 00` | footer address (195) |

Note that every address in the file (`LAYERBITMAP:24`, `MAINLAYER:30`,
`FILE_FEATURE:171`, `PAGE1:112`, and the trailing `195`) points at a **length
prefix**, not at a payload. Writers therefore emit content before the blocks that
reference it, innermost first — which is why the footer is last and the bitmap
first.

---

## 7. Bitmap encodings

Four encodings are named in the reverse-engineering record.

| Encoding | Family | Marker |
|---|---|---|
| `RATTA_RLE` | X-series | **C** |
| `RATTA_RLE` X2 variant | X-series, `version >= 20230015` | **C** |
| `SN_ASA_COMPRESS` | original A-series | **I** |
| `PNG` | some content blocks | **I** |

### 7.1 `RATTA_RLE`

**C**

The stream is a sequence of `(colour_code, length_byte)` **pairs** producing a
row-major bitmap of exactly `width * height * (bits_per_pixel / 8)` bytes. In
every observed file that is 8-bit grayscale, so exactly `width * height` bytes.

| Length byte | Run length |
|---|---|
| `0xFF` | `0x4000` — or `0x400` when the layer carries the [all-blank shortcut](#the-all-blank-shortcut) |
| bit 7 set (`& 0x80`) | **held**: the high part of a two-byte length, resolved against the next pair |
| otherwise | `length_byte + 1` |

Resolving a held pair `(c_h, l_h)` against the next pair `(c, l)`:

- **Same colour** (`c == c_h`) → a single run of
  `1 + l + (((l_h & 0x7F) + 1) << 7)`.
- **Different colour** → emit the held run as `((l_h & 0x7F) + 1) << 7`, then
  process `(c, l)` normally.
- **End of stream with a pair still held** → emit
  `((l_h & 0x7F) + 1) << i` for the largest `i` in 7…0 whose result fits the
  remaining gap; if none fits, emit nothing. This exists so a held tail can be
  adjusted to land exactly on the expected buffer size.

A lone trailing byte (an odd-length stream) is ignored.

**The decoded length must equal the expected size exactly.** There is no
in-stream terminator and no per-row framing, so a wrong `width` does not fail —
it shears the image diagonally. Length equality is the only integrity check the
encoding offers, and it must be enforced.

#### The all-blank shortcut

The all-blank flag is **not in the stream**. It is inferred from the container,
and it changes the meaning of the `0xFF` length byte from `0x4000` to `0x400`:

```
all_blank = slot == BGLAYER
         && PAGESTYLE == "style_white"
         && content_block_length == 0x140E
```

The `0x140E` (5134) constant is **I** and unexplained — an exact block size
matched as a magic number, with no structural cross-check against the stream
itself.

#### Colour codes

Any code **not** in the table below passes through **literally as the grayscale
value**. That is how the X2 variant stores anti-aliasing greys, and it means an
unknown code can never fail a decode — only look wrong.

| Code | `RATTA_RLE` → gray | X2 variant → gray | Name |
|---|---|---|---|
| `0x61` | `0x00` | `0x00` | black |
| `0x62` | `0xFF` | `0xFF` | background / transparent |
| `0x63` | `0x9D` | `0x30` | dark grey (X2: *compat* dark grey) |
| `0x64` | `0xC9` | `0x50` | grey (X2: *compat* grey) |
| `0x65` | `0xFE` | `0xFE` | white |
| `0x66` | `0x00` | `0x00` | marker black |
| `0x67` | `0x9D` | literal | marker dark grey |
| `0x68` | `0xC9` | literal | marker grey |
| `0x9D` | literal | `0x9D` | dark grey (X2) |
| `0x9E` | literal | `0x9D` | marker dark grey (X2) |
| `0xC9` | literal | `0xC9` | grey (X2) |
| `0xCA` | literal | `0xC9` | marker grey (X2) |
| any other | literal | literal | anti-aliasing grey |

!!! note "`0xFE` white is not `0xFF` white"
    Colour code `0x65` decodes to `0xFE`, one below `0xFF`. `0xFF` is
    simultaneously the **transparent** sentinel and the value a compositing
    canvas starts at ([§8](#8-compositing)). A layer can therefore paint an
    opaque near-white (`0xFE`) that **masks** the layer below — which `0xFF`
    would not. The one-step difference is load-bearing, not a rounding artefact.

### 7.2 The X2 variant

**C**

Same algorithm, same length rules, **different colour table** — the third column
of the table above. It exists to carry high-resolution grayscale: dark grey and
grey move to `0x9D`/`0xC9`, the old `0x63`/`0x64` codes are retained as
*compatibility* entries mapping to darker values, and every unlisted byte is a
literal grey level.

Selection is by **file signature** (`version >= 20230015`), not by
`LAYERPROTOCOL` — see the warning in [§4.4](#44-layer).

### 7.3 Colour palette

**C** for the grayscale column; **I** for the RGB column.

| Name | Gray | RGB |
|---|---|---|
| black | `0x00` | `#000000` |
| dark grey | `0x9D` | `#9d9d9d` |
| grey | `0xC9` | `#c9c9c9` |
| white | `0xFE` | `#fefefe` |
| transparent | `0xFF` | `#ffffff` |
| compat dark grey | `0x30` | `#303030` |
| compat grey | `0x50` | `#505050` |

Grayscale layers are 8 bits per pixel. `supernote-tool` also models 24-bit RGB
layers (and 32-bit with alpha on the A-series path), but **?** — no observed
layer is anything other than 8-bit grayscale.

### 7.4 `SN_ASA_COMPRESS` (original A-series)

**I**, entirely. The content block is zlib-compressed. Decompressing yields an
array of `u16` colour codes at an internal size of **1404 × 1888**; rotate 90°
clockwise and drop the bottom 16 rows to reach 1404 × 1872.

| Code | Colour |
|---|---|
| `0x0000` | black |
| `0xFFFF` | background |
| `0x2104` | dark grey |
| `0xE1E2` | grey |

No A-series file has ever been examined.

### 7.5 `PNG`

**I** — some content blocks are said to be plain PNG, decoded directly, with the
result required to match the page dimensions. No observed layer uses it.

---

## 8. Compositing

**C**

1. Clear the canvas to `0xFF`.
2. Determine **bottom-to-top** order: reverse `LAYERSEQ`, skipping tokens that
   are not one of the five slot keys. When `LAYERSEQ` is absent or yields no
   valid token, fall back to `BGLAYER, MAINLAYER, LAYER1, LAYER2, LAYER3`.
3. For each layer in that order with a non-zero `LAYERBITMAP`: decode it to a
   full-page grayscale buffer, then copy every pixel whose value is **not**
   `0xFF` over the canvas.

Transparency is a **single sentinel value**, not an alpha channel. There is no
blending: a pixel is either `0xFF` (leave what is underneath) or an opaque grey.
Layer order is the only thing that resolves overlap, which is why `LAYERSEQ`
must be honoured and why `0xFE` white is distinct from `0xFF`.

---

## 9. Hardware-bound constants

**These describe a hardware class, not the format.** Getting them wrong produces
mirrored or mis-scaled output that still *looks* plausible.

### 9.1 Page dimensions, in pixels

| `APPLY_EQUIPMENT` | Device | Pixels | Marker |
|---|---|---|---|
| `N5` | A5X2 / Manta | 1920 × 2560 | **I** |
| `N6` | Nomad | 1404 × 1872 | **C** |
| anything else, or absent | A5X, A6X, … | 1404 × 1872 (default) | **I** for the device list; **C** that the default applies to `N6`, which is not special-cased by `supernote-tool` |

Only `N5` is special-cased. Everything else, `N6` included, falls to the
1404 × 1872 default — which is correct for the Nomad.

A wrong pixel size is **self-announcing**: `RATTA_RLE` carries no row framing, so
a wrong width shears the image, and a wrong total size fails the decoder's
length-equality check ([§7.1](#71-ratta_rle)). Cross-checking the decoded byte
count against `width * height` catches it.

### 9.2 Physical canvas, in millimetres

**C** for `N6` only.

| `APPLY_EQUIPMENT` | Canvas | Scale at 1404 px wide |
|---|---|---|
| `N6` | 118.64 × 158.19 mm | ≈ 11.834 px/mm, isotropic |
| anything else | **unknown** | **?** |

!!! danger "This is an allowlist and must not have a fallback"
    Unlike pixel dimensions, a wrong millimetre scale is **silent**. Its consumer
    is coordinate data — recognition bounding boxes ([§11.1](#111-recogntext))
    and vector strokes ([§10.1](#101-coordinate-transform)) — which is often
    invisible or only loosely checkable against the raster.

    An N5/Manta is 1920 × 2560 — the **same aspect ratio** — so it would fall
    through a pixel-style default happily while its true scale is plausibly ~10 %
    away. Everything would look right and be wrong.

    Establishing a value for a new device requires a real file from that device
    whose coordinate data has been checked against its own render. It cannot be
    inferred from the pixel table.

### 9.3 Orientation

**C** — both values observed, and the storage question settled.

`ORIENTATION` is **per-page** and encodes the rotation as `1000 + degrees`:
`"1000"` = 0°, `"1090"` = 90°, `"1180"` = 180°, `"1270"` = 270°. What matters for
the raster is the ROW WIDTH, and a **90° _or_ 270°** rotation is what stores it
natively landscape — so **both `"1090"` and `"1270"` are horizontal**; `"1000"`
and `"1180"` (portrait-shaped, 180° merely upside-down) are vertical, as is any
unrecognized value or an absent key. There is no file-level orientation; the
header's `HORIZONTAL_CHECK` key does not carry one (a dead key — ignore it).

> Originally read as "only `1090` is horizontal" (mirroring an older
> `supernote-tool`). A real Nomad note carrying `ORIENTATION:1270`
> (`Ozymandias - Percy Shelley.note`) decoded at portrait width and sheared until
> `1270` was added — see `types.Orientation.fromValue`.

**A landscape page's raster is stored natively landscape.** The bitmap is the
same flat `RATTA_RLE` stream as always, but its true row width is the *swapped*
base width: a Nomad `1090` page decodes as 1872-wide × 1404 rows (an N5 page
would be 2560-wide). Nothing is rotated after decode — the stream itself is
landscape, template (`BGLAYER`) content included.

Evidence, from both directions:

- **Empirical** — a real Nomad capture (`horizontal_layers.note`: 2 pages, both
  `1090`, 4 ink layers on page 2) decodes coherently at 1872-wide rows.
  `RATTA_RLE` has no row framing, so a wrong width cannot hide: at 1404 the
  same stream shears ([§9.1](#91-page-dimensions-in-pixels)).
- **Reference agreement** — `supernote-tool` v0.7.1 swaps width and height
  *before* decoding (`decoder.py:138-139`) and its converters render natively
  landscape, never rotating. There is no `style_h_*` special-casing: landscape
  templates are landscape-stored too.

One latent reference bug is deliberately **not** replicated here: its
`PngDecoder` ignores the swapped dimensions (it trusts the PNG's own header),
so a PNG layer on a landscape page would come out unswapped. This codebase
labels every layer of a `1090` page with the effective (swapped) dims.

In this codebase the swap fact lives in exactly one place —
`types.Dimensions.oriented` — consumed by `render.zig`, `page_payload.zig` and
the server's `note_index`, so no consumer can hold a differing opinion of it.

---

## 10. `TOTALPATH` vector strokes

**Mostly C**, from the third capture ([What the corpus is](#what-the-corpus-is)):
189 strokes across 7 pages, decoded and re-rasterised, then compared against the
same pages' `LAYERBITMAP`. That comparison is what makes this section different
from the one it replaces — the bitmap is the device's own final picture, so a
decode that reproduces it is checked against the device rather than against
another reader's notes.

| page | strokes | IoU vs `LAYERBITMAP` |
|---|---|---|
| 2 / 5 / 6 | 4 each | 0.892 / 0.906 / 0.910 |
| 13 (erasures) | 93 | 0.880 |
| 16 (margins) | 33 | 0.981 |
| 34 / 35 | 27 / 24 | 0.951 / 0.988 |
| **all** | **189** | **0.967** |

The residual is a one-pixel dither along stroke edges: a sub-pixel offset scan
over ±0.5 px in both axes bottoms out at exactly `(0, 0)`, so it is the
anti-aliasing threshold and not a geometry or half-pixel-convention error. The
lower scores are simply the pages with the least ink, where a one-pixel edge is a
larger share of the total.

`TOTALPATH` addresses the **vector stroke data for a whole page** — the strokes
as drawn, before they were flattened into `LAYERBITMAP`.

### 10.0 Framing

```
TOTALPATH -> u32 block_len          (bytes that follow)
             u32 stroke_count
             stroke × stroke_count
stroke    -> u32 section_len        (bytes that follow; EXCLUDES itself)
             payload
```

**C**, and self-checking: walking `section_len` lands byte-exactly on the block
end for all 10 blocks across both mark captures, and the walked count equals
`stroke_count` every time. A decoder should assert both and refuse the block
otherwise — this is the cheapest possible guard against the layout below
drifting on a device or firmware we have not seen.

### 10.1 Stroke layout

Offsets from the start of a stroke (i.e. from its `section_len`).

| Offset | Type | Meaning | |
|---|---|---|---|
| `+0` | u32 | `section_len`, excluding itself | **C** |
| `+4` | u32 | **pen** — see the enum below | **C** |
| `+8` | u32 | **colour** — see the enum below | **C** |
| `+12` | u32 | **thickness**, 400…3799 observed | **C** |
| `+16` | u32 | `10` on all 189 | **?** |
| `+20` | u32 | `0` on all 189 | **?** |
| `+24` | u32 | `32` on all 189 | **?** |
| `+28` | u32 | `0xFFFFFFFF` on all 189 | **?** |
| `+32` | u32 | **page number**, 1-based — equals the `PAGE<n>` key of the block's own page, 189/189 | **C** |
| `+36`, `+40` | u32 | `0` | **?** |
| `+44` | u32 | `5000` on the 184 drawing strokes; `-1`/`-2` on the 5 erasers | **?** |
| `+48` | u32 | `0` | **?** |
| `+52` | char[52] | **stroke kind**, NUL-padded — `"others"` on all 189 | **C** |
| `+104` | 6 × i32 | **bounding box in PANEL PIXELS**: `minX, minY, midX, midY, maxX, maxY` | **C** |
| `+128` | u32 | `2` on all 189 | **?** |
| `+132` | u32 | **canvas height** for THIS stroke (see [§10.3](#103-coordinate-transform)) | **C** |
| `+136` | u32 | **canvas width** for THIS stroke | **C** |
| `+140` | char[52] | `"superNoteDocument"` in a `.mark` | **C** |
| `+192` | u32 | `1` | **?** |
| `+196` | 5 × u32 | `0` | **?** |
| `+216` | arrays | the four parallel per-point arrays, below | **C** |
| … | 74 B | a struct; `+16` is a 1-based per-page stroke **sequence number**, i.e. draw order. 74 bytes for every drawing stroke; **78/86/118 for erasers** | **C** |
| … | contours | `u32 nC`, then per contour `u32 M` and `M × (f32, f32)` — **in PANEL PIXELS** | **C** |
| … | trailer | `u32 nC` (echo), `nC × 16 B`, `u32` | **C** |
| … | tail | 30 B (or 34–38 B on stubs), then `[u32 4]"none"[u32 4]"none"`, then 32 B | **I** |

!!! danger "Navigate by `section_len`, never by arithmetic"
    The 74-byte struct and the tail are **variable and not understood** — their
    boundaries were found by search, not by grammar. Skip to the next stroke
    using `section_len` alone, and treat a stroke whose arrays cannot be walked
    as a stroke to **skip**, not one to guess at.

The four parallel arrays, each `u32 N` followed by `N` elements:

| Array | Element | Notes |
|---|---|---|
| points | `i32, i32` stored **`(y, x)`** | canvas units — see [§10.3](#103-coordinate-transform) |
| pressure | **`u16`** | 156…2985 observed. The inherited spec says `u32`; it is **16-bit** |
| tilt | `i16, i16` | hundredths of a degree (99.9% are multiples of 100). **I** |
| flags | `u8` | **constant `1`** on all 23,789 points — carries no information in this corpus |

| `pen` | Meaning | |
|---|---|---|
| 10 | Needle Point | **C** |
| 11 | Marker | **C** |
| 15 | **Calligraphy Pen** | **C** |
| 16 | **Ink Pen** | **C** |
| 1 | `InkPen` in the inherited enum. Not observed in the `.mark` corpus; **every pen stroke** in three `.note` pages from firmware Chauvet.E103.2610191001 (2026-11) is pen 1 | **C** |
| 0 | **A text box**, not a stroke — [§10.5](#105-text-boxes) | **C** |
| 4 | A record that came with a sticker: 513 bytes, no field list. Layout unknown | **I** |

15 and 16 are new here: they are absent from the inherited enum, they account for
75 of the 189 strokes, and they are named because the capture's author wrote the
pen's name on the page in that pen's own handwriting.

| `colour` | Meaning | |
|---|---|---|
| 0 | Black (176 strokes) | **C** |
| 1 | MarkerBlack (8) | **C** |
| 255 | **Eraser** (5) — [§10.2](#102-erasure) | **C** |
| 158 / 202 / 254 | DarkGrey / LightGrey / White | **I** — not observed |

### 10.2 Erasure

**`TOTALPATH` retains ink the user erased, in two different ways, and a decoder
that mishandles either will put deleted content back on the page.** This is the
most dangerous thing in the format: the failure is silent, it looks like a
correct render, and what it leaks is precisely the material someone chose to
remove.

**1 — An eraser is a stroke.** Colour 255 marks a stroke that masks the strokes
beneath it rather than an edit applied to them, so the strokes it passed over are
still present in full. Rendering page 13 with every drawing stroke and no erasure
draws four continuous wavy lines where the device shows them chopped into dashes
(symmetric difference 6,753 px; precision 0.65). Compositing the erasers
**destination-out along their point polyline** collapses that to 1,543 px and
IoU 0.88, with the remainder 1–2 px at the dash tips.

- Best-fit eraser radius ≈ **4.5–5 px** at `thickness = 1300` (≈ 0.8 mm
  diameter). **One sample** — whether radius scales with `thickness` is unknown.
- **Order matters.** Erasing in stroke order, so an eraser affects only strokes
  drawn before it, scores 1,543 against 1,735 for erasing everything at the end.
  The struct's sequence number (`+16`) gives that order.
- Erasers are structurally different (78/86/118-byte struct, and they may carry
  no contour section). Detect them by `colour == 255` and never fill them.

**2 — A fully erased stroke is kept as a stub, with stale geometry.** The
inherited notes say such a stroke is "deleted from the data outright". It is not.
63 of page 13's 93 strokes have `N == 0` — points, pressure, tilt and flags all
emptied — **while keeping their original bounding box and their original
contour**. Filling those contours resurrects 3,287 px of deliberately deleted
ink.

!!! danger "Both guards are needed; either alone leaks"
    Skip `N == 0` strokes **and** composite the erasers. Applying only the
    erasers leaves the stubs; skipping only the stubs leaves the partial
    erasures.

    The hazard also generalises in a direction this corpus cannot rule out: the
    device is willing to leave *inconsistent* geometry behind. If a future
    firmware emptied the **contours** instead of the points, a contour-first
    renderer would drop live ink rather than resurrect dead ink. Cross-check
    `N == 0` against the contour extent and treat a disagreement as a stroke to
    skip.

### 10.3 Coordinate transform

The inherited three-step transform is **correct**, with one fix that decides
whether a page lands or not.

1. **Axis order.** Points are stored **`(y, x)`**, not `(x, y)`.
2. **Origin.** The origin is top-right, so `x' = canvas_width - x`, applied
   **before** scaling because the extent is in canvas units.
3. **Scale.** `pixels = x' × panel_width / canvas_width`.

!!! warning "Take the canvas extent from the STROKE, not from a constant"
    Each stroke carries its own canvas extent at `+132` (height) and `+136`
    (width), and they are **not all the same within one file**. The common value
    is `11864 × 15819`, but one stroke in the corpus declares `8898 × 11864` and
    eight more declare `11863`. Decoded with the hard-coded constant that stroke
    lands **358 px away** from its own declared bounding box; decoded with its
    own extent it lands on it.

    This is exactly the failure [§9.2](#92-physical-canvas-in-millimetres)
    warns about — "uniformly wrong, and it still looks right" — caught in a real
    file only because the bounding box gives an independent check.

**The bounding box is the free self-check.** It is in panel pixels, so it is
already in the destination space: every decoded point must fall inside its own
stroke's box. Across all 189 strokes the worst overshoot is 1.5 px, which is the
integer rounding of the box itself. A decoder should verify this per stroke and
refuse a stroke that fails.

### 10.4 Rendering: fill the contours, do not model the pen

Each stroke carries the **device's own fill outline** in the contour section, in
panel pixels. Filling those reproduces `LAYERBITMAP` to the anti-aliasing
threshold, which makes a pen model unnecessary for rendering.

- **Fill EVEN-ODD across all of a stroke's contours together.** Filling each
  contour independently plugs the holes in `o`, `e` and `a`; on page 2 that is
  the difference between precision 0.34 and 0.997.
- Contours are already in panel pixels — no transform, and they are what makes
  resolution-independent output possible: the same outlines can be rasterised at
  any DPI, or emitted as vector paths.

The width model is therefore **not needed**, and is recorded only because it
describes the hardware. Pens 10 and 11 are constant-width and ignore pressure
entirely; pens 15 and 16 are pressure-modulated:

```
pen 15/16:  width ≈ (thickness / 1000) × (2.6 + 0.0025 × pressure)   ± ~10%
pen 10/11:  width  = constant × (thickness / 1000)
```

The ±10% residual is why the contours are the better source: they are exact where
this is fitted.

### 10.5 Text boxes

**C**, from three `.note` pages (Nomad, firmware Chauvet.E103.2610191001,
2026-11): `tests/fixtures/textbox_recognition_on.note` (two boxes, recognition
on), `textbox_recognition_off.note` (one box, a Standard note) and one capture
kept local.

**A text box is a record in `TOTALPATH`, not a stroke and not part of the
transcript.** The tablet never puts typed text in `RECOGNTEXT`, with
recognition on or off; the transcript of a page holding only typed text is
`{"elements": []}`. The text is drawn into `MAINLAYER` like ink, so a renderer
shows it; only a reader of `TOTALPATH` can search it.

| Offset | Type | Meaning | |
|---|---|---|---|
| `+0` | u32 | `section_len`, as for a stroke | **C** |
| `+4` | u32 | **pen = 0**: what marks a text box | **C** |
| `+8`, `+12` | u32 | `0`, `100` | **?** |
| `+483` | u32 | byte length of the field list, its final comma included | **C** |
| `+487` | bytes | the **field list**: base64 values, each followed by `,` | **C** |
| … | 26 B | `…none…` and zeros | **?** |

The field list holds 19 values on every box seen. Decoded:

| Field | Example | Meaning | |
|---|---|---|---|
| 3 | `20261109060851683675` | an id, `yyyyMMddHHmmss` + digits | **I** |
| 4, 5 | `702,928,259,127` | the box in **panel pixels**, `x,y,w,h` (twice) | **C** |
| 10 | `48.000000` | font size | **I** |
| 11 | `/system/fonts/DroidSansFallbackFull.ttf` | font | **C** |
| **12** | `Très bien\nça va` | **the text**, UTF-8, line breaks as `\n` | **C** |
| 13 | `0,0,0,0.000000,…` | style, unknown | **?** |

Two page keys go with it:

- **`PAGETEXTBOX`** is a flag: `0` on every page without a box, `1` on a page
  with one **or two**. Read the strokes only when it is not `0`.
- **`DISABLE`** lists every live box, `x,y,w,h|` each (`702,928,259,127|702,928,260,64|`).
  Inkhold keeps only a record whose rectangle `DISABLE` lists. Erased strokes
  stay in this block ([§10.2](#102-erasure)); whether a deleted box does is
  unknown, and that check keeps one out of search either way.

Boxes overlap freely: a new box is always placed mid-page, and on the device it
moves only with the pen.

---

## 11. Handwriting recognition

Recognition is performed **on the device**, is **per page**, and is
**status-gated** by `RECOGNSTATUS`. A file records only what the device has
already recognised; nothing in the format implies text can be derived from an
unrecognised page.

| `RECOGNSTATUS` | Meaning | `RECOGNTEXT` | `RECOGNFILE` | Marker |
|---|---|---|---|---|
| `0`, or key absent | never recognised | absent / address `0` | absent | **C** |
| `1` | finished | populated | present | **C** |
| `2` | running | present but **empty** | present | **C** |

File-level flags in the header: `FILE_RECOGN_TYPE = "1"` means recognition is
enabled, and `FILE_RECOGN_LANGUAGE` carries the language tag. Neither implies any
particular page has finished.

### 11.1 `RECOGNTEXT`

**C**

The content block is **base64** (standard alphabet) wrapping a JSON document:

```json
{ "elements": [
  { "label": "Test", "type": "Text",
    "words": [
      { "label": "Test",
        "bounding-box": { "x": 3.31, "y": 11.76, "width": 30.31, "height": 16.53 } },
      { "label": "\n", "bounding-box": null }
    ] },
  { "type": "Raw Content" } ] }
```

| Field | Type | Notes |
|---|---|---|
| `elements[].type` | string | `"Text"` and `"Raw Content"` observed. Only `"Text"` carries usable words. |
| `elements[].label` | string | the element's joined transcript |
| `elements[].words[].label` | string | one word, **or** a layout separator: `"\n"` or `" "` |
| `elements[].words[].bounding-box` | object **or `null`** | **millimetres**, origin **top-left** |

Two properties that a parser must handle explicitly:

- **`bounding-box` is nullable, and null is common.** The device emits layout
  separators as words with no position. They must be *skipped*, not defaulted to
  `{0,0,0,0}` — which would pile every separator into the top-left corner. A
  schema that types the field as non-optional fails the whole document on the
  first null, costing the page its entire transcript.
- **The boxes are in millimetres, not pixels.** On a 1404 × 1872 page, reading
  them as pixels places every word inside the top-left ~112 × 149 px corner —
  wrong in a way that is easy to mistake for a layout bug. Converting requires
  the millimetre canvas of [§9.2](#92-physical-canvas-in-millimetres), which is
  known only for verified hardware.

### 11.2 `RECOGNFILE`

**I**, entirely. A **MyScript iink package**: a ZIP (magic `PK…`) containing

```
meta.json
rel.json
index.bdom
pages/<id>/ink.bink
pages/<id>/page.bdom
pages/<id>/style.css
pages/<id>/meta.json
```

Richer than `RECOGNTEXT`, and present even while `RECOGNTEXT` is still empty
mid-recognition (`RECOGNSTATUS = 2`). Extracting text from it is uncharted.

---

## 12. Known unknowns

Recorded because "this is not known" is a fact worth looking up.

| Question | Status |
|---|---|
| What is the true millimetre canvas of an N5/Manta, or any non-`N6` device? | **?** — needs a sample whose coordinate data has been checked against its own render. |
| Does `LAYERPROTOCOL` ever actually select an encoding? | **?** — it reads `RATTA_RLE` on files carrying X2 data. The signature version is the reliable discriminator. |
| What is `0x140E`, the blank-background block size? | **?** — a magic constant with no structural cross-check against the stream. |
| Is any layer 24-bit RGB rather than 8-bit grayscale? | **?** — `supernote-tool` models it; no observed layer uses it. |
| Do `SN_ASA_COMPRESS` or `PNG` content blocks appear in files a current device produces? | **?** — no A-series file has been examined. |
| What are `TOTALPATH`'s `unk` config fields? | **?** — the layout DID survive contact with a real file ([§10](#10-totalpath-vector-strokes)); eight constant u32s in the head, the 74-byte struct and the tail remain unexplained. |
| What does the per-point `flags` array in a stroke mean? | **?** — constant `1` across all 23,789 points in the corpus, so it carries no information here and cannot be decoded from it. |
| How does `thickness` map to a rendered stroke width in pixels? | **C** to ±10% for the four observed pens ([§10.4](#104-rendering-fill-the-contours-do-not-model-the-pen)) — and not needed, since each stroke carries the device's own fill contour. |
| Do `LAYERPATH`, `LAYERVECTORGRAPH` and `LAYERRECOGN` mean what their names suggest? | **?** — observed in a third-party spec, never read. |
| `EXTERNALLINKINFO`'s field 2 — is it the destination page's id? | **C** — YES. It equals the `PAGEID` of the page field 3 names, for **all 51,256 records** of the corpus, checked against the id each page block actually carries ([§14.1](#141-encoding)). |
| Keyword, title and link blocks — what encodes their images, and does it vary by version? | **?** — unexamined. The COVER branch is settled (a complete PNG, [§5](#5-keyword-title-link-and-cover-objects)); whether that holds across versions/devices, and what `COVER_1` files look like, is not. |
| Does an eraser's radius scale with `thickness`? | **?** — fitted at ~4.5 px for one `thickness` on one page ([§10.2](#102-erasure)). |
| Is a `.mark`'s canvas extent genuinely PER-STROKE, or per-device with outliers? | **?** — three distinct extents appear within one file ([§10.3](#103-coordinate-transform)); reading it per stroke is correct either way. |
| What lays out a `"straightLine"` stroke? | **?** — all 189 strokes in the corpus are `"others"`. |
| Does `SN_FILE_VER_20260016` add fields beyond those documented here? | **?** — it parses and renders correctly; absence of new fields is not established. |
| How do the 5 layers blend with the template/background beyond the `0xFF` sentinel rule? | **?** — the sentinel rule reproduces every sample checked, now including a non-default `LAYERSEQ` (`horizontal_layers.note` page 2, golden-pinned); whether any other blend mode exists remains unexamined. |
| Is `.mark` (the PDF-annotation sibling format) related to this container? | **C** — YES, it is the same container. See [§13](#13-the-mark-sibling-format). |
| How does the device map an arbitrary PDF page into its panel? | **C**, aspect-preserving and centred — the device writes the mapping itself in `HIGHLIGHTINFO` ([§13.3](#133-geometry-panel-pixels-to-page), [§13.4](#134-highlightinfo-the-devices-own-page-transform)). |

---

## Sources

| Source | Contributed |
|---|---|
| [`supernote-tool`](https://github.com/jya-dev/supernote-tool) by jya (Apache-2.0) | Container layout, metadata key names, `RATTA_RLE`, `SN_ASA_COMPRESS`, palette, keyword/title/link objects |
| Walnut356's [blog post](https://walnut356.github.io/posts/inspecting-the-supernote-note-format/) and [`snlib`](https://github.com/Walnut356/snlib) | `TOTALPATH` stroke layout, the coordinate transform, the `snlib` sample corpus, an ImHex `.hexpat` structural spec |

Field names and constants marked **I** are those projects'. Marks of **C**
record independent confirmation against files described in
[What the corpus is](#what-the-corpus-is).

---

## 13. The `.mark` sibling format

Supernote annotates a PDF by writing a **separate** `.mark` file beside it. This
section is **C** except where marked, from two real captures written by an N6
(Nomad) on 2026-08-04, checked against the PDFs they annotate.

Corpus: `2022-03 Plano diretor de Natal.pdf.mark` (28,349 B, 3 pages) and
`..._compressed.pdf.mark` (67,931 B), annotating a 77-page **A4** document
(595.276 x 841.89 pt).

### 13.1 It is this container

The same container, byte for byte in structure — `keyblock`, footer, page
blocks, `RATTA_RLE` layers. It parses and renders through the unmodified note
parser, which is why Inkhold has always shown `.mark` files.

What differs is only metadata:

| Field | Value | Note |
|---|---|---|
| first 4 bytes | `mark` | where a notebook has `note` ([§4](#4-the-signature)) |
| `<FILE_TYPE:...>` | `MARK` | stated outright, unlike a notebook |
| `<LAYERTYPE:...>` | `MARK` | on each LAYER block (not the page's); a notebook uses `NOTE` |
| `<PDFSTYLE:...>`, `<PDFSTYLEMD5:...>` | `none`, `0` | present but unused in both captures |
| `<APPLY_EQUIPMENT:...>` | `N6` | so [§9.1](#91-page-dimensions-in-pixels) gives 1404 x 1872 |

### 13.2 Pairing, and the sparse page map

**Pairing is `<full pdf filename>.mark`, in the same folder** — `foo.pdf` pairs
with `foo.pdf.mark`, NOT `foo.mark`. Both captures agree.

**A `.mark` holds only the annotated pages, and the footer names which.** The
footer of the 3-page capture reads:

```
<PAGE2:13104><PAGE5:19384><PAGE6:27875><COVER_0:0><DIRTY:0><FILE_FEATURE:24>
```

Not `PAGE1/2/3`. The integer in each key **is the 1-based PDF page number**,
corroborated by `<FINALOPERATION_PAGE:6>` in the header naming a page that
exists in the list. A notebook's footer is contiguous from `PAGE1`, which is why
nothing has needed this until now.

> **This parser currently discards that number.** `note.pageAddresses` collects
> every `PAGE*` entry in footer order and keeps only the ADDRESS, so a 3-page
> mark presents as pages 0,1,2 and the fact that they are PDF pages 2, 5 and 6
> is lost. Harmless while a `.mark` is shown alone; wrong the moment it is
> composited onto its PDF.

### 13.3 Geometry: panel pixels to page

Ink is written in **device panel pixels** (1404 x 1872 here). The container
carries no page geometry at all — dimensions come from `APPLY_EQUIPMENT`
([§9.1](#91-page-dimensions-in-pixels)) — so the page-to-panel mapping must be
reconstructed.

**The device fits the page to the panel preserving aspect.** For a page of
`W x H` points in a `PW x PH` panel:

```
scale  = min(PW / W, PH / H)
offset = ((PW - W*scale) / 2, (PH - H*scale) / 2)
```

A4 in an N6 panel is height-limited: `scale = 2.2236`, fitted 1323.6 x 1872.0,
so 40.2 px of dead margin on each side and none top or bottom.

Verified by compositing the decoded ink onto the rendered PDF pages: on all
three annotated pages the handwriting lands in the whitespace it was plainly
written in — beside a column of `VETADO` entries on page 2, at the end of a
numbered list on page 6 — with no clipping and no visible offset.

**The centring offset is now `C` too — and the device states it.** This was `I`
for a day: the first two captures had no ink near a side margin, so they could
not discriminate centred-letterbox from a plain stretch (for A4 the two differ by
at most 3.0 mm, and agree exactly in `y`). The third capture settles it, but not
in the way the question was posed — the answer turned out to be **written in the
file**, in `HIGHLIGHTINFO` ([§13.4](#134-highlightinfo-the-devices-own-page-transform)),
which records the same rectangle twice: once in PDF points and once in panel
pixels.

Fitting those 14 paired x-samples (PDF x 46…541 pt, panel 143…1243 px):

| Mapping | Fit | Max residual |
|---|---|---|
| **The device's own pairs** | `panel_x = 2.223022·pdf_x + 40.6375` | 0.49 px |
| Aspect-preserving, centred (above) | `scale 2.223568, offset 40.1815` | **0.67 px** |
| Plain stretch to the full panel | `scale 2.358570, offset 0` | **34.51 px** |

Centred wins by a factor of ~50, against geometry the device wrote itself.

> **The device does NOT clip the pen to the page.** Page 16 of the third capture
> has ink spanning the full panel, x `0.0 … 1403.8` — 1,375 contour vertices left
> of the page rect and 2,557 right of it. Ink drawn in the dead margin is
> therefore real, recorded, and **not on the document**. Anything compositing a
> mark onto its PDF has to decide whether to clip it or carry it; there is no
> answer in the file.

### 13.4 `HIGHLIGHTINFO`: the device's own page transform

A `.mark` records **PDF text highlights** — the ones made by selecting text
rather than by drawing — in a header block of their own, and they are **not ink**:
six of the seven highlight rectangles on page 34 of the third capture cover zero
pixels in that page's `LAYERBITMAP`. A reader that renders only the layers loses
them entirely.

`<HIGHLIGHTINFO:addr>` addresses a length-prefixed, base64-encoded JSON block.
Each highlight carries the same rectangles **twice**:

| Field | Space |
|---|---|
| `mupdfRectList` | PDF **points**, as `{x0, y0, x1, y1}` |
| `rnRectList` | device **panel pixels**, as `{left, top, right, bottom}` |

That pairing is why [§13.3](#133-geometry-panel-pixels-to-page) is now **C**: the
device is stating its own page-to-panel mapping, in the file, for every
highlighted rectangle. It is also the cheapest possible calibration for any
future device or page size — one highlight anywhere on a page yields the exact
transform for that page, with no fitting against ink required.

The field name `mupdfRectList` is worth noting on its own: the device's PDF
engine is MuPDF, which is also what Inkhold renders with.

---

## 14. `EXTERNALLINKINFO` — the links a PDF template brought with it

**C**, from a single but overwhelming capture: a 1703-page notebook built on a
commercial digital planner (`Supernote-Teacher-Planner-digital-vertical`),
imported as a PDF template on an N6. **1702 of its 1703 pages carry links, 51,256
records in all** — 48,047 internal page jumps and 3,209 web URLs.

**A PDF used as a template keeps its links.** The device rasterises each PDF page
into a per-page style (`<PAGESTYLE:user_pdf_<pdf name>_<n>>`, with
`PAGESTYLEMD5` naming the template blob) and records that page's link rectangles
separately, in a page-level `EXTERNALLINKINFO` block. Address `0` means the page
has none, which is the case for every other file in the corpus — an ordinary
`.note` on a built-in style has nothing to preserve.

### 14.1 Encoding

Decoded by `src/links.zig`, which needs its own decoder rather than the JSON
path — this key's encoding is the odd one out among the page's content blocks.
Not base64 JSON, unlike its neighbours `LAYERINFO`, `RECOGNTEXT` and
`HIGHLIGHTINFO`. It is a length-prefixed content block holding **records
separated by `|`**, each a list of **comma-separated base64 fields**:

```
Mg==,UDIwMjYw…,MQ==,ODE5,NjE0,MTg3,Mjg=,MQ==,aHR0cHM6…,|…
```

**Both separators are TRAILING, not infix**, and a decoder has to expect it:
every record ends with a `,` (so it splits into TEN fields, the last empty) and
every block ends with a `|` (so it ends with an empty record). This holds for all
51,256 records — the field count is exactly 10 for every one of them. Reading it
as "nine fields, skip what does not parse" is the only shape that survives
contact with a real file.

Every field — including the plain integers — is base64. Decoded:

| # | Field | Meaning | |
|---|---|---|---|
| 1 | `2` | the page these links are ON, 1-based | **C** |
| 2 | `P20260804145314013102EjfmKbJyxu7V` | a `PAGEID`-shaped id | **I** — see below |
| 3 | `1` | the TARGET page, 1-based, for an internal link | **C** |
| 4–7 | `819, 614, 187, 28` | **the rect: x, y, w, h in DEVICE PANEL PIXELS** | **C** |
| 8 | `1` | kind: `1` = web, `0` = internal page jump | **C** |
| 9 | `https://…` or `none` | the URL, or `none` for an internal link | **C** |

**The rect is in panel pixels, the same space as the ink** ([§9.1](#91-page-dimensions-in-pixels)) —
across all 51,256 records the extremes are `x+w = 1401` and `y+h = 1865`, both
just inside the N6's 1404 × 1872. So a link needs no coordinate transform to sit
on a `.note` page: the page IS the panel. (Placing one on the PDF *it came from*
would need [§13.3](#133-geometry-panel-pixels-to-page)'s mapping, as ink does.)

**Field 2 is `C`: it is the TARGET page's `PAGEID`.** Checked the way the guess
asked for — against the `PAGEID` each page block actually carries — it matches
for **every one of the 51,256 records**, so it is the stable form of field 3's
number and the field to prefer if page numbers are ever rewritten underneath.
(On an external record field 3 is always `1` and field 2 is page 1's id
accordingly: both are filler when there is a URL.)

Two more facts the same sweep established, both of which a decoder has to be
built for:

- **Field 1 is always the containing page's own number** — no record in the
  corpus disagrees with the block it sits in. It is a redundancy, not
  information, which makes it the one field that can be checked against
  something known.
- **`kind` is a claim, not a guarantee.** Two records say `1` (web) and carry the
  URI `none` — a web link with nowhere to go. They are the argument for letting
  the URI decide and refusing anything the scheme allowlist does not accept,
  rather than trusting field 8 and synthesising a jump to page 1.

### 14.2 The template travels with the file

**The PDF page's pixels are IN the note**, not referenced out of it. Every one of
the 1703 pages carries a `BGLAYER` whose `LAYERPROTOCOL` is `RATTA_RLE` — the
same encoding as ink — and whose `LAYERBITMAP` is a real content block, 258–695
KB on the pages sampled. **376 MB of the 385 MB file, 98% of it, is background
raster.** The `PAGESTYLEMD5` is distinct per page (1698 values over 1703 pages),
so it identifies THAT page's rendered template rather than the source document.

Two consequences worth stating:

- **The file stands alone.** The template blob named by `PAGESTYLEMD5` is not in
  the corpus at all — the device never synced it — and nothing needs it: an
  existing reader composites `BGLAYER` under the ink and gets the planner,
  which is why these files have always rendered correctly here.
- **Links are the only part that is NOT in the picture.** The pixels of a link
  are baked into the background like everything else; what
  [§14.1](#141-encoding) adds is the geometry and the destination. So honouring
  them is purely additive — nothing about the existing render changes.

### 14.3 Why this matters

A digital planner is mostly links: month tabs, day cells, an index. A reader that
renders the pages and drops the links reproduces the picture of a planner and not
the planner. Everything needed to honour them is already in the file, in the
same coordinate space as everything else on the page.

