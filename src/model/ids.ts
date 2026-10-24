import { randomBytes } from 'node:crypto';
import type { MemoryId } from './types.ts';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

// A ULID: 48 bits of milliseconds then 80 random bits, in Crockford base32.
export function newMemoryId(now: number = Date.now()): MemoryId {
  let time = '';
  let ms = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[ms % 32] + time;
    ms = Math.floor(ms / 32);
  }
  const bytes = randomBytes(10);
  let bits = 0n;
  for (const byte of bytes) bits = (bits << 8n) | BigInt(byte);
  let random = '';
  for (let i = 0; i < 16; i++) {
    random = CROCKFORD[Number(bits & 31n)] + random;
    bits >>= 5n;
  }
  return time + random;
}

export function isMemoryId(value: unknown): value is MemoryId {
  return typeof value === 'string' && ULID_PATTERN.test(value);
}
