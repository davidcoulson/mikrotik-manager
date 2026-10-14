jest.mock('../../config/database');
// No Redis in tests: the throttle falls back to process memory.
jest.mock('../../config/redis', () => ({
  limiterRedis: () => ({
    eval: jest.fn().mockRejectedValue(new Error('down')),
    get: jest.fn().mockRejectedValue(new Error('down')),
    pttl: jest.fn().mockRejectedValue(new Error('down')),
    del: jest.fn().mockRejectedValue(new Error('down')),
    set: jest.fn().mockRejectedValue(new Error('down')),
  }),
}));
jest.mock('../../middleware/rateLimitRedis', () => ({
  loginRateLimit: () => (_q: unknown, _s: unknown, next: () => void) => next(),
  rateLimitRedis: () => (_q: unknown, _s: unknown, next: () => void) => next(),
}));
jest.mock('../../utils/passwordLogin', () => ({ passwordLoginEnabled: jest.fn().mockResolvedValue(true) }));
jest.mock('../../utils/sessionResponse', () => ({ sessionResponse: jest.fn().mockResolvedValue({ token: 'session' }) }));
jest.mock('../../utils/sessionState', () => ({ revokeSessionToken: jest.fn(), forgetSessionAccount: jest.fn(), validateSession: jest.fn() }));

import request from 'supertest';
import express from 'express';
import bcrypt from 'bcryptjs';
import * as OTPAuth from 'otpauth';
import authRoutes from '../auth';
import { queryOne } from '../../config/database';
import { signRawToken } from '../../middleware/auth';
import { sealTotpSecret } from '../../utils/totpSecret';
import { _resetAuthThrottleMemory } from '../../utils/authThrottle';

const mockedQueryOne = jest.mocked(queryOne);
const app = express();
app.use(express.json());
app.use('/', authRoutes);

const seed = new OTPAuth.Secret({ size: 20 }).base32;
const codeAt = (offsetSteps = 0) =>
  new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(seed), digits: 6, period: 30 })
    .generate({ timestamp: Date.now() + offsetSteps * 30_000 });
const partial = (jti = 'j1') => signRawToken({ userId: 7, partial: true, jti }, { expiresIn: '5m' });
const totpUser = (secret = sealTotpSecret(seed)) => ({
  id: 7, username: 'alice', role: 'admin', totp_secret: secret, totp_enabled: true, must_change_password: false,
});

beforeEach(() => {
  jest.clearAllMocks();
  _resetAuthThrottleMemory();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('POST /login', () => {
  it('answers 401, not 500, for an SSO-only account with no password hash', async () => {
    mockedQueryOne.mockResolvedValue({ id: 3, username: 'sso', password_hash: null, role: 'viewer', totp_enabled: false, must_change_password: false } as never);
    const res = await request(app).post('/login').send({ username: 'sso', password: 'whatever' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid credentials');
  });

  it('locks the account after repeated failures, whatever the source address', async () => {
    const hash = await bcrypt.hash('right-password', 4);
    mockedQueryOne.mockResolvedValue({ id: 1, username: 'bob', password_hash: hash, role: 'admin', totp_enabled: false, must_change_password: false } as never);
    for (let i = 0; i < 10; i++) {
      expect((await request(app).post('/login').send({ username: 'bob', password: 'bad' })).status).toBe(401);
    }
    const locked = await request(app).post('/login').send({ username: 'Bob', password: 'right-password' });
    expect(locked.status).toBe(429);
    expect(locked.headers['retry-after']).toBeDefined();
  });

  it('a successful login resets the failure count', async () => {
    const hash = await bcrypt.hash('right-password', 4);
    mockedQueryOne.mockResolvedValue({ id: 1, username: 'bob', password_hash: hash, role: 'admin', totp_enabled: false, must_change_password: false } as never);
    for (let i = 0; i < 9; i++) await request(app).post('/login').send({ username: 'bob', password: 'bad' });
    expect((await request(app).post('/login').send({ username: 'bob', password: 'right-password' })).status).toBe(200);
    for (let i = 0; i < 9; i++) {
      expect((await request(app).post('/login').send({ username: 'bob', password: 'bad' })).status).toBe(401);
    }
  });
});

describe('POST /totp/verify', () => {
  it('accepts a valid code and reads a legacy plaintext seed', async () => {
    mockedQueryOne.mockResolvedValue(totpUser(seed) as never);
    const res = await request(app).post('/totp/verify').send({ totp_token: partial(), code: codeAt() });
    expect(res.status).toBe(200);
  });

  it('rejects a replay of an accepted code, even with a fresh partial token', async () => {
    mockedQueryOne.mockResolvedValue(totpUser() as never);
    const code = codeAt();
    expect((await request(app).post('/totp/verify').send({ totp_token: partial('a'), code })).status).toBe(200);
    expect((await request(app).post('/totp/verify').send({ totp_token: partial('b'), code })).status).toBe(401);
  });

  it('a partial token is good for one session', async () => {
    mockedQueryOne.mockResolvedValue(totpUser() as never);
    const token = partial('single');
    expect((await request(app).post('/totp/verify').send({ totp_token: token, code: codeAt() })).status).toBe(200);
    // A different (next-step) code, same token.
    expect((await request(app).post('/totp/verify').send({ totp_token: token, code: codeAt(1) })).status).toBe(401);
  });

  it('burns the partial token after 5 wrong codes, even for a right one', async () => {
    mockedQueryOne.mockResolvedValue(totpUser() as never);
    const token = partial('guessy');
    for (let i = 0; i < 5; i++) {
      expect((await request(app).post('/totp/verify').send({ totp_token: token, code: '000000' })).status).toBe(401);
    }
    const res = await request(app).post('/totp/verify').send({ totp_token: token, code: codeAt() });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/expired/i);
  });

  it('caps wrong codes per account across partial tokens', async () => {
    mockedQueryOne.mockResolvedValue(totpUser() as never);
    for (let i = 0; i < 10; i++) {
      await request(app).post('/totp/verify').send({ totp_token: partial(`t${i}`), code: '000000' });
    }
    const res = await request(app).post('/totp/verify').send({ totp_token: partial('fresh'), code: codeAt() });
    expect(res.status).toBe(429);
  });
});
