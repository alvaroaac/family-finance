# Model comparison output

Evaluation set: [`generated-cases.jsonl`](./generated-cases.jsonl), 14 derived
cases, one repetition, strict provider-neutral schema.

| Metric | GPT-5.5 | GPT-5.3 Codex Spark |
|---|---:|---:|
| Schema-valid rate | 100.0% | 92.9% |
| Intent accuracy | 100.0% | 85.7% |
| Field accuracy | 88.9% | 84.4% |
| Top-1 category accuracy | 42.9% | 35.7% |
| Mean Recall@3 | 53.6% | 46.4% |
| Category-decision accuracy | 78.6% | 78.6% |
| Proposal accuracy | 92.9% | 100.0% |
| Accounting accuracy | 14.3% | 21.4% |
| Latency p50 | 10.9s | 4.3s |
| Latency p95 | 18.6s | 17.6s |

Interpretation: Spark was materially faster at the median and slightly better
on accounting/proposal scoring here, while GPT-5.5 had perfect intent/schema
validity and higher field/category scores. This is a single 14-case run, not a
model-selection conclusion.

Notable failures:

- GPT-5.5: accounting semantics on `gen-acct-009` and `gen-acct-010`.
- Spark: one invalid-schema invocation on `gen-cat-010`, plus accounting
  semantics on `gen-acct-009`.

Raw predictions:

- GPT-5.5: `/tmp/family-finance-generated-comparison/codex-gpt-5.5.jsonl`
- GPT-5.3 Codex Spark: `/tmp/family-finance-generated-comparison-spark/codex-gpt-5.3-codex-spark.jsonl`

The earlier 42-case GPT-5.5 run is at
`/tmp/family-finance-eval-results/codex-gpt-5.5.jsonl`.
