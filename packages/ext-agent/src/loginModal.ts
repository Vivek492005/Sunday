// sunday-agent — Centered Sunday Login modal with logo.
//
// Replaces the small QuickPick popup with a beautiful centered webview modal
// featuring the Sunday logo, Google/GitHub sign-in buttons, and warm branding.
// Opens via `sunday.account.showLoginModal` command.

import * as vscode from 'vscode';

export const SHOW_LOGIN_MODAL_COMMAND = 'sunday.account.showLoginModal';

/** Sunday brand colors */
const SUNDAY_GOLD = '#f5b942';
const SUNDAY_DARK = '#1a1611';
const SUNDAY_BROWN = '#221c14';

function loginHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: ${SUNDAY_DARK};
    color: #e8e0d0;
    display: flex; align-items: center; justify-content: center;
    min-height: 100vh; padding: 24px;
  }
  .card {
    background: ${SUNDAY_BROWN};
    border: 1px solid #4a3d28;
    border-radius: 16px;
    padding: 48px 40px;
    max-width: 400px; width: 100%;
    text-align: center;
    box-shadow: 0 24px 64px rgba(0,0,0,0.5);
  }
  .logo {
    width: 72px; height: 72px; border-radius: 50%;
    background: ${SUNDAY_GOLD};
    display: flex; align-items: center; justify-content: center;
    font-size: 36px; margin: 0 auto 20px;
  }
  h1 { font-size: 24px; font-weight: 700; color: ${SUNDAY_GOLD}; margin-bottom: 8px; }
  p.sub { font-size: 14px; color: #8a7a5c; margin-bottom: 32px; }
  .btn {
    display: flex; align-items: center; justify-content: center; gap: 12px;
    width: 100%; padding: 14px 20px; margin-bottom: 12px;
    border-radius: 10px; border: 1px solid #4a3d28;
    font-size: 15px; font-weight: 600; cursor: pointer;
    transition: transform 0.1s, box-shadow 0.2s;
  }
  .btn:hover { transform: translateY(-1px); box-shadow: 0 4px 16px rgba(245,185,66,0.2); }
  .btn-google { background: #ffffff; color: #1a1611; border-color: #e0d5c0; }
  .btn-github { background: #24292f; color: #ffffff; border-color: #4a3d28; }
  .btn svg { width: 20px; height: 20px; }
  .footer { margin-top: 24px; font-size: 12px; color: #5c4f38; }
</style>
</head>
<body>
<div class="card">
  <div class="logo">☀️</div>
  <h1>Welcome to Sunday</h1>
  <p class="sub">Sign in to unlock AI features, streaks &amp; sync</p>
  <button class="btn btn-google" onclick="signin('google')">
    <svg viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.1c-.22-.66-.35-1.36-.35-2.1s.13-1.44.35-2.1V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l3.66-2.84z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/></svg>
    Continue with Google
  </button>
  <button class="btn btn-github" onclick="signin('github')">
    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg>
    Continue with GitHub
  </button>
  <p class="footer">Free tier · 200 AI requests/day · No credit card</p>
</div>
<script>
  const vscode = acquireVsCodeApi();
  function signin(provider) { vscode.postMessage({ type: 'signin', provider }); }
</script>
</body>
</html>`;
}

/** Opens the centered Sunday login modal. Returns the chosen provider or undefined. */
export function showLoginModal(): Promise<'google' | 'github' | undefined> {
  return new Promise((resolve) => {
    const panel = vscode.window.createWebviewPanel(
      'sundayLogin',
      'Sign in to Sunday',
      vscode.ViewColumn.Active,
      { enableScripts: true }
    );
    panel.webview.html = loginHtml();
    let resolved = false;
    const done = (v: 'google' | 'github' | undefined) => {
      if (!resolved) { resolved = true; resolve(v); panel.dispose(); }
    };
    panel.webview.onDidReceiveMessage((msg: { type?: string; provider?: string }) => {
      if (msg.type === 'signin' && (msg.provider === 'google' || msg.provider === 'github')) {
        done(msg.provider);
      }
    });
    panel.onDidDispose(() => done(undefined));
  });
}

/** Registers the `sunday.account.showLoginModal` command. */
export function registerLoginModal(
  context: vscode.ExtensionContext,
  onSignIn: (provider: 'google' | 'github') => Promise<void>,
): vscode.Disposable {
  return vscode.commands.registerCommand(SHOW_LOGIN_MODAL_COMMAND, async () => {
    const provider = await showLoginModal();
    if (provider) await onSignIn(provider);
  });
}
