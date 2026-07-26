#!/usr/bin/env python3
"""Seed a household-scale note library, so listing/search/index cost can be
MEASURED rather than estimated.

The live database is ~20 files, which tells you nothing: every query on the
control-plane face is index-backed and single-row-ish, so the shape only shows up
at a few hundred notes across a real folder tree with a real FTS corpus. This
builds that, offline (no server, no Zig), by writing `inkhold.db` and
`<data-dir>/blobs/` directly — the same thing `seed_note.py` does, at scale.

## What is real and what is synthetic (read this before quoting a number)

  * **Blob bytes are real.** Every seeded note's blob file is a byte-for-byte copy
    of a real `.note` capture, so `/note/:id/page/:n` streams real layer ranges
    out of a real file at a real size.
  * **The index rows are real in structure, replicated in content.** `note_index`
    / `note_page_index` are copied from a TEMPLATE — a real note that the server
    itself parsed and indexed — and re-keyed to each synthetic blob md5. Page
    rows are repeated cyclically to give notes differing page counts. So the row
    widths, the `layers` blobs and the offsets are exactly what the indexer
    produces; only their multiplicity is manufactured.
  * **Recognized text is synthetic natural-language-shaped noise**, drawn Zipf-ish
    from a fixed vocabulary so FTS term selectivity spans the realistic range
    (a common word hits thousands of pages, a rare one a handful). Real OCR
    output was not available at this scale.

Two phases, because the template has to be produced by the real indexer:

    seed_corpus.py place    --db ... --data-dir ... --note sample.note ...
    # (start the server, GET /api/controlplane/note/<id> for each placed note)
    seed_corpus.py populate --db ... --data-dir ... --users 4 --notes 300

Run with the server STOPPED (avoids WAL write contention).
"""
import argparse
import hashlib
import math
import os
import random
import shutil
import sqlite3
import sys
import time

# A vocabulary with a deliberate spread of frequencies. The Zipf draw below turns
# this order into the selectivity spread that makes FTS timings meaningful: index
# 0 lands on nearly every page, the tail on a handful.
VOCAB = """
reuniao projeto prazo cliente entrega equipe orcamento relatorio decisao risco
proposta contrato revisao escopo tarefa sprint backlog metrica objetivo resultado
meeting project deadline client delivery team budget report decision risk
proposal contract review scope task milestone metric target outcome summary
compra venda estoque fornecedor pagamento fatura imposto recibo despesa receita
consulta exame receita medicamento dosagem sintoma diagnostico tratamento retorno
escola prova nota materia licao caderno horario professor aluno turma
receita ingrediente forno massa acucar farinha manteiga fermento tempero caldo
viagem passagem hotel reserva bagagem embarque destino roteiro passeio mapa
jardim planta rega poda semente adubo colheita estufa canteiro composto
bicicleta corrente pneu freio guidao pedal quadro selim capacete oficina
livro capitulo pagina autor editora resenha citacao referencia indice prefacio
codigo funcao modulo teste build deploy commit branch merge patch
servidor cache memoria disco rede latencia throughput fila lock thread
inventario garagem ferramenta parafuso porca broca serra lixa verniz cola
""".split()


# A page is drawn from the hand-written head above plus a generated tail out to
# VOCAB_SIZE. The tail is not padding — it is the whole point. A first attempt
# drew 110 words from a 150-word vocabulary, and every term in it then matched
# 20-100% of the corpus: there was no such thing as a selective query, so an FTS
# timing measured one case and claimed to have measured search. Real handwriting
# has a long tail, and what a search costs depends on where in it the term sits.
VOCAB_SIZE = 20_000
_STEMS = ["cad", "mor", "vent", "pral", "sint", "torn", "brac", "quel", "dorm",
          "fals", "grin", "hept", "isol", "jant", "lamp", "must", "nerv", "orbit",
          "pulm", "ras", "sold", "trin", "urg", "vinc", "zurr", "elm", "flux"]
_MIDS = ["", "a", "e", "i", "o", "ar", "er", "or", "in", "un", "al", "el"]
_TAILS = ["ao", "ada", "ivo", "ento", "agem", "ismo", "ura", "ico", "avel", "ante",
          "encia", "idade", "mente", "ario", "oso", "eiro", "inho", "ista"]


