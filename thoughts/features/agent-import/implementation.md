# Agent imports implementation

Approved 2026-10-14: implement the design in an isolated worktree, including 24-hour normalized recovery, browser review approval, transient original files, and publish the PR. Production changes are excluded.

## Foundation evidence

Baseline: 0f5a22c, merged tenant-isolation PR #40. Production inspection found GoTrue v2.158.1 and no OAuth authorization-server discovery endpoint. Production activation therefore requires a separately approved Auth upgrade. Use Supabase OAuth with PKCE to retain the existing user identity; verify client identity and resource audience, and resolve permissions from a browser-approved, revocable client grant.

The application service owns strict contracts, categorization, validation, edits and preparation. A database adapter owns transactions, owner-private drafts, revision compare-and-swap, idempotency, approval and lineage locks. MCP and HTTP share that service. A least-privilege server database login executes with the verified user's identity under RLS; it must not be a service-role or BYPASSRLS connection. OAuth tokens must not bypass the approval boundary by calling legacy financial RPCs directly.

## Work sequence

1. Strict contracts and shared review engine, preserving existing website imports.
2. Forward migration and transactional adapter: tenant/owner isolation, drafts, approvals, recovery, receipt, race protection.
3. HTTP/MCP authentication, consent, scoped permissions, Streamable HTTP and twelve tools.
4. Authenticated review surface and atomic confirmation.
5. Synthetic unit, database, protocol and browser verification, including two edit rounds and repeat imports.
6. Open PR with tested results and explicit production activation prerequisites.

## Verification ledger

Implementation in progress. No production migration, upgrade, deployment, or financial writes have been performed.

## Implemented and verified

The shared service, private database adapter, four forward migrations, twelve
MCP tools, HTTP API, OAuth consent/revocation, authenticated review and atomic
confirmation are implemented. See `verification.md` for local test evidence and
`activation.md` for the separate production/pilot gates. The dedicated database
integration command is part of CI.
