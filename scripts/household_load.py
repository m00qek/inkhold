#!/usr/bin/env python3
"""A busy evening in one household, against a real server.

Starts a ReleaseSafe `inkhold serve` on a temporary install, signs in four
people through the real login challenge (the first-run admin creates the
other three), gives each a library of real notebooks, a PDF and text files,
then for `--seconds` simulates them all at once:

  - four people browsing: each holds the live-update stream open, as a
    browser tab does, and keeps listing folders, opening a note and reading
    a few pages, looking at thumbnails, downloading a PDF and refreshing
    search; a second or two of thinking between clicks;
  - two tablets syncing: each uploads a new notebook every ~15 s, which also
    gives the server's deferred worker indexing to do meanwhile.

Every notebook is unique: each copy gets its own `FILE_ID` (a fixed-length
header tag, so no offset moves), so the server parses, scans and thumbnails
every one, as it would a real sync. The evening starts once the server has
finished indexing the libraries (CPU quiet), and that time is reported too.

It reports latency per kind of request, errors, and the server's peak memory,
CPU and threads. Not a CI gate: timings depend on the machine. Measure a Pi
from another machine (`--ssh`): a load generator on the same single core
would compete with the server it is measuring.

    zig build -Doptimize=ReleaseSafe
    scripts/household_load.py zig-out/bin/inkhold [--seconds 60] [--people 4] [--think 0]
    scripts/household_load.py --ssh devlab-pi1bplus --remote-binary inkhold-load/inkhold
    scripts/household_load.py --ssh devlab-pi1bplus --attach 8080 --admin EMAIL:PASSWORD \
        --seconds 900 --stop-file /tmp/stop-load

`--url HOST:PORT --first-password PW` loads a fresh install started somewhere
this script cannot reach by ssh: a devlab job on a Pi (scripts/pi-load.sh runs
the whole thing). Memory then comes from the admin health endpoint, the CPU
from the job's own accounting, and indexing gets a fixed `--settle` time.

`--attach` loads a server that is already running there (say, one a real tablet
syncs with) instead of a fresh install: it never stops it or deletes anything.
The admin's own library is browsed as it is and gets no seeded files, so
nothing new syncs down to that account's tablet; the other people are created
fresh, with names unique to the run. `--stop-file` ends the evening early
once that local file exists (e.g. after a real tablet finished syncing).
"""
import argparse, base64, hashlib, http.client, json, os, random, re, socket, ssl, subprocess, sys, tempfile, threading, time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
NOTES = [os.path.join(ROOT, "parsers/note/tests/fixtures", n) for n in
         ("sample.note", "sample-2.note", "layers_edited.note", "horizontal_layers.note", "one_thumb.note")]
PDF = os.path.join(ROOT, "backend/pdf/testdata/text-120-page.pdf")
TABLETS = 2
UPLOAD_EVERY_S = 15.0
THINK_S = (0.7, 2.0)  # a person between clicks; `--think 0` is a stress test

def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]

# ---- one person's HTTP session ---------------------------------------------

class Session:
    def __init__(self, host, port, stats, name):
        self.host, self.port, self.stats, self.name, self.cookie = host, port, stats, name, None
        self.conn = connect(host, port)

    def call(self, method, path, body=None, headers=None, kind=None, record=True):
        h = dict(headers or {})
        if self.cookie:
            h["Cookie"] = self.cookie
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
            h["Content-Type"] = "application/json"
        t = time.perf_counter()
        for attempt in (0, 1):
            try:
                self.conn.request(method, path, body=body, headers=h)
                r = self.conn.getresponse()
                data = r.read()
                break
            except (http.client.HTTPException, OSError):
                # A keep-alive the server closed (idle timeout): one fresh retry, as a browser would.
                self.conn.close()
                self.conn = connect(self.host, self.port)
                if attempt:
                    raise
        ms = (time.perf_counter() - t) * 1000
        sc = r.getheader("Set-Cookie")
        if sc:
            m = re.search(r"(sn_session=[^;]+)", sc) or re.search(r"([^=;\s]+=[^;]+)", sc)
            if m:
                self.cookie = m.group(1)
        if record and kind:
            self.stats.add(kind, ms, r.status)
        return r.status, data

    def json(self, method, path, body=None, kind=None):
        st, data = self.call(method, path, body, kind=kind)
        return st, (json.loads(data) if data and data[:1] in (b"{", b"[") else None)

