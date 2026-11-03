// Login credential math, in the browser so the plaintext password never leaves it:
//   stored = md5_hex(pw); challenge = sha256_hex(md5_hex(pw) + randomCode).
// No `crypto.subtle`: it needs a secure context and this is served over plain HTTP.

import { md5Hex } from "./md5";
import { sha256Hex } from "./sha256";

export { md5Hex, sha256Hex };

/** Device-compatible login challenge response; `async` only for call-site compatibility. */
export async function challengeHash(plaintext: string, randomCode: string): Promise<string> {
  return sha256Hex(md5Hex(plaintext) + randomCode);
}
