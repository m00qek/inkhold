#!/bin/sh
# Runs the container image as people will: it starts, serves the browser app,
# reports its version, and stops cleanly on `docker stop`.
#
#   scripts/smoke-image.sh IMAGE VERSION
set -eu

image=$1
version=$2
name="inkhold-smoke-$$"
port=$((20000 + $$ % 20000))
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT

got=$(docker run --rm "$image" --version)
[ "$got" = "inkhold $version" ] || { echo "--version says '$got', want 'inkhold $version'" >&2; exit 1; }
echo "ok   --version: $got"

docker run -d --name "$name" -p "127.0.0.1:$port:8089" "$image" >/dev/null
i=0
until docker logs "$name" 2>&1 | grep -q "listening on"; do
  i=$((i + 1))
  [ "$(docker inspect -f '{{.State.Running}}' "$name")" = true ] || { docker logs "$name" >&2; echo "the container exited" >&2; exit 1; }
  [ "$i" -lt 60 ] || { docker logs "$name" >&2; echo "the server did not start" >&2; exit 1; }
  sleep 0.5
done
echo "ok   started"

curl -fsS "http://127.0.0.1:$port/" | grep -q "<title>" || { echo "/ is not the browser app" >&2; exit 1; }
echo "ok   serves the browser app"

docker stop -t 20 "$name" >/dev/null
code=$(docker inspect -f '{{.State.ExitCode}}' "$name")
[ "$code" = 0 ] || { docker logs "$name" >&2; echo "exit code $code after docker stop" >&2; exit 1; }
echo "ok   stops cleanly"
