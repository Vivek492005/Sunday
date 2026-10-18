/**
 * Sunday IDE terminal tab — one xterm.js instance bound to one pty session.
 *
 * Lifecycle:
 *   mount   → xterm opens, ptyService.spawn(id, cwd, cols, rows) starts the shell,
 *              xterm.onData forwards keystrokes to ptyService.write,
 *              subscribePty routes onData/onExit to this tab by id
 *   unmount → ptyService.kill(id), dispose xterm
 *
 * Sizing: FitAddon proposes dimensions; resizes are debounced and forwarded to
 * ptyService.resize. Fitting only happens while the tab is active AND visible —
 * hidden tabs keep their session but never fight for layout.
 */
import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { ptyService, subscribePty } from '../../services/ptyService';

export interface TerminalProps {
  /** pty session id owned by this tab */
  id: string;
  /** working directory the shell starts in */
  cwd: string;
  /** only fit/focus the terminal while its tab is the active one */
  active: boolean;
}

type TermStatus = 'starting' | 'ready' | 'error' | 'exited';

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const RESIZE_DEBOUNCE_MS = 120;

const SUNDAY_MONO =
  "'JetBrains Mono', 'Cascadia Code', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

export function Terminal({ id, cwd, active }: TerminalProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const resizeTimerRef = useRef<number | null>(null);
  const lastDimsRef = useRef<{ cols: number; rows: number } | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;

  const [status, setStatus] = useState<TermStatus>('starting');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);

  /** Forward a resize to the pty, debounced so drag-resizes don't flood IPC. */
  const scheduleResize = (cols: number, rows: number): void => {
    const prev = lastDimsRef.current;
    if (prev && prev.cols === cols && prev.rows === rows) return;
    lastDimsRef.current = { cols, rows };
    if (resizeTimerRef.current !== null) {
      window.clearTimeout(resizeTimerRef.current);
    }
    resizeTimerRef.current = window.setTimeout(() => {
      resizeTimerRef.current = null;
      try {
        void ptyService.resize(id, cols, rows).catch(() => {
          /* pty gone — nothing to resize */
        });
      } catch {
        /* bridge unavailable — nothing to resize */
      }
    }, RESIZE_DEBOUNCE_MS);
  };

  /** Fit xterm to its container and forward the new size. No-op when hidden. */
  const fitAndForward = (): void => {
    const host = hostRef.current;
    const fit = fitRef.current;
    if (!host || !fit) return;
    if (!activeRef.current) return;
    if (host.clientWidth <= 0 || host.clientHeight <= 0) return;
    try {
      fit.fit();
    } catch {
      return;
    }
    let dims: { cols: number; rows: number } | undefined;
    try {
      dims = fit.proposeDimensions() ?? undefined;
    } catch {
      return;
    }
    if (!dims || dims.cols <= 0 || dims.rows <= 0) return;
    scheduleResize(dims.cols, dims.rows);
  };

  /** Dimensions for the first spawn — the tab may be hidden, so fall back safely. */
  const spawnDims = (): { cols: number; rows: number } => {
    const fit = fitRef.current;
    if (fit) {
      try {
        const dims = fit.proposeDimensions();
        if (dims && dims.cols > 0 && dims.rows > 0) {
          return { cols: dims.cols, rows: dims.rows };
        }
      } catch {
        /* not laid out yet — fall through to the default */
      }
    }
    return { cols: DEFAULT_COLS, rows: DEFAULT_ROWS };
  };

  /** (Re)start the shell session. The main process replaces any stale session id. */
  const startSession = (): void => {
    const term = termRef.current;
    if (!term) return;
    setStatus('starting');
    setErrorMsg(null);
    const { cols, rows } = spawnDims();
    try {
      ptyService
        .spawn(id, cwd, cols, rows)
        .then((res) => {
          if (!res.ok) {
            setStatus('error');
            setErrorMsg(res.error ?? 'The terminal process could not be started.');
            return;
          }
          setStatus('ready');
          fitAndForward();
        })
        .catch((err: unknown) => {
          setStatus('error');
          setErrorMsg(err instanceof Error ? err.message : String(err));
        });
    } catch (err: unknown) {
      // bridge() throws synchronously outside Electron
      setStatus('error');
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  // Mount: create xterm, wire pty, spawn the shell. Unmount: kill the session.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new XTerm({
      allowTransparency: false,
      cursorBlink: true,
      cursorStyle: 'bar',
      fontFamily: SUNDAY_MONO,
      fontSize: 12.5,
      lineHeight: 1.3,
      theme: {
        background: '#14100b',
        foreground: '#e8e0d0',
        cursor: '#f5b942',
        cursorAccent: '#14100b',
        selectionBackground: 'rgba(245, 185, 66, 0.28)',
        black: '#14100b',
        red: '#e05c5c',
        green: '#7bc98a',
        yellow: '#f5b942',
        blue: '#7aa5d2',
        magenta: '#c792ea',
        cyan: '#6fc3c3',
        white: '#e8e0d0',
        brightBlack: '#8a7a5c',
        brightRed: '#e05c5c',
        brightGreen: '#7bc98a',
        brightYellow: '#f5b942',
        brightBlue: '#7aa5d2',
        brightMagenta: '#c792ea',
        brightCyan: '#6fc3c3',
        brightWhite: '#fff8e8',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;

    let unsubscribe: (() => void) | null = null;
    try {
      unsubscribe = subscribePty({
        onData: (evtId, data) => {
          if (evtId === id) term.write(data);
        },
        onExit: (evtId, code) => {
          if (evtId === id) {
            setExitCode(code);
            setStatus('exited');
          }
        },
      });
    } catch (err: unknown) {
      setStatus('error');
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }

    const dataDisposable = term.onData((data) => {
      try {
        void ptyService.write(id, data).catch(() => {
          /* session gone — keystrokes have nowhere to go */
        });
      } catch {
        /* bridge unavailable */
      }
    });

    const ro = new ResizeObserver(() => {
      fitAndForward();
    });
    ro.observe(host);

    startSession();

    return () => {
      ro.disconnect();
      if (resizeTimerRef.current !== null) {
        window.clearTimeout(resizeTimerRef.current);
        resizeTimerRef.current = null;
      }
      dataDisposable.dispose();
      unsubscribe?.();
      try {
        void ptyService.kill(id).catch(() => {
          /* already dead */
        });
      } catch {
        /* bridge unavailable */
      }
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // One xterm + one pty session per tab id, for the life of the tab.
  }, []);

  // When this tab becomes the visible active one, fit it to the panel and focus.
  useEffect(() => {
    if (!active) return;
    const t = window.setTimeout(() => {
      const host = hostRef.current;
      if (host && host.clientWidth > 0 && host.clientHeight > 0) {
        fitAndForward();
        termRef.current?.focus();
      }
    }, 0);
    return () => window.clearTimeout(t);
  }, [active]);

  const retry = (): void => {
    setExitCode(null);
    startSession();
  };

  return (
    <div className="sunday-term">
      <div ref={hostRef} className="sunday-term-host" aria-label="Terminal" />
      {status === 'starting' && (
        <div className="sunday-term-overlay" aria-live="polite">
          <span className="sunday-term-spin" aria-hidden="true" />
          <span className="sunday-term-status">Starting shell…</span>
        </div>
      )}
      {(status === 'error' || status === 'exited') && (
        <div className="sunday-term-overlay">
          <div className="sunday-term-msg">
            {status === 'error' ? (
              <>
                <div className="sunday-term-title">Terminal failed to start</div>
                {errorMsg && <div className="sunday-term-detail">{errorMsg}</div>}
              </>
            ) : (
              <>
                <div className="sunday-term-title">
                  Shell exited{exitCode !== null ? ` (code ${exitCode})` : ''}
                </div>
                <div className="sunday-term-detail">
                  Start a new shell to keep working in this tab.
                </div>
              </>
            )}
            <button type="button" className="sunday-btn" onClick={retry}>
              {status === 'error' ? 'Retry' : 'Restart shell'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
