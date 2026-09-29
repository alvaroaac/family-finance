# Portuguese category benchmark

This additive benchmark leaves the original 42 cases, tests, commands and production providers unchanged. It projects those 42 cases onto category decisions and adds 24 synthetic Portuguese examples (66 total: 28 development, 38 test).

## Task

Both providers receive the same Portuguese text, frozen taxonomy, category descriptions and decision criteria. Gold answers, adjudication notes, case IDs and split labels are never sent to either model. Each request asks two questions:

- Decision: `single`, `choose`, `propose_new`, or `abstain`.
- Category: one existing category/subcategory path, or `unknown`, with probabilities over the catalog.

Jev uses native Choice questions via the official TypeSafe API. Haiku generates the equivalent answer JSON. Each independent Jev question gets the context it needs, including the full taxonomy for the decision question.

Category/subcategory is scored independently of purpose. Amount/date extraction, accounting, free-text explanations, and naming a proposed category are outside this task. `propose_new` measures recognizing a taxonomy gap, not generating its name. Existing novel-category expectations are preserved in the source dataset.

## Run

From the repository root, configure `TYPESAFE_API_KEY` and `ANTHROPIC_API_KEY` in the gitignored `.env` file. The new command loads that file without executing it; process environment values take precedence. Never commit credentials.

```sh
pnpm --filter @family-finance/bot eval:portuguese --dry-run
pnpm --filter @family-finance/bot eval:portuguese
```

Defaults: pinned `jev-1.13.0` and `claude-haiku-4-5-20251001`, three repetitions, four concurrent requests per provider, and a 30-second timeout per request. Providers run in sequence. Only the synthetic fixture texts are sent; the application database is not accessed.

Optional flags:

```sh
pnpm --filter @family-finance/bot eval:portuguese --providers jev --split dev --repetitions 1
pnpm --filter @family-finance/bot eval:portuguese --providers anthropic --baseline-model claude-haiku-4-5-20251001
```

`--split` accepts `all`, `dev`, or `test`. `--jev-model` and `--baseline-model` override model IDs. Unknown model pricing is reported as unavailable. Use an absolute path for `--output`; relative paths resolve from the bot package directory. Missing keys stop the entire selected run before API calls. Authentication, credit and invalid-model/request errors stop further batches, preserving partial records.

Default outputs are under the gitignored `apps/bot/eval-results/portuguese-<timestamp>/`. A nonempty run directory cannot be reused: the manifest and provider logs use exclusive creation, preventing accidental overwrites.

- `manifest.json`: exact cases, taxonomy, requests, price sources and methodological limitations.
- `jev.jsonl` / `anthropic.jsonl`: individual answers, raw responses, probabilities, reported confidence, model IDs, usage, latency, repetitions and errors.
- `report.json`: aggregate, development, test and added-case scores with individual failures.

## Interpretation

- Decision accuracy includes all cases. Failed calls count as wrong.
- Exact category/subcategory accuracy and macro-category accuracy include only cases whose gold decision is `single` or `choose` and that have acceptable existing labels. Proposal/abstention cases do not manufacture category scores.
- Top-three hit rate means at least one acceptable category appears. Required-candidate recall checks coverage of explicitly required alternatives. Zero-probability alternatives are excluded.
- Unsafe single selections count cases where the model selects `single` despite a gold ambiguity, proposal or abstention.
- High-probability error rate uses a fixed selected-category probability of at least 0.85 together with a `single` decision. It does **not** interpret Jev's separate `confidence` field as probability of correctness.
- Latency percentiles cover successful requests at the recorded concurrency. API failures and timeouts remain visible in success counts and failures.
- Cost is estimated from recorded usage and pinned rates. It is incomplete if usage is missing, including network failures or timeouts whose API cost is unknown. Response-validation failures retain usage and raw responses.

These are small, draft, hand-labelled datasets with related development/test examples. Three repetitions measure stability, not three times as many independent examples. Do not tune prompts or thresholds on test results and then present those same results as held-out validation. A production decision needs an independently adjudicated sample of real transaction descriptions.

Haiku probabilities are self-reported text; Jev probabilities are native model output. This benchmark asks Haiku to generate the full distribution, so its latency and output cost are not equivalent to the current production prompt, which asks for a single suggestion. Results compare these category-only adapters, not an unchanged production pipeline.

Official references: [Jev API](https://docs.typesafe.ai/api), [Jev models and pricing](https://docs.typesafe.ai/models), [confidence semantics](https://docs.typesafe.ai/confidence), [Haiku pricing](https://platform.claude.com/docs/en/about-claude/pricing).

Validator revision v1.1 keeps the original inclusive 1% probability-sum tolerance but adds a floating-point epsilon. Rounded sums of 0.99 or 1.01 are accepted; materially larger errors remain failures. Both models must use the same revision. The initial v1 runs are retained separately and were not silently rescored. Prompts and gold labels are unchanged.
