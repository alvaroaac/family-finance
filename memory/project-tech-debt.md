# Project Tech Debt

Track known compromises here. Debt should be specific enough that a future agent can act on it.

## Open Debt

## 2026-06-22: Web lint has no eslint config

**Area:** apps/web

**Impact:** `pnpm lint` for the web app runs `next lint` with no eslint config; first real run will scaffold/prompt. Not covered by Task 1 verification.

**Current workaround:** `lint` left as `next lint`; lint is not part of the baseline green gate.

**Revisit trigger:** Adding the first web feature, or wiring lint into CI.

**Status:** open

## 2026-06-22: Packages use `--passWithNoTests`

**Area:** all packages and apps

**Impact:** `test` scripts pass even when a package has zero tests, so an accidentally empty test suite would not fail.

**Current workaround:** `vitest run --passWithNoTests` keeps `pnpm test` green until real tests exist (Task 2+).

**Revisit trigger:** Once a package has real tests, the flag is a harmless no-op but can be dropped for that package.

**Status:** open

## Entry Format

```md
## YYYY-MM-DD: Short Title

**Area:** package/app/file

**Impact:** What this makes harder, riskier, slower, or more confusing.

**Current workaround:** How the project currently survives with this debt.

**Revisit trigger:** What event should make us fix it.

**Status:** open | in-progress | resolved
```

