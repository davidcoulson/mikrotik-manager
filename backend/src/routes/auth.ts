import { Router, Request, Response } from 'express';
import { revokeSessionToken, forgetSessionAccount } from '../utils/sessionState';
import bcrypt from 'bcryptjs';
import * as OTPAuth from 'otpauth';
import * as qrcode from 'qrcode';
import { query, queryOne } from '../config/database';
import { signRawToken, verifyRawToken, requireAuth } from '../middleware/auth';
import { getSecretsInfo, encryptionKeyMissing } from '../utils/secrets';
import { loginRateLimit, rateLimitRedis } from '../middleware/rateLimitRedis';
import { validatePassword } from '../utils/passwordPolicy';
import { sessionResponse } from '../utils/sessionResponse';
import { passwordLoginEnabled } from '../utils/passwordLogin';
import { sealTotpSecret, openTotpSecret } from '../utils/totpSecret';
import { randomBytes } from 'crypto';
import {
  bump, peek, clear, claimOnce, ttlSeconds, accountFailKey, totpUserFailKey, totpTokenFailKey,
  ACCOUNT_FAIL_MAX, ACCOUNT_FAIL_WINDOW_SEC, TOTP_USER_FAIL_MAX, TOTP_TOKEN_FAIL_MAX,
  PARTIAL_TOKEN_TTL_SEC, TOTP_REPLAY_TTL_SEC,
} from '../utils/authThrottle';

const router = Router();

// bcrypt hash of a random string nobody knows: compared against when the
// account has no local password, so timing matches a real attempt.
const DUMMY_HASH = '$2b$12$x1ShfS6ua.IHfzy/kdOkeuC0OtQwJzjRaIpYhRdUDBT7Ecg3cyyL2';

router.get(
  '/security-status',
  requireAuth,
  rateLimitRedis({ windowSec: 60, max: 10, keyPrefix: 'security-status', allMethods: true }),
  async (_req: Request, res: Response) => {
    const warnings: string[] = [];

    // Secrets self-heal to strong auto-generated values, so the only remaining
    // risk is an auto-generated secret that couldn't be persisted (it would
    // churn on restart) — surface that rather than "default".
    const secrets = getSecretsInfo();
    if (secrets.ephemeral) {
      warnings.push('secrets_not_persisted');
    }
    // Stored credentials no known key decrypts: the key was lost (P2-29).
    if (encryptionKeyMissing()) warnings.push('encryption_key_missing');

    const adminUser = await queryOne<{ password_hash: string | null }>(
      `SELECT password_hash FROM users WHERE username = 'admin' LIMIT 1`
    );
    if (adminUser?.password_hash && (await bcrypt.compare('admin', adminUser.password_hash))) {
      warnings.push('admin_password_default');
    }

    return res.json({ warnings });
  }
);

/**
 * A session for a user who has passed every login step. An account still on the
 * default password gets a session that can only change it (see requireAuth).
 */
