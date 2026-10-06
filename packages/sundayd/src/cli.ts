#!/usr/bin/env node
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { SundayDaemon } from './daemon.js';
import { SocketServerTransport, type ServerTransport } from './rpc-transport.js';
import {
  isSharedDaemonSocket,
  releaseDaemonLockIfOurs,
  sharedDaemonLockPath,
  writeDaemonLock,
} from '@sunday/protocol';
import { createContextHandlers } from '@sunday/context';
import { registerManagerMethods } from './manager.js';
import { registerOrchestrationMethods } from '@sunday/orchestrator';
import { registerBackgroundMethods } from '@sunday/orchestrator';
import {
  setupOrchestrationPersistence,
  type OrchestrationPersistenceModule,
} from './orchestration-lifecycle.js';
import { BrowserdManager } from './browserd.js';
import { registerBrowserPanelMethods } from './browser-panel.js';
import { registerBrowserWalkthroughTools } from './browser-walkthrough.js';
import { EnvSecretResolver, createSundaydTools } from './agent-tools.js';
import { registerMcpMethods, type McpHubResolver } from './mcp-methods.js';
import { WorkspaceMcpManager, adaptMcpToolForWorkspace } from './workspace-mcp.js';
import { adaptMcpTool } from './agent-tools.js';
import { isWorkspaceTrusted } from './trust.js';

// sundayd entrypoint: JSON-RPC over stdio by default (`--socket <path>`
// switches to a unix-socket / Windows-named-pipe listener with the same
// NDJSON framing and RPC dispatch — Phase 8 Stage 1). Logs go to stderr so
// the NDJSON frame stream on stdout stays clean.

/** `--socket <path>` value, or undefined for stdio mode. */
function socketFlag(): string | undefined {
  const i = process.argv.indexOf('--socket');
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return undefined;
}

// context/* methods take an explicit `workspaceRoot` per call (the same
// pattern as the session cwd that confines tools). Bind a fresh handler table
// per call so the daemon serves any workspace no matter where it was launched
// from — and on any drive (a single construction-time root could never cover
// that on Windows).
//
// Trust note: the requested root is the extension's explicit choice, exactly
// like the cwd accepted by `session/create`. The daemon and the extension run
// as the same user over local stdio — there is no privilege boundary between
// them. Model confinement stays at the tool layer (per-call session cwd),
// where it already is. If context/* is ever exposed to the model as tools,
// that wrapper must clamp workspaceRoot to the session cwd like tools do.
function bindPerCall<K extends 'context/map' | 'context/index' | 'context/search'>(method: K) {
  return (params: unknown): Promise<unknown> => {
    let root: string | undefined;
    if (typeof params === 'object' && params !== null) {
      const r = (params as Record<string, unknown>).workspaceRoot;
      if (typeof r === 'string' && r.length > 0) root = r;
    }
    const table = createContextHandlers(root);
    return table[method](params) as Promise<unknown>;
  };
}

