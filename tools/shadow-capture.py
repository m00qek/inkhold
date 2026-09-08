#!/usr/bin/env python3
"""Freeze what the SERVER's search answers, before it stops existing.

`golden-search.md` §6 step 6 deletes the server implementation. After that there
is nothing left to compare the browser against -- so the window for capturing its
answers is now, and the value of the capture is proportional to how many
questions we think to ask inside it.

So the queries are GENERATED FROM THE CORPUS rather than hand-picked. A
hand-written list carries the author's idea of what might break; seventeen of
them, all single terms, was the first version of this and it tested none of the
multi-word AND path that ordinary use is made of.

Deterministic (seeded), so the set is reproducible and reviewable, and a
regression names the same query it named last time.

Answers are recorded two ways because the client asks two questions: buildMatch
in `webapp/wasm/sqlite_core.zig` appends `*` to the LAST term unless the query
ends in whitespace, so "con" is a prefix search and "con " an exact one.

Storage: every query keeps a COUNT and a DIGEST of its sorted page set; small
results (<= FULL_BELOW pages) also keep the pages themselves. A digest catches
any divergence; the full list is what lets a small, precise disagreement be read
directly rather than re-derived from a server that no longer runs.

Usage: shadow-capture.py <snapshot.db> <out.json> [n_queries]
"""
import hashlib, json, random, re, sqlite3, sys, unicodedata

SQL = """SELECT p.blob_md5, p.page_index
           FROM segment_fts f
           JOIN segment_search s ON s.id = f.rowid
           JOIN note_page_index p ON p.id = s.segment_id
          WHERE segment_fts MATCH ?"""

FULL_BELOW = 40
SEED = 0x5EED


def digest(pages):
    h = hashlib.sha256()
    for md5, page in pages:
        h.update(f"{md5}#{page}\n".encode())
    return h.hexdigest()[:32]


def vocabulary(db):
    """(term, doc_frequency) over the server's own index, commonest first."""
    db.execute("CREATE VIRTUAL TABLE IF NOT EXISTS temp.v USING fts5vocab('main','segment_fts','row')")
    return db.execute("SELECT term, doc FROM temp.v ORDER BY doc DESC").fetchall()


def accented_words(db, limit=400):
    """Words as a PERSON would type them -- with diacritics still on.

    The corpus is folded (`remove_diacritics 2` ran over it), so every stored
    term is unaccented and no generated query drawn from the vocabulary can ever
    exercise the fold. These can: the server folds the query through its
    tokenizer, the browser through the same C compiled to wasm, and agreeing
    about "reunião" is the entire parity argument (§2.2).
    """
    out, seen = [], set()
    for (text,) in db.execute(
        "SELECT text FROM note_page_index WHERE text IS NOT NULL AND length(text) > 0 LIMIT 4000"
    ):
        for w in re.findall(r"\w{4,}", text, re.UNICODE):
            if any(unicodedata.combining(c) for c in unicodedata.normalize("NFD", w)):
                lw = w.lower()
                if lw not in seen:
                    seen.add(lw)
                    out.append(w)
                    if len(out) >= limit:
                        return out
    return out


def page_terms(db, limit=3000):
    """Terms co-occurring on one page, for AND queries that MUST match."""
    db.execute("CREATE VIRTUAL TABLE IF NOT EXISTS temp.vi USING fts5vocab('main','segment_fts','instance')")
    by_page = {}
    for term, doc in db.execute("SELECT term, doc FROM temp.vi LIMIT 400000"):
        by_page.setdefault(doc, [])
        if len(by_page[doc]) < 12:
            by_page[doc].append(term)
    return [v for v in by_page.values() if len(v) >= 3][:limit]


def generate(db, n):
    rnd = random.Random(SEED)
    vocab = vocabulary(db)
    terms = [t for t, _ in vocab]
    common = terms[: max(1, len(terms) // 50)]
    rare = [t for t, d in vocab if d == 1]
    queries = []

    def add(q):
        if q and q not in queries:
            queries.append(q)

    # Single terms across the frequency range -- commonest, rarest, longest.
    for t in common[:60]:
        add(t)
    for t in rnd.sample(rare, min(len(rare), 300)):
        add(t)
    for t in sorted(terms, key=len, reverse=True)[:40]:
        add(t)
    for t in rnd.sample(terms, min(len(terms), 400)):
        add(t)

    # Multi-word. The path ordinary use is made of and the first version tested
    # none of it: the client ANDs its terms, so these are where an AND that
    # silently ORs, or a rowid that maps to the wrong page, would show.
    for group in page_terms(db):
        picks = rnd.sample(group, min(len(group), 3))
        add(" ".join(picks[:2]))          # same page: MUST match
        add(" ".join(picks))              # three from one page
    for _ in range(300):
        add(" ".join(rnd.sample(terms, 2)))   # unrelated: usually matches nothing

    # Words with their accents still on, plus case the folder has to flatten.
    for w in accented_words(db):
        add(w)
        add(w.upper())

    # And the shapes that are not words at all. Each must be answered, not
    # thrown: a token folding to no terms is not an error (§2.2).
    for q in ["!!!", "-", '"', "\\", "   ", "a", "zzzznotpresentanywhere", "the the", "1234"]:
        add(q)

    rnd.shuffle(queries)
    return queries[:n]


def main(db_path, out_path, n=4000):
    db = sqlite3.connect(db_path)
    queries = generate(db, int(n))
    out, full, big = {}, 0, 0
    for q in queries:
        entry = {}
        for mode, expr in (("exact", q), ("prefix", q + "*")):
            try:
                pages = sorted([m, p] for m, p in db.execute(SQL, (expr,)).fetchall())
            except sqlite3.OperationalError as e:
                entry[mode] = {"error": str(e)}
                continue
            rec = {"n": len(pages), "digest": digest(pages)}
            if len(pages) <= FULL_BELOW:
                rec["pages"] = pages
                full += 1
            else:
                big += 1
            entry[mode] = rec
        out[q] = entry
    json.dump({"seed": SEED, "queries": out}, open(out_path, "w", encoding="utf-8"), ensure_ascii=False)
    print(f"captured {len(queries)} queries x2 modes ({full} with full pages, {big} digest-only) -> {out_path}")


if __name__ == "__main__":
    main(*sys.argv[1:4])
