import { createRequire } from 'node:module';
import {
  ErrorCode,
  METHODS,
  PROTOCOL_VERSION,
  createRequest,
  parseParams,
  type ChatEvent,
  type JsonRpcRequest,
  type MethodName,
  type Session,
} from '@sunday/protocol';
import {
  ProviderRegistry,
  Router,
  createDefaultRegistry as createDefaultProviders,
  parseModelRef,
  type FimProvider,
  type FimRequest,
  type RouterPolicyConfig,
} from '@sunday/gateway';
import { homedir } from 'node:os';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { DAEMON_BOOT_TOKEN_ENV } from '@sunday/protocol';
import { ToolRegistry, createDefaultRegistry as createDefaultTools, type SandboxConfig } from '@sunday/tools';
import { RpcError, StdioTransport, type ServerTransport } from './transport.js';
import { sandboxConfigFromEnv } from './sandbox.js';
import { SessionStore, defaultSessionsDir, type StoredSession } from './sessions.js';
import { PolicyGate, syncDangerousFlags, type PolicyOptions } from './policy.js';
import {
  canonicalizeWorkspaceRoot,
  isWorkspaceTrusted,
  setWorkspaceTrust,
  workspaceTrust,
} from './trust.js';
import { workspaceSecrets } from './workspace-secrets.js';
import { AgentLoop, DEFAULT_MODEL, newTurnId } from './loop.js';
import { BrowserdManager } from './browserd.js';
import { registerBrowserTools } from './browser-tools.js';
import { buildSessionSystemPrompt } from './system-prompt.js';
import { CompletionOrchestrator } from './completion.js';

/** Part B: default inline-completion model (fast/cheap). */
export const DEFAULT_COMPLETION_MODEL = 'groq:llama-3.1-8b-instant';

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

/**
 * Phase 5: everything the orchestrator needs from the daemon, declared
 * structurally (see DaemonContextHandlers). Field-for-field compatible with
 * the orchestrator's `OrchestratorHost` — the bridge in cli.ts relies on
 * structural typing, never on importing the orchestrator package here.
 *
 * Note the inversion: the orchestrator never constructs an AgentLoop or a
 * session itself. It asks the daemon to run one sub-agent turn via
 * `runSubAgent`; the mechanics stay here. That keeps the package edge
 * one-directional (orchestrator → sundayd would be a cycle, since the
 * daemon's cli wires the orchestrator in).
 */
export interface DaemonOrchestratorHost {
  /** Model router (with Relay failover); the planner calls it directly. */
  router: Router;
  /** Full tool catalogue — handed ONLY to Feature Agents (role=coder). */
  tools: ToolRegistry;
  /** Default model ref when the plan doesn't name one. */
  defaultModel: string;
  /** Dispatch into the daemon's own method table (worktree/*, checkpoint/*). */
  dispatch(method: string, params: unknown): Promise<unknown>;
  /** Emit `orchestrate/event` notifications to connected clients. */
  notify(event: unknown): void;
  /** Emit `background/event` notifications to connected clients (Phase 8). */
  notifyBackground(event: unknown): void;
  /** Run one sub-agent turn — session lifecycle + AgentLoop live here. */
  runSubAgent(opts: DaemonSubAgentOptions): Promise<void>;
}

/**
 * Phase 5: one orchestrator sub-agent turn. Structural mirror of the
 * orchestrator's `SubAgentRunOptions`.
 */
export interface DaemonSubAgentOptions {
  title: string;
  cwd: string;
  model?: string;
  systemPrompt: string;
  prompt: string;
  tools: ToolRegistry;
  maxIterations: number;
  signal?: AbortSignal;
  onEvent: (event: ChatEvent) => void;
}

