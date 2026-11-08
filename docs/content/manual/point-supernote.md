---
title: "Point your Supernote at Inkhold"
description: "Sign the tablet in to Inkhold instead of Supernote's cloud."
weight: 2110
extra:
  reader: household
  type: how-to
---

# Point your Supernote at Inkhold

Sign the tablet in to Inkhold instead of Supernote's cloud. You need Inkhold's
address, for example `http://192.168.1.20:8089`, and an Inkhold account.

1. **Copy the tablet's folders to another computer first.** Sync runs both ways,
   and Inkhold is in beta.
2. On the tablet, open **Settings → Supernote Cloud / Private Cloud**, and enter
   Inkhold's address as the server address.
3. Sign in with your Inkhold email and password.
4. If the tablet asks how to treat its digest and to-do data, choose
   **Retain locally**. **Delete locally** removes them from the tablet.
5. Sync from the tablet's top bar. Your notebooks appear in the library in the
   browser.

To sync without thinking about it, turn on **Settings → Drive → Private Cloud
→ Auto Sync**: the tablet then sends each change as you make it, and receives
what you change in the browser within a second or two.

## When the server is new or restored

Each Inkhold library has its own identity. A tablet that signs in to a new or
[restored](@/manual/restore.md) server notices, forgets what it synced before
and syncs from scratch, uploading what the server is missing rather than
deleting it. Afterwards, open **Settings → Drive → Private Cloud** again:
**Auto Sync** is off, and the folders to sync may need ticking again.

Over the internet, put Inkhold [behind HTTPS](@/manual/https.md) first. On your
home network, plain HTTP is fine.
