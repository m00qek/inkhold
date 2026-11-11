// The fake API's Digest: one person's digests and categories, as a tablet
// synced them, with sources in the fake library (`fakeFixtures.ts`) so
// "Open at page" lands somewhere, one source the library lacks, and a
// category with nothing in it.

import { delay } from "./fake";
import { fakeHash } from "./fakeHash";
import type { Digest, DigestCategory, DigestSnapshot } from "./digestTypes";

const DAY = 86_400_000;

const CATEGORIES: DigestCategory[] = [
  { uid: "c0ffee00000000000000000000000001", name: "Home" },
  { uid: "c0ffee00000000000000000000000002", name: "Kitchen" },
  { uid: "c0ffee00000000000000000000000003", name: "Reading" },
];
const [HOME, KITCHEN] = CATEGORIES.map((c) => c.uid) as [string, string];

/** A digest's handwritten note: its md5, which the fake bytes answer to. */
export const FAKE_NOTE_MD5 = fakeHash("digest-note-1").padEnd(32, "0").slice(0, 32);

function digests(now: number): Digest[] {
  const at = (days: number) => now - days * DAY;
  return [
    {
      id: "1", text: "The tenant may sublet the flat only with the landlord's written consent.", comment: "Ask before the summer",
      categoryUid: HOME, author: null, createdAt: at(9), note: FAKE_NOTE_MD5,
      source: { kind: "document", path: "Document/Apartment lease — signed.pdf", fileId: "142", page: 3 },
    },
    {
      id: "2", text: "Descale the boiler every three months in hard-water areas.", comment: null,
      categoryUid: HOME, author: null, createdAt: at(8), note: null,
      source: { kind: "document", path: "Document/Appliance manual.pdf", fileId: "178", page: 2 },
    },
    {
      id: "3", text: "The tenant pays for repairs caused by misuse.", comment: null,
      categoryUid: HOME, author: null, createdAt: at(7), note: null,
      source: { kind: "document", path: "Document/Apartment lease — signed.pdf", fileId: "142", page: 1 },
    },
    {
      id: "4", text: "Feed the starter twice a day while it is young.", comment: "Try the rye flour",
      categoryUid: KITCHEN, author: "M. Baker", createdAt: at(5), note: null,
      source: { kind: "document", path: "Document/Sourdough — a field guide.epub", fileId: "143", page: null },
    },
    {
      id: "5", text: "Ship the beta before the review", comment: null,
      categoryUid: "", author: null, createdAt: at(3), note: null,
      source: { kind: "note", path: "Note/Project Aurora — kickoff.note", fileId: "121", page: 2 },
    },
    {
      id: "6", text: "Bring the old drawings to the meeting", comment: null,
      categoryUid: "", author: null, createdAt: at(2), note: null,
      source: { kind: "note", path: "Note/Old notebook.note", fileId: null, page: 4 },
    },
    {
      id: "7", text: "Call the plumber about the kitchen tap", comment: null,
      categoryUid: "", author: null, createdAt: at(1), note: null,
      source: { kind: "manual", path: null, fileId: null, page: null },
    },
  ];
}

export function fakeDigestMethods(latency: number) {
  const made = Date.now();
  return {
    async digests(): Promise<DigestSnapshot> {
      await delay(latency);
      return { enabled: true, categories: CATEGORIES.map((c) => ({ ...c })), digests: digests(made) };
    },
    async digestNoteBytes(_id: string, md5: string): Promise<ArrayBuffer> {
      await delay(latency);
      // The fake renderer paints from the page's hash, not its bytes.
      return new TextEncoder().encode(md5).buffer as ArrayBuffer;
    },
  };
}
