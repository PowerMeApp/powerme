import {
  generatePillarPassword,
  hashPillarPassword,
  verifyPillarPassword,
} from './pillar-credential';

describe('pillar credential (Security Profile 2, ADR-0011)', () => {
  it('generates 24-character URL-safe passwords (OCPP AuthorizationKey 16–40 chars), never twice the same', () => {
    const a = generatePillarPassword();
    const b = generatePillarPassword();
    expect(a).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(a).not.toBe(b);
  });

  it('stores a salted hash, not the password', async () => {
    const pw = generatePillarPassword();
    const h1 = await hashPillarPassword(pw);
    const h2 = await hashPillarPassword(pw);
    expect(h1.startsWith('scrypt$16384$8$1$')).toBe(true);
    expect(h1).not.toContain(pw);
    expect(h1).not.toBe(h2); // different salt
  });

  it('accepts the right password as string or Buffer (ocpp-rpc gives a Buffer)', async () => {
    const pw = generatePillarPassword();
    const h = await hashPillarPassword(pw);
    await expect(verifyPillarPassword(pw, h)).resolves.toBe(true);
    await expect(verifyPillarPassword(Buffer.from(pw, 'utf8'), h)).resolves.toBe(true);
  });

  it('rejects a wrong, missing or malformed credential', async () => {
    const h = await hashPillarPassword('correct-horse-battery-1');
    await expect(verifyPillarPassword('correct-horse-battery-2', h)).resolves.toBe(false);
    await expect(verifyPillarPassword(undefined, h)).resolves.toBe(false);
    await expect(verifyPillarPassword('x', 'argon2$whatever')).resolves.toBe(false);
    await expect(verifyPillarPassword('x', 'scrypt$0$8$1$AAAA$BBBB')).resolves.toBe(false);
  });
});
