#!/bin/sh
# A household's evening on the devlab's Pi 1B+, from the laptop
# (docs/content/contributor/measure-on-a-pi.md):
#
#   scripts/pi-load.sh ARCHIVE [household_load.py options, e.g. --seconds 600]
#
# ARCHIVE is a release's armhf archive, the bytes people download. The server
# runs as a devlab job on the Pi (`devlab-target submit --tar`): its memory
# and CPU are the job's own accounting. The load comes from the NUC's
# `scratch/inkhold-builder` instance, since a job answers only the NUC: a
# generator on the Pi's one core would compete with what it measures.
#
# PI, NUC, PROJECT and BUILDER override where, as in ~/.ssh/config and Incus.
set -eu

archive=$(realpath "${1:?usage: scripts/pi-load.sh ARCHIVE [household_load.py options]}")
shift
pi=${PI:-devlab-pi1bplus}
nuc=${NUC:-devlab}
project=${PROJECT:-scratch}
builder=${BUILDER:-inkhold-builder}
port=18089
id="inkhold-load-$(date +%s)"
host=$(ssh -G "$pi" | awk '/^hostname /{print $2}')
root=$(cd "$(dirname "$0")/.." && pwd)

work=$(mktemp -d)
trap 'ssh -o BatchMode=yes "$pi" sudo -n devlab-target stop "$id" >/dev/null 2>&1 || true; rm -rf "$work"' EXIT

# The job's archive: the release's own files, and a config with paths in the
# job's working directory (its state directory, /var/lib/job-<id>).
mkdir "$work/pkg"
tar -xzf "$archive" -C "$work/pkg"
printf '.{ .host = "0.0.0.0", .port = %s, .db_path = "inkhold.db", .cred_key_path = "cred.key", .data_dir = "data", .web_dir = "webapp/dist", .admin_email = "ana@home.lan" }\n' \
  "$port" > "$work/pkg/config.zon"
tar -czf "$work/job.tar.gz" -C "$work/pkg" .

echo "== the server: job $id on $pi ($host:$port)"
ssh -o BatchMode=yes "$pi" sudo -n devlab-target submit "$id" --mem 200M --for 2h --tar inkhold \
  -- --config=config.zon serve < "$work/job.tar.gz"

# Its first-run password, from its log, once it listens.
logs=""
i=0
until printf '%s' "$logs" | grep -q "listening on"; do
  i=$((i + 1))
  [ "$i" -lt 60 ] || { printf '%s\n' "$logs"; echo "the server did not start" >&2; exit 1; }
  sleep 2
  logs=$(ssh -o BatchMode=yes "$pi" sudo -n devlab-target logs "$id" 2>&1 || true)
done
temp=$(printf '%s\n' "$logs" | sed -n 's/.*temporary password: \([^ ]*\).*/\1/p' | tail -n 1)
[ -n "$temp" ] || { echo "no first-run password in the log" >&2; exit 1; }
ssh -o BatchMode=yes "$pi" sudo -n devlab-target status "$id" | grep -E "Memory(Current|Peak)=" || true

echo "== the load: $project/$builder on $nuc"
( cd "$root" && tar -czf - scripts/household_load.py backend/pdf/testdata/text-120-page.pdf \
    parsers/note/tests/fixtures/sample.note parsers/note/tests/fixtures/sample-2.note \
    parsers/note/tests/fixtures/layers_edited.note parsers/note/tests/fixtures/horizontal_layers.note \
    parsers/note/tests/fixtures/one_thumb.note ) |
  ssh -o BatchMode=yes "$nuc" "incus exec --project $project $builder -- sh -c 'rm -rf /root/load && mkdir -p /root/load && tar -xzf - -C /root/load'"
# The evening starts once indexing is done: the job's CPU under 5% of the
# core for 3 s running (its own accounting, CPUUsageNSec), not a fixed wait.
go=/root/load/go
ssh -o BatchMode=yes "$nuc" "incus exec --project $project $builder -- python3 /root/load/scripts/household_load.py \
  --url $host:$port --first-password $temp --go-file $go $*" > "$work/load.out" 2>&1 &
gen=$!
cpu() { ssh -o BatchMode=yes "$pi" sudo -n devlab-target status "$id" | sed -n 's/^CPUUsageNSec=//p'; }
until grep -q "^seeded:" "$work/load.out" 2>/dev/null; do
  kill -0 "$gen" 2>/dev/null || break
  sleep 2
done
quiet=0
prev=$(cpu)
t_prev=$(date +%s%N)
while kill -0 "$gen" 2>/dev/null && [ "$quiet" -lt 3 ]; do
  sleep 1
  cur=$(cpu)
  t_cur=$(date +%s%N)
  # busy = CPU ns / wall ns; quiet under 5%.
  if [ $(( (cur - prev) * 100 )) -lt $(( (t_cur - t_prev) * 5 )) ]; then quiet=$((quiet + 1)); else quiet=0; fi
  prev=$cur
  t_prev=$t_cur
done
ssh -o BatchMode=yes "$nuc" "incus exec --project $project $builder -- touch $go" || true
cpu_go=$(cpu)
t_go=$(date +%s%N)
code=0
wait "$gen" || code=$?
cpu_end=$(cpu)
t_end=$(date +%s%N)
cat "$work/load.out"
# The evening alone: CPU ns over wall ns, from the job's accounting.
echo "evening CPU: $(( (cpu_end - cpu_go) * 100 / (t_end - t_go) ))% of the core (the job's accounting)"

echo "== the job's own accounting"
ssh -o BatchMode=yes "$pi" sudo -n devlab-target status "$id" | grep -E "MemoryPeak=|CPUUsageNSec=|ActiveEnterTimestamp=" || true
ssh -o BatchMode=yes "$pi" sudo -n devlab-target stop "$id" >/dev/null || true
sleep 2
ssh -o BatchMode=yes "$pi" sudo -n devlab-target result "$id" || true
exit "$code"
