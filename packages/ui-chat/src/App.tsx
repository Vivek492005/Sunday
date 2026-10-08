import { useEffect, useReducer, useRef, useState } from 'react';
import {
  applyEvent,
  applyModelsList,
  applyTurnState,
  createInitialState,
  queueUserMessage,
  selectModel,
  type ChatState,
  type InboundMessage,
  type ModelView,
  type ChatEventNotificationWire,
} from './chatClient.js';
import type { ImageWire } from './images.js';
import { postToExtension } from './vscode.js';
import { MessageList } from './MessageList.js';
import { Composer } from './Composer.js';
import { ModelPill } from './ModelPill.js';
import { StopButton } from './StopButton.js';
import {
  VOICE_CONFIG_DEFAULTS,
  isSpeechSynthesisSupported,
  speakText,
  stopSpeaking,
  type VoiceConfig,
} from './voice.js';

type Action =
  | { kind: 'event'; notif: ChatEventNotificationWire }
  | { kind: 'models'; models: ModelView[] }
  | { kind: 'select-model'; id: string }
  | { kind: 'turn-state'; activeTurn: string | null }
  | { kind: 'send'; text: string };

function reducer(state: ChatState, action: Action): ChatState {
  switch (action.kind) {
    case 'event':
      return applyEvent(state, action.notif);
    case 'models':
      return applyModelsList(state, action.models);
    case 'select-model':
      return selectModel(state, action.id);
    case 'turn-state':
      return applyTurnState(state, action.activeTurn);
    case 'send':
      return queueUserMessage(state, action.text);
  }
}

export function App(): JSX.Element {
  const [state, dispatch] = useReducer(reducer, createInitialState());
  const [voiceConfig, setVoiceConfig] = useState<VoiceConfig>(VOICE_CONFIG_DEFAULTS);
  const [ttsMuted, setTtsMuted] = useState(false);
  const voiceRef = useRef(voiceConfig);
  voiceRef.current = voiceConfig;
  const ttsMutedRef = useRef(ttsMuted);
  ttsMutedRef.current = ttsMuted;
  /** Accumulates the in-flight assistant text so turn-end can speak it. */
  const turnTextRef = useRef('');

  useEffect(() => {
    const onMessage = (e: MessageEvent): void => {
      const m = e.data as InboundMessage | undefined;
      if (!m || typeof m.type !== 'string') return;
      switch (m.type) {
        case 'sunday/chat/event': {
          const ev: { type: string; delta?: string } = m.event as { type: string; delta?: string };
          if (ev.type === 'text-delta' && typeof ev.delta === 'string') {
            turnTextRef.current += ev.delta;
            // A new turn's speech cancels any in-progress TTS of the old one.
            if (voiceRef.current.outputEnabled) stopSpeaking();
          }
          if (ev.type === 'turn-end') {
            dispatch({ kind: 'event', notif: m });
            // Speak the final assistant text when voice output is on.
            if (voiceRef.current.outputEnabled && !ttsMutedRef.current && turnTextRef.current.trim()) {
              speakText(turnTextRef.current);
            }
            turnTextRef.current = '';
            break;
          }
          if (ev.type === 'turn-error') {
            turnTextRef.current = '';
          }
          dispatch({ kind: 'event', notif: m });
          break;
        }
        case 'sunday/models/list':
          dispatch({ kind: 'models', models: Array.isArray(m.models) ? m.models : [] });
          break;
        case 'sunday/chat/state':
          dispatch({ kind: 'turn-state', activeTurn: m.activeTurn });
          break;
        case 'sunday/voice/config':
          setVoiceConfig({
            inputEnabled: !!m.inputEnabled,
            outputEnabled: !!m.outputEnabled,
            language: typeof m.language === 'string' && m.language ? m.language : 'en-US',
          });
          break;
      }
    };
    window.addEventListener('message', onMessage);
    postToExtension({ type: 'sunday/models/get' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const busy = state.activeTurnId !== undefined;
  const ttsAvailable = voiceConfig.outputEnabled && isSpeechSynthesisSupported();

  const send = (text: string, images: ImageWire[]): void => {
    const displayText =
      images.length > 0
        ? [text, ...images.map((i) => `🖼️ attached image: ${i.name ?? 'pasted image'}`)]
            .filter(Boolean)
            .join('\n')
        : text;
    dispatch({ kind: 'send', text: displayText });
    postToExtension({ type: 'sunday/chat/send', text, model: state.selectedModel, images });
  };

  return (
    <div className="chat-root">
      <header className="chat-header">
        <span className="chat-title">Sunday</span>
        <ModelPill
          models={state.models}
          selected={state.selectedModel}
          onSelect={(id) => dispatch({ kind: 'select-model', id })}
        />
        {ttsAvailable && (
          <button
            type="button"
            className="tts-toggle"
            aria-pressed={!ttsMuted}
            aria-label={ttsMuted ? 'Unmute spoken responses' : 'Mute spoken responses'}
            title="Toggle spoken responses (on-device speech synthesis)"
            onClick={() => {
              setTtsMuted((prev) => {
                if (!prev) stopSpeaking();
                return !prev;
              });
            }}
          >
            {ttsMuted ? '🔇' : '🔊'}
          </button>
        )}
      </header>
      {state.error && <div className="conn-error" role="alert">{state.error}</div>}
      <MessageList messages={state.messages} />
      <div className="composer-row">
        <Composer
          onSend={send}
          disabled={false}
          voiceInputEnabled={voiceConfig.inputEnabled}
          voiceLanguage={voiceConfig.language}
        />
        <StopButton visible={busy} onStop={() => postToExtension({ type: 'sunday/chat/cancel' })} />
      </div>
    </div>
  );
}
