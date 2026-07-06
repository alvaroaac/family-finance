# Project Ideas

This file captures ideas that come up during implementation but should not interrupt MVP delivery.

The fuller future backlog lives in `docs/specs/project-ideas.md`. Use this file for short implementation-time notes, then promote mature ideas to the docs backlog when useful.

## Ideas

## 2026-06-22: Dedicated transaction entry screen (account OR card)

**Why it came up:** Task 9 added the account/card structure and a card-purchase entry on
`/cards`, but there is no general `/transactions` screen for an arbitrary expense/income
that picks account OR card.

**Potential value:** A single quick-entry web surface mirroring the bot, reusing the
already-supported domain `createTransactionDraft` + db `createTransaction`.

**MVP impact:** Not required by Task 9 acceptance; the import flow and card entry already
cover the account-vs-card paths for the MVP. Build alongside Task 10/11 if useful.

**Status:** parked

## 2026-06-22: Caixinha balance / simple position

**Why it came up:** Spec mentions "saldo manual ou posição simples" for caixinhas; the MVP
schema has no balance column (see tech debt).

**Potential value:** Dashboard can show how much is saved per objetivo (filhos/casa/
independência).

**MVP impact:** Needs a migration; deferred to keep the committed schema stable.

**Status:** parked

## Entry Format

```md
## YYYY-MM-DD: Idea Title

**Why it came up:** Context from implementation or user feedback.

**Potential value:** What it could improve.

**MVP impact:** why it should or should not affect the current MVP.

**Status:** parked | promoted | rejected
```

