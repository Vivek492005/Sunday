#!/usr/bin/env node
/**
 * `sunday` — terminal frontend for the per-user sundayd agent daemon
 * (Phase 8: CLI frontends reusing sundayd).
 *
 * Commands:
 *   sunday chat "prompt" [--session <id>] [--model <id>] [--cwd <dir>]
 *   sunday status [--json]
 *   sunday sessions [--json]
 *
 * Attaches to the shared per-user daemon (`~/.sunday/sundayd.sock`,
 * Windows named pipe) or spawns one when none is running — the same
 * daemon the VS Code extension uses.
 */
import { pathToFileURL } from 'node:url';
import { DaemonClient, DaemonClientError, CLI_VERSION } from './client.js';
import {
  chatEventNotificationSchema,
  type ChatEventNotification,
} from '@sunday/protocol';

const USAGE = `sunday — Sunday agent CLI (v${CLI_VERSION})

Usage:
  sunday chat "prompt" [--session <id>] [--model <id>] [--cwd <dir>] [--socket <path>]
  sunday status [--json] [--socket <path>]
  sunday sessions [--json] [--socket <path>]
  sunday --help | -h | --version

The CLI attaches to your per-user sundayd daemon (spawning it if needed).
Use --socket to target a specific daemon socket instead.
`;

interface GlobalOpts {
  json: boolean;
}

function fail(msg: string): never {
  process.stderr.write(`sunday: ${msg}\n`);
  process.exit(1);
}

/** Minimal argv parser: returns { cmd, positional, flags }. */
export function parseArgs(argv: string[]): {
  cmd: string | undefined;
  positional: string[];
  flags: Record<string, string | boolean>;
} {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let cmd: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq >= 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
        flags[a.slice(2)] = argv[++i];
      } else {
        flags[a.slice(2)] = true;
      }
    } else if (a === '-h') {
      flags['help'] = true;
    } else if (!cmd) {
      cmd = a;
    } else {
      positional.push(a);
    }
  }
  return { cmd, positional, flags };
}

async function withClient<T>(fn: (c: DaemonClient) => Promise<T>, socketPath?: string): Promise<T> {
  const client = new DaemonClient({
    ...(socketPath ? { socketPath, lockPath: `${socketPath}.lock` } : {}),
    log: process.env.SUNDAY_DEBUG ? (m) => process.stderr.write(m + '\n') : undefined,
  });
  try {
    await client.connect();
    return await fn(client);
  } finally {
    client.close();
  }
}

async function cmdStatus(json: boolean, socketPath?: string): Promise<void> {
  await withClient(async (c) => {
    const status = (await c.request('daemon/status', {})) as {
      workspaces: Array<{ root: string; trusted: boolean }>;
      multiWorkspace: boolean;
    };
    if (json) {
      process.stdout.write(JSON.stringify(status, null, 2) + '\n');
      return;
    }
    process.stdout.write(`sundayd: ok (protocol via CLI v${CLI_VERSION})\n`);
    process.stdout.write(`multi-workspace mode: ${status.multiWorkspace ? 'yes' : 'no'}\n`);
    if (status.workspaces.length === 0) {
      process.stdout.write('no workspaces configured yet\n');
    } else {
      for (const w of status.workspaces) {
        process.stdout.write(`  ${w.trusted ? '[trusted]  ' : '[untrusted]'} ${w.root}\n`);
      }
    }
  }, socketPath);
}

async function cmdSessions(json: boolean, socketPath?: string): Promise<void> {
  await withClient(async (c) => {
    const { sessions } = (await c.request('session/list', {})) as {
      sessions: Array<{ id: string; title: string; updatedAt: string; cwd?: string }>;
    };
    if (json) {
      process.stdout.write(JSON.stringify(sessions, null, 2) + '\n');
      return;
    }
    if (sessions.length === 0) {
      process.stdout.write('no sessions\n');
      return;
    }
    for (const s of sessions) {
      process.stdout.write(`${s.id}  ${s.title || '(untitled)'}  ${s.updatedAt}${s.cwd ? `  ${s.cwd}` : ''}\n`);
    }
  }, socketPath);
}

