import crypto from 'crypto';

const BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;

/**
 * Check an uploaded PEM bundle as a whole: every block must parse, nothing but
 * whitespace may sit between or after them, each certificate must be issued by
 * the next (leaf first, as nginx expects), and the private key must belong to
 * the leaf. Returns an error message, or null when the bundle is usable.
 */
export function validateCertificateBundle(certificate: string, privateKey: string): string | null {
  const blocks = certificate.match(BLOCK) ?? [];
  if (blocks.length === 0) return 'certificate does not appear to be a valid PEM certificate';
  // Text between blocks (OpenSSL "Bag Attributes", subject=/issuer= lines) is
  // ignored by nginx, but a stray or mangled PEM block is not.
  if (/-----(BEGIN|END) /.test(certificate.replace(BLOCK, ''))) {
    return 'certificate contains a PEM block that is not a valid certificate';
  }

  const certs: crypto.X509Certificate[] = [];
  for (let i = 0; i < blocks.length; i++) {
    try {
      certs.push(new crypto.X509Certificate(blocks[i]));
    } catch {
      return `Certificate ${i + 1} of ${blocks.length} in the file could not be parsed`;
    }
  }
  for (let i = 0; i + 1 < certs.length; i++) {
    if (!certs[i].checkIssued(certs[i + 1])) {
      return `Certificate ${i + 1} was not issued by certificate ${i + 2} — put the server certificate first, then its intermediates in order`;
    }
  }

  try {
    const key = crypto.createPrivateKey(privateKey);
    const sign = crypto.createSign('SHA256');
    sign.update('mikrotik-manager-cert-verify');
    const signature = sign.sign(key);
    const verify = crypto.createVerify('SHA256');
    verify.update('mikrotik-manager-cert-verify');
    if (!verify.verify(certs[0].publicKey, signature)) return 'Private key does not match the certificate';
  } catch (err) {
    return `Key/certificate validation failed: ${err instanceof Error ? err.message : String(err)}`;
  }
  return null;
}