_FILE_ID = re.compile(rb"<FILE_ID:([^>]+)>")

def unique_note(data, n):
    """The notebook with a new `FILE_ID` of the same length: a distinct blob the
    server must index, every offset in the file unchanged."""
    m = _FILE_ID.search(data)
    assert m, "no FILE_ID in sample"
    old = m.group(1)
    tag = f"{n:x}".encode()
    new = (old[: len(old) - len(tag)] + tag) if len(tag) < len(old) else tag[-len(old):]
    return data[: m.start(1)] + new + data[m.end(1):]

def challenge(md5_pw, code):
    return hashlib.sha256((md5_pw + code).encode()).hexdigest()

def md5h(s):
    return hashlib.md5(s.encode()).hexdigest()

def log_in(host, port, stats, email, password):
    """An existing account's sign-in, no password change."""
    s = Session(host, port, stats, email)
    _, r = s.json("POST", "/api/official/user/query/random/code", {"account": email})
    st, _ = s.json("POST", "/api/official/user/account/login/new", {"account": email, "password": challenge(md5h(password), r["randomCode"])})
    assert st == 200, f"login {email}: {st}"
    return s

def sign_in(host, port, stats, email, temp, final):
    s = Session(host, port, stats, email)
    _, r = s.json("POST", "/api/official/user/query/random/code", {"account": email})
    st, _ = s.json("POST", "/api/official/user/account/login/new", {"account": email, "password": challenge(md5h(temp), r["randomCode"])})
    assert st == 200, f"login {email}: {st}"
    st, _ = s.json("PUT", "/api/user/password", {"currentPassword": md5h(temp), "newPassword": md5h(final)})
    assert st == 200, f"password change {email}: {st}"
    return s

THINK_SCALE = 1.0

# Set by `--tls`: the client side of HTTPS. The server's certificate is
# self-signed, so it is not verified; this measures cost, not trust.
TLS_CTX = None

def connect(host, port, timeout=30):
    if TLS_CTX:
        return http.client.HTTPSConnection(host, port, timeout=timeout, context=TLS_CTX)
    return http.client.HTTPConnection(host, port, timeout=timeout)

def upload(s, name, data, kind="upload"):
    b = "----inkhold" + os.urandom(8).hex()
    body = (f"--{b}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\n"
            f"Content-Type: application/octet-stream\r\n\r\n").encode() + data + f"\r\n--{b}--\r\n".encode()
    st, _ = s.call("POST", "/api/controlplane/folder/root/upload", body,
                   {"Content-Type": f"multipart/form-data; boundary={b}"}, kind=kind)
    return st

# ---- what a run records --------------------------------------------------------

class Stats:
    def __init__(self):
        self.lock = threading.Lock()
        self.ms, self.errors, self.missing = {}, {}, {}

    def add(self, kind, ms, status):
        with self.lock:
            self.ms.setdefault(kind, []).append(ms)
            if status == 404:  # a file with no thumbnail answers 404: counted apart, not an error
                self.missing[kind] = self.missing.get(kind, 0) + 1
            elif status >= 400:
                self.errors[kind] = self.errors.get(kind, 0) + 1

def pct(xs, p):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(len(xs) * p))] if xs else 0.0

def parse_sample(status_text, stat_text):
    out = {}
    for line in status_text.splitlines():
        k, _, v = line.partition(":")
        if k in ("RssAnon", "VmRSS", "Threads"):
            out[k] = int(v.split()[0])
    st = stat_text.rsplit(")", 1)[1].split()
    out["cpu_ticks"] = int(st[11]) + int(st[12])  # utime + stime
    return out

