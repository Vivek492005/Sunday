import { createRequire } from 'node:module';
import {
  ErrorCode,
  METHODS,
  PROTOCOL_VERSION,
  parseParams,
  type JsonRpcRequest,
  type MethodName,
  type Session,
} from '@sunday/protocol';
import {
  ProviderRegistry,
  Router,
  createDefaultRegistry as createDefaultProviders,
  type RouterPolicyConfig,
} from '@sunday/gateway';
import { ToolRegistry, createDefaultRegistry as createDefaultTools } from '@sunday/tools';
import { RpcError, StdioTransport } from './transport.js';
import { SessionStore, defaultSessionsDir, type StoredSession } from './sessions.js';
import { PolicyGate, type PolicyOptions } from './policy.js';
import { AgentLoop, newTurnId } from './loop.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version?: string };
export const SUNDAYD_VERSION: string = pkg.version ?? '0.0.1';

// Phase 2: context — handler table shape returned by createContextHandlers()
// in @sunday/context. Declared here structurally (not imported) so that
// @sunday/sundayd has no dependency on @sunday/context; the host injects a
// bound table via DaemonOptions.contextHandlers.
export interface DaemonContextHandlers {
  'context/map': (params: unknown) => Promise<unknown>;
  'context/index': (params: unknown) => Promise<unknown>;
  'context/search': (params: unknown) => Promise<unknown>;
}

export interface DaemonOptions {
  sessionsDir?: string;
  defaultModel?: string;
  policy?: PolicyOptions;
  maxIterations?: number;
  /** Dependency injection (tests / embedding). */
  tools?: ToolRegistry;
  providers?: ProviderRegistry;
  onShutdown?: () => void;
  onStdinClose?: () => void;
  /**
   * Phase 3: router policy for provider selection + Relay failover. Defaults
   * to registry order (openrouter → groq) with failover on rate-limit — this
   * is what makes the visible Relay reachable in production. Tests inject
   * their own (e.g. mock providers with forced 429s).
   */
  routerPolicy?: RouterPolicyConfig;
  /** Phase 2: context — bound `context/*` handlers from @sunday/context
   *  (e.g. `createContextHandlers(workspaceRoot)`), injected so sundayd
   *  doesn't depend on @sunday/context. When absent, `context/*` calls fail
   *  with MethodNotFound. */
  contextHandlers?: DaemonContextHandlers;
}

function publicSession(s: StoredSession): Session {
  const { messages: _messages, ...rest } = s;
  return rest;
}

/**
 * sundayd — the Sunday sidecar daemon (§6.3). Speaks JSON-RPC over stdio,
 * owns sessions + the agent loop, and streams `chat/event` notifications.
 * Constructed with defaults it wires the real tool registry and the
 * OpenRouter/Groq provider registry; tests inject mocks.
 */
export class SundayDaemon {
  private readonly transport: StdioTransport;
  private readonly sessions: SessionStore;
  private readonly tools: ToolRegistry;
  private readonly providers: ProviderRegistry;
  private readonly loop: AgentLoop;
  private readonly turns = new Map<string, AbortController>();
  private readonly onShutdown: () => void;
  /** Phase 2: context — injected `context/*` handlers (see DaemonOptions). */
  private readonly contextHandlers: DaemonContextHandlers | undefined;
  /** Persists currently being written — drained before exit so a shutdown can
   *  never truncate a session file. */
  private readonly pendingPersists = new Set<Promise<void>>();
  private shuttingDown = false;

  constructor(
    opts: DaemonOptions = {},
    input?: NodeJS.ReadableStream,
    output?: NodeJS.WritableStream,
  ) {
    this.sessions = new SessionStore(opts.sessionsDir ?? defaultSessionsDir());
    this.tools = opts.tools ?? createDefaultTools();
    this.providers = opts.providers ?? createDefaultProviders();
    // Phase 3: without a policy the router never fails over, so the visible
    // Relay would be dead code in production. Default: registry order with
    // failover on rate-limit (429s), Relay surfaced on chat/event via the
    // sink above.
    const routerPolicy: RouterPolicyConfig = opts.routerPolicy ?? {
      order: this.providers.ids(),
      perProvider: {},
      failover: { enabled: true, on: ['rate-limit'] },
    };
    const router = new Router(this.providers, opts.defaultModel, routerPolicy);
    const policy = new PolicyGate(opts.policy);
    this.onShutdown = opts.onShutdown ?? (() => process.exit(0));
    this.contextHandlers = opts.contextHandlers;
    this.loop = new AgentLoop(
      { tools: this.tools, providers: this.providers },
      {
        // Phase 3: visible Relay — when the loop relays mid-turn, the
        // notification carries via:'relay' + from/to/reason (never silent).
        event: (sessionId, turnId, event, relay) =>
          this.transport.notify(
            'chat/event',
            relay
              ? {
                  turnId,
                  sessionId,
                  event,
                  via: 'relay' as const,
                  relay: { from: relay.from, to: relay.to, reason: relay.reason },
                }
              : { turnId, sessionId, event },
          ),
      },
      { router, policy, defaultModel: opts.defaultModel, maxIterations: opts.maxIterations },
    );
    this.transport = new StdioTransport((req) => this.dispatch(req), input, output, {
      onStdinClose: opts.onStdinClose ?? (() => void this.gracefulExit()),
    });
  }