async function buildDaemon(extra: { transport?: ServerTransport; onShutdown?: () => void } = {}): Promise<SundayDaemon> {
  // Part A: the daemon-level workspace (the extension stamps SUNDAY_WORKSPACE
  // at spawn; falls back to the process cwd). The MCP hub is daemon-global
  // and reads this workspace's .sunday/mcp.json; per-session tools
  // (load_skill, remember) and the system prompt use each session's own cwd.
  const workspaceDir = process.env.SUNDAY_WORKSPACE?.trim() || process.cwd();

  // Phase 6: browserd stays a lazy child process — it only spawns on first
  // browser_* tool use — and is stopped with the daemon (see gracefulExit).
  const browserdManager = new BrowserdManager({
    log: (msg) => console.error(`[browserd] ${msg}`),
  });

  // Part A: default tools + load_skill/tool_search/remember + McpHub +
  // approval-aware PolicyGate (shared instance with the daemon below).
  const agentTools = createSundaydTools({
    workspaceDir,
    userDir: homedir(),
    mcp: {
      // SEC-04: fail closed — the hub loads the workspace-scope mcp.json
      // only when the extension stamped SUNDAY_WORKSPACE_TRUSTED=1 at
      // spawn. The extension still prompts (Allow/Deny) before *starting*
      // a workspace-scope server.
      workspaceTrusted: isWorkspaceTrusted(),
      secretResolver: new EnvSecretResolver(),
    },
  });

  // Browser Agent UI phase: walkthrough artifact tool (markdown + screenshots).
  // Registered before the daemon so syncDangerousFlags picks up its dangerous flag.
  registerBrowserWalkthroughTools(agentTools.registry, browserdManager, { workspaceDir });

  // Phase 8 Stage 3: per-workspace MCP hubs. The default hub (from
  // createSundaydTools above) serves the legacy single-workspace path;
  // additional workspaces get lazily-created hubs with their own trust
  // verdict, mcp.json, and secret namespace.
  const mcpManager = new WorkspaceMcpManager();
  const syncedWorkspaceRoots = new Set<string>();

  /** Sync one workspace hub's tools into the registry, execution-gated to that workspace. */
  const syncWorkspaceHubTools = (entry: { root: string; hub: import('@sunday/mcp').McpHub }): void => {
    for (const t of entry.hub.toTools()) {
      const name = t.definition.name;
      if (agentTools.registry.names().includes(name)) continue;
      agentTools.registry.register(adaptMcpToolForWorkspace(t, adaptMcpTool, entry.root));
      agentTools.policy.markDangerous(name);
    }
    // Re-sync when servers start later (attach once per workspace).
    if (!syncedWorkspaceRoots.has(entry.root)) {
      syncedWorkspaceRoots.add(entry.root);
      entry.hub.events.on('tools-changed', () => {
        try {
          for (const t of entry.hub.toTools()) {
            const name = t.definition.name;
            if (agentTools.registry.names().includes(name)) continue;
            agentTools.registry.register(adaptMcpToolForWorkspace(t, adaptMcpTool, entry.root));
            agentTools.policy.markDangerous(name);
          }
        } catch (e) {
          console.error(`[sundayd] MCP tool sync failed for ${entry.root}: ${(e as Error).message}`);
        }
      });
    }
  };

  /** Route `mcp/*` RPCs to the default hub or a workspace hub. */
  const mcpResolver: McpHubResolver = {
    resolve: (workspaceRoot?: string) => {
      if (!workspaceRoot) {
        return {
          hub: agentTools.hub,
          workspaceConfigPath: agentTools.workspaceConfigPath,
          workspaceTrusted: agentTools.workspaceTrusted,
        };
      }
      const entry = mcpManager.get(workspaceRoot);
      // Lazy tool sync on first routing to this workspace.
      entry.ready.then(
        () => syncWorkspaceHubTools(entry),
        () => undefined,
      );
      return {
        hub: entry.hub,
        workspaceConfigPath: entry.workspaceConfigPath,
        workspaceTrusted: entry.workspaceTrusted,
      };
    },
  };

  const daemon = new SundayDaemon({
    tools: agentTools.registry,
    policyGate: agentTools.policy,
    userDir: homedir(),
    contextHandlers: {
      'context/map': bindPerCall('context/map'),
      'context/index': bindPerCall('context/index'),
      'context/search': bindPerCall('context/search'),
    },
    browserd: browserdManager,
    // Phase 8 Stage 3: a trust-verdict change rebuilds that workspace's MCP
    // hub (the hub captures its workspace's verdict at construction) and
    // re-syncs its tools into the registry with workspace execution gating.
    onWorkspaceTrustChanged: (root) => {
      const entry = mcpManager.rebuild(root);
      syncWorkspaceHubTools(entry);
    },
    // Phase 8 Stage 1: socket mode injects a fan-out transport; onShutdown
    // is overridden so the socket file is cleaned up on graceful shutdown.
    ...(extra.transport ? { transport: extra.transport } : {}),
    ...(extra.onShutdown ? { onShutdown: extra.onShutdown } : {}),
  });

  // Phase 4: checkpoints + worktrees. Registered first — the orchestration
  // primitives (`worktree/*`, `checkpoint/*`) are consumed verbatim by Phase 5.
  registerManagerMethods(daemon);

  // Part A: mcp/* server lifecycle + policy/* approvals. Routes to the
  // default hub or a per-workspace hub (Phase 8 Stage 3); the reported
  // trust verdict is the routed workspace's.
  registerMcpMethods(daemon, mcpResolver, agentTools.policy);

  // Browser Agent UI phase: the Agent Browser panel (`browser/panel/*`).
  // Opt-in only — every handler returns a disabled error unless
  // SUNDAY_BROWSER_ENABLED=1 (set from the `sunday.browser.enabled` setting).
  registerBrowserPanelMethods(daemon, browserdManager);

  // Phase 5: hierarchical orchestration (Orchestrator → Feature Agents →
  // Verifier, sequential-only v1). The adapter keeps the package edge
  // one-directional: daemon.ts never imports @sunday/orchestrator (not even
  // its types); structural typing checks the host shape instead.
  registerOrchestrationMethods({
    addMethod: (name, handler) => daemon.registerMethod(name, handler),
    getOrchestratorHost: () => daemon.getOrchestratorHost(),
  });

  // Phase 8: background agents with PR creation. The host is the same
  // orchestrator host plus a `background/event` notify channel (declared on
  // DaemonOrchestratorHost); the package edge stays one-directional via
  // structural typing.
  registerBackgroundMethods({
    addMethod: (name, handler) => daemon.registerMethod(name, handler),
    getBackgroundHost: () => daemon.getOrchestratorHost(),
  });

  // Parallel Agents phase: durable run registry. The store +
  // reconcileOrchestrationRuns live in @sunday/orchestrator (Worker 1) and
  // are loaded dynamically so sundayd keeps building — and starting —
  // against an older orchestrator dist (persistence then degrades to a
  // logged warning instead of crashing the daemon). The store is not passed
  // into the handlers: Worker 1's registry is module-level and
  // getOrchestrationRunState falls back to the persisted file, so
  // stop/status/merge/resolveConflict work across restarts as-is.
  await setupOrchestrationPersistence(
    (await import('@sunday/orchestrator')) as unknown as OrchestrationPersistenceModule,
    (msg) => console.error(msg),
  );

  // MCP config load is additive — a failure is logged, never fatal.
  try {
    await agentTools.ready;
  } catch (e) {
    console.error(`[sundayd] MCP setup failed: ${(e as Error).message}`);
  }

  if (!isWorkspaceTrusted()) {
    console.error('[sundayd] workspace is not trusted: workspace skills with scripts are disabled until approved');
  }

  return daemon;
}

