jest.mock('../../config/database');
jest.mock('../../config/redis', () => ({ redis: {} }));
jest.mock('../../middleware/auth', () => ({
  requireAuth: (_q: unknown, _s: unknown, next: () => void) => next(),
  requireAdmin: (_q: unknown, _s: unknown, next: () => void) => next(),
  requireWrite: (_q: unknown, _s: unknown, next: () => void) => next(),
}));
jest.mock('../../services/WebhookService', () => ({ webhookService: {}, WEBHOOK_EVENTS: [] }));
jest.mock('../../services/ReportService', () => ({ reportService: {}, computeNextRun: jest.fn() }));

import request from 'supertest';
import express from 'express';
import automationRoutes from '../automation';
import { queryOne } from '../../config/database';

const mockedQueryOne = jest.mocked(queryOne);
const app = express();
app.use(express.json());
app.use('/', automationRoutes);

const DAY = 86_400_000;
const storedExpiry = () => (mockedQueryOne.mock.calls[0][1] as unknown[])[5] as string | null;

beforeEach(() => {
  jest.resetAllMocks();
  mockedQueryOne.mockResolvedValue({ id: 1 } as never);
});

// Auth review M4: a write token is fleet-wide command execution.
describe('POST /tokens expiry', () => {
  it('gives a write token a 90-day expiry by default, with a warning', async () => {
    const res = await request(app).post('/tokens').send({ name: 'ci', scope: 'write' });
    expect(res.status).toBe(201);
    const days = (new Date(storedExpiry()!).getTime() - Date.now()) / DAY;
    expect(days).toBeGreaterThan(89);
    expect(days).toBeLessThan(91);
    expect(res.body.expires_at).toBe(storedExpiry());
    expect(res.body.warning).toMatch(/every device/);
  });

  it('refuses a never-expiring write token without an explicit acknowledgement', async () => {
    for (const body of [{ expires_days: 0 }, { no_expiry: true }, { no_expiry: true, acknowledge_risk: false }]) {
      const res = await request(app).post('/tokens').send({ name: 'ci', scope: 'write', ...body });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('token_risk_not_acknowledged');
    }
    expect(mockedQueryOne).not.toHaveBeenCalled();
  });

  it('allows it when acknowledged', async () => {
    const res = await request(app).post('/tokens').send({ name: 'ci', scope: 'write', no_expiry: true, acknowledge_risk: true });
    expect(res.status).toBe(201);
    expect(storedExpiry()).toBeNull();
  });

  it('caps an explicit write expiry at a year', async () => {
    expect((await request(app).post('/tokens').send({ name: 'ci', scope: 'write', expires_days: 366 })).status).toBe(400);
    expect((await request(app).post('/tokens').send({ name: 'ci', scope: 'write', expires_days: 30 })).status).toBe(201);
  });

  it('leaves read tokens as they were', async () => {
    const res = await request(app).post('/tokens').send({ name: 'mon', scope: 'read' });
    expect(res.status).toBe(201);
    expect(storedExpiry()).toBeNull();
    expect(res.body.warning).toBeUndefined();
  });
});
