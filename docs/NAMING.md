# Sunday naming (renamed from AURORA, 2026-10-01)

The design doc (`merged_step1.md`) was written when the product was called
AURORA. The final product name is **Sunday**. Mapping for all new work:

| Old (doc) | New |
|---|---|
| `aurora.*` settings/config namespace | `sunday.*` |
| `~/.aurora` data folder | `~/.sunday` |
| `aurorad` sidecar/daemon | `sundayd` |
| `aurora-agent` built-in extension | `sunday-agent` |
| `aurora/main` long-lived branch | `sunday/main` |
| `// AURORA(P-xxx)` patch markers | `// SUNDAY(P-xxx)` |
| `.aurora/` workspace dir | `.sunday/` |
| `aurora-worktrees/` | `.sunday-worktrees/` |

A full rename pass over `merged_step1.md` is still pending.
