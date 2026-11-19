# package.nix given an archive instead of a release: the release's own
# x86_64 archive, fetched here and handed over as if built locally. It
# installs what the archive holds, under the version it is given.
{ pkgs }:

let
  release = pkgs.callPackage ./package.nix { };
  local = release.override {
    archive = release.src;
    version = "hub-test";
  };
in
pkgs.runCommand "inkhold-archive-test" { } ''
  test "${local.version}" = hub-test
  test -x ${local}/bin/inkhold
  test -f ${local}/share/inkhold/web/index.html
  test -f ${local}/share/inkhold/config.example.zon
  ${local}/bin/inkhold --version | grep -q '^inkhold '
  touch $out
''
