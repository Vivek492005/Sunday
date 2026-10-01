import { useEffect, useReducer } from 'react';
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
import { postToExtension } from './vscode.js';
import { MessageList } from './MessageList.js';
import { Composer } from './Composer.js';
import { ModelPill } from './ModelPill.js';
import { StopButton } from './StopButton.js';

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

  useEffect(() => {
    const onMessage = (e: MessageEvent): void => {
      const m = e.data as InboundMessage | undefined;
      if (!m || typeof m.type !== 'string') return;
      switch (m.type) {
        case 'sunday/chat/event':
          dispatch({ kind: 'event', notif: m });
          break;
        case 'sunday/models/list':
          dispatch({ kind: 'models', models: Array.isArray(m.models) ? m.models : [] });
          break;
        case 'sunday/chat/state':
          dispatch({ kind: 'turn-state', activeTurn: m.activeTurn });
          break;
      }
    };
    window.addEventListener('message', onMessage);
    postToExtension({ type: 'sunday/models/get' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const busy = state.activeTurnId !== undefined;

  const send = (text: string): void => {
    dispatch({ kind: 'send', text });
    postToExtension({ type: 'sunday/chat/send', text, model: state.selectedModel });
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
      </header>
      {state.error && <div className="conn-error">{state.error}</div>}
      <MessageList messages={state.messages} />
      <div className="composer-row">
        <Composer onSend={send} disabled={false} />
        <StopButton visible={busy} onStop={() => postToExtension({ type: 'sunday/chat/cancel' })} />
      </div>
    </div>
  );
}
