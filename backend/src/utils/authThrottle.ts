/**
 * Per-account sign-in throttling and one-time claims (auth review M2).
 *
 * The per-IP limiters stop one address, not a botnet guessing a single
 * account's password or 6-digit code. These counters are keyed by account (or
 * by partial-token id), live in Redis so replicas share them, and fall back to
 * process memory while Redis is unreachable, like the IP limiters.
 */
import { limiterRedis } from '../config/redis';

const mem = new Map<string, { n: number; exp: number }>();
let lastSweep = 0;

function sweep(now: number): void {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [k, v] of mem) if (v.exp <= now) mem.delete(k);
}

function memGet(key: string, now = Date.now()): { n: number; exp: number } | undefined {
  sweep(now);
  const v = mem.get(key);
  return v && v.exp > now ? v : undefined;
}

// INCR + expiry in one step so a counter can never outlive its window.
const BUMP = `
local n = redis.call('INCR', KEYS[1])
if redis.call('PTTL', KEYS[1]) < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return n
`;

/** Count one event for `key`; the window starts at the first event. */
export async function bump(key: string, windowSec: number): Promise<number> {
  try {
    return Number(await limiterRedis().eval(BUMP, 1, key, String(windowSec * 1000)));
  } catch {
    const now = Date.now();
    const cur = memGet(key, now) ?? { n: 0, exp: now + windowSec * 1000 };
    cur.n += 1;
    mem.set(key, cur);
    return cur.n;
  }
}

/** Events counted for `key` in its current window. */
export async function peek(key: string): Promise<number> {
  try {
    return Number((await limiterRedis().get(key)) ?? 0);
  } catch {
    return memGet(key)?.n ?? 0;
  }
}

/** Seconds until `key` resets (0 when unset). */
export async function ttlSeconds(key: string): Promise<number> {
  try {
    const ms = await limiterRedis().pttl(key);
    return ms > 0 ? Math.ceil(ms / 1000) : 0;
  } catch {
    const v = memGet(key);
    return v ? Math.ceil((v.exp - Date.now()) / 1000) : 0;
  }
}

export async function clear(key: string): Promise<void> {
  mem.delete(key);
  try { await limiterRedis().del(key); } catch { /* memory already cleared */ }
}

/** True the first time `key` is claimed within `ttlSec`, false for every later try. */
export async function claimOnce(key: string, ttlSec: number): Promise<boolean> {
  try {
    return (await limiterRedis().set(key, '1', 'EX', ttlSec, 'NX')) === 'OK';
  } catch {
    const now = Date.now();
    if (memGet(key, now)) return false;
    mem.set(key, { n: 1, exp: now + ttlSec * 1000 });
    return true;
  }
}

/** Test hook. */
export function _resetAuthThrottleMemory(): void {
  mem.clear();
}

// Wrong passwords per account, and wrong second-factor codes per account / per
// partial token, before sign-in is refused for the rest of the window.
export const ACCOUNT_FAIL_MAX = 10;
export const ACCOUNT_FAIL_WINDOW_SEC = 15 * 60;
export const TOTP_USER_FAIL_MAX = 10;
export const TOTP_TOKEN_FAIL_MAX = 5;
export const PARTIAL_TOKEN_TTL_SEC = 5 * 60;
/** A TOTP step is 30 s and the window is +-1, so a code is valid for at most 90 s. */
export const TOTP_REPLAY_TTL_SEC = 120;

export const accountFailKey = (username: string): string => `af:${username.toLowerCase().slice(0, 128)}`;
export const totpUserFailKey = (userId: number): string => `tf:u:${userId}`;
export const totpTokenFailKey = (jti: string): string => `tf:j:${jti}`;
