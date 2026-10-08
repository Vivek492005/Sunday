// Tests for skills-marketplace/panel.ts: registry fetch/parse, HTML
// rendering, friendly states. The vscode shell is mocked.
import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  window: {
    createWebviewPanel: vi.fn(),
    showInformationMessage: vi.fn(),
    showErrorMessage: vi.fn(),
  },
  commands: { registerCommand: vi.fn() },
  workspace: { getConfiguration: () => ({ get: (_k: string, d: unknown) => d }) },
  extensions: { getExtension: () => undefined },
  ViewColumn: { One: 1 },
}));

import {
  DEFAULT_REGISTRY_URL,
  fetchRegistry,
  RegistryFetchError,
  renderMarketplaceHtml,
  renderMarketplacePage,
  renderMarketplaceState,
  resolveRegistryUrl,
} from './panel.js';
import type { RegistrySkill } from './registry.js';

const skills: RegistrySkill[] = [
  {
    name: 'hello-sunday',
    description: 'Example <b>skill</b>.',
    author: 'Sunday',
    version: '1.0.0',
    downloadUrl: 'https://example.com/a.md',
  },
  {
    name: 'git-helper',
    description: 'Git reminders.',
    author: 'Sunday',
    version: '2.1.0',
    downloadUrl: 'https://example.com/b.md',
  },
];

function registryFetch(doc: unknown, ok = true, status = 200) {
  return async () => ({
    ok,
    status,
    headers: { get: () => null },
    arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(doc)).buffer as ArrayBuffer,
  });
}

describe('resolveRegistryUrl', () => {
  const cfg = (url: string) => ({
    get: <T>(key: string, def: T): T => (key === 'skills.registryUrl' ? (url as T) : def),
  });

  it('uses the default registry URL when unconfigured', () => {
    expect(resolveRegistryUrl(cfg(''))).toBe(DEFAULT_REGISTRY_URL);
    expect(DEFAULT_REGISTRY_URL).toContain('raw.githubusercontent.com/Vivek492005/Sunday');
  });

  it('honors a custom registry URL', () => {
    expect(resolveRegistryUrl(cfg('https://x.example/r.json'))).toBe('https://x.example/r.json');
  });
});

describe('fetchRegistry', () => {
  it('parses a valid registry, reporting rejections', async () => {
    const r = await fetchRegistry(
      registryFetch({ skills: [...skills.map((s) => ({ ...s })), { name: 'bad!!' }] }) as any,
      'https://x/r.json',
    );
    expect(r.skills).toHaveLength(2);
    expect(r.rejected).toHaveLength(1);
  });

  it('throws RegistryFetchError when unreachable or invalid', async () => {
    await expect(
      fetchRegistry(async () => { throw new Error('dns'); }, 'https://x/r.json'),
    ).rejects.toBeInstanceOf(RegistryFetchError);
    await expect(
      fetchRegistry(registryFetch({}, false, 404) as any, 'https://x/r.json'),
    ).rejects.toBeInstanceOf(RegistryFetchError);
    const badJson = async () => ({
      ok: true, status: 200, headers: { get: () => null },
      arrayBuffer: async () => new TextEncoder().encode('not json').buffer as ArrayBuffer,
    });
    await expect(fetchRegistry(badJson, 'https://x/r.json')).rejects.toBeInstanceOf(
      RegistryFetchError,
    );
  });
});

describe('renderMarketplaceHtml', () => {
  it('renders install buttons and escapes descriptions', () => {
    const html = renderMarketplaceHtml(skills, new Set(), 0);
    expect(html).toContain('hello-sunday');
    expect(html).toContain('data-action="install"');
    expect(html).not.toContain('<b>skill</b>');
    expect(html).toContain('&lt;b&gt;skill&lt;/b&gt;');
    expect(html).toContain('v1.0.0');
  });

  it('shows installed state with uninstall buttons', () => {
    const html = renderMarketplaceHtml(skills, new Set(['hello-sunday']), 0);
    expect(html).toContain('installed');
    expect(html).toContain('data-action="uninstall" data-name="hello-sunday"');
    // The other skill still offers install.
    expect(html).toContain('data-action="install" data-name="git-helper"');
  });

  it('notes rejected entries and empty registries', () => {
    expect(renderMarketplaceHtml([], new Set(), 0)).toContain('No skills in this registry');
    expect(renderMarketplaceHtml(skills, new Set(), 3)).toContain('3 registry entries were rejected');
    expect(renderMarketplaceHtml(skills, new Set(), 1)).toContain('1 registry entry was rejected');
  });

  it('carries the never-execute safety note', () => {
    expect(renderMarketplaceHtml(skills, new Set(), 0)).toContain('never executed');
  });
});

describe('renderMarketplaceState', () => {
  it('renders the friendly registry-unavailable state', () => {
    const html = renderMarketplaceState('unavailable', 'https://x/r.json');
    expect(html).toContain('Registry unavailable');
    expect(html).toContain('https://x/r.json');
    expect(renderMarketplaceState('loading')).toContain('Loading skills');
    expect(renderMarketplaceState('error', 'boom')).toContain('boom');
  });
});

describe('renderMarketplacePage', () => {
  it('builds a full page with CSP nonce and message wiring', () => {
    const page = renderMarketplacePage('<p>hi</p>', 'n123', 'https://null');
    expect(page).toContain(`script-src 'nonce-n123'`);
    expect(page).toContain('skills/refresh');
    expect(page).toContain('data-action');
    expect(page).toContain('<p>hi</p>');
  });
});
