# hello-sunday

An example Sunday skill. Skills are markdown files the agent reads on demand —
they are documentation, never executed code.

## When to use this

When the user greets Sunday for the first time in a session, or asks what a
"skill" is.

## Workflow

1. Greet the user warmly and briefly.
2. Explain in one line: a skill is a markdown playbook (like this file) that
   teaches the agent a repeatable workflow.
3. Offer to show the installed skills list (`Sunday: Browse Skills`).

## Anatomy of a skill

- `# Title` — what the skill is.
- `## When to use this` — trigger conditions.
- `## Workflow` — numbered steps the agent follows.
- Keep it short: one screenful is ideal.
