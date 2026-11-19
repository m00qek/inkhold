# Nix values as ZON, the config's format: attribute sets are structs, lists
# are tuples. Null leaves a field out, so the server keeps its default.
# Tested by zon-test.nix.
{ lib }:

let
  toZon =
    indent: v:
    if builtins.isAttrs v then
      ".{\n"
      + lib.concatStrings (
        lib.mapAttrsToList (k: x: "${indent}    .${k} = ${toZon "${indent}    " x},\n") (
          lib.filterAttrs (_: x: x != null) v
        )
      )
      + "${indent}}"
    else if v == [ ] then
      ".{}"
    else if builtins.isList v then
      ".{ " + lib.concatMapStringsSep ", " (toZon indent) v + " }"
    else if builtins.isBool v then
      lib.boolToString v
    else if builtins.isInt v then
      toString v
    else if builtins.isString v then
      if lib.hasInfix "\n" v then
        throw "services.inkhold.settings: a string with a newline cannot be written to config.zon"
      else
        "\"" + lib.escape [ "\\" "\"" ] v + "\""
    else
      throw "services.inkhold.settings: ${builtins.typeOf v} has no ZON form";
in
v: toZon "" v + "\n"
