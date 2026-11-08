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

On the server's disk, in two places: a database (accounts, folders, names,
versions) and a data folder holding every file exactly as the tablet wrote it,
along with the text Inkhold reads out of each file for search. Nothing is kept
anywhere else. Whoever runs the server chooses the two places
([config.zon settings](@/manual/configuration.md)).

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

Your password never leaves your browser or tablet: only proof of it does.

The tablet's way of signing in needs the server to keep a form of your
password it can check against, so Inkhold cannot keep only a one-way hash,
as most websites do. It keeps that form **encrypted**, with a key stored apart
from the database. A copy of the database alone reveals no password. Whoever
runs the server keeps that key safe: [Back up automatically](@/manual/back-up.md)
says how.
