/**
 * Design Mode — embedded page preview with a point-and-click element
 * picker. Clicking "Pick element" injects a one-shot picker script into
 * the LIVE page DOM (via the webview's executeJavaScript): the next click
 * in the preview is captured, a unique CSS selector + tag + visible text
 * are computed in-page, and the result is attached as a context chip in
 * the Agent panel ("fix this element"). Everything here is real DOM data
 * from the actual page — nothing is simulated.
 *
 * The preview is an Electron <webview> with no preload, no node access,
 * and sandbox enabled (main enables webviewTag for exactly this).
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  getDesignChip,
  setDesignChip,
  clearDesignChip,
  type DesignChip,
} from '../../services/designContext';

/** Minimal structural type for the Electron webview element. */
interface WebviewEl extends HTMLElement {
  src: string;
  executeJavaScript(code: string): Promise<unknown>;
  getURL(): string;
  goBack(): void;
  goForward(): void;
  reload(): void;
}

interface PickResult {
  selector: string;
  tag: string;
  text: string;
  url: string;
}

/**
 * In-page picker. Returns a promise (Electron awaits it) that resolves
 * with the picked element's data, or null when the user presses Escape.
 * Hover outlines the hovered element; the click is captured (and not
 * delivered to the page) exactly once.
 */
const PICKER_SCRIPT = `(() => {
  if (window.__sundayPickerCleanup) window.__sundayPickerCleanup();
  return new Promise((resolve) => {
    var hovered = null;
    var prevOutline = '';
    function cssPath(el) {
      if (!(el instanceof Element)) return '';
      var parts = [];
      var node = el;
      while (node && node.nodeType === 1 && parts.length < 8) {
        if (node.id) {
          var byId = '#' + CSS.escape(node.id);
          try {
            if (document.querySelectorAll(byId).length === 1) { parts.unshift(byId); break; }
          } catch (e) { /* fall through to path */ }
        }
        var part = node.tagName.toLowerCase();
        var parent = node.parentElement;
        if (parent) {
          var sibs = Array.prototype.filter.call(parent.children, function (c) { return c.tagName === node.tagName; });
          if (sibs.length > 1) part += ':nth-of-type(' + (sibs.indexOf(node) + 1) + ')';
        }
        parts.unshift(part);
        node = node.parentElement;
      }
      return parts.join(' > ');
    }
    function restore() {
      if (hovered) { try { hovered.style.outline = prevOutline; } catch (e) {} hovered = null; }
    }
    function cleanup() {
      restore();
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKey, true);
      window.__sundayPickerCleanup = null;
    }
    function onMove(e) {
      var el = e.target;
      if (el === hovered) return;
      restore();
      if (el instanceof Element) {
        hovered = el;
        prevOutline = el.style.outline || '';
        el.style.outline = '2px solid #f5b942';
      }
    }
    function onClick(e) {
      e.preventDefault();
      e.stopPropagation();
      var el = e.target;
      var data = {
        selector: cssPath(el),
        tag: (el.tagName || '').toLowerCase(),
        text: ((el.innerText || el.textContent || '') + '').trim().replace(/\\s+/g, ' ').slice(0, 200),
        url: location.href
      };
      cleanup();
      resolve(data);
    }
    function onKey(e) {
      if (e.key === 'Escape') { cleanup(); resolve(null); }
    }
    window.__sundayPickerCleanup = cleanup;
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
  });
})()`;

function normalizeUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

