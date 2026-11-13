// The fake API's Digest: one person's digests and categories, as a tablet
// synced them, with sources in the fake library (`fakeFixtures.ts`) so
// "Open at page" lands somewhere, one source the library lacks, one that
// has changed since, and a category with nothing in it.
//
// The demo and the docs' screenshots get their own set (`demoNotes.ts`):
// someone learning German, quoting the demo's grammar sheet word for word.
// The e2e suite keeps the first set, whose texts its tests read.

import { delay } from "./fake";
import { fakeHash } from "./fakeHash";
import { DEMO_GRAMMAR_ID, demoNotesOn } from "./demoNotes";
import { ApiError } from "./errors";
import {
  categoryNameProblem, MAX_COMMENT, trimComment,
  type BinnedDigest, type Digest, type DigestBin, type DigestCategory, type DigestEdit, type DigestSnapshot, type DigestSource,
} from "./digestTypes";

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

/**
 * A digest as the tablet synced it, its source unchanged unless it says so;
 * when it last changed, and whether a browser change waits, are the fake server's.
 */
type Synced = Omit<Digest, "waiting" | "modifiedAt" | "source"> & { source: Omit<DigestSource, "changed"> & { changed?: boolean } };

function testDigests(now: number): Synced[] {
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
      source: { kind: "document", path: "Document/Appliance manual.pdf", fileId: "178", page: 2, changed: true },
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
function demoDigests(now: number): Synced[] {
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

/** The fake bin's window, as the server's default. */
const RETENTION_DAYS = 30;

/**
 * A digest in the fake bin: what it was, when it went. `uid` is the one the
 * tablet keeps in its metadata: a live digest with the same one is the tablet's
 * copy, sent back after it was edited there (the server's "back").
 */
export interface Binned {
  digest: Digest;
  deletedAt: number;
  uid?: string;
}

/** What the fake starts with beyond its set: digests already in the bin, live ones with a tablet uid. */
export interface DigestSeed {
  bin?: Binned[];
  /** Live digests' tablet uids, by id. */
  uids?: Record<string, string>;
}

export function fakeDigestMethods(latency: number, seed: DigestSeed = {}) {
  const demo = demoNotesOn();
  const categories = (demo ? DEMO_CATEGORIES : CATEGORIES).map((c) => ({ ...c }));
  /** Deleted categories, kept while a digest in the bin may bring one back. */
  const deletedCategories: DigestCategory[] = [];
  const bin: Binned[] = [...(seed.bin ?? [])];
  const uids = new Map(Object.entries(seed.uids ?? {}));
  let nextCategory = 1;
  /**
   * Something changed here that no tablet has fetched: a digest or a category,
   * made, edited, deleted or restored (the server's `webChangedSince`). The
   * fake has no tablet to fetch it, so it stays.
   */
  let changedHere = false;
  // `waiting`: like a server whose tablet has not synced since.
  const digests: Digest[] = (demo ? demoDigests(Date.now()) : testDigests(Date.now())).map((d) => ({
    ...d, modifiedAt: d.createdAt, source: { ...d.source, changed: d.source.changed ?? false }, waiting: false,
  }));
  const tabletSyncedAt = Date.now() - 5 * 60_000;
  return {
    async digests(): Promise<DigestSnapshot> {
      await delay(latency);
      return {
        enabled: true,
        categories: categories.map((c) => ({ ...c })),
        digests: digests.map((d) => ({ ...d, source: { ...d.source } })),
        tabletSyncedAt,
        waiting: changedHere,
      };
    },
    async digestEdit(id: string, change: DigestEdit): Promise<void> {
      await delay(latency);
      const text = change.comment === undefined ? undefined : trimComment(change.comment);
      if (text !== undefined && [...text].length > MAX_COMMENT) throw new ApiError("BAD_COMMENT", "a comment holds at most 2000 characters of text", 400);
      const uid = change.categoryUid;
      if (uid !== undefined && uid !== "" && !categories.some((c) => c.uid === uid)) throw new ApiError("NO_SUCH_CATEGORY", "there is no such category", 404);
      const d = digests.find((x) => x.id === id);
      if (!d) throw new ApiError("NO_SUCH_DIGEST", "there is no such digest", 404);
      if (text !== undefined) d.comment = text === "" ? null : text;
      if (uid !== undefined) d.categoryUid = uid;
      d.modifiedAt = Math.max(Date.now(), d.modifiedAt + 1);
      d.waiting = true;
      changedHere = true;
    },
    async digestNoteBytes(_id: string, md5: string): Promise<ArrayBuffer> {
      await delay(latency);
      // The fake renderer paints from the page's hash, not its bytes.
      return new TextEncoder().encode(md5).buffer as ArrayBuffer;
    },
    async digestDelete(id: string): Promise<void> {
      await delay(latency);
      const i = digests.findIndex((x) => x.id === id);
      if (i < 0) throw new ApiError("NO_SUCH_DIGEST", "there is no such digest", 404);
      const d = digests.splice(i, 1)[0]!;
      bin.unshift({ digest: d, deletedAt: Date.now(), uid: uids.get(d.id) });
      changedHere = true;
    },
    async digestCreateCategory(name: string): Promise<DigestCategory> {
      await delay(latency);
      const clean = checkName(name, null);
      const c = { uid: `fa${String(nextCategory++).padStart(30, "0")}`, name: clean };
      categories.push(c);
      changedHere = true;
      return { ...c };
    },
    async digestRenameCategory(uid: string, name: string): Promise<void> {
      await delay(latency);
      const c = categories.find((x) => x.uid === uid);
      if (!c) throw new ApiError("NO_SUCH_CATEGORY", "there is no such category", 404);
      c.name = checkName(name, uid);
      changedHere = true;
    },
    async digestDeleteCategory(uid: string): Promise<number> {
      await delay(latency);
      const i = categories.findIndex((x) => x.uid === uid);
      if (i < 0) throw new ApiError("NO_SUCH_CATEGORY", "there is no such category", 404);
      deletedCategories.push(categories.splice(i, 1)[0]!);
      const now = Date.now();
      const gone = digests.filter((d) => d.categoryUid === uid);
      for (const d of gone) {
        digests.splice(digests.indexOf(d), 1);
        bin.unshift({ digest: d, deletedAt: now, uid: uids.get(d.id) });
      }
      changedHere = true;
      return gone.length;
    },
    async digestBin(): Promise<DigestBin> {
      await delay(latency);
      return { enabled: true, retentionDays: RETENTION_DAYS, digests: bin.map(binned) };
    },
    async digestRestore(id: string): Promise<void> {
      await delay(latency);
      const i = bin.findIndex((b) => b.digest.id === id);
      if (i < 0) throw new ApiError("NOT_IN_BIN", "there is no such digest in the bin", 404);
      if (isBack(bin[i]!)) throw new ApiError("BACK_ALREADY", "the tablet brought this digest back already", 409);
      const { digest: d, uid: tabletUid } = bin[i]!;
      const was = d.categoryUid;
      if (was !== "" && !categories.some((c) => c.uid === was)) {
        // A deleted category comes back; one whose name is taken since lends the digest to the live one.
        const gone = deletedCategories.find((c) => c.uid === was);
        const same = gone ? categories.find((c) => c.name === gone.name) : undefined;
        if (same) d.categoryUid = same.uid;
        else if (gone) categories.push(deletedCategories.splice(deletedCategories.indexOf(gone), 1)[0]!);
        else d.categoryUid = "";
      }
      // Landed elsewhere: a change the tablet takes, as the server stamps it.
      if (d.categoryUid !== was) d.modifiedAt = Math.max(Date.now(), d.modifiedAt + 1);
      bin.splice(i, 1);
      d.waiting = true;
      digests.push(d);
      if (tabletUid) uids.set(d.id, tabletUid);
      changedHere = true;
    },
    async digestPurge(id: string): Promise<void> {
      await delay(latency);
      const i = bin.findIndex((b) => b.digest.id === id);
      if (i < 0) throw new ApiError("NOT_IN_BIN", "there is no such digest in the bin", 404);
      bin.splice(i, 1);
    },
    /** Empty bin's digest half (`fake.ts` joins it to the files'): how many went. Not an `Api` method. */
    emptyDigestBin(): number {
      const n = bin.length;
      bin.length = 0;
      deletedCategories.length = 0;
      return n;
    },
  };

  /** The server's name rules (`categoryNameProblem`), and no second of a name but `self`'s own. */
  function checkName(name: string, self: string | null): string {
    if (categoryNameProblem(name) !== null) throw new ApiError("BAD_NAME", "a category name holds 1 to 150 characters", 400);
    const clean = name.trim();
    if (categories.some((c) => c.name === clean && c.uid !== self)) throw new ApiError("NAME_TAKEN", "a category with that name exists", 409);
    return clean;
  }

  /** The tablet sent its own copy back already: a live digest has its uid. */
  function isBack(b: Binned): boolean {
    return b.uid !== undefined && [...uids.entries()].some(([id, u]) => u === b.uid && digests.some((d) => d.id === id));
  }

  function binned(b: Binned): BinnedDigest {
    const d = b.digest;
    const name = [...categories, ...deletedCategories].find((c) => c.uid === d.categoryUid)?.name ?? null;
    return { id: d.id, text: d.text, categoryUid: d.categoryUid, categoryName: d.categoryUid === "" ? null : name, deletedAt: b.deletedAt, back: isBack(b) };
  }
}
