// sundayd — F6 Durable Sessions: event-log, rewind, branch, settings snapshots.
//
// Acceptance gates (roadmap F6):
//  - kill -9 mid-write → restart → recover to last consistent entry
//  - rewind → workspace hash == checkpoint hash
//  - settings restore round-trip

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  SessionLog,
  readLogFile,
  replayLog,
  verifyEntry,
  entryChecksum,
  SESSION_LOG_SCHEMA_VERSION,
  LOG_FLUSH_BATCH,
} from './sessionLog.js';
import { SessionStore } from './sessions.js';
import {
  snapshotSettings,
  listSettingsSnapshots,
  restoreSettingsSnapshot,
  maybeSnapshotOnUpgrade,
  MAX_SETTINGS_SNAPSHOTS,
} from './settingsSnapshots.js';

function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('SessionLog primitive', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await tmpDir('sunday-f6-log-');
  });

  it('appends entries with monotonic seq + valid checksums', async () => {
    const log = await SessionLog.open(dir, 's1');
    const e1 = await log.append('session_created', { title: 't' });
    const e2 = await log.append('message', { role: 'user', content: 'hi' });
    await log.flush();
    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);
    expect(e1.schemaVersion).toBe(SESSION_LOG_SCHEMA_VERSION);
    expect(verifyEntry(e1)).toBe(true);
    expect(verifyEntry(e2)).toBe(true);
    await log.close();

    const { entries, truncated } = await readLogFile(SessionLog.logPath(dir, 's1'));
    expect(truncated).toBe(false);
    expect(entries).toHaveLength(2);
    expect(entries[1].type).toBe('message');
  });

  it('replays messages in order', async () => {
    const log = await SessionLog.open(dir, 's1');
    await log.append('session_created', { title: 't' });
    await log.append('message', { role: 'user', content: 'hello' });
    await log.append('message', { role: 'assistant', content: 'hi there' });
    await log.append('tool_call', { name: 'read_file', args: {} });
    await log.flush();
    await log.close();

    const { entries } = await readLogFile(SessionLog.logPath(dir, 's1'));
    const replayed = replayLog(entries);
    expect(replayed.messages).toHaveLength(2);
    expect(replayed.messages[0]).toMatchObject({ role: 'user' });
    expect(replayed.messages[1]).toMatchObject({ role: 'assistant' });
  });

  it('kill -9 mid-write: torn final line recovers to last consistent entry', async () => {
    const log = await SessionLog.open(dir, 's1');
    await log.append('session_created', { title: 't' });
    await log.append('message', { role: 'user', content: 'one' });
    await log.append('message', { role: 'user', content: 'two' });
    await log.flush();
    await log.close();

    // Simulate kill -9 mid-write: a torn partial line at the tail.
    const logPath = SessionLog.logPath(dir, 's1');
    await fs.appendFile(logPath, '{"schemaVersion":1,"seq":4,"id":"abc","sess');

    const { entries, truncated, badTail } = await readLogFile(logPath);
    expect(truncated).toBe(true);
    expect(entries).toHaveLength(3);
    expect(badTail).toContain('"seq":4');

    // Reopen quarantines the torn tail and truncates to the good prefix.
    const reopened = await SessionLog.open(dir, 's1');
    const e = await reopened.append('message', { role: 'user', content: 'three' });
    expect(e.seq).toBe(4); // continues exactly after the consistent prefix
    await reopened.close();

    const after = await readLogFile(logPath);
    expect(after.truncated).toBe(false);
    expect(after.entries).toHaveLength(4);
    // The torn bytes were preserved for forensics.
    const badFiles = (await fs.readdir(dir)).filter((f) => f.includes('.bad.'));
    expect(badFiles).toHaveLength(1);
  });

  it('a tampered checksum in the middle truncates the log there', async () => {
    const log = await SessionLog.open(dir, 's1');
    await log.append('session_created', { title: 't' });
    await log.append('message', { role: 'user', content: 'good' });
    await log.append('message', { role: 'user', content: 'evil?' });
    await log.flush();
    await log.close();

    const logPath = SessionLog.logPath(dir, 's1');
    const lines = (await fs.readFile(logPath, 'utf8')).split('\n').filter(Boolean);
    const tampered = JSON.parse(lines[1]);
    tampered.payload.content = 'attacker was here';
    lines[1] = JSON.stringify(tampered); // checksum now stale
    await fs.writeFile(logPath, lines.join('\n') + '\n');

    const { entries, truncated } = await readLogFile(logPath);
    expect(truncated).toBe(true);
    expect(entries).toHaveLength(1); // only session_created survives
  });

  it('batching: auto-flush at the batch threshold, explicit flush fsyncs', async () => {
    const log = await SessionLog.open(dir, 's1');
    for (let i = 0; i < LOG_FLUSH_BATCH + 5; i++) {
      await log.append('message', { role: 'user', content: `m${i}` });
    }
    // 32 auto-flushed; 5 remain buffered.
    expect(log.bufferedCount).toBe(5);
    const lines = (await fs.readFile(SessionLog.logPath(dir, 's1'), 'utf8'))
      .split('\n')
      .filter(Boolean);
    expect(lines).toHaveLength(LOG_FLUSH_BATCH);
    await log.close(); // close flushes the rest
    const lines2 = (await fs.readFile(SessionLog.logPath(dir, 's1'), 'utf8'))
      .split('\n')
      .filter(Boolean);
    expect(lines2).toHaveLength(LOG_FLUSH_BATCH + 5);
  });

  it('rejects entries with a future schema version', async () => {
    const log = await SessionLog.open(dir, 's1');
    const e = await log.append('message', { role: 'user', content: 'x' });
    await log.close();
    const future = { ...e, schemaVersion: SESSION_LOG_SCHEMA_VERSION + 1 };
    expect(verifyEntry(future)).toBe(false);
    // entryChecksum is stable regardless of key order in the source object
    const reshuffled = { checksum: '', ...(({ checksum: _c, ...rest }) => rest)(e) } as typeof e;
    expect(entryChecksum(reshuffled)).toBe(e.checksum);
  });
});

