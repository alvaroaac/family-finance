# thoughts/

Project context that doesn't belong in code: product identity, feature briefs, in-flight work state, design notes, punted issues. Agents read this dir to understand what the human is talking about.

**Read this README before answering "take a look at X" or "update Y".** It tells you which file to open.

---

## Directory map

```
thoughts/
  README.md                  ← this file
  tech-debt.md               ← punted issues, future work
  what-the-heck.md           ← codebase surprises logged by agents (read on startup)
  notes/                     ← cross-cutting reference docs (project-wide)
  product/                   ← durable identity, scope, boundaries
  features/<name>/           ← per-feature work; one dir per shipped or in-flight feature
```

Top-level files are reserved for things referenced often enough that a short path matters. Don't add new top-level files casually — most things go under `notes/`, `product/`, or `features/<name>/`.

---

## Where things live

### `tech-debt.md` (top level)

Punted issues and improvements deferred from the current session. Heavily referenced. When the human says **"tech debt"**, **"add to tech debt"**, **"check tech debt"** — this is the file. Always.

Append entries with date + short context. Don't reorganize without being asked.

### `what-the-heck.md` (top level)

Codebase surprises logged by agents — footguns, undocumented quirks, hidden coupling, assumptions that turned out wrong. Read on startup before non-trivial tasks; prior surprises are warnings. Agents must always ask permission before writing here (auto mode does not override). Format and rules live in the `what-the-heck` skill.

### `notes/`

Cross-cutting reference docs. Subsystem designs, integration setup, architectural decisions — anything not tied to a single feature.

Examples: `deployment.md`, `decisions.md` (ADR-lite), `runbooks.md`, `rate-limiting.md`.

Naming: lowercase-kebab. One topic per file. If a topic grows, split it before the file gets unwieldy.

### `product/`

Durable identity and scope. Slow-changing. Treat as source of truth for what we sell, who we sell to, and what we will not do.

Suggested files (create as the identity emerges — don't pre-stub):

- `customer-profile-and-service-scope.md` — ICP and what's in/out of scope
- `wont-dos.md` — hard product boundaries
- `getting-started-script.md` — onboarding script for new customers
- `initial-prompt.md` — original framing prompt that seeded the project

### `features/<name>/`

One dir per feature. Default file convention:

| File | Owner | Purpose |
|---|---|---|
| `ticket.md` | human | High-level brief: what to build and why. Written first. Optional once feature is finished. |
| `progress.md` | agent | Decisions made, current state of work, non-obvious context that won't surface from a codebase search. Single source of truth for "where is X at?" |
| `qa-review.md` | QA agent | Review output: gaps, blockers, what's missing for PR merge |

A finished feature may have just `progress.md` (final summary). An active feature usually has all three. Topic-specific notes for a single feature stay in the feature dir alongside these (e.g. `features/<name>/some-design-note.md`); cross-feature topics go to top-level `notes/`.

---

## Resolving common requests

Patterns the human uses → file the agent should open.

| Human says | Open this |
|---|---|
| "tech debt" / "add to tech debt" / "what's in tech debt" | `tech-debt.md` |
| "what the heck" / "WTH" / "log this surprise" / "codebase surprises" | `what-the-heck.md` |
| "the [feature] progress" / "update progress for [feature]" | `features/<feature>/progress.md` |
| "QA review for [feature]" / "what did QA find" | `features/<feature>/qa-review.md` |
| "the [feature] ticket" / "the brief" | `features/<feature>/ticket.md` |
| "wont-dos" / "what we won't do" | `product/wont-dos.md` |
| "ICP" / "customer profile" / "service scope" | `product/customer-profile-and-service-scope.md` |
| "the onboarding script" / "getting started" | `product/getting-started-script.md` |

If a request doesn't resolve cleanly, ask before guessing. Don't create a new doc unless the human asked for one.

---

## Conventions

**Filenames.** lowercase-kebab. `progress.md`, not `PROGRESS.md` or `Progress.md`. One word per concept (`rate-limiting`, not `rate_limiting` or `rateLimiting`).

**Ownership.** `ticket.md` is human-owned (don't rewrite without being asked). `progress.md` and `qa-review.md` are agent-maintained — keep them current as work moves. Other files: ask before restructuring.

**Dates.** When a doc references a relative date ("yesterday", "last week"), convert to absolute (`2026-04-26`) before saving. Memory and notes that age past their relative anchor become unreadable.

**Don't duplicate the codebase.** These docs capture what code can't tell you: why a decision was made, what was considered and rejected, what's blocking progress, what's been promised but not yet built. If a fact is derivable from `git log` or a quick grep, it doesn't belong here.

**Don't archive.** Finished features stay in place. `progress.md` summarizes the final state. Old branches and PRs are the archive — git already did this work.

---

## Adding a new feature

1. Create `features/<name>/` (lowercase-kebab name).
2. Add `ticket.md` with the brief.
3. Agent adds `progress.md` once work begins.
4. QA agent adds `qa-review.md` when there's something to review.

That's it. No template required — copy the shape of an existing feature dir if useful.
