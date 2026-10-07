// sunday-agent — Code actions (Part B, Worker 3).
//
// Registers a CodeActionProvider for all languages plus the backing
// `sunday.codeAction.*` commands. Sending policy (shared with the other
// Part B features, see agentSend.ts): direct `chatSend` via the HostBridge,
// then focus the chat view so the turn streams visibly. No prefill path
// exists on the chat view, and direct send is consistent everywhere.
//
// Pure, unit-tested helpers: buildFixPrompt / buildExplainPrompt /
// buildTestsPrompt, summarizeDiagnostics, findEnclosingBlock,
// extractRelevantCode, truncateCode.
import * as vscode from 'vscode';
import { AgentSender, type AgentSendDeps } from './agentSend.js';
import { redactSecrets } from '@sunday/protocol'; // S6: redact secrets from outbound prompts

/** Plain-data view of a vscode.Diagnostic (keeps prompt builders vscode-free). */
export interface DiagnosticSummary {
  message: string;
  /** e.g. 'Error', 'Warning', 'Information', 'Hint'. */
  severity: string;
  /** 1-based line number. */
  line: number;
  code?: string;
}

/** Cap on code text embedded in a prompt (selections can be enormous). */
export const CODE_MAX_CHARS = 16_000;

/** Convert vscode diagnostics to plain summaries. */
export function summarizeDiagnostics(diagnostics: readonly vscode.Diagnostic[]): DiagnosticSummary[] {
  return diagnostics.map((d) => ({
    message: d.message,
    severity: vscode.DiagnosticSeverity[d.severity] ?? String(d.severity),
    line: d.range.start.line + 1,
    code:
      typeof d.code === 'string' || typeof d.code === 'number' ? String(d.code) : undefined,
  }));
}

/** Truncate long code for prompts (keeps the head; diagnostics reference it). */
export function truncateCode(code: string, maxChars = CODE_MAX_CHARS): string {
  if (code.length <= maxChars) return code;
  return code.slice(0, maxChars) + `\n…[truncated ${code.length - maxChars} chars]`;
}

/** Prompt: fix the given diagnostics in the given code. */
export function buildFixPrompt(
  diagnostics: DiagnosticSummary[],
  code: string,
  opts: { filePath?: string; languageId?: string } = {},
): string {
  const lines = diagnostics.map(
    (d) => `- [${d.severity}] line ${d.line}${d.code ? ` (${d.code})` : ''}: ${redactSecrets(d.message)}`,
  );
  const where = opts.filePath ? ` in ${opts.filePath}` : '';
  return [
    `Fix the following diagnostics${where}. Make the minimal edits needed so every diagnostic is resolved; apply the fixes to the workspace files with your editing tools. Do not only explain — fix them.`,
    '',
    'Diagnostics:',
    ...lines,
    '',
    'Code:',
    '```' + (opts.languageId ?? ''),
    redactSecrets(truncateCode(code)),
    '```',
    '',
    'After fixing, reply briefly with what you changed.',
  ].join('\n');
}

/** Prompt: explain the given code. */
export function buildExplainPrompt(code: string, languageId: string): string {
  const lang = languageId || 'code';
  return [
    `Explain what the following ${lang} code does. Be concise: its purpose, the key logic, and any notable edge cases or risks.`,
    '',
    '```' + lang,
    redactSecrets(truncateCode(code)),
    '```',
  ].join('\n');
}

/** Prompt: generate vitest tests for the given code. */
export function buildTestsPrompt(code: string, languageId: string): string {
  const lang = languageId || 'code';
  return [
    `Write vitest unit tests for the following ${lang} code. Cover the main paths and edge cases; keep the tests self-contained and runnable with \`vitest run\`.`,
    '',
    '```' + lang,
    redactSecrets(truncateCode(code)),
    '```',
  ].join('\n');
}

export interface TextSpan {
  start: number;
  end: number;
}

/**
 * Find the smallest brace-balanced block enclosing `offset`. Best-effort
 * heuristic: skips string literals (' " `) and // and /* *​/ comments while
 * scanning. Returns the span of the block including its braces, or undefined
 * when the cursor is not inside any block (e.g. top-level Python).
 */
export function findEnclosingBlock(text: string, offset: number): TextSpan | undefined {
  const stack: number[] = [];
  let i = 0;
  let innermost = -1;
  while (i <= offset && i < text.length) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i + 1 < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      i++;
      while (i < text.length && text[i] !== q) {
        if (text[i] === '\\') i++;
        i++;
      }
      i++;
      continue;
    }
    if (c === '{') stack.push(i);
    else if (c === '}') stack.pop();
    i++;
  }
  innermost = stack.length ? stack[stack.length - 1] : -1;
  if (innermost < 0) return undefined;
  // Scan forward from offset for the matching close brace.
  let depth = 1;
  i = offset + 1;
  while (i < text.length && depth > 0) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i + 1 < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      i++;
      while (i < text.length && text[i] !== q) {
        if (text[i] === '\\') i++;
        i++;
      }
      i++;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    i++;
  }
  if (depth !== 0) return undefined;
  return { start: innermost, end: i };
}

