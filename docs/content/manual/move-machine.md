---
title: "Move Inkhold to a new machine"
description: "Move the library, accounts and devices to another computer."
weight: 2080
extra:
  reader: operator
  type: how-to
---

# Move Inkhold to a new machine

Move the whole library (notebooks, accounts, settings) to another computer.
It is a backup on the old machine and a restore on the new one.

1. **Back up each tablet.** The new server is a new library to the tablets
   (step 6).
2. On the old machine, take a backup that includes `cred.key`, so everyone
   keeps their password:

   ```sh
   inkhold --config=/etc/inkhold/config.zon backup create /mnt/move --include-cred-key
   ```

3. Stop Inkhold on the old machine, so nothing changes after the backup.
4. On the new machine, [install Inkhold](@/get-inkhold.md) but don't start it.
   Make the backup folder reachable there: copy it, or mount the same NAS share.
5. Restore, then start the server:

   ```sh
   inkhold --config=/etc/inkhold/config.zon restore /mnt/move
   sudo systemctl start inkhold
   ```

6. If the address changed, log each tablet out (**Settings → My Account → Log
   out**) and [sign it in](@/manual/point-supernote.md) at the new one. Either way, each tablet
   notices the restored library at its next sign-in and syncs from scratch,
   uploading what the server lacks rather than deleting anything. If it asks
   how to treat its digest and to-do data, choose **Retain locally**.

Then delete the backup folder you made for the move, or keep it as a backup.
`cred.key` is in it: keep it as private as the notebooks.
