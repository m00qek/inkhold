#!/bin/sh
# Runs a release archive on its own architecture: the version it reports, a
# fresh install that starts and serves the browser app, and a clean stop.
#
#   scripts/smoke-archive.sh ARCHIVE VERSION [EMULATOR...]
#
# EMULATOR runs a foreign binary, e.g. `qemu-arm-static -cpu arm1176` for the
# Pi 1's ARMv6. It proves the binary runs there, not how fast.
set -eu

archive=$(realpath "$1")
version=$2
shift 2
emulator="$*"
# Unquoted on purpose: empty runs the binary itself, else splits into words.
run() { $emulator "$@"; }

dir=$(mktemp -d)
trap 'kill "$pid" 2>/dev/null || true; rm -rf "$dir"' EXIT
cd "$dir"
tar -xzf "$archive"

got=$(run ./inkhold --version)
[ "$got" = "inkhold $version" ] || { echo "--version says '$got', want 'inkhold $version'" >&2; exit 1; }
echo "ok   --version: $got"

# A port of its own, and one nothing else answers on: a stray server there would
# answer for this one.
port=$((20000 + $$ % 20000))
if curl -s -o /dev/null "http://127.0.0.1:$port/"; then echo "port $port is taken" >&2; exit 1; fi
printf '.{ .host = "127.0.0.1", .port = %s, .db_path = "%s/inkhold.db", .cred_key_path = "%s/cred.key", .data_dir = "%s/data", .web_dir = "%s/webapp/dist", .admin_email = "admin@home.lan" }\n' \
  "$port" "$dir" "$dir" "$dir" "$dir" > config.zon
# Not through `run`: in the background that would be a subshell, and SIGTERM
# below must reach the server itself.
$emulator ./inkhold --config=config.zon serve 2> server.log &
pid=$!

# Emulated, the first start is slow: up to two minutes.
i=0
until grep -q "listening on" server.log; do
  i=$((i + 1))
  kill -0 "$pid" 2>/dev/null || { cat server.log >&2; echo "the server exited" >&2; exit 1; }
  [ "$i" -lt 240 ] || { cat server.log >&2; echo "the server did not start" >&2; exit 1; }
  sleep 0.5
done
echo "ok   started"

curl -fsS "http://127.0.0.1:$port/" | grep -q "<title>" || { echo "/ is not the browser app" >&2; exit 1; }
curl -fsS -o /dev/null "http://127.0.0.1:$port/sw.js" || { echo "/sw.js is missing" >&2; exit 1; }
echo "ok   serves the browser app"

kill -TERM "$pid"
i=0
while kill -0 "$pid" 2>/dev/null; do
  i=$((i + 1))
  [ "$i" -lt 40 ] || { echo "did not stop within 20 s of SIGTERM" >&2; exit 1; }
  sleep 0.5
done
wait "$pid" && code=0 || code=$?
[ "$code" = 0 ] || { cat server.log >&2; echo "exit code $code after SIGTERM" >&2; exit 1; }
echo "ok   stops cleanly"
