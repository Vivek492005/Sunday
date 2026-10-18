/**
 * Sunday Run & Debug — Wave 3 minimal scope: breakpoints + launch + stop.
 *
 * Launch a Node program from the open folder, stream its output into the
 * debug console, stop it on demand. Breakpoints are toggled by clicking the
 * editor gutter and listed here.
 *
 * Full DAP (step over/into, variables, call stack via vscode-debugprotocol
 * + a debug adapter) is an explicit follow-up.
 */
import React, { useEffect, useRef, useState } from 'react';
import { useIde } from '../../state/ideStore';
import {
  debugService,
  getAllBreakpoints,
  clearBreakpoints,
  onBreakpointsChanged,
  type DebugOutput,
} from '../../services/debugService';
import './debug.css';

const CONFIG_KEY = 'sunday.debug.config.v1';

interface DebugConfig {
  program: string;
  args: string;
}

function loadConfig(): DebugConfig {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<DebugConfig>;
      return { program: parsed.program ?? '', args: parsed.args ?? '' };
    }
  } catch {
    // corrupted — defaults
  }
  return { program: '', args: '' };
}

export function Debug() {
  const { state, dispatch } = useIde();
  const [config, setConfig] = useState<DebugConfig>(loadConfig);
  const [running, setRunning] = useState(false);
  const [output, setOutput] = useState<DebugOutput[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [breakpoints, setBreakpoints] = useState(getAllBreakpoints());
  const consoleRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setBreakpoints(getAllBreakpoints());
    return onBreakpointsChanged(() => setBreakpoints(getAllBreakpoints()));
  }, []);

  useEffect(() => {
    const offOut = debugService.onOutput((info) => {
      setOutput((prev) => [...prev.slice(-500), info]);
    });
    const offExit = debugService.onExit((info) => {
      setRunning(false);
      setOutput((prev) => [
        ...prev.slice(-500),
        {
          stream: 'stdout',
          text: `\n— process exited with code ${info.exitCode}${info.error ? ` (${info.error})` : ''} —\n`,
        },
      ]);
    });
    return () => {
      offOut();
      offExit();
    };
  }, []);

  // auto-scroll the console
  useEffect(() => {
    const el = consoleRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [output]);

  const saveConfig = (next: DebugConfig) => {
    setConfig(next);
    try {
      localStorage.setItem(CONFIG_KEY, JSON.stringify(next));
    } catch {
      // non-fatal
    }
  };

  const launch = async () => {
    if (running || !config.program.trim()) return;
    setError(null);
    const program = config.program.trim();
    const args = config.args.trim() ? config.args.trim().split(/\s+/) : [];
    setOutput([{ stream: 'stdout', text: `— launching: node ${program} ${args.join(' ')}\n` }]);
    try {
      const r = await debugService.launch(state.rootFolder ?? '', program, args);
      if (!r.ok) {
        setError(r.error ?? 'Launch failed');
        setRunning(false);
      } else {
        setRunning(true);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Launch failed');
      setRunning(false);
    }
  };

  const stop = () => {
    void debugService.stop().catch(() => undefined);
    setRunning(false);
  };

  const openAt = (filePath: string, line: number) => {
    dispatch({ type: 'OPEN_FILE', path: filePath });
    // let the editor open first, then reveal the line
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('sunday:reveal-line', { detail: { filePath, line } }));
    }, 150);
  };

  return (
    <div className="sunday-debug-root">
      <div className="sunday-sidebar-header">
        <span className="title">RUN & DEBUG</span>
      </div>

      <div className="sunday-debug-body">
        <div className="sunday-debug-section">
          <div className="sunday-debug-section-title">LAUNCH</div>
          <label className="sunday-debug-label">
            Program
            <input
              className="sunday-input sunday-debug-input"
              placeholder="e.g. server.js or ./dist/app.js"
              value={config.program}
              spellCheck={false}
              onChange={(e) => saveConfig({ ...config, program: e.target.value })}
            />
          </label>
          <label className="sunday-debug-label">
            Arguments
            <input
              className="sunday-input sunday-debug-input"
              placeholder="--port 3000"
              value={config.args}
              spellCheck={false}
              onChange={(e) => saveConfig({ ...config, args: e.target.value })}
            />
          </label>
          <div className="sunday-debug-runrow">
            {!running ? (
              <button className="sunday-btn sunday-debug-run" disabled={!config.program.trim()} onClick={() => void launch()}>
                ▶ Launch
              </button>
            ) : (
              <button className="sunday-btn ghost sunday-debug-run" onClick={stop}>
                ■ Stop
              </button>
            )}
            <span className={`sunday-debug-status${running ? ' on' : ''}`}>
              {running ? 'Running…' : 'Idle'}
            </span>
          </div>
          {error && <div className="sunday-debug-error">{error}</div>}
        </div>

        <div className="sunday-debug-section">
          <div className="sunday-debug-section-title">
            BREAKPOINTS · {breakpoints.reduce((n, b) => n + b.lines.length, 0)}
            <button className="sunday-sc-link" onClick={() => clearBreakpoints()}>
              Clear all
            </button>
          </div>
          {breakpoints.length === 0 && (
            <div className="sunday-debug-hint">Click the editor gutter to add a breakpoint.</div>
          )}
          {breakpoints.map((b) => (
            <div key={b.filePath} className="sunday-debug-bpfile">
              <div className="sunday-debug-bpfile-name" title={b.filePath}>
                {b.filePath.split('/').pop()}
              </div>
              {b.lines.map((line) => (
                <button key={line} className="sunday-debug-bpline" onClick={() => openAt(b.filePath, line)}>
                  <span className="bp-dot" />
                  Line {line}
                </button>
              ))}
            </div>
          ))}
        </div>

        <div className="sunday-debug-section sunday-debug-console-section">
          <div className="sunday-debug-section-title">
            DEBUG CONSOLE
            <button className="sunday-sc-link" onClick={() => setOutput([])}>
              Clear
            </button>
          </div>
          <div className="sunday-debug-console" ref={consoleRef}>
            {output.length === 0 && <span className="sunday-debug-hint">Program output appears here.</span>}
            {output.map((o, i) => (
              <span key={i} className={o.stream === 'stderr' ? 'dbg-err' : 'dbg-out'}>
                {o.text}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
