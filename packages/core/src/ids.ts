import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A ULID: 48-bit millisecond timestamp + 80 bits of randomness, Crockford base32, sortable. */
export function ulid(now: number = Date.now()): string {
  let t = now;
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32]! + time;
    t = Math.floor(t / 32);
  }
  const rand = randomBytes(16);
  let r = '';
  for (let i = 0; i < 16; i++) r += ALPHABET[rand[i]! % 32];
  return time + r;
}

export const nowIso = (): string => new Date().toISOString();
