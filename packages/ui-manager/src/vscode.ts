// Thin wrapper around the VS Code webview API. Falls back to a no-op stub
// outside a real webview (unit tests, plain browsers) so modules stay
// importable anywhere. Mirrors @sunday/ui-chat's vscode.ts.
import type { OutboundMessage } from './managerClient.js';

export interface VsCodeApi {
  postMessage(message: unknown): void;
}

declare global {
  // Provided by the VS Code webview host; absent elsewhere.
  function acquireVsCodeApi(): VsCodeApi;
}

let cached: VsCodeApi | undefined;

export function getVsCodeApi(): VsCodeApi {
  if (!cached) {
    cached =
      typeof acquireVsCodeApi === 'function'
        ? acquireVsCodeApi()
        : { postMessage: () => undefined };
  }
  return cached;
}

export function postToExtension(message: OutboundMessage): void {
  getVsCodeApi().postMessage(message);
}
