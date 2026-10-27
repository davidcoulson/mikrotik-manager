jest.mock('../../config/database');
jest.mock('../../services/WebhookService', () => ({ webhookService: {}, WEBHOOK_EVENTS: ['device_offline'] }));
jest.mock('../../services/ReportService', () => ({ reportService: {}, computeNextRun: jest.fn(), appTimezone: jest.fn() }));
jest.mock('../../middleware/auth', () => {
  const actual = jest.requireActual('../../middleware/auth');
  return { ...actual, requireAuth: (_req: unknown, _res: unknown, next: () => void) => next() };
});

import request from 'supertest';
import express from 'express';
import automation from '../automation';
import { query, queryOne } from '../../config/database';

const URL_WITH_TOKEN = 'https://hooks.slack.com/services/T000/B000/SECRETTOKEN';

function app(user: Record<string, unknown>) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => { (req as never as { user: unknown }).user = user; next(); });
  a.use('/api/automation', automation);
  return a;
}

beforeEach(() => {
  jest.mocked(query).mockReset().mockResolvedValue([{ id: 1, name: 'w', url: URL_WITH_TOKEN }] as never);
  jest.mocked(queryOne).mockReset().mockResolvedValue({ id: 1 } as never);
});

describe('webhook access (M4)', () => {
  it('shows the full URL to a fleet admin', async () => {
    const res = await request(app({ role: 'admin' })).get('/api/automation/webhooks');
    expect(res.body.webhooks[0].url).toBe(URL_WITH_TOKEN);
  });
  it('masks the token for viewers and operators; site-scoped accounts are refused', async () => {
    for (const user of [{ role: 'viewer' }, { role: 'operator' }]) {
      const res = await request(app(user)).get('/api/automation/webhooks');
      expect(JSON.stringify(res.body)).not.toContain('SECRETTOKEN');
      expect(res.body.webhooks[0].url).toMatch(/^https:\/\/hooks\.slack\.com\//);
    }
  });
  it('refuses a site-scoped admin the webhook list', async () => {
    const res = await request(app({ role: 'admin', siteRoles: { 1: 'admin' } })).get('/api/automation/webhooks');
    expect(res.status).toBe(403);
  });
  it('refuses site-scoped accounts on every webhook write', async () => {
    const scoped = app({ role: 'operator', siteRoles: { 1: 'operator' } });
    const body = { name: 'x', url: 'https://example.com/h', events: ['device_offline'] };
    expect((await request(scoped).post('/api/automation/webhooks').send(body)).status).toBe(403);
    expect((await request(scoped).put('/api/automation/webhooks/1').send({ enabled: false })).status).toBe(403);
    expect((await request(scoped).delete('/api/automation/webhooks/1')).status).toBe(403);
    expect((await request(scoped).post('/api/automation/webhooks/1/test')).status).toBe(403);
  });
  it('still lets a fleet operator write', async () => {
    const res = await request(app({ role: 'operator' })).put('/api/automation/webhooks/1').send({ enabled: false });
    expect(res.status).toBe(200);
  });
});
