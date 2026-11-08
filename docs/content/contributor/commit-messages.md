---
title: "Commit messages"
description: "Conventional Commits: the types, the scopes, and the 120-character title."
weight: 3082
extra:
  reader: contributor
  type: reference
---

# Commit messages

Every commit follows [Conventional Commits](https://www.conventionalcommits.org).
CI checks each title a push or pull request adds.

```text
type(scope): what changed, in the imperative

Why, in a few short lines, when the title isn't enough.
```

## The title

- `type`, an optional `(scope)`, a colon, a space, then the summary.
- Under 120 characters.
- Lowercase scope: `server`, `webapp`, `parsers`, `docs`, `ci`, `release`.
- `!` before the colon for a breaking change: `feat(server)!: drop the v1 routes`.

| Type | For |
|---|---|
| `feat` | Something new for the people using Inkhold |
| `fix` | A bug fixed |
| `perf` | Faster or smaller, behaving the same |
| `refactor` | Code changed, behaviour not |
| `test` | Tests only |
| `docs` | Documentation only |
| `ci` | The workflows |
| `build` | The build, the toolchain, dependencies |
| `style` | Formatting only |
| `chore` | Anything else, such as `chore(release): 1.0.0-beta.1` |
| `revert` | Undoing an earlier commit |

## The body

Short, and only when the title leaves a question: why, not what. A breaking
change says what to do about it in a `BREAKING CHANGE:` line.

## Check before you push

```sh
make commit-check     # the commits not yet on origin/main
make commit-hook      # once: git then checks each title as you commit
```
