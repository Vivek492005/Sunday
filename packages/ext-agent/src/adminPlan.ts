// sunday-agent — admin plan toggle (Phase 9.b, Task 8).
//
// `sunday.admin.setPlan`: quickpick a plan (Basic/Smart/Pro) + input a user
// id, then POST {gateway}/admin/users/:id/plan with the `x-admin-key` from
// the `sunday.admin.key` setting. The admin key is never logged.
//
// This is for testing plan gating before billing exists — NOT for
// production use (single shared key, no audit trail, no RBAC).
//
// vscode-coupled by design; covered by adminPlan.test.ts with a mocked
// `vscode` module and an injected fetch.
import * as vscode from 'vscode';
import { DEFAULT_GATEWAY_URL } from './cloudTasks.js';

export const ADMIN_SET_PLAN_COMMAND = 'sunday.admin.setPlan';

/** Config keys (sunday.* namespace). */
export const ADMIN_KEY_CONFIG = 'admin.key';
export const ADMIN_GATEWAY_URL_CONFIG = 'cloudTasks.gatewayUrl';

type PlanId = 'basic' | 'smart' | 'pro';

interface PlanChoice extends vscode.QuickPickItem {
  plan: PlanId;
}

const PLAN_CHOICES: PlanChoice[] = [
  { label: 'Basic', description: 'Free tier — 200 managed req/day', plan: 'basic' },
  { label: 'Smart', description: '₹499/mo — 300 managed req/day, browser agent', plan: 'smart' },
  { label: 'Pro', description: '₹1499/mo — 1500 managed req/day, parallel agents', plan: 'pro' },
];

function gatewayUrl(): string {
  const raw = vscode.workspace
    .getConfiguration('sunday')
    .get<string>(ADMIN_GATEWAY_URL_CONFIG, '')
    .trim()
    .replace(/\/$/, '');
  return raw || process.env.SUNDAY_API_URL?.trim().replace(/\/$/, '') || DEFAULT_GATEWAY_URL;
}

export interface AdminPlanDeps {
  fetchFn?: typeof fetch;
  log: (msg: string) => void;
}

export async function adminSetPlan(deps: AdminPlanDeps): Promise<void> {
  // The key lives in settings, never in logs or notifications.
  const adminKey = vscode.workspace
    .getConfiguration('sunday')
    .get<string>(ADMIN_KEY_CONFIG, '')
    .trim();
  if (!adminKey) {
    void vscode.window.showWarningMessage(
      'Sunday admin key is not configured. Set "sunday.admin.key" in settings to use the admin plan toggle.',
    );
    return;
  }

  const pick = await vscode.window.showQuickPick(PLAN_CHOICES, {
    title: 'Sunday admin: set user plan',
    placeHolder: 'Select the plan to assign (testing only — not for production)',
  });
  if (!pick) return; // dismissed

  const userId = await vscode.window.showInputBox({
    title: 'Sunday admin: set user plan',
    prompt: `User id to move to the ${pick.label} plan`,
    placeHolder: 'e.g. u_9f3a1c2b4d5e6f70',
    validateInput: (v) => (v.trim() ? undefined : 'Enter a user id.'),
  });
  if (!userId) return; // dismissed
  const trimmedId = userId.trim();

  const url = `${gatewayUrl()}/admin/users/${encodeURIComponent(trimmedId)}/plan`;
  let res: Response;
  try {
    res = await (deps.fetchFn ?? fetch)(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-key': adminKey },
      body: JSON.stringify({ plan: pick.plan }),
    });
  } catch (err) {
    deps.log(`admin setPlan: gateway unreachable (${(err as Error).message})`);
    void vscode.window.showErrorMessage(`Could not reach the gateway: ${(err as Error).message}`);
    return;
  }
  if (!res.ok) {
    const snippet = (await res.text().catch(() => '')).slice(0, 300);
    deps.log(`admin setPlan: gateway HTTP ${res.status}`);
    void vscode.window.showErrorMessage(`Set plan failed (HTTP ${res.status}): ${snippet || 'no detail'}`);
    return;
  }
  let plan: string = pick.plan;
  let daily: unknown;
  try {
    const view = (await res.json()) as {
      plan?: unknown;
      entitlements?: Record<string, unknown>;
    };
    if (typeof view.plan === 'string') plan = view.plan;
    daily = view.entitlements?.['managed_models.daily_requests'];
  } catch {
    // Non-JSON 2xx — fall back to the requested plan label.
  }
  deps.log(`admin setPlan: ${trimmedId} -> ${plan}`);
  void vscode.window.showInformationMessage(
    `User ${trimmedId} is now on the ${plan} plan` +
      (typeof daily === 'number' ? ` (${daily} managed requests/day).` : '.'),
  );
}

export function registerAdminPlanCommand(
  context: vscode.ExtensionContext,
  deps: AdminPlanDeps,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(ADMIN_SET_PLAN_COMMAND, () => adminSetPlan(deps)),
  );
}

/** Default production wiring (extension.ts). */
export function defaultAdminPlanDeps(log: (msg: string) => void): AdminPlanDeps {
  return { log };
}
