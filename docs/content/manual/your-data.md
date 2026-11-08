---
title: "Your data"
description: "Where your notes are kept, who can see them, and what never leaves your home."
weight: 4030
extra:
  reader: operator, household
  type: explanation
---

# Your data

Where your notebooks are kept, who can see them, and what leaves your home.

## Where it lives

On the server's disk, in two places its [settings](@/manual/configuration.md)
name: a database (accounts, folders, names, versions, the search index) and a
data folder holding every file exactly as the tablet wrote it, named by its
content. Nothing is kept anywhere else.

## What leaves your home

Nothing. Inkhold makes no connections of its own: no updates, no telemetry, no
accounts somewhere else. The tablet and the browsers connect to it, and that's
all. Over the internet, put it [behind HTTPS](@/manual/https.md) so those
connections are private too.

The browser keeps some things to be fast: page images, the search index, the
app itself. They stay in that browser, for that person.

## Who can see what

- **Each person** sees their own notebooks, in the browser and on their tablet.
- **An administrator** manages accounts: adds and deletes people, resets
  passwords, sets allotments. The admin console doesn't show anyone's
  notebooks.
- **Whoever runs the server** has the disk, and so the files. That's the point
  of running your own: it's you, or someone in your house.

## Passwords

The tablet's sign-in needs the server to be able to check a password in a
particular form, so Inkhold cannot store only a one-way hash, as most services
do. It stores that form **encrypted**, with a key kept outside the database
(`cred.key`). A copy of the database alone reveals no password; the key and the
database together would. Keep `cred.key` apart from your backups unless you
choose to include it, and as private as the server.

Your password itself never leaves your browser or tablet: only proof of it
does.
