---
title: "Your first change"
description: "Make a small change end to end: the code, its test, and the checks before a pull request."
weight: 1020
extra:
  reader: contributor
  type: tutorial
---

# Your first change

In this tutorial you make a small change to the browser app, see it, test it,
and get it ready to send. The change: the To-Do page's keyboard help gains a
word. You will undo it at the end, so pick nothing important.

You need [the code built and running](@/contributor/build-and-run.md).

## 1. Find the code

Every label in the app is in the code as written. Search for it:

```sh
grep -rn '"Keyboard shortcuts"' webapp/src
```

It is in `webapp/src/pages/todo/todoView.ts`, in `keysHint`, which lists each
key and what it does.

## 2. Change it

In `keysHint`, change `"new task"` to `"add a new task"`. Save.

## 3. See it

With `npm run demo` running in `webapp/`, open **To-Do**, then **All**, and
open **Keyboard shortcuts** under the list: it says "add a new task". The page
reloaded itself when you saved.

## 4. Test it

The unit tests and the type checker, quick:

```sh
cd webapp
npm run typecheck
npx vitest run
```

The end-to-end tests for To-Do, which drive a real browser:

```sh
npx playwright test tests/e2e/todo
```

If a test reads the text you changed, it fails now: that is the suite doing its
job. A real change updates that test in the same commit.

## 5. Get it ready

A commit's title says what changed, as a
[Conventional Commit](@/contributor/commit-messages.md):
`fix(webapp): name the To-Do button for what it does`. Run the whole suite
before you send it ([Run the tests](@/contributor/run-the-tests.md)).

## Undo it

```sh
git checkout webapp/src/pages/todo/todoView.ts
```

You have found code by its label, changed it, seen it live, and run the tests
that cover it. That is the loop every change goes through.