/**
 * Phase 8 Stage 1: `--socket <path>` mode. Listens on a unix socket (POSIX)
 * or named pipe (Windows, e.g. `\\\\.\\pipe\\sundayd-<user>`) with the same
 * NDJSON framing and RPC dispatch as stdio. One `SocketServerTransport` per
 * accepted connection, all sharing the single daemon; notifications fan out
 * to every connected client.
 */
async function serveSocket(socketPath: string): Promise<void> {
  const attached = new Set<SocketServerTransport>();
  const fanout: ServerTransport = {
    start() {
      /* connections drive themselves; nothing to do here */
    },
    notify(method: string, params: unknown) {
      for (const t of [...attached]) {
        try {
          t.notify(method, params);
        } catch {
          /* a dead peer drops on its own close event */
        }
      }
    },
  };

  let server: net.Server | undefined;
  const cleanupAndExit = (code: number): void => {
    try {
      server?.close();
    } catch {
      /* ignore */
    }
    // Phase 8 Stage 2: on clean shutdown of the shared per-user daemon,
    // drop the lockfile — but only when it still names us, so we never
    // delete a successor daemon's lock after a crash + respawn.
    if (isSharedDaemonSocket(socketPath)) {
      releaseDaemonLockIfOurs(sharedDaemonLockPath(), process.pid);
    }
    // Best-effort socket file removal (POSIX). Named pipes on Windows are
    // released by the OS when the last handle closes — no unlink needed.
    if (process.platform !== 'win32') {
      try {
        fs.unlinkSync(socketPath);
      } catch {
        /* ignore */
      }
    }
    process.exit(code);
  };

  const daemon = await buildDaemon({
    transport: fanout,
    onShutdown: () => cleanupAndExit(0),
  });
  await daemon.start().catch((e) => {
    console.error(`sundayd failed to start: ${(e as Error).message}`);
    process.exit(1);
  });

  server = net.createServer((socket) => {
    const t = new SocketServerTransport(socket, (req) => daemon.handleRequest(req), {
      onClose: () => {
        attached.delete(t);
      },
    });
    attached.add(t);
    t.start();
  });
  // A dead peer must never take the server down.
  server.on('error', (err) => {
    console.error(`[sundayd] socket server error: ${(err as Error).message}`);
  });

  await listenWithStaleRecovery(server, socketPath);
  // Restrict the socket to the owning user (POSIX). Best-effort: logs, never fatal.
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(socketPath, 0o600);
    } catch (e) {
      console.error(`[sundayd] warning: could not chmod ${socketPath}: ${(e as Error).message}`);
    }
  }
  // Phase 8 Stage 2: single-flight — when serving the well-known per-user
  // socket, record our PID in the lockfile (overwrites the winning
  // connector's claim) so other windows can tell a live daemon apart from
  // a stale lock. Best-effort: logs, never fatal.
  if (isSharedDaemonSocket(socketPath)) {
    try {
      writeDaemonLock(sharedDaemonLockPath(), {
        pid: process.pid,
        socketPath,
        startedAt: new Date().toISOString(),
        version: 1,
      });
    } catch (e) {
      console.error(`[sundayd] warning: could not write lockfile: ${(e as Error).message}`);
    }
  }
  console.error(`[sundayd] listening on socket ${socketPath}`);

  // Socket mode has no stdin-lifeline; terminate explicitly on signals.
  process.on('SIGTERM', () => cleanupAndExit(0));
  process.on('SIGINT', () => cleanupAndExit(0));
}

