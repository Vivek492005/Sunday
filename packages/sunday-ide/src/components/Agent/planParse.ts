/**
 * Plan detection for agent replies.
 *
 * The daemon emits no structured "plan" event — plans arrive as markdown
 * inside the assistant's text. This parser extracts them HONESTLY:
 *  1. Markdown task lists (- [ ] / - [x]) anywhere in the reply, or
 *  2. A "Plan" heading followed by a run of bullet/numbered steps.
 * Anything else returns null and the reply renders as plain markdown.
 * The UI labels the card "Plan — detected in the agent's reply".
 */

export interface PlanStep {
  text: string;
  done: boolean;
}

export interface ParsedPlan {
  steps: PlanStep[];
  /** The reply text with the plan lines removed (rendered as markdown). */
  rest: string;
}

const MAX_STEPS = 20;
const TASK_LINE = /^\s*(?:[-*+]|\d{1,2}[.)])\s+\[([ xX])\]\s+(.+?)\s*$/;
const LIST_LINE = /^\s*(?:[-*+]|\d{1,2}[.)])\s+(.+?)\s*$/;
const HEADING_LINE = /^\s{0,3}(?:#{1,4}\s+|\*\*|__)?(.{0,80}?)(?:\*\*|__)?\s*:?\s*$/;

function isPlanHeading(line: string): boolean {
  const m = HEADING_LINE.exec(line);
  if (!m) return false;
  const text = (m[1] ?? '').trim();
  return /\bplan\b/i.test(text) && text.length <= 60;
}

function collapseBlankRuns(lines: string[]): string {
  const out: string[] = [];
  let blank = false;
  for (const l of lines) {
    if (l.trim() === '') {
      if (!blank) out.push(l);
      blank = true;
    } else {
      out.push(l);
      blank = false;
    }
  }
  return out.join('\n').trim();
}

export function parsePlanFromText(text: string): ParsedPlan | null {
  if (!text || text.length < 10) return null;
  const lines = text.split('\n');

  // Pass 1: markdown task-list items anywhere in the reply.
  const taskSteps: PlanStep[] = [];
  const taskIdx = new Set<number>();
  lines.forEach((line, i) => {
    const m = TASK_LINE.exec(line);
    if (m && taskSteps.length < MAX_STEPS) {
      taskSteps.push({ text: m[2] ?? '', done: (m[1] ?? '').toLowerCase() === 'x' });
      taskIdx.add(i);
    }
  });
  if (taskSteps.length >= 2) {
    const rest = collapseBlankRuns(lines.filter((_, i) => !taskIdx.has(i)));
    return { steps: taskSteps, rest };
  }

  // Pass 2: "Plan" heading followed by a run of list items.
  for (let h = 0; h < lines.length; h++) {
    if (!isPlanHeading(lines[h])) continue;
    const steps: PlanStep[] = [];
    const used = new Set<number>([h]);
    let blanks = 0;
    for (let i = h + 1; i < lines.length && steps.length < MAX_STEPS; i++) {
      const line = lines[i];
      if (line.trim() === '') {
        blanks++;
        if (blanks > 1) break;
        continue;
      }
      const m = LIST_LINE.exec(line);
      if (!m) break;
      steps.push({ text: m[1] ?? '', done: false });
      used.add(i);
    }
    if (steps.length >= 3) {
      const rest = collapseBlankRuns(lines.filter((_, i) => !used.has(i)));
      return { steps, rest };
    }
  }

  return null;
}