// GET /api/auth/login-hints — public. Whether the login page should still show
// the default admin/admin credentials: only until that password is changed.
router.get('/login-hints', async (_req: Request, res: Response) => {
  const row = await queryOne<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM users WHERE username = 'admin' AND must_change_password = TRUE`
  ).catch(() => null);
  // password_login: false hides the username/password form for SSO-only
  // installs (#226).
  return res.json({ default_credentials: parseInt(row?.n ?? '0', 10) > 0, password_login: await passwordLoginEnabled() });
});

/** Refuse a password-based action while password sign-in is off (#226). */
async function refuseIfPasswordLoginOff(res: Response): Promise<boolean> {
  if (await passwordLoginEnabled()) return false;
  res.status(403).json({ error: 'Password sign-in is turned off on this server. Sign in with SSO.' });
  return true;
}

// lgtm[js/missing-rate-limiting] - loginRateLimit() middleware handles per-IP rate limiting
router.post('/login', loginRateLimit(), async (req: Request, res: Response) => {
  if (await refuseIfPasswordLoginOff(res)) return;
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const user = await queryOne<{
    id: number;
    username: string;
    password_hash: string | null;
    role: string;
    totp_enabled: boolean;
    must_change_password: boolean;
  }>(`SELECT id, username, password_hash, role, totp_enabled, must_change_password, session_version FROM users WHERE username = $1`, [username]);

  // Per-account cap on top of the per-IP one: a botnet guessing one account's
  // password is stopped here (auth review M2).
  const failKey = accountFailKey(String(username));
  if ((await peek(failKey)) >= ACCOUNT_FAIL_MAX) {
    res.setHeader('Retry-After', String(Math.max(1, await ttlSeconds(failKey))));
    return res.status(429).json({ error: 'Too many failed sign-in attempts for this account. Try again later.' });
  }

  // An account with no local password (SSO) must fail like a wrong password,
  // after the same bcrypt work, not crash bcrypt (and not reveal itself).
  const passwordOk = await bcrypt.compare(String(password), user?.password_hash || DUMMY_HASH);
  if (!user || !user.password_hash || !passwordOk) {
    await bump(failKey, ACCOUNT_FAIL_WINDOW_SEC);
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  await clear(failKey);

  if (user.totp_enabled) {
    // jti makes the partial token countable and single-use at /totp/verify.
    const totpToken = signRawToken(
      { userId: user.id, partial: true, jti: randomBytes(16).toString('hex') },
      { expiresIn: PARTIAL_TOKEN_TTL_SEC });
    return res.json({ requires_totp: true, totp_token: totpToken });
  }

  return res.json(await sessionResponse(user));
});

// Exchange partial TOTP token + code for a full session token
router.post('/totp/verify', rateLimitRedis({ windowSec: 60, max: 5, keyPrefix: 'totp-verify', allMethods: true }), async (req: Request, res: Response) => {
  if (await refuseIfPasswordLoginOff(res)) return;
  const { totp_token, code } = req.body as { totp_token?: string; code?: string };
  if (!totp_token || !code) {
    return res.status(400).json({ error: 'totp_token and code are required' });
  }
  let payload: { userId: number; partial: boolean; jti?: string };
  try {
    payload = verifyRawToken<{ userId: number; partial: boolean; jti?: string }>(totp_token);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired TOTP token' });
  }
  if (!payload.partial) {
    return res.status(401).json({ error: 'Invalid token type' });
  }

  const user = await queryOne<{ id: number; username: string; role: string; totp_secret: string | null; totp_enabled: boolean; must_change_password: boolean }>(
    `SELECT id, username, role, totp_secret, totp_enabled, must_change_password, session_version FROM users WHERE id = $1`,
    [payload.userId]
  );
  if (!user || !user.totp_enabled || !user.totp_secret) {
    return res.status(401).json({ error: 'TOTP not configured' });
  }

  // Attempt caps (auth review M2): per partial token and per account, so
  // distributing guesses over addresses does not help.
  const userFailKey = totpUserFailKey(user.id);
  const tokenFailKey = payload.jti ? totpTokenFailKey(payload.jti) : null;
  if ((await peek(userFailKey)) >= TOTP_USER_FAIL_MAX) {
    res.setHeader('Retry-After', String(Math.max(1, await ttlSeconds(userFailKey))));
    return res.status(429).json({ error: 'Too many failed codes for this account. Try again later.' });
  }
  if (tokenFailKey && (await peek(tokenFailKey)) >= TOTP_TOKEN_FAIL_MAX) {
    return res.status(401).json({ error: 'Invalid or expired TOTP token' });
  }

  const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(openTotpSecret(user.totp_secret)), digits: 6, period: 30 });
  const delta = totp.validate({ token: code.replace(/\s/g, ''), window: 1 });
  if (delta === null) {
    await bump(userFailKey, ACCOUNT_FAIL_WINDOW_SEC);
    if (tokenFailKey) await bump(tokenFailKey, PARTIAL_TOKEN_TTL_SEC);
    return res.status(401).json({ error: 'Invalid TOTP code' });
  }

  // A code is good once: a captured one cannot be replayed within its window,
  // and the partial token buys one session (auth review M2).
  const step = Math.floor(Date.now() / 30_000) + delta;
  const fresh = await claimOnce(`tu:${user.id}:${step}`, TOTP_REPLAY_TTL_SEC);
  const tokenFresh = payload.jti ? await claimOnce(`tj:${payload.jti}`, PARTIAL_TOKEN_TTL_SEC + 30) : true;
  if (!fresh || !tokenFresh) {
    await bump(userFailKey, ACCOUNT_FAIL_WINDOW_SEC);
    return res.status(401).json({ error: 'Invalid TOTP code' });
  }
  await clear(userFailKey);

  return res.json(await sessionResponse(user));
});

// Generate a new TOTP secret + QR code for the current user (does not enable yet).
// Requires the current password so a hijacked session can't enroll 2FA and lock
// the legitimate user out.
router.post('/totp/setup', requireAuth, async (req: Request, res: Response) => {
  if (await refuseIfPasswordLoginOff(res)) return;
  const { password } = req.body as { password?: string };
  if (!password) return res.status(400).json({ error: 'Current password is required to set up 2FA' });

  const account = await queryOne<{ password_hash: string | null }>(
    `SELECT password_hash FROM users WHERE id = $1`,
    [req.user!.userId]
  );
  if (!account?.password_hash) {
    return res.status(400).json({ error: 'This account has no local password (SSO). Set a password before enabling 2FA.' });
  }
  if (!(await bcrypt.compare(password, account.password_hash))) {
    return res.status(400).json({ error: 'Incorrect password', code: 'credential_rejected' });
  }

  const secret = new OTPAuth.Secret({ size: 20 });
  const totp = new OTPAuth.TOTP({
    issuer: 'MikroTik Manager',
    label: req.user!.username,
    secret,
    digits: 6,
    period: 30,
  });
  const uri = totp.toString();
  const qrDataUrl = await qrcode.toDataURL(uri);
  // Held as pending until a code from it is confirmed (outside review S1).
  // Writing it over totp_secret replaced a working authenticator the moment
  // setup was started, so an abandoned re-setup locked the user out.
  await query(`UPDATE users SET totp_pending_secret = $1 WHERE id = $2`, [sealTotpSecret(secret.base32), req.user!.userId]);
  return res.json({ secret: secret.base32, uri, qr: qrDataUrl });
});

// Credential re-checks inside a signed-in session answer 400, not 401: the
// client treats 401 as "session over" and signed the user out over a typo
// (outside review U8).

// Confirm the TOTP setup by validating a code — enables TOTP
router.post('/totp/confirm', requireAuth, async (req: Request, res: Response) => {
  if (await refuseIfPasswordLoginOff(res)) return;
  const { code } = req.body as { code?: string };
  if (!code) return res.status(400).json({ error: 'code is required' });

  const user = await queryOne<{ totp_pending_secret: string | null }>(
    `SELECT totp_pending_secret FROM users WHERE id = $1`,
    [req.user!.userId]
  );
  if (!user?.totp_pending_secret) return res.status(400).json({ error: 'Run /totp/setup first' });

  const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(openTotpSecret(user.totp_pending_secret)), digits: 6, period: 30 });
  const delta = totp.validate({ token: code.replace(/\s/g, ''), window: 1 });
  if (delta === null) return res.status(400).json({ error: 'Invalid code', code: 'credential_rejected' });

  // Only now does the new authenticator replace the old one.
  await query(
    `UPDATE users SET totp_secret = totp_pending_secret, totp_pending_secret = NULL, totp_enabled = true WHERE id = $1`,
    [req.user!.userId]);
  return res.json({ ok: true });
});

// Disable TOTP — requires password confirmation
router.post('/totp/disable', requireAuth, async (req: Request, res: Response) => {
  if (await refuseIfPasswordLoginOff(res)) return;
  const { password } = req.body as { password?: string };
  if (!password) return res.status(400).json({ error: 'password is required' });

  const user = await queryOne<{ password_hash: string | null }>(
    `SELECT password_hash FROM users WHERE id = $1`,
    [req.user!.userId]
  );
  if (!user?.password_hash || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(400).json({ error: 'Incorrect password', code: 'credential_rejected' });
  }

  await query(`UPDATE users SET totp_enabled = false, totp_secret = NULL, totp_pending_secret = NULL WHERE id = $1`, [req.user!.userId]);
  return res.json({ ok: true });
});

// Return current TOTP status for the authenticated user
router.get('/totp/status', requireAuth, async (req: Request, res: Response) => {
  const user = await queryOne<{ totp_enabled: boolean }>(
    `SELECT totp_enabled FROM users WHERE id = $1`,
    [req.user!.userId]
  );
  return res.json({ totp_enabled: user?.totp_enabled ?? false });
});

router.get('/me', requireAuth, (req: Request, res: Response) => {
  res.json({ user: req.user });
});

// Ends this session on the server too; before, only the browser's copy was
// discarded and the token kept working for the rest of its 24 hours (P2-1).
router.post('/logout', requireAuth, async (req: Request, res: Response) => {
  await revokeSessionToken(req.user!);
  res.json({ message: 'Logged out' });
});

router.put('/password', requireAuth, async (req: Request, res: Response) => {
  if (await refuseIfPasswordLoginOff(res)) return;
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current and new password required' });
  }
  const pwError = validatePassword(newPassword);
  if (pwError) {
    return res.status(400).json({ error: pwError });
  }

  const user = await queryOne<{ id: number; password_hash: string | null }>(
    `SELECT id, password_hash FROM users WHERE id = $1`,
    [req.user!.userId]
  );

  if (!user?.password_hash || !(await bcrypt.compare(currentPassword, user.password_hash))) {
    return res.status(400).json({ error: 'Current password is incorrect', code: 'credential_rejected' });
  }
  if (newPassword === currentPassword) {
    return res.status(400).json({ error: 'The new password must be different from the current one' });
  }

  const hash = await bcrypt.hash(newPassword, 12);
  // Changing the password ends every other session on the account, including
  // one someone else may have started with the old password (P2-1). This
  // request gets a fresh session under the new version.
  const updated = await queryOne<{ id: number; username: string; role: string; must_change_password: boolean; session_version: number }>(
    `UPDATE users SET password_hash = $1, must_change_password = FALSE, session_version = session_version + 1 WHERE id = $2
     RETURNING id, username, role, must_change_password, session_version`,
    [hash, req.user!.userId]
  );
  forgetSessionAccount(req.user!.userId);
  return res.json({ message: 'Password updated', ...(updated ? await sessionResponse(updated) : {}) });
});

export default router;
