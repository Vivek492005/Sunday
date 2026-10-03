# Sunday Voice — Privacy Notes

Voice input/output (`sunday.voice.inputEnabled`, `sunday.voice.outputEnabled`)
is **experimental and off by default**.

## Where your voice data goes

| Feature | Technology | Data flow |
|---|---|---|
| Voice input (mic button) | Browser Web Speech API (`SpeechRecognition` / `webkitSpeechRecognition`) | Audio is processed by **your browser's speech service** (e.g. Chrome's on-device or cloud speech recognizer, per the browser's own privacy policy). **No audio is sent to Sunday servers.** Only the transcribed *text* — which you then explicitly review and send — leaves the webview, exactly as if you had typed it. |
| Voice output (spoken responses) | Browser `speechSynthesis` API | Agent response text is synthesized **on your device**. No audio or text is sent anywhere for TTS. Long responses are truncated/summarized before speaking. |

## What Sunday stores

- Nothing voice-specific. The transcribed text becomes a normal chat prompt
  and follows the same session/message retention as typed prompts
  (`~/.sunday/sessions/`).
- No audio recordings are made or stored by Sunday at any point.

## Requirements & limitations

- Voice input needs Chrome/Edge (the only browsers shipping
  `SpeechRecognition`/`webkitSpeechRecognition`) **and** microphone permission.
  Firefox/Safari show no mic button.
- Voice output needs `speechSynthesis` (all modern browsers).
- When the APIs are unavailable, the UI degrades gracefully: no mic button,
  no TTS toggle, no errors.

## Disabling

Set both settings to `false` (the default) and no speech API is ever touched:
the recognizer is never constructed and `speechSynthesis` is never called.
