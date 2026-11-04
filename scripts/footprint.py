#!/usr/bin/env python3
"""The server's memory footprint, pinned.

Starts a ReleaseSafe `inkhold serve` on a temp config, holds N keep-alive
sockets, and reads `/proc/<pid>/status`. Fails when a number crosses its
ceiling. The ceilings below carry headroom over the measured value; raise one
only with a note here saying what bought the bytes (as `precompress.mjs` does
for the web bundle).

    make footprint            # builds, then measures
    scripts/footprint.py BIN  # measures an existing binary

Numbers are x86_64 Linux. They stand in for the Pi (one core, ARMv6): the
structure they pin (threads do not grow with sockets) is the same there; the
absolute values are a proxy until a Pi runner exists.
"""
import os, re, socket, subprocess, sys, tempfile, time

# ---- ceilings (KB unless noted) ----------------------------------------------
# Measured 2026-11-04 after the poller/worker transport: idle RssAnon 2,996 KB
# with 7 threads; 60 parked sockets +2,696 KB (45 KB each); threads unchanged.
IDLE_ANON_MAX_KB = 6_000
PER_SOCKET_MAX_KB = 80
HELD_SOCKETS = 64
HELD_THREADS_MAX = 12          # main + 4 workers + poller + deferred worker, plus slack
TOTAL_ANON_MAX_KB = 16_000     # idle + 64 sockets, under the ~50 MB budget with room for work

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
        finally:
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
    ok = True
    for name, value, passed, ceiling in rows:
        ok &= passed
        print(f"{'ok  ' if passed else 'FAIL'} {name:<32} {value:>12}   ceiling {ceiling}")
    print(f"     (VmRSS idle {idle_rss} KB, with sockets {held_rss} KB; anon after close {after_anon} KB)")
    sys.exit(0 if ok else 1)

if __name__ == "__main__":
    main()
