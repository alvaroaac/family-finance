# Private MCP activation

Implementation is feature-gated with `AGENT_IMPORT_ENABLED=true`. Keep the gate
off until all activation prerequisites below pass. Opening the PR does not
activate production or authorize production migrations.

## Auth and data boundary

Production was inspected on 2026-10-14: GoTrue `v2.158.1`; OAuth authorization
server discovery returned 404. The isolated integration stack uses GoTrue
`v2.191.0` and proves authorization code + S256 PKCE, consent, existing user
identity, resource audience and refresh-capable token issuance. Upgrade the
production Auth stack only under the separate backup/migration approval process.

Use Supabase's established OAuth server, with authorization UI `/oauth/consent`.
The provider supports standard OIDC scopes; request `openid`. The four proposed
finance permissions are server-side, revocable grants shown on our consent page,
not unsupported custom scopes sent to GoTrue. Every service operation checks its
permission against the current grant. The custom access-token hook adds the MCP
resource audience only for a currently granted existing user/client pair.

OAuth tokens are not interchangeable with website sessions. The API calls Auth
to verify the token, then checks issuer, expiry, subject, `authenticated` role,
client identity and the exact resource audience. Browser approval rejects OAuth
sessions and requires a same-origin POST and explicit checkbox/button action.

The PostgREST pre-request guard is essential: it denies OAuth `client_id` tokens
before they can invoke legacy financial APIs that do not require import approval.
Do not enable the feature unless this bypass-negative control passes. If an
existing installation already has a pre-request hook, compose the guard with it
before activation instead of discarding its behavior.

## Configuration

- `NEXT_PUBLIC_SITE_URL`: canonical HTTPS app origin.
- Existing `NEXT_PUBLIC_SUPABASE_URL` and public anon key.
- `AGENT_IMPORT_DATABASE_URL`: TLS PostgreSQL connection as `ff_import_app`.
  Provision its password outside source control. The adapter rejects superuser,
  BYPASSRLS, and other runtime roles. Use a reachable restricted database endpoint;
  do not expose an unrestricted database port to the internet.
- `AGENT_IMPORT_ENABLED`: defaults off.
- Existing `IMPORT_SUGGESTION_URL` and `IMPORT_SUGGESTION_SHARED_SECRET`: optional
  bounded categorization provider; no additional paid-provider budget is created.

After the approved forward migrations:

1. Provision the runtime login password securely. Never put it in a PR or logs.
2. Insert one `agent_import.oauth_config` row with `singleton=true` and
   `resource='https://YOUR_APP_ORIGIN/mcp'`.
3. Enable GoTrue OAuth server and its consent route. Configure the custom access
   token hook to `pg-functions://postgres/public/agent_import_access_token_hook`.
4. Verify `authenticator` has
   `pgrst.db_pre_request=public.reject_direct_oauth_access`, reload PostgREST
   configuration and prove a normal website token still works while an OAuth
   token receives 403 on direct financial REST/RPC requests.
5. Schedule `deploy/agent-import-cleanup.sql` every five minutes with the
   privileged maintenance role. It removes expired normalized payloads after
   the 24-hour recovery window, plus their event/operation payloads. Cancelled
   drafts are scrubbed immediately; lightweight retry tombstones remain.
6. Enable the app gate and link the private MCP client to `https://YOUR_APP/mcp`.
   Use a registered client with S256 PKCE; dynamic client registration is optional.
7. Repeat the synthetic end-to-end proof against the approved pilot environment,
   then perform the representative ChatGPT conversation before calling the pilot
   activated. No public plugin-directory publication is required.

## Contracts and locking

HTTP paths and MCP tools follow `design.md`. HTTP mutations use
`Idempotency-Key`; MCP uses `idempotency_key`. Both require `expected_revision`
after creation. `update_import` also supports explicit `source_changes` for
coverage corrections, alongside the seven typed row actions. Limits are returned
by `get_import_context`; oversized requests are rejected, never truncated.

Draft operations serialize per household. Confirmation additionally obtains a
short database table lock covering financial transactions, installment groups,
installments and import claims, so concurrent website/manual writers cannot slip
between final matching and persistence. This conservative pilot tradeoff can
briefly delay unrelated writes; replace it only with a cross-writer locking
protocol with equivalent race tests. It runs only during confirmation, not AI.

AI runs synchronously inside the revision transaction with bounded timeouts and
the existing provider's lineage budget. A later edit cannot be overwritten by a
late result: it waits for the transaction and must present the new revision.
Failures leave manual review available. Renewal keeps the lineage budget.

## Repeatable local proof

Use only a disposable stack on ports `57421/57422`, with OAuth enabled, the hook
configured, and app origin `http://127.0.0.1:3147`. The browser/MCP verifier refuses
any other Supabase origin. Save `supabase status -o env` to the ignored
`.agent-import-test.env`, configure the runtime login and resource row, then run:

```sh
AGENT_IMPORT_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:57422/postgres pnpm --filter @family-finance/import-service test
node scripts/verify-agent-import.mjs
```

The browser verifier uses synthetic users, accounts and statements, performs
real OAuth consent, discovers twelve tools, prepares a draft, edits it twice,
proves a GET does not approve, clicks approval, commits, checks financial records
and original evidence, repeats intake, and revokes access. It saves a review
screenshot to `artifacts/agent-import/review.png`. Fixtures remain only in the
disposable stack for inspection; destroy that stack after review.

Official references checked during implementation:

- https://developers.openai.com/plugins/build/auth
- https://supabase.com/docs/guides/auth/oauth-server/mcp-authentication
- https://supabase.com/docs/guides/auth/oauth-server/token-security
