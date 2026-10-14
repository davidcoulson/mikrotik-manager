import { openTotpSecret, sealTotpSecret, isEncryptedTotpSecret } from '../../utils/totpSecret';
import { sealPlaintextSecrets } from '../encryptedData';
import { query } from '../../config/database';

jest.mock('../../config/database', () => ({ query: jest.fn() }));
const mockQuery = query as jest.MockedFunction<typeof query>;

// Auth review M1: TOTP seeds encrypted at rest, legacy plaintext still readable.
describe('TOTP seed storage', () => {
  const seed = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

  it('round-trips through the encrypted form', () => {
    const stored = sealTotpSecret(seed);
    expect(stored).not.toContain(seed);
    expect(isEncryptedTotpSecret(stored)).toBe(true);
    expect(openTotpSecret(stored)).toBe(seed);
  });

  it('still reads a legacy plaintext seed', () => {
    expect(isEncryptedTotpSecret(seed)).toBe(false);
    expect(openTotpSecret(seed)).toBe(seed);
  });

  it('startup sweep encrypts only the plaintext seeds', async () => {
    const already = sealTotpSecret(seed);
    mockQuery.mockImplementation((async (sql: string) => {
      if (/SELECT id, totp_secret AS value FROM users/.test(sql)) return [{ id: 1, value: seed }, { id: 2, value: already }];
      return [];
    }) as never);
    expect(await sealPlaintextSecrets()).toBe(1);
    const updates = mockQuery.mock.calls.filter((c) => /^UPDATE users SET totp_secret/.test(String(c[0])));
    expect(updates).toHaveLength(1);
    const [, params] = updates[0] as [string, unknown[]];
    expect(params[1]).toBe(1);
    expect(isEncryptedTotpSecret(String(params[0]))).toBe(true);
    expect(openTotpSecret(String(params[0]))).toBe(seed);
  });
});
