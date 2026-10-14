jest.mock('../../config/database');
jest.mock('../../middleware/auth', () => ({
  requireAuth: (_r: unknown, _s: unknown, n: () => void) => n(),
  requireWrite: (_r: unknown, _s: unknown, n: () => void) => n(),
  requireAdmin: (_r: unknown, _s: unknown, n: () => void) => n(),
  fleetOnly: (_r: unknown, _s: unknown, n: () => void) => n(),
}));

import request from 'supertest';
import express from 'express';
import alerts from '../alerts';
import { alertService } from '../../services/AlertService';

jest.spyOn(alertService, 'upsertRule').mockResolvedValue({ event_type: 'device_offline', enabled: true } as never);

const app = () => { const a = express(); a.use(express.json()); a.use('/api/alerts', alerts); return a; };

describe('PUT /api/alerts/rules/:type cooldown_min (L2)', () => {
  it.each([[-1], [1.5], ['abc'], [10081], [null]])('rejects %p', async (v) => {
    const res = await request(app()).put('/api/alerts/rules/device_offline').send({ cooldown_min: v });
    expect(res.status).toBe(400);
  });
  it('accepts 0 and 10080', async () => {
    for (const v of [0, 10080, 15]) {
      const res = await request(app()).put('/api/alerts/rules/device_offline').send({ cooldown_min: v });
      expect(res.status).toBe(200);
    }
  });
});
