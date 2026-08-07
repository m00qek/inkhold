// The login credential math, done entirely in the browser so the plaintext
// password never crosses the network.
//
//   stored credential = md5_hex(password)
//   login challenge   = sha256_hex(md5_hex(password) + randomCode)
//   change-password   = md5_hex(newPassword)
//
// Both digests are bundled (md5.ts, sha256.ts) and neither touches Web Crypto.
// `crypto.subtle` is only exposed in a *secure context*, which this deployment
// cannot offer: serving is deliberately plaintext HTTP, so a phone loading
// `http://<lan-ip>` would find `crypto.subtle` undefined and every login would
// fail. Keeping the credential path free of that dependency is the point — do
// not reintroduce `crypto.subtle` here.

import { md5Hex } from "./md5";
import { sha256Hex } from "./sha256";

export { md5Hex, sha256Hex };

/**
 * The device-compatible login challenge response for a plaintext password and a
 * server-issued single-use `randomCode`.
 *
 * Computed synchronously, but kept `async` so call sites are unaffected.
 */
export async function challengeHash(plaintext: string, randomCode: string): Promise<string> {
  return sha256Hex(md5Hex(plaintext) + randomCode);
}
