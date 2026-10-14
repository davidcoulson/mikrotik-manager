// Scheduled email reports — periodic fleet summaries (device health, alerts,
// top clients, updates, backups) delivered over the SMTP settings of the first
// enabled email alert channel. An hourly scheduler sends whatever is due.

import { outageOverlapsSql, outageSecondsSql } from '../utils/outageWindow';
import { openConfig } from '../utils/alertChannelSecrets';
import nodemailer from 'nodemailer';
import { query, queryOne } from '../config/database';
import { escapeHtml } from '../utils/escapeHtml';

interface ScheduleRow {
  id: number; name: string; frequency: 'daily' | 'weekly' | 'monthly';
  recipients: string; enabled: boolean; next_run_at: string;
}

const PERIOD_DAYS: Record<string, number> = { daily: 1, weekly: 7, monthly: 30 };

interface WallClock { y: number; mo: number; d: number; h: number; mi: number; s: number }

function wallClock(date: Date, timeZone: string): WallClock {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(date).map((x) => [x.type, x.value]));
  return { y: Number(p.year), mo: Number(p.month), d: Number(p.day), h: Number(p.hour) % 24, mi: Number(p.minute), s: Number(p.second) };
}

/**
 * The instant at which `timeZone` shows the given wall-clock time. A time that
 * does not exist (skipped by the spring-forward change) lands just after the gap.
 */
function instantFromWallClock(w: WallClock, timeZone: string): Date {
  const asUtc = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
  const offsetAt = (ms: number) => {
    const seen = wallClock(new Date(ms), timeZone);
    return Date.UTC(seen.y, seen.mo - 1, seen.d, seen.h, seen.mi, seen.s) - Math.floor(ms / 1000) * 1000;
  };
  const DAY = 86_400_000;
  const before = offsetAt(asUtc - DAY);
  const after = offsetAt(asUtc + DAY);
  const candidates = [asUtc - before, asUtc - after].sort((a, b) => a - b);
  for (const c of candidates) {
    if (offsetAt(c) === asUtc - c) return new Date(c);
  }
  // In the gap: read the time with the pre-transition offset.
  return new Date(asUtc - before);
}

/**
 * The run after `from`. With `timeZone` (the app timezone) the time of day is
 * kept as wall-clock time in that zone and the monthly report goes out on the
 * 1st of that zone's month; without it the process timezone is used.
 */
export function computeNextRun(frequency: string, from: Date, timeZone?: string): Date {
  if (timeZone) {
    try {
      const w = wallClock(from, timeZone);
      if (frequency === 'monthly') {
        return instantFromWallClock({ ...w, mo: w.mo + 1, d: 1 }, timeZone);
      }
      const days = frequency === 'daily' ? 1 : 7;
      const day = new Date(Date.UTC(w.y, w.mo - 1, w.d + days));
      return instantFromWallClock(
        { ...w, y: day.getUTCFullYear(), mo: day.getUTCMonth() + 1, d: day.getUTCDate() }, timeZone);
    } catch { /* unknown zone name: fall through to the process timezone */ }
  }
  const next = new Date(from);
  if (frequency === 'daily') next.setDate(next.getDate() + 1);
  // Monthly reports go out on the 1st. setMonth(+1) from the 31st overflowed
  // past short months (31 January became 3 March), skipping February (J5).
  else if (frequency === 'monthly') return new Date(from.getFullYear(), from.getMonth() + 1, 1, from.getHours(), from.getMinutes(), from.getSeconds());
  else next.setDate(next.getDate() + 7);
  return next;
}

/**
 * Next run strictly after `now`, stepping from the previous scheduled time so
 * the time of day does not drift with when the hourly poll happened to run.
 */
export function advanceNextRun(frequency: string, previous: Date, now: Date, timeZone?: string): Date {
  let next = computeNextRun(frequency, previous, timeZone);
  for (let i = 0; i < 1000 && next <= now; i++) next = computeNextRun(frequency, next, timeZone);
  return next <= now ? computeNextRun(frequency, now, timeZone) : next;
}

