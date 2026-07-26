#!/usr/bin/env python3
"""Seed a .note into a user's file tree + blob store so a synced device sees a
file it LACKS and downloads it — the setup for capturing the (still-unobserved)
M2 download path (`download_v3` -> `/oss/get`).

It writes `inkhold.db` and `<data-dir>/blobs/` DIRECTLY (no server, no Zig
build), mirroring what the Files service + BlobStore would produce:
  - copies the bytes to  <data-dir>/blobs/<md5[:2]>/<md5>   (BlobStore layout)
  - upserts a `blobs` row (md5, size, refcount)
  - ensures the destination folders exist, then inserts/updates the `files` row
  - bumps `sync_state.version` so the device + control-plane see the change

Run with the server STOPPED (avoids WAL write contention). Idempotent-ish: a
re-run updates the same file row rather than duplicating it.

Usage:
  scripts/seed_note.py <note-file> [--email nomad@home.lan] [--db inkhold.db]
                       [--data-dir data] [--dest /NOTE/Note/]
"""
import argparse
import hashlib
import os
import shutil
import sqlite3
import sys
import time


def main() -> None:
    ap = argparse.ArgumentParser(description="Seed a .note for M2 download capture.")
    ap.add_argument("note", help="path to the .note file to seed")
    ap.add_argument("--email", default="nomad@home.lan", help="owning user's email")
    ap.add_argument("--db", default="inkhold.db")
    ap.add_argument("--data-dir", default="data")
    ap.add_argument("--dest", default="/NOTE/Note/", help="device folder to place it in")
    ap.add_argument("--name", default=None, help="filename to store as (default: source basename)")
    args = ap.parse_args()

    if not os.path.isfile(args.note):
        sys.exit(f"no such file: {args.note}")
    if not os.path.isfile(args.db):
        sys.exit(f"no db at {args.db} — start the server once to create it, then stop it")

    raw = open(args.note, "rb").read()
    md5 = hashlib.md5(raw).hexdigest()
    size = len(raw)
    name = args.name or os.path.basename(args.note)
    now = int(time.time())
    print(f"file={name}  size={size}  md5={md5}")

    # 1) BlobStore layout: <data-dir>/blobs/<md5[:2]>/<md5>
    blob_dir = os.path.join(args.data_dir, "blobs", md5[:2])
    os.makedirs(blob_dir, exist_ok=True)
    blob_path = os.path.join(blob_dir, md5)
    shutil.copyfile(args.note, blob_path)
    print(f"blob -> {blob_path}")

    db = sqlite3.connect(args.db)
    db.execute("PRAGMA foreign_keys = ON;")
    cur = db.cursor()

    row = cur.execute("SELECT id FROM users WHERE email = ?", (args.email,)).fetchone()
    if not row:
        sys.exit(f"no user with email {args.email!r} — onboard it first (must_change_password=0)")
    uid = row[0]

    # 2) ensure the destination folder chain exists; walk to the leaf parent_id.
    parent = None
    for seg in [s for s in args.dest.strip("/").split("/") if s]:
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
            print(f"  + folder {seg} (id={parent})")

    # 3) blob row (content-addressed; leave an existing one's refcount alone).
    cur.execute(
        "INSERT INTO blobs(md5, size, refcount, created_at) VALUES(?, ?, 1, ?)"
        " ON CONFLICT(md5) DO NOTHING",
        (md5, size, now),
    )

    # 4) the file row — update in place if it already exists (unique live name).
    existing = cur.execute(
        "SELECT id FROM files WHERE user_id = ? AND COALESCE(parent_id, 0) = COALESCE(?, 0)"
        " AND name = ? AND deleted = 0",
        (uid, parent, name),
    ).fetchone()
    if existing:
        fid = existing[0]
        cur.execute(
            "UPDATE files SET md5 = ?, size = ?, is_folder = 0, updated_at = ? WHERE id = ?",
            (md5, size, now, fid),
        )
        print(f"  ~ updated file id={fid}")
    else:
        cur.execute(
            "INSERT INTO files(user_id, parent_id, name, is_folder, md5, size, created_at, updated_at, deleted)"
            " VALUES(?, ?, ?, 0, ?, ?, ?, ?, 0)",
            (uid, parent, name, md5, size, now, now),
        )
        fid = cur.lastrowid
        print(f"  + inserted file id={fid}")

    # 5) bump the user's sync-version so device + control-plane notice.
    cur.execute(
        "INSERT INTO sync_state(user_id, version) VALUES(?, 1)"
        " ON CONFLICT(user_id) DO UPDATE SET version = version + 1",
        (uid,),
    )
    ver = cur.execute("SELECT version FROM sync_state WHERE user_id = ?", (uid,)).fetchone()[0]

    db.commit()
    db.close()
    print(f"\nseeded file id={fid} at {args.dest}{name} for user {uid} (sync_state.version={ver}).")
    print("next: start the passthrough server, sync the device, and watch for")
    print("  POST /api/file/3/files/download_v3   then   GET /oss/get/... (matched=real vs stub)")


if __name__ == "__main__":
    main()
