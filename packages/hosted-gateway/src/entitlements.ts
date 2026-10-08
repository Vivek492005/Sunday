/**
 * @sunday/hosted-gateway — Entitlements model (Phase 9.b).
 *
 * A *plan* is what the user bought (basic/smart/pro). An *entitlement* is a
 * specific, checkable permission or limit derived from that plan. Clients
 * NEVER hard-code "if plan == pro" — they check entitlement keys, which is
 * what makes trials, grandfathering, and tier changes possible without a
 * client update.
 *
 * Plan templates live in `data/plans.json`. This module holds the TypeScript
 * types, runtime validation, and the pure `computeEntitlements()` function.
 * Route wiring (admin endpoint, /me/entitlements upgrade) is separate.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultDataDir } from './accounts.js';

/** All known entitlement keys. */
export const ENTITLEMENT_KEYS = [
  'managed_models.enabled',
  'managed_models.daily_requests',
  'orchestration.max_feature_agents',
  'orchestration.parallel',
  'browser_agent.enabled',
  'browser_agent.daily_sessions',
  'codebase_index.max_repo_mb',
  'autocomplete.managed_route',
  'scheduler.priority_class',
  'support.tier',
] as const;

export type EntitlementKey = (typeof ENTITLEMENT_KEYS)[number];

export type EntitlementValue = boolean | number | string;

export type Entitlements = Record<EntitlementKey, EntitlementValue>;

export type PlanId = 'basic' | 'smart' | 'pro';

export interface PlanTemplate {
  id: PlanId;
  name: string;
  /** Price in INR paise (e.g. 49900 = ₹499). 0 = free. Illustrative until real costs are known. */
  price_inr_paise: number;
  interval: 'month';
  description: string;
  entitlements: Entitlements;
}

export interface PlansFile {
  version: number;
  plans: PlanTemplate[];
}

export type SubscriptionStatus = 'active' | 'past_due' | 'cancelling' | 'cancelled';

/** The served-to-client entitlements view (plan §5.2). */
export interface EntitlementsView {
  user_id: string;
  plan: PlanId;
  status: SubscriptionStatus;
  /** ISO timestamp of next renewal, or null for free plans. */
  renews_at: string | null;
  entitlements: Entitlements;
  cached_at: string;
  /** ISO timestamp until which the client may use this without refetching. */
  valid_until: string;
}

/** How long a served entitlements view stays fresh on the client (1 hour). */
export const ENTITLEMENTS_TTL_MS = 3600 * 1000;

/** Grace window: keep using last-known entitlements this long when offline (72h). */
export const ENTITLEMENTS_GRACE_MS = 72 * 3600 * 1000;

/**
 * Load and validate plans.json. Throws on missing file, bad JSON, or
 * schema violations — fail closed: no plans, no paid entitlements.
 */
