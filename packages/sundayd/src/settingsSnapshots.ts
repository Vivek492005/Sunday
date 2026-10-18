// sundayd — F6 Durable Sessions: settings snapshots & rollback.
//
// Before every daemon upgrade (version marker change) the current
// `~/.sunday/settings.json` is snapshotted automatically; the user can also
// snapshot on demand and roll back with `settings/restore` ("Sunday: Restore
// Previous Settings"). A pre-restore backup is always taken first, so a
// restore itself is reversible.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface SettingsSnapshot {
  /** `<ts>-<reason>` — sortable, unique. */
  id: string;
  createdAt: string;
  reason: string;
  /** Absolute path of the snapshot file. */
  path: string;
  /** Byte size of the snapshotted settings file. */
  bytes: number;
}

/** Keep at most this many snapshots; oldest pruned on new snapshot. */
export const MAX_SETTINGS_SNAPSHOTS = 10;

export function defaultSettingsPath(): string {
  return path.join(os.homedir(), '.sunday', 'settings.json');
}

export function defaultSettingsSnapshotsDir(): string {
  return path.join(os.homedir(), '.sunday', 'settings-snapshots');
}

export function defaultVersionMarkerPath(): string {
  return path.join(os.homedir(), '.sunday', 'daemon-version');
}

function snapshotId(reason: string, ts = Date.now()): string {
  const safe = reason.replace(/[^a-z0-9-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'manual';
  return `${ts}-${safe}`;
}

/**
 * Snapshot the settings file. No-op (returns null) when there is no
 * settings file yet — nothing to protect. Prunes beyond the cap.
 */
export async function snapshotSettings(
  reason: string,
  opts: { settingsPath?: string; snapshotsDir?: string } = {},
): Promise<SettingsSnapshot | null> {
  const settingsPath = opts.settingsPath ?? defaultSettingsPath();
  const snapshotsDir = opts.snapshotsDir ?? defaultSettingsSnapshotsDir();
  let data: Buffer;
  try {
    data = await fs.readFile(settingsPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw e;
  }
  await fs.mkdir(snapshotsDir, { recursive: true, mode: 0o700 });
  const id = snapshotId(reason);
  const dest = path.join(snapshotsDir, `${id}.json`);
  await fs.writeFile(dest, data, { mode: 0o600 });
  await pruneSettingsSnapshots(snapshotsDir);
  return {
    id,
    createdAt: new Date().toISOString(),
    reason,
    path: dest,
    bytes: data.byteLength,
  };
}

/** Newest-first snapshot list. Corrupt/foreign files are ignored. */
export async function listSettingsSnapshots(
  snapshotsDir: string = defaultSettingsSnapshotsDir(),
): Promise<SettingsSnapshot[]> {
  let files: string[];
  try {
    files = await fs.readdir(snapshotsDir);
  } catch {
    return [];
  }
  const out: SettingsSnapshot[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const id = f.slice(0, -'.json'.length);
    const m = id.match(/^(\d+)-(.+)$/);
    if (!m) continue;
    const full = path.join(snapshotsDir, f);
    try {
      const stat = await fs.stat(full);
      if (!stat.isFile()) continue;
      out.push({
        id,
        createdAt: new Date(Number(m[1])).toISOString(),
        reason: m[2],
        path: full,
        bytes: stat.size,
      });
    } catch {
      // ignore races
    }
  }
  out.sort((a, b) => (a.id < b.id ? 1 : -1));
  return out;
}

async function pruneSettingsSnapshots(snapshotsDir: string): Promise<void> {
  const snaps = await listSettingsSnapshots(snapshotsDir);
  for (const s of snaps.slice(MAX_SETTINGS_SNAPSHOTS)) {
    await fs.unlink(s.path).catch(() => undefined);
  }
}

/**
 * Restore a snapshot over the live settings file. Takes a `pre-restore`
 * backup first, so the restore is itself reversible. Returns the backup.
 */
export async function restoreSettingsSnapshot(
  id: string,
  opts: { settingsPath?: string; snapshotsDir?: string } = {},
): Promise<SettingsSnapshot> {
  const settingsPath = opts.settingsPath ?? defaultSettingsPath();
  const snapshotsDir = opts.snapshotsDir ?? defaultSettingsSnapshotsDir();
  const snaps = await listSettingsSnapshots(snapshotsDir);
  const snap = snaps.find((s) => s.id === id);
  if (!snap) throw new Error(`settings snapshot not found: ${id}`);
  const backup = await snapshotSettings('pre-restore', { settingsPath, snapshotsDir });
  const data = await fs.readFile(snap.path);
  const tmp = `${settingsPath}.${process.pid}.tmp`;
  await fs.writeFile(tmp, data, { mode: 0o600 });
  await fs.rename(tmp, settingsPath);
  if (!backup) throw new Error('restore failed: could not back up current settings');
  return backup;
}

/**
 * Upgrade hook: call once per daemon boot with the running package version.
 * When the marker is missing or differs, the settings are snapshotted with
 * reason `upgrade:<old>-><new>` and the marker is updated. Returns the
 * snapshot (null when no upgrade detected or no settings file yet).
 */
export async function maybeSnapshotOnUpgrade(
  packageVersion: string,
  opts: { settingsPath?: string; snapshotsDir?: string; markerPath?: string } = {},
): Promise<SettingsSnapshot | null> {
  const markerPath = opts.markerPath ?? defaultVersionMarkerPath();
  let previous: string | null = null;
  try {
    previous = (await fs.readFile(markerPath, 'utf8')).trim() || null;
  } catch {
    previous = null;
  }
  if (previous === packageVersion) return null;
  const reason = previous ? `upgrade-${previous}-to-${packageVersion}` : 'first-boot';
  const snap = await snapshotSettings(reason, opts);
  await fs.mkdir(path.dirname(markerPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(markerPath, `${packageVersion}\n`, { mode: 0o600 });
  return snap;
}
