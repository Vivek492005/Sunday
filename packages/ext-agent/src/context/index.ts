// sunday-agent — F4 Context Cockpit: public surface.
//
// meter/pinned/compaction/slashCommands are pure (no vscode import) —
// safe to import from the sundayd sidecar. commands.ts is the vscode glue.
export { ContextCockpit } from './cockpit.js';
export {
  ContextMeter,
  SEGMENT_KINDS,
  DEFAULT_CONTEXT_LIMITS,
  type MeterOptions,
} from './meter.js';
export { PinnedStore } from './pinned.js';
export {
  estimateTokens,
  estimateTokensBatch,
  formatTokens,
  CHARS_PER_TOKEN,
  type ProviderUsage,
} from './tokenizer.js';
export {
  compact,
  editLedgerSummary,
  extractiveSummary,
  previewCompaction,
  trimToolOutput,
  undoCompaction,
} from './compaction.js';
export {
  handleSlashCommand,
  parseSlashCommand,
  SLASH_COMMANDS,
  type SlashDeps,
} from './slashCommands.js';
export {
  registerContextCommands,
  CONTEXT_METER_COMMAND,
  CONTEXT_COMPACT_COMMAND,
  CONTEXT_PIN_COMMAND,
  type ContextCommandDeps,
} from './commands.js';
export type {
  CompactionLedger,
  CompactionOptions,
  CompactionPreview,
  ContextSegment,
  ContextUsage,
  PinnedFact,
  SegmentKind,
  SlashCommand,
  SlashCommandName,
  TrackedMessage,
} from './types.js';
