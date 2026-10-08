// sunday-agent — `sunday.designToCode` (Workflow, C2).
//
// Turn a UI design image into a framework component. Flow:
//   1. image source: command argument Uri (explorer context) or an open-file
//      dialog (png/jpg/webp)
//   2. detect the project framework from package.json deps (React/Next/Vue/
//      Svelte, else plain React+TS default)
//   3. send image + prompt to a vision-capable model via the existing
//      AgentSender completion path (chat/send accepts content parts)
//   4. show the result in a preview editor BEFORE applying; the user can
//      Apply (filename input box) or Copy
//
// No clipboard-image API exists in stable VS Code, so clipboard paste is not
// offered — the file picker is the documented path.

import * as vscode from 'vscode';
import { readFile } from 'node:fs/promises';
import { AgentSender, type AgentSendDeps, type CollectedTurn } from './agentSend.js';
import type { ContentPart } from '@sunday/protocol';

/** Model ref used for design-to-code when `sunday.designToCode.model` is unset. */
export const DESIGN_TO_CODE_MODEL = 'openrouter:openai/gpt-4o';

export type Framework = 'react' | 'nextjs' | 'vue' | 'svelte';

export interface FrameworkInfo {
  framework: Framework;
  /** True when the project uses TypeScript (devDep or filename hints). */
  typescript: boolean;
}

/** Detect the UI framework from package.json dependency maps. */
export function detectFramework(pkg: {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}): FrameworkInfo {
  const all = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const has = (name: string): boolean => name in all;
  let framework: Framework = 'react'; // default
  if (has('next')) framework = 'nextjs';
  else if (has('vue') || has('nuxt')) framework = 'vue';
  else if (has('svelte') || has('@sveltejs/kit')) framework = 'svelte';
  else if (has('react') || has('react-dom')) framework = 'react';
  return { framework, typescript: has('typescript') };
}

/** Language id + default filename extension for the generated component. */
export function editorLanguageFor(info: FrameworkInfo): { language: string; ext: string } {
  if (info.framework === 'vue') return { language: 'vue', ext: '.vue' };
  if (info.framework === 'svelte') return { language: 'svelte', ext: '.svelte' };
  return info.typescript
    ? { language: 'typescriptreact', ext: '.tsx' }
    : { language: 'javascriptreact', ext: '.jsx' };
}

export function frameworkLabel(info: FrameworkInfo): string {
  const base =
    info.framework === 'react'
      ? 'React'
      : info.framework === 'nextjs'
        ? 'Next.js'
        : info.framework === 'vue'
          ? 'Vue'
          : 'Svelte';
  return info.typescript ? `${base} + TypeScript` : base;
}

/** Prompt: output ONLY the component code, no explanation. */
export function buildDesignToCodePrompt(info: FrameworkInfo): string {
  return [
    `Generate a single ${frameworkLabel(info)} component matching this design.`,
    'Requirements: pixel-faithful layout, accessible semantics (labels, alt text, focus states), responsive.',
    'Output ONLY code, no explanation, no markdown fences.',
  ].join('\n');
}

/** Strip ``` fences (with or without a language tag) and trim. */
export function extractGeneratedCode(text: string): string {
  let t = text.trim();
  if (t.startsWith('```')) {
    const firstNl = t.indexOf('\n');
    t = firstNl >= 0 ? t.slice(firstNl + 1) : '';
    const lastFence = t.lastIndexOf('```');
    if (lastFence >= 0) t = t.slice(0, lastFence);
  }
  return t.trim();
}

/** True when the failure looks like a vision-capability problem. */
export function looksLikeVisionError(message: string): boolean {
  return /image|vision|multimodal|attachment|unsupported media/i.test(message);
}

export const DESIGN_IMAGE_FILTERS: Record<string, string[]> = {
  'Design images': ['png', 'jpg', 'jpeg', 'webp'],
};

export function mimeForExtension(fileName: string): string {
  const ext = fileName.toLowerCase().split('.').pop() ?? '';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  return 'image/png';
}

/** data: URL for a chat/send image part. */
export function imageToDataUrl(bytes: Uint8Array, mime: string): string {
  return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
}

export interface DesignToCodeDeps extends AgentSendDeps {
  /** Model override; defaults to `sunday.designToCode.model` config, then DESIGN_TO_CODE_MODEL. */
  model?: string;
  /** Injectable for tests; defaults to vscode.workspace.fs / node fs reads. */
  readWorkspaceFile?: (fsPath: string) => Promise<string | undefined>;
}

