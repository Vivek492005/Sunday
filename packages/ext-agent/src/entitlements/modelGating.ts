// sunday-agent — managed-model gating for the chat model picker (Task 7).
//
// Pure functions over an EntitlementsView; the ChatViewProvider wires them
// to the webview. Client code never branches on plan names — only on
// entitlement keys via the helpers in types.js.

import {
  canUseManagedModels,
  dailyRequestLimit,
  type EntitlementsView,
} from './types.js';

/**
 * Provider id of the Sunday-hosted (gateway-routed) models. The
 * SundayHostedProvider in @sunday/gateway registers with `id = 'sunday'`;
 * those are the models whose quota the hosted gateway enforces.
 */
export const MANAGED_PROVIDER_ID = 'sunday';

/** Greyed-model hint shown when the daily managed-request quota is spent. */
export const DAILY_LIMIT_HINT = 'Daily limit reached — upgrade';

export interface ModelLike {
  id: string;
  provider: string;
  label: string;
}

/** True when the model is gateway-routed (quota-enforced), not local/BYOK. */
export function isManagedModel(m: Pick<ModelLike, 'provider'>): boolean {
  return m.provider === MANAGED_PROVIDER_ID;
}

export interface GatedModel extends ModelLike {
  /** Set when the model is listed but must not be selected. */
  disabled?: boolean;
  /** Human-readable reason for `disabled` (rendered greyed in the picker). */
  hint?: string;
}

/**
 * Gate a model list against entitlements (pure, testable):
 * - `view` undefined (provider unset / read failed) → fail open: list as-is.
 * - `managed_models.enabled` false → managed models are EXCLUDED entirely.
 * - enabled but `usedToday >= dailyRequestLimit` → managed models stay in
 *   the list but greyed with the upgrade hint.
 */
export function gateModelList(
  models: readonly ModelLike[],
  view: EntitlementsView | undefined,
  usedToday: number,
): GatedModel[] {
  if (!view) return models.map((m) => ({ ...m }));
  if (!canUseManagedModels(view)) {
    return models.filter((m) => !isManagedModel(m)).map((m) => ({ ...m }));
  }
  const limit = dailyRequestLimit(view);
  const exhausted = limit > 0 && usedToday >= limit;
  if (!exhausted) return models.map((m) => ({ ...m }));
  return models.map((m) =>
    isManagedModel(m) ? { ...m, disabled: true, hint: DAILY_LIMIT_HINT } : { ...m },
  );
}

/**
 * Why a selected model id cannot be used, or undefined when it is
 * selectable. Used by the chat view to show an info message INSTEAD of
 * calling the model when the user picks a gated model.
 */
export function modelSelectionBlock(
  models: readonly GatedModel[],
  modelId: string | undefined,
): string | undefined {
  if (!modelId || models.length === 0) return undefined; // unknown — fail open
  const found = models.find((m) => m.id === modelId);
  if (!found) {
    return 'That model is not available on your plan — pick another model.';
  }
  if (found.disabled) {
    const reason = found.hint ?? 'not available on your plan';
    return `${found.label}: ${reason}.`;
  }
  return undefined;
}
