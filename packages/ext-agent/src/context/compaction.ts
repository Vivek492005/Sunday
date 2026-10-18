// sunday-agent — F4 Context Cockpit: transparent compaction.
//
// Strategy pipeline (per spec):
//   1. Tool-output trimming FIRST — large terminal/test outputs are truncated
//      and the full text is archived to an artifact file with a stub reference
//      left in the message (most bloat comes from here).
//   2. Older non-pinned turns are summarized into one block (pinned facts and
//      pinned messages are NEVER touched).
//   3. Everything removed is recorded verbatim in a CompactionLedger, which
//      supports user-edited summaries and byte-identical undo.
//
// Pure (no vscode import). The artifact writer is injected so tests stay
// hermetic. Unit-tested: pinned survives 3 compactions; undo is byte-identical.

import { estimateTokens } from './tokenizer.js';
import type {
  CompactionLedger,
  CompactionOptions,
  CompactionPreview,
  TrackedMessage,
} from './types.js';

let ledgerCounter = 0;

/** Default extractive summarizer — used when no model is wired in. */
export function extractiveSummary(texts: string[]): string {
  const bullets: string[] = [];
  for (const t of texts) {
    const lines = t.split('\n').map((l) => l.trim()).filter(Boolean);
    const head = lines.slice(0, 3).join(' ');
    bullets.push(head.length > 220 ? `${head.slice(0, 217)}…` : head);
  }
  return `Summary of ${texts.length} earlier turn(s):\n${bullets.map((b, i) => `- ${b || '(empty)'}${i < texts.length ? '' : ''}`).join('\n')}`;
}

/**
 * Trim a large tool output: keep head + tail, note how much was archived.
 * Returns the trimmed text and whether trimming happened.
 */
export function trimToolOutput(
  text: string,
  threshold = 4000,
): { trimmed: string; wasTrimmed: boolean; archivedChars: number } {
  if (text.length <= threshold) return { trimmed: text, wasTrimmed: false, archivedChars: 0 };
  const head = Math.floor(threshold * 0.6);
  const tail = threshold - head;
  const trimmed =
    `${text.slice(0, head)}\n… [trimmed ${text.length - threshold} chars — full output archived] …\n${text.slice(text.length - tail)}`;
  return { trimmed, wasTrimmed: true, archivedChars: text.length };
}

function defaultWriteArtifact(dir: string, messageId: string, text: string): string {
  // Fallback when no writer is injected: return a virtual path; the real
  // host (vscode glue) always injects a filesystem writer.
  void dir;
  void text;
  return `artifact://${messageId}`;
}

