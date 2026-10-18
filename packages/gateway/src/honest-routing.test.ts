/**
 * F3 — Honest Routing & Task-class Router tests.
 *
 * Acceptance gates:
 *  (a) downgrade=ask → the provider/model is NEVER switched without consent
 *      (no handler, denied, timeout → pause, never switch).
 *  (b) every routing decision is recorded in the session log (100% coverage:
 *      each chat() emits route-start and route-end/route-error).
 */
import { describe, it, expect } from 'vitest';
import {
  MockChatProvider,
  ProviderRegistry,
  Router,
  RoutingPausedError,
  RoutingSession,
  type ChatChunk,
  type ConsentHandler,
  type DowngradeConsentRequest,
  type RoutePolicy,
  type RouterPolicyConfig,
} from './index.js';

function okScript(text = 'ok'): ChatChunk[][] {
  return [[{ type: 'text-delta', delta: text }, { type: 'done', finishReason: 'stop' } as const]];
}

async function drain(gen: AsyncIterable<ChatChunk>): Promise<string> {
  let out = '';
  for await (const c of gen) {
    if (c.type === 'text-delta') out += c.delta;
  }
  return out;
}

function failoverPolicy(): RouterPolicyConfig {
  return { order: ['p1', 'p2'], perProvider: {}, failover: { enabled: true, on: ['rate-limit'] } };
}

function askPolicies(): RoutePolicy[] {
  return [
    {
      taskClass: 'default',
      primary: 'p1:meta-llama/llama-3.3-70b-instruct',
      fallbacks: ['p2:llama-3.1-8b-instant'],
      downgrade: 'ask',
    },
  ];
}

/** Registry: p1 always 429s, p2 serves (two scripts — one per chat call). */
function registry429(): ProviderRegistry {
  const r = new ProviderRegistry();
  r.register(new MockChatProvider({ id: 'p1', force429: true }));
  r.register(
    new MockChatProvider({
      id: 'p2',
      scripts: [...okScript('served-by-p2'), ...okScript('served-by-p2')],
    }),
  );
  return r;
}

const baseReq: { model: string; messages: [] } = {
  model: 'p1:meta-llama/llama-3.3-70b-instruct',
  messages: [],
};

