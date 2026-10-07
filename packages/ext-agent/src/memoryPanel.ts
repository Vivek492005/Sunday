// sunday-agent — Memory panel: a TreeView of recent Second Brain memories.
//
// `registerMemoryPanel()` creates the `sunday.memoryView` TreeView; the
// coordinator calls it from extension.ts with the `MemoryStore` from
// `@sunday/skills`. The store is typed structurally (`MemoryStoreLike`) so
// this module needs no hard dependency on that package — any object with
// `list()`/`delete()` fits, including the real store.

import * as vscode from 'vscode';

/** TreeView id for the Second Brain memory panel. */
export const MEMORY_VIEW_ID = 'sunday.memoryView';

/** Max characters shown on a tree item label. */
export const MEMORY_LABEL_MAX = 60;

/**
 * Structural shape of a long-term memory record. Mirrors `LongTermMemory`
 * from `@sunday/skills` without importing it.
 */
export interface MemoryRecordLike {
  id: string;
  text: string;
  timestamp: string;
  project: string;
  tags: string[];
  source: 'auto' | 'manual';
}

/** Structural shape of the store — `list()` and `delete()` only. */
export interface MemoryStoreLike {
  list(opts?: { limit?: number }): Promise<MemoryRecordLike[]>;
  delete(id: string): Promise<boolean>;
}

/** Tree-item label: the memory text, whitespace-collapsed, first 60 chars. */
export function memoryLabel(mem: MemoryRecordLike): string {
  const clean = mem.text.replace(/\s+/g, ' ');
  return clean.length > MEMORY_LABEL_MAX ? `${clean.slice(0, MEMORY_LABEL_MAX)}…` : clean;
}

/** Tooltip: the full text plus project, date, and tags. */
export function memoryTooltip(mem: MemoryRecordLike): string {
  const date = mem.timestamp.slice(0, 10);
  const tags = mem.tags.length > 0 ? mem.tags.join(', ') : 'note';
  return `${mem.text}\n\nProject: ${mem.project} · ${date} · ${tags}`;
}

/** Pure helper: turn a memory record into a TreeItem (easy to unit-test). */
export function memoryToTreeItem(mem: MemoryRecordLike): vscode.TreeItem {
  const item = new vscode.TreeItem(memoryLabel(mem), vscode.TreeItemCollapsibleState.None);
  item.tooltip = memoryTooltip(mem);
  item.description = mem.project;
  item.contextValue = 'sundayMemory';
  item.id = mem.id;
  return item;
}

/** TreeDataProvider backed by the Second Brain store, newest memories first. */
export class MemoryTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly emitter = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  public readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly store: MemoryStoreLike) {}

  public async getChildren(_element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    const mems = await this.store.list({ limit: 100 });
    return mems.map(memoryToTreeItem);
  }

  public getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  /** Fire when memories change so the view re-reads the store. */
  public refresh(): void {
    this.emitter.fire(undefined);
  }
}

/**
 * Create the `sunday.memoryView` TreeView listing recent memories and return
 * it as a disposable. The coordinator wires this up in extension.ts.
 */
export function registerMemoryPanel(
  context: vscode.ExtensionContext,
  store: MemoryStoreLike,
): vscode.Disposable {
  const provider = new MemoryTreeProvider(store);
  const view = vscode.window.createTreeView(MEMORY_VIEW_ID, { treeDataProvider: provider });
  context.subscriptions.push(view);
  return view;
}
