#!/usr/bin/env python3
"""The server's memory footprint, pinned.

Starts a ReleaseSafe `inkhold serve` on a temp config, holds N keep-alive
sockets, and reads `/proc/<pid>/status`. Fails when a number crosses its
ceiling. The ceilings below carry headroom over the measured value; raise one
only with a note here saying what bought the bytes (as `precompress.mjs` does
for the web bundle).

    make footprint            # builds, then measures
    scripts/footprint.py BIN  # measures an existing binary

It then seeds a library at two sizes and runs `inkhold backup create` beside
the serving server, pinning the backup's memory (and that it does not grow
with the library) and the server's latency and memory meanwhile.

Numbers are x86_64 Linux. They stand in for the Pi (one core, ARMv6): the
structure they pin (threads do not grow with sockets) is the same there; the
absolute values are a proxy until a Pi runner exists.
"""
import os, re, shutil, signal, socket, subprocess, sys, tempfile, time

# ---- ceilings (KB unless noted) ----------------------------------------------
# Measured 2026-11-04 after the poller/worker transport: idle RssAnon 2,996 KB
# with 7 threads; 60 parked sockets +2,696 KB (45 KB each); threads unchanged.
IDLE_ANON_MAX_KB = 6_000
PER_SOCKET_MAX_KB = 80
HELD_SOCKETS = 64
HELD_THREADS_MAX = 12          # main + 4 workers + poller + deferred worker, plus slack
TOTAL_ANON_MAX_KB = 16_000     # idle + 64 sockets, under the ~50 MB budget with room for work

# ---- backup ceilings (DESIGN.md §2.6) ------------------------------------------
# `inkhold backup create` runs beside the server. Its memory must not depend on
# the library's size, and the server must not notice it.
BACKUP_ANON_MAX_KB = 4_096     # the 4 MB target: SQLite cache 1 MB/connection, ~420 KB scratch
BACKUP_DRIFT_MAX_KB = 512      # small library vs large: equal within noise, or it is not O(1)
BACKUP_SMALL, BACKUP_LARGE = 100, 2_000   # blobs
BLOB_BYTES = 16 * 1024
LATENCY_FACTOR = 2.0           # server p50 during a backup vs idle ...
LATENCY_SLACK_MS = 2.0         # ... plus this much, since idle p50 is a fraction of a ms
SERVER_DRIFT_MAX_KB = 512      # the server's own anon memory across a backup

# ---- stopping (http/shutdown.zig) ----------------------------------------------
STOP_MAX_S = 2.0               # SIGTERM to exit, idle; podman SIGKILLs at 10 s

def status(pid):
    out = {}
    for line in open(f"/proc/{pid}/status"):
        k, _, v = line.partition(":")
        out[k] = v.split()[0] if v.split() else ""
    return int(out["RssAnon"]), int(out["Threads"]), int(out["VmRSS"])

def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]

def request(sock, line):
    sock.sendall(line)
    buf = b""
    while b"\r\n\r\n" not in buf:
        buf += sock.recv(65536)
    head, _, body = buf.partition(b"\r\n\r\n")
    n = int(re.search(rb"content-length: (\d+)", head, re.I).group(1))
    while len(body) < n:
        body += sock.recv(65536)
    return head

def anon_kb(pid):
    try:
        for line in open(f"/proc/{pid}/status"):
            if line.startswith("RssAnon:"):
                return int(line.split()[1])
    except FileNotFoundError:
        pass
    return 0

def seed(d, first, count):
    """Adds `count` blobs (half compressible text, half noise) with their rows."""
    import hashlib, random, sqlite3
    rnd = random.Random(first)
    db = sqlite3.connect(os.path.join(d, "inkhold.db"), timeout=10)
    for i in range(first, first + count):
        if i % 2:
            body = (f"page {i} of a notebook, strokes and words " * 400).encode()[:BLOB_BYTES]
        else:
            body = rnd.randbytes(BLOB_BYTES)
        md5 = hashlib.md5(body).hexdigest()
        fan = os.path.join(d, "data", "blobs", md5[:2])
        os.makedirs(fan, exist_ok=True)
        with open(os.path.join(fan, md5), "wb") as f:
            f.write(body)
        db.execute("INSERT OR IGNORE INTO blobs(md5, size, refcount, created_at) VALUES(?, ?, 1, 0)", (md5, len(body)))
    db.commit()
    db.close()

