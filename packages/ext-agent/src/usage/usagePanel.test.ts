// Tests for usage/usagePanel.ts rendering: empty data, populated data,
// HTML escaping, friendly states. The vscode shell is not exercised here.
import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  window: {
    createWebviewPanel: vi.fn(),
  },
  commands: {
    registerCommand: vi.fn(),
  },
  workspace: {
    getConfiguration: () => ({ get: (_k: string, d: unknown) => d }),
  },
  extensions: {
    getExtension: () => undefined,
  },
  ViewColumn: { One: 1 },
}));
import {
  compact,
  escapeHtml,
  historyChart,
  modelBars,
  renderUsageHtml,
  renderUsagePage,
  renderUsageState,
} from './usagePanel.js';
import type { UsageSnapshot as S } from './gatewayClient.js';

const empty: S = {
  today: { requests: 0, tokens_in: 0, tokens_out: 0 },
  by_model: [],
  history_7d: Array.from({ length: 7 }, (_, i) => ({ day: `2026-10-0${i + 1}`, requests: 0 })),
};

const full: S = {
  today: { requests: 12, tokens_in: 1500, tokens_out: 23000 },
  by_model: [
    { model: 'openrouter:meta-llama/llama-3.3-70b-instruct', requests: 9, tokens: 20000 },
    { model: 'groq:llama-3.3-70b-versatile', requests: 3, tokens: 4500 },
  ],
  history_7d: [
    { day: '2026-10-02', requests: 0 },
    { day: '2026-10-03', requests: 2 },
    { day: '2026-10-04', requests: 5 },
    { day: '2026-10-05', requests: 1 },
    { day: '2026-10-06', requests: 0 },
    { day: '2026-10-07', requests: 4 },
    { day: '2026-10-08', requests: 0 },
  ],
};

describe('renderUsageHtml', () => {
  it('renders an empty-but-valid dashboard for empty data', () => {
    const html = renderUsageHtml(empty);
    expect(html).toContain('0');
    expect(html).toContain('No requests yet');
    expect(html).toContain('<svg');
    expect(html).not.toContain('undefined');
  });

  it('renders totals, model bars, and the 7-day chart', () => {
    const html = renderUsageHtml(full);
    expect(html).toContain('12');
    expect(html).toContain('1.5k'); // compact tokens_in
    expect(html).toContain('23.0k'); // compact tokens_out
    expect(html).toContain('openrouter:meta-llama/llama-3.3-70b-instruct');
    expect(html).toContain('groq:llama-3.3-70b-versatile');
    expect(html).toContain('mfill');
    // 7 bars, one per day
    expect((html.match(/<rect /g) ?? []).length).toBe(7);
  });

  it('escapes model names (no HTML injection)', () => {
    const evil: S = {
      ...empty,
      by_model: [{ model: '<script>alert(1)</script>', requests: 1, tokens: 10 }],
    };
    const html = renderUsageHtml(evil);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('renderUsageState', () => {
  it('covers loading, unreachable, auth, and error states', () => {
    expect(renderUsageState('loading')).toContain('Loading usage');
    const un = renderUsageState('unreachable', 'https://gw.example.com');
    expect(un).toContain('Gateway unreachable');
    expect(un).toContain('https://gw.example.com');
    expect(un).not.toContain('<script>');
    const auth = renderUsageState('auth');
    expect(auth).toContain('Sign in required');
    const err = renderUsageState('error', 'boom <b>');
    expect(err).toContain('Could not load usage');
    expect(err).toContain('boom &lt;b&gt;');
  });
});

describe('renderUsagePage', () => {
  it('builds a full page with CSP nonce and refresh wiring', () => {
    const page = renderUsagePage('<p>hi</p>', 'abc123', 'https://null');
    expect(page).toContain(`script-src 'nonce-abc123'`);
    expect(page).toContain('id="refresh"');
    expect(page).toContain('usage/refresh');
    expect(page).toContain('<p>hi</p>');
  });
});

describe('helpers', () => {
  it('compact() formats thousands', () => {
    expect(compact(999)).toBe('999');
    expect(compact(1500)).toBe('1.5k');
    expect(compact(2_500_000)).toBe('2.5M');
  });

  it('escapeHtml() escapes markup', () => {
    expect(escapeHtml('<a href="x">&')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;');
  });

  it('historyChart() renders one bar per day', () => {
    const svg = historyChart(full.history_7d);
    expect((svg.match(/<rect /g) ?? []).length).toBe(7);
    expect(svg).toContain('aria-label');
  });

  it('modelBars() shows the empty hint when there are no models', () => {
    expect(modelBars([])).toContain('No requests yet');
  });
});
