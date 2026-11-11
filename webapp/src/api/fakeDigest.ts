// The fake API's Digest: one person's digests and categories, as a tablet
// synced them, with sources in the fake library (`fakeFixtures.ts`) so
// "Open at page" lands somewhere, one source the library lacks, and a
// category with nothing in it.
//
// The demo and the docs' screenshots get their own set (`demoNotes.ts`):
// someone learning German, quoting the demo's grammar sheet word for word.
// The e2e suite keeps the first set, whose texts its tests read.

import { delay } from "./fake";
import { fakeHash } from "./fakeHash";
import { DEMO_GRAMMAR_ID, demoNotesOn } from "./demoNotes";
import type { Digest, DigestCategory, DigestSnapshot } from "./digestTypes";

const DAY = 86_400_000;

const CATEGORIES: DigestCategory[] = [
  { uid: "c0ffee00000000000000000000000001", name: "Home" },
  { uid: "c0ffee00000000000000000000000002", name: "Kitchen" },
  { uid: "c0ffee00000000000000000000000003", name: "Reading" },
];
const [HOME, KITCHEN] = CATEGORIES.map((c) => c.uid) as [string, string];

/** A handwritten note's md5, from a seed: the fake renderer draws each its own. */
const noteMd5 = (seed: string) => fakeHash(seed).padEnd(32, "0").slice(0, 32);

/** The e2e set's one handwritten note. */
export const FAKE_NOTE_MD5 = noteMd5("digest-note-1");

function testDigests(now: number): Digest[] {
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

const DEMO_CATEGORIES: DigestCategory[] = [
  { uid: "de000000000000000000000000000001", name: "Grammar" },
  { uid: "de000000000000000000000000000002", name: "Phrases for Berlin" },
];
const [GRAMMAR, PHRASES] = DEMO_CATEGORIES.map((c) => c.uid) as [string, string];

/** The demo's German, in the grammar sheet's own words and pages. */
function demoDigests(now: number): Digest[] {
  const at = (days: number) => now - days * DAY;
  const sheet = (page: number) => ({ kind: "document" as const, path: "Document/Deutsch lernen — Grammatik.pdf", fileId: DEMO_GRAMMAR_ID, page });
  const typed = { kind: "manual" as const, path: null, fileId: null, page: null };
  const base = { author: null, categoryUid: GRAMMAR };
  return [
    { ...base, id: "11", text: "Im Deutschen hat jedes Nomen ein Geschlecht: der, die oder das.", comment: "Learn every noun with its article, never alone.", createdAt: at(3), note: noteMd5("demo-articles"), source: sheet(1) },
    { ...base, id: "12", text: "Der Plural hat für alle drei Geschlechter denselben Artikel: die.", comment: null, createdAt: at(3) + 60_000, note: null, source: sheet(1) },
    { ...base, id: "13", text: "Im Nebensatz steht das Verb am Ende.", comment: null, createdAt: at(2), note: noteMd5("demo-weil"), source: sheet(2) },
    { ...base, id: "14", text: "Trennbare Verben teilen sich: Ich rufe dich morgen an.", comment: "anrufen, aufstehen, einkaufen: the prefix goes to the end.", createdAt: at(2) + 60_000, note: null, source: sheet(2) },
    { ...base, id: "15", text: "Verben der Bewegung bilden das Perfekt meist mit sein.", comment: "sein, not haben!", createdAt: at(1), note: noteMd5("demo-perfekt"), source: sheet(3) },
    { ...base, id: "16", categoryUid: PHRASES, text: "Entschuldigung, wo ist der Bahnhof?", comment: "Excuse me, where is the station?", createdAt: at(1) + 60_000, note: null, source: typed },
    { ...base, id: "17", categoryUid: PHRASES, text: "Ich hätte gern einen Kaffee, bitte.", comment: "I'd like a coffee, please.", createdAt: at(0.2), note: noteMd5("demo-kaffee"), source: typed },
    { ...base, id: "18", categoryUid: "", text: "Wir haben gestern Kaffee getrunken.", comment: null, createdAt: at(0.1), note: null, source: sheet(3) },
  ];
}

export function fakeDigestMethods(latency: number) {
  const made = Date.now();
  const demo = demoNotesOn();
  return {
    async digests(): Promise<DigestSnapshot> {
      await delay(latency);
      const categories = demo ? DEMO_CATEGORIES : CATEGORIES;
      return { enabled: true, categories: categories.map((c) => ({ ...c })), digests: demo ? demoDigests(made) : testDigests(made) };
    },
    async digestNoteBytes(_id: string, md5: string): Promise<ArrayBuffer> {
      await delay(latency);
      // The fake renderer paints from the page's hash, not its bytes.
      return new TextEncoder().encode(md5).buffer as ArrayBuffer;
    },
  };
}
