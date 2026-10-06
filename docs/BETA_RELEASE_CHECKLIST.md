# 1.0-beta Release Checklist

**Target version:** `1.0-beta` (from `0.1.0`)
**Status:** SHIPPED — 1.0.0-beta.1 released 2026-10-06.
**Last updated:** 2026-10-06

This checklist is the single source of truth for cutting the 1.0-beta
release. Work through it top to bottom. Nothing ships until every
checkbox is ticked.

---

## 1. Gate status (must all be Green)

| # | Gate | Current | Required before beta |
|---|---|---|---|
| 1 | Build | Partial (CI in progress) | 3-platform `sunday-ide` CI green on the release commit |
| 2 | Tests | Partial | `windows-package` CI green incl. Electron smoke step |
| 3 | Eval | Partial | Live-model baseline recorded (`docs/eval-baseline-<date>.md`) |
| 4 | Relay | Partial | `windows-package` CI green with `relay-matrix-report.txt` artifact |
| 5 | Security | Partial | Advisory-scan green on CI, then flip to blocking |
| 6 | Privacy | Partial | Human packet-capture per `docs/PRIVACY_PCAP.md` |
| 7 | Performance | Partial | Stock VS Code baseline + 1h soak on release machine |
| 8 | Accessibility | Partial | Human NVDA/VoiceOver pass (checklist in `docs/ACCESSIBILITY.md`) |
| 9 | Docs | Green | — |
| 10 | Legal | Green (doc stale, see §5) | Fix stale text in `docs/RELEASE_GATES.md` |
| 11 | Upgrade | Partial | Blocked on upstream (no newer tag) — acceptable for beta |

**Human-required steps (cannot be automated):** #6 pcap, #8 screen reader,
#3 live-model baseline (needs provider keys), #7 soak/baseline on Windows,
Appendix A.6 manual QA ritual.

---

## 2. Version bump plan (0.1.0 → 1.0-beta)

**Do NOT bump yet** — execute only when §1 is fully green.

15 packages at `0.1.0` → `1.0.0-beta.1` (semver prerelease):
- `packages/browserd`, `context`, `eval`, `ext-agent`, `gateway`,
  `hosted-gateway`, `mcp`, `orchestrator`, `protocol`, `skills`,
  `sunday-cli`, `sundayd`, `tools`, `ui-chat`, `ui-manager`

Root `package.json` is `0.0.1` (workspace root, not published) — leave it.

Steps:
1. `for p in packages/*/package.json` → set `"version": "1.0.0-beta.1"`
2. `pnpm install --lockfile-only` (regenerates `pnpm-lock.yaml`)
3. Update `CHANGELOG.md` with the 1.0-beta entry (draft in
   `docs/RELEASE_NOTES_1.0-BETA.md`)
4. Update `docs/PROGRESS.json` via `scripts/update-progress.py`
5. Commit: `Release: bump to 1.0.0-beta.1`
6. Tag: `v1.0.0-beta.1` (triggers `windows-package.yml` → VSIX + installer)
7. Tag: `ide-v1.0.0-beta.1` (triggers `sunday-ide.yml` → full IDE installers)

**Why `1.0.0-beta.1` and not `1.0-beta`:** semver prerelease syntax
(`1.0.0-beta.1`) sorts correctly in npm/pnpm/VS Code marketplace tooling;
bare `1.0-beta` does not.

---

## 3. Pre-release verification steps

Run in order on the release commit:

- [ ] `pnpm install --frozen-lockfile` clean on Linux (this VM)
- [ ] `pnpm -r --workspace-concurrency=1 build` clean
- [ ] `pnpm -r test` — all suites green (target: 900+ tests)
- [ ] `node scripts/smoke/src/run.mjs` — Electron smoke (needs display/CI)
- [ ] `pnpm --filter @sunday/eval eval:live-baseline` — with provider keys
- [ ] `node scripts/soak-test.mjs --duration=1h` — on release machine
- [ ] `node scripts/privacy-pcap.mjs` — 0 violations
- [ ] Secret-scan clean: `git grep` with the CI pattern returns nothing
      outside the 4 excluded test fixtures
- [ ] `git status` clean, `git log` shows the version-bump commit on top

---

## 4. Release artifacts

| Artifact | Produced by | Verify |
|---|---|---|
| `sunday-agent-1.0.0-beta.1.vsix` | `windows-package.yml` on `v1.0.0-beta.1` | Installs in stock VS Code 1.140.0, smoke checks pass |
| `Sunday-Agent-Setup-1.0.0-beta.1.exe` | `windows-package.yml` (NSIS) | Installs on Windows, sidecars bundled |
| Full IDE installers (win/linux/mac) | `sunday-ide.yml` on `ide-v1.0.0-beta.1` | Launch, extension built-in, chat works |
| `docs/sbom.json` | `scripts/gen-sbom.mjs` | Regenerate at release commit |
| GitHub Release notes | `docs/RELEASE_NOTES_1.0-BETA.md` | Copy into the release body |

---

## 5. Known limitations (ship with beta, document honestly)

1. **Installers are unsigned** (`TODO(signing)`). Windows SmartScreen and
   macOS Gatekeeper will warn. Documented in `docs/PACKAGING.md`.
2. **Advisory scanning is report-only** (`TODO(security-gate)`). Flip to
   blocking after one green CI run.
3. **Ollama is roadmap, not implemented.** `docs/PROVIDER_SETUP.md` says
   so; the D2 localhost-model privacy check is aspirational until then.
4. **Next-edit suggestions are heuristic** (rename propagation), not an
   LLM re-ranker. Behind `sunday.nextEdit.enabled` (default off).
5. **Voice I/O needs a Chromium host** (Web Speech API) and is off by
   default. No audio leaves the machine.
6. **Hosted gateway is text-chat only** — no remote tool/shell/file
   execution by design.
7. **Upgrade rehearsal wall-clock unmeasured** — blocked on upstream
   cutting a tag newer than 1.140.0. Divergence is zero; re-vendor
   should be mechanical.
8. **A.6 manual QA ritual never recorded end-to-end.** Automated coverage
   exists; the human walkthrough is still owed.

---

## 6. Post-release

- [ ] Verify both GitHub Releases are public with all assets attached
- [ ] Verify VSIX installs from the release page (not just CI artifacts)
- [ ] Update `docs/PROGRESS.json` (release phase → done)
- [ ] Announce in feed (if the user wants it)
- [ ] Open issues for: code signing, advisory-scan blocking flip,
      Ollama support, next-edit LLM re-ranker, JetBrains plugin
