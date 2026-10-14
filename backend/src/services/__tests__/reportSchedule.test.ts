import { computeNextRun, advanceNextRun } from '../ReportService';

jest.mock('../../config/database', () => ({ query: jest.fn(), queryOne: jest.fn() }));

// Outside review J5.
describe('computeNextRun', () => {
  it('never skips a short month', () => {
    const next = computeNextRun('monthly', new Date(2027, 0, 31, 7, 0, 0));
    expect([next.getFullYear(), next.getMonth(), next.getDate(), next.getHours()]).toEqual([2027, 1, 1, 7]);
  });
  it('runs monthly reports on the 1st, year boundary included', () => {
    const next = computeNextRun('monthly', new Date(2026, 11, 15, 6, 30));
    expect([next.getFullYear(), next.getMonth(), next.getDate()]).toEqual([2027, 0, 1]);
  });
  it('keeps daily and weekly as they were', () => {
    expect(computeNextRun('daily', new Date(2027, 1, 28)).getDate()).toBe(1);
    expect(computeNextRun('weekly', new Date(2027, 0, 1)).getDate()).toBe(8);
  });
});

describe('app timezone scheduling (M6)', () => {
  const LA = 'America/Los_Angeles';
  it('keeps the wall-clock hour in the app zone across a DST change', () => {
    // 07:00 PDT on 31 Oct 2026; DST ends 1 Nov, so the next 07:00 is 15:00Z.
    const next = computeNextRun('daily', new Date('2026-10-31T14:00:00Z'), LA);
    expect(next.toISOString()).toBe('2026-11-01T15:00:00.000Z');
  });
  it('goes out on the 1st of the month in the app zone, not UTC', () => {
    // 20:00 PST on 31 Jan is already 1 Feb in UTC; in the app zone the next
    // run is 1 Feb 20:00 PST, not 1 Mar.
    const next = computeNextRun('monthly', new Date('2027-02-01T04:00:00Z'), LA);
    expect(next.toISOString()).toBe('2027-02-02T04:00:00.000Z');
  });
  it('weekly moves 7 calendar days in the zone', () => {
    expect(computeNextRun('weekly', new Date('2026-09-02T09:30:00Z'), 'UTC').toISOString()).toBe('2026-09-09T09:30:00.000Z');
  });
  it('steps from the previous scheduled time, not from when it was sent', () => {
    const prev = new Date('2026-09-02T06:00:00Z');
    const now = new Date('2026-09-02T06:40:00Z');
    expect(advanceNextRun('daily', prev, now, 'UTC').toISOString()).toBe('2026-09-03T06:00:00.000Z');
  });
  it('skips missed runs after an outage, landing in the future', () => {
    const prev = new Date('2026-09-02T06:00:00Z');
    const now = new Date('2026-09-10T12:00:00Z');
    expect(advanceNextRun('daily', prev, now, 'UTC').toISOString()).toBe('2026-09-11T06:00:00.000Z');
  });
});

describe('report HTML escaping (M3)', () => {
  it('escapes client names that came from devices', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { query } = require('../../config/database') as { query: jest.Mock };
    const { reportService } = await import('../ReportService');
    query
      .mockResolvedValueOnce([{ total: '1', online: '1', updates: '0' }])
      .mockResolvedValueOnce([{ n: '0', secs: '0' }])
      .mockResolvedValueOnce([{ errors: '0', warnings: '0' }])
      .mockResolvedValueOnce([{ name: '<script>alert(1)</script>', bytes: '2048' }])
      .mockResolvedValueOnce([{ n: '0' }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const html: string = await (reportService as any).buildHtml('daily');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});
