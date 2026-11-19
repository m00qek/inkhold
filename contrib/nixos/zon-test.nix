# zon.nix, without a VM: what each kind of value becomes, and what it refuses.
{ pkgs }:

let
  inherit (pkgs) lib;
  toZon = import ./zon.nix { inherit lib; };
  refused = v: !(builtins.tryEval (builtins.deepSeq (toZon v) null)).success;

  failures = lib.runTests {
    testScalars = {
      expr = toZon {
        port = 8089;
        todo_sync = true;
        digest_sync = false;
        host = "0.0.0.0";
      };
      expected = ''
        .{
            .digest_sync = false,
            .host = "0.0.0.0",
            .port = 8089,
            .todo_sync = true,
        }
      '';
    };
    testNestedAndTuple = {
      expr = toZon {
        history.keep = 3;
        tls = {
          enabled = true;
          cipher_suites = [
            "TLS_AES_128_GCM_SHA256"
            "TLS_CHACHA20_POLY1305_SHA256"
          ];
        };
      };
      expected = ''
        .{
            .history = .{
                .keep = 3,
            },
            .tls = .{
                .cipher_suites = .{ "TLS_AES_128_GCM_SHA256", "TLS_CHACHA20_POLY1305_SHA256" },
                .enabled = true,
            },
        }
      '';
    };
    testEmptyTuple = {
      expr = toZon { tls.cipher_suites = [ ]; };
      expected = ''
        .{
            .tls = .{
                .cipher_suites = .{},
            },
        }
      '';
    };
    testEscapes = {
      expr = toZon { trusted_proxy = ''a"b\c''; };
      expected = ''
        .{
            .trusted_proxy = "a\"b\\c",
        }
      '';
    };
    testNullKeepsTheDefault = {
      expr = toZon {
        host = null;
        port = 1;
      };
      expected = ''
        .{
            .port = 1,
        }
      '';
    };
    testRefusesANewline = {
      expr = refused { admin_email = "a\nb"; };
      expected = true;
    };
    testRefusesAFloat = {
      expr = refused { port = 1.5; };
      expected = true;
    };
  };
in
if failures == [ ] then
  pkgs.runCommand "inkhold-zon-test" { } "touch $out"
else
  throw "zon.nix: ${builtins.toJSON failures}"
