#!/usr/bin/env python3
"""Half one of the shadow comparison: what the SERVER's index answers.

Queries `segment_fts` -- the real index the shipped search path uses, not a
reimplementation of it -- and writes `{query: [[md5, page], ...]}` as JSON for
the client half to be diffed against.

Reads a SNAPSHOT rather than the live database: the server runs against it in
WAL mode, so a plain copy can be torn. Pass one made with `sqlite3 db ".backup"`.

Usage: shadow-server.py <snapshot.db> <queries.txt> <out.json>
"""
import json, sqlite3, sys

SQL = """SELECT p.blob_md5, p.page_index
           FROM segment_fts f
           JOIN segment_search s ON s.id = f.rowid
           JOIN note_page_index p ON p.id = s.segment_id
          WHERE segment_fts MATCH ?"""

def main(db_path, queries_path, out_path):
    db = sqlite3.connect(db_path)
    queries = [l.strip() for l in open(queries_path, encoding="utf-8") if l.strip() and not l.startswith("#")]
    out = {}
    for q in queries:
        # The server folds the query through the same tokenizer before matching,
        # so the raw string is what goes in -- exactly as the handler does it.
        # BOTH MODES, because the client asks two different questions and a
        # comparison that only asks one reports a pile of false disagreements.
        # `sqlite_core.zig`'s buildMatch appends `*` to the LAST term unless the
        # query ends in whitespace -- a trailing space is the user saying they
        # finished the word. So "con" is a prefix search and "con " is an exact
        # one, and the server half has to spell both.
        entry = {}
        for mode, expr in (("exact", q), ("prefix", q + "*")):
            try:
                rows = db.execute(SQL, (expr,)).fetchall()
                entry[mode] = sorted([[m, p] for m, p in rows])
            except sqlite3.OperationalError as e:
                # An FTS5 syntax error is an answer too: the client must agree
                # this is unqueryable, and agree by returning nothing rather
                # than by throwing.
                entry[mode + "_error"] = str(e)
        out[q] = entry
    json.dump(out, open(out_path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    ex = sum(len(v.get("exact", [])) for v in out.values())
    pf = sum(len(v.get("prefix", [])) for v in out.values())
    print(f"server: {len(queries)} queries, {ex} exact + {pf} prefix page hits -> {out_path}")

if __name__ == "__main__":
    main(*sys.argv[1:4])
