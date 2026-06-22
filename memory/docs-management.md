# Docs Management

Use this file to keep documentation useful, current, and easy for agents to navigate.

## Documentation Map

`README.md`

- Entry point for humans and agents.
- Local setup.
- Common commands.
- Links to the current spec, implementation plan, and runbooks.
- Should stay concise.

`docs/specs/`

- Product and architecture specs.
- Approved scope.
- Future backlog in `project-ideas.md`.
- Specs describe what and why, not every execution step.

`docs/superpowers/plans/`

- Agent execution plans.
- Task sequencing.
- File boundaries.
- Acceptance criteria.
- Verification and dispatch strategy.

`docs/decisions/`

- Durable architecture/product decisions.
- Use when a decision should survive beyond a single task.
- Each entry should explain decision, rationale, alternatives considered, and revisit trigger.

`docs/runbooks/`

- Operational instructions.
- Local verification.
- Supabase setup.
- Telegram webhook setup.
- Vercel deploy.
- Incident/debug playbooks once needed.

`memory/`

- Living project memory.
- Progress, QA, review, risks, debt, and handoff notes.
- Records what happened and what changed.

## Rules

- Specs are the source of truth for product scope.
- Plans are the source of truth for task sequencing.
- Runbooks are the source of truth for repeatable operational procedures.
- Memory is the source of truth for current state and handoffs.
- If docs conflict, prefer the newest approved spec or decision record, then update the stale document.
- Do not duplicate long content across files. Link instead.

## Required Docs Before MVP Release

- [ ] `README.md` with setup, commands, and links.
- [ ] Supabase local setup runbook.
- [ ] Telegram bot setup runbook.
- [ ] Vercel deployment runbook.
- [ ] MVP verification runbook.
- [x] Architecture decision for package boundaries (`docs/decisions/0001-package-boundaries.md`); RLS decision still pending.
- [ ] Current implementation plan.

## Docs Debt

No docs debt recorded yet.

## Entry Format

```md
## YYYY-MM-DD: Docs Debt Title

**Document:** path/to/document.md

**Issue:** What is stale, missing, duplicated, or unclear.

**Impact:** Why this matters for agents or maintainers.

**Fix:** Specific update needed.

**Status:** open | in-progress | resolved
```

## Review Cadence

- Review docs at the end of each implementation task.
- Review runbooks before release gates.
- Review decisions whenever a task changes architecture boundaries.
- Review memory files before dispatching a new agent batch.