  async start(): Promise<void> {
    await this.sessions.init();
    this.transport.start();
  }

  /** Tracked persist: registers the in-flight write so gracefulExit can drain it. */
  private async persistSession(s: StoredSession): Promise<void> {
    const p = this.sessions.persist(s);
    this.pendingPersists.add(p);
    try {
      await p;
    } finally {
      this.pendingPersists.delete(p);
    }
  }

  /** Drain in-flight session writes, then hand off to onShutdown (process.exit
   *  by default). Idempotent — a second call while draining is a no-op. */
  private async gracefulExit(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    try {
      await Promise.allSettled([...this.pendingPersists]);
    } finally {
      this.onShutdown();
    }
  }

  private async dispatch(req: JsonRpcRequest): Promise<unknown> {
    // Phase 2: context — dispatched ahead of the switch. CONTEXT_METHODS is
    // part of the central METHODS registry, but these calls are served by
    // the injected @sunday/context handler table (each validates params
    // against the CONTEXT_METHODS zod schemas itself), not by the switch
    // below.
    const maybeContext = req.method as 'context/map' | 'context/index' | 'context/search';
    if (
      maybeContext === 'context/map' ||
      maybeContext === 'context/index' ||
      maybeContext === 'context/search'
    ) {
      const handler = this.contextHandlers?.[maybeContext];
      if (!handler) {
        throw new RpcError(ErrorCode.MethodNotFound, `context not configured: ${req.method}`);
      }
      return handler(req.params);
    }
    const method = req.method as MethodName;
    if (!(method in METHODS)) {
      throw new RpcError(ErrorCode.MethodNotFound, `unknown method: ${req.method}`);
    }
    switch (method) {
      case 'sunday/hello':
        return this.hello(req);
      case 'sunday/ping':
        return { ok: true as const, time: new Date().toISOString() };
      case 'sunday/shutdown':
        setImmediate(() => void this.gracefulExit());
        return { ok: true as const };
      case 'session/create': {
        const p = parseParams(method, req.params);
        const s = this.sessions.create(p);
        await this.persistSession(s);
        return { session: publicSession(s) };
      }
      case 'session/list':
        return { sessions: this.sessions.list() };
      case 'session/restore': {
        const p = parseParams(method, req.params);
        return { session: publicSession(await this.sessions.restore(p.sessionId)) };
      }
      case 'session/close': {
        const p = parseParams(method, req.params);
        this.sessions.close(p.sessionId);
        return { ok: true as const };
      }
      case 'tools/list':
        return { tools: this.tools.definitions() };
      case 'models/list':
        return this.modelsList();
      case 'chat/send':
        return this.chatSend(req);
      case 'chat/cancel': {
        const p = parseParams(method, req.params);
        this.turns.get(p.turnId)?.abort();
        return { ok: true as const };
      }
      default:
        throw new RpcError(ErrorCode.MethodNotFound, `unknown method: ${req.method}`);
    }
  }

  private hello(req: JsonRpcRequest): unknown {
    const p = parseParams('sunday/hello', req.params);
    return {
      protocolVersion: PROTOCOL_VERSION,
      negotiated: p.protocolVersion === PROTOCOL_VERSION,
      server: { name: 'sundayd' as const, version: SUNDAYD_VERSION },
    };
  }

  private async modelsList(): Promise<unknown> {
    try {
      return { models: await this.providers.listModels() };
    } catch {
      // Keys missing / provider down — the daemon stays up; chat/send will
      // surface a per-turn error when a model is actually used.
      return { models: [] };
    }
  }

  private async chatSend(req: JsonRpcRequest): Promise<unknown> {
    const p = parseParams('chat/send', req.params);
    const session = await this.sessions.restore(p.sessionId);
    const turnId = newTurnId();
    const ctrl = new AbortController();
    this.turns.set(turnId, ctrl);
    void this.loop
      .runTurn(turnId, session, p.message, { model: p.model, signal: ctrl.signal })
      .catch(() => undefined) // runTurn reports failures as turn-error events
      .finally(() => {
        this.turns.delete(turnId);
        void this.persistSession(session).catch(() => undefined);
      });
    return { turnId };
  }
}
