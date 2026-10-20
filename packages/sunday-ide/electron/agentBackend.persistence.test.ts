/**
 * agentBackend persistence shape-guard regression tests (audit M6).
 *
 * agentBackend restores ledger.json / pins.json / budgets.json at MODULE
 * SCOPE. readJson only guarantees valid JSON, not the shape: a file
 * containing `{}` / `null` / `42` made the module-scope iteration throw
 * a TypeError and killed the main process before any window opened.
 * These tests point HOME at a temp dir (os.homedir() reads $HOME on
 * Linux), poison the files, and import the module fresh per scenario.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const realHome = process.env.HOME;
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sunday-agentbackend-home-'));
const ideDir = path.join(fakeHome, '.sunday-ide');
fs.mkdirSync(ideDir, { recursive: true });
process.env.HOME = fakeHome;

afterAll(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

function writeIdeFile(name: string, content: string): void {
  fs.writeFileSync(path.join(ideDir, name), content, 'utf8');
}

describe('agentBackend persistence shape guards (audit M6)', () => {
  it('valid-JSON-wrong-shape ledger/pins/budgets files degrade to empty state, module loads', async () => {
    writeIdeFile('ledger.json', '{"not":"an array"}');
    writeIdeFile('pins.json', '42');
    writeIdeFile('budgets.json', 'null');
    vi.resetModules();
    // Pre-fix this import itself threw (module-scope TypeError).
    const backend = await import('./agentBackend.js');
    expect(backend.listPins()).toEqual([]);
    expect(backend.getRealUsage().used).toBe(0);
    expect(backend.getRealUsage().taskSpend).toBe(0);
    expect(() => backend.checkBudgetGate()).not.toThrow();
    // The stores stay fully functional afterwards.
    const pinned = backend.pinFact('still works after poisoned load');
    expect(backend.listPins().some((p) => p.id === pinned.id)).toBe(true);
    expect(backend.unpinFact(pinned.id)).toBe(true);
  });

  it('mixed-validity arrays restore the valid entries and skip the junk', async () => {
    writeIdeFile(
      'ledger.json',
      JSON.stringify([
        null,
        42,
        'junk',
        { id: 'r1', model: 'auto', requests: 5, success: true, at: Date.now() },
      ]),
    );
    writeIdeFile(
      'pins.json',
      JSON.stringify([
        null,
        { id: 'p1' }, // no text — not a well-formed pin
        { id: 'p2', text: 'keep this', pinnedBy: 'user', createdAt: 1 },
      ]),
    );
    writeIdeFile('budgets.json', '{}');
    vi.resetModules();
    const backend = await import('./agentBackend.js');
    expect(backend.listPins().map((p) => p.id)).toEqual(['p2']);
    expect(backend.getRealUsage().taskSpend).toBe(5);
  });
});
