# Risks And Blockers

Use this file for active risks, unresolved questions, and external dependencies that can affect delivery.

## Active Risks

### Import format variance

**Risk:** Minhas Financas and Nubank exports may vary by date format, decimal format, column naming, or encoding.

**Mitigation:** Build import adapters with fixtures and preview errors instead of assuming a perfect file.

**Status:** open

### Supabase local setup

**Risk:** Local migration verification may be blocked if Supabase CLI or Docker is unavailable.

**Mitigation:** Document the exact blocker and keep SQL migrations reviewable.

**Status:** open

### AI confidence and explainability

**Risk:** Categorization may feel magical or wrong if confidence/explanations are not visible.

**Mitigation:** Every suggestion must include confidence and explanation metadata.

**Status:** open

## Blockers

No active blockers recorded yet.

## Entry Format

```md
## YYYY-MM-DD: Risk Or Blocker

**Type:** risk | blocker | open question

**Impact:** What this can delay or break.

**Next action:** Specific action to reduce uncertainty.

**Owner:** person or agent role

**Status:** open | watching | resolved
```