export interface DaemonOptions {
  sessionsDir?: string;
  defaultModel?: string;
  /**
   * Part B: model ref used for ghost-text inline completions when the
   * `completion/complete` RPC omits `model`. Default
   * `groq:llama-3.1-8b-instant` (fast/cheap; Groq has no FIM endpoint so the
   * gateway serves these via the prefix-only chat fallback).
   */
  completionModel?: string;
  /**
   * Local Model slice (autocomplete only): when true, the completion
   * orchestrator tries the `ollama` provider first (3s timeout) and falls
   * back to the API provider chain silently on any failure. Default false —
   * stamped by the extension from `sunday.localModel.enabled` via
   * SUNDAY_LOCAL_MODEL_ENABLED=1. An explicit option takes precedence over
   * the env var (useful for tests).
   */
  localModelEnabled?: boolean;
  policy?: PolicyOptions;
  /**
   * Part A: a pre-built PolicyGate (from `createSundaydTools()`), sharing
   * the dangerous-tool markings with the tool registry. Takes precedence
   * over `policy` when both are given.
   */
  policyGate?: PolicyGate;
  /** Home dir for user skills/rules/memory in the system prompt. Defaults to os.homedir(). */
  userDir?: string;
  maxIterations?: number;
  /**
   * S3: per-boot token for sensitive RPCs. Defaults to the
   * SUNDAY_DAEMON_BOOT_TOKEN env var (stamped by the spawning extension),
   * else a fresh randomUUID per boot. Tests may inject a fixed value.
   */
  bootToken?: string;
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
  /** Phase 6: browser — managed browserd child. When present, the daemon
   *  registers the `browser_*` agent tools (opt-in, dangerous) and stops the
   *  child on graceful exit. Injected by the composition root (cli.ts). */
  browserd?: BrowserdManager;
  /**
   * Hardening: sandbox execution for agent shell commands (`run_terminal`).
   * Defaults to the environment (`SUNDAY_SANDBOX_MODE`, stamped by the
   * extension from `sunday.sandbox.*`); mode 'off' = host execution.
   */
  sandbox?: SandboxConfig;
  /**
   * Phase 8 Stage 1: inject a pre-built server transport (e.g. a socket
   * fan-out in `--socket` mode). Defaults to NDJSON-over-stdio.
   */
  transport?: ServerTransport;
  /**
   * Phase 8 Stage 3: called after a workspace's trust verdict changes via
   * `daemon/configure` or `daemon/set-workspace-trust`, so the composition
   * root can rebuild that workspace's MCP hub (the hub captures its
   * workspace's trust verdict at construction). Defaults to no-op.
   */
  onWorkspaceTrustChanged?: (workspaceRoot: string) => void;
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
  private readonly transport: ServerTransport;
  private readonly sessions: SessionStore;
  private readonly tools: ToolRegistry;
  private readonly providers: ProviderRegistry;
  /** Phase 3: model router (kept as a field so Phase 5 orchestration can
   *  hand it to sub-agent loops as ordinary clients). */
  private readonly router: Router;
  /** Phase 5: default model ref, handed to the orchestrator host. */
  private readonly defaultModel: string;
  /** Part B: model ref for inline completions (overridable per RPC). */
  private readonly completionModel: string;
  /** Local Model slice: try Ollama first for completions (default off). */
  private readonly localModelEnabled: boolean;
  /** Part B: lazy completion orchestrator (debounce/cache/coalescing). */
  private completionOrchestrator: CompletionOrchestrator | undefined;
  private readonly loop: AgentLoop;
  /** Shared approval gate: the main agent loop AND every orchestrator
   *  sub-agent loop evaluate through this instance, so a dangerous tool can
   *  never run in a sub-agent without the session approval the main loop
   *  would require (SEC-01). */
  private readonly policyGate: PolicyGate;
  private readonly turns = new Map<string, AbortController>();
  private readonly onShutdown: () => void;
  /** Phase 6: managed browserd child (if the composition root opted in). */
  private readonly browserdManager: BrowserdManager | undefined;
  /** Phase 8 Stage 3: workspace trust-change hook (MCP hub rebuild). */
  private readonly onWorkspaceTrustChanged: ((workspaceRoot: string) => void) | undefined;
  /** Home dir for user skills/rules/memory (system prompt injection). */
  private readonly userDir: string;
  /** Hardening: sandbox config for agent shell commands (from opts or env). */
  private readonly sandbox: SandboxConfig;
  /** Phase 2: context — injected `context/*` handlers (see DaemonOptions). */
  private readonly contextHandlers: DaemonContextHandlers | undefined;
  /** Phase 4: dynamically registered method handlers (manager methods).
   *  Wired via `registerManagerMethods(daemon)` in manager.ts. */
  private readonly extraHandlers = new Map<string, (params: unknown) => Promise<unknown>>();
  /**
   * S3: per-boot token guarding sensitive RPCs (`policy/approve`,
   * `daemon/set-workspace-trust`, `mcp/secrets/provide`, `mcp/server/start`).
   * Any local process on the socket without this token is rejected.
   */
  readonly bootToken: string;
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
      // P1-4: SUNDAY_RELAY_FAILOVER_OPTOUT="groq,ollama" skips those providers
      // for automatic relay (explicit provider: pins still work).
      failover: {
        enabled: true,
        on: ['rate-limit'],
        optOut: (process.env.SUNDAY_RELAY_FAILOVER_OPTOUT ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      },
    };
    this.router = new Router(this.providers, opts.defaultModel, routerPolicy);
    this.defaultModel = opts.defaultModel ?? DEFAULT_MODEL;
    this.completionModel = opts.completionModel ?? DEFAULT_COMPLETION_MODEL;
    // Local Model slice: explicit option wins; otherwise the extension
    // stamps SUNDAY_LOCAL_MODEL_ENABLED=1 from sunday.localModel.enabled.
    this.localModelEnabled =
      opts.localModelEnabled ?? process.env.SUNDAY_LOCAL_MODEL_ENABLED === '1';
    const policy = opts.policyGate ?? new PolicyGate(opts.policy);
    this.policyGate = policy;
    this.userDir = opts.userDir ?? homedir();
    // Hardening: sandbox mode for agent shell commands. Env-sourced by
    // default (SUNDAY_SANDBOX_MODE, stamped by the extension); an invalid
    // value throws here — fail closed, never silently unsandboxed.
    this.sandbox = opts.sandbox ?? sandboxConfigFromEnv();
    this.onShutdown = opts.onShutdown ?? (() => process.exit(0));
    this.contextHandlers = opts.contextHandlers;
    // Phase 6: opt-in browser tools. browserd stays a lazy child — it only
    // spawns on first tool use — and is stopped with the daemon.
    this.browserdManager = opts.browserd;
    this.onWorkspaceTrustChanged = opts.onWorkspaceTrustChanged;
    if (opts.browserd) {
      registerBrowserTools(this.tools, opts.browserd);
    }
    // Part A: keep the gate's dangerous set in sync with every registered
    // tool carrying `dangerous: true` (browser tools land here).
    syncDangerousFlags(policy, this.tools);
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
      { router: this.router, policy, defaultModel: opts.defaultModel, maxIterations: opts.maxIterations, sandbox: this.sandbox },
    );
    this.transport = opts.transport ?? new StdioTransport((req) => this.dispatch(req), input, output, {
      onStdinClose: opts.onStdinClose ?? (() => void this.gracefulExit()),
    });
    // S3: per-boot token. The spawning extension stamps SUNDAY_DAEMON_BOOT_TOKEN;
    // standalone/CLI boots get a fresh random token (fail-closed: unknown to callers).
    this.bootToken = opts.bootToken ?? process.env[DAEMON_BOOT_TOKEN_ENV] ?? randomUUID();
  }

  async start(): Promise<void> {
    await this.sessions.init();
    this.transport.start();
  }

  /**
   * Register a JSON-RPC method handler after construction (Phase 4: manager
   * methods via `registerManagerMethods`). The method must exist in the
   * protocol METHODS registry; dispatch consults this table before the
   * built-in switch.
   */
  registerMethod(method: string, handler: (params: unknown) => Promise<unknown>): void {
    this.extraHandlers.set(method, handler);
  }

  /**
   * Phase 5: orchestration host surface. Declared structurally (like
   * DaemonContextHandlers above) so that @sunday/sundayd has no dependency
   * on @sunday/orchestrator — not even at the type level. The orchestrator
   * package drives sundayd's AgentLoop, so the edge must stay
   * one-directional; cli.ts bridges the two via registerOrchestrationMethods.
   */
  getOrchestratorHost(): DaemonOrchestratorHost {
    return {
      router: this.router,
      tools: this.tools,
      defaultModel: this.defaultModel,
      dispatch: (method, params) => this.dispatchLocal(method, params),
      notify: (event) => this.notifyOrchestration(event),
      notifyBackground: (event) => this.notifyBackground(event),
      runSubAgent: (opts) => this.runSubAgent(opts),
    };
  }

  /**
   * Phase 5: execute one orchestrator sub-agent turn. The orchestrator owns
   * the coordination (plan → delegate → verify → merge); the mechanics —
   * ephemeral session, AgentLoop, turn id — stay in the daemon.
   */
  private async runSubAgent(opts: DaemonSubAgentOptions): Promise<void> {
    const session = this.sessions.create({ title: opts.title, cwd: opts.cwd, model: opts.model });
    session.messages.push({ role: 'system', content: opts.systemPrompt });
    // SEC-01: sub-agent loops share the daemon's PolicyGate (with the
    // sub-agent's own tool registry synced for dangerous flags) — a fresh
    // default gate would have an empty dangerous set and silently approve
    // dangerous tools.
    syncDangerousFlags(this.policyGate, opts.tools);
    const loop = new AgentLoop(
      { tools: opts.tools, providers: this.providers },
      { event: (_sessionId, _turnId, event) => opts.onEvent(event) },
      { router: this.router, policy: this.policyGate, defaultModel: this.defaultModel, maxIterations: opts.maxIterations, sandbox: this.sandbox },
    );
    await loop.runTurn(newTurnId(), session, opts.prompt, { model: opts.model, signal: opts.signal });
  }

  /** Phase 5: dispatch into the daemon's own method table (used by the
   *  orchestrator for the `worktree/*` and `checkpoint/*` primitives). */
  async dispatchLocal(method: string, params: unknown): Promise<unknown> {
    return this.dispatch(createRequest(`local-${Date.now()}`, method, params));
  }

  /**
   * Phase 8 Stage 1: per-connection JSON-RPC dispatch for `--socket` mode.
   * The socket server binds one `SocketServerTransport` per accepted
   * connection to this method, so many connections can share one daemon
   * while request ids and responses stay correctly correlated per peer.
   */
  handleRequest(req: JsonRpcRequest): Promise<unknown> {
    return this.dispatch(req);
  }

  /** Phase 5: emit an `orchestrate/event` notification to connected clients. */
  notifyOrchestration(event: unknown): void {
    this.transport.notify('orchestrate/event', event);
  }

  /** Phase 8: emit a `background/event` notification to connected clients. */
  notifyBackground(event: unknown): void {
    this.transport.notify('background/event', event);
  }

  /**
   * Part A: prepend the skills/rules/memory system prompt to a fresh
   * session. Always injected — at minimum the INJECTION_GUARD (§15.4), so
   * the untrusted-content rule is standing even in skill-less workspaces.
   * Failures are logged, never fatal to session creation.
   */
  private async injectSystemPrompt(s: StoredSession): Promise<void> {
    try {
      const prompt = await buildSessionSystemPrompt({
        workspaceDir: s.cwd ?? process.cwd(),
        userDir: this.userDir,
      });
      s.messages.push({ role: 'system', content: prompt });
    } catch (e) {
      console.error(`[sundayd] system prompt build failed: ${(e as Error).message}`);
    }
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

  /**
   * S3: reject sensitive RPCs without the per-boot token. Timing-safe
   * compare; throws RpcError(PolicyDenied) on missing/mismatched token.
   */
  requireBootToken(params: unknown): void {
    const token = (params as { bootToken?: unknown } | null)?.bootToken;
    let ok = false;
    if (typeof token === 'string' && token.length > 0) {
      try {
        ok = timingSafeEqual(Buffer.from(token), Buffer.from(this.bootToken));
      } catch {
        ok = false;
      }
    }
    if (!ok) {
      throw new RpcError(ErrorCode.PolicyDenied, 'missing or invalid daemon boot token');
    }
  }

  /** Drain in-flight session writes, then hand off to onShutdown (process.exit
   *  by default). Idempotent — a second call while draining is a no-op. */
  private async gracefulExit(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    try {
      await Promise.allSettled([...this.pendingPersists]);
      // Phase 6: stop the browser child (no-op when never started).
      await this.browserdManager?.stop().catch(() => undefined);
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
    // Phase 4: dynamically registered handlers (manager methods) win over
    // the built-in switch.
    const extra = this.extraHandlers.get(req.method);
    if (extra) {
      return extra(req.params);
    }
    switch (method) {
      case 'sunday/hello':
        return this.hello(req);
      case 'sunday/ping':
        return { ok: true as const, time: new Date().toISOString() };
      case 'sunday/shutdown':
        setImmediate(() => void this.gracefulExit());
        return { ok: true as const };
      case 'daemon/configure': {
        const p = parseParams('daemon/configure', req.params);
        const root = canonicalizeWorkspaceRoot(p.workspaceRoot);
        if (p.trusted !== undefined) {
          setWorkspaceTrust(root, p.trusted);
          this.onWorkspaceTrustChanged?.(root);
        }
        // Sunday hosted gateway token (GitHub OAuth from the IDE sign-in).
        // Set as env so @sunday/gateway's SundayHostedProvider picks it up.
        // Never logged — treated like any other credential.
        if (p.sundayApiToken) {
          process.env.SUNDAY_API_TOKEN = p.sundayApiToken;
        }
        // browserEnabled / sandboxMode are accepted for forward-compat;
        // per-workspace enforcement of those lands with the browser +
        // sandbox Stage 3 follow-up (daemon-global behavior unchanged).
        return { ok: true as const };
      }
      case 'daemon/set-workspace-trust': {
        this.requireBootToken(req.params); // S3
        const p = parseParams('daemon/set-workspace-trust', req.params);
        const root = canonicalizeWorkspaceRoot(p.workspaceRoot);
        setWorkspaceTrust(root, p.trusted);
        this.onWorkspaceTrustChanged?.(root);
        return { ok: true as const, workspaceRoot: root };
      }
      case 'daemon/status': {
        parseParams('daemon/status', req.params);
        return {
          workspaces: workspaceTrust
            .roots()
            .map((root) => ({ root, trusted: isWorkspaceTrusted(root) })),
          multiWorkspace: workspaceTrust.isMultiWorkspace,
        };
      }
      case 'mcp/secrets/provide': {
        this.requireBootToken(req.params); // S3
        const p = parseParams('mcp/secrets/provide', req.params);
        const count = workspaceSecrets.provide(p.workspaceRoot, p.secrets);
        return { ok: true as const, count };
      }
      case 'session/create': {
        const p = parseParams(method, req.params);
        const s = this.sessions.create(p);
        // Part A: skills/rules/memory system prompt (no-op when empty).
        await this.injectSystemPrompt(s);
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
      case 'session/delete': {
        const p = parseParams(method, req.params);
        const deleted = await this.sessions.delete(p.sessionId);
        return { ok: true as const, deleted };
      }
      case 'tools/list':
        return { tools: this.tools.definitions() };
      case 'models/list':
        return this.modelsList();
      case 'completion/complete':
        return this.completionComplete(req);
      case 'completion/stats':
        return this.getCompletionOrchestrator().stats();
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

  /**
   * Part B: lazy singleton. The FIM call resolves the provider per request
   * so `completionModel` (or the RPC's `model`) picks the adapter; providers
   * without `complete` fail this RPC loudly instead of hanging a keystroke.
   *
   * Local Model slice: when `localModelEnabled`, the `ollama` provider is
   * tried first with a 3s timeout. ANY Ollama failure (not installed, no
   * model pulled, timeout) falls through SILENTLY to the API provider chain
   * — no user-visible error. A `sunday.completion.provider` metric line is
   * emitted on every attempt so the fallback rate is observable (same
   * JSON-on-stderr convention as the orchestrator's latency metric).
   */
  private getCompletionOrchestrator(): CompletionOrchestrator {
    if (!this.completionOrchestrator) {
      let ollama: Partial<FimProvider> | undefined;
      try {
        ollama = this.providers.get('ollama') as Partial<FimProvider>;
      } catch {
        ollama = undefined; // custom registries (tests) may not register it
      }
      this.completionOrchestrator = new CompletionOrchestrator({
        complete: async (req: FimRequest) => {
          if (
            this.localModelEnabled &&
            ollama &&
            typeof ollama.complete === 'function'
          ) {
            // 3s budget for the local model; abort the in-flight request on
            // timeout so a hung Ollama can't pile up sockets behind keystrokes.
            const ctrl = new AbortController();
            const onOuterAbort = () => ctrl.abort();
            req.signal?.addEventListener('abort', onOuterAbort, { once: true });
            const timer = setTimeout(() => ctrl.abort(), 3000);
            timer.unref?.();
            try {
              const result = await ollama.complete({
                ...req,
                model: 'ollama:qwen2.5-coder:1.5b',
                signal: ctrl.signal,
              });
              this.emitMetric('sunday.completion.provider', {
                provider: 'ollama',
              });
              return result;
            } catch (err) {
              // The caller's abort is never papered over with a retry.
              if (req.signal?.aborted) throw err;
              // Ollama down/slow/model-missing — silent fallthrough.
            } finally {
              clearTimeout(timer);
              req.signal?.removeEventListener('abort', onOuterAbort);
            }
          }
          this.emitMetric('sunday.completion.provider', { provider: 'api' });
          const ref = req.model || this.completionModel;
          const { providerId } = parseModelRef(ref, this.completionModel);
          const provider = this.providers.get(providerId) as Partial<FimProvider>;
          if (typeof provider.complete !== 'function') {
            throw new RpcError(
              ErrorCode.InternalError,
              `provider "${providerId}" does not support inline completions`,
            );
          }
          return provider.complete({ ...req, model: ref });
        },
      });
    }
    return this.completionOrchestrator;
  }

  /**
   * Structured metric on the daemon's diagnostics channel (stderr) — the same
   * JSON-line convention as CompletionOrchestrator's log sink; never parsed
   * as RPC.
   */
  private emitMetric(metric: string, fields: Record<string, unknown>): void {
    process.stderr.write(
      JSON.stringify({ metric, ts: new Date().toISOString(), ...fields }) + '\n',
    );
  }

  private async completionComplete(req: JsonRpcRequest): Promise<unknown> {
    const p = parseParams('completion/complete', req.params);
    return this.getCompletionOrchestrator().complete({
      ...p,
      model: p.model ?? this.completionModel,
    });
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