export function DesignModeSection() {
  const [urlInput, setUrlInput] = useState('');
  const [src, setSrc] = useState<string | null>(null);
  const [currentUrl, setCurrentUrl] = useState('');
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chip, setChip] = useState<DesignChip | null>(() => getDesignChip());
  const webviewRef = useRef<WebviewEl | null>(null);
  const pickTimeout = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (pickTimeout.current != null) window.clearTimeout(pickTimeout.current);
    };
  }, []);

  const load = () => {
    const url = normalizeUrl(urlInput);
    if (!url) {
      setError('Enter a valid http(s) URL (e.g. http://localhost:5173 or https://example.com).');
      return;
    }
    setError(null);
    setSrc(url);
    setCurrentUrl(url);
  };

  const startPick = async () => {
    const wv = webviewRef.current;
    if (!wv || picking) return;
    setError(null);
    setPicking(true);
    pickTimeout.current = window.setTimeout(() => setPicking(false), 120_000);
    try {
      const result = (await wv.executeJavaScript(PICKER_SCRIPT)) as PickResult | null;
      if (result && result.selector) {
        const next: DesignChip = {
          selector: result.selector,
          tag: result.tag || 'element',
          text: result.text ?? '',
          url: result.url || currentUrl,
          pickedAt: Date.now(),
        };
        setDesignChip(next);
        setChip(next);
      }
    } catch (e) {
      setError(
        `Element picking failed on this page: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      if (pickTimeout.current != null) window.clearTimeout(pickTimeout.current);
      pickTimeout.current = null;
      setPicking(false);
    }
  };

  const removeChip = () => {
    clearDesignChip();
    setChip(null);
  };

  const openAgent = () => {
    window.dispatchEvent(new CustomEvent('sunday:show-agent'));
  };

  return (
    <div className="ops-section">
      <h4>5 · Design Mode — pick an element, ask the agent to fix it</h4>
      <div className="ops-note">
        Live preview of your page (dev server or any URL). Enable picking, click an element, and
        Sunday attaches it — selector, tag and text — as context in the Agent panel.
      </div>
      <div className="ops-row">
        <input
          className="ops-input mono"
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') load();
          }}
          placeholder="http://localhost:5173 or https://…"
          aria-label="Preview URL"
        />
        <button className="sunday-btn ops-btn" onClick={load}>
          Load preview
        </button>
      </div>
      {error && <div className="ops-error">{error}</div>}
      {src && (
        <>
          <div className="ops-row design-toolbar">
            <button
              className="sunday-btn ghost ops-btn"
              onClick={() => webviewRef.current?.goBack()}
            >
              ←
            </button>
            <button
              className="sunday-btn ghost ops-btn"
              onClick={() => webviewRef.current?.goForward()}
            >
              →
            </button>
            <button
              className="sunday-btn ghost ops-btn"
              onClick={() => webviewRef.current?.reload()}
            >
              Reload
            </button>
            <span className="dim mono design-current-url" title={currentUrl}>
              {currentUrl}
            </span>
          </div>
          <div className="design-preview-wrap">
            {React.createElement('webview', {
              ref: (el: WebviewEl | null): void => {
                webviewRef.current = el;
                if (el && !el.dataset.sundayNavWired) {
                  el.dataset.sundayNavWired = '1';
                  const onNav = (e: Event) => {
                    const url = (e as unknown as { url?: string }).url;
                    if (url) setCurrentUrl(url);
                  };
                  el.addEventListener('did-navigate', onNav);
                  el.addEventListener('did-navigate-in-page', onNav);
                }
              },
              src,
              // Guest page: no preload, no node, sandboxed — display only.
              webpreferences: 'contextIsolation=yes, nodeIntegration=no, sandbox=yes',
              className: 'design-preview',
              style: { width: '100%', height: '340px', background: '#fff' },
            })}
          </div>
          <div className="ops-row">
            <button
              className="sunday-btn ops-btn"
              disabled={picking}
              onClick={() => void startPick()}
            >
              {picking ? 'Click an element in the preview… (Esc cancels)' : '🎯 Pick element'}
            </button>
            {chip && (
              <button className="sunday-btn ghost ops-btn" onClick={removeChip}>
                Clear picked element
              </button>
            )}
          </div>
          {chip && (
            <div className="ops-result">
              <div>
                Picked <span className="mono">&lt;{chip.tag}&gt;</span>{' '}
                <span className="mono">{chip.selector}</span>
              </div>
              {chip.text && <div className="dim">“{chip.text}”</div>}
              <div className="dim">
                Attached as a context chip in the Agent panel — describe the fix there and send.
              </div>
              <button className="sunday-btn ops-btn" onClick={openAgent}>
                Open Agent panel
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
