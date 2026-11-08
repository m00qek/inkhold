---
title: "Where things live"
description: "The repository's map: which directory holds what, and how modules are split and named."
weight: 3010
extra:
  reader: contributor
  type: reference
---

# Where things live

The repository's map: the layers of the server, how a module splits, how things are named, and how the browser app is laid out.

The directories are layers. An import points down the list, never up: a file
in `services/` may import `store/` and `db/`, and nothing in `store/` knows
`http/` exists. The one deliberate exception is `http/context.zig`, the
per-request bag of service pointers every handler receives.

| layer | directory | holds |
|---|---|---|
| entry | `backend/main.zig`, `cli.zig`, `cli/`, `app.zig`, `routes.zig`, `config.zig` | process start, the CLI grammar, the composition root, the route table |
| transport | `http/` | the accept loop and TLS, the router, request context, replies, multipart, static files, rate limits, SSE admission, lock histograms |
| handlers | `handlers/` | one function per route, in `auth`, `device/`, `controlplane/`, `admin`; thin HTTP shells that parse, call a service, reply |
| services | `services/` | the domain: `files` (tree, bin, quota, history), `auth/`, `controlplane` (the browser's JSON shapes), `sync`, `settings`, `backup` ([§2.6](@/contributor/storage.md#backups)), the indexers (`note_index`, `spd_index`, `txt_index`, `pdf_index`, `pdf_text`, `ink_scan`, `derive_search`), `deferred` (the worker), `pending`, `search/` |
| stores | `store/` | content-addressed bytes on disk: blobs, thumbnails, derived files |
| db | `db/` | the SQLite wrapper, the schema and migrations, the reader pool |
| leaf | `compress/`, `pdf/`, `util/` | code with no dependency on the rest: the gzip stitcher, the MuPDF shims, small helpers |
| tests | `test/http/` | integration tests over the in-memory transport; unit tests sit beside the code (below) |
| benches | `bench/` | measurement programs, built on demand, never shipped |

Within `services/`, the indexers sit below `files` (which calls them inside
its transactions), and `controlplane`, `sync` and `auth` sit above it. Each
SQL table has one owner, and only the owner writes it: `files` owns `files`,
`blobs`, `capacity`, `file_history`, `sync_state` and `upload_sessions`; `auth`
owns `users`, `sessions`, `devices` and `user_devices`; `settings` owns
`settings`; `note_index` owns `note_index` and `note_page_index`, where the
other indexers record their per-blob verdict through it ([§8](@/contributor/indexing-rules.md)); `spd_index` owns
`spd_index`. Any module may read a table it does not own, joining through
`files` for ownership ([§2.1](@/contributor/storage.md#invariants)).

## A module in parts

A module is one file, `x.zig`, until it outgrows 500 lines. Then `x.zig`
stays as the façade (the types, the struct, `pub const f = part.f;` for each
exported function, grouped under one header per part) and the parts move to
`x/`: `x/part.zig` holds the code, `x/part_test.zig` its tests, `x/fixture.zig`
what the tests share, `x/internal.zig` what the parts share and nothing else
calls. Nothing becomes `pub` for a test's sake: a test that needs a private
helper stays inline, under `// ---- tests of private helpers ----` at the end
of the file. `files.zig` + `files/` is the model.

## Naming

- Handlers are named after the resource, not the face: `controlplane.tree`,
  `admin.listUsers`, `device.listFolder`. The face is the module.
- One import alias per module, everywhere: `filesmod`, `authsvc`, `context`,
  `noteindex`, `blobstore`, `thumbstore`, `derivedstore`, `sqlite`, `schema`.
- A section header `// ---- name ----` sits above code; a header with nothing
  under it is deleted, not kept.
- Every file starts with a `//!` line saying what it is for; every `pub fn`
  that is not a one-line wrapper carries a `///` saying what the caller may
  assume.

## The browser app

`webapp/src/` is laid out by role: `api/` (the server client and its fake),
`core/` (shared types), `render/`, `search/`, `export/`, `cache/`, `sync/`,
`ui/` (DOM helpers) and `pages/` (the screens). A screen with more than one
module gets its own folder, `pages/<feature>/`, with the entry module named
after the feature (`pages/library/library.ts`); a single-file screen stays at
`pages/`. Unit tests live under `tests/unit/`, end-to-end specs under
`tests/e2e/`, mirroring the source names.

A screen that outgrows one file is not cut into closures fed by thunks. It
gets one typed context object (`LibraryCtx`, `ReaderCtx`, `PdfViewerCtx`,
`TodoCtx`)
that names everything its parts share, built once in dependency order by the
screen's entry module; each part is `createX(ctx)` returning a named
interface, and reads a member only when one of its functions runs. The
context file states the order rule; the entry module is the only place that
has to get it right.

Stylesheets are a list of rules, so the 500-line target is for code, not for
them. `styles.css` is an ordered manifest and the order is load-bearing; a
sheet that grows is split by component (`09-admin.css`, `09b-admin-panels.css`),
the continuation imported right after its base so the cascade is unchanged.
