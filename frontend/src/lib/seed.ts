/**
 * ChemEx SEED values are unsigned 64-bit integers (0 ≤ seed ≤ 2^64 − 1).
 * JS `number` loses precision above 2^53, so seeds are carried as canonical
 * decimal strings everywhere in the method model and emitted as bare integers.
 */

export const MAX_SEED = (1n << 64n) - 1n;

/** A seed as stored in the method model: canonical decimal string. */
export type Seed = string;

const DECIMAL = /^\d+$/;

/** True for a canonical decimal string in [0, 2^64 − 1]. */
export function isValidSeed(value: unknown): value is Seed {
  if (typeof value !== 'string' || !DECIMAL.test(value)) return false;
  return BigInt(value) <= MAX_SEED;
}

/**
 * Normalise anything that may hold a seed (legacy numeric configs, BigInt from the
 * TOML reader, user text) to a canonical decimal string. Returns `undefined` for an
 * empty value, and the trimmed raw text when it is not a valid integer, so that
 * validation can report it instead of it being silently dropped.
 */
export function toSeed(value: unknown): Seed | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return String(value);
    return Number.isInteger(value) ? BigInt(value).toString() : String(value);
  }
  const s = String(value).trim();
  if (s === '') return undefined;
  if (DECIMAL.test(s)) return BigInt(s).toString(); // strips leading zeros
  return s;
}

/** Full-range random u64 seed from the platform CSPRNG. */
export function randomSeed(): Seed {
  const words = new Uint32Array(2);
  crypto.getRandomValues(words);
  return ((BigInt(words[0]) << 32n) | BigInt(words[1])).toString();
}

/** Validation message for an optional seed, or null when it is fine. */
export function seedError(value: unknown, required = false): string | null {
  if (value === undefined || value === null || value === '') {
    return required ? 'SEED is required (unsigned 64-bit integer).' : null;
  }
  return isValidSeed(value) ? null : `SEED must be an integer between 0 and ${MAX_SEED.toString()}.`;
}
