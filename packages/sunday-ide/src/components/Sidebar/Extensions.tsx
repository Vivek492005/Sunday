/**
 * Sunday Extensions — browse Open VSX, install/uninstall, enable/disable.
 * Sunday's own UI throughout.
 *
 * NOTE: there is no extension host yet — installed extensions are stored
 * under ~/.sunday-ide/extensions and are inert until the host lands
 * (follow-up). This wave ships the full UI + install/uninstall mechanics.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { extensionsService, type OpenVsxExtension, type InstalledExtension } from '../../services/extensionsService';
import { SearchIcon, RefreshIcon } from '../icons';
import './extensions.css';

type Tab = 'browse' | 'installed';

export function Extensions() {
  const [tab, setTab] = useState<Tab>('browse');
  return (
    <div className="sunday-ext-root">
      <div className="sunday-sidebar-header">
        <span className="title">EXTENSIONS</span>
      </div>
      <div className="sunday-ext-tabs" role="tablist" aria-label="Extensions tabs">
        {(['browse', 'installed'] as Tab[]).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            className={`sunday-ext-tab${tab === t ? ' active' : ''}`}
            onClick={() => setTab(t)}
          >
            {t === 'browse' ? 'Browse' : 'Installed'}
          </button>
        ))}
      </div>
      {tab === 'browse' ? <BrowseTab /> : <InstalledTab />}
      <div className="sunday-ext-note">
        Extension host coming soon — installed extensions are stored locally until then.
      </div>
    </div>
  );
}

function BrowseTab() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<OpenVsxExtension[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [installedIds, setInstalledIds] = useState<Set<string>>(new Set());
  const seq = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const refreshInstalled = useCallback(async () => {
    try {
      const list = await extensionsService.list();
      setInstalledIds(new Set(list.map((e) => e.id)));
    } catch {
      // non-fatal
    }
  }, []);

  useEffect(() => {
    inputRef.current?.focus();
    void refreshInstalled();
  }, [refreshInstalled]);

  const runSearch = useCallback(async (q: string) => {
    const my = ++seq.current;
    setSearching(true);
    setError(null);
    try {
      const res = await extensionsService.search(q);
      if (seq.current !== my) return;
      setResults(res ?? []);
    } catch (err) {
      if (seq.current !== my) return;
      setError(err instanceof Error ? err.message : 'Search failed — check your connection');
      setResults([]);
    } finally {
      if (seq.current === my) setSearching(false);
    }
  }, []);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      setError(null);
      setSearching(false);
      return;
    }
    const t = setTimeout(() => void runSearch(q), 400);
    return () => clearTimeout(t);
  }, [query, runSearch]);

  const install = async (ext: OpenVsxExtension) => {
    setInstalling(ext.id);
    setError(null);
    try {
      const r = await extensionsService.install(ext);
      if (!r.ok) setError(r.error ?? 'Install failed');
      else await refreshInstalled();
    } finally {
      setInstalling(null);
    }
  };

  return (
    <div className="sunday-ext-tabbody">
      <div className="sunday-ext-searchrow">
        <div className="sunday-ext-search">
          <SearchIcon size={15} />
          <input
            ref={inputRef}
            placeholder="Search Open VSX…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search extensions"
          />
        </div>
      </div>
      <div className="sunday-ext-list">
        {error && <div className="sunday-ext-error">{error}</div>}
        {searching && <div className="sunday-ext-hint">Searching Open VSX…</div>}
        {!searching && !error && query.trim() && results.length === 0 && (
          <div className="sunday-ext-hint">No extensions found for &lsquo;{query.trim()}&rsquo;</div>
        )}
        {!query.trim() && !searching && (
          <div className="sunday-ext-hint">Type to search the Open VSX registry.</div>
        )}
        {results.map((ext) => {
          const installed = installedIds.has(ext.id);
          return (
            <div key={ext.id} className="sunday-ext-card">
              <div className="sunday-ext-card-main">
                <div className="sunday-ext-name" title={ext.id}>{ext.displayName}</div>
                <div className="sunday-ext-meta">{ext.namespace} · v{ext.version}</div>
                {ext.description && <div className="sunday-ext-desc">{ext.description}</div>}
              </div>
              <button
                className={`sunday-ext-btn${installed ? ' installed' : ''}`}
                disabled={installed || installing === ext.id}
                onClick={() => void install(ext)}
              >
                {installing === ext.id ? 'Installing…' : installed ? 'Installed' : 'Install'}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function InstalledTab() {
  const [list, setList] = useState<InstalledExtension[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setList(await extensionsService.list());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to list extensions');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggle = async (ext: InstalledExtension) => {
    setBusy(ext.id);
    try {
      await extensionsService.setEnabled(ext.id, !ext.enabled);
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  const uninstall = async (ext: InstalledExtension) => {
    if (!window.confirm(`Uninstall "${ext.displayName}"?`)) return;
    setBusy(ext.id);
    setError(null);
    try {
      const r = await extensionsService.uninstall(ext.id);
      if (!r.ok) setError(r.error ?? 'Uninstall failed');
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="sunday-ext-tabbody">
      <div className="sunday-ext-list">
        {loading && <div className="sunday-ext-hint">Loading installed extensions…</div>}
        {error && <div className="sunday-ext-error">{error}</div>}
        {!loading && !error && list.length === 0 && (
          <div className="sunday-ext-hint">Nothing installed yet — browse Open VSX to add extensions.</div>
        )}
        {list.map((ext) => (
          <div key={ext.id} className={`sunday-ext-card${ext.enabled ? '' : ' disabled'}`}>
            <div className="sunday-ext-card-main">
              <div className="sunday-ext-name" title={ext.id}>{ext.displayName}</div>
              <div className="sunday-ext-meta">{ext.namespace} · v{ext.version}</div>
            </div>
            <div className="sunday-ext-actions">
              <button
                className="sunday-toggle small"
                role="switch"
                aria-checked={ext.enabled}
                aria-label={ext.enabled ? 'Disable' : 'Enable'}
                disabled={busy === ext.id}
                onClick={() => void toggle(ext)}
              >
                <span className="knob" />
              </button>
              <button
                className="sunday-ext-uninstall"
                disabled={busy === ext.id}
                onClick={() => void uninstall(ext)}
              >
                {busy === ext.id ? '…' : 'Uninstall'}
              </button>
            </div>
          </div>
        ))}
      </div>
      <button className="sunday-ext-refresh" onClick={() => void refresh()} title="Refresh">
        <RefreshIcon size={14} /> Refresh
      </button>
    </div>
  );
}