describe('SessionStore with event log', () => {
  let dir: string;
  let ckptDir: string;
  beforeEach(async () => {
    dir = await tmpDir('sunday-f6-store-');
    ckptDir = await tmpDir('sunday-f6-ckpt-');
  });

  async function makeStore() {
    const store = new SessionStore(dir, ckptDir);
    await store.init();
    return store;
  }

  it('create → logEvent → persist → restore replays the log', async () => {
    const store = await makeStore();
    const s = store.create({ title: 'hello' });
    await store.logEvent(s.id, 'session_created', { title: s.title });
    s.messages.push({ role: 'user', content: 'ping' } as never);
    await store.persist(s);
    await store.closeLogs();

    const store2 = await makeStore();
    const r = await store2.restore(s.id);
    expect(r.messages).toHaveLength(1);
    expect((r.messages[0] as { content: string }).content).toBe('ping');
    await store2.closeLogs();
  });

  it('migrates a legacy .json session into the log on first restore', async () => {
    const store = await makeStore();
    const s = store.create({ title: 'legacy' });
    s.messages.push({ role: 'user', content: 'old msg' } as never);
    // Simulate a pre-F6 daemon: write only the legacy JSON, no log.
    await fs.writeFile(path.join(dir, `${s.id}.json`), JSON.stringify(s), { mode: 0o600 });

    const store2 = await makeStore();
    const r = await store2.restore(s.id);
    expect(r.messages).toHaveLength(1);
    const { entries } = await readLogFile(SessionLog.logPath(dir, s.id));
    expect(entries[0].type).toBe('session_created');
    expect(entries[0].payload).toMatchObject({ migratedFrom: 'legacy-json' });
    await store2.closeLogs();
  });

  it('rewind restores conversation AND workspace to the checkpoint', async () => {
    const store = await makeStore();
    const workspace = await tmpDir('sunday-f6-ws-');
    const target = path.join(workspace, 'app.txt');
    await fs.writeFile(target, 'version-1');

    const s = store.create({ title: 'rw', cwd: workspace });
    await store.logEvent(s.id, 'session_created', { title: s.title, cwd: workspace });
    s.messages.push({ role: 'user', content: 'start' } as never);
    const { checkpointId, entryId: cpEntryId } = await store.createCheckpoint(s.id, 'v1');
    expect(checkpointId).toBeTruthy();

    // Diverge: new code + more conversation.
    await fs.writeFile(target, 'version-2-broken');
    s.messages.push({ role: 'assistant', content: 'changed it' } as never);
    s.messages.push({ role: 'user', content: 'oops' } as never);
    await store.persist(s);

    const entries = await store.getLogEntries(s.id);
    const head = entries[entries.length - 1];

    const r = await store.rewind(s.id, cpEntryId);
    expect(r.rewoundTo).toBe(cpEntryId);
    expect(r.droppedEntries).toBeGreaterThan(0);
    expect(r.codeRestored).toBe(true);

    // Workspace hash matches the checkpoint state.
    const content = await fs.readFile(target, 'utf8');
    expect(content).toBe('version-1');
    const hash = createHash('sha256').update(content).digest('hex');
    expect(hash).toBe(createHash('sha256').update('version-1').digest('hex'));

    // Conversation rewound: only messages up to the checkpoint entry.
    const live = store.require(s.id);
    expect(live.messages.map((m) => (m as { content: string }).content)).toEqual(['start']);

    // The log now ends with a rewind marker; head entry id differs.
    const entriesAfter = await store.getLogEntries(s.id);
    expect(entriesAfter[entriesAfter.length - 1].type).toBe('rewind');
    expect(entriesAfter.find((e) => e.id === head.id)).toBeUndefined();
    await store.closeLogs();
  });

  it('rewind to an unknown entry id throws', async () => {
    const store = await makeStore();
    const s = store.create({ title: 'rw2' });
    await store.logEvent(s.id, 'session_created', { title: s.title });
    await expect(store.rewind(s.id, 'nope')).rejects.toThrow(/log entry not found/);
    await store.closeLogs();
  });

  it('branch forks a new session from any entry', async () => {
    const store = await makeStore();
    const s = store.create({ title: 'orig' });
    await store.logEvent(s.id, 'session_created', { title: s.title });
    s.messages.push({ role: 'user', content: 'm1' } as never);
    s.messages.push({ role: 'user', content: 'm2' } as never);
    s.messages.push({ role: 'user', content: 'm3' } as never);
    await store.persist(s);
    const entries = await store.getLogEntries(s.id);
    const secondMsg = entries.find(
      (e) => e.type === 'message' && (e.payload as { content: string }).content === 'm2',
    )!;

    const { session: b, parentSessionId } = await store.branch(s.id, secondMsg.id, 'forked');
    expect(parentSessionId).toBe(s.id);
    expect(b.id).not.toBe(s.id);
    expect(b.title).toBe('forked');
    expect(b.messages.map((m) => (m as { content: string }).content)).toEqual(['m1', 'm2']);

    const bEntries = await store.getLogEntries(b.id);
    expect(bEntries[bEntries.length - 1].type).toBe('branch');
    expect(bEntries[bEntries.length - 1].payload).toMatchObject({ parentSessionId: s.id });

    // Parent is untouched.
    expect(store.require(s.id).messages).toHaveLength(3);
    await store.closeLogs();
  });

  it('export produces JSONL and Markdown transcripts', async () => {
    const store = await makeStore();
    const s = store.create({ title: 'exp' });
    await store.logEvent(s.id, 'session_created', { title: s.title });
    s.messages.push({ role: 'user', content: 'hello' } as never);
    await store.logEvent(s.id, 'tool_call', { name: 'read_file', args: { path: 'x' } });
    await store.logApproval(s.id, 'read_file(x)', 'allow_once', 'session');
    await store.persist(s);

    const jsonl = await store.exportTranscript(s.id, 'jsonl');
    const lines = jsonl.split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(4);
    for (const l of lines) expect(verifyEntry(JSON.parse(l))).toBe(true);

    const md = await store.exportTranscript(s.id, 'markdown');
    expect(md).toContain('# Sunday session transcript');
    expect(md).toContain('## user');
    expect(md).toContain('hello');
    expect(md).toContain('tool_call');
    expect(md).toContain('allow_once');
    await store.closeLogs();
  });

  it('delete removes the log file too (privacy)', async () => {
    const store = await makeStore();
    const s = store.create({ title: 'del' });
    await store.logEvent(s.id, 'session_created', { title: s.title });
    await store.persist(s);
    expect(
      await fs.stat(SessionLog.logPath(dir, s.id)).then(() => true).catch(() => false),
    ).toBe(true);
    await store.delete(s.id);
    expect(
      await fs.stat(SessionLog.logPath(dir, s.id)).then(() => true).catch(() => false),
    ).toBe(false);
    await store.closeLogs();
  });
});