def build_vocab():
    words = list(dict.fromkeys(VOCAB))  # the frequent head, order preserved
    seen = set(words)
    rng = random.Random(0)  # fixed: the vocabulary must be identical across runs
    while len(words) < VOCAB_SIZE:
        w = (rng.choice(_STEMS) + rng.choice(_MIDS) + rng.choice(_TAILS)
             + str(rng.randrange(10_000)))
        if w not in seen:
            seen.add(w)
            words.append(w)
    return words


def zipf_index(rng, n, harmonic):
    """Draw a rank with probability proportional to 1/rank — the shape word
    frequency actually has, and the reason a common term matches most pages while
    a rare one matches a handful."""
    target = rng.random() * harmonic
    # Invert the harmonic sum by its log approximation, then clamp.
    r = int(math.exp(target - 0.5772156649))  # e^(H_r - gamma) ~= r
    return min(max(r, 1), n) - 1


def page_text(vocab, harmonic, rng, words=90):
    n = len(vocab)
    return " ".join(vocab[zipf_index(rng, n, harmonic)] for _ in range(words))


def md5_hex(b):
    return hashlib.md5(b).hexdigest()


def blob_path(data_dir, md5):
    return os.path.join(data_dir, "blobs", md5[:2], md5)


def ensure_folder_chain(cur, uid, segments, now):
    parent = None
    for seg in segments:
        r = cur.execute(
            "SELECT id FROM files WHERE user_id = ? AND COALESCE(parent_id, 0) = COALESCE(?, 0)"
            " AND name = ? AND is_folder = 1 AND deleted = 0",
            (uid, parent, seg),
        ).fetchone()
        if r:
            parent = r[0]
        else:
            cur.execute(
                "INSERT INTO files(user_id, parent_id, name, is_folder, size, created_at, updated_at, deleted)"
                " VALUES(?, ?, ?, 1, 0, ?, ?, 0)",
                (uid, parent, seg, now, now),
            )
            parent = cur.lastrowid
    return parent


# ---- phase 1: place the real notes the indexer will produce templates from ----


def cmd_place(args):
    db = sqlite3.connect(args.db)
    cur = db.cursor()
    now = int(time.time())
    uid = ensure_user(cur, args.email, admin=True, now=now)

    for path in args.note:
        raw = open(path, "rb").read()
        md5 = md5_hex(raw)
        bp = blob_path(args.data_dir, md5)
        os.makedirs(os.path.dirname(bp), exist_ok=True)
        shutil.copyfile(path, bp)
        cur.execute(
            "INSERT INTO blobs(md5, size, refcount, created_at) VALUES(?, ?, 1, ?)"
            " ON CONFLICT(md5) DO NOTHING",
            (md5, len(raw), now),
        )
        parent = ensure_folder_chain(cur, uid, ["Note", "_templates"], now)
        name = os.path.basename(path)
        row = cur.execute(
            "SELECT id FROM files WHERE user_id = ? AND parent_id = ? AND name = ? AND deleted = 0",
            (uid, parent, name),
        ).fetchone()
        if row:
            fid = row[0]
            cur.execute("UPDATE files SET md5 = ?, size = ? WHERE id = ?", (md5, len(raw), fid))
        else:
            cur.execute(
                "INSERT INTO files(user_id, parent_id, name, is_folder, md5, size, created_at, updated_at, deleted)"
                " VALUES(?, ?, ?, 0, ?, ?, ?, ?, 0)",
                (uid, parent, name, md5, len(raw), now, now),
            )
            fid = cur.lastrowid
        print(f"template {name}: file_id={fid} md5={md5} size={len(raw)}")

    bump_sync(cur, uid)
    db.commit()
    db.close()


def ensure_user(cur, email, admin, now):
    row = cur.execute("SELECT id FROM users WHERE email = ?", (email,)).fetchone()
    if row:
        uid = row[0]
    else:
        cur.execute(
            "INSERT INTO users(email, password_md5, name, is_admin, must_change_password, created_at)"
            " VALUES(?, ?, '', ?, 0, ?)",
            (email, md5_hex(b"benchpass"), 1 if admin else 0, now),
        )
        uid = cur.lastrowid
    # A usable account, not a first-login one: the harness logs in with a known
    # password and must not be diverted to the change-password flow.
    cur.execute(
        "UPDATE users SET password_md5 = ?, must_change_password = 0, is_admin = ? WHERE id = ?",
        (md5_hex(b"benchpass"), 1 if admin else 0, uid),
    )
    cur.execute(
        "INSERT INTO capacity(user_id, used_bytes, total_bytes) VALUES(?, 0, ?)"
        " ON CONFLICT(user_id) DO NOTHING",
        (uid, 100 * 1024 * 1024 * 1024),
    )
    return uid


