# Casa mobile

Native React Native + Expo application for iOS and Android. The Esmeralda/Sálvia interface shares the dashboard's palette, typography and vocabulary. The development flag opens the full app using a normal user session obtained with a one-time access code.

## Run

From the workspace root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @family-finance/mobile start
```

Use a development build for native Google authentication, microphone and document-picker verification. Expo Go is useful for initial UI work but is not the release validation target. `pnpm --filter @family-finance/mobile build` exports web JavaScript and iOS/Android Hermes bundles; it does not produce signed native binaries.

Physical iPhone setup and the prepared Expo development profile are documented in [IPHONE-TESTING.md](./IPHONE-TESTING.md).

Copy `.env.example` to `.env.local` and set the dashboard API origin and the same Supabase public URL/anon key as the dashboard. Deploy the web changes in this worktree before connecting a phone. Add `casa://auth/callback` to the Supabase redirect allowlist and retain the existing Google provider configuration. These configuration and deployment steps have not been performed by this implementation.

The server uses the existing authorized-email policy and requires a verified active household membership. No service-role or AI keys are included in the app. Native sessions use SecureStore in small encrypted chunks, with a manifest committed after all chunks are written. Web preview sessions use sessionStorage. Financial views and drafts are reset on account changes/sign-out.

## Implemented

- **Capture:** text or native voice transcription, shared bot interpretation/category memory, editable category/subcategory, expense/income, account/card, responsibility, native date selection and installments. The review button stays visible. Closing the sheet preserves the draft and stable retry ID. Successful saves refresh the ledger. Voice recording is limited to a minute and uploads only after an explicit transcribe tap.
- **Movements:** month navigation, virtualized list, search, kind filters, edits and confirmed deletion. Individual installment mutation is blocked by the same domain restriction as the dashboard.
- **Reports:** monthly income/expense totals, category drill-down and actual payment-source breakdown. The monthly difference is never labeled as a bank balance.
- **Simulation:** enter cash available now, then load six months of future registered income, future cash expenses, unpaid commitments and unsettled card bills. Add/edit/toggle/remove disposable income/spend assumptions. Freeze the base on first assumption; discard without changing real entries. Projection loading is separate from initial account loading.
- **Imports:** native PDF/CSV selection, the existing signed-preview and atomic-confirmation pipeline, target-specific duplicate checking, reviewed category suggestions and taxonomy proposals, optional correction learning/suppression, editable date/description/value, per-card mapping, justified duplicate overrides, installment total/date confirmation, stable import retry key and recent import history. Formats are Mercado Pago PDF, Nubank CSV and Minhas Finanças CSV.
- **Household management:** accounts/cards, card-bill settlement, recurring commitments/payments, investment buckets/balances, category/subcategory creation, archive/restore/merge, categorization rules and member/Telegram profile edits.
- **Design system:** authenticated API source, versioned semantic tokens, household identity, both themes, bounded control sizes and bundled fonts. Invalid/unavailable tokens fall back to the bundled Casa theme.

## Architecture

`packages/mobile-contracts` contains the entry schema, DTOs and versioned design-system definitions. `packages/intake` contains the bot parser, interpreter, provider adapters and supporting code; the bot keeps compatibility re-exports and its existing behavior.

`apps/web/app/api/mobile/v1/[...path]/route.ts` exposes a fixed list of native operations. Every request verifies its bearer token with Supabase, validates allowlist/membership and creates an RLS-bound client. An AsyncLocalStorage context allows existing dashboard server actions to use the verified native household; cookie-based dashboard behavior stays on its original path. References are checked against that household before generic actions run.

Core endpoints: `GET bootstrap?month=YYYY-MM`, `GET projection`, `GET design-system?theme=esmeralda|salvia`, `POST draft`, `POST audio`, `POST entries`, `POST actions`, `POST imports/preview|resolve|suggest|confirm`, `GET imports/history`.

