---
title: "Build and run Inkhold"
description: "Build the server, start the web app on its demo library, and open it."
weight: 1010
extra:
  reader: contributor
  type: tutorial
---

# Build and run Inkhold

In this tutorial you build Inkhold from source, start the server, and then run
the browser app on its own demo library, the way you will while changing it.

You need [Zig](https://ziglang.org) 0.17.0, Node.js with npm, and `git`.

## 1. Get the code

```sh
git clone https://github.com/m00qek/inkhold.git
cd inkhold
```

The repository has three parts:

```text
backend/   the Zig server: device sync, the browser's API, the static files
webapp/    the browser app (TypeScript, no runtime dependencies); wasm/ holds its decoders
parsers/   the .note and .spd file-format parsers, with their own tests and specs
```

## 2. Build and start the server

```sh
make serve
```

This builds the WebAssembly decoders, the browser app and the server, then
starts it on port 8089. The first start writes its config to
`server/8089/serve.zon` (the file to edit from now on) and prints a password
for `admin@home.lan`. Open `http://127.0.0.1:8089`, sign in with it, and choose
your own.

You now run a real Inkhold: you could point a tablet at it. Stop it with
Ctrl-C.

## 3. Run the browser app on the demo library

Most work on the browser app needs no server at all:

```sh
cd webapp
npm install
npm run demo
```

Open the address it prints. You are signed in to a made-up household: folders,
notebooks (three of them with real handwriting), PDFs, a recycle bin, to-dos
and an admin console, all served by an in-memory fake. Change a file under
`webapp/src/` and the page reloads.

## What you have now

A server you built yourself, and the app running on test data. Next:

- [Run the tests](@/contributor/run-the-tests.md) before you change anything.
- [Where things live](@/contributor/where-things-live.md): the map of the code.
- [Your first change](@/contributor/first-change.md).
