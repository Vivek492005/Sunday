// sunday-agent — `sunday.initProject` command (Group B3).
//
// New-project wizard: quickpick a template → name the project → pick the
// target directory → scaffold → `git init` → offer dependency install
// (approval-gated) → open the project in a new window. File copying is the
// pure `scaffold()` in `./scaffold.js`; everything VS Code-specific lives
// here.
import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import {
  TEMPLATE_NAMES,
  assertValidProjectName,
  scaffold,
  type TemplateName,
} from './scaffold.js';

export interface InitProjectDeps {
  /** Directory containing the template folders. */
  templatesDir: string;
  log(msg: string): void;
}

const TEMPLATE_DESCRIPTIONS: Record<TemplateName, string> = {
  'react-ts': 'React + TypeScript + Vite app',
  'node-api': 'Express + TypeScript API server',
  'python-cli': 'Python argparse CLI (pyproject.toml)',
  'nextjs': 'Next.js + TypeScript app',
};

/** Install command per template, or undefined when there is nothing to install. */
export function installCommandFor(template: TemplateName): string | undefined {
  switch (template) {
    case 'react-ts':
    case 'node-api':
    case 'nextjs':
      return 'npm install';
    case 'python-cli':
      return 'pip install -e .';
  }
}

/** `git init` in the new project dir; warns (never throws) when git fails. */
export function gitInit(cwd: string, log: (msg: string) => void): Promise<void> {
  return new Promise((resolve) => {
    execFile('git', ['init'], { cwd }, (err) => {
      if (err) {
        log(`initProject: git init failed: ${err.message}`);
        vscode.window.showWarningMessage('Sunday: `git init` failed — the project was scaffolded without a git repo.');
      }
      resolve();
    });
  });
}

async function pickTemplate(): Promise<TemplateName | undefined> {
  const pick = await vscode.window.showQuickPick(
    TEMPLATE_NAMES.map((name) => ({
      label: name,
      description: TEMPLATE_DESCRIPTIONS[name],
    })),
    { placeHolder: 'Select a project template' },
  );
  return pick?.label as TemplateName | undefined;
}

async function pickProjectName(): Promise<string | undefined> {
  return vscode.window.showInputBox({
    prompt: 'Project name',
    placeHolder: 'my-app',
    validateInput: (value) => {
      try {
        assertValidProjectName(value.trim());
        return undefined;
      } catch (err) {
        return (err as Error).message;
      }
    },
  });
}

async function pickTargetDir(): Promise<string | undefined> {
  const uris = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: 'Scaffold here',
    title: 'Choose where to create the project',
  });
  return uris?.[0]?.fsPath;
}

/** Register the `sunday.initProject` command. */
export function registerInitProject(
  context: vscode.ExtensionContext,
  deps: InitProjectDeps,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('sunday.initProject', async () => {
      const template = await pickTemplate();
      if (!template) return;
      const rawName = await pickProjectName();
      if (!rawName) return;
      const projectName = rawName.trim();
      const parentDir = await pickTargetDir();
      if (!parentDir) return;
      const targetDir = join(parentDir, projectName);

      try {
        const created = await scaffold({
          templatesDir: deps.templatesDir,
          template,
          projectName,
          targetDir,
        });
        deps.log(`initProject: scaffolded ${template} "${projectName}" (${created.length} files)`);
      } catch (err) {
        vscode.window.showErrorMessage(`Sunday: scaffolding failed: ${(err as Error).message}`);
        return;
      }

      await gitInit(targetDir, deps.log);

      const installCmd = installCommandFor(template);
      if (installCmd) {
        const choice = await vscode.window.showInformationMessage(
          `Install dependencies for ${projectName}? (${installCmd})`,
          'Install',
          'Skip',
        );
        if (choice === 'Install') {
          const terminal = vscode.window.createTerminal({ name: `${projectName} setup`, cwd: targetDir });
          terminal.sendText(installCmd);
          terminal.show();
          deps.log(`initProject: installing deps via terminal: ${installCmd}`);
        }
      }

      const open = await vscode.window.showInformationMessage(
        `Project ${projectName} is ready. Open it in a new window?`,
        'Open',
        'Stay here',
      );
      if (open === 'Open') {
        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(targetDir), true);
      }
    }),
  );
}
