import { isInternalOnlyAddress, resolveAlertTarget } from '../alertTarget';

describe('alert channel targets', () => {
  it('allows LAN addresses, since ntfy and Gotify are often self-hosted', () => {
    for (const ip of ['192.168.1.20', '10.0.0.5', '172.20.3.4', 'fd00::5', '203.0.113.9']) {
      expect(isInternalOnlyAddress(ip)).toBe(false);
    }
  });

  it('refuses loopback, link-local (cloud metadata), multicast and unspecified', () => {
    for (const ip of ['127.0.0.1', '169.254.169.254', '0.0.0.0', '224.0.0.1', '::1', 'fe80::1', '::ffff:127.0.0.1', 'ff02::1']) {
      expect(isInternalOnlyAddress(ip)).toBe(true);
    }
  });

  it('refuses loopback/metadata reached through IPv4-mapped, compatible and NAT64 IPv6 forms', async () => {
    const forms = [
      '::ffff:7f00:1', '::ffff:7f00:0001', '0:0:0:0:0:ffff:7f00:1', '::ffff:a9fe:a9fe', '::FFFF:127.0.0.1',
      '::7f00:1', '::127.0.0.1', '64:ff9b::7f00:1', '64:ff9b::169.254.169.254', '::ffff:0:0',
    ];
    for (const ip of forms) expect(isInternalOnlyAddress(ip)).toBe(true);
    // what WHATWG URL produces for http://[::ffff:127.0.0.1]/
    const host = new URL('http://[::ffff:127.0.0.1]/').hostname;
    await expect(resolveAlertTarget(host)).rejects.toThrow(/inside the manager/);
  });

  it('still allows a mapped LAN or public address', () => {
    for (const ip of ['::ffff:c0a8:114', '::ffff:192.168.1.20', '::ffff:cb00:709']) {
      expect(isInternalOnlyAddress(ip)).toBe(false);
    }
  });

  it("refuses this stack's own services by name", async () => {
    for (const host of ['influxdb', 'postgres', 'redis', 'backend', 'localhost', 'x.localhost']) {
      await expect(resolveAlertTarget(host)).rejects.toThrow(/inside the manager/);
    }
  });

  it('returns an allowed IP literal unchanged', async () => {
    await expect(resolveAlertTarget('192.168.1.20')).resolves.toBe('192.168.1.20');
    await expect(resolveAlertTarget('[fd00::5]')).resolves.toBe('fd00::5');
  });
});
