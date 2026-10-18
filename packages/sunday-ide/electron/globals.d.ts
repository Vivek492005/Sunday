/**
 * Sunday IDE — Electron main global type shims.
 *
 * The F1 budget store (packages/ext-agent/src/budgets/budgetStore.ts) was
 * written against the VS Code API surface where `Thenable<T>` is global.
 * In the Electron main process we don't have vscode types; a minimal
 * structural alias is sufficient and honest.
 */
declare type Thenable<T> = PromiseLike<T>;