/**
 * Pure selection logic: explicit selection wins; otherwise the enclosing
 * brace block around the cursor; otherwise the cursor's line.
 */
export function extractRelevantCode(text: string, selStart: number, selEnd: number = selStart): string {
  if (selEnd > selStart) return text.slice(selStart, selEnd);
  const block = findEnclosingBlock(text, selStart);
  if (block) {
    // Include the line the opening brace sits on (e.g. the `function f()` signature).
    const lineStart = text.lastIndexOf('\n', block.start - 1) + 1;
    return text.slice(lineStart, block.end);
  }
  const lineStart = text.lastIndexOf('\n', selStart - 1) + 1;
  let lineEnd = text.indexOf('\n', selStart);
  if (lineEnd < 0) lineEnd = text.length;
  return text.slice(lineStart, lineEnd);
}

/** CodeActionProvider: "Fix / Explain / Generate tests with Sunday". */
export class SundayCodeActionProvider implements vscode.CodeActionProvider {
  constructor(private readonly sender: AgentSender) {}

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];
    const text = document.getText();

    const diagnostics = context.diagnostics ?? [];
    if (diagnostics.length > 0) {
      const summaries = summarizeDiagnostics(diagnostics);
      let start = document.offsetAt(range.start);
      let end = document.offsetAt(range.end);
      for (const d of diagnostics) {
        start = Math.min(start, document.offsetAt(d.range.start));
        end = Math.max(end, document.offsetAt(d.range.end));
      }
      const mid = Math.floor((start + end) / 2);
      const block = findEnclosingBlock(text, mid);
      let code = text.slice(start, end);
      if (block && block.start <= start && block.end >= end) {
        // Include the line the opening brace sits on (e.g. the function signature).
        const lineStart = text.lastIndexOf('\n', block.start - 1) + 1;
        code = text.slice(lineStart, block.end);
      }
      const fix = new vscode.CodeAction('Fix with Sunday', vscode.CodeActionKind.QuickFix);
      fix.diagnostics = [...diagnostics];
      fix.command = {
        command: 'sunday.codeAction.fix',
        title: 'Fix with Sunday',
        arguments: [summaries, code, document.fileName, document.languageId],
      };
      actions.push(fix);
    }

    const selStart = document.offsetAt(range.start);
    const selEnd = document.offsetAt(range.end);
    const code = extractRelevantCode(text, selStart, selEnd);
    if (code.trim().length > 0) {
      const explain = new vscode.CodeAction('Explain with Sunday', vscode.CodeActionKind.Empty);
      explain.command = {
        command: 'sunday.codeAction.explain',
        title: 'Explain with Sunday',
        arguments: [code, document.languageId],
      };
      const tests = new vscode.CodeAction(
        'Generate tests with Sunday',
        vscode.CodeActionKind.Empty,
      );
      tests.command = {
        command: 'sunday.codeAction.generateTests',
        title: 'Generate tests with Sunday',
        arguments: [code, document.languageId],
      };
      actions.push(explain, tests);
    }

    return actions;
  }
}

/** Register the provider + the three backing commands. */
export function registerCodeActions(
  context: vscode.ExtensionContext,
  deps: AgentSendDeps,
): void {
  const sender = new AgentSender(deps);
  const fail = (what: string, err: unknown): void => {
    deps.log(`codeAction ${what} failed: ${(err as Error).message}`);
    vscode.window.showErrorMessage(`Sunday ${what} failed: ${(err as Error).message}`);
  };
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      { pattern: '**' },
      new SundayCodeActionProvider(sender),
      {
        providedCodeActionKinds: [vscode.CodeActionKind.QuickFix, vscode.CodeActionKind.Empty],
      },
    ),
    vscode.commands.registerCommand(
      'sunday.codeAction.fix',
      async (summaries: DiagnosticSummary[], code: string, fileName: string, languageId: string) => {
        try {
          await sender.send(buildFixPrompt(summaries, code, { filePath: fileName, languageId }));
        } catch (err) {
          fail('fix', err);
        }
      },
    ),
    vscode.commands.registerCommand(
      'sunday.codeAction.explain',
      async (code: string, languageId: string) => {
        try {
          await sender.send(buildExplainPrompt(code, languageId));
        } catch (err) {
          fail('explain', err);
        }
      },
    ),
    vscode.commands.registerCommand(
      'sunday.codeAction.generateTests',
      async (code: string, languageId: string) => {
        try {
          await sender.send(buildTestsPrompt(code, languageId));
        } catch (err) {
          fail('test generation', err);
        }
      },
    ),
  );
}
