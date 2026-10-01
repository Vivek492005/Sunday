// @sunday/sundayd — privacy: "idle network silent".
//
// Boots the real daemon surface (default OpenRouter/Groq provider registry,
// full Part-A tool surface, MCP hub with an empty workspace config) with the
// network layer stubbed, then asserts ZERO outbound fetch calls happen
// without a user task: no telemetry, no update checks, no phoning home on
// startup. Provider HTTP only fires from an actual chat/completion turn.
import { PassThrough } from 'node:stream';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SundayDaemon } from './daemon.js';
import { createSundaydTools } from './agent-tools.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function bootIdleDaemon(): Promise<{
  daemon: SundayDaemon;
  fetchCalls: string[];
  dir: string;
  input: PassThrough;
  output: PassThrough;
}> {
  const fetchCalls: string[] = [];
  vi.stubGlobal(
    'fetch',
    async (url: unknown, _init: unknown) => {
      fetchCalls.push(String(url));
      throw new Error(`unexpected network call in idle test: ${String(url)}`);
    },
  );

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sunday-privacy-'));
  const workspaceDir = path.join(dir, 'ws');
  await fs.mkdir(workspaceDir, { recursive: true });
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume(); // drain so writes never backpressure

  const agentTools = createSundaydTools({
    workspaceDir,
    userDir: path.join(dir, 'home'),
    mcp: { workspaceTrusted: true, workspaceConfigPath: path.join(workspaceDir, '.sunday', 'mcp.json') },
  });
  try {
    await agentTools.ready;
  } catch {
    /* additive — never fatal */
  }

  const daemon = new SundayDaemon(
    {
      tools: agentTools.registry,
      policyGate: agentTools.policy,
      sessionsDir: path.join(dir, 'sessions'),
      userDir: path.join(dir, 'home'),
      defaultModel: 'openrouter:meta-llama/llama-3.3-70b-instruct',
      onShutdown: () => undefined,
      onStdinClose: () => undefined,
      // Real default providers (OpenRouter + Groq adapters) — no keys set, and
      // none needed: nothing may call them without a user task.
    },
    input,
    output,
  );
  await daemon.start();
  return { daemon, fetchCalls, dir, input, output };
}

describe('privacy: idle network silent', () => {
  it('makes zero fetch calls on daemon boot with no user task', async () => {
    const { fetchCalls, input } = await bootIdleDaemon();
    // Let any lazy/timer-driven startup work settle.
    await sleep(750);
    expect(fetchCalls).toEqual([]);
    input.end();
  }, 15000);

  it('still silent after a non-model RPC round-trip (session/list)', async () => {
    const { fetchCalls, input, output } = await bootIdleDaemon();
    const frames: string[] = [];
    let buf = '';
    output.on('data', (d: Buffer) => {
      buf += d.toString();
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line) frames.push(line);
      }
    });
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'session/list', params: {} }) + '\n');
    await sleep(750);
    expect(fetchCalls).toEqual([]);
    // Sanity: the daemon actually answered (this isn't a dead transport).
    expect(frames.some((f) => f.includes('"id":1'))).toBe(true);
    input.end();
  }, 15000);
});