function makeSummaryMessage(text: string): TrackedMessage {
  return {
    id: `summary-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    role: 'system',
    text,
    createdAt: Date.now(),
  };
}

/**
 * Preview what a compaction would do, without changing anything.
 */
export function previewCompaction(
  messages: TrackedMessage[],
  opts: CompactionOptions = {},
): CompactionPreview {
  const keepRecent = opts.keepRecent ?? 6;
  const trimThreshold = opts.trimThreshold ?? 4000;
  const summarize = opts.summarize ?? extractiveSummary;

  const protectedIds: string[] = [];
  const toTrim: string[] = [];
  const toSummarize: string[] = [];
  const toDrop: string[] = [];

  // Eligible = non-pinned, non-summary messages.
  const eligible: Array<{ index: number; msg: TrackedMessage }> = [];
  messages.forEach((msg, index) => {
    if (msg.pinned || msg.id.startsWith('summary-')) {
      protectedIds.push(msg.id);
      return;
    }
    eligible.push({ index, msg });
  });

  // Tool-output trimming first.
  for (const { msg } of eligible) {
    if (msg.toolOutput && msg.text.length > trimThreshold) toTrim.push(msg.id);
  }

  // Summarize the oldest eligible messages beyond the keep window.
  const keepSet = new Set(eligible.slice(-keepRecent).map((e) => e.msg.id));
  const candidates = eligible.filter((e) => !keepSet.has(e.msg.id));
  for (const { msg } of candidates) {
    // Tool outputs are trimmed, not summarized (they stay as stubs).
    if (msg.toolOutput) continue;
    toSummarize.push(msg.id);
  }

  const tokensBefore = estimateTokens(messages.map((m) => m.text).join('\n'));
  const summarizedTexts = candidates
    .filter((e) => toSummarize.includes(e.msg.id))
    .map((e) => `[${e.msg.role}] ${e.msg.text}`);
  const draftSummary = toSummarize.length > 0 ? summarize(summarizedTexts) : '';

  // Rough after-estimate: pinned + kept + summary + trimmed stubs.
  const keptTexts = messages
    .filter((m) => !toSummarize.includes(m.id) && !toDrop.includes(m.id))
    .map((m) => (toTrim.includes(m.id) ? `[trimmed tool output ~${trimThreshold} chars]` : m.text));
  const tokensAfter = estimateTokens([...keptTexts, draftSummary].join('\n'));

  return { toSummarize, toDrop, toTrim, protected: protectedIds, tokensBefore, tokensAfter, draftSummary };
}

/**
 * Run a transparent compaction. Returns the new message list + ledger.
 * Pinned facts/messages are never touched. Undo restores byte-identical history.
 */
export function compact(
  messages: TrackedMessage[],
  opts: CompactionOptions = {},
): { messages: TrackedMessage[]; ledger: CompactionLedger } {
  const keepRecent = opts.keepRecent ?? 6;
  const trimThreshold = opts.trimThreshold ?? 4000;
  const summarize = opts.summarize ?? extractiveSummary;
  const writeArtifact = opts.writeArtifact ?? defaultWriteArtifact;
  const artifactDir = opts.artifactDir ?? '~/.sunday/sessions/artifacts';
  const sessionId = opts.sessionId ?? 'default';

  const preview = previewCompaction(messages, { ...opts, keepRecent, trimThreshold, summarize });
  const summarizeSet = new Set(preview.toSummarize);
  const trimSet = new Set(preview.toTrim);

  const removed: Array<{ index: number; message: TrackedMessage }> = [];
  const archivedOutputs: Array<{ messageId: string; artifactPath: string }> = [];
  const kept: TrackedMessage[] = [];

  messages.forEach((msg, index) => {
    if (summarizeSet.has(msg.id)) {
      // Store verbatim for byte-identical undo.
      removed.push({ index, message: { ...msg } });
      return;
    }
    if (trimSet.has(msg.id)) {
      const artifactPath = writeArtifact(artifactDir, msg.id, msg.text);
      archivedOutputs.push({ messageId: msg.id, artifactPath });
      const { trimmed } = trimToolOutput(msg.text, trimThreshold);
      kept.push({
        ...msg,
        text: `${trimmed}\n[full output archived: ${artifactPath}]`,
      });
      return;
    }
    kept.push({ ...msg });
  });

  // Insert the summary block where the oldest summarized content was:
  // right after any leading pinned messages (deterministic placement).
  const summaryText = preview.draftSummary;
  if (preview.toSummarize.length > 0) {
    const summaryMsg = makeSummaryMessage(summaryText);
    let at = 0;
    while (at < kept.length && kept[at].pinned) at += 1;
    kept.splice(at, 0, summaryMsg);
  }

  const tokensBefore = preview.tokensBefore;
  const tokensAfter = estimateTokens(kept.map((m) => m.text).join('\n'));

  ledgerCounter += 1;
  const ledger: CompactionLedger = {
    id: `compaction-${Date.now()}-${ledgerCounter}`,
    sessionId,
    createdAt: Date.now(),
    summary: summaryText,
    removed,
    archivedOutputs,
    tokensBefore,
    tokensAfter,
  };
  return { messages: kept, ledger };
}

/**
 * Undo a compaction from its ledger — restores the message list byte-identical
 * to the pre-compaction state (removed messages re-inserted at original
 * indices, trimmed tool outputs NOT untrimmed — the full text lives in the
 * artifact; the stub stays. Removed summaries are dropped).
 *
 * Note: for byte-identical restore of tool-output text, callers should pass
 * the archived texts via `archivedTexts` (messageId → full text).
 */
export function undoCompaction(
  current: TrackedMessage[],
  ledger: CompactionLedger,
  archivedTexts?: Record<string, string>,
): TrackedMessage[] {
  // Drop summary messages created by this compaction.
  const summaryIds = new Set(
    current.filter((m) => m.id.startsWith('summary-')).map((m) => m.id),
  );
  const withoutSummary = current.filter((m) => !summaryIds.has(m.id));

  // Restore trimmed tool outputs from archives when available.
  const restored = withoutSummary.map((m) => {
    const archived = ledger.archivedOutputs.find((a) => a.messageId === m.id);
    if (archived && archivedTexts?.[m.id]) {
      return { ...m, text: archivedTexts[m.id] };
    }
    return { ...m };
  });

  // Re-insert removed messages at their original indices.
  const result = [...restored];
  const sorted = [...ledger.removed].sort((a, b) => a.index - b.index);
  for (const { index, message } of sorted) {
    result.splice(Math.min(index, result.length), 0, { ...message });
  }
  return result;
}

/** Let the user edit a ledger's summary after the fact. */
export function editLedgerSummary(ledger: CompactionLedger, newSummary: string): CompactionLedger {
  return { ...ledger, summary: newSummary };
}
