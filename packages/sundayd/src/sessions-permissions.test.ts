// SEC-12 regression: session persistence is owner-only. Session files hold
// the full conversation history (tool calls + args), which can contain
// secrets the user pasted or the model echoed, so they must not be
// world-readable on multi-user machines.
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionStore } from './sessions.js';

describe('SEC-12: session file permissions', () => {
  it('persists session files as owner-only (0600) inside a 0700 dir', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sunday-sess-perm-'));
    const sdir = join(dir, 'sessions');
    const store = new SessionStore(sdir);
    await store.init();
    const s = store.create({ title: 'perm-test' });
    await store.persist(s);

    const dirMode = (await stat(sdir)).mode & 0o777;
    expect(dirMode).toBe(0o700);
    const fileMode = (await stat(join(sdir, `${s.id}.json`))).mode & 0o777;
    expect(fileMode).toBe(0o600);
  });
});
