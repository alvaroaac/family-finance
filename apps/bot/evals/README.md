# Bot model evaluation

This harness compares extraction and categorization quality without letting a
provider-specific API feature change the task. Every provider receives the same
single-turn Portuguese prompt, taxonomy snapshot, JSON shape, and case date.

Version `v1` contains 42 hand-labelled cases across intent extraction,
categorization, and desired end-to-end drafts. It deliberately includes desired
behaviour the production contract cannot yet represent. Run the gap report
before interpreting model scores:

```bash
pnpm --filter @family-finance/bot eval:gaps
```

The key gaps are ranked top-3 category choices, merchant/item separation, plain
card expenses without installments, new subcategory proposals, transfer
intents, and investment accounting. A model must not be blamed for failing to
emit data a tested production schema has nowhere to put.

## Taxonomy semantics

`purpose` is separate from category/subcategory. For example an airfryer can be
`Conforto / Moradia / Eletrodomésticos`, while a hotel saved for ahead of time
can be `Metas / Lazer / Viagens`.

An investment contribution is **not an accounting expense**. It is a cash
outflow/transfer that subtracts from the user-facing available `Saldo`, while
remaining excluded from consumption-spend totals. Spending money later on an
actual good or service is consumption and is counted then.

The taxonomy is an intentionally versioned draft. User adjudication should
happen before treating the test split as sealed gold.

## Run models

The default matrix is `claude-haiku-4-5`, `claude-sonnet-5`, `gpt-5.4-mini`,
and `gpt-5.5`. Model IDs remain overridable so pinned successors can run under
identical prompt/schema settings:

```bash
export ANTHROPIC_API_KEY=...
export OPENAI_API_KEY=...
pnpm --filter @family-finance/bot eval:models -- --repetitions 3 --output ./eval-results
```

Set `EVAL_MODELS` or pass `--models` to override the default matrix.
Each request times out after 30 seconds by default; override with
`--timeout-ms`. The runner prints one concise progress line per request so a
sequential 42-case run does not look stalled. It does not force a
provider-specific reasoning mode: unsupported settings would make the matrix
less comparable, and timeout/output-budget failures are recorded honestly.

Token usage is captured from both provider responses. Estimated cost uses
[`v1/pricing.json`](./v1/pricing.json), versioned for 2026-07-09. The Sonnet 5
entry records its introductory price and the later list price in a note. Pass
`--pricing PATH` with another compatible table when rates change; unknown model
IDs still run but their estimated cost is `null`.

The runner intentionally does not enable provider-specific structured-output
features. It sends plain text to Anthropic Messages and OpenAI Responses, then
extracts the JSON object. This makes schema-valid rate a meaningful comparison
metric. OpenAI requests set `store: false`.

Each model gets its own append-only JSONL file. Errors are recorded per case so
a partial provider failure does not erase the rest of the run. To rescore an
existing file without network access:

```bash
pnpm --filter @family-finance/bot eval:score -- --predictions ./eval-results/provider-model.jsonl
```

## Reading the score

The report includes schema validity, intent accuracy, exact gold-field accuracy,
top-1 category accuracy, mean Recall@3, category-decision accuracy, accounting
accuracy, p50/p95 latency, input/output tokens, estimated USD cost, and a list of
catastrophic errors. Critical failures include confusing
an obligation, installment, or investment transfer; getting amount semantics,
installment count, or card wrong; and counting an investment transfer as
consumption.

Use the dev split to refine prompts. Do not tune against the test split. Run
each candidate three to five times and compare the mean plus the worst run.
Select the smallest model with zero catastrophic errors on the critical cases;
route only ambiguous/new-category cases to a stronger model if that meets the
quality bar more economically.
