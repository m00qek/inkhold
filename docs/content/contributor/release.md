---
title: "Make a release"
description: "Tag a version, build every image and binary, and publish the release notes."
weight: 2070
extra:
  reader: contributor
  type: how-to
---

# Make a release

`pre-release` is the source of truth: every push to it is tested and, when the
suites pass, published.

What a push sets off:

```mermaid
flowchart TD
  push["git push origin pre-release"] --> ci["CI: fmt, server tests, parsers, footprint, web unit + e2e"]
  ci --> rel["release job: inkhold-target.tar.gz for 4 targets, with the browser app"]
  rel --> img["image job: one multi-arch image"]
  img --> ghcr["ghcr.io/m00qek/inkhold :latest and :sha"]
  rel --> dl["The archives the docs' download links point at"]
  main["git push origin main"] --> ci2["CI: the same suites, nothing published"]
```

1. [Cross-build](@/contributor/cross-build.md) if the server changed, and
   [run the tests](@/contributor/run-the-tests.md).
2. Push `pre-release`. CI then:
   - runs the server, parser and browser app suites, and the footprint check;
   - only if all of them pass, builds the server for the four targets, with the browser app, as
     archives (the download links in the docs point at them);
   - builds and publishes the container image for all four architectures, as
     `ghcr.io/m00qek/inkhold:latest` and as the commit's hash.
3. Check the run: the image job prints what it published.

`main` is tested on push but publishes nothing.

There are no version numbers yet: the commit is the version, and to stay on one
build people use its hash as the image tag.