class Server:
    """`inkhold serve` on a temp install, here or on `ssh` host."""

    def __init__(self, binary, ssh, remote_binary, port, tls=None, suites=(), attach=False, url=None, settle=180,
                 go_file=None):
        """`tls`: (cert.pem, key.pem) paths here, sent along when remote.
        `attach`: use the server already listening on `port` on `ssh`; never stop it.
        `url`: a fresh install already started at HOST:PORT, out of ssh's reach."""
        self.ssh, self.port, self.attached = ssh, port, attach
        self.url, self.settle, self.health, self.go_file = url, settle, None, go_file
        if url:
            self.host, port_s = url.rsplit(":", 1)
            self.port = int(port_s)
            self.ticks = 1
            self.last = {"RssAnon": 0, "VmRSS": 0, "Threads": 0, "cpu_ticks": 0}
            return
        if attach:
            assert ssh, "--attach needs --ssh"
            self.host = subprocess.check_output(["ssh", "-G", ssh], text=True).split("\nhostname ")[1].split()[0]
            # The process that owns the listening port, not a name match: a
            # pattern can also match the ssh command that runs it.
            pids = subprocess.check_output(["ssh", "-o", "BatchMode=yes", ssh,
                                            f"ss -Hltnp 'sport = :{port}' | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u"], text=True).split()
            assert len(pids) == 1, f"expected one process on port {port}, found {pids}"
            self.pid = int(pids[0])
            self.ticks = int(subprocess.check_output(["ssh", "-o", "BatchMode=yes", ssh, "getconf CLK_TCK"]))
            return
        tls_cfg = ""
        if tls:
            names = ", ".join(f'"{x}"' for x in suites)
            tls_cfg = f', .tls = .{{ .enabled = true, .cert_path = "cert.pem", .key_path = "key.pem", .cipher_suites = .{{ {names} }} }}'
        pems = [base64.b64encode(open(f, "rb").read()).decode() for f in tls] if tls else []
        self.host = "127.0.0.1"
        if ssh:
            self.host = subprocess.check_output(["ssh", "-G", ssh], text=True).split("\nhostname ")[1].split()[0]
            d = f"inkhold-load-{port}"
            cfg = (f'.{{ .host = "0.0.0.0", .port = {port}, .db_path = "inkhold.db", .cred_key_path = "cred.key", '
                   f'.data_dir = "data", .web_dir = "", .admin_email = "ana@home.lan"{tls_cfg} }}')
            certs = (f"echo {pems[0]} | base64 -d > cert.pem && echo {pems[1]} | base64 -d > key.pem && ") if tls else ""
            # `exec` keeps the pid we echo; the first-run banner comes back on stderr.
            cmd = (f"rm -rf {d} && mkdir -p {d} && cd {d} && {certs}printf '%s\\n' '{cfg}' > c.zon && "
                   f"echo $$ && exec $HOME/{remote_binary} --config=c.zon serve")
            self.proc = subprocess.Popen(["ssh", "-o", "BatchMode=yes", ssh, cmd],
                                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            self.pid = int(self.proc.stdout.readline())
            self.dir = d
            self.ticks = int(subprocess.check_output(["ssh", "-o", "BatchMode=yes", ssh, "getconf CLK_TCK"]))
        else:
            self.tmp = tempfile.TemporaryDirectory(prefix="inkhold-load-")
            d = self.tmp.name
            if tls:
                for name, pem in zip(("cert.pem", "key.pem"), pems):
                    open(os.path.join(d, name), "wb").write(base64.b64decode(pem))
            with open(os.path.join(d, "config.zon"), "w") as f:
                f.write(f'.{{ .host = "127.0.0.1", .port = {port}, .db_path = "{d}/inkhold.db", '
                        f'.cred_key_path = "{d}/cred.key", .data_dir = "{d}/data", .web_dir = "", '
                        f'.admin_email = "ana@home.lan"{tls_cfg} }}\n')
            self.proc = subprocess.Popen([binary, f"--config={d}/config.zon", "serve"], cwd=d,
                                         stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
            self.pid = self.proc.pid
            self.ticks = os.sysconf("SC_CLK_TCK")

    def first_run_password(self):
        temp = None
        for line in self.proc.stderr:
            m = re.search(r"temporary password: (\S+)", line)
            if m:
                temp = m.group(1)
            if "listening on" in line:
                break
        assert temp, "no first-run password"
        # Keep draining: a full pipe would block the server's next log line.
        threading.Thread(target=lambda: [None for _ in self.proc.stderr], daemon=True).start()
        for _ in range(100):
            try:
                socket.create_connection((self.host, self.port), timeout=0.5).close()
                return temp
            except OSError:
                time.sleep(0.2)
        raise SystemExit("server did not come up")

    def sample(self):
        if self.url:
            # The admin health endpoint: memory only (CPU is the job's to report).
            if self.health:
                try:
                    st, r = self.health.json("GET", "/api/admin/health", kind="health")
                    if st == 200:
                        h = r["health"]
                        self.last = {"RssAnon": (h["memory_anon_bytes"] or 0) // 1024,
                                     "VmRSS": (h["memory_bytes"] or 0) // 1024, "Threads": 0, "cpu_ticks": 0}
                except (OSError, KeyError, ValueError):
                    pass
            return dict(self.last)
        if not self.ssh:
            return parse_sample(open(f"/proc/{self.pid}/status").read(), open(f"/proc/{self.pid}/stat").read())
        out = subprocess.check_output(["ssh", "-o", "BatchMode=yes", self.ssh,
                                       f"cat /proc/{self.pid}/status; echo @@; cat /proc/{self.pid}/stat"], text=True)
        status, stat = out.split("@@\n")
        return parse_sample(status, stat)

    def wait_quiet(self, limit_s=900):
        """Until the deferred worker has indexed what arrived: CPU under 5% of a core
        for three seconds running. Returns how long that took."""
        if self.url:
            # No CPU to watch from here. With --go-file, whoever can see it (pi-load.sh,
            # through the job's accounting) says when indexing is done; else a fixed settle.
            print("seeded: waiting for indexing", flush=True)
            if not self.go_file:
                time.sleep(self.settle)
                return self.settle
            t0 = time.time()
            while not os.path.exists(self.go_file) and time.time() - t0 < limit_s:
                time.sleep(0.5)
            return time.time() - t0
        t0 = time.time()
        prev, quiet = self.sample(), 0
        while time.time() - t0 < limit_s:
            time.sleep(1.0)
            cur = self.sample()
            busy = (cur["cpu_ticks"] - prev["cpu_ticks"]) / self.ticks
            prev = cur
            quiet = quiet + 1 if busy < 0.05 else 0
            if quiet >= 3:
                return time.time() - t0 - 3
        return time.time() - t0

    def stop(self):
        if self.attached or self.url:
            return  # not ours: leave it running, with its data
        if self.ssh:
            subprocess.run(["ssh", "-o", "BatchMode=yes", self.ssh,
                            f"kill {self.pid}; sleep 1; cd && rm -rf {self.dir}"], check=False)
            self.proc.wait(timeout=30)
        else:
            self.proc.kill()
            self.proc.wait()
            self.tmp.cleanup()

# ---- the people ------------------------------------------------------------------

def browse(s, stop, rng):
    """One person clicking around their library until `stop`, asking for
    exactly what the browser asks for: byte routes are content-addressed
    (`?v=`), so the URLs come from the listing and the note's page list."""
    try:
        _browse(s, stop, rng)
    except (OSError, http.client.HTTPException):
        if not stop.is_set():
            raise

def _browse(s, stop, rng):
    while not stop.is_set():
        st, tree = s.json("GET", "/api/controlplane/tree", kind="list folder")
        entries = (tree or {}).get("entries", []) if st == 200 else []
        notes = [e for e in entries if e.get("fileType") == "note" and e.get("pageCount")]
        pdfs = [e for e in entries if e.get("fileType") == "pdf"]
        act = rng.random()
        if notes and act < 0.55:
            n = rng.choice(notes)
            _, meta = s.json("GET", f"/api/controlplane/file/metadata/{n['id']}", kind="open note")
            for pg in (meta or {}).get("pages", [])[: rng.randint(1, 4)]:
                s.call("GET", f"/note/{n['id']}/page/{pg['index']}?v={pg['hash']}", kind="note page")
        elif act < 0.75:
            # The gallery: a screenful of covers (a file with none answers 404, a glyph).
            for e in rng.sample(entries, min(6, len(entries))):
                if e.get("fileHash"):
                    s.call("GET", f"/thumbnail/{e['fileHash']}", kind="thumbnail")
        elif pdfs and act < 0.9:
            e = rng.choice(pdfs)
            s.call("GET", f"/file/{e['id']}?v={e['fileHash']}", kind="download pdf")
        else:
            s.call("GET", "/api/controlplane/search-index/manifest", kind="search manifest")
        stop.wait(rng.uniform(*THINK_S) * THINK_SCALE)

def hold_events(host, port, cookie, stop):
    """The live-update stream a browser tab keeps open."""
    try:
        c = socket.create_connection((host, port), timeout=5)
        if TLS_CTX:
            c = TLS_CTX.wrap_socket(c, server_hostname=host)
        c.sendall(f"GET /api/controlplane/events HTTP/1.1\r\nHost: x\r\nCookie: {cookie}\r\nAccept: text/event-stream\r\n\r\n".encode())
        c.settimeout(1.0)
        while not stop.is_set():
            try:
                if not c.recv(4096):
                    return
            except socket.timeout:
                pass
        c.close()
    except OSError:
        pass

_seq = [0]
_seq_lock = threading.Lock()

def next_note(rng):
    with _seq_lock:
        _seq[0] += 1
        n = _seq[0]
    return unique_note(open(rng.choice(NOTES), "rb").read(), 0x100000 + n)

def tablet(s, stop, rng, label):
    """A tablet syncing: a new notebook every so often."""
    try:
        _tablet(s, stop, rng, label)
    except (OSError, http.client.HTTPException):
        if not stop.is_set():
            raise

def _tablet(s, stop, rng, label):
    n = 0
    stop.wait(rng.uniform(0, UPLOAD_EVERY_S))
    while not stop.is_set():
        # A notebook the server has never seen: parsed, scanned, thumbnailed.
        upload(s, f"{label}-sync-{n}.note", next_note(rng), kind="tablet sync")
        n += 1
        stop.wait(UPLOAD_EVERY_S)

# ---- main --------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("binary", nargs="?", default="zig-out/bin/inkhold")
    ap.add_argument("--seconds", type=int, default=60)
    ap.add_argument("--people", type=int, default=4)
    ap.add_argument("--think", type=float, default=1.0, help="scale the pause between clicks; 0 = no pause (stress)")
    ap.add_argument("--ssh", help="run the server on this ssh host and load it from here")
    ap.add_argument("--remote-binary", default="inkhold-load/inkhold", help="its path under the remote $HOME")
    ap.add_argument("--tls", nargs=2, metavar=("CERT", "KEY"), help="serve HTTPS with this certificate and key")
    ap.add_argument("--suite", action="append", default=[], help="TLS 1.3 cipher suite to allow (repeatable)")
    ap.add_argument("--attach", type=int, metavar="PORT", help="load the server already running on --ssh at this port")
    ap.add_argument("--admin", metavar="EMAIL:PASSWORD", help="with --attach: an existing admin account")
    ap.add_argument("--stop-file", help="end the evening early once this local file exists")
    ap.add_argument("--url", metavar="HOST:PORT", help="a fresh install already started there, out of ssh's reach")
    ap.add_argument("--first-password", help="with --url: the first-run admin's temporary password")
    ap.add_argument("--settle", type=int, default=180, help="with --url: seconds to let indexing finish")
    ap.add_argument("--go-file", help="with --url: start the evening once this file exists (indexing done), not after --settle")
    a = ap.parse_args()
    global TLS_CTX
    if a.tls:
        TLS_CTX = ssl.create_default_context()
        TLS_CTX.check_hostname = False
        TLS_CTX.verify_mode = ssl.CERT_NONE
    global THINK_SCALE
    THINK_SCALE = a.think
    binary = os.path.abspath(a.binary)
    port = a.attach or (free_port() if not a.ssh else 18400)
    if a.attach and not a.admin:
        ap.error("--attach needs --admin EMAIL:PASSWORD")
    if a.url and not a.first_password:
        ap.error("--url needs --first-password")
    stats = Stats()
    rng = random.Random(7)

    srv = Server(binary, a.ssh, a.remote_binary, port, tls=a.tls, suites=a.suite, attach=bool(a.attach),
                 url=a.url, settle=a.settle, go_file=a.go_file)
    try:
        P = srv.port
        H = srv.host
        if True:
            # ---- the household -------------------------------------------------
            if a.attach:
                admin_email, admin_pw = a.admin.split(":", 1)
                people = [log_in(H, P, stats, admin_email, admin_pw)]
                suffix = f"-{int(time.time()) % 100000}"
            else:
                admin_email, admin_pw = "ana@home.lan", "ana-pw"
                temp = a.first_password if a.url else srv.first_run_password()
                people = [sign_in(H, P, stats, admin_email, temp, admin_pw)]
                suffix = ""
            admin = people[0]
            _, r = admin.json("POST", "/api/official/user/query/random/code", {"account": admin_email})
            st, _ = admin.json("POST", "/api/admin/elevate", {"password": challenge(md5h(admin_pw), r["randomCode"])})
            assert st == 200, f"elevate: {st}"
            if a.url:
                # Its own connection: http.client connections are not shared across threads.
                srv.health = Session(H, P, Stats(), "health")
                srv.health.cookie = admin.cookie
            for name in ["rui", "bia", "leo"][: a.people - 1]:
                email = f"{name}{suffix}@home.lan"
                _, created = admin.json("POST", "/api/admin/users", {"email": email})
                people.append(sign_in(H, P, stats, email, created["temporaryPassword"], f"{name}-pw"))

            # ---- their libraries: every notebook a distinct one ----------------
            # Attached, the admin's library is a real tablet's: browse it as it is.
            t_seed = time.perf_counter()
            seeded = 0
            for i, s in enumerate(people):
                if a.attach and s is admin:
                    continue
                for k, path in enumerate(NOTES * 4):
                    data = unique_note(open(path, "rb").read(), 0x1000 * (i + 1) + k)
                    assert upload(s, f"notebook-{k}.note", data, kind="seed") == 200
                    seeded += 1
                assert upload(s, "manual.pdf", open(PDF, "rb").read(), kind="seed") == 200
                for k in range(8):
                    assert upload(s, f"list-{k}.txt", f"{s.name} shopping list {k}\n".encode() * 200, kind="seed") == 200
                seeded += 9
            seed_s = time.perf_counter() - t_seed
            index_s = srv.wait_quiet()

            # ---- the evening -----------------------------------------------------
            stop = threading.Event()
            threads = []
            for s in people:
                threads.append(threading.Thread(target=hold_events, args=(H, P, s.cookie, stop), daemon=True))
                threads.append(threading.Thread(target=browse, args=(s, stop, random.Random(rng.random())), daemon=True))
            for t in range(TABLETS):
                # Its own connection and session: an http.client connection is not
                # shared between threads (sharing one stalled a request for 15 s).
                tab = Session(H, P, stats, f"tablet{t}")
                # Attached, the admin is a real tablet's account: the simulated
                # tablets sync as the others, so nothing lands on the real one.
                tab.cookie = people[t + 1 if a.attach else t].cookie
                threads.append(threading.Thread(target=tablet, args=(tab, stop, random.Random(rng.random()), f"tablet{t}"), daemon=True))
            before = srv.sample()
            peak = dict(before)
            t0 = time.time()
            for t in threads:
                t.start()
            while time.time() - t0 < a.seconds and not (a.stop_file and os.path.exists(a.stop_file)):
                time.sleep(1.0)
                cur = srv.sample()
                for k in ("RssAnon", "VmRSS", "Threads"):
                    peak[k] = max(peak[k], cur[k])
            stop.set()
            after = srv.sample()
            elapsed = time.time() - t0
            for t in threads:
                t.join(timeout=10)  # before the server goes, so nothing hits a closed port
    finally:
        srv.stop()

    cpu_pct = None if a.url else 100 * (after["cpu_ticks"] - before["cpu_ticks"]) / srv.ticks / elapsed
    total = sum(len(v) for k, v in stats.ms.items() if k != "seed")
    print(f"over {'HTTPS ' + (','.join(a.suite) or 'default suites') if a.tls else 'plain HTTP'}")
    print(f"{a.people} people browsing + {TABLETS} tablets syncing, {elapsed:.0f} s, "
          f"{total} requests ({total / elapsed:.1f}/s)")
    print(f"libraries: {seeded} files uploaded in {seed_s:.1f} s, "
          + (f"then {index_s:.0f} s to settle" if a.url and not a.go_file else f"indexed by {index_s:.0f} s later"))
    mode = "stress, no pauses" if THINK_SCALE == 0 else f"pauses x{THINK_SCALE:g}"
    print(f"({mode})")
    print(f"{'request':<18}{'count':>7}{'p50 ms':>9}{'p95 ms':>9}{'max ms':>9}{'404':>6}{'errors':>8}")
    for kind in ["list folder", "open note", "note page", "thumbnail", "download pdf", "search manifest", "tablet sync"]:
        xs = stats.ms.get(kind, [])
        print(f"{kind:<18}{len(xs):>7}{pct(xs, .5):>9.1f}{pct(xs, .95):>9.1f}{max(xs, default=0):>9.1f}{stats.missing.get(kind, 0):>6}{stats.errors.get(kind, 0):>8}")
    if a.url:
        print(f"server: RssAnon peak {peak['RssAnon']} KB (idle {before['RssAnon']}), VmRSS peak {peak['VmRSS']} KB; "
              f"CPU and peak memory: the job's own accounting")
    else:
        print(f"server: RssAnon peak {peak['RssAnon']} KB (idle {before['RssAnon']}), VmRSS peak {peak['VmRSS']} KB, "
              f"threads peak {peak['Threads']}, CPU {cpu_pct:.0f}% of one core")
    sys.exit(1 if stats.errors else 0)

if __name__ == "__main__":
    main()
