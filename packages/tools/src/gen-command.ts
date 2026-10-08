import { err, type Tool, type ToolContext, type ToolResult } from './types.js';

/** `generate_command` (§7.7): translate a natural-language description into a
 *  single shell command (PowerShell on Windows, bash elsewhere).
 *
 *  Two-layer safety:
 *  1. Sanitization — the generated text is rejected (never executed) when it
 *     contains multi-command constructs, subshells, backticks, or known
 *     download-cradle patterns. The agent must rephrase instead.
 *  2. Approval — the tool is marked DANGEROUS, so the PolicyGate always asks
 *     the user before the agent runs anything; the intended path is
 *     generate → review → `run_terminal` (which approval-gates again).
 *
 *  The LLM call comes through an injected completer: `ctx.complete` (stamped
 *  by the host, like `ctx.sandbox`) or the factory's `complete` argument.
 *  The tool itself never executes the command it produces.
 */

export type ShellKind = 'powershell' | 'bash';

/** Injected model call: given the translation prompt, return the raw reply. */
export type CompleteFn = (prompt: string) => Promise<string>;

export const GENERATED_COMMAND_MAX_CHARS = 500;

export function shellForCurrentPlatform(): ShellKind {
  return process.platform === 'win32' ? 'powershell' : 'bash';
}

export function buildGenCommandPrompt(description: string, shell: ShellKind): string {
  const shellName = shell === 'powershell' ? 'PowerShell' : 'bash';
  return [
    `Translate the following request into a single ${shellName} command.`,
    'Rules: output ONLY the command — no code fences, no explanation, no commentary.',
    'It must be ONE command: no chaining with ;, && or ||, no newlines.',
    '',
    `Request: ${description}`,
  ].join('\n');
}

export interface SanitizedCommand {
  ok: boolean;
  command?: string;
  reason?: string;
}

/**
 * Adversarial-aware sanitizer. Rejects anything that is not plausibly a
 * single benign command; the caller must ask the agent to rephrase.
 */
export function sanitizeGeneratedCommand(raw: string, shell: ShellKind): SanitizedCommand {
  const command = raw.trim();
  if (!command) return { ok: false, reason: 'the model returned an empty command' };
  if (command.length > GENERATED_COMMAND_MAX_CHARS) {
    return { ok: false, reason: `command exceeds ${GENERATED_COMMAND_MAX_CHARS} characters` };
  }
  if (/[\r\n]/.test(command)) {
    return { ok: false, reason: 'multi-line output rejected — one command only' };
  }
  if (/`/.test(command)) {
    return { ok: false, reason: 'backtick command substitution is not allowed' };
  }
  if (/\$\(/.test(command)) {
    return { ok: false, reason: '$() subshell expansion is not allowed' };
  }
  if (/;/.test(command)) {
    return { ok: false, reason: '";" statement chaining is not allowed — one command only' };
  }
  if (/&&|\|\|/.test(command)) {
    return { ok: false, reason: '"&&"/"||" chaining is not allowed — one command only' };
  }
  if (shell === 'powershell') {
    // Download cradles: iex / Invoke-Expression with a network fetch.
    if (/\biex\b/i.test(command) || /invoke-expression/i.test(command)) {
      return { ok: false, reason: 'Invoke-Expression (iex) is not allowed' };
    }
    if (/invoke-webrequest|invoke-restmethod|\birm\b|\biwr\b|net\.webclient|downloadstring/i.test(command)) {
      return { ok: false, reason: 'network download primitives are not allowed in generated commands' };
    }
  } else {
    if (/\bcurl\b|\bwget\b/.test(command) && /\|\s*(sh|bash)\b/.test(command)) {
      return { ok: false, reason: 'curl|sh / wget|bash download-and-execute patterns are not allowed' };
    }
  }
  return { ok: true, command };
}

export function describeGeneratedCommand(description: string, shell: ShellKind, command: string): string {
  return `Generated ${shell === 'powershell' ? 'PowerShell' : 'bash'} command for "${description}": ${command}. ` +
    'Review it, then run it via run_terminal (approval required).';
}

/** Completer source: explicit factory arg wins, then `ctx.complete` stamped by the host. */
export function resolveCompleter(
  factoryComplete: CompleteFn | undefined,
  ctx: ToolContext,
): CompleteFn | undefined {
  return factoryComplete ?? ctx.complete;
}

export function createGenerateCommandTool(factoryComplete?: CompleteFn): Tool {
  return {
    definition: {
      name: 'generate_command',
      description:
        'Translate a natural-language description into a single shell command (PowerShell on Windows, bash elsewhere). Returns {command, explanation} — it does NOT run the command. Always requires user approval before execution via run_terminal.',
      // P0: generated commands must never execute silently.
      dangerous: true,
      parameters: {
        type: 'object',
        required: ['description'],
        properties: {
          description: {
            type: 'string',
            minLength: 1,
            description: 'What the command should do, in plain language.',
          },
        },
      },
    },
    async execute(rawArgs, ctx: ToolContext): Promise<ToolResult> {
      const args = rawArgs as { description: string };
      const description = (args.description ?? '').trim();
      if (!description) return err('generate_command: description must be non-empty');

      const complete = resolveCompleter(factoryComplete, ctx);
      if (!complete) {
        return err(
          'generate_command: no LLM completer is wired in this host (ctx.complete is unset). ' +
            'Wire one via createGenerateCommandTool(complete) or stamp ctx.complete.',
        );
      }

      const shell = shellForCurrentPlatform();
      let raw: string;
      try {
        raw = await complete(buildGenCommandPrompt(description, shell));
      } catch (e) {
        return err(`generate_command: model call failed: ${(e as Error).message}`);
      }

      const sanitized = sanitizeGeneratedCommand(raw, shell);
      if (!sanitized.ok) {
        return err(
          `generate_command: rejected the model's output (${sanitized.reason}). ` +
            'Ask me to rephrase the request more concretely — the command was NOT executed.',
        );
      }
      const command = sanitized.command!;
      return {
        output: describeGeneratedCommand(description, shell, command),
        metadata: { command, shell, description },
      };
    },
  };
}

/** Ready-made instance: resolves its completer from `ctx.complete` at call time. */
export const generateCommandTool: Tool = createGenerateCommandTool();
