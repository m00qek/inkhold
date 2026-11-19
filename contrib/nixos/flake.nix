# Inkhold on NixOS. In your system's flake:
#
#   inputs.inkhold.url = "github:m00qek/inkhold?dir=contrib/nixos";
#   ...
#   modules = [ inkhold.nixosModules.default { services.inkhold.enable = true; } ];
#
# Without flakes, import ./module.nix. The options are in module.nix; running
# a commit no release carries, from a locally built archive, in package.nix.
# `nix flake check` boots three VMs to run the server and both backups
# (test.nix), checks the config writer (zon-test.nix), and the package built
# from a local archive (archive-test.nix).
{
  description = "Inkhold on NixOS: the release build and a module to run it";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "armv6l-linux"
        "armv7l-linux"
        "i686-linux"
      ];
      forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      packages = forAll (pkgs: rec {
        inkhold = pkgs.callPackage ./package.nix { };
        default = inkhold;
      });

      nixosModules.default = ./module.nix;
      nixosModules.inkhold = ./module.nix;

      checks.x86_64-linux = {
        vm = import ./test.nix {
          pkgs = nixpkgs.legacyPackages.x86_64-linux;
          module = self.nixosModules.default;
        };
        zon = import ./zon-test.nix { pkgs = nixpkgs.legacyPackages.x86_64-linux; };
        archive = import ./archive-test.nix { pkgs = nixpkgs.legacyPackages.x86_64-linux; };
      };
    };
}
