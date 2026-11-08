---
title: "Make a release"
description: "Tag a version, build every image and binary, and publish the release notes."
weight: 2070
extra:
  reader: contributor
  type: how-to
---

# Make a release

`main` is the only branch: every push to it is tested and, when the suites
pass, published.

What a push sets off:

```mermaid
flowchart TD
  push["git push origin main"] --> suites["The suites, side by side: server, parsers, footprint, web unit, web e2e in 4 slices"]
  push --> rel["release job: inkhold-target.tar.gz for 4 targets, with the browser app"]
  suites --> img["image job: one multi-arch image"]
  rel --> img
  img --> ghcr["ghcr.io/m00qek/inkhold :latest and :sha"]
  rel --> dl["The archives the docs' download links point at, once the whole run is green"]
  pr["a pull request"] --> ci2["The same suites and builds, nothing published"]
```

1. [Cross-build](@/contributor/cross-build.md) if the server changed, and
   [run the tests](@/contributor/run-the-tests.md).
2. Push `main`. CI then:
   - runs the server, parser and browser app suites and the footprint check,
     each on its own runner;
   - meanwhile builds the server for the four targets, with the browser app,
     as archives. The download links in the docs serve the latest run that
     passed, so a failing run's archives are never downloaded;
   - once every suite has passed, builds and publishes the container image
     for all four architectures, as `ghcr.io/m00qek/inkhold:latest` and as
     the commit's hash.
3. Check the run: the image job prints what it published.

A pull request runs the same suites and builds the image, but publishes nothing.

There are no version numbers yet: the commit is the version, and to stay on one
build people use its hash as the image tag.