export function loadPlans(dataDir: string = defaultDataDir()): PlansFile {
  const path = join(dataDir, 'plans.json');
  if (!existsSync(path)) {
    throw new Error(`plans.json not found at ${path}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`plans.json is not valid JSON: ${(err as Error).message}`);
  }
  return validatePlansFile(parsed);
}

/** Validate unknown input against the PlansFile schema. Throws on violation. */
export function validatePlansFile(input: unknown): PlansFile {
  if (typeof input !== 'object' || input === null) {
    throw new Error('plans.json: top-level must be an object');
  }
  const obj = input as Record<string, unknown>;
  if (typeof obj.version !== 'number') {
    throw new Error('plans.json: version must be a number');
  }
  if (!Array.isArray(obj.plans) || obj.plans.length === 0) {
    throw new Error('plans.json: plans must be a non-empty array');
  }
  const seen = new Set<string>();
  const plans: PlanTemplate[] = obj.plans.map((p, i) => {
    const plan = validatePlanTemplate(p, i);
    if (seen.has(plan.id)) {
      throw new Error(`plans.json: duplicate plan id "${plan.id}"`);
    }
    seen.add(plan.id);
    return plan;
  });
  if (!seen.has('basic')) {
    throw new Error('plans.json: must include a "basic" plan');
  }
  return { version: obj.version, plans };
}

function validatePlanTemplate(input: unknown, index: number): PlanTemplate {
  const where = `plans.json: plans[${index}]`;
  if (typeof input !== 'object' || input === null) {
    throw new Error(`${where}: must be an object`);
  }
  const p = input as Record<string, unknown>;
  const id = p.id;
  if (id !== 'basic' && id !== 'smart' && id !== 'pro') {
    throw new Error(`${where}: id must be basic|smart|pro, got ${JSON.stringify(id)}`);
  }
  if (typeof p.name !== 'string' || p.name.length === 0) {
    throw new Error(`${where}: name must be a non-empty string`);
  }
  if (typeof p.price_inr_paise !== 'number' || p.price_inr_paise < 0 || !Number.isInteger(p.price_inr_paise)) {
    throw new Error(`${where}: price_inr_paise must be a non-negative integer`);
  }
  if (p.interval !== 'month') {
    throw new Error(`${where}: interval must be "month"`);
  }
  if (typeof p.description !== 'string') {
    throw new Error(`${where}: description must be a string`);
  }
  const entitlements = validateEntitlements(p.entitlements, `${where}.entitlements`);
  return {
    id,
    name: p.name,
    price_inr_paise: p.price_inr_paise,
    interval: p.interval,
    description: p.description,
    entitlements,
  };
}

/** Validate an entitlements map: all known keys present, correct value types. */
export function validateEntitlements(input: unknown, where = 'entitlements'): Entitlements {
  if (typeof input !== 'object' || input === null) {
    throw new Error(`${where}: must be an object`);
  }
  const obj = input as Record<string, unknown>;
  const out = {} as Entitlements;
  for (const key of ENTITLEMENT_KEYS) {
    const v = obj[key];
    if (v === undefined) {
      throw new Error(`${where}: missing key "${key}"`);
    }
    if (!isValidEntitlementValue(key, v)) {
      throw new Error(`${where}: key "${key}" has invalid value ${JSON.stringify(v)}`);
    }
    (out as Record<string, EntitlementValue>)[key] = v as EntitlementValue;
  }
  return out;
}

function isValidEntitlementValue(key: EntitlementKey, v: unknown): boolean {
  switch (key) {
    case 'managed_models.enabled':
    case 'orchestration.parallel':
    case 'browser_agent.enabled':
    case 'autocomplete.managed_route':
      return typeof v === 'boolean';
    case 'managed_models.daily_requests':
    case 'orchestration.max_feature_agents':
    case 'browser_agent.daily_sessions':
    case 'codebase_index.max_repo_mb':
      return typeof v === 'number' && Number.isInteger(v) && v >= 0;
    case 'scheduler.priority_class':
      return v === 'standard' || v === 'elevated' || v === 'highest';
    case 'support.tier':
      return (
        v === 'community' || v === 'email' || v === 'priority_email'
      );
    default:
      return false;
  }
}

/**
 * Resolve a user's stored plan against the loaded templates. A stored plan
 * id missing from plans.json (e.g. a template removed after the record was
 * written) falls back to 'basic', which the schema guarantees exists.
 * Pure function — no I/O.
 */
export function planOrBasic(plan: PlanId, plans: PlansFile): PlanId {
  return plans.plans.some((p) => p.id === plan) ? plan : 'basic';
}

/**
 * Compute the served entitlements view for a user from their plan.
 * Pure function — no I/O. `now` is injectable for tests.
 */
export function computeEntitlements(
  userId: string,
  plan: PlanId,
  plans: PlansFile,
  opts: { status?: SubscriptionStatus; renews_at?: string | null; now?: number } = {},
): EntitlementsView {
  const template = plans.plans.find((p) => p.id === plan);
  if (!template) {
    throw new Error(`unknown plan "${plan}"`);
  }
  const now = opts.now ?? Date.now();
  const cachedAt = new Date(now).toISOString();
  return {
    user_id: userId,
    plan: template.id,
    status: opts.status ?? 'active',
    renews_at: opts.renews_at ?? null,
    entitlements: { ...template.entitlements },
    cached_at: cachedAt,
    valid_until: new Date(now + ENTITLEMENTS_TTL_MS).toISOString(),
  };
}

/**
 * Validate a cached/served entitlements view received from the network.
 * Returns true only if the shape is valid AND valid_until is a real date.
 * Expiry checking is the caller's job (grace window logic).
 */
export function isValidEntitlementsView(input: unknown): input is EntitlementsView {
  if (typeof input !== 'object' || input === null) return false;
  const v = input as Record<string, unknown>;
  if (typeof v.user_id !== 'string' || v.user_id.length === 0) return false;
  if (v.plan !== 'basic' && v.plan !== 'smart' && v.plan !== 'pro') return false;
  if (
    v.status !== 'active' &&
    v.status !== 'past_due' &&
    v.status !== 'cancelling' &&
    v.status !== 'cancelled'
  ) {
    return false;
  }
  if (v.renews_at !== null && typeof v.renews_at !== 'string') return false;
  try {
    validateEntitlements(v.entitlements, 'view.entitlements');
  } catch {
    return false;
  }
  for (const k of ['cached_at', 'valid_until'] as const) {
    if (typeof v[k] !== 'string' || Number.isNaN(Date.parse(v[k] as string))) return false;
  }
  return true;
}

/** True when the view is past its valid_until. */
export function isEntitlementsExpired(view: EntitlementsView, now: number = Date.now()): boolean {
  return Date.parse(view.valid_until) <= now;
}

/** True when still inside the 72h grace window after expiry. */
export function isWithinGraceWindow(view: EntitlementsView, now: number = Date.now()): boolean {
  const expiredAt = Date.parse(view.valid_until);
  return now - expiredAt <= ENTITLEMENTS_GRACE_MS;
}

/** The safe fallback: Basic-equivalent with no managed access at all. */
export function fallbackEntitlements(userId: string, now: number = Date.now()): EntitlementsView {
  return {
    user_id: userId,
    plan: 'basic',
    status: 'active',
    renews_at: null,
    entitlements: {
      'managed_models.enabled': false,
      'managed_models.daily_requests': 0,
      'orchestration.max_feature_agents': 1,
      'orchestration.parallel': false,
      'browser_agent.enabled': false,
      'browser_agent.daily_sessions': 0,
      'codebase_index.max_repo_mb': 100,
      'autocomplete.managed_route': false,
      'scheduler.priority_class': 'standard',
      'support.tier': 'community',
    },
    cached_at: new Date(now).toISOString(),
    valid_until: new Date(now + ENTITLEMENTS_TTL_MS).toISOString(),
  };
}
