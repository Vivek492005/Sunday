// sunday-agent — Rules view: the learned-rules sidebar panel.
//
// Lists the rules the self-improving agent learned from user corrections,
// stored in `<home>/.sunday/rules.md`. The sundayd daemon owns correction
// detection and rule extraction
// (`packages/sundayd/src/rule-extractor.ts`); this view shows the rules,
// refreshes the tree, and deletes rules via `sunday.rules.delete`.
//
// NOTE: ext-agent does not depend on @sunday/sundayd, so the markdown line
// format (`- [<id>] <rule> <!-- createdAt=.. source=.. project=.. -->`) is
// duplicated here in `parseRulesMarkdown` / `formatRulesMarkdown`. Keep it
// in sync with the daemon's RuleStore; the pure helpers are covered by
// rulesView.test.ts without a vscode mock.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';

/** Sidebar tree view id for learned rules. */
export const RULES_VIEW_TYPE = 'sunday.rulesView';
/** Delete the selected learned rule (tree item, or pick one). */
export const RULES_DELETE_COMMAND = 'sunday.rules.delete';
/** Re-read the rules file and refresh the tree. */
export const RULES_REFRESH_COMMAND = 'sunday.rules.refresh';

/**
 * A rule learned from a user correction. Mirrors the daemon's LearnedRule
 * (`packages/sundayd/src/rule-extractor.ts`); structurally identical so the
 * two stores stay interchangeable.
 */
export interface LearnedRule {
  id: string;
  rule: string;
  createdAt: string;
  source: 'correction';
  project: string;
}

/**
 * Minimal rule-store contract, matching the daemon RuleStore's public
 * surface (add/list/remove). The default file-backed implementation reads
 * the same `<home>/.sunday/rules.md` the daemon writes.
 */
export interface RuleStore {
  readonly path: string;
  add(rule: string, project?: string): Promise<LearnedRule>;
  list(): Promise<LearnedRule[]>;
  remove(id: string): Promise<boolean>;
}

const RULE_LINE = /^- \[(?<id>[^\]]+)\] (?<rest>.*)$/;
const META_SUFFIX = /\s*<!--\s*(?<meta>.*?)\s*-->\s*$/;

function parseMeta(meta: string): { createdAt: string; project: string } {
  const out = { createdAt: '', project: '' };
  for (const part of meta.split(/\s+/)) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (key === 'createdAt') out.createdAt = value;
    else if (key === 'project') out.project = value;
  }
  return out;
}

/**
 * Parse the shared rules.md format. Pure (no fs): safe to unit-test.
 * Unknown lines are skipped so a hand-edited file degrades gracefully.
 */
export function parseRulesMarkdown(text: string): LearnedRule[] {
  const out: LearnedRule[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = RULE_LINE.exec(line);
    if (!m?.groups) continue;
    const id = m.groups['id']!.trim();
    let rest = m.groups['rest'] ?? '';
    let createdAt = '';
    let project = '';
    const metaMatch = META_SUFFIX.exec(rest);
    if (metaMatch?.groups) {
      const meta = parseMeta(metaMatch.groups['meta'] ?? '');
      createdAt = meta.createdAt;
      project = meta.project;
      rest = rest.slice(0, metaMatch.index).trimEnd();
    }
    if (!id || !rest) continue;
    out.push({ id, rule: rest, createdAt, source: 'correction', project });
  }
  return out;
}

/**
 * Serialise rules to the shared rules.md format. Pure (no fs).
 * Multi-line rule text is flattened so every rule is exactly one line.
 */
export function formatRulesMarkdown(rules: LearnedRule[]): string {
  return (
    rules
      .map((r) => {
        const oneLine = r.rule.replace(/\s+/g, ' ').trim();
        return `- [${r.id}] ${oneLine} <!-- createdAt=${r.createdAt} source=${r.source} project=${r.project} -->`;
      })
      .join('\n') + (rules.length ? '\n' : '')
  );
}

/** One-line detail shown under the rule in the tree (pure, testable). */
export function ruleDetailLine(rule: LearnedRule): string {
  const when = rule.createdAt ? rule.createdAt.slice(0, 10) : 'unknown date';
  const where = rule.project ? ` · ${rule.project}` : '';
  return `learned ${when} · from correction${where}`;
}

/**
 * File-backed RuleStore reading/writing the same `<home>/.sunday/rules.md`
 * the sundayd daemon uses. Pass an instance to `registerRulesView`, or
 * bring your own store implementing the `RuleStore` interface.
 */
