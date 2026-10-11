// sunday-agent — Sunday User Guide.
//
// A rich, searchable-in-page guide that teaches users every Sunday feature:
// how to sign in, change the theme, use the agent, models, streaks, and all
// important keyboard shortcuts. Opens via `sunday.guide.open` (Ctrl+Alt+G)
// and from the Help menu / Welcome walkthrough.
//
// User request 2026-10-11: "user ko kaise pata chalega theme kaise change
// karna hai — ek alag keybinding ke sath User guide wala section ho jaha har
// important commands/features ke baare mai likha ho."

import * as vscode from 'vscode';

export const SHOW_GUIDE_COMMAND = 'sunday.guide.open';

const GOLD = '#f5b942';
const DARK = '#1a1611';
const BROWN = '#221c14';
const BORDER = '#4a3d28';
const MUTED = '#a89878';

function guideHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: ${DARK}; color: #e8e0d0; padding: 32px; line-height: 1.6;
    max-width: 860px; margin: 0 auto;
  }
  .hero { text-align: center; margin-bottom: 36px; }
  .hero .logo {
    width: 64px; height: 64px; border-radius: 50%; background: ${GOLD};
    display: inline-flex; align-items: center; justify-content: center;
    font-size: 30px; margin-bottom: 12px;
  }
  .hero h1 { color: ${GOLD}; font-size: 28px; margin-bottom: 6px; }
  .hero p { color: ${MUTED}; font-size: 14px; }
  h2 {
    color: ${GOLD}; font-size: 19px; margin: 30px 0 12px;
    padding-bottom: 6px; border-bottom: 1px solid ${BORDER};
  }
  h3 { font-size: 15px; margin: 16px 0 6px; }
  p, li { font-size: 14px; color: #d4c9b0; }
  ul { padding-left: 20px; margin-bottom: 10px; }
  li { margin-bottom: 5px; }
  kbd {
    background: #2a2318; border: 1px solid ${BORDER}; border-bottom-width: 2px;
    border-radius: 5px; padding: 1px 7px; font-family: Consolas, monospace;
    font-size: 12px; color: ${GOLD}; white-space: nowrap;
  }
  code {
    background: #2a2318; border-radius: 4px; padding: 1px 6px;
    font-family: Consolas, monospace; font-size: 13px; color: ${GOLD};
  }
  .card {
    background: ${BROWN}; border: 1px solid ${BORDER}; border-radius: 12px;
    padding: 16px 20px; margin-bottom: 12px;
  }
  .card b.title { color: ${GOLD}; }
  table { width: 100%; border-collapse: collapse; margin: 10px 0 16px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid ${BORDER}; font-size: 13px; }
  th { color: ${GOLD}; }
  .btn {
    display: inline-block; background: ${GOLD}; color: ${DARK}; border: none;
    border-radius: 8px; padding: 9px 18px; font-size: 13px; font-weight: 700;
    cursor: pointer; margin: 4px 6px 4px 0;
  }
  .btn:hover { opacity: 0.9; }
  .btn.ghost { background: transparent; color: ${GOLD}; border: 1px solid ${GOLD}; }
  .tip { border-left: 3px solid ${GOLD}; padding: 8px 14px; background: ${BROWN}; margin: 12px 0; font-size: 13px; }
</style>
</head>
<body>
<div class="hero">
  <div class="logo">☀️</div>
  <h1>Sunday User Guide</h1>
  <p>Har Sunday feature, shortcut aur setting — ek hi jagah. Ye guide kabhi bhi <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>G</kbd> se kholo.</p>
</div>

<h2>🚀 Shuruaat (Getting Started)</h2>
<div class="card">
  <b class="title">1. Sign in karo</b>
  <p>Neeche-right status bar me <b>Sign In</b> pe click karo, ya Sunday Home (left bar ka ☀️ icon) kholo. Google ya GitHub se sign in karne par free tier activate hota hai — <b>200 AI requests/day</b>, koi credit card nahi.</p>
  <button class="btn" onclick="cmd('sunday.account.showMenu')">Sign in to Sunday</button>
</div>
<div class="card">
  <b class="title">2. Sunday Home</b>
  <p>Left activity bar me ☀️ icon = <b>Sunday Home</b>. Yahan saare 21+ features ek jagah milte hain — Agents, Streaks, Memory, Skills, Browser, MCP, Templates aur Updates.</p>
  <button class="btn" onclick="cmd('sunday.home.focus')">Open Sunday Home</button>
</div>

<h2>🎨 Theme Kaise Change Karein</h2>
<p>Sunday do built-in themes ke saath aata hai — <b>Sunday Dark</b> (default) aur <b>Sunday Light</b>. Amber/gold Sunday look ke liye:</p>
<ul>
  <li><kbd>Ctrl</kbd>+<kbd>K</kbd> phir <kbd>Ctrl</kbd>+<kbd>T</kbd> dabao → theme list khulegi</li>
  <li><b>Sunday Dark</b> ya <b>Sunday Light</b> select karo</li>
  <li>Ya Command Palette (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd>) → <code>Preferences: Color Theme</code></li>
</ul>
<button class="btn" onclick="cmd('workbench.action.selectTheme')">Theme Badlo</button>
<div class="tip">💡 Marketplace (Open VSX) se koi bhi dusra theme bhi install kar sakte ho — Extensions (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>X</kbd>) me search karo.</div>

<h2>🤖 AI Agent Kaise Use Karein</h2>
<div class="card">
  <b class="title">Sunday Chat</b>
  <p>Editor ke top bar me ✨ <b>Open IDE Agent</b> button, ya Sunday Home → Agent Chat. Apna kaam likho ("build a login page") — agent code likhega, files banayega, commands chalayega.</p>
  <button class="btn" onclick="cmd('sunday.agent.open')">Open IDE Agent</button>
</div>
<div class="card">
  <b class="title">@sunday (Built-in Chat)</b>
  <p>VS Code ke apne Chat panel me <code>@sunday tumhara sawal</code> likho. <code>@sunday /model</code> se model list dekho.</p>
</div>
<h3>Models</h3>
<table>
  <tr><th>Model</th><th>Kab use karein</th></tr>
  <tr><td>⚡ Auto</td><td>Recommended — speed + quality balance</td></tr>
  <tr><td>🧠 Llama 3.3 70B</td><td>Best quality, mushkil problems</td></tr>
  <tr><td>💻 Qwen 2.5 Coder 32B</td><td>Coding ke liye best</td></tr>
  <tr><td>🚀 Llama 3.1 8B</td><td>Sabse fast, chhote kaam</td></tr>
</table>

<h2>🔥 Streaks</h2>
<p>Roz code karo, streak banao! Neeche-right 🔥 button pe click karne se colorful streak panel khulta hai — current streak, longest streak, freezes aur agla reward (7/14/30 din pe +AI requests/day). Vacation mode se streak pause bhi kar sakte ho (14 din/saal).</p>
<button class="btn" onclick="cmd('sunday.streak.show')">Mera Streak Dekho</button>

<h2>⌨️ Important Shortcuts</h2>
<table>
  <tr><th>Shortcut</th><th>Kaam</th></tr>
  <tr><td><kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>G</kbd></td><td>Ye User Guide</td></tr>
  <tr><td><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd></td><td>Command Palette — saare Sunday commands yahan "Sunday:" search karke milenge</td></tr>
  <tr><td><kbd>Ctrl</kbd>+<kbd>K</kbd> <kbd>Ctrl</kbd>+<kbd>T</kbd></td><td>Theme badlo</td></tr>
  <tr><td><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>X</kbd></td><td>Extensions (Open VSX)</td></tr>
  <tr><td><kbd>Ctrl</kbd>+<kbd>~</kbd></td><td>Terminal</td></tr>
  <tr><td><kbd>Ctrl</kbd>+<kbd>P</kbd></td><td>File quickly kholo</td></tr>
  <tr><td><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd></td><td>Poore project me search</td></tr>
</table>

<h2>🧩 Sunday Features — Poori List</h2>
<ul>
  <li><b>Agent Chat / Manager / Mission Control</b> — multi-agent kaam</li>
  <li><b>Agent Modes</b> — Architect, Code, Debug, Ask modes</li>
  <li><b>Design to Code</b> — design se seedha code</li>
  <li><b>Best-of-N</b> — ek kaam ke kai solutions, best chuno</li>
  <li><b>Swarm</b> — kai agents ek saath</li>
  <li><b>Cloud Tasks</b> — lambi tasks cloud pe</li>
  <li><b>Agent Browser</b> — agent web browse karke verify karta hai</li>
  <li><b>MCP Servers</b> — Model Context Protocol tools</li>
  <li><b>Memory & Skills</b> — agent tumhari preferences yaad rakhta hai</li>
  <li><b>Scheduler</b> — tasks schedule karo</li>
  <li><b>Project Templates</b> — ready-made project starters</li>
  <li><b>Repo Onboarding</b> — naye repo ko samjho ek click me</li>
</ul>

<h2>🔄 Updates</h2>
<p>Sunday Home → <b>Check for Updates</b>, ya Help menu → Check for Updates. Naya version aane par yahin se download hoga.</p>
<button class="btn" onclick="cmd('sunday.checkForUpdates')">Check for Updates</button>

<h2>♿ Accessibility</h2>
<ul>
  <li>Saare Sunday panels keyboard se navigate hote hain (<kbd>Tab</kbd> / <kbd>Shift</kbd>+<kbd>Tab</kbd>)</li>
  <li>High Contrast themes: <kbd>Ctrl</kbd>+<kbd>K</kbd> <kbd>Ctrl</kbd>+<kbd>T</kbd> → "Default High Contrast"</li>
  <li>Zoom: <kbd>Ctrl</kbd>+<kbd>+</kbd> / <kbd>Ctrl</kbd>+<kbd>-</kbd> · Screen reader support VS Code ke saath built-in hai</li>
</ul>

<p style="text-align:center; color:${MUTED}; margin-top:36px;">☀️ Sunday — Editing evolved · Guide kabhi bhi: <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>G</kbd></p>

<script>
  const vscode = acquireVsCodeApi();
  function cmd(id) { vscode.postMessage({ type: 'command', id }); }
</script>
</body>
</html>`;
}

let guidePanel: vscode.WebviewPanel | undefined;

/** Opens (or reveals) the Sunday User Guide panel. */
export function showUserGuide(context: vscode.ExtensionContext): void {
  if (guidePanel) {
    guidePanel.reveal(vscode.ViewColumn.Active);
    return;
  }
  guidePanel = vscode.window.createWebviewPanel(
    'sundayUserGuide',
    '☀️ Sunday User Guide',
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  guidePanel.webview.html = guideHtml();
  guidePanel.webview.onDidReceiveMessage(
    (msg: { type?: string; id?: string }) => {
      if (msg.type === 'command' && typeof msg.id === 'string') {
        void vscode.commands.executeCommand(msg.id);
      }
    },
    undefined,
    context.subscriptions,
  );
  guidePanel.onDidDispose(() => { guidePanel = undefined; }, undefined, context.subscriptions);
}

/** Registers the `sunday.guide.open` command (keybinding: Ctrl+Alt+G). */
export function registerUserGuide(context: vscode.ExtensionContext): vscode.Disposable {
  return vscode.commands.registerCommand(SHOW_GUIDE_COMMAND, () => showUserGuide(context));
}