def bump_sync(cur, uid):
    cur.execute(
        "INSERT INTO sync_state(user_id, version) VALUES(?, 1)"
        " ON CONFLICT(user_id) DO UPDATE SET version = version + 1",
        (uid,),
    )


# ---- phase 2: replicate the templates into a household-scale library ----


def load_templates(cur, data_dir):
    """Every blob the server has actually indexed, with its page rows."""
    out = []
    for md5, in cur.execute(
        "SELECT blob_md5 FROM note_index WHERE indexable = 1 AND page_count > 0"
    ).fetchall():
        idx = cur.execute("SELECT * FROM note_index WHERE blob_md5 = ?", (md5,)).fetchone()
        idx_cols = [d[0] for d in cur.description]
        pages = cur.execute(
            "SELECT * FROM note_page_index WHERE blob_md5 = ? ORDER BY page_index", (md5,)
        ).fetchall()
        page_cols = [d[0] for d in cur.description]
        path = blob_path(data_dir, md5)
        if not os.path.isfile(path):
            continue
        out.append(
            {
                "md5": md5,
                "index": dict(zip(idx_cols, idx)),
                "pages": [dict(zip(page_cols, p)) for p in pages],
                "bytes": open(path, "rb").read(),
            }
        )
    return out


FOLDERS = [
    ["Note", "Work"],
    ["Note", "Work", "Meetings"],
    ["Note", "Work", "Projects"],
    ["Note", "Work", "Projects", "Archive"],
    ["Note", "Personal"],
    ["Note", "Personal", "Journal"],
    ["Note", "Personal", "Recipes"],
    ["Note", "Study"],
    ["Note", "Study", "Maths"],
    ["Note", "Study", "Reading"],
    ["Note", "Inbox"],
    ["EXPORT"],
]


