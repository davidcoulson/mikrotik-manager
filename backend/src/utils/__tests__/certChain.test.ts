import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { validateCertificateBundle } from '../certChain';

const dir = mkdtempSync(path.join(tmpdir(), 'chain-'));
const sh = (...args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
const read = (f: string) => readFileSync(path.join(dir, f), 'utf8');

let leaf: string, leafKey: string, ca: string, otherCa: string, otherKey: string;

beforeAll(() => {
  sh('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-subj', '/CN=Test CA', '-days', '2');
  sh('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'other.key', '-out', 'other.pem', '-subj', '/CN=Other CA', '-days', '2');
  sh('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'leaf.key', '-out', 'leaf.csr', '-subj', '/CN=leaf.example');
  writeFileSync(path.join(dir, 'ext.cnf'), 'basicConstraints=CA:FALSE\n');
  sh('x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'leaf.pem', '-days', '2', '-extfile', 'ext.cnf');
  leaf = read('leaf.pem'); leafKey = read('leaf.key'); ca = read('ca.pem'); otherCa = read('other.pem'); otherKey = read('other.key');
});

describe('validateCertificateBundle', () => {
  it('accepts a leaf alone and a leaf followed by its issuer', () => {
    expect(validateCertificateBundle(leaf, leafKey)).toBeNull();
    expect(validateCertificateBundle(leaf + ca, leafKey)).toBeNull();
  });
  it('rejects a good leaf followed by a malformed chain block', () => {
    const broken = leaf + '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n';
    expect(validateCertificateBundle(broken, leafKey)).toMatch(/Certificate 2 of 2/);
  });
  it('rejects stray data and an unrelated intermediate', () => {
    expect(validateCertificateBundle(leaf + 'junk', leafKey)).toMatch(/not a PEM certificate block/);
    expect(validateCertificateBundle(leaf + otherCa, leafKey)).toMatch(/not issued by/);
  });
  it('rejects a key that does not match the leaf', () => {
    expect(validateCertificateBundle(leaf + ca, otherKey)).toMatch(/does not match/);
  });
});
