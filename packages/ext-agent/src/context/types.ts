// sunday-agent — F4 Context Cockpit: shared types.
//
// Pure (no vscode import) — safe to import from the sundayd sidecar.

/** Context segment kinds tracked by the meter. */
export type SegmentKind =
  | 'system'
  | 'rules'
  | 'files'
  | 'toolOutputs'
  | 'history'
  | 'pinned';

/** One tracked chunk of context. */
export interface ContextSegment {
  /** Stable id of the segment. */
  id: string;
  kind: SegmentKind;
  /** Token estimate for this segment. */
  tokens: number;
  /** Short human label (shown in the breakdown). */
  label?: string;
}

/** Live context meter reading. */
export interface ContextUsage {
  /** Total estimated tokens in context. */
  used: number;
  /** Model context window. */
  limit: number;
  /** Tokens per segment kind. */
  breakdown: Record<SegmentKind, number>;
  /** used / limit, 0..1. */
  percent: number;
  /** Tokens remaining. */
  remaining: number;
}

/** A pinned fact — never compacted, never dropped. */
export interface PinnedFact {
  id: string;
  text: string;
  /** Who pinned it: 'user' | 'agent'. */
  pinnedBy: 'user' | 'agent';
  createdAt: number;
}

/** One chat message as tracked by the cockpit. */
export interface TrackedMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  /** True for tool outputs (terminal/test results) — trimmed FIRST. */
  toolOutput?: boolean;
  /** True when this message is a pinned fact (immune to compaction). */
  pinned?: boolean;
  createdAt: number;
}

/** What a compaction WOULD do — shown to the user before running. */
export interface CompactionPreview {
  /** Message ids that would be summarized into one block. */
  toSummarize: string[];
  /** Message ids that would be dropped outright. */
  toDrop: string[];
  /** Tool-output message ids that would be trimmed + archived. */
  toTrim: string[];
  /** Pinned facts / pinned messages that stay untouched. */
  protected: string[];
  /** Tokens before → after estimate. */
  tokensBefore: number;
  tokensAfter: number;
  /** Draft summary text (editable by the user). */
  draftSummary: string;
}

/** Record of a compaction — fully reversible via undo. */
export interface CompactionLedger {
  id: string;
  sessionId: string;
  createdAt: number;
  /** Summary text (user-editable after the fact). */
  summary: string;
  /** Removed messages, verbatim, with original indices (byte-identical restore). */
  removed: Array<{ index: number; message: TrackedMessage }>;
  /** Archived tool-output artifacts: message id → artifact path. */
  archivedOutputs: Array<{ messageId: string; artifactPath: string }>;
  tokensBefore: number;
  tokensAfter: number;
  /** The compaction this supersedes when a second compaction runs. */
  supersedes?: string;
}

/** Options for compaction. */
export interface CompactionOptions {
  /** Keep this many most-recent non-pinned turns untouched. Default 6. */
  keepRecent?: number;
  /** Tool outputs longer than this many chars get trimmed. Default 4000. */
  trimThreshold?: number;
  /** Where archived tool outputs are written. */
  artifactDir?: string;
  /** Summarizer: (texts) => summary. Default = extractive fallback. */
  summarize?: (texts: string[]) => string;
  /** Session id for ledger/artifacts. */
  sessionId?: string;
  /** Write an artifact file; returns its path. Injected for testability. */
  writeArtifact?: (dir: string, messageId: string, text: string) => string;
}

/** Slash command parsed from chat input. */
export type SlashCommandName = 'compact' | 'pin' | 'forget';

export interface SlashCommand {
  command: SlashCommandName;
  /** Raw argument text after the command (may be empty). */
  args: string;
}
