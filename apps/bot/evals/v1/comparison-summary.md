# Model comparison output

Evaluation set: [`generated-cases.jsonl`](./generated-cases.jsonl), 14 derived
cases, one repetition, strict provider-neutral schema.

| Metric | GPT-5.5 | GPT-5.3 Codex Spark | GPT-5.4 mini |
|---|---:|---:|---:|
| Schema-valid rate | 100.0% | 92.9% | 78.6% |
| Intent accuracy | 100.0% | 85.7% | 78.6% |
| Field accuracy | 88.9% | 84.4% | 73.3% |
| Top-1 category accuracy | 42.9% | 35.7% | 21.4% |
| Mean Recall@3 | 53.6% | 46.4% | 35.7% |
| Category-decision accuracy | 78.6% | 78.6% | 57.1% |
| Proposal accuracy | 92.9% | 100.0% | 100.0% |
| Accounting accuracy | 14.3% | 21.4% | 42.9% |
| Latency p50 | 10.9s | 4.3s | 11.4s |
| Latency p95 | 18.6s | 17.6s | 26.6s |

Interpretation: Spark was materially faster at the median. GPT-5.5 had the
strongest intent/schema/field/category scores. GPT-5.4 mini scored best on
accounting in this sample, but had the most schema failures and highest p95
latency. This is a single 14-case run, not a model-selection conclusion.

Notable failures:

- GPT-5.5: accounting semantics on `gen-acct-009` and `gen-acct-010`.
- Spark: one invalid-schema invocation on `gen-cat-010`, plus accounting
  semantics on `gen-acct-009`.
- GPT-5.4 mini: invalid-schema invocations on `gen-giassi-008`, `gen-cat-009`,
  and `gen-cat-010`, plus accounting semantics on `gen-acct-009`.

Raw predictions:

- GPT-5.5: `/tmp/family-finance-generated-comparison/codex-gpt-5.5.jsonl`
- GPT-5.3 Codex Spark: `/tmp/family-finance-generated-comparison-spark/codex-gpt-5.3-codex-spark.jsonl`
- GPT-5.4 mini: `/tmp/family-finance-generated-comparison-mini/codex-gpt-5.4-mini.jsonl`

The earlier 42-case GPT-5.5 run is at
`/tmp/family-finance-eval-results/codex-gpt-5.5.jsonl`.
