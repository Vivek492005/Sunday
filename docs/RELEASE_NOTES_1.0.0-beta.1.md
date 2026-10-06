# SUNDAY 1.0.0-beta.1 Release Notes

## 🎉 First Public Beta

SUNDAY is an autonomous coding-agent IDE — a full VS Code fork with a built-in AI agent.

## What's Included

### Core Features
- **AI Agent** — Autonomous coding agent with parallel execution
- **Editor Intelligence** — FIM autocomplete, inline editing, code actions
- **MCP Support** — Model Context Protocol integration
- **Browser Agent** — Automated browser control with visual feedback
- **Skills & Memory** — Persistent skills, rules, and memory system

### Platforms
- **Windows** (x64) — Full installer
- **Linux** (x64) — Portable build
- **macOS** (ARM64) — DMG installer

## Installation

### Windows
Download `Sunday-Setup-1.0.0-beta.1.exe` and run the installer.

### Linux
Download the Linux build, extract, and run.

### macOS
Download the `.dmg` file and drag to Applications.

## Configuration

Set your API keys as environment variables:
- `OPENROUTER_API_KEY` — For OpenRouter models
- `GROQ_API_KEY` — For Groq models

## Known Limitations (Beta)

- This is a beta release — expect bugs
- Windows named-pipe tests are skipped (Unix socket semantics don't apply)
- Browser agent requires opt-in (`sunday.browser.enabled`)
- Screen reader testing pending (accessibility)

## What's Next

- Stable 1.0.0 release
- Daemon Stage 4 reimplementation
- JetBrains plugin release

## License

Apache-2.0 — See LICENSE file.
