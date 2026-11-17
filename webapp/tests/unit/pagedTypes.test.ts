// The browser's paged documents and the server's must be the same list: a type
// the browser opens but the server never probes gets no shape and no search,
// and one the server probes but the browser never opens is wasted work.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PAGED_DOCUMENT_TYPES } from "../../src/core/fileKind";

const server = readFileSync(
  fileURLToPath(new URL("../../../backend/services/pdf_index.zig", import.meta.url)),
  "utf8",
);

describe("paged document types", () => {
  it("are the same on both sides", () => {
    const m = /pub const extensions = \[_\]\[\]const u8\{([^}]*)\};/.exec(server);
    expect(m, "pdf_index.extensions not found").not.toBeNull();
    const zig = [...m![1]!.matchAll(/"([a-z0-9]+)"/g)].map((x) => x[1]);
    expect([...PAGED_DOCUMENT_TYPES].sort()).toEqual(zig.sort());
  });
});
