/**
 * Sunday Google Authentication Provider.
 *
 * Implements a VS Code authentication provider for Google using the
 * OAuth 2.0 loopback flow (RFC 8252 §7.3) — the standard for desktop apps.
 *
 * Setup (one-time, by the Sunday operator):
 *   1. https://console.cloud.google.com/apis/credentials
 *   2. Create Credentials → OAuth client ID → Desktop app
 *   3. Set the client ID in `sunday.google.clientId` (or SUNDAY_GOOGLE_CLIENT_ID env)
 *
 * Scopes: openid email profile (minimal — we only need the user identity
 * for the Sunday hosted gateway free tier).
 */

import * as vscode from 'vscode';
import * as http from 'http';
import * as crypto from 'crypto';
import { URL, URLSearchParams } from 'url';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const SCOPES = ['openid', 'email', 'profile'].join(' ');
const SECRET_KEY = 'sunday.google.sessions';

interface StoredSession {
  id: string;
  accessToken: string;
  refreshToken?: string;
  account: { id: string; label: string };
  expiresAt: number;
}

const DEFAULT_CLIENT_ID = '759535868571-93cq3r0qh1i8pdddeol1buvnu41irtg2.apps.googleusercontent.com';

function getClientId(): string {
  return (
    process.env.SUNDAY_GOOGLE_CLIENT_ID?.trim() ||
    vscode.workspace.getConfiguration('sunday.google').get<string>('clientId', '').trim() ||
    DEFAULT_CLIENT_ID
  );
}

export class GoogleAuthProvider implements vscode.AuthenticationProvider {
  private readonly _onDidChangeSessions = new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
  readonly onDidChangeSessions = this._onDidChangeSessions.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  private async loadSessions(): Promise<StoredSession[]> {
    const raw = await this.context.secrets.get(SECRET_KEY);
    if (!raw) return [];
    try {
      return JSON.parse(raw) as StoredSession[];
    } catch {
      return [];
    }
  }

  private async saveSessions(sessions: StoredSession[]): Promise<void> {
    await this.context.secrets.store(SECRET_KEY, JSON.stringify(sessions));
    this._onDidChangeSessions.fire({ added: [], removed: [], changed: [] });
  }

  async getSessions(scopes?: readonly string[]): Promise<vscode.AuthenticationSession[]> {
    const stored = await this.loadSessions();
    const out: vscode.AuthenticationSession[] = [];
    for (const s of stored) {
      // Refresh if expiring within 5 minutes.
      let token = s.accessToken;
      if (s.refreshToken && s.expiresAt - Date.now() < 5 * 60 * 1000) {
        const refreshed = await this.refreshToken(s.refreshToken).catch(() => undefined);
        if (refreshed) {
          s.accessToken = refreshed.accessToken;
          s.expiresAt = refreshed.expiresAt;
          if (refreshed.refreshToken) s.refreshToken = refreshed.refreshToken;
          token = s.accessToken;
          await this.saveSessions(stored);
        }
      }
      out.push({
        id: s.id,
        accessToken: token,
        account: s.account,
        scopes: scopes ? [...scopes] : [],
      });
    }
    return out;
  }

  async createSession(scopes: readonly string[]): Promise<vscode.AuthenticationSession> {
    const clientId = getClientId();
    if (!clientId) {
      throw new Error(
        'Google sign-in is not configured. Set `sunday.google.clientId` in settings (create an OAuth client ID at https://console.cloud.google.com/apis/credentials, Desktop app type).',
      );
    }

    const { code, redirectUri, codeVerifier } = await this.loopbackFlow(clientId, scopes);
    const tokens = await this.exchangeCode(code, redirectUri, codeVerifier, clientId);
    const userinfo = await this.fetchUserinfo(tokens.accessToken);

    const session: StoredSession = {
      id: crypto.randomUUID(),
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      account: {
        id: userinfo.sub,
        label: userinfo.email || userinfo.name || userinfo.sub,
      },
      expiresAt: Date.now() + tokens.expiresIn * 1000,
    };

    const sessions = await this.loadSessions();
    // One Google account per IDE (matches the hosted-gateway free tier model).
    const next = [session];
    await this.saveSessions(next);

    return {
      id: session.id,
      accessToken: session.accessToken,
      account: session.account,
      scopes: [...scopes],
    };
  }

