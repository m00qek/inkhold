#!/usr/bin/env python3
"""Drive a running server over HTTP and read back the per-route `db_lock`
hold-time histogram from `GET /api/admin/health`.

The measurement lives in the SERVER (http/lock_stats.zig), not here — this only
generates the traffic and prints the table. So the numbers are the real hold
times of the real handlers under the real lock, and re-measuring after a change
is "run this again", not "rebuild a harness".

Two modes:

  sequential  one client at a time, one route class at a time. This is what the
              reported per-route p50/p95/max come from: no contention noise, so a
              hold time is the handler's own work and nothing else.
  concurrent  N clients firing a cold-gallery load at once. Checks that hold
              times don't change under contention, and that the connection cap
              behaves.

Usage:
  lock_bench.py --host 127.0.0.1 --port 18089 --account admin@home.lan \
                --password benchpass [--mode sequential|concurrent] [--clients 20]
"""
import argparse
import hashlib
import http.client
import json
import os
import random
import sys
import threading
import time
from urllib.parse import quote


def md5_hex(b):
    return hashlib.md5(b).hexdigest()


def challenge(password, code):
    """The login challenge: sha256_hex(md5_hex(pw) + randomCode)."""
    return hashlib.sha256((md5_hex(password.encode()) + code).encode()).hexdigest()


class Client:
    """One keep-alive connection, i.e. one browser tab or one device."""

    def __init__(self, host, port):
        self.host, self.port = host, port
        self.conn = http.client.HTTPConnection(host, port, timeout=30)
        self.cookie = None
        self.token = None

    def request(self, method, path, body=None, headers=None, read=True):
        h = dict(headers or {})
        if self.cookie:
            h["cookie"] = self.cookie
        if self.token:
            h["x-access-token"] = self.token
        if body is not None and "content-type" not in h:
            h["content-type"] = "application/json"
        data = json.dumps(body).encode() if isinstance(body, (dict, list)) else body
        for attempt in range(2):
            try:
                self.conn.request(method, path, body=data, headers=h)
                r = self.conn.getresponse()
                payload = r.read() if read else b""
                sc = r.getheader("set-cookie")
                if sc:
                    self.cookie = sc.split(";")[0]
                return r.status, payload
            except (http.client.HTTPException, OSError):
                # A keep-alive connection the server closed between requests.
                self.conn.close()
                self.conn = http.client.HTTPConnection(self.host, self.port, timeout=30)
                if attempt:
                    raise

    def json(self, method, path, body=None, headers=None):
        status, payload = self.request(method, path, body, headers)
        try:
            return status, json.loads(payload)
        except Exception:
            return status, {"_raw": payload[:200].decode("utf-8", "replace")}

    def login(self, account, password, equipment=None):
        _, code = self.json("POST", "/api/official/user/query/random/code", {"account": account})
        body = {"account": account, "password": challenge(password, code["randomCode"])}
        if equipment:
            body["equipmentNo"] = equipment
        path = "/api/official/user/account/login/equipment" if equipment else "/api/official/user/account/login/new"
        _, r = self.json("POST", path, body)
        if not r.get("success"):
            sys.exit(f"login failed: {r}")
        if equipment:
            self.token = r["token"]
        return r

    def elevate(self, account, password):
        _, code = self.json("POST", "/api/official/user/query/random/code", {"account": account})
        _, r = self.json("POST", "/api/admin/elevate",
                         {"password": challenge(password, code["randomCode"])})
        if not r.get("success"):
            sys.exit(f"elevate failed: {r}")


# ---- the workloads ----


def discover(c):
    """Learn the corpus: folder ids, note ids, page hashes. Done before the
    measured phase so the discovery traffic is not what gets reported (it is
    recorded too, but it is the same routes, and the counts below dwarf it)."""
    folders, notes = [], []

    def walk(parent, depth):
        _, t = c.json("GET", f"/api/controlplane/tree?parent={parent}")
        for e in t.get("entries", []):
            if e["kind"] == "folder":
                folders.append(e["id"])
                if depth < 4:
                    walk(e["id"], depth + 1)
            elif e.get("fileType") == "note":
                notes.append(e["id"])

    walk("root", 0)
    return folders, notes


