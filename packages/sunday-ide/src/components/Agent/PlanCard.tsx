/**
 * PlanCard — renders a plan detected in an agent reply as a checklist.
 * Steps come from planParse.ts (markdown task lists / Plan sections in
 * the agent's own text); the card is labelled accordingly — the daemon
 * emits no structured plan event, and this UI does not pretend otherwise.
 */
import React from 'react';
import type { PlanStep } from './planParse';

export function PlanCard({ steps }: { steps: PlanStep[] }) {
  const doneCount = steps.filter((s) => s.done).length;
  return (
    <div className="sunday-plan-card">
      <div className="sunday-plan-title">
        <span>Plan</span>
        <span className="sunday-plan-note">
          detected in the agent's reply · {doneCount}/{steps.length} done
        </span>
      </div>
      <ol className="sunday-plan-steps">
        {steps.map((s, i) => (
          <li key={i} className={s.done ? 'done' : ''}>
            <span className="sunday-plan-box" aria-hidden="true">
              {s.done ? '☑' : '☐'}
            </span>
            <span className="sunday-plan-text">{s.text}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