describe('F3 honest routing', () => {
  it('ask + consent yes → switches, relay + consent recorded, quality note honest', async () => {
    const seen: DowngradeConsentRequest[] = [];
    const handler: ConsentHandler = async (req) => {
      seen.push(req);
      return { decision: 'yes' };
    };
    const router = new Router(registry429(), 'p1:x', failoverPolicy(), undefined, undefined, {
      routePolicies: askPolicies(),
      consentHandler: handler,
    });
    const res = await router.chat({ ...baseReq });
    expect(res.provider.id).toBe('p2');
    expect(res.model).toBe('llama-3.1-8b-instant');
    expect(await drain(res.stream)).toBe('served-by-p2');
    expect(res.relay).toMatchObject({ from: 'p1', to: 'p2', reason: 'rate-limit' });

    // Consent prompt carried the honest quality delta (strong→fast, low→free).
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      from: 'p1:meta-llama/llama-3.3-70b-instruct',
      to: 'p2:llama-3.1-8b-instant',
      reason: 'rate-limit',
    });
    expect(seen[0].qualityNote).toBe('est. quality ↓, cost ↓');

    const kinds = router.routingLog.entries().map((e) => e.kind);
    expect(kinds[0]).toBe('route-start');
    expect(kinds).toContain('consent-request');
    expect(kinds).toContain('consent-response');
    expect(kinds).toContain('relay');
    expect(kinds[kinds.length - 1]).toBe('route-end');
    const consentResp = router.routingLog.ofKind('consent-response')[0];
    expect(consentResp.consent?.decision).toBe('yes');
  });

  it('ask + consent wait → NEVER switches, pauses with the original failure preserved', async () => {
    const router = new Router(registry429(), 'p1:x', failoverPolicy(), undefined, undefined, {
      routePolicies: askPolicies(),
      consentHandler: async () => ({ decision: 'wait' }),
    });
    const err = await router.chat({ ...baseReq }).catch((e) => e);
    expect(err).toBeInstanceOf(RoutingPausedError);
    expect((err as RoutingPausedError).pauseReason).toBe('consent-denied');
    // p2 was never attempted — the switch did not happen.
    const attempted = router.routingLog.ofKind('attempt').map((e) => e.providerId);
    expect(attempted).not.toContain('p2');
    expect(router.routingLog.ofKind('relay')).toHaveLength(0);
    // …but the decision is still fully logged.
    const kinds = router.routingLog.entries().map((e) => e.kind);
    expect(kinds[0]).toBe('route-start');
    expect(kinds).toContain('consent-request');
    expect(kinds[kinds.length - 1]).toBe('route-error');
  });

  it('ask + consent later → pauses with retry-later', async () => {
    const router = new Router(registry429(), 'p1:x', failoverPolicy(), undefined, undefined, {
      routePolicies: askPolicies(),
      consentHandler: async () => ({ decision: 'later' }),
    });
    const err = await router.chat({ ...baseReq }).catch((e) => e);
    expect(err).toBeInstanceOf(RoutingPausedError);
    expect((err as RoutingPausedError).pauseReason).toBe('retry-later');
  });

  it('ask + NO handler → safe default = pause, never switches', async () => {
    const router = new Router(registry429(), 'p1:x', failoverPolicy(), undefined, undefined, {
      routePolicies: askPolicies(),
      // no consentHandler wired
    });
    const err = await router.chat({ ...baseReq }).catch((e) => e);
    expect(err).toBeInstanceOf(RoutingPausedError);
    expect((err as RoutingPausedError).pauseReason).toBe('no-consent-handler');
    const attempted = router.routingLog.ofKind('attempt').map((e) => e.providerId);
    expect(attempted).not.toContain('p2');
  });

  it('ask + handler timeout → pause (safe default)', async () => {
    const router = new Router(registry429(), 'p1:x', failoverPolicy(), undefined, undefined, {
      routePolicies: askPolicies(),
      consentHandler: () => new Promise(() => {}), // never answers
      consentTimeoutMs: 50,
    });
    const err = await router.chat({ ...baseReq }).catch((e) => e);
    expect(err).toBeInstanceOf(RoutingPausedError);
    expect((err as RoutingPausedError).pauseReason).toBe('consent-timeout');
    const resp = router.routingLog.ofKind('consent-response')[0];
    expect(resp.consent?.decision).toBe('timeout');
  });

  it('ask + "always for this session" → second downgrade needs no new prompt', async () => {
    let calls = 0;
    const session = new RoutingSession();
    const router = new Router(registry429(), 'p1:x', failoverPolicy(), undefined, undefined, {
      routePolicies: askPolicies(),
      consentHandler: async () => {
        calls++;
        return { decision: 'yes', rememberSession: true };
      },
      session,
    });
    const r1 = await router.chat({ ...baseReq });
    expect(await drain(r1.stream)).toBe('served-by-p2');
    expect(calls).toBe(1);
    // p1 is now cooling down from the first 429; the gate still fires, but
    // the remembered consent lets it through without a second prompt.
    const r2 = await router.chat({ ...baseReq });
    expect(await drain(r2.stream)).toBe('served-by-p2');
    expect(calls).toBe(1);
  });

  it('downgrade=never → original error surfaces, no fallback attempted', async () => {
    const policies: RoutePolicy[] = [
      { taskClass: 'default', primary: 'p1:m', fallbacks: ['p2:m'], downgrade: 'never' },
    ];
    const router = new Router(registry429(), 'p1:m', failoverPolicy(), undefined, undefined, {
      routePolicies: policies,
    });
    const err = await router
      .chat({ model: 'p1:m', messages: [] })
      .catch((e) => e);
    expect(err).not.toBeInstanceOf(RoutingPausedError);
    expect(String((err as Error).message)).toMatch(/429/);
    const attempted = router.routingLog.ofKind('attempt').map((e) => e.providerId);
    expect(attempted).not.toContain('p2');
  });

  it('downgrade=auto → legacy automatic relay still works', async () => {
    const policies: RoutePolicy[] = [
      { taskClass: 'default', primary: 'p1:m', fallbacks: ['p2:m2'], downgrade: 'auto' },
    ];
    let consentCalls = 0;
    const router = new Router(registry429(), 'p1:m', failoverPolicy(), undefined, undefined, {
      routePolicies: policies,
      consentHandler: async () => {
        consentCalls++;
        return { decision: 'yes' };
      },
    });
    const res = await router.chat({ model: 'p1:m', messages: [] });
    expect(res.provider.id).toBe('p2');
    expect(res.model).toBe('m2');
    expect(res.relay).toMatchObject({ from: 'p1', to: 'p2' });
    expect(consentCalls).toBe(0); // auto never asks
    expect(router.routingLog.ofKind('consent-request')).toHaveLength(0);
  });

  it('task-class routing: edit uses the edit policy primary, not req.model', async () => {
    const policies: RoutePolicy[] = [
      { taskClass: 'default', primary: 'p1:model-a', fallbacks: [], downgrade: 'auto' },
      { taskClass: 'edit', primary: 'p2:model-edit', fallbacks: [], downgrade: 'auto' },
    ];
    const r = new ProviderRegistry();
    r.register(new MockChatProvider({ id: 'p1', scripts: okScript('from-p1') }));
    r.register(new MockChatProvider({ id: 'p2', scripts: okScript('from-p2') }));
    const router = new Router(r, 'p1:model-a', failoverPolicy(), undefined, undefined, {
      routePolicies: policies,
    });
    const res = await router.chat({ model: 'p1:model-a', messages: [], taskClass: 'edit' });
    expect(res.provider.id).toBe('p2');
    expect(res.model).toBe('model-edit');
    expect(await drain(res.stream)).toBe('from-p2');
    const start = router.routingLog.ofKind('route-start')[0];
    expect(start.taskClass).toBe('edit');
    expect(start.primary).toBe('p2:model-edit');
    expect(start.requestedModel).toBe('p1:model-a');
    // route() honors the task class too.
    const routed = router.route({ model: 'p1:model-a', taskClass: 'edit' });
    expect(routed.model).toBe('model-edit');
  });

  it('unknown primary provider in a policy → config error, fail fast', async () => {
    const policies: RoutePolicy[] = [
      { taskClass: 'default', primary: 'nope:m', fallbacks: ['p2:m'], downgrade: 'auto' },
    ];
    const router = new Router(registry429(), 'p1:m', failoverPolicy(), undefined, undefined, {
      routePolicies: policies,
    });
    await expect(router.chat({ model: 'p1:m', messages: [] })).rejects.toThrow(
      /unknown provider 'nope' in route policy/,
    );
  });
});
