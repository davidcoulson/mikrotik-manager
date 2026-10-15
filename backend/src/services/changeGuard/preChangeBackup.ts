import { queryOne } from '../../config/database';

/** A backup this recent already covers the device; don't export again. */
const FRESH_MINUTES = 10;
/** Never hold the device lock (or the operator) for longer than this. */
const BUDGET_MS = 60_000;

/** Kinds that take their own backup or are themselves a restore. */
function skipKind(kind: string): boolean {
  return kind.startsWith('backup.') || kind.startsWith('firmware');
}

/**
 * Save a listed, downloadable backup of the device before a guarded change.
 *
 * Change Guard's own restore point lives on the device and is deleted once the
 * change is confirmed; this one stays in the Backups list. Best effort: a
 * device without SSH access, or an export that is slow, never blocks the change.
 */
export async function backupBeforeChange(deviceId: number, kind: string, summary: string): Promise<void> {
  try {
    if (skipKind(kind)) return;
    const flag = await queryOne<{ value: unknown }>(
      `SELECT value FROM app_settings WHERE key = 'pre_change_backup_enabled'`
    ).catch(() => null);
    if (flag && flag.value === false) return;

    const recent = await queryOne<{ id: number }>(
      `SELECT id FROM backups WHERE device_id = $1
         AND created_at > NOW() - ($2 || ' minutes')::interval LIMIT 1`,
      [deviceId, String(FRESH_MINUTES)]
    ).catch(() => null);
    if (recent) return;

    const device = await queryOne<{
      id: number; name: string; ip_address: string; ssh_port: number;
      ssh_username: string; ssh_password_encrypted: string;
      api_username: string; api_password_encrypted: string;
    }>(
      `SELECT id, name, ip_address, ssh_port, ssh_username, ssh_password_encrypted,
              api_username, api_password_encrypted FROM devices WHERE id = $1`,
      [deviceId]
    );
    if (!device) return;

    // Loaded lazily: BackupService itself imports ChangeGuard.
    const { BackupService } = await import('../BackupService');
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      new BackupService().createBackup(device, `Before change: ${summary}`, 'pre-change'),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timed out')), BUDGET_MS); }),
    ]).finally(() => clearTimeout(timer));
  } catch (e) {
    console.warn(`[ChangeGuard] Pre-change backup skipped for device ${deviceId}: ${(e as Error).message}`);
  }
}
