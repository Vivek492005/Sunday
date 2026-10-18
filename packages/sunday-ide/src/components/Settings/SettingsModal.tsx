/**
 * Sunday Settings — custom modal, searchable, grouped sections.
 * Persists to ~/.sunday-ide/settings.json via IPC and applies live
 * (Monaco options + CSS theme variables).
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useIde } from '../../state/ideStore';
import { settingsService, DEFAULT_SETTINGS, type SundaySettings } from '../../services/settingsService';
import { CloseIcon, SearchIcon } from '../icons';
import './settings.css';

interface SettingDef {
  key: keyof SundaySettings;
  label: string;
  hint: string;
  section: 'Appearance' | 'Editor' | 'Terminal';
  control: 'theme' | 'number' | 'text' | 'toggle';
  min?: number;
  max?: number;
  step?: number;
}

const SETTINGS_DEFS: SettingDef[] = [
  {
    key: 'theme', label: 'Theme', hint: 'Sunday Dark or Sunday Light',
    section: 'Appearance', control: 'theme',
  },
  {
    key: 'editorFontSize', label: 'Editor font size', hint: 'In pixels',
    section: 'Editor', control: 'number', min: 8, max: 32, step: 0.5,
  },
  {
    key: 'editorFontFamily', label: 'Editor font family', hint: 'CSS font stack',
    section: 'Editor', control: 'text',
  },
  {
    key: 'editorTabSize', label: 'Tab size', hint: 'Spaces per indent level',
    section: 'Editor', control: 'number', min: 1, max: 8, step: 1,
  },
  {
    key: 'editorWordWrap', label: 'Word wrap', hint: 'Wrap long lines in the editor',
    section: 'Editor', control: 'toggle',
  },
  {
    key: 'terminalFontSize', label: 'Terminal font size', hint: 'In pixels',
    section: 'Terminal', control: 'number', min: 8, max: 28, step: 0.5,
  },
];

const SECTIONS = ['Appearance', 'Editor', 'Terminal'] as const;

export function SettingsModal() {
  const { state, dispatch } = useIde();
  const [settings, setSettings] = useState<SundaySettings>({ ...DEFAULT_SETTINGS });
  const [query, setQuery] = useState('');
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!state.settingsOpen) return;
    setLoaded(false);
    setQuery('');
    void settingsService.get().then((s) => {
      setSettings(s);
      setLoaded(true);
    });
  }, [state.settingsOpen]);

  // close on Escape
  useEffect(() => {
    if (!state.settingsOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dispatch({ type: 'SET_SETTINGS_OPEN', open: false });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state.settingsOpen, dispatch]);

  const update = (key: keyof SundaySettings, value: string | number | boolean) => {
    setSettings((prev) => {
      const next = { ...prev, [key]: value };
      void settingsService.set({ [key]: value } as Partial<SundaySettings>);
      return next;
    });
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return SETTINGS_DEFS;
    return SETTINGS_DEFS.filter(
      (d) => d.label.toLowerCase().includes(q) || d.hint.toLowerCase().includes(q) || d.section.toLowerCase().includes(q),
    );
  }, [query]);

  if (!state.settingsOpen) return null;

  const close = () => dispatch({ type: 'SET_SETTINGS_OPEN', open: false });

  return (
    <div className="sunday-modal-backdrop" onClick={close} role="presentation">
      <div
        className="sunday-modal sunday-settings"
        role="dialog"
        aria-label="Sunday settings"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sunday-modal-header">
          <span className="title">SETTINGS</span>
          <button className="sunday-icon-btn" onClick={close} aria-label="Close settings">
            <CloseIcon size={14} />
          </button>
        </div>

        <div className="sunday-settings-search">
          <SearchIcon size={15} />
          <input
            placeholder="Search settings…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search settings"
          />
        </div>

        <div className="sunday-settings-body">
          {!loaded && <div className="sunday-settings-hint">Loading…</div>}
          {loaded && filtered.length === 0 && (
            <div className="sunday-settings-hint">No settings match &lsquo;{query}&rsquo;</div>
          )}
          {SECTIONS.map((section) => {
            const defs = filtered.filter((d) => d.section === section);
            if (defs.length === 0) return null;
            return (
              <div key={section} className="sunday-settings-section">
                <div className="sunday-settings-section-title">{section.toUpperCase()}</div>
                {defs.map((def) => (
                  <div key={def.key} className="sunday-setting-row">
                    <div className="sunday-setting-meta">
                      <div className="sunday-setting-label">{def.label}</div>
                      <div className="sunday-setting-hint">{def.hint}</div>
                    </div>
                    <div className="sunday-setting-control">
                      {def.control === 'theme' && (
                        <div className="sunday-theme-pick">
                          {(['sunday-dark', 'sunday-light'] as const).map((t) => (
                            <button
                              key={t}
                              className={`sunday-theme-card${settings.theme === t ? ' active' : ''}`}
                              data-theme-card={t}
                              onClick={() => update('theme', t)}
                            >
                              <span className="swatch" />
                              {t === 'sunday-dark' ? 'Dark' : 'Light'}
                            </button>
                          ))}
                        </div>
                      )}
                      {def.control === 'number' && (
                        <input
                          type="number"
                          className="sunday-input sunday-input-num"
                          min={def.min}
                          max={def.max}
                          step={def.step}
                          value={Number(settings[def.key])}
                          onChange={(e) => update(def.key, Number(e.target.value))}
                        />
                      )}
                      {def.control === 'text' && (
                        <input
                          type="text"
                          className="sunday-input"
                          value={String(settings[def.key])}
                          onChange={(e) => update(def.key, e.target.value)}
                          spellCheck={false}
                        />
                      )}
                      {def.control === 'toggle' && (
                        <button
                          role="switch"
                          aria-checked={Boolean(settings[def.key])}
                          className={`sunday-toggle${settings[def.key] ? ' on' : ''}`}
                          onClick={() => update(def.key, !settings[def.key])}
                        >
                          <span className="knob" />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