async function cmdChat(
  prompt: string,
  opts: { session?: string; model?: string; cwd?: string },
  socketPath?: string,
): Promise<void> {
  await withClient(async (c) => {
    const cwd = opts.cwd ?? process.cwd();
    // Register this workspace with the daemon (trusted: the user explicitly
    // invoked the CLI here).
    await c.request('daemon/configure', { workspaceRoot: cwd, trusted: true });

    let sessionId = opts.session;
    if (!sessionId) {
      const { session } = (await c.request('session/create', {
        title: prompt.slice(0, 60),
        cwd,
      })) as { session: { id: string } };
      sessionId = session.id;
      process.stderr.write(`session: ${sessionId}\n`);
    }

    // Subscribe BEFORE chat/send so no early text-delta is missed.
    let turnId: string | undefined;
    const done = new Promise<{ ok: boolean; error?: string }>((resolve) => {
      const unsub = c.onNotification('chat/event', (params) => {
        const parsed = chatEventNotificationSchema.safeParse(params);
        if (!parsed.success) return;
        const n: ChatEventNotification = parsed.data;
        if (n.sessionId !== sessionId) return;
        if (turnId !== undefined && n.turnId !== turnId) return;
        const e = n.event;
        switch (e.type) {
          case 'text-delta':
            process.stdout.write(e.delta);
            break;
          case 'tool-call':
            process.stderr.write(`\n[tool] ${e.call.name}\n`);
            break;
          case 'tool-result':
            break; // quiet; deltas carry the narrative
          case 'turn-end':
            process.stdout.write('\n');
            unsub();
            resolve({ ok: e.finishReason === 'stop' });
            break;
          case 'turn-error':
            unsub();
            resolve({ ok: false, error: e.message });
            break;
          case 'usage':
            process.stderr.write(
              `\n[usage] in=${e.usage.inputTokens} out=${e.usage.outputTokens}` +
                (e.usage.costUsd !== undefined ? ` cost=$${e.usage.costUsd.toFixed(4)}` : '') +
                '\n',
            );
            break;
        }
      });
    });

    const res = (await c.request('chat/send', {
      sessionId,
      message: prompt,
      ...(opts.model ? { model: opts.model } : {}),
    })) as { turnId: string };
    turnId = res.turnId;

    const result = await done;
    if (!result.ok) fail(result.error ?? 'turn failed');
  }, socketPath);
}

async function main(): Promise<void> {
  const { cmd, positional, flags } = parseArgs(process.argv.slice(2));
  if (flags['help'] || flags['h'] || cmd === 'help') {
    process.stdout.write(USAGE);
    return;
  }
  if (flags['version']) {
    process.stdout.write(`${CLI_VERSION}\n`);
    return;
  }
  const json = flags['json'] === true;
  const socketPath = typeof flags['socket'] === 'string' ? flags['socket'] : undefined;
  try {
    switch (cmd) {
      case 'chat': {
        const prompt = positional.join(' ');
        if (!prompt) fail('chat needs a prompt: sunday chat "your prompt"');
        const session = typeof flags['session'] === 'string' ? flags['session'] : undefined;
        const model = typeof flags['model'] === 'string' ? flags['model'] : undefined;
        const cwd = typeof flags['cwd'] === 'string' ? flags['cwd'] : undefined;
        await cmdChat(prompt, { session, model, cwd }, socketPath);
        break;
      }
      case 'status':
        await cmdStatus(json, socketPath);
        break;
      case 'sessions':
        await cmdSessions(json, socketPath);
        break;
      case undefined:
        process.stdout.write(USAGE);
        process.exit(2);
        break;
      default:
        fail(`unknown command '${cmd}'\n${USAGE}`);
    }
  } catch (e) {
    if (e instanceof DaemonClientError) fail(e.message);
    throw e;
  }
}

// Only run as a CLI entrypoint when executed directly (not when imported
// by tests or as a library).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    process.stderr.write(`sunday: ${(e as Error).message}\n`);
    process.exit(1);
  });
}