/** True when something answers on the socket (i.e. a live daemon owns it). */
function probeSocket(socketPath: string, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect(socketPath);
    const done = (alive: boolean): void => {
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolve(alive);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    timer.unref?.();
    sock.once('connect', () => {
      clearTimeout(timer);
      done(true);
    });
    sock.once('error', () => {
      clearTimeout(timer);
      done(false);
    });
  });
}

function listenOnce(server: net.Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(socketPath);
  });
}

/**
 * Bind the socket, recovering from a stale socket file left by a crashed
 * daemon. If the path is owned by a *live* daemon, this throws — two daemons
 * must never share one socket path (single-flight arrives in Stage 2).
 */
async function listenWithStaleRecovery(server: net.Server, socketPath: string): Promise<void> {
  try {
    await listenOnce(server, socketPath);
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'EADDRINUSE') throw err;
  }
  if (await probeSocket(socketPath)) {
    throw new Error(`sundayd: socket ${socketPath} is already served by a live daemon`);
  }
  // Stale socket file (or released named pipe): remove and retry. Unlink is
  // a no-op for Windows named pipes — the OS releases them when the owner
  // dies — so a retry is all that is needed there.
  if (process.platform !== 'win32') {
    try {
      fs.unlinkSync(socketPath);
    } catch {
      /* ignore */
    }
    // Ensure the parent dir exists for the retry (default ~/.sunday layout).
    try {
      fs.mkdirSync(path.dirname(socketPath), { recursive: true });
    } catch {
      /* ignore */
    }
  }
  await listenOnce(server, socketPath);
}

async function main(): Promise<void> {
  const socketPath = socketFlag();
  if (socketPath) {
    await serveSocket(socketPath);
    return;
  }
  const daemon = await buildDaemon();
  await daemon.start().catch((e) => {
    console.error(`sundayd failed to start: ${(e as Error).message}`);
    process.exit(1);
  });
}

main().catch((e) => {
  console.error(`sundayd failed to start: ${(e as Error).message}`);
  process.exit(1);
});
