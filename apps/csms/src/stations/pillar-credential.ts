/**
 * Pillar credential for OCPP Security Profile 2 (HTTP Basic auth over TLS, ADR-0011).
 *
 * Why it exists: SD-5a issues one password per pillar at onboarding and shows it ONCE; only a
 * salted hash is stored in `charge_points.basic_auth_password_hash`. SD-5b verifies it at the
 * WebSocket upgrade.
 *
 * Hash = scrypt from `node:crypto` (memory-hard, no native dependency), stored as
 * `scrypt$N$r$p$<salt b64url>$<hash b64url>`. ADR-0011 and the schema comment say argon2; scrypt is
 * used so the CSMS keeps zero native add-ons on Windows dev machines. The format is self-describing,
 * so switching to argon2 later only needs a new prefix (decision for Trí, noted in the PR).
 *
 * OCPP 1.6 Security Whitepaper: AuthorizationKey is 16–40 characters. 18 random bytes in base64url
 * give 24 characters, ~144 bits of entropy.
 */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const N = 16384;
const R = 8;
const P = 1;
const KEY_LEN = 32;
const PREFIX = 'scrypt';

function scryptAsync(password: Buffer, salt: Buffer, n: number, r: number, p: number) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, KEY_LEN, { N: n, r, p, maxmem: 64 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

/** New random credential (plain text) — returned to the operator once, never stored. */
export function generatePillarPassword(): string {
  return randomBytes(18).toString('base64url');
}

export async function hashPillarPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(Buffer.from(password, 'utf8'), salt, N, R, P);
  return [PREFIX, N, R, P, salt.toString('base64url'), key.toString('base64url')].join('$');
}

/** Constant-time check. A malformed stored hash never matches. */
export async function verifyPillarPassword(
  password: Buffer | string | undefined | null,
  stored: string,
): Promise<boolean> {
  if (password === undefined || password === null) return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== PREFIX) return false;
  const [, nRaw, rRaw, pRaw, saltRaw, keyRaw] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const n = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (![n, r, p].every((x) => Number.isSafeInteger(x) && x > 0)) return false;
  const expected = Buffer.from(keyRaw, 'base64url');
  if (expected.length !== KEY_LEN) return false;
  const pw = typeof password === 'string' ? Buffer.from(password, 'utf8') : password;
  const actual = await scryptAsync(pw, Buffer.from(saltRaw, 'base64url'), n, r, p);
  return timingSafeEqual(actual, expected);
}