describe('settings snapshots', () => {
  let settingsPath: string;
  let snapshotsDir: string;
  let markerPath: string;
  beforeEach(async () => {
    const d = await tmpDir('sunday-f6-settings-');
    settingsPath = path.join(d, 'settings.json');
    snapshotsDir = path.join(d, 'snapshots');
    markerPath = path.join(d, 'daemon-version');
  });

  const opts = () => ({ settingsPath, snapshotsDir });

  it('snapshot → modify → restore round-trips', async () => {
    await fs.writeFile(settingsPath, JSON.stringify({ theme: 'dark' }));
    const snap = await snapshotSettings('manual', opts());
    expect(snap).not.toBeNull();
    await fs.writeFile(settingsPath, JSON.stringify({ theme: 'light', extra: 1 }));

    const backup = await restoreSettingsSnapshot(snap!.id, opts());
    expect(backup.reason).toBe('pre-restore');
    expect(JSON.parse(await fs.readFile(settingsPath, 'utf8'))).toEqual({ theme: 'dark' });

    // The pre-restore backup lets us undo the restore itself.
    const snaps = await listSettingsSnapshots(snapshotsDir);
    expect(snaps.some((s) => s.reason === 'pre-restore')).toBe(true);
  });

  it('snapshot is a no-op when no settings file exists', async () => {
    expect(await snapshotSettings('manual', opts())).toBeNull();
  });

  it('restore of an unknown snapshot id throws', async () => {
    await expect(restoreSettingsSnapshot('nope', opts())).rejects.toThrow(/not found/);
  });

  it('prunes beyond the cap, newest kept', async () => {
    await fs.writeFile(settingsPath, '{}');
    for (let i = 0; i < MAX_SETTINGS_SNAPSHOTS + 3; i++) {
      await snapshotSettings(`r${i}`, opts());
      await new Promise((r) => setTimeout(r, 2)); // distinct timestamps
    }
    const snaps = await listSettingsSnapshots(snapshotsDir);
    expect(snaps).toHaveLength(MAX_SETTINGS_SNAPSHOTS);
  });

  it('maybeSnapshotOnUpgrade snapshots on version change only', async () => {
    await fs.writeFile(settingsPath, JSON.stringify({ a: 1 }));
    const o = { ...opts(), markerPath };
    const first = await maybeSnapshotOnUpgrade('1.0.0', o);
    expect(first?.reason).toBe('first-boot');
    expect(await maybeSnapshotOnUpgrade('1.0.0', o)).toBeNull();
    const upgraded = await maybeSnapshotOnUpgrade('1.1.0', o);
    expect(upgraded?.reason).toBe('upgrade-1.0.0-to-1.1.0');
    expect(await fs.readFile(markerPath, 'utf8')).toContain('1.1.0');
  });
});
