# Local Model Support — Minimal Slice Plan (Ollama autocomplete)

**Status:** NOT STARTED — design only, no code yet.
**Goal:** Restore the original differentiator (rate-limit survival) with the
smallest shippable slice: Ollama-backed **autocomplete only**, before any
full agent-loop local support.
**Target:** one focused PR, no new packages.

## Why autocomplete first

- Autocomplete is the highest-frequency, lowest-stakes model call — the exact
  workload where provider rate limits hurt most.
- The seam already exists: `CompletionOrchestrator` takes a single-shot
  `complete: (req: FimRequest) => Promise<FimResult>` (see
  `packages/sundayd/src/completion.ts`). Swapping the backing provider needs
  no orchestrator changes.
- Ollama speaks an OpenAI-compatible API, so it reuses the existing
  `OpenAICompatibleProvider` base class — no new HTTP client code.

## Non-goals for this slice

- No local chat/agent-loop support (that's a later slice).
- No model downloading/management UI (user runs `ollama pull` themselves).
- No GPU detection or performance tuning.

## Changes

### 1. `packages/gateway/src/providers.ts` (or new `ollama.ts`)

Add `OllamaProvider extends OpenAICompatibleProvider`:

- Base URL: `process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434'`
- No API key required (override `requireApiKey()` to no-op).
- Default model: `ollama:qwen2.5-coder:1.5b` (small, fast, good enough for FIM).
- Health check: `GET /api/tags` with a 2s timeout → `isAvailable()`.

### 2. Provider registration — `packages/sundayd/src/daemon.ts`

`createDefaultProviders()` (daemon.ts:222) gains the Ollama provider under id
`ollama`, alongside `openrouter`/`groq`. Registration is unconditional;
*selection* is gated by config (below), so a missing Ollama install changes
nothing for existing users.

### 3. Config flag — `sunday.localModel.enabled`

- Declare in `packages/ext-agent/package.json` under
  `contributes.configuration` (default `false`), following the existing
  `sunday.browser.enabled` precedent.
- The extension reads it via `vscode.workspace.getConfiguration('sunday')`
  (see `extension.ts:98`) and forwards it to `sundayd` at spawn — same
  mechanism as `browser.enabled` (env var or spawn arg; match whichever that
  precedent uses).

### 4. Fallback logic — `getCompletionOrchestrator()` (daemon.ts:536)

In the `complete` closure:

```
if (localModelEnabled) {
  try {
    return await ollama.complete(req);   // 3s timeout
  } catch {
    // fall through to provider chain
  }
}
return existingProviderChain(req);
```

Rules:
- Ollama failure (not installed, no model pulled, timeout) is **silent** —
  it falls back to the API provider chain with no user-visible error.
- A metric line (`sunday.completion.provider=ollama|api`) is emitted so the
  fallback rate is observable, reusing the existing metric sink.
- The LRU cache in `CompletionOrchestrator` is provider-agnostic and needs
  no changes; optionally namespace cache keys by provider id.

### 5. Docs — `docs/PROVIDER_SETUP.md`

New section: installing Ollama, `ollama pull qwen2.5-coder:1.5b`, enabling
`sunday.localModel.enabled`, and what happens when Ollama isn't running
(silent fallback).

## Tests

- `ollama.test.ts` (gateway): provider builds correct URL, no API key
  required, `isAvailable()` false on connection refused (mocked fetch).
- `completion-fallback.test.ts` (sundayd): orchestrator falls back to API
  provider when Ollama throws; uses Ollama result when it succeeds.
- Existing `completion.test.ts` p50 gate must stay green.

## Acceptance gate (moves Local Model → SHIPPED in FEATURE_COMPLETION.md)

- [ ] `sunday.localModel.enabled=true` + `ollama run qwen2.5-coder:1.5b`
      → ghost-text completions appear with no API keys set
- [ ] Killing Ollama mid-session → completions silently fall back to API
      providers (no user-visible error)
- [ ] Flag off (default) → zero behavior change, all existing tests green
- [ ] `docs/PROVIDER_SETUP.md` documents the setup

## Follow-up slices (out of scope here)

1. Local chat (agent loop on Ollama) — needs context-window and tool-call
   evals per model.
2. Model management UI (`ollama pull` from the extension).
3. Auto-detect Ollama on first run and suggest enabling.
