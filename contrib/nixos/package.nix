# The release build: the same static binary and browser app as every other
# install ("Install the binary"), for the machine's architecture. A release
# changes `version` and the four hashes: ./update.sh <version>.
{
  lib,
  stdenvNoCC,
  fetchurl,
}:

let
  version = "1.0.0-beta.2";
  builds = {
    x86_64-linux = {
      target = "x86_64-linux-musl";
      hash = "sha256-asYC62rxYlAFg5knfVhdpnSIzZ8KnUYTbzeBdB53HlU=";
    };
    aarch64-linux = {
      target = "aarch64-linux-musl";
      hash = "sha256-XuV3vLxJpOh5tdexypzL6/68qDAawUbL+oUD0nqZQOQ=";
    };
    # Built for the Raspberry Pi 1's ARMv6, so it runs on any 32-bit ARM.
    armv6l-linux = {
      target = "arm-linux-musleabihf";
      hash = "sha256-XCQIZkeWWad4BuxDFzGjSbWZ4RoEmgYxM3LjXukbq9Y=";
    };
    armv7l-linux = builds.armv6l-linux;
    i686-linux = {
      target = "x86-linux-musl";
      hash = "sha256-kosXUvc6/yo4aVxEC/k2COgSma2MjJ9KgMm/7GwxHgs=";
    };
  };
  system = stdenvNoCC.hostPlatform.system;
  build = builds.${system} or (throw "inkhold: no release build for ${system}");
in
stdenvNoCC.mkDerivation {
  pname = "inkhold";
  inherit version;

  src = fetchurl {
    url = "https://github.com/m00qek/inkhold/releases/download/v${version}/inkhold-${build.target}.tar.gz";
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