  async removeSession(id: string): Promise<void> {
    const sessions = await this.loadSessions();
    const target = sessions.find((s) => s.id === id);
    if (target) {
      // Best-effort revoke of BOTH tokens. Revoking only the access token
      // leaves the long-lived refresh token valid (Privacy M3) — a "sign out"
      // that doesn't actually sign out. Google's revoke endpoint accepts
      // either token type.
      const revoke = (token: string) =>
        fetch(GOOGLE_REVOKE_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token }),
        }).catch(() => undefined);
      await revoke(target.accessToken);
      if (target.refreshToken) {
        await revoke(target.refreshToken);
      }
    }
    await this.saveSessions(sessions.filter((s) => s.id !== id));
  }

  // -- OAuth internals ----------------------------------------------------------

  private async loopbackFlow(
    clientId: string,
    scopes: readonly string,
  ): Promise<{ code: string; redirectUri: string; codeVerifier: string }> {
    // PKCE (RFC 7636) — required for loopback clients.
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    const state = crypto.randomBytes(16).toString('hex');

    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        try {
          const url = new URL(req.url || '/', 'http://127.0.0.1');
          if (url.pathname !== '/callback') {
            res.writeHead(404).end();
            return;
          }
          const code = url.searchParams.get('code');
          const returnedState = url.searchParams.get('state');
          const error = url.searchParams.get('error');
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end(
            '<html><body style="font-family:sans-serif;text-align:center;padding-top:40px">' +
              '<h2>Google sign-in complete</h2><p>You can close this tab and return to Sunday.</p>' +
              '</body></html>',
          );
          server.close();
          if (error) {
            reject(new Error(`Google OAuth error: ${error}`));
          } else if (!code || returnedState !== state) {
            reject(new Error('Google OAuth: invalid callback (missing code or state mismatch)'));
          } else {
            const addr = server.address();
            const port = typeof addr === 'object' && addr ? addr.port : 0;
            resolve({ code, redirectUri: `http://127.0.0.1:${port}/callback`, codeVerifier });
          }
        } catch (e) {
          server.close();
          reject(e);
        }
      });

      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        const redirectUri = `http://127.0.0.1:${port}/callback`;
        const params = new URLSearchParams({
          client_id: clientId,
          redirect_uri: redirectUri,
          response_type: 'code',
          scope: [...scopes, ...SCOPES.split(' ')].filter((s, i, a) => s && a.indexOf(s) === i).join(' '),
          code_challenge: codeChallenge,
          code_challenge_method: 'S256',
          state,
          access_type: 'offline',
          prompt: 'consent',
        });
        vscode.env.openExternal(vscode.Uri.parse(`${GOOGLE_AUTH_URL}?${params}`));
      });

      server.on('error', reject);
      // 5-minute timeout for the user to complete the browser flow.
      setTimeout(() => {
        server.close();
        reject(new Error('Google sign-in timed out. Please try again.'));
      }, 5 * 60 * 1000).unref?.();
    });
  }

  private async exchangeCode(
    code: string,
    redirectUri: string,
    codeVerifier: string,
    clientId: string,
  ): Promise<{ accessToken: string; refreshToken?: string; expiresIn: number }> {
    const res = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
        grant_type: 'authorization_code',
      }),
    });
    if (!res.ok) {
      throw new Error(`Google token exchange failed (HTTP ${res.status})`);
    }
    const body = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (!body.access_token) throw new Error('Google token exchange: no access token returned');
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresIn: body.expires_in ?? 3600,
    };
  }

  private async refreshToken(
    refreshToken: string,
  ): Promise<{ accessToken: string; refreshToken?: string; expiresAt: number }> {
    const clientId = getClientId();
    const res = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    if (!res.ok) throw new Error(`Google token refresh failed (HTTP ${res.status})`);
    const body = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (!body.access_token) throw new Error('Google token refresh: no access token returned');
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
    };
  }

  private async fetchUserinfo(
    accessToken: string,
  ): Promise<{ sub: string; email?: string; name?: string }> {
    const res = await fetch(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new Error(`Google userinfo failed (HTTP ${res.status})`);
    const body = (await res.json()) as { sub?: string; email?: string; name?: string };
    if (!body.sub) throw new Error('Google userinfo: no sub returned');
    return { sub: body.sub, email: body.email, name: body.name };
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new GoogleAuthProvider(context);
  context.subscriptions.push(
    vscode.authentication.registerAuthenticationProvider('google', 'Google', provider, {
      supportsMultipleAccounts: false,
    }),
  );
}

export function deactivate(): void {}
