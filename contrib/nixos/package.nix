# The release build: the same static binary and browser app as every other
# install ("Install the binary"), for the machine's architecture. A release
# changes `released` and the four hashes: ./update.sh <version>.
#
# Or a commit no release carries, from an archive built like a release's
# (`make release-artifact TARGET=x86_64-linux-musl` at the repo's root):
#
#   services.inkhold.package = inkhold.packages.${system}.default.override {
#     archive = ./inkhold-x86_64-linux-musl.tar.gz;
#     version = "hub-abc1234";
#   };
#
# Nix copies the archive into the store, so no hash is kept by hand: it is
# the archive's own. It must be built for the machine's architecture.
{
  lib,
  stdenvNoCC,
  fetchurl,
  archive ? null,
  version ? null,
}:

let
  released = "1.0.0-beta.3";
  builds = {
    x86_64-linux = {
      target = "x86_64-linux-musl";
      hash = "sha256-kOwe9jwRkH2XZBRbeXiolBR5s8R2oJQFsA53k6VV824=";
    };
    aarch64-linux = {
      target = "aarch64-linux-musl";
      hash = "sha256-z7WQ4eCJcbyGfNrWXEKHsiP6Z0M8rPkEdWEwqZtgu84=";
    };
    # Built for the Raspberry Pi 1's ARMv6, so it runs on any 32-bit ARM.
    armv6l-linux = {
      target = "arm-linux-musleabihf";
      hash = "sha256-KWGn+R4ofVUA/nyiod56xKUPJOTjLTlGU41vAb4wpmE=";
    };
    armv7l-linux = builds.armv6l-linux;
    i686-linux = {
      target = "x86-linux-musl";
      hash = "sha256-phYPq1snDdGfSXcXeZr/eeQjwdWGdHvNscKeJRgoKpU=";
    };
  };
  system = stdenvNoCC.hostPlatform.system;
  build = builds.${system} or (throw "inkhold: no release build for ${system}");
in
stdenvNoCC.mkDerivation {
  pname = "inkhold";
  version =
    if archive == null then
      released
    else if version == null then
      "local"
    else
      version;

  src =
    if archive != null then
      archive
    else
      fetchurl {
        url = "https://github.com/m00qek/inkhold/releases/download/v${released}/inkhold-${build.target}.tar.gz";
        inherit (build) hash;
      };
  sourceRoot = ".";

  installPhase = ''
    runHook preInstall
    install -Dm755 inkhold $out/bin/inkhold
    mkdir -p $out/share/inkhold
    cp -r webapp/dist $out/share/inkhold/web
    install -Dm644 config.example.zon $out/share/inkhold/config.example.zon
    runHook postInstall
  '';

  # Static and already stripped: ship the release's bytes as they are.
  dontStrip = true;
  dontPatchELF = true;

  meta = {
    description = "A self-hosted server for Supernote tablets: sync, a browser library and search";
    homepage = "https://github.com/m00qek/inkhold";
    license = lib.licenses.agpl3Only;
    sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
    platforms = builtins.attrNames builds;
    mainProgram = "inkhold";
  };
}