Plain entries insert a client-generated UUID; replay succeeds only if the existing row matches the same payload. Installments reuse `create_installment_purchase` and its existing idempotency key. Imports reuse their signed request key. There are no automatic mutation retries. Unknown management outcomes require refreshing before retrying.

The draft service selects OpenAI when configured, otherwise Anthropic, and awaits the single selected provider's timeout. A failure falls back to deterministic parsing/category memory without starting a second paid provider. Audio uses the existing OpenAI transcription adapter. Temporary server audio files are deleted in `finally`; mobile audio caches are deleted when clips are discarded/unmounted.

## Native release gates

This is a local integration, not a deployed or device-certified release. No production schema was changed. The fresh worktree starts at `origin/main` (`371ce5c`); unrelated uncommitted dashboard/bot work in the original checkout was not copied.

Before release:

1. Verify Google PKCE return and native cold launch/session restoration against a staging Supabase project and deployed API. Real local Auth/session restoration and API household isolation have passed; see [E2E validation](./E2E-VALIDATION.md).
2. Verify real PDF/CSV preview → correction → confirmation → database rows, duplicate replay and card-bill settlement in staging. The UI harness below uses fake responses; it is not evidence that real imports ran.
3. Install on iOS and midrange Android. Verify keyboard, native calendar, microphone, document permissions, safe areas, VoiceOver/TalkBack, large text, scroll/frame pacing and interrupted network behavior. No native simulator is installed in this environment.
4. Add durable encrypted transaction drafts if they must survive process termination. Current financial drafts/scenarios survive navigation in the session and are intentionally not saved to disk. There is no offline write queue.
5. Commercial multi-household selection/onboarding and custom token storage remain future tenant work. The API accepts a verified `x-household-id`; the current native session assumes one active household.

Planning depends on the manually confirmed cash balance and recorded schedules. It does not infer recurring salary or variable spending from history, reconcile banks, or guarantee a future balance. Registered card purchases are accrual-style expenses; settlement transfers do not count as expenses a second time.

## Verification

Real local API/Postgres and React Native web-rendered flow results are documented in [E2E-VALIDATION.md](./E2E-VALIDATION.md), including the fixes found during testing and the remaining native-only gate.

```sh
pnpm typecheck
pnpm --filter @family-finance/mobile test
pnpm --filter @family-finance/web test
pnpm --filter @family-finance/bot test
EXPO_NO_TELEMETRY=1 CI=1 pnpm --filter @family-finance/mobile build
pnpm --filter @family-finance/web build
```

For an isolated UI harness using the real native screens and deliberately fake API responses:

```sh
node apps/mobile/scripts/export-ui-fixture.mjs
python3 -m http.server 8088 --bind 127.0.0.1 --directory apps/mobile/dist-ui-test
```

The exporter restores `index.ts` in `finally`; `dist-ui-test` is excluded from Git and TypeScript. Never publish the fixture as the real app. It displays a test banner and makes no external requests.

References: [Expo native file uploads](https://docs.expo.dev/versions/latest/sdk/filesystem/), [Expo recording](https://docs.expo.dev/versions/latest/sdk/audio/), [Supabase React Native authentication](https://supabase.com/docs/guides/auth/quickstarts/react-native).

## Expo Go development preview

Run `pnpm --filter @family-finance/mobile go` to enable `EXPO_PUBLIC_DEVELOPMENT_MODE=true` and replace the Google browser flow with a one-time access code for `EXPO_PUBLIC_DEVELOPMENT_EMAIL`. The code is verified directly by Supabase over HTTPS, and the normal session is stored in SecureStore. All screens use the real mobile API; the flag never bypasses API authorization. It is ignored in release bundles, even when set to true. Normal app starts retain the login.

For an existing authorized account, issue a one-time magic-link code using Supabase's server-side admin tooling and enter only that code on the device. Never embed a service-role key, access token, refresh token or one-time code in Expo public environment variables. Confirm the account already exists before issuing a code; do not create a new user as part of device setup. Codes are single-use and expire according to the Auth server's configured lifetime. Signing out removes this installation's session; the development flag alone grants no access.
