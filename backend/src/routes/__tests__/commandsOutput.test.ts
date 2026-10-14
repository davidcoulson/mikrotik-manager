jest.mock('../../config/database');
jest.mock('../../config/redis', () => ({ redis: {} }));
jest.mock('../../services/CommandRunner', () => ({ commandRunner: { start: jest.fn(), cancel: jest.fn() } }));
jest.mock('../../middleware/auth', () => ({
  requireAuth: (_q: unknown, _s: unknown, next: () => void) => next(),
  requireWrite: (_q: unknown, _s: unknown, next: () => void) => next(),
  isSiteScoped: (u?: { siteRoles?: unknown }) => !!u?.siteRoles,
}));
jest.mock('../../middleware/site', () => ({ activeSite: () => null }));
jest.mock('../../utils/siteAccess', () => ({ devicesDenied: jest.fn().mockResolvedValue([]) }));

import request from 'supertest';
import express from 'express';
import commandsRoutes from '../commands';
import { query, queryOne } from '../../config/database';
import { devicesDenied } from '../../utils/siteAccess';

const mockedQuery = jest.mocked(query);
const mockedQueryOne = jest.mocked(queryOne);
const mockedDenied = jest.mocked(devicesDenied);

function makeApp(user: Record<string, unknown>) {
  const app = express();
  app.use((req, _res, next) => { (req as unknown as { user: unknown }).user = user; next(); });
  app.use('/', commandsRoutes);
  return app;
}

const deviceRows = [{ device_id: 1, device_name: 'r1', ip_address: '10.0.0.1', wave: 1, status: 'success', output: 'private-key=SECRET', error: 'boom' }];

beforeEach(() => {
  jest.resetAllMocks();
  mockedDenied.mockResolvedValue([]);
  mockedQueryOne.mockResolvedValue({ id: 5, name: 'n', command: '/export', status: 'success', created_at: new Date().toISOString() } as never);
  mockedQuery.mockResolvedValue(deviceRows as never);
});

// Auth review M3: device output can hold secrets the device printed itself.
describe('command run output access', () => {
  it('viewers (and read tokens) get status but no output', async () => {
    const res = await request(makeApp({ userId: -1, username: 'token:x', role: 'viewer', tokenAuth: true })).get('/runs/5');
    expect(res.status).toBe(200);
    expect(res.body.output_redacted).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('SECRET');
    expect(res.body.devices[0]).toMatchObject({ status: 'success', output: null, error: null });
  });

  it('operators get the output', async () => {
    const res = await request(makeApp({ userId: 2, username: 'op', role: 'operator' })).get('/runs/5');
    expect(res.body.output_redacted).toBe(false);
    expect(res.body.devices[0].output).toBe('private-key=SECRET');
  });

  it('refuses the CSV export to viewers', async () => {
    const res = await request(makeApp({ userId: 3, username: 'v', role: 'viewer' })).get('/runs/5/export');
    expect(res.status).toBe(403);
    expect(res.text).not.toContain('SECRET');
  });

  it('exports for operators', async () => {
    const res = await request(makeApp({ userId: 2, username: 'op', role: 'operator' })).get('/runs/5/export');
    expect(res.status).toBe(200);
    expect(res.text).toContain('SECRET');
  });

  it('a site-scoped operator who is only a viewer on a device sees no output', async () => {
    // Visible at viewer (first check), not at operator (output check).
    mockedDenied.mockResolvedValueOnce([]).mockResolvedValueOnce([1]);
    const res = await request(makeApp({ userId: 4, username: 'so', role: 'operator', siteRoles: { 1: 'viewer' } })).get('/runs/5');
    expect(res.status).toBe(200);
    expect(res.body.output_redacted).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('SECRET');
  });
});
