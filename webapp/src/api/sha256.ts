// SHA-256 — compact, dependency-free implementation of the FIPS 180-4 digest.
//
// Why this exists: the login challenge is `sha256_hex(md5_hex(password) +
// randomCode)` and it has to be computable in the browser. Web Crypto's
// `crypto.subtle` offers SHA-256 but is only exposed in a *secure context*, and
// this deployment is deliberately plaintext HTTP (the Nomad requires it, and
// single-port serving means the browser shares that listener). A phone on the
// LAN therefore has no `crypto.subtle` at all, so we bundle the routine — the
// same reason md5.ts is bundled, arrived at from the opposite direction.
//
// The plaintext password is hashed here in the browser and never leaves it.
//
// Algorithm: the FIPS 180-4 reference, operating directly on a byte array (so
// UTF-8 inputs hash correctly). All arithmetic is kept inside the 32-bit signed
// range with `| 0`; intermediate sums of at most eight 32-bit terms stay well
// under 2^53 and so are exact before truncation.

// Round constants: the first 32 bits of the fractional parts of the cube roots
// of the first 64 primes (FIPS 180-4 §4.2.2).
const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

// Initial state: the first 32 bits of the fractional parts of the square roots
// of the first 8 primes (FIPS 180-4 §5.3.3).
const INIT = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

/**
 * Appends the FIPS 180-4 padding: the 0x80 marker, zeroes, and the 64-bit
 * big-endian bit length, rounded up to a whole number of 64-byte blocks. When
 * the marker leaves fewer than 8 spare bytes (message length 56..63 mod 64) the
 * round-up adds an extra block, which is where the length then lives.
 */
function pad(bytes: Uint8Array): Uint8Array {
  const n = bytes.length;
  const total = ((n + 9 + 63) >> 6) << 6; // n + marker + 8 length bytes, to a block boundary
  const out = new Uint8Array(total);
  out.set(bytes);
  out[n] = 0x80;

  // Bit length as two 32-bit halves. `n * 8` is exact for any length a browser
  // can hold, and ToUint32 (`>>> 0`) takes the low half modulo 2^32.
  const hi = Math.floor(n / 0x20000000); // = floor(n * 8 / 2^32)
  const lo = (n * 8) >>> 0;
  for (let i = 0; i < 4; i++) {
    out[total - 8 + i] = (hi >>> ((3 - i) * 8)) & 0xff;
    out[total - 4 + i] = (lo >>> ((3 - i) * 8)) & 0xff;
  }
  return out;
}

function sha256(bytes: Uint8Array): number[] {
  const msg = pad(bytes);
  const state = [...INIT];
  const w = new Array<number>(64);

  for (let off = 0; off < msg.length; off += 64) {
    // The block as sixteen big-endian 32-bit words, then extended to 64.
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      w[i] = (msg[j]! << 24) | (msg[j + 1]! << 16) | (msg[j + 2]! << 8) | msg[j + 3]!;
    }
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15]!;
      const y = w[i - 2]!;
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) | 0;
    }

    let a = state[0]!, b = state[1]!, c = state[2]!, d = state[3]!;
    let e = state[4]!, f = state[5]!, g = state[6]!, h = state[7]!;

    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + s1 + ch + K[i]! + w[i]!) | 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) | 0;

      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }

    state[0] = (state[0]! + a) | 0;
    state[1] = (state[1]! + b) | 0;
    state[2] = (state[2]! + c) | 0;
    state[3] = (state[3]! + d) | 0;
    state[4] = (state[4]! + e) | 0;
    state[5] = (state[5]! + f) | 0;
    state[6] = (state[6]! + g) | 0;
    state[7] = (state[7]! + h) | 0;
  }

  return state;
}

function toHex(state: number[]): string {
  let out = "";
  for (const word of state) {
    for (let b = 3; b >= 0; b--) {
      out += ((word >>> (b * 8)) & 0xff).toString(16).padStart(2, "0");
    }
  }
  return out;
}

const utf8 = new TextEncoder();

/** Lowercase 64-char SHA-256 hex digest of a UTF-8 string. */
export function sha256Hex(text: string): string {
  return toHex(sha256(utf8.encode(text)));
}
