# MCP import verification

Verified locally on 2026-10-14, using only synthetic financial records and an
isolated OAuth-capable Supabase stack. Production was inspected read-only; it
was not upgraded, migrated or deployed.

| Boundary                    | Evidence                                                                                                                                                                                                                                      |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build and existing behavior | `pnpm typecheck`, `pnpm test` (3,159 passing tests), and the production web build pass. The ordinary login callback and existing parser imports remain covered by their suites.                                                               |
| Database and RLS            | `pnpm test:agent-import-db` creates a fresh PostgreSQL container, applies the full migration history, and passes 24 tests (10 pure review cases and 14 real database cases). This command is included in CI.                                  |
| Migrations                  | `pnpm test:migrations` passes, including applying the migration history twice. Four forward migrations add the generic source, private drafts, OAuth hook and retention cleanup.                                                              |
| OAuth                       | Real authorization code exchange with S256 PKCE, browser consent, the existing Supabase user, and the MCP resource audience. Standard OIDC scope plus explicit revocable finance grants are exercised.                                        |
| Transport                   | The official MCP SDK connects over Streamable HTTP and discovers all twelve tools. Shared HTTP context, resource discovery, missing-token challenge and rejection of a first-party token at the MCP resource pass.                            |
| Approval boundary           | Opening the review page does not approve. Confirmation fails until the browser checkbox/button POST approves the exact revision. OAuth tokens cannot directly access the financial REST API.                                                  |
| Full workflow               | Against the compiled production app: structured browser-statement input → API categorization → two edit rounds → browser review/approval → atomic commit → saved financial row plus separate source evidence → repeat import detects overlap. |
| Isolation and lifecycle     | Foreign households and other users in the same household cannot read drafts. Foreign references, stale edits, revoked grants and inactive membership fail. Expiry, renewal and cleanup of draft/event/operation payloads are tested.          |
| Financial semantics         | Card refunds remain card credits; bill payments stay excluded. Installment totals require acceptance, sum exactly, and later positions link the existing purchase without another schedule.                                                   |
| Concurrency and recovery    | Concurrent overlapping approvals produce one commit and one changed review. A forced failure after financial insertion rolls back artifacts and approval consumption. Successful retries return one authoritative receipt.                    |
| Categorization              | Explicit uncategorized choices survive enrichment. AI and concurrent edits serialize; stale edits fail rather than overwriting an intervening revision. AI uses the existing bounded provider interface and lineage budget.                   |
| Browser                     | Consent, review, approval and revocation pass with no browser page errors. Screenshot: `artifacts/agent-import/review.png`.                                                                                                                   |

The browser/MCP proof uses the official SDK as the client. A live ChatGPT-host
conversation and production activation are not claimed by this verification.
They remain pilot activation checks in `activation.md`, requiring the separately
approved Auth upgrade and deployment. The current production Auth version does
not expose an OAuth server; feature activation defaults off.

The existing paid AI provider was not invoked with real financial data. Its
failure behavior and revision concurrency are exercised with synthetic adapters;
the runtime uses the existing provider's budget contract.
