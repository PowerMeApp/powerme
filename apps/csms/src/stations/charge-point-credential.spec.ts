import {
  generateChargePointPassword,
  hashChargePointPassword,
  verifyChargePointPassword,
} from './charge-point-credential';

describe('charge point credential (Security Profile 2, ADR-0011)', () => {
  it('generates 24-character URL-safe passwords (OCPP AuthorizationKey 16–40 chars), never twice the same', () => {
    const a = generateChargePointPassword();
    const b = generateChargePointPassword();
    expect(a).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(a).not.toBe(b);
  });

  it('stores a salted hash, not the password', async () => {
    const pw = generateChargePointPassword();
    const h1 = await hashChargePointPassword(pw);
    const h2 = await hashChargePointPassword(pw);
    expect(h1.startsWith('scrypt$16384$8$1$')).toBe(true);
    expect(h1).not.toContain(pw);
    expect(h1).not.toBe(h2); // different salt
  });

  it('accepts the right password as string or Buffer (ocpp-rpc gives a Buffer)', async () => {
    const pw = generateChargePointPassword();
    const h = await hashChargePointPassword(pw);
    await expect(verifyChargePointPassword(pw, h)).resolves.toBe(true);
    await expect(verifyChargePointPassword(Buffer.from(pw, 'utf8'), h)).resolves.toBe(true);
  });

  it('rejects a wrong, missing or malformed credential', async () => {
    const h = await hashChargePointPassword('correct-horse-battery-1');
    await expect(verifyChargePointPassword('correct-horse-battery-2', h)).resolves.toBe(false);
    await expect(verifyChargePointPassword(undefined, h)).resolves.toBe(false);
    await expect(verifyChargePointPassword('x', 'argon2$whatever')).resolves.toBe(false);
    await expect(verifyChargePointPassword('x', 'scrypt$0$8$1$AAAA$BBBB')).resolves.toBe(false);
  });
});