def p50_ms(port, n=200):
    """Median latency of a cheap request on a fresh keep-alive socket."""
    s = socket.create_connection(("127.0.0.1", port))
    times = []
    for _ in range(n):
        t = time.perf_counter()
        request(s, b"GET /api/version HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n\r\n")
        times.append((time.perf_counter() - t) * 1000)
    s.close()
    times.sort()
    return times[len(times) // 2]

def backup_run(binary, cfg, out_dir, port, rate):
    """Runs `backup create`, sampling its RssAnon; returns (peak KB, server p50 ms meanwhile)."""
    os.makedirs(out_dir, exist_ok=True)
    proc = subprocess.Popen([binary, f"--config={cfg}", "backup", "create", out_dir, f"--max-rate={rate}"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    peak, lat = 0, []
    s = socket.create_connection(("127.0.0.1", port))
    while proc.poll() is None:
        peak = max(peak, anon_kb(proc.pid))
        t = time.perf_counter()
        request(s, b"GET /api/version HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n\r\n")
        lat.append((time.perf_counter() - t) * 1000)
        time.sleep(0.005)
    s.close()
    err = proc.stderr.read().decode()
    if proc.returncode != 0:
        sys.exit(f"backup create failed ({proc.returncode}): {err}")
    lat.sort()
    return peak, (lat[len(lat) // 2] if lat else 0.0)

def main():
    # Absolute, since the server runs with the temp dir as its cwd.
    binary = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else "zig-out/bin/inkhold")
    port = free_port()
    with tempfile.TemporaryDirectory(prefix="inkhold-footprint-") as d:
        cfg = os.path.join(d, "config.zon")
        with open(cfg, "w") as f:
            f.write(f'.{{ .host = "127.0.0.1", .port = {port}, .db_path = "{d}/inkhold.db", '
                    f'.cred_key_path = "{d}/cred.key", .data_dir = "{d}/data", .web_dir = "" }}\n')
        proc = subprocess.Popen([binary, f"--config={cfg}", "serve"], cwd=d,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            for _ in range(100):
                try:
                    socket.create_connection(("127.0.0.1", port), timeout=0.2).close()
                    break
                except OSError:
                    time.sleep(0.1)
            else:
                sys.exit("server did not come up")
            time.sleep(0.5)
            idle_anon, idle_threads, idle_rss = status(proc.pid)

            socks = [socket.create_connection(("127.0.0.1", port)) for _ in range(HELD_SOCKETS)]
            for s in socks:
                request(s, b"GET /api/version HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n\r\n")
            time.sleep(0.5)
            held_anon, held_threads, held_rss = status(proc.pid)
            for s in socks:
                s.close()
            time.sleep(1.0)
            after_anon, after_threads, _ = status(proc.pid)

            # A backup beside the serving server, at two library sizes; into a
            # directory of its own, since one inside the live data is refused.
            bdir = tempfile.mkdtemp(prefix="inkhold-footprint-backup-")
            idle_p50 = p50_ms(port)
            server_before = anon_kb(proc.pid)
            seed(d, 0, BACKUP_SMALL)
            # Both at the default pace, so the sampler sees each run's steady state:
            # an unpaced small run ends between samples and reads low.
            small_peak, _ = backup_run(binary, cfg, os.path.join(bdir, "small"), port, "4M")
            seed(d, BACKUP_SMALL, BACKUP_LARGE - BACKUP_SMALL)
            large_peak, busy_p50 = backup_run(binary, cfg, os.path.join(bdir, "large"), port, "4M")
            server_after = anon_kb(proc.pid)
            shutil.rmtree(bdir, ignore_errors=True)

            # SIGTERM stops it: promptly, exit 0, the WAL checkpointed away.
            t = time.perf_counter()
            proc.send_signal(signal.SIGTERM)
            try:
                stop_code = proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                stop_code = None
            stop_s = time.perf_counter() - t
            wal = os.path.join(d, "inkhold.db-wal")
            wal_bytes = os.path.getsize(wal) if os.path.exists(wal) else 0
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait()

    per_socket = (held_anon - idle_anon) / HELD_SOCKETS
    rows = [
        ("idle RssAnon", f"{idle_anon} KB", idle_anon <= IDLE_ANON_MAX_KB, f"<= {IDLE_ANON_MAX_KB}"),
        (f"RssAnon with {HELD_SOCKETS} sockets", f"{held_anon} KB", held_anon <= TOTAL_ANON_MAX_KB, f"<= {TOTAL_ANON_MAX_KB}"),
        ("per parked socket", f"{per_socket:.0f} KB", per_socket <= PER_SOCKET_MAX_KB, f"<= {PER_SOCKET_MAX_KB}"),
        (f"threads with {HELD_SOCKETS} sockets", f"{held_threads}", held_threads <= HELD_THREADS_MAX, f"<= {HELD_THREADS_MAX}"),
        ("threads after close", f"{after_threads}", after_threads <= idle_threads, f"<= idle ({idle_threads})"),
    ]
    latency_ceiling = max(idle_p50 * LATENCY_FACTOR, idle_p50 + LATENCY_SLACK_MS)
    drift = abs(large_peak - small_peak)
    rows += [
        (f"backup RssAnon, {BACKUP_SMALL} blobs", f"{small_peak} KB", small_peak <= BACKUP_ANON_MAX_KB, f"<= {BACKUP_ANON_MAX_KB}"),
        (f"backup RssAnon, {BACKUP_LARGE} blobs", f"{large_peak} KB", large_peak <= BACKUP_ANON_MAX_KB, f"<= {BACKUP_ANON_MAX_KB}"),
        ("backup memory vs library size", f"{drift} KB", drift <= BACKUP_DRIFT_MAX_KB, f"<= {BACKUP_DRIFT_MAX_KB} apart"),
        ("server p50 during a backup", f"{busy_p50:.2f} ms", busy_p50 <= latency_ceiling, f"<= {latency_ceiling:.2f} (idle {idle_p50:.2f})"),
        ("server RssAnon across a backup", f"{server_after - server_before:+d} KB", server_after - server_before <= SERVER_DRIFT_MAX_KB, f"<= +{SERVER_DRIFT_MAX_KB}"),
        ("SIGTERM to exit", f"{stop_s:.2f} s, code {stop_code}", stop_code == 0 and stop_s <= STOP_MAX_S, f"<= {STOP_MAX_S}, code 0"),
        ("WAL left after stopping", f"{wal_bytes} B", wal_bytes == 0, "0 (checkpointed)"),
    ]
    ok = True
    for name, value, passed, ceiling in rows:
        ok &= passed
        print(f"{'ok  ' if passed else 'FAIL'} {name:<32} {value:>12}   ceiling {ceiling}")
    print(f"     (VmRSS idle {idle_rss} KB, with sockets {held_rss} KB; anon after close {after_anon} KB)")
    sys.exit(0 if ok else 1)

if __name__ == "__main__":
    main()
