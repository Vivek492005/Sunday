// sunday-agent — onboarding wizard (Workflow, C3): webview HTML.
// Pure string builder (unit-tested); the webview posts {type:'run'|'copyEnv', stepId}
// messages and re-renders on {type:'state', steps} messages from the extension.

import type { RepoAnalysis } from './detect.js';
import { stackLabel } from './detect.js';
import type { ChecklistStep, StepStatus } from './state.js';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const STATUS_ICON: Record<StepStatus, string> = {
  done: '✅',
  pending: '⬜',
  running: '⏳',
  failed: '❌',
  skipped: '➖',
};

/** Render the checklist as a self-contained HTML page. */
export function buildOnboardingHtml(analysis: RepoAnalysis, steps: ChecklistStep[]): string {
  const stepsJson = JSON.stringify(steps).replace(/</g, '\\u003c');
  const rows = steps
    .map((s) => {
      const action =
        s.action && (s.status === 'pending' || s.status === 'failed')
          ? `<button data-step="${esc(s.id)}" data-kind="${s.action === 'env' ? 'copyEnv' : 'run'}">${
              s.action === 'env' ? 'Create .env' : s.status === 'failed' ? 'Retry' : 'Run'
            }</button>`
          : '';
      return `<li class="step ${s.status}">
        <span class="icon">${STATUS_ICON[s.status]}</span>
        <span class="body"><strong>${esc(s.label)}</strong>${
          s.detail ? `<div class="detail">${esc(s.detail)}</div>` : ''
        }</span>
        <span class="action">${action}</span>
      </li>`;
    })
    .join('\n');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  body { font-family: var(--vscode-font-family); padding: 16px; color: var(--vscode-foreground); }
  h2 { margin-top: 0; }
  ul { list-style: none; padding: 0; }
  .step { display: flex; gap: 10px; align-items: flex-start; padding: 10px; border-bottom: 1px solid var(--vscode-panel-border); }
  .step .body { flex: 1; }
  .detail { opacity: 0.75; font-size: 0.9em; margin-top: 4px; font-family: var(--vscode-editor-font-family); }
  .step.failed .detail { opacity: 1; color: var(--vscode-errorForeground); }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 12px; cursor: pointer; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  #summary { margin-top: 16px; }
</style></head>
<body>
  <h2>Onboard this repository</h2>
  <p>Stack: <strong>${esc(stackLabel(analysis))}</strong>${analysis.hasDockerfile ? ' · Dockerfile present' : ''}</p>
  <ul id="steps">${rows}</ul>
  <div id="summary"></div>
  <script>
    const vscode = acquireVsCodeApi();
    let steps = ${stepsJson};
    const ICONS = ${JSON.stringify(STATUS_ICON)};
    function render() {
      const ul = document.getElementById('steps');
      ul.innerHTML = steps.map(s => {
        const showBtn = s.action && (s.status === 'pending' || s.status === 'failed');
        const btn = showBtn
          ? '<button data-step="' + s.id + '" data-kind="' + (s.action === 'env' ? 'copyEnv' : 'run') + '">' + (s.action === 'env' ? 'Create .env' : (s.status === 'failed' ? 'Retry' : 'Run')) + '</button>'
          : '';
        return '<li class="step ' + s.status + '"><span class="icon">' + ICONS[s.status] + '</span>' +
          '<span class="body"><strong>' + escapeHtml(s.label) + '</strong>' +
          (s.detail ? '<div class="detail">' + escapeHtml(s.detail) + '</div>' : '') + '</span>' +
          '<span class="action">' + btn + '</span></li>';
      }).join('');
      ul.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
        vscode.postMessage({ type: b.dataset.kind, stepId: b.dataset.step });
      }));
      const done = steps.filter(s => s.status === 'done').length;
      const failed = steps.filter(s => s.status === 'failed');
      document.getElementById('summary').innerHTML =
        '<p>' + done + ' of ' + steps.length + ' steps complete.</p>' +
        (failed.length ? '<p>Needs attention: ' + failed.map(f => escapeHtml(f.label)).join(', ') + '</p>' : '');
    }
    function escapeHtml(s) {
      return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    window.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'state') { steps = e.data.steps; render(); }
    });
    render();
  </script>
</body></html>`;
}