/** Configured app timezone, or undefined when unset/invalid. */
export async function appTimezone(): Promise<string | undefined> {
  const rows = await query<{ value: unknown }>(`SELECT value FROM app_settings WHERE key = 'app_timezone'`).catch(() => []);
  const v = rows[0]?.value;
  const tz = typeof v === 'string' ? v : undefined;
  if (!tz) return undefined;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch { return undefined; }
}

const fmtBytes = (b: number) =>
  b >= 1024 ** 4 ? `${(b / 1024 ** 4).toFixed(2)} TB`
  : b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(2)} GB`
  : b >= 1024 ** 2 ? `${(b / 1024 ** 2).toFixed(1)} MB`
  : `${(b / 1024).toFixed(1)} KB`;

export class ReportService {
  private timer: ReturnType<typeof setInterval> | null = null;

  startScheduler(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.sendDue().catch(e => console.error('[Reports] scheduler error:', e));
    }, 60 * 60_000);
  }

  stopScheduler(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  private async sendDue(): Promise<void> {
    const due = await query<ScheduleRow>(
      `SELECT * FROM report_schedules WHERE enabled = TRUE AND next_run_at <= NOW()`);
    const tz = await appTimezone();
    for (const s of due) {
      const nextRun = () => advanceNextRun(s.frequency, new Date(s.next_run_at), new Date(), tz);
      try {
        await this.send(s);
        await query(
          `UPDATE report_schedules SET last_sent_at = NOW(), next_run_at = $2 WHERE id = $1`,
          [s.id, nextRun()]);
      } catch (e) {
        console.error(`[Reports] "${s.name}" failed:`, (e as Error).message);
        // push next_run_at forward anyway so a broken SMTP config doesn't retry hourly forever
        await query(`UPDATE report_schedules SET next_run_at = $2 WHERE id = $1`,
          [s.id, nextRun()]);
      }
    }
  }

  async send(schedule: Pick<ScheduleRow, 'name' | 'frequency' | 'recipients'>): Promise<void> {
    const smtp = await this.smtpConfig();
    const html = await this.buildHtml(schedule.frequency);
    const recipients = schedule.recipients.split(',').map(r => r.trim()).filter(Boolean);
    if (recipients.length === 0) throw new Error('No recipients configured');

    const transport = nodemailer.createTransport({
      host: smtp.host, port: smtp.port, secure: smtp.secure,
      tls: { rejectUnauthorized: !smtp.allowSelfSigned },
      auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
    });
    await transport.sendMail({
      from: smtp.from,
      to: recipients.join(', '),
      subject: `MikroTik Manager — ${schedule.frequency} network report`,
      html,
    });
    console.log(`[Reports] sent "${schedule.name}" to ${recipients.length} recipient(s)`);
  }

  // SMTP settings come from the first enabled email alert channel
  private async smtpConfig(): Promise<{ host: string; port: number; secure: boolean; allowSelfSigned: boolean; user?: string; pass?: string; from: string }> {
    const ch = await queryOne<{ config: Record<string, unknown> }>(
      `SELECT config FROM alert_channels WHERE type = 'email' AND enabled = TRUE ORDER BY id LIMIT 1`);
    // The SMTP password is stored encrypted (S7).
    const cfg = ch?.config ? openConfig('email', ch.config) : undefined;
    const host = cfg?.smtp_host as string | undefined;
    if (!host) throw new Error('No enabled email alert channel — configure one under Settings → Alerting to send reports');
    return {
      host,
      port: (cfg?.smtp_port as number) || 587,
      secure: !!cfg?.smtp_secure,
      allowSelfSigned: cfg?.smtp_allow_self_signed === true || cfg?.smtp_allow_self_signed === 'true',
      user: cfg?.smtp_user as string | undefined,
      pass: cfg?.smtp_pass as string | undefined,
      from: (cfg?.from_address as string) || (cfg?.smtp_user as string) || 'reports@mikrotik-manager',
    };
  }

  private async buildHtml(frequency: string): Promise<string> {
    const days = PERIOD_DAYS[frequency] ?? 7;
    const [devices, outages, alerts, topClients, backups] = await Promise.all([
      query<{ total: string; online: string; updates: string }>(
        `SELECT COUNT(*)::text AS total,
                COUNT(*) FILTER (WHERE status='online')::text AS online,
                COUNT(*) FILTER (WHERE firmware_update_available)::text AS updates
         FROM devices`),
      query<{ n: string; secs: string }>(
        // Every outage overlapping the period, clipped to it (P2-25).
        `SELECT COUNT(*)::text AS n, COALESCE(SUM(${outageSecondsSql(`($1 || ' days')::interval`)}),0)::bigint::text AS secs
         FROM device_availability WHERE ${outageOverlapsSql(`($1 || ' days')::interval`)}`, [days]),
      query<{ errors: string; warnings: string }>(
        // The severity test is in the WHERE too, so only error and warning rows are read
        // rather than every (mostly info) event of the period.
        `SELECT COUNT(*) FILTER (WHERE severity='error')::text AS errors,
                COUNT(*) FILTER (WHERE severity='warning')::text AS warnings
         FROM events WHERE severity IN ('error','warning') AND event_time > NOW() - ($1 || ' days')::interval`, [days]),
      query<{ name: string; bytes: string }>(
        // One name per MAC: joining every client row multiplied a MAC's bytes
        // by the number of devices that had seen it.
        `SELECT COALESCE(NULLIF(n.custom_name,''), NULLIF(n.hostname,''), t.mac_address) AS name,
                t.bytes::text AS bytes
         FROM (
           SELECT mac_address, SUM(upload_bytes + download_bytes) AS bytes
             FROM client_traffic_daily
            WHERE day > CURRENT_DATE - $1::int
              AND mac_address NOT IN ('unknown', 'other')
            GROUP BY mac_address
         ) t
         LEFT JOIN LATERAL (
           SELECT custom_name, hostname FROM clients c
            WHERE LOWER(c.mac_address) = t.mac_address
            ORDER BY last_seen DESC NULLS LAST LIMIT 1
         ) n ON TRUE
         ORDER BY t.bytes DESC LIMIT 5`, [days]),
      query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM backups WHERE created_at > NOW() - ($1 || ' days')::interval`, [days]),
    ]);

    const d = devices[0];
    const outageMin = Math.round(parseInt(outages[0]?.secs || '0', 10) / 60);
    const row = (label: string, value: string) =>
      `<tr><td style="padding:6px 12px;color:#64748b;">${escapeHtml(label)}</td><td style="padding:6px 12px;font-weight:600;color:#0f172a;">${escapeHtml(value)}</td></tr>`;

    const clientRows = topClients.map((c, i) =>
      `<tr><td style="padding:4px 12px;color:#64748b;">${i + 1}. ${escapeHtml(c.name)}</td><td style="padding:4px 12px;color:#0f172a;">${fmtBytes(parseInt(c.bytes, 10))}</td></tr>`).join('');

    return `
<div style="font-family:-apple-system,system-ui,sans-serif;max-width:560px;margin:0 auto;">
  <h2 style="color:#0f172a;">MikroTik Manager — ${escapeHtml(frequency)} report</h2>
  <p style="color:#64748b;font-size:13px;">Covering the last ${days} day${days !== 1 ? 's' : ''} · generated ${new Date().toUTCString()}</p>
  <table style="border-collapse:collapse;width:100%;background:#f8fafc;border-radius:8px;">
    ${row('Devices online', `${d?.online ?? 0} / ${d?.total ?? 0}`)}
    ${row('Outages', `${outages[0]?.n ?? 0} (${outageMin} min total downtime)`)}
    ${row('Error events', alerts[0]?.errors ?? '0')}
    ${row('Warning events', alerts[0]?.warnings ?? '0')}
    ${row('Firmware updates available', d?.updates ?? '0')}
    ${row('Backups taken', backups[0]?.n ?? '0')}
  </table>
  ${topClients.length ? `<h3 style="color:#0f172a;font-size:14px;margin-top:20px;">Top clients by traffic</h3>
  <table style="border-collapse:collapse;width:100%;background:#f8fafc;border-radius:8px;">${clientRows}</table>` : ''}
  <p style="color:#94a3b8;font-size:11px;margin-top:20px;">Sent by MikroTik Manager scheduled reports.</p>
</div>`;
  }
}

export const reportService = new ReportService();
