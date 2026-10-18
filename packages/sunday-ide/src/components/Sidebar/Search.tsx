/**
 * Sunday Search — ripgrep-powered text search across the open folder.
 * Debounced input, results grouped by file, click a match to open it.
 * Nothing here comes from VS Code.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useIde } from '../../state/ideStore';
import { searchService, SearchResult } from '../../services/searchService';
import './search.css';

interface FileGroup {
  path: string;
  name: string;
  dir: string;
  matches: SearchResult[];
}

function splitName(relPath: string): { name: string; dir: string } {
  const idx = Math.max(relPath.lastIndexOf('/'), relPath.lastIndexOf('\\'));
  if (idx === -1) return { name: relPath, dir: '' };
  return { name: relPath.slice(idx + 1), dir: relPath.slice(0, idx) };
}

function relativeTo(path: string, root: string): string {
  const clean = (p: string): string => p.replace(/\\/g, '/').replace(/\/$/, '');
  const n = clean(path);
  const r = clean(root);
  return n.startsWith(r + '/') ? n.slice(r.length + 1) : path;
}

function HighlightMatch({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = text.split(new RegExp(`(${escaped})`, 'gi'));
  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === query.toLowerCase() ? (
          <span key={i} className="sunday-search-hit">
            {part}
          </span>
        ) : (
          <React.Fragment key={i}>{part}</React.Fragment>
        ),
      )}
    </>
  );
}

export function Search() {
  const { state, dispatch } = useIde();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchedQuery, setSearchedQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const seq = useRef(0);

  // auto-focus on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // reset when the folder changes
  useEffect(() => {
    seq.current += 1;
    setResults([]);
    setError(null);
    setSearchedQuery('');
    setSearching(false);
  }, [state.rootFolder]);

  const [hybridMode, setHybridMode] = useState(true);
  const [hybridWhys, setHybridWhys] = useState<Map<string, string>>(new Map());

  const runSearch = useCallback(async (q: string, dir: string) => {
    const my = ++seq.current;
    setSearching(true);
    setError(null);
    try {
      // F5: try hybrid retrieval first (explainable); fall back to ripgrep
      // when no workspace index exists.
      if (hybridMode) {
        try {
          const hres = await searchService.hybrid(q, dir);
          if (seq.current !== my) return;
          const whyMap = new Map<string, string>();
          const mapped = hres.map((h) => {
            whyMap.set(`${h.path}:${h.line}`, h.why);
            return { path: h.path, line: h.line, column: 0, text: h.text };
          });
          setHybridWhys(whyMap);
          setResults(mapped);
          setSearchedQuery(q);
          return;
        } catch {
          // No index — fall through to ripgrep
        }
      }
      setHybridWhys(new Map());
      const res = await searchService.text(q, dir);
      if (seq.current !== my) return;
      setResults(res ?? []);
      setSearchedQuery(q);
    } catch (err) {
      if (seq.current !== my) return;
      setError(err instanceof Error ? err.message : 'Search failed');
      setResults([]);
    } finally {
      if (seq.current === my) setSearching(false);
    }
  }, [hybridMode]);

  // debounce 300ms
  useEffect(() => {
    const q = query.trim();
    if (!q || !state.rootFolder) {
      setSearching(false);
      return;
    }
    const t = setTimeout(() => {
      void runSearch(q, state.rootFolder as string);
    }, 300);
    return () => clearTimeout(t);
  }, [query, state.rootFolder, runSearch]);

  const clear = useCallback(() => {
    seq.current += 1;
    setQuery('');
    setResults([]);
    setError(null);
    setSearchedQuery('');
    setSearching(false);
    inputRef.current?.focus();
  }, []);

  const groups: FileGroup[] = useMemo(() => {
    const root = state.rootFolder ?? '';
    const map = new Map<string, FileGroup>();
    for (const r of results) {
      let g = map.get(r.path);
      if (!g) {
        const rel = relativeTo(r.path, root);
        const { name, dir } = splitName(rel);
        g = { path: r.path, name, dir, matches: [] };
        map.set(r.path, g);
      }
      g.matches.push(r);
    }
    return [...map.values()];
  }, [results, state.rootFolder]);

  if (!state.rootFolder) {
    return (
      <div className="sunday-search-root">
        <div className="sunday-sidebar-header">
          <span className="title">SEARCH</span>
        </div>
        <div className="sunday-empty-state">
          <div style={{ fontSize: 14, color: 'var(--sunday-fg-dim)' }}>
            Open a folder to search
          </div>
        </div>
      </div>
    );
  }

  const showHint = !query.trim() && !searchedQuery && !error && !searching;
  const showNoResults =
    searchedQuery && !searching && !error && results.length === 0;

  return (
    <div className="sunday-search-root">
      <div className="sunday-sidebar-header">
        <span className="title">SEARCH</span>
      </div>

      <div className="sunday-search-input-row">
        <input
          ref={inputRef}
          className="sunday-search-input"
          placeholder="Search across files…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') clear();
            else if (e.key === 'Enter') {
              const q = query.trim();
              if (q && state.rootFolder) void runSearch(q, state.rootFolder);
            }
          }}
        />
        {searching ? (
          <span className="sunday-search-spinner" title="Searching…" />
        ) : (
          query && (
            <button
              className="sunday-search-clear"
              title="Clear"
              onClick={clear}
              aria-label="Clear search"
            >
              ×
            </button>
          )
        )}
      </div>

      <div className="sunday-search-body">
        {error && <div className="sunday-search-error">{error}</div>}

        <label className="sunday-search-hybrid-toggle" title="F5 hybrid retrieval: TF-IDF + symbol graph + embeddings (falls back to ripgrep)">
          <input
            type="checkbox"
            checked={hybridMode}
            onChange={(e) => setHybridMode(e.target.checked)}
          />
          Smart search
        </label>

        {showHint && (
          <div className="sunday-search-hint">
            Type to search across every file in the open folder.
          </div>
        )}

        {showNoResults && (
          <div className="sunday-search-hint">
            No results for &lsquo;{searchedQuery}&rsquo;
          </div>
        )}

        {!searching && !error && results.length > 0 && (
          <div className="sunday-search-summary">
            {results.length} result{results.length === 1 ? '' : 's'} in{' '}
            {groups.length} file{groups.length === 1 ? '' : 's'}
          </div>
        )}

        {groups.map((g) => (
          <div key={g.path} className="sunday-search-file">
            <div className="sunday-search-file-header" title={g.path}>
              <span className="sunday-search-file-name">{g.name}</span>
              <span className="sunday-search-file-dir">{g.dir}</span>
              <span className="sunday-search-file-count">
                {g.matches.length} match{g.matches.length === 1 ? '' : 'es'}
              </span>
            </div>
            {g.matches.map((m, i) => (
              <button
                key={`${m.line}:${m.column}:${i}`}
                className="sunday-search-row"
                title={g.path}
                onClick={() => dispatch({ type: 'OPEN_FILE', path: m.path })}
              >
                <span className="sunday-search-line">{m.line}</span>
                <span className="sunday-search-text">
                  <HighlightMatch text={m.text.trim()} query={searchedQuery} />
                </span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
