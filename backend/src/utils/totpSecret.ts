/**
 * TOTP seeds are stored encrypted with the manager's key, like every other
 * secret (auth review M1). Rows written before that hold the bare base32 seed;
 * those still read, and are sealed at startup (sealPlaintextTotpSecrets).
 */
import { encrypt, decrypt } from './crypto';

/** iv:tag:ciphertext, all hex. Base32 seeds never contain ':'. */
const ENCRYPTED_FORM = /^[0-9a-f]{32}:[0-9a-f]{32}:[0-9a-f]*$/;

export function isEncryptedTotpSecret(stored: string): boolean {
  return ENCRYPTED_FORM.test(stored);
}

export function sealTotpSecret(base32: string): string {
  return encrypt(base32);
}

/** The base32 seed, whether the row is encrypted or still legacy plaintext. */
export function openTotpSecret(stored: string): string {
  return isEncryptedTotpSecret(stored) ? decrypt(stored) : stored;
}
