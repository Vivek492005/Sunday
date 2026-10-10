// sunday-agent — SundayHomeProvider: the dedicated "Sunday" home panel.
//
// A prominent, always-visible home for everything Sunday: sign-in, coding
// streaks, quick actions, and personalization. This is the user's front door
// — no more hunting through the status bar or confusing Copilot UI.
//
// Shows:
//   - Big Sunday branding + sign-in button (Google/GitHub via Sunday gateway)
//   - Streak card: current streak, fire visual, "Start a streak!" CTA
//   - Quick actions: Agent Chat, Manager, MCP, Skills
//   - Connection status

import * as vscode from 'vscode';

export const SUNDAY_HOME_VIEW_TYPE = 'sunday.homeView';

export interface SundayHomeDeps {
  log: (msg: string) => void;
}

export class SundayHomeProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = SUNDAY_HOME_VIEW_TYPE;

  private view: vscode.WebviewView | undefined;

  constructor(private readonly deps: SundayHomeDeps = { log: () => undefined }) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.renderHtml();
    webviewView.webview.onDidReceiveMessage((msg: unknown) => {
      void this.onMessage(msg);
    });
    webviewView.onDidDispose(() => {
      this.view = undefined;
    });
    // Refresh when the view becomes visible (sign-in may have changed)
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) this.refresh();
    });
  }

  /** Re-render the home panel (call after sign-in/out). */
  refresh(): void {
    if (this.view) {
      this.view.webview.html = this.renderHtml();
    }
  }

  private async onMessage(msg: unknown): Promise<void> {
    const m = msg as { command?: string };
    try {
      switch (m.command) {
        case 'sunday.accountMenu':
          // Opens the Sunday account menu (Google/GitHub sign-in options)
          await vscode.commands.executeCommand('sunday.account.showMenu');
          break;
        case 'sunday.focusChat':
          await vscode.commands.executeCommand('sunday.chat.focus');
          break;
        case 'sunday.openManager':
          await vscode.commands.executeCommand('sunday.manager.open');
          break;
        case 'sunday.openStreak':
          await vscode.commands.executeCommand('sunday.streak.show');
          break;
        case 'sunday.checkUpdates':
          await vscode.commands.executeCommand('sunday.checkForUpdates');
          break;
        case 'sunday.openMissionControl':
          await vscode.commands.executeCommand('sunday.missionControl.open');
          break;
        case 'sunday.openUsage':
          await vscode.commands.executeCommand('sunday.usage.show');
          break;
        case 'sunday.openSkills':
          await vscode.commands.executeCommand('sunday.skills.open');
          break;
        case 'sunday.openArtifacts':
          await vscode.commands.executeCommand('sunday.artifacts.open');
          break;
        case 'sunday.openMemory':
          await vscode.commands.executeCommand('sunday.memory.open');
          break;
        case 'sunday.openScheduler':
          await vscode.commands.executeCommand('sunday.scheduler.open');
          break;
        case 'sunday.onboardRepo':
          await vscode.commands.executeCommand('sunday.onboardRepo');
          break;
        case 'sunday.importRepo':
          await vscode.commands.executeCommand('sunday.github.importRepo');
          break;
        case 'sunday.setMode':
          await vscode.commands.executeCommand('sunday.mode.set');
          break;
        case 'sunday.designToCode':
          await vscode.commands.executeCommand('sunday.designToCode');
          break;
        case 'sunday.initProject':
          await vscode.commands.executeCommand('sunday.initProject');
          break;
        case 'sunday.cloudTask':
          await vscode.commands.executeCommand('sunday.cloudTask.submit');
          break;
        case 'sunday.bestOfN':
          await vscode.commands.executeCommand('sunday.bestOfN.run');
          break;
        case 'sunday.browserOpen':
          await vscode.commands.executeCommand('sunday.browser.open');
          break;
        case 'sunday.orchestrate':
          await vscode.commands.executeCommand('sunday.orchestration.run');
          break;
        case 'sunday.mcpServers':
          await vscode.commands.executeCommand('sunday.mcp.startServer');
          break;
        default:
          this.deps.log(`sunday home: unknown command ${(m as { command?: string }).command}`);
      }
    } catch (err) {
      this.deps.log(`sunday home: command failed: ${String(err)}`);
    } finally {
      // Refresh after a delay to let auth state settle
      setTimeout(() => this.refresh(), 1000);
    }
  }

  private renderHtml(): string {
    const nonce = Math.random().toString(36).slice(2);

    const signInSection = `
        <div class="card signin-cta">
          <div class="signin-title">Welcome to Sunday ⚡</div>
          <div class="signin-sub">Sign in to unlock your AI coding agent,<br>streaks, and personalization.</div>
          <button class="btn btn-primary btn-big" data-cmd="sunday.accountMenu">
            <span class="g-logo">G</span> Sign in to Sunday
          </button>
          <div class="signin-note">Google or GitHub · Free tier · 200 requests/day</div>
        </div>`;

    const streakSection = `
      <div class="card streak-card" data-cmd="sunday.openStreak" style="cursor: pointer;">
        <div class="streak-fire">🔥</div>
        <div class="streak-info">
          <div class="streak-count">Coding Streak</div>
          <div class="streak-label">Tap to view your streak & milestones</div>
        </div>
      </div>`;

    const quickActions = `
      <div class="section-title">🤖 Agents</div>
      <div class="actions">
        <button class="action-btn" data-cmd="sunday.focusChat">
          <span class="action-icon">💬</span>
          <span class="action-label">Agent Chat</span>
        </button>
        <button class="action-btn" data-cmd="sunday.openManager">
          <span class="action-icon">🎛️</span>
          <span class="action-label">Agent Manager</span>
        </button>
        <button class="action-btn" data-cmd="sunday.openMissionControl">
          <span class="action-icon">📊</span>
          <span class="action-label">Mission Control</span>
        </button>
      </div>
      <div class="section-title">🔥 Engagement</div>
      <div class="actions">
        <button class="action-btn" data-cmd="sunday.openStreak">
          <span class="action-icon">🔥</span>
          <span class="action-label">Streaks</span>
        </button>
        <button class="action-btn" data-cmd="sunday.openUsage">
          <span class="action-icon">📈</span>
          <span class="action-label">Usage</span>
        </button>
        <button class="action-btn" data-cmd="sunday.openScheduler">
          <span class="action-icon">⏰</span>
          <span class="action-label">Scheduler</span>
        </button>
      </div>
      <div class="section-title">🧠 Memory & Skills</div>
      <div class="actions">
        <button class="action-btn" data-cmd="sunday.openMemory">
          <span class="action-icon">🧠</span>
          <span class="action-label">Memory</span>
        </button>
        <button class="action-btn" data-cmd="sunday.openSkills">
          <span class="action-icon">🛠️</span>
          <span class="action-label">Skills</span>
        </button>
        <button class="action-btn" data-cmd="sunday.openArtifacts">
          <span class="action-icon">📦</span>
          <span class="action-label">Artifacts</span>
        </button>
      </div>
      <div class="section-title">⚡ Power Tools</div>
      <div class="actions">
        <button class="action-btn" data-cmd="sunday.setMode">
          <span class="action-icon">🎭</span>
          <span class="action-label">Agent Modes</span>
        </button>
        <button class="action-btn" data-cmd="sunday.designToCode">
          <span class="action-icon">🎨</span>
          <span class="action-label">Design to Code</span>
        </button>
        <button class="action-btn" data-cmd="sunday.bestOfN">
          <span class="action-icon">🎯</span>
          <span class="action-label">Best-of-N</span>
        </button>
      </div>
      <div class="actions" style="margin-top: 8px;">
        <button class="action-btn" data-cmd="sunday.orchestrate">
          <span class="action-icon">🐝</span>
          <span class="action-label">Swarm</span>
        </button>
        <button class="action-btn" data-cmd="sunday.cloudTask">
          <span class="action-icon">☁️</span>
          <span class="action-label">Cloud Tasks</span>
        </button>
        <button class="action-btn" data-cmd="sunday.browserOpen">
          <span class="action-icon">🌐</span>
          <span class="action-label">Agent Browser</span>
        </button>
      </div>
      <div class="actions" style="margin-top: 8px;">
        <button class="action-btn" data-cmd="sunday.mcpServers">
          <span class="action-icon">🔌</span>
          <span class="action-label">MCP Servers</span>
        </button>
        <button class="action-btn" data-cmd="sunday.initProject">
          <span class="action-icon">📋</span>
          <span class="action-label">Templates</span>
        </button>
        <button class="action-btn" data-cmd="sunday.accountMenu">
          <span class="action-icon">👤</span>
          <span class="action-label">Account</span>
        </button>
      </div>
      <div class="section-title">📁 Projects</div>
      <div class="actions">
        <button class="action-btn" data-cmd="sunday.onboardRepo">
          <span class="action-icon">🚀</span>
          <span class="action-label">Onboard Repo</span>
        </button>
        <button class="action-btn" data-cmd="sunday.importRepo" style="grid-column: span 2;">
          <span class="action-icon">📥</span>
          <span class="action-label">Import from GitHub</span>
        </button>
      </div>
      <div class="section-title">⚙️ System</div>
      <div class="actions">
        <button class="action-btn" data-cmd="sunday.checkUpdates" style="grid-column: span 3;">
          <span class="action-icon">⬆️</span>
          <span class="action-label">Check for Updates</span>
        </button>
      </div>`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background);
    padding: 16px 12px;
  }
  .brand {
    text-align: center;
    margin-bottom: 16px;
  }
  .brand-name {
    font-size: 28px;
    font-weight: 800;
    background: linear-gradient(135deg, #f59e0b, #f97316);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    letter-spacing: -0.5px;
  }
  .brand-tag { font-size: 12px; opacity: 0.7; margin-top: 2px; }
  .card {
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 10px;
    padding: 14px;
    margin-bottom: 12px;
  }
  .signin-cta { text-align: center; padding: 20px 14px; }
  .signin-title { font-size: 17px; font-weight: 700; margin-bottom: 6px; }
  .signin-sub { font-size: 12px; opacity: 0.75; margin-bottom: 14px; line-height: 1.5; }
  .signin-note { font-size: 11px; opacity: 0.55; margin-top: 10px; }
  .signed-in { display: flex; align-items: center; gap: 10px; }
  .avatar {
    width: 36px; height: 36px; border-radius: 50%;
    background: linear-gradient(135deg, #22c55e, #16a34a);
    display: flex; align-items: center; justify-content: center;
    font-weight: 700; color: white; flex-shrink: 0;
  }
  .user-info { flex: 1; min-width: 0; }
  .user-label { font-weight: 600; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .user-sub { font-size: 11px; opacity: 0.6; }
  .btn {
    font-family: inherit; cursor: pointer; border-radius: 8px;
    border: 1px solid var(--vscode-button-border, transparent);
    padding: 8px 14px; font-size: 13px; font-weight: 600;
  }
  .btn-primary {
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; display: inline-flex; align-items: center; gap: 8px;
  }
  .btn-primary:hover { background: var(--vscode-button-hoverBackground); }
  .btn-big { padding: 12px 24px; font-size: 14px; }
  .btn-ghost { background: transparent; color: var(--vscode-foreground); opacity: 0.75; }
  .btn-ghost:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
  .g-logo {
    width: 20px; height: 20px; border-radius: 50%; background: white; color: #4285f4;
    display: inline-flex; align-items: center; justify-content: center;
    font-weight: 800; font-size: 13px;
  }
  .streak-card { display: flex; align-items: center; gap: 12px; }
  .streak-card.active { border-color: #f59e0b; box-shadow: 0 0 12px rgba(245,158,11,0.25); }
  .streak-fire { font-size: 36px; }
  .streak-count { font-size: 20px; font-weight: 800; }
  .streak-label { font-size: 12px; opacity: 0.7; margin-top: 2px; }
  .section-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; opacity: 0.6; margin: 16px 0 8px; }
  .actions { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; }
  .action-btn {
    font-family: inherit; cursor: pointer;
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border); border-radius: 8px;
    padding: 12px 6px; display: flex; flex-direction: column; align-items: center; gap: 6px;
    color: var(--vscode-foreground);
  }
  .action-btn:hover { border-color: var(--vscode-focusBorder); background: var(--vscode-toolbar-hoverBackground); }
  .action-icon { font-size: 22px; }
  .action-label { font-size: 11px; font-weight: 600; }
</style>
</head>
<body>
  <div class="brand">
    <div class="brand-name">Sunday</div>
    <div class="brand-tag">Your AI coding agent</div>
  </div>
  ${signInSection}
  ${streakSection}
  ${quickActions}
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  document.querySelectorAll('[data-cmd]').forEach((el) => {
    el.addEventListener('click', () => {
      vscode.postMessage({ command: el.getAttribute('data-cmd') });
    });
  });
</script>
</body>
</html>`;
  }

  private escape(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
}
