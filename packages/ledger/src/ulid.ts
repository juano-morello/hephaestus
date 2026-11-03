import { randomBytes } from "node:crypto";

// Crockford base32, as in the ULID spec: 48-bit time (10 chars) + 80-bit randomness (16 chars).
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LEN = 10;
const RANDOM_LEN = 16;
const MAX_TIME = 2 ** 48 - 1;

export type UlidOptions = {
  now?: () => number;
  random?: (bytes: number) => Uint8Array;
};

function encodeTime(time: number): string {
  let out = "";
  let t = time;
  for (let i = 0; i < TIME_LEN; i++) {
    out = ALPHABET[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

/** 10 random bytes as 16 base32 digits (5 bits each, most significant first). */
function randomDigits(bytes: Uint8Array): number[] {
  let bits = 0n;
  for (const b of bytes) bits = (bits << 8n) | BigInt(b);
  return Array.from({ length: RANDOM_LEN }, (_, i) =>
    Number((bits >> BigInt(5 * (RANDOM_LEN - 1 - i))) & 31n),
  );
}

/**
 * Monotonic ULID generator: within one millisecond (or when the clock goes backwards) the
 * random part is incremented, so ids from one generator are strictly increasing.
 */
export function createUlid(opts: UlidOptions = {}): () => string {
  const now = opts.now ?? Date.now;
  const random = opts.random ?? ((n: number) => randomBytes(n));
  let lastTime = -1;
  let digits: number[] = [];

  return () => {
    const t = now();
    if (!Number.isInteger(t) || t < 0 || t > MAX_TIME) throw new Error("ulid: time out of range");
    if (t > lastTime) {
      lastTime = t;
      digits = randomDigits(random(10));
    } else {
      // Increment a copy so an overflow leaves the generator's state untouched.
      const next = [...digits];
      let i = RANDOM_LEN - 1;
      while (i >= 0 && next[i] === 31) next[i--] = 0;
      if (i < 0) throw new Error("ulid: random overflow");
      next[i] = (next[i] as number) + 1;
      digits = next;
    }
    return encodeTime(lastTime) + digits.map((d) => ALPHABET[d]).join("");
  };
}

export function decodeTime(id: string): number {
  let t = 0;
  for (const ch of id.slice(0, TIME_LEN)) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) throw new Error(`ulid: invalid character "${ch}"`);
    t = t * 32 + v;
  }
  return t;
}
