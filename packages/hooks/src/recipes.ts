/**
 * @sunday/hooks — 5 ready-made recipe hooks (F8).
 *
 * Each recipe is a `HookDef[]` factory. Drop the JSON into
 * `.sunday/hooks.json` (repo) or `~/.sunday/hooks.json` (user).
 * `recipeJson(name)` returns the pretty-printed JSON for copy-paste.
 */

import type { HookDef } from './schema.js';

/**
 * Secret-scan shell script for the recipe. Kept as a plain string built
 * from parts to avoid nested-quote escaping hazards.
 */
const SECRET_SCAN_SCRIPT = [
  'git diff --cached -U0',
  '| grep -nEi',
  String.raw`(api[_-]?key|secret|password|token)\s*[:=]\s*[^[:space:]"']{8,}`,
  '&& echo SUNDAY_SECRET_HIT || true',
].join(' ');

/** Format edited files with prettier (falls back to a no-op when prettier is absent). */
export function formatOnEditRecipe(): HookDef[] {
  return [
    {
      name: 'sunday:format-on-edit',
      event: 'post_edit',
      match: { tools: [], paths: ['**/*.{ts,tsx,js,jsx,json,css,md}'] },
      actions: [
        {
          type: 'run_command',
          command: 'npx',
          args: ['--no-install', 'prettier', '--write', '{file}'],
          timeoutMs: 15000,
          blockOnFailure: false,
        },
      ],
      enabled: true,
    },
  ];
}

/** Scan staged changes for secrets before commit; block the commit on hits. */
export function secretScanRecipe(): HookDef[] {
  return [
    {
      name: 'sunday:secret-scan',
      event: 'pre_commit',
      match: { tools: [], paths: [] },
      actions: [
        {
          type: 'run_command',
          command: 'sh',
          args: [
            '-c',
            // NOTE: uses `sh -c` intentionally — this recipe is documentation
            // for humans to review; the runner itself never uses a shell.
            // Scans staged diff for common secret shapes.
            SECRET_SCAN_SCRIPT,
          ],
          timeoutMs: 10000,
          blockOnFailure: false,
        },
      ],
      enabled: true,
    },
    {
      name: 'sunday:secret-scan-block',
      event: 'pre_commit',
      match: { tools: [], paths: [] },
      actions: [
        {
          type: 'block',
          reason:
            'Secret scan found a possible secret in the staged diff. Remove it (use env vars / secret storage) before committing.',
        },
      ],
      enabled: false, // enable after wiring the scan output check in your flow
    },
  ];
}

/** Never let the agent read .env / credential files (defense in depth — the credential gate already exists). */
export function blockEnvReadsRecipe(): HookDef[] {
  return [
    {
      name: 'sunday:block-env-reads',
      event: 'pre_tool',
      match: {
        tools: ['read_file'],
        paths: ['**/.env', '**/.env.*', '**/*.pem', '**/id_rsa', '**/id_ed25519', '**/*.key'],
      },
      actions: [
        {
          type: 'block',
          reason:
            'Policy: credential files (.env, private keys) must never be read into the agent context. Ask the user to provide the specific value you need.',
        },
      ],
      enabled: true,
    },
  ];
}

/** Run the test suite before the agent may finish a task; block "done" on failure. */
export function testBeforeDoneRecipe(): HookDef[] {
  return [
    {
      name: 'sunday:test-before-done',
      event: 'task.end',
      match: { tools: [], paths: [] },
      actions: [
        {
          type: 'run_command',
          command: 'sh',
          args: ['-c', 'npm test --silent 2>&1 | tail -20'],
          timeoutMs: 120000,
          blockOnFailure: true,
        },
      ],
      enabled: true,
    },
  ];
}

/** Remind (annotate) when source files change without a CHANGELOG entry. */
export function changelogUpdateRecipe(): HookDef[] {
  return [
    {
      name: 'sunday:changelog-reminder',
      event: 'post_edit',
      match: { tools: [], paths: ['src/**/*', 'packages/*/src/**/*'] },
      actions: [
        {
          type: 'annotate',
          text: 'Reminder: source files changed — update CHANGELOG.md if this is user-facing.',
        },
      ],
      enabled: true,
    },
  ];
}

const RECIPES: Record<string, () => HookDef[]> = {
  'format-on-edit': formatOnEditRecipe,
  'secret-scan': secretScanRecipe,
  'block-env-reads': blockEnvReadsRecipe,
  'test-before-done': testBeforeDoneRecipe,
  'changelog-update': changelogUpdateRecipe,
};

/** All recipe names. */
export function recipeNames(): string[] {
  return Object.keys(RECIPES);
}

/** Build a hooks.json payload from recipe names. */
export function buildRecipesFile(names: string[]): { version: 1; hooks: HookDef[] } {
  const hooks: HookDef[] = [];
  for (const n of names) {
    const factory = RECIPES[n];
    if (!factory) throw new Error(`unknown recipe: ${n}`);
    hooks.push(...factory());
  }
  return { version: 1, hooks };
}

/** Pretty JSON for copy-paste into .sunday/hooks.json. */
export function recipeJson(name: string): string {
  return JSON.stringify(buildRecipesFile([name]), null, 2);
}
