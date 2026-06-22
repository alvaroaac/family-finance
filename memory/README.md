# Memory Architecture

This folder is the project memory layer for agentic development. It is meant to preserve context between agents, sessions, and implementation phases without turning the repo into a diary.

Use it for durable project knowledge:

- What we are trying to build.
- What is currently true.
- What each task changed or discovered.
- What still needs review.
- What risks, debts, and ideas should not be lost.

Do not use it for secrets, raw financial data, copied import files, chat transcripts, or noisy logs.

## Structure

```txt
memory/
  README.md
  project-goals.md
  project-decisions.md
  project-tech-debt.md
  project-ideas.md
  docs-management.md
  risks-and-blockers.md
  glossary.md
  tasks/
    README.md
    _template.md
```

## Project-Level Memory

`project-goals.md`

- Current product goals.
- MVP boundaries.
- Non-goals that should be defended.
- Success signals.

`project-decisions.md`

- Durable technical and product decisions.
- Why a choice was made.
- What would cause the decision to be revisited.

`project-tech-debt.md`

- Known shortcuts, compromises, and cleanup work.
- Debt must have impact, owner/status, and a revisit trigger.

`project-ideas.md`

- Ideas discovered during development that should not interrupt the MVP.
- This may summarize or point to `docs/specs/project-ideas.md`.

`docs-management.md`

- Documentation structure and ownership.
- What belongs in specs, plans, decisions, runbooks, README, and memory.
- Documentation debt, review cadence, and stale-doc rules.

`risks-and-blockers.md`

- Active risks, unresolved questions, integration blockers, and external dependencies.

`glossary.md`

- Shared language for domain concepts such as household, caixinha, transaction, installment group, category memory, and import batch.

## Task-Level Memory

Every meaningful implementation task should get one task memory file under `memory/tasks/`.

Suggested filename:

```txt
memory/tasks/task-NN-short-name.md
```

Use the template in `memory/tasks/_template.md`.

Each task memory should track:

- Progress.
- Acceptance criteria.
- QA and verification.
- Review notes.
- Decisions made inside the task.
- Follow-ups and discovered debt.

## Agent Read Protocol

Every agent must read memory before starting implementation work.

### Required For Every Agent

Read these files first:

- `memory/README.md`
- `memory/project-goals.md`
- `memory/project-decisions.md`
- `memory/risks-and-blockers.md`
- `memory/docs-management.md`
- The current implementation plan in `docs/superpowers/plans/`
- The approved product spec in `docs/specs/`

### Required For A Specific Task

Before working on a task, read:

- The matching task memory file in `memory/tasks/`, if it exists.
- `memory/tasks/_template.md`, if creating the task memory file.
- Any previous task memory files that produced direct inputs for the current task.

Examples:

- A bot agent should read the domain, categorization, and DB task memories if those tasks already ran.
- A dashboard agent should read import, transaction, installment, and DB task memories if those tasks already ran.
- A final integration agent should read every completed task memory file.

### Role-Relevant Memory

Agents should also read role-relevant files:

- Product or scope work: `memory/project-goals.md`, `memory/project-ideas.md`
- Architecture work: `memory/project-decisions.md`, `docs/decisions/`
- Database/auth work: `memory/risks-and-blockers.md`, RLS decisions, Supabase runbooks
- Documentation work: `memory/docs-management.md`
- Cleanup/refactor work: `memory/project-tech-debt.md`
- Domain terminology work: `memory/glossary.md`

### Required At Handoff

Before an agent finishes, it must update:

- Its task memory file.
- `memory/project-tech-debt.md` for newly accepted debt.
- `memory/project-ideas.md` for deferred ideas.
- `memory/risks-and-blockers.md` for unresolved risks or blockers.
- `memory/project-decisions.md` or `docs/decisions/` for durable decisions.
- `memory/docs-management.md` if docs are stale, missing, or reorganized.

## Update Rules

- Update memory at task boundaries, not after every tiny edit.
- Prefer concise, factual notes over narrative.
- Link to specs, plans, PRs, commits, or files when useful.
- If something is still uncertain, mark it as an open question with an owner or next action.
- Do not duplicate large sections of the spec. Link and summarize only what changed.

## Relationship To Specs And Plans

- Specs define what should be built.
- Plans define how work should be sequenced.
- Memory records what happened, what changed, and what should be remembered.
