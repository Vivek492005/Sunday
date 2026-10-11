// sunday-agent — Sunday Streak right-side panel.
//
// Colorful, animated, interactive streak showcase that opens in the right
// sidebar (like the agent window) when the user clicks the streak status bar
// item. Shows current streak, longest, freezes, milestones, and rewards.

import * as vscode from 'vscode';

export const STREAK_VIEW_ID = 'sunday.streakView';

export interface StreakPanelData {
  current: number;
  longest: number;
  freezesAvailable: number;
  todayIsActive: boolean;
  nextMilestone?: { atDays: number; bonus: number; daysAway: number };
  vacationActive: boolean;
}

function streakHtml(data: StreakPanelData): string {
  const GOLD = '#f5b942';
  const DARK = '#1a1611';
  const BROWN = '#221c14';
  const flameSize = Math.min(64 + data.current * 2, 120);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: ${DARK}; color: #e8e0d0; padding: 20px; min-height: 100vh;
  }
  .header { text-align: center; margin-bottom: 24px; }
  .header h1 { color: ${GOLD}; font-size: 20px; margin-bottom: 4px; }
  .header p { color: #8a7a5c; font-size: 13px; }
  .flame-wrap { text-align: center; margin: 24px 0; }
  .flame {
    font-size: ${flameSize}px;
    display: inline-block;
    animation: flicker 1.5s ease-in-out infinite;
    filter: drop-shadow(0 0 24px rgba(245,185,66,0.5));
  }
  @keyframes flicker {
    0%, 100% { transform: scale(1) rotate(-2deg); }
    50% { transform: scale(1.08) rotate(2deg); }
  }
  .streak-num {
    font-size: 48px; font-weight: 800; color: ${GOLD};
    text-align: center; margin-bottom: 4px;
  }
  .streak-label { text-align: center; color: #8a7a5c; font-size: 14px; margin-bottom: 24px; }
  .cards { display: grid; gap: 12px; }
  .card {
    background: ${BROWN}; border: 1px solid #4a3d28; border-radius: 12px;
    padding: 16px; display: flex; align-items: center; gap: 14px;
    transition: transform 0.15s, border-color 0.2s;
  }
  .card:hover { transform: translateY(-2px); border-color: ${GOLD}; }
  .card-icon { font-size: 28px; }
  .card-body { flex: 1; }
  .card-title { font-weight: 600; font-size: 14px; margin-bottom: 2px; }
  .card-desc { font-size: 12px; color: #8a7a5c; }
  .card-value { font-size: 20px; font-weight: 700; color: ${GOLD}; }
  .btn {
    width: 100%; padding: 12px; margin-top: 16px;
    background: ${GOLD}; color: ${DARK}; border: none; border-radius: 10px;
    font-size: 14px; font-weight: 700; cursor: pointer;
    transition: transform 0.1s;
  }
  .btn:hover { transform: translateY(-1px); }
  .btn-secondary {
    background: transparent; color: ${GOLD};
    border: 1px solid ${GOLD}; margin-top: 8px;
  }
  .progress {
    height: 8px; background: #2a2318; border-radius: 4px;
    margin-top: 8px; overflow: hidden;
  }
  .progress-fill {
    height: 100%; background: linear-gradient(90deg, #e0a832, ${GOLD});
    border-radius: 4px; transition: width 0.5s ease;
  }
</style>
</head>
<body>
<div class="header">
  <h1>🔥 Sunday Streak</h1>
  <p>Keep the fire burning — code every day!</p>
</div>
<div class="flame-wrap"><span class="flame">🔥</span></div>
<div class="streak-num">${data.current}</div>
<div class="streak-label">${data.current === 1 ? 'day' : 'days'}${data.todayIsActive ? ' · today counts!' : ' · code today to keep it going'}</div>
<div class="cards">
  <div class="card">
    <span class="card-icon">🏆</span>
    <div class="card-body">
      <div class="card-title">Longest Streak</div>
      <div class="card-desc">Your personal best</div>
    </div>
    <span class="card-value">${data.longest}</span>
  </div>
  <div class="card">
    <span class="card-icon">🛡️</span>
    <div class="card-body">
      <div class="card-title">Streak Freezes</div>
      <div class="card-desc">Saves your streak if you miss a day</div>
    </div>
    <span class="card-value">${data.freezesAvailable}</span>
  </div>
  ${data.nextMilestone ? `
  <div class="card">
    <span class="card-icon">🎁</span>
    <div class="card-body">
      <div class="card-title">Next Reward</div>
      <div class="card-desc">+${data.nextMilestone.bonus} AI requests/day at ${data.nextMilestone.atDays}-day streak</div>
      <div class="progress"><div class="progress-fill" style="width:${Math.round((data.current / data.nextMilestone.atDays) * 100)}%"></div></div>
    </div>
    <span class="card-value">${data.nextMilestone.daysAway}d</span>
  </div>` : ''}
</div>
<button class="btn" onclick="msg('code')">⚡ Code Now to Extend Streak</button>
<button class="btn btn-secondary" onclick="msg('vacation')">${data.vacationActive ? '🏖️ End Vacation Mode' : '🏖️ Start Vacation Mode'}</button>
<script>
  const vscode = acquireVsCodeApi();
  function msg(type) { vscode.postMessage({ type }); }
</script>
</body>
</html>`;
}

export class StreakViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = STREAK_VIEW_ID;
  private view?: vscode.WebviewView;
  private getData: () => StreakPanelData;

  constructor(getData: () => StreakPanelData) {
    this.getData = getData;
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    this.refresh();
    webviewView.webview.onDidReceiveMessage((msg: { type?: string }) => {
      if (msg.type === 'code') {
        void vscode.commands.executeCommand('workbench.action.files.newUntitledFile');
      } else if (msg.type === 'vacation') {
        void vscode.commands.executeCommand('sunday.streak.vacation');
      }
    });
  }

  refresh(): void {
    if (this.view) {
      this.view.webview.html = streakHtml(this.getData());
    }
  }

  /** Reveals the streak view in the sidebar. */
  async show(): Promise<void> {
    await vscode.commands.executeCommand(`${STREAK_VIEW_ID}.focus`);
    this.refresh();
  }
}
