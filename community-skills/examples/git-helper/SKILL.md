# git-helper

An example Sunday skill: concise git workflow reminders for agents working
in the Sunday repo.

## When to use this

Before creating commits, branches, or pull requests.

## Workflow

1. **One feature per commit.** Never bundle unrelated changes; never commit
   another worker's uncommitted files — stage selectively.
2. **Never push** unless the task explicitly says to. Commit locally.
3. **Branch hygiene:** small, imperative commit messages
   (e.g. `feat(sync): ...`), no AURORA naming anywhere.
4. **Before committing:** run the package's tests
   (`npx vitest run` in the package dir) and `npx tsc --noEmit`.
5. **Secrets:** never commit tokens, keys, or `.env` files. Pasted PATs are
   one-time-use via env passthrough and are discarded immediately.
