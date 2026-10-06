# Feature Completion Criteria

Falsifiable definitions of "done" for every non-stable item.
No vibes — each has checkable gates.

## JetBrains Plugin → STABLE when:

- [ ] Chat tool window works end-to-end against real `sundayd` protocol
- [ ] Diff review renders correctly for agent-proposed changes
- [ ] Approval flow (approve/reject) works for tool calls
- [ ] 19 JUnit tests pass (already green)
- [ ] +5 new integration tests against real daemon (not mocked)
- [ ] Works on both IntelliJ IDEA and PyCharm (manual verification)

**Status**: IN PROGRESS (19 tests green, integration tests pending)

## Sunday IDE Fork → STABLE when:

- [ ] CI green on Windows, Linux, macOS (already green: run 37340699360)
- [ ] Branded installer installs and launches on all 3 OSes
- [ ] sunday-agent extension loads in the fork
- [ ] No upstream VS Code functionality broken (smoke test)

**Status**: IN PROGRESS (CI green, installers on release)

## Local Model Support → SHIPPED when:

- [ ] Ollama-backed autocomplete works (minimal slice)
- [ ] Config flag `sunday.localModel.enabled` exists
- [ ] Falls back to API providers when Ollama unavailable
- [ ] Documented in PROVIDER_SETUP.md

**Status**: NOT STARTED (roadmap)

## Sequencing decision

Per Path-to-10 §6: **ONE frontend at a time.**

**Active**: Sunday IDE fork (closest to stable — CI green, assets shipped)
**Paused**: JetBrains plugin (resume when IDE fork hits STABLE above)

Resume condition for JetBrains: IDE fork marked STABLE + user confirms.