export class FileRuleStore implements RuleStore {
  private readonly filePath: string;

  constructor(opts: { homeDir?: string } = {}) {
    this.filePath = join(opts.homeDir ?? homedir(), '.sunday', 'rules.md');
  }

  get path(): string {
    return this.filePath;
  }

  async add(rule: string, project = ''): Promise<LearnedRule> {
    const record: LearnedRule = {
      id: `rule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      rule: rule.replace(/\s+/g, ' ').trim(),
      createdAt: new Date().toISOString(),
      source: 'correction',
      project,
    };
    const rules = await this.list();
    rules.push(record);
    await this.save(rules);
    return record;
  }

  async list(): Promise<LearnedRule[]> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch {
      return [];
    }
    return parseRulesMarkdown(raw);
  }

  async remove(id: string): Promise<boolean> {
    const rules = await this.list();
    const kept = rules.filter((r) => r.id !== id);
    if (kept.length === rules.length) return false;
    await this.save(kept);
    return true;
  }

  private async save(rules: LearnedRule[]): Promise<void> {
    await mkdir(join(this.filePath, '..'), { recursive: true });
    await writeFile(this.filePath, formatRulesMarkdown(rules), 'utf8');
  }
}

/** Tree item for one learned rule. */
export class RuleTreeItem extends vscode.TreeItem {
  constructor(public readonly learnedRule: LearnedRule) {
    super(learnedRule.rule, vscode.TreeItemCollapsibleState.None);
    this.id = learnedRule.id;
    this.tooltip = `${learnedRule.rule}\n${ruleDetailLine(learnedRule)}`;
    this.description = ruleDetailLine(learnedRule);
    this.contextValue = 'sundayRule';
  }
}

/** TreeDataProvider over a RuleStore; re-reads the file on refresh. */
export class RulesTreeDataProvider implements vscode.TreeDataProvider<RuleTreeItem> {
  private readonly onChange = new vscode.EventEmitter<RuleTreeItem | undefined | void>();
  readonly onDidChangeTreeData: vscode.Event<RuleTreeItem | undefined | void> = this.onChange.event;

  constructor(private readonly store: RuleStore) {}

  /** Re-read the store and refresh the tree. Never throws. */
  async refresh(): Promise<void> {
    this.onChange.fire();
  }

  getTreeItem(element: RuleTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<RuleTreeItem[]> {
    const rules = await this.store.list().catch(() => []);
    return rules.map((r) => new RuleTreeItem(r));
  }
}

function asRuleItem(item: unknown): RuleTreeItem | undefined {
  return item instanceof RuleTreeItem ? item : undefined;
}

/**
 * Register the `sunday.rulesView` tree plus the refresh/delete commands.
 * Returns a disposable tearing everything down (also pushed onto
 * `context.subscriptions`).
 */
export function registerRulesView(
  context: vscode.ExtensionContext,
  store: RuleStore,
): vscode.Disposable {
  const provider = new RulesTreeDataProvider(store);
  const treeView = vscode.window.createTreeView(RULES_VIEW_TYPE, {
    treeDataProvider: provider,
    showCollapseAll: false,
  });

  const refreshCmd = vscode.commands.registerCommand(RULES_REFRESH_COMMAND, () => {
    void provider.refresh();
  });

  const deleteCmd = vscode.commands.registerCommand(
    RULES_DELETE_COMMAND,
    async (item: unknown) => {
      let target = asRuleItem(item);
      if (!target) {
        // Invoked without a tree selection (e.g. command palette): let the
        // user pick a rule to delete.
        const rules = await store.list().catch(() => []);
        if (rules.length === 0) {
          void vscode.window.showInformationMessage('Sunday: no learned rules to delete.');
          return;
        }
        const picked = await vscode.window.showQuickPick(
          rules.map((r) => ({ label: r.rule, description: ruleDetailLine(r), id: r.id })),
          { placeHolder: 'Delete a learned rule' },
        );
        if (!picked) return;
        const found = rules.find((r) => r.id === picked.id);
        if (!found) return;
        target = new RuleTreeItem(found);
      }
      const confirm = await vscode.window.showWarningMessage(
        `Delete learned rule "${target.learnedRule.rule}"?`,
        { modal: true },
        'Delete',
      );
      if (confirm !== 'Delete') return;
      await store.remove(target.learnedRule.id);
      await provider.refresh();
    },
  );

  const disposable = vscode.Disposable.from(treeView, refreshCmd, deleteCmd);
  context.subscriptions.push(disposable);
  return disposable;
}