# Terms chosen by measured document frequency in the seeded corpus, because an
# FTS timing is meaningless without saying how selective the query was. See the
# report: rank-1 matches ~100% of pages, the tail ~0.1%.
#
# Selectivity here is stated per ACCOUNT, but because `phase_search` sends a
# prefix term (see its docstring) what these timings actually track is the term's
# posting count across the WHOLE index, not the caller's share of it — MEASURED
# at ~30 us per whole-index posting, and linear. The classes still order
# correctly; the reason they do is not the one the
# names suggest.
SEARCH_TERMS = {
    "ubiquitous": ["reuniao"],        # ~100% of pages
    "common": ["meeting"],            # ~33%
    "mid": ["quadro"],                # ~7.7%
    "selective": ["grinelmente446"],  # ~1.7%
    "rare": ["moreagem3617"],         # ~0.3%
    "miss": ["xyzzynotaword"],        # 0% — the fuzzy-expansion fallback path
}


def phase_listing(c, folders, notes, rounds, rng):
    """Folder listings, including the root and the fullest folders."""
    for _ in range(rounds):
        c.request("GET", f"/api/controlplane/tree?parent={rng.choice(folders)}")
    for _ in range(rounds // 4):
        c.request("GET", "/api/controlplane/tree?parent=root")


def phase_bin(c, folders, notes, rounds, rng):
    """The recycle-bin listing. Its OWN phase, not part of `listing`: a gallery
    load never touches it, and folding it in would let one screen nobody opened
    dominate the cold-load arithmetic."""
    for _ in range(rounds):
        c.request("GET", "/api/controlplane/bin")


def phase_note(c, folders, notes, rounds, rng):
    """Opening notes: metadata, then the page bytes and transcripts that follow."""
    refs = []
    for _ in range(rounds):
        nid = rng.choice(notes)
        _, meta = c.json("GET", f"/api/controlplane/note/{nid}")
        pages = meta.get("pages", [])
        if pages:
            refs.append((nid, rng.choice(pages)))
    for nid, p in refs:
        c.request("GET", f"/note/{nid}/page/{p['index']}?v={p['hash']}")
        if p.get("textHash"):
            c.request("GET", f"/note/{nid}/page/{p['index']}/text?v={p['textHash']}")


def phase_search(c, folders, notes, rounds, rng, term_class="mid"):
    """Library-wide FTS at ONE selectivity, so the histogram is attributable.

    THIS IS A PREFIX BENCHMARK, and every global-search figure this script has
    ever produced is a prefix figure. The `q=` below carries NO TRAILING SPACE,
    and the server reads a trailing space as "the user finished this word"
    (`isStillTyping`, backend/services/search/query.zig); without one the last
    token becomes an FTS5 prefix term. So `q=reuniao` measures `reuniao*`, not
    `reuniao`.

    That is the RIGHT query to measure — the SPA trims on both sides of its own
    boundary, so a prefix term is the only kind a browser can send. Keep it, but
    it must not be confused with the completed-term cost, because on the Pi the
    two differ by 10.0x: 810.3 ms
    p50 here against 80.6 ms for the same page with the term completed, of which
    95% is FTS posting expansion. Any figure that came through this script is
    the left-hand number.

    Appending a space (`q=reuniao+`) would measure the other query. Do that in a
    separate class rather than by editing this one, or the historical series
    stops being comparable with itself.
    """
    terms = SEARCH_TERMS[term_class]
    for _ in range(rounds):
        c.request("GET", f"/api/controlplane/search?q={quote(rng.choice(terms))}&limit=20")


def _pct(xs, p):
    if not xs:
        return 0.0
    s = sorted(xs)
    i = min(len(s) - 1, int(round((p / 100.0) * (len(s) - 1))))
    return s[i]


def phase_notesearch(c, folders, notes, rounds, rng, term_class="mid", drain=False):
    """Find-in-note in the KEYSET-BATCHED model (Phase 2, eb87ac2).

    Each HTTP request is ONE keyset batch (default stride 20) + an optional
    `cursor`; the server holds its small db_lock window per request and RELEASES
    it between batches (client-driven drain — the fairness win). So:

      drain=False  ONE request/round = the FIRST batch = FIRST-RESULT FEEDBACK,
                   the latency the user waits for before anything is on screen.
      drain=True   loop `?cursor=` to exhaustion (the client's auto-drain), so
                   the whole note is read as N SEPARATE requests = N separate
                   bounded lock windows. Proves the fairness property: the
                   server dbLock `max` for this route is ONE batch, never the
                   whole note in one hold.

    The fuzzy fallback (a term absent from the note) is NOT batched: it returns
    complete with no cursor, i.e. exactly one request — so its whole-corpus
    vocab scan (entry 8b, still open) shows as a single long window either way.

    Client-side timing is reported here because the server histogram MERGES the
    first batch and the drain batches into one route bucket; only the client can
    separate 'time to first result' from 'per-drain-batch'."""
    terms = SEARCH_TERMS[term_class]
    first_ms, all_ms, per_round = [], [], []
    for _ in range(rounds):
        nid = rng.choice(notes)
        term = rng.choice(terms)
        cursor, n = None, 0
        while True:
            path = f"/api/controlplane/note/{nid}/search?q={quote(term)}"
            if cursor:
                path += f"&cursor={quote(cursor)}"
            t0 = time.perf_counter()
            status, payload = c.request("GET", path)
            dt = (time.perf_counter() - t0) * 1000.0
            n += 1
            all_ms.append(dt)
            if n == 1:
                first_ms.append(dt)
            if not drain:
                break
            try:
                cursor = json.loads(payload).get("cursor")
            except Exception:
                cursor = None
            if not cursor:
                break
        per_round.append(n)
    mode = "DRAINED" if drain else "first-batch only"
    print(f"  [client-side notesearch {term_class} — {mode}]")
    print(f"    time-to-first-result  p50 {_pct(first_ms,50):.1f}ms "
          f"p95 {_pct(first_ms,95):.1f}ms  max {max(first_ms):.1f}ms")
    if drain:
        print(f"    per-batch (all reqs)  p50 {_pct(all_ms,50):.1f}ms "
              f"p95 {_pct(all_ms,95):.1f}ms  max {max(all_ms):.1f}ms  "
              f"(n={len(all_ms)} reqs, {sum(per_round)} batches over {rounds} rounds; "
              f"max {max(per_round)} batches/round)")


PHASES = {
    "listing": phase_listing,
    "bin": phase_bin,
    "note": phase_note,
    "search": phase_search,
    "notesearch": phase_notesearch,
}


def device_workload(host, port, account, password, rounds, rng):
    """A device sync session: handshake, the enumeration diff, a download
    (download_v3 -> /oss/get) and an upload (apply -> /oss/put -> finish)."""
    d = Client(host, port)
    eq = "SN-BENCH-0001"
    d.login(account, password, equipment=eq)
    d.json("POST", "/api/terminal/user/bindEquipment",
           {"equipmentNo": eq, "equipmentName": "bench", "model": "N6"})

    for _ in range(rounds):
        d.request("POST", "/api/file/2/files/synchronous/start", {"equipmentNo": eq})
        d.request("POST", "/api/file/2/users/get_space_usage", {"equipmentNo": eq})
        # The enumeration diff: what the device compares its own tree against.
        d.request("POST", "/api/file/2/files/list_folder",
                  {"path": "/Note/Work", "equipmentNo": eq})
        d.request("POST", "/api/file/query/summary/hash", {"page": 1, "size": 100})
        d.request("POST", "/api/file/3/files/query_v3", {"id": "0"})
        d.request("POST", "/api/file/2/files/synchronous/end", {"equipmentNo": eq, "flag": "Y"})

    # Download path: a URL-authed /oss/get of a real multi-hundred-KB blob.
    _, listing = d.json("POST", "/api/file/2/files/list_folder",
                        {"path": "/Note/Work", "equipmentNo": eq})
    files = [e for e in listing.get("entries", []) if not e.get("isFolder")]
    for e in files[: min(len(files), rounds // 4 or 1)]:
        _, dv = d.json("POST", "/api/file/3/files/download_v3", {"id": str(e["id"])})
        if dv.get("url"):
            path = dv["url"].split("://", 1)[-1].split("/", 1)[-1]
            d.request("GET", "/" + path)

    # Upload path: apply -> /oss/put (multipart) -> finish, with real bytes.
    payload = os.urandom(512 * 1024)
    for i in range(max(rounds // 8, 3)):
        name = f"bench-upload-{i}-{rng.randrange(1 << 30)}.note"
        _, ap = d.json("POST", "/api/file/3/files/upload/apply",
                       {"path": "/Note/Inbox", "fileName": name,
                        "equipmentNo": eq, "size": len(payload)})
        if not ap.get("innerName"):
            continue
        boundary = "----bench" + str(rng.randrange(1 << 40))
        body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; "
                f"filename=\"{name}\"\r\nContent-Type: application/octet-stream\r\n\r\n"
                ).encode() + payload + f"\r\n--{boundary}--\r\n".encode()
        d.request("POST", f"/oss/put/{ap['innerName']}", body,
                  {"content-type": f"multipart/form-data; boundary={boundary}"})
        d.json("POST", "/api/file/2/files/upload/finish",
               {"content_hash": md5_hex(payload), "innerName": ap["innerName"],
                "equipmentNo": eq, "fileName": name, "path": "/Note/Inbox"})
    return d


def sse_workload(host, port, account, password, seconds):
    """Hold an SSE stream open. The point is not the stream — it is that a stream
    parked for `seconds` must contribute only microsecond-scale lock windows. If
    the events route ever regresses to the default whole-handler lock, this alone
    pins the lock for the whole duration and every other number in the run
    collapses, which is exactly the regression worth catching."""
    c = Client(host, port)
    c.login(account, password)
    h = {"cookie": c.cookie, "accept": "text/event-stream"}
    conn = http.client.HTTPConnection(host, port, timeout=seconds + 5)
    conn.request("GET", "/api/controlplane/events", headers=h)
    conn.getresponse()  # headers only; the frames are not what is being measured
    time.sleep(seconds)  # PARKED — the whole point is that the lock is not
    conn.close()


# ---- reporting ----


def fmt_ns(ns):
    if ns < 1_000:
        return f"{ns}ns"
    if ns < 1_000_000:
        return f"{ns / 1_000:.1f}us"
    if ns < 1_000_000_000:
        return f"{ns / 1_000_000:.2f}ms"
    return f"{ns / 1_000_000_000:.2f}s"


def print_report(health):
    d = health.get("dbLock")
    if not d:
        sys.exit("server reported no dbLock block — is it built with lock_stats wired in?")
    rows = sorted(d["routes"], key=lambda r: -r["p95_ns"])
    w = max(len(r["path"]) for r in rows) + 8
    print(f"\n{'route':<{w}}{'n':>8}{'p50':>10}{'p95':>10}{'max':>10}{'mean':>10}  lock")
    print("-" * (w + 50))
    for r in rows:
        label = f"{r['method']} {r['path']}"
        print(f"{label:<{w}}{r['count']:>8}{fmt_ns(r['p50_ns']):>10}"
              f"{fmt_ns(r['p95_ns']):>10}{fmt_ns(r['max_ns']):>10}"
              f"{fmt_ns(r['mean_ns']):>10}  {'manual' if r['manual'] else 'whole'}")
    held = d["total_held_ns"]
    n = d["windows"]
    print(f"\nwindows={n}  total held={fmt_ns(held)}  mean={fmt_ns(held // max(n, 1))}")
    print(f"ceiling from mean window: {1e9 / max(held / max(n, 1), 1):,.0f} windows/s")
    h = health["health"]
    if h.get("memory_bytes"):
        print(f"RSS={h['memory_bytes'] / 1e6:.1f} MB / budget {h['memory_budget_bytes'] / 1e6:.0f} MB")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=18089)
    ap.add_argument("--account", default="admin@home.lan")
    ap.add_argument("--password", default="benchpass")
    ap.add_argument("--mode", choices=["sequential", "concurrent"], default="sequential")
    ap.add_argument("--rounds", type=int, default=200)
    ap.add_argument("--clients", type=int, default=20)
    ap.add_argument("--sse-seconds", type=int, default=5)
    ap.add_argument("--phases", default="", help="comma list of " + ",".join(PHASES))
    ap.add_argument("--term-class", default="mid", choices=list(SEARCH_TERMS))
    ap.add_argument("--device", action="store_true", help="also run a device sync session")
    ap.add_argument("--drain", action="store_true",
                    help="notesearch: auto-drain the keyset cursor to exhaustion (client-driven)")
    ap.add_argument("--conns-per-client", type=int, default=6,
                    help="connections per web client (a browser opens ~6 per origin)")
    args = ap.parse_args()
    rng = random.Random(7)

    admin = Client(args.host, args.port)
    admin.login(args.account, args.password)
    folders, notes = discover(admin)
    print(f"corpus seen: {len(folders)} folders, {len(notes)} notes")
    if not notes:
        sys.exit("no notes found — seed the corpus first")

    sse = threading.Thread(target=sse_workload,
                           args=(args.host, args.port, args.account, args.password, args.sse_seconds),
                           daemon=True)
    sse.start()

    t0 = time.time()
    chosen = args.phases.split(",") if args.phases else list(PHASES)
    if args.mode == "sequential":
        for name in chosen:
            fn = PHASES[name]
            kw = {"term_class": args.term_class} if name in ("search", "notesearch") else {}
            if name == "notesearch":
                kw["drain"] = args.drain
            fn(admin, folders, notes, args.rounds, rng, **kw)
            print(f"  phase {name} done ({time.time() - t0:.1f}s)")
        if args.device:
            device_workload(args.host, args.port, args.account, args.password,
                            max(args.rounds // 4, 4), rng)
            print(f"  phase device done ({time.time() - t0:.1f}s)")
    else:
        # A BROWSER, not a socket. Chrome opens ~6 connections per origin and
        # fans a cold gallery load across them, so one "client" here is six
        # connections — which is the whole reason 12 web clients can demand 70+
        # sockets against a cap of 32. Modelling a client as one connection would
        # measure a load the household never generates.
        conns_per_client = args.conns_per_client
        errors = []
        refused = []
        # Share ONE session cookie. Every client is 127.0.0.1 here and the login
        # route is IP-rate-limited (10/min), so 20 real logins would measure the
        # rate limiter rather than the lock. The server resolves the caller per
        # request either way, so sharing a session changes nothing it does.
        cookie = admin.cookie  # the session `discover` already established

        def one(i):
            r = random.Random(i)
            socks = []
            try:
                for k in range(conns_per_client):
                    c = Client(args.host, args.port)
                    c.cookie = cookie
                    socks.append(c)
                # Hold every connection open for the whole load, exactly as a
                # browser's keep-alive pool does — the cap counts connections in
                # flight, not requests.
                phase_listing(socks[0], folders, notes, args.rounds, r)
                for k, c in enumerate(socks):
                    phase_note(c, folders, notes, max(args.rounds // 2, 2), r)
            except Exception as e:  # a refused connection is a RESULT, not a crash
                (refused if isinstance(e, (ConnectionError, OSError)) else errors).append(repr(e))
            finally:
                for c in socks:
                    try:
                        c.conn.close()
                    except Exception:
                        pass

        ts = [threading.Thread(target=one, args=(i,)) for i in range(args.clients)]
        for t in ts:
            t.start()
        for t in ts:
            t.join()
        total = args.clients * conns_per_client
        print(f"{args.clients} clients x {conns_per_client} connections = {total} sockets "
              f"against max_connections; refused={len(refused)} other_errors={len(errors)}")
        if errors:
            print(f"  first errors: {errors[:3]}")
    wall = time.time() - t0
    sse.join(timeout=args.sse_seconds + 5)

    admin.elevate(args.account, args.password)
    _, health = admin.json("GET", "/api/admin/health")
    print_report(health)
    print(f"wall clock: {wall:.1f}s")


if __name__ == "__main__":
    main()
