// Helpers shared by the slowLink tests.

// The real layered SNPG payload; its layer descriptors pair with the records by slot.
import { layeredPageLayers, layeredPagePayload } from "../../src/api/layeredFixture";

// What is on screen while a request is in flight: loading and known-empty are different
// states. Uses `?real` with a mocked control plane, the only way to hold a response.
// Use `recordText` for "must never have said X"; retrying matchers cannot catch it.

export const ME = { success: true, email: "ana@household.lan", isAdmin: false, mustChangePassword: false };

export function note(id: string, name: string) {
  return {
    kind: "note",
    id,
    name,
    pageCount: 1,
    fileType: "note",
    fileHash: "0".repeat(32),
    updatedAt: 1_700_000_000_000,
    hasRecognizedText: false,
    firstPage: { index: 0, hash: "1".repeat(32), width: 1404, height: 1872, textHash: null },
  };
}
