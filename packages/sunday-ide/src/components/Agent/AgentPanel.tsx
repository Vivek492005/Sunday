/**
 * Sunday Agent panel — chat UI for the Sunday agent (Wave 2).
 *
 * Header (☀️ title, model picker, clear history, usage pill), 4 mode pills
 * (Auto / Architect / Implementer / Reviewer), message list with safe
 * markdown, pre-run request estimate chip, burn meter, budget-pause continue
 * UI, session persistence via agentService history helpers.
 *
 * Renders standalone: `<AgentPanel />`. When the Electron bridge is absent
 * (plain browser dev), usage/estimate/send degrade gracefully.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  agentService,
  AGENT_MODES,
  AGENT_MODELS,
  loadHistory,
  saveHistory,
  clearHistory,
} from '../../services/agentService';
import type {
  AgentEstimate,
  AgentMessage,
  AgentMode,
  AgentUsage,
  ContextUsage,
} from '../../services/agentService';
import { Markdown } from './markdown';
import './agent.css';

const SUGGESTIONS = [
  'Explain the selected file',
  'Write a unit test for this module',
  'Review my recent changes',
];

const ESTIMATE_DEBOUNCE_MS = 600;

export function AgentPanel() {
  const [messages, setMessages] = useState<AgentMessage[]>(() => loadHistory());
  const [mode, setMode] = useState<AgentMode>('auto');
  const [model, setModel] = useState<string>(AGENT_MODELS[0].id);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [estimate, setEstimate] = useState<AgentEstimate | null>(null);
  const [usage, setUsage] = useState<AgentUsage | null>(null);
  const [budgetPaused, setBudgetPaused] = useState(false);
  const [ctxUsage, setCtxUsage] = useState<ContextUsage | null>(null);

  const listRef = useRef<HTMLDivElement>(null);
  const lastUserMessage = useRef<string>('');

  /* ---------------- usage (burn meter) + F4 context meter ---------------- */

  const refreshUsage = useCallback(async () => {
    try {
      setUsage(await agentService.usage());
    } catch {
      setUsage(null); // bridge unavailable — hide the meter
    }
    try {
      setCtxUsage(await agentService.contextMeter());
    } catch {
      setCtxUsage(null);
    }
  }, []);

  useEffect(() => {
    void refreshUsage();
  }, [refreshUsage]);

  /* ---------------- pre-run estimate (debounced) ---------------- */

  useEffect(() => {
    const query = input.trim();
    if (!query) {
      setEstimate(null);
      return;
    }
    const timer = window.setTimeout(() => {
      agentService
        .estimate(query)
        .then((e) => setEstimate(e))
        .catch(() => setEstimate(null));
    }, ESTIMATE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [input]);

  /* ---------------- auto-scroll ---------------- */

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, sending]);

  /* ---------------- send ---------------- */

  const doSend = useCallback(
    async (text: string) => {
      const message = text.trim();
      if (!message || sending) return;
      setSending(true);
      setBudgetPaused(false);
      lastUserMessage.current = message;

      const userMsg: AgentMessage = { role: 'user', content: message };
      const withUser = [...messages, userMsg];
      setMessages(withUser);
      setInput('');
      setEstimate(null);

      try {
        const reply = await agentService.send({
          message,
          mode,
          model,
          history: withUser,
        });
        const assistantMsg: AgentMessage = { role: 'assistant', content: reply.content };
        const next = [...withUser, assistantMsg];
        setMessages(next);
        saveHistory(next);
        if (reply.budgetPaused) setBudgetPaused(true);
      } catch (err) {
        const failed: AgentMessage = {
          role: 'assistant',
          content: `⚠️ Request failed: ${err instanceof Error ? err.message : String(err)}`,
        };
        setMessages([...withUser, failed]);
      } finally {
        setSending(false);
        void refreshUsage();
      }
    },
    [messages, mode, model, sending, refreshUsage],
  );

  const handleSendClick = () => {
    void doSend(input);
  };

  /** "Hard budget hit — Continue +10": re-sends the last prompt. */
  const handleContinue = () => {
    if (sending) return;
    void doSend(lastUserMessage.current || 'continue');
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void doSend(input);
    }
  };

  const handleClear = () => {
    clearHistory();
    setMessages([]);
    setBudgetPaused(false);
  };

  /* ---------------- render ---------------- */

  const usagePct = usage && usage.limit > 0 ? Math.min(100, (usage.used / usage.limit) * 100) : 0;
  const burnHot = usagePct >= 85;

  return (
    <div className="sunday-agent-panel">
      {/* header */}
      <div className="sunday-agent-header">
        <span className="sunday-agent-title">
          <span className="sunday-agent-sun" aria-hidden="true">
            ☀️
          </span>
          Sunday Agent
        </span>
        <select
          className="sunday-agent-model"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          title="Model"
          aria-label="Model"
        >
          {AGENT_MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="sunday-agent-clear"
          onClick={handleClear}
          title="Clear chat history"
        >
          Clear
        </button>
      </div>

      {/* mode pills */}
      <div className="sunday-agent-modes" role="group" aria-label="Agent mode">
        {AGENT_MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            className={`sunday-agent-mode${mode === m.id ? ' active' : ''}`}
            title={m.hint}
            aria-pressed={mode === m.id}
            onClick={() => setMode(m.id)}
          >
            {m.label}
          </button>
        ))}
      </div>

      {/* burn meter (F1) */}
      {usage && (
        <div className="sunday-agent-burn">
          <span className="sunday-agent-usage-pill">
            {usage.used}/{usage.limit} · resets {usage.resetAt}
          </span>
          <div className="sunday-agent-burn-bar" title={`${Math.round(usagePct)}% of quota used`}>
            <div
              className={`sunday-agent-burn-fill${burnHot ? ' hot' : ''}`}
              style={{ width: `${usagePct}%` }}
            />
          </div>
        </div>
      )}

      {/* context meter (F4) */}
      {ctxUsage && ctxUsage.limit > 0 && (
        <div className="sunday-agent-ctx" title={Object.entries(ctxUsage.breakdown).map(([k, v]) => `${k}: ${v}`).join(', ')}>
          <span className="sunday-agent-ctx-pill">
            ctx {Math.round(ctxUsage.percent)}% · 📌 {ctxUsage.pinnedCount}
          </span>
          <div className="sunday-agent-burn-bar">
            <div
              className="sunday-agent-burn-fill ctx"
              style={{ width: `${Math.min(100, ctxUsage.percent)}%` }}
            />
          </div>
        </div>
      )}

      {/* messages */}
      <div className="sunday-agent-messages" ref={listRef}>
        {messages.length === 0 && !sending && (
          <div className="sunday-agent-empty">
            <span className="sunday-agent-empty-sun" aria-hidden="true">
              ☀️
            </span>
            <div className="sunday-agent-empty-title">Ask Sunday anything…</div>
            <div className="sunday-agent-suggestions">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  className="sunday-agent-suggestion"
                  onClick={() => setInput(s)}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} className={`sunday-agent-msg ${m.role}`}>
            <div className="sunday-agent-bubble">
              {m.role === 'user' ? m.content : <Markdown source={m.content} />}
            </div>
          </div>
        ))}

        {sending && (
          <div className="sunday-agent-msg assistant">
            <div className="sunday-agent-bubble sunday-agent-shimmer" aria-label="Thinking">
              <span />
              <span />
              <span />
            </div>
          </div>
        )}

        {budgetPaused && !sending && (
          <div className="sunday-agent-budget">
            <span>Hard budget hit — the agent paused before continuing.</span>
            <button
              type="button"
              className="sunday-agent-budget-continue"
              onClick={handleContinue}
            >
              Continue +10
            </button>
          </div>
        )}
      </div>

      {/* input */}
      <div className="sunday-agent-input-area">
        {estimate && (
          <span className="sunday-agent-estimate" title={estimate.rationale}>
            ~{estimate.min}–{estimate.max} requests · {estimate.confidence} confidence
          </span>
        )}
        <div className="sunday-agent-input-row">
          <textarea
            className="sunday-agent-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask Sunday anything…"
            rows={1}
            aria-label="Message Sunday Agent"
          />
          <button
            type="button"
            className="sunday-agent-send"
            onClick={handleSendClick}
            disabled={sending || !input.trim()}
            title="Send (Enter)"
            aria-label="Send"
          >
            ➤
          </button>
        </div>
        <div className="sunday-agent-hint">Enter to send · Shift+Enter for a new line</div>
      </div>
    </div>
  );
}
