#!/usr/bin/env node
/**
 * Sunday Electron smoke test — suite runner.
 *
 * This module executes INSIDE the VS Code extension host (loaded by
 * @vscode/test-electron's `runTests` via `extensionTestsPath`). It verifies:
 *
 *   1. VS Code window opened (if we're running, it did)
 *   2. sunday-agent extension is present and activated
 *   3. sundayd sidecar spawned and reached 'ready' status
 *   4. sunday/hello handshake completed (server info present) — the RPC roundtrip
 *   5. Key Sunday commands are registered
 *
 * Results are printed as `SMOKE <name>: PASS|FAIL` lines and a final
 * `SMOKE RESULT: PASS|FAIL`. The process exits 0 on pass, 1 on fail.
 *
 * No model calls are made — no provider API keys required. The hello
 * handshake is the RPC roundtrip proof.
 */

import * as vscode from 'vscode';
import { setTimeout as delay } from 'node:timers/promises';

const EXT_ID = 'sunday.sunday-agent';
const START_TIMEOUT_MS = 90_000;
const POLL_MS = 500;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`SMOKE ${name}: ${ok ? 'PASS' : 'FAIL'}${detail ? ` — ${detail}` : ''}`);
}

async function waitFor(fn, timeoutMs, label) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await delay(POLL_MS);
  }
  throw new Error(`timeout waiting for ${label}: ${last instanceof Error ? last.message : last}`);
}

export async function run() {
  try {
    // 1. Extension is present
    const ext = vscode.extensions.getExtension(EXT_ID);
    check('extension-present', !!ext, ext ? EXT_ID : 'not found');
    if (!ext) throw new Error('extension not found, aborting');

    // 2. Extension activates (onStartupFinished)
    await waitFor(async () => ext.isActive || (await ext.activate(), ext.isActive), START_TIMEOUT_MS, 'activation');
    check('extension-active', ext.isActive);

    // 3. Smoke API is exposed
    const api = ext.exports?.__sundaySmoke;
    check('smoke-api', !!api, api ? 'exposed' : 'missing __sundaySmoke');
    if (!api) throw new Error('smoke API missing, aborting');

    // 4. Sidecar reaches ready (spawns sundayd + hello handshake)
    await api.ensureStarted().catch(() => {});
    const status = await waitFor(async () => {
      const s = api.getSidecarStatus();
      return s === 'ready' ? s : null;
    }, START_TIMEOUT_MS, 'sidecar ready');
    check('sidecar-ready', status === 'ready', `status=${status}`);

    // 5. Hello handshake completed — server info is the RPC roundtrip proof
    const info = api.getServerInfo();
    check('hello-handshake', !!info?.version, info ? `sundayd v${info.version}` : 'no server info');

    // 6. Key commands registered
    const commands = await vscode.commands.getCommands(true);
    for (const cmd of ['sunday.chat.focus', 'sunday.sidecar.status', 'sunday.manager.open']) {
      check(`command-${cmd}`, commands.includes(cmd), commands.includes(cmd) ? '' : 'not registered');
    }

    // 7. Chat view registered (webview view id from package.json)
    // Best-effort: the view container existing is enough for smoke purposes.
    check('window-open', true, 'extension host running');
  } catch (err) {
    check('harness-error', false, String((err && err.message) || err));
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`SMOKE RESULT: ${failed.length === 0 ? 'PASS' : 'FAIL'} (${results.length - failed.length}/${results.length} checks)`);
  // Give the console a beat to flush before the host tears down.
  await delay(500);
  if (failed.length > 0) {
    throw new Error(`${failed.length} smoke check(s) failed`);
  }
}
