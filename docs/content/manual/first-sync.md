---
title: "Your first sync"
description: "Install Inkhold, sign in, point the tablet at it, and see your notes in the browser."
weight: 1010
extra:
  reader: operator, household
  type: tutorial
---

# Your first sync

In this tutorial you start Inkhold on a computer at home, sign in from a
browser, point your Supernote at it, and see your notebooks in the library.
It takes about fifteen minutes. You need a computer that runs Docker, and your
tablet on the same network.

## 1. Copy your tablet first

Connect the tablet to a computer and copy its folders somewhere safe. Inkhold
is in beta and sync runs both ways; this copy is your way back.

## 2. Start Inkhold

On the computer that will keep your notes, run:

```sh
docker volume create inkhold
docker run -d --name inkhold -p 8089:8089 -v inkhold:/var/lib/inkhold \
  ghcr.io/m00qek/inkhold-beta:latest
docker logs inkhold
```

The last command prints a line like:

```text
Created admin 'admin@home.lan' with a temporary password: props-barbecue-lumber-wrought
```

Keep that password: it is shown only once.

## 3. Sign in from a browser

Find the computer's address on your network (`hostname -I` prints it), and
open `http://<that address>:8089`. Sign in as `admin@home.lan` with the
temporary password. Inkhold asks you to choose your own password; do that.

The library is empty: nothing has synced yet.

## 4. Point the tablet at it

On the tablet, open **Settings → Supernote Cloud / Private Cloud**. Enter
`http://<that address>:8089` as the server address and sign in with
`admin@home.lan` and your new password. If the tablet asks how to treat its
digest and to-do data, choose **Retain locally**.

## 5. Sync

Tap sync in the tablet's top bar. Back in the browser, your folders and
notebooks appear in the library as they arrive. Open one: its pages are drawn
by your browser, the same ink as on the tablet.

## What you have now

A private cloud for your Supernote, in your home. From here:

- [Back up automatically](@/manual/back-up.md), so the server is not the only
  copy.
- [Add a household member](@/manual/household-members.md), with their own
  account and tablet.
- [Put it behind HTTPS](@/manual/https.md), to sync from outside your home.
