// sundayd — system prompt construction (Part A: Editor Intelligence).
//
// Every new session starts with a compact system message built from:
//   - Skills: names + descriptions only (progressive disclosure — the model
//     calls `load_skill(name)` for full bodies).
//   - Rules: active rules from RuleLoader, ascending precedence
//     (system > user > workspace > nested AGENTS.md), clearly delimited.
//   - Memory: opt-in `.sunday/memory.md` + `~/.sunday/memory.md` contents.
//
// `buildSystemPrompt` is pure and unit-tested; `buildSessionSystemPrompt`
// does the async collection and returns `undefined` when everything is empty
// so sessions stay message-free (and existing behavior is unchanged).

import { homedir } from 'node:os';
import { resolve } from 'node:path';
import {
  loadMemory,
  RuleLoader,
  SkillLoader,
  type ActiveRule,
  type SkillSummary,
} from '@sunday/skills';

export interface SystemPromptData {
  skills: SkillSummary[];
  rules: ActiveRule[];
  memory: { workspace?: string; user?: string };
}

export interface SystemPromptOptions {
  /** Workspace root for skills/rules/workspace memory. Defaults to cwd. */
  workspaceDir?: string;
  /** Home dir for user skills/rules/memory. Defaults to os.homedir(). */
  userDir?: string;
}

/** Cap per injected section so a huge memory file can't blow the context. */
const MAX_SECTION_CHARS = 4000;

function truncate(s: string): string {
  const t = s.trim();
  return t.length > MAX_SECTION_CHARS ? `${t.slice(0, MAX_SECTION_CHARS)}\n…[truncated]` : t;
}

/** Gather skills, rules, and memory for a session cwd. */
export async function collectSystemPromptData(
  opts: SystemPromptOptions = {},
): Promise<SystemPromptData> {
  const workspaceDir = resolve(opts.workspaceDir ?? process.cwd());
  const userDir = resolve(opts.userDir ?? homedir());
  const [skills, rules, memory] = await Promise.all([
    new SkillLoader({ workspaceDir, userDir }).discover(),
    new RuleLoader({ workspaceDir, userDir }).loadActiveRules(),
    loadMemory({ workspaceDir, userDir }),
  ]);
  return { skills, rules, memory };
}

/**
 * Build the system prompt from collected data. Pure/testable. Returns ''
 * when there is nothing to inject.
 */
export function buildSystemPrompt(data: SystemPromptData): string {
  const sections: string[] = [];

  if (data.skills.length > 0) {
    const lines = data.skills.map((s) => `- ${s.name} — ${s.description}`);
    sections.push(
      [
        '## Skills',
        '',
        "Available skills (name — description). Call `load_skill(name)` to read a skill's full content before using it.",
        ...lines,
      ].join('\n'),
    );
  }

  if (data.rules.length > 0) {
    const blocks = data.rules.map((r) => `--- rule: ${r.source} ---\n${truncate(r.content)}`);
    sections.push(
      [
        '## Rules',
        '',
        'The following rules apply, in ascending precedence order (later rules override earlier ones when they conflict).',
        '',
        ...blocks,
      ].join('\n'),
    );
  }

  const memBlocks: string[] = [];
  if (data.memory.workspace) {
    memBlocks.push(`### Workspace memory (\`.sunday/memory.md\`)\n${truncate(data.memory.workspace)}`);
  }
  if (data.memory.user) {
    memBlocks.push(`### User memory (\`~/.sunday/memory.md\`)\n${truncate(data.memory.user)}`);
  }
  if (memBlocks.length > 0) {
    sections.push(
      [
        '## Memory',
        '',
        'Persistent notes from previous sessions. Follow them unless the user overrides them in conversation.',
        '',
        ...memBlocks,
      ].join('\n'),
    );
  }

  return sections.join('\n\n');
}

/**
 * Collect + build for a session. Returns `undefined` when every section is
 * empty — the caller then skips injection entirely.
 */
export async function buildSessionSystemPrompt(
  opts: SystemPromptOptions = {},
): Promise<string | undefined> {
  const prompt = buildSystemPrompt(await collectSystemPromptData(opts));
  return prompt.length > 0 ? prompt : undefined;
}