def cmd_populate(args):
    rng = random.Random(args.seed)
    db = sqlite3.connect(args.db)
    db.execute("PRAGMA foreign_keys = ON;")
    cur = db.cursor()
    now = int(time.time())

    vocab = build_vocab()
    harmonic = sum(1.0 / r for r in range(1, len(vocab) + 1))

    templates = load_templates(cur, args.data_dir)
    if not templates:
        sys.exit("no indexed template blobs — run `place`, start the server, and open each note first")
    print(f"templates: {len(templates)} "
          f"({', '.join(str(len(t['pages'])) + 'p' for t in templates)})")

    emails = [args.email] + [f"user{i}@home.lan" for i in range(2, args.users + 1)]
    total_pages = 0
    for u, email in enumerate(emails):
        uid = ensure_user(cur, email, admin=(u == 0), now=now)
        folder_ids = [ensure_folder_chain(cur, uid, segs, now) for segs in FOLDERS]

        for k in range(args.notes):
            t = templates[k % len(templates)]
            # Distinct content per note: the blob is content-addressed, so a
            # distinct md5 is what makes it a distinct index row, a distinct FTS
            # document set and a distinct cache key. The BYTES are the template's,
            # so the layer offsets stored below stay valid against them.
            md5 = md5_hex(f"{email}/{k}/{t['md5']}".encode())
            bp = blob_path(args.data_dir, md5)
            os.makedirs(os.path.dirname(bp), exist_ok=True)
            if not os.path.exists(bp):
                # Hard link where possible: 1200 copies of a 140 KB capture is
                # 170 MB of pointless disk, and the store only ever reads.
                try:
                    os.link(blob_path(args.data_dir, t["md5"]), bp)
                except OSError:
                    shutil.copyfile(blob_path(args.data_dir, t["md5"]), bp)
            size = len(t["bytes"])
            cur.execute(
                "INSERT INTO blobs(md5, size, refcount, created_at) VALUES(?, ?, 1, ?)"
                " ON CONFLICT(md5) DO NOTHING",
                (md5, size, now),
            )

            parent = folder_ids[k % len(folder_ids)]
            name = f"note-{k:04d}.note"
            if cur.execute(
                "SELECT 1 FROM files WHERE user_id = ? AND parent_id = ? AND name = ? AND deleted = 0",
                (uid, parent, name),
            ).fetchone():
                continue
            cur.execute(
                "INSERT INTO files(user_id, parent_id, name, is_folder, md5, size, created_at, updated_at, deleted)"
                " VALUES(?, ?, ?, 0, ?, ?, ?, ?, 0)",
                (uid, parent, name, md5, size, now - rng.randint(0, 90 * 86400), now),
            )

            # Page count varies per note the way a real shelf does: a few long
            # notebooks among many short ones. Pages cycle through the template's,
            # so every `layers` range still addresses real bytes.
            n_pages = rng.choice([4, 6, 8, 10, 12, 16, 24, 40])
            total_pages += n_pages
            src = t["index"]
            cur.execute(
                "INSERT INTO note_index(blob_md5, index_version, indexable, page_count, signature,"
                " signature_version, equipment, width, height, rle_variant, recogn_type,"
                " recogn_language, recognized_page_count, indexed_at)"
                " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (md5, src["index_version"], 1, n_pages, src["signature"],
                 src["signature_version"], src["equipment"], src["width"], src["height"],
                 src["rle_variant"], src["recogn_type"], src["recogn_language"], n_pages, now),
            )
            for p in range(n_pages):
                sp = t["pages"][p % len(t["pages"])]
                text = page_text(vocab, harmonic, rng)
                cur.execute(
                    "INSERT INTO note_page_index(blob_md5, page_index, content_hash, width, height,"
                    " layers, recogn_status, text_hash, recogn_offset, recogn_length, text)"
                    " VALUES(?,?,?,?,?,?,1,?,?,?,?)",
                    (md5, p, md5_hex(f"{md5}/{p}".encode()), sp["width"], sp["height"],
                     sp["layers"], md5_hex(text.encode()),
                     sp["recogn_offset"], sp["recogn_length"], text),
                )
        bump_sync(cur, uid)
        print(f"user {email}: {args.notes} notes across {len(FOLDERS)} folders")

    # Quota must agree with the tree, or the device face refuses uploads for
    # reasons that have nothing to do with what is being measured.
    cur.execute(
        "UPDATE capacity SET used_bytes = COALESCE(("
        "  SELECT SUM(b.size) FROM blobs b WHERE b.md5 IN ("
        "    SELECT DISTINCT f.md5 FROM files f WHERE f.user_id = capacity.user_id"
        "      AND f.is_folder = 0 AND f.md5 IS NOT NULL AND f.md5 <> '')), 0);"
    )
    # v15's backfill (search_partitions/segment_search/segment_fts) is replay-safe;
    # rewinding lets the next server boot mint partitions and postings for the
    # seeded rows via the REAL migration path rather than a Python mirror of it.
    cur.execute("PRAGMA user_version = 14;")
    db.commit()
    print("user_version rewound to 14 — next server boot re-runs the v15 backfill")
    print(f"\ncorpus: {len(emails)} users x {args.notes} notes, {total_pages} pages total")
    print(f"  vocabulary         {len(vocab)} words, ~90 per page, Zipf 1/rank")
    for label, sql in [
        ("files rows", "SELECT COUNT(*) FROM files"),
        ("blobs", "SELECT COUNT(*) FROM blobs"),
        ("note_index", "SELECT COUNT(*) FROM note_index"),
        ("note_page_index", "SELECT COUNT(*) FROM note_page_index"),
        ("segment rows", "SELECT COUNT(*) FROM segment_search"),
        ("fts docs", "SELECT COUNT(*) FROM segment_fts"),
    ]:
        print(f"  {label:18s} {cur.execute(sql).fetchone()[0]}")
    db.close()


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("phase", choices=["place", "populate"])
    ap.add_argument("--db", default="inkhold.db")
    ap.add_argument("--data-dir", default="data")
    ap.add_argument("--email", default="admin@home.lan")
    ap.add_argument("--note", action="append", default=[])
    ap.add_argument("--users", type=int, default=4)
    ap.add_argument("--notes", type=int, default=300)
    ap.add_argument("--seed", type=int, default=1)
    args = ap.parse_args()
    if not os.path.isfile(args.db):
        sys.exit(f"no db at {args.db} — start the server once to create it, then stop it")
    (cmd_place if args.phase == "place" else cmd_populate)(args)


if __name__ == "__main__":
    main()
