// The fake API's stand-in for a content md5, on its own so the demo server
// (`vite.config.ts`) can name the same files the fake library does.

/** Deterministic pseudo-hash from a seed — stands in for a real content md5. */
export function fakeHash(seed: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0").repeat(4); // 32 hex chars, md5-shaped
}

/** A fixture's whole-file `fileHash`, which keys its `/thumbnail/{hash}`. */
export function fakeFileHash(id: string): string {
  return fakeHash(`${id}:file`);
}