async function readPackageJson(deps: DesignToCodeDeps, wsFolder?: string): Promise<Record<string, unknown>> {
  if (!wsFolder) return {};
  try {
    const read = deps.readWorkspaceFile ?? (async (p) => readFile(p, 'utf8').catch(() => undefined));
    const text = await read(`${wsFolder}/package.json`);
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function registerDesignToCode(
  context: vscode.ExtensionContext,
  deps: DesignToCodeDeps,
): void {
  const sender = new AgentSender(deps);

  context.subscriptions.push(
    vscode.commands.registerCommand('sunday.designToCode', async (resource?: vscode.Uri) => {
      const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

      // 1. Image source.
      let imageUri = resource;
      if (!imageUri) {
        const picked = await vscode.window.showOpenDialog({
          canSelectMany: false,
          filters: DESIGN_IMAGE_FILTERS,
          openLabel: 'Generate component from design',
          title: 'Pick a design image (png/jpg/webp)',
        });
        if (!picked?.length) return;
        imageUri = picked[0];
      }

      let bytes: Uint8Array;
      try {
        const data = await vscode.workspace.fs.readFile(imageUri);
        bytes = data;
      } catch (e) {
        vscode.window.showErrorMessage(`Sunday: could not read the design image: ${(e as Error).message}`);
        return;
      }
      const dataUrl = imageToDataUrl(bytes, mimeForExtension(imageUri.fsPath));

      // 2. Framework detection.
      const pkg = await readPackageJson(deps, wsFolder);
      const info = detectFramework(pkg as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> });
      const { language, ext } = editorLanguageFor(info);
      deps.log(`designToCode: framework=${frameworkLabel(info)}, image=${imageUri.fsPath}`);

      // 3. Vision turn.
      const configured = vscode.workspace.getConfiguration('sunday').get<string>('designToCode.model', '');
      const model = deps.model ?? (configured || DESIGN_TO_CODE_MODEL);
      const parts: ContentPart[] = [
        { type: 'text', text: buildDesignToCodePrompt(info) },
        { type: 'image', dataUrl },
      ];
      let turn: CollectedTurn;
      try {
        turn = await sender.sendAndCollect(parts, model);
      } catch (e) {
        vscode.window.showErrorMessage(
          `Sunday: could not reach the AI gateway: ${(e as Error).message}. ` +
            'Make sure the sidecar is running, or paste a text description of the design into chat instead.',
        );
        return;
      }
      if (!turn.ok || !turn.text?.trim()) {
        const reason = turn.error ?? 'empty reply';
        const hint = looksLikeVisionError(reason)
          ? ' The model may not support images — try a vision-capable model via `sunday.designToCode.model`, or paste a text description of the design into chat instead.'
          : ' Paste a text description of the design into chat instead.';
        vscode.window.showErrorMessage(`Sunday: design-to-code failed: ${reason}.${hint}`);
        return;
      }

      // 4. Preview BEFORE applying.
      const code = extractGeneratedCode(turn.text);
      const doc = await vscode.workspace.openTextDocument({ language, content: code });
      await vscode.window.showTextDocument(doc, { preview: true });
      const choice = await vscode.window.showInformationMessage(
        `Sunday: generated a ${frameworkLabel(info)} component. Apply it to a file?`,
        'Apply to file…',
        'Copy to clipboard',
      );
      if (choice === 'Copy to clipboard') {
        await vscode.env.clipboard.writeText(code);
        vscode.window.showInformationMessage('Sunday: component copied to the clipboard.');
      } else if (choice === 'Apply to file…') {
        const name = await vscode.window.showInputBox({
          prompt: 'File name for the generated component (relative to the workspace)',
          value: `GeneratedComponent${ext}`,
          validateInput: (v) =>
            v.trim() ? undefined : 'Enter a file name.',
        });
        if (!name?.trim()) return;
        if (!wsFolder) {
          vscode.window.showErrorMessage('Sunday: no workspace folder open — cannot write the file.');
          return;
        }
        const target = vscode.Uri.joinPath(vscode.Uri.file(wsFolder), name.trim());
        await vscode.workspace.fs.writeFile(target, Buffer.from(code, 'utf8'));
        await vscode.window.showTextDocument(target);
        vscode.window.showInformationMessage(`Sunday: component written to ${name.trim()}.`);
      }
      // Dismissing the prompt leaves the preview open for manual copying.
    }),
  );
}
