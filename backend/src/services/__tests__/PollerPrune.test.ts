import { PollerService } from '../PollerService';
import { query } from '../../config/database';

jest.mock('bullmq', () => ({ Queue: jest.fn(), Worker: jest.fn() }));
jest.mock('../../config/redis', () => ({ createRedisConnection: jest.fn(), redis: {} }));
jest.mock('../../config/influxdb', () => ({ getWriteApi: jest.fn() }));
jest.mock('../../config/database', () => ({ query: jest.fn(), queryOne: jest.fn(), pool: {} }));

const q = query as unknown as jest.Mock;
const svc = () => new PollerService() as unknown as {
  pruneProxyConnections(s: Record<string, unknown>): Promise<void>;
  pruneStaleClients(s: Record<string, unknown>): Promise<void>;
};

describe('PollerService pruning', () => {
  beforeEach(() => q.mockReset());

  it('deletes proxy connections in bounded batches and returns only counts', async () => {
    q.mockResolvedValueOnce([{ n: 20000 }]).mockResolvedValueOnce([{ n: 5 }]).mockResolvedValue([]);
    await svc().pruneProxyConnections({ retention_proxy_days: 30 });
    const deletes = q.mock.calls.filter(([t]) => String(t).includes('FROM proxy_connections'));
    expect(deletes).toHaveLength(2);
    for (const [t] of deletes) {
      expect(String(t)).toMatch(/LIMIT 20000/);
      expect(String(t)).not.toMatch(/RETURNING id/);
    }
  });

  it('never prunes clients that carry user-entered data', async () => {
    q.mockResolvedValue([{ count: '0' }]);
    await svc().pruneStaleClients({ retention_clients_days: 7 });
    const sql = String(q.mock.calls[0][0]);
    expect(sql).toMatch(/custom_name/);
    expect(sql).toMatch(/comment/);
    expect(sql).toMatch(/custom_category/);
  });
});
