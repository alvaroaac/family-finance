# Mobile MVP validation — 2026-09-05

Status: local full-stack validation passed. Native-device validation remains required before the complete MVP can be declared validated. This is not a production deployment.

## Environment

Fresh worktree `/private/tmp/family-finance-mobile`, branch `codex/mobile-expo-prototype`, base `371ce5c`. Dedicated local Supabase project `family-finance-mobile`, API port 55321, database port 55322. All 19 branch migrations and seed applied to this new database. The existing local `family-finance` database and production data were untouched.

The actual Expo App/SessionGate/LiveApp, actual mobile API and RLS-bound Supabase client were exercised through the web rendering of React Native. A separate test-only entrypoint signs into real local Supabase with a synthetic password user. It does not mock financial requests or weaken the production authentication path. Google OAuth itself remains a separate required device/staging check.

## Observed end-to-end flows

| Flow | Result and evidence |
| --- | --- |
| Local authentication and session restoration | Real Auth session opened household; page reload restored it. Logout returned to sign-in and stayed signed out after reload. Anonymous API returned 401, unrelated household header returned 403. |
| Accounts and cards | UI created Conta E2E and Cartão E2E; HTTP regression creates, renames and deletes separate temporary accounts/cards and reads each result back. |
| Quick expense | Text parsed R$85; reviewed account/category saved to Postgres and appeared in movements. |
| Edit expense | Changed to Mercado E2E revisado, R$95, subcategory Mercado. Postgres and UI agreed. |
| Income | Salário E2E R$8,500 saved and appeared in list and reports. |
| Installments | Notebook E2E R$1,200 in 3 installments generated R$400 in September, October, November. Reports and drill-down displayed installments 1/3 and 2/3 in the correct month. |
| Reports | R$8,500 income and R$495 expense before commitment payment; R$1,475 expense after R$980 actual rent payment. Card settlement transfer did not add a second expense. Category and payment-source breakdowns reconciled. |
| Recurring commitment | Created R$1,000 rent due day 10, paid actual R$980, showed paid state, edited due day to 11, canceled. Past payment remained and future pressure disappeared. Regression repeats payment to prove one row only. |
| Card settlement | R$400 bill payment stored as transfer and removed that bill from future unpaid pressure. |
| Category memory | Created mercado → Alimentação / Mercado, paused and restored it. New text autofilled R$42 plus category, subcategory and account; saved row verified in database. |
| Taxonomy | UI created Categoria E2E and Sub E2E, archived/restored category, merged into Outros. Subcategory's destination verified in Postgres. |
| Investments | UI updated Casa bucket balance to R$25,000 and displayed it. |
| Member profile | UI changed test member display name to Pessoa E2E; database and capture responsibility choices reflected it. |
| Draft preservation | Closing and reopening the capture sheet preserved the unsaved description. Logout and a fresh sign-in cleared that draft. |
| Search and deletion | Search isolated Autofill E2E; confirmation deleted it; database count became zero. |
| Simulations | Cash R$12,000 plus schedules projected R$6,200. R$600 expense × 3 months produced R$4,400. Toggle off restored R$6,200. Edited assumption to R$2,500 income; toggle on produced R$8,700. Discard returned to clean baseline; real ledger unchanged. |
| Invalid/replayed requests | Negative amount and invalid account rejected; identical UUID retry produced one transaction; changed payload with same UUID returned 409. |
| Recovery | API unavailability showed retry screen; retry loaded real household once server was restored. |
| Management validation | Empty account form displayed “Preencha: Nome.” and stayed editable without submitting. |
| Visual validation | Screenshots inspected at 390×844 and 320×740. Esmeralda and Sálvia, fixed save control, wrapping headings, Portuguese error beside save. |

## Bugs found and fixed during full-stack verification

- Installment query compared `YYYY-MM` against complete dates; now filters exact selected month and presents valid full dates.
- Commitment cards read camelCase fields from snake_case resource rows; amount, due day and edit/payment defaults now match stored data.
- Paid-month comparison now uses the database's first-of-month date and disables repeat UI payment for a paid month.
- Empty capture exposed default English schema errors; input guidance is now Portuguese and adjacent to the fixed save control.
- Request timeout now covers response body decoding too.
- Management validates required values, amount/day/month/date before submission; known client errors remain editable.

## Repeat locally

From the repository root (Docker and Supabase CLI required):

```sh
cp apps/mobile/tests/supabase-config.toml supabase/config.toml
supabase start
supabase status -o json > /private/tmp/casa-local-status.json
node apps/mobile/scripts/setup-e2e.mjs
WATCHPACK_POLLING=true pnpm --filter @family-finance/web exec next dev -p 3109
```

In separate terminals:

```sh
node apps/mobile/scripts/export-e2e.mjs
node apps/mobile/scripts/serve-e2e.mjs
```

Open `http://127.0.0.1:8087/`, use the clearly labeled local test sign-in, and perform the synthetic flows above. The exporter restores the production `index.ts` in `finally`. The test entrypoint and exported bundle are not release entrypoints. Local setup refuses remote URLs and refuses to overwrite non-test environment files.

After the UI fixture flows (including rent cancellation):

```sh
node apps/mobile/scripts/verify-local-api.mjs
```

Observed: **62 real API/Auth/Postgres regression checks passed against the production Next.js build**, no financial API mocks. It uses the named UI records as fixtures, creates fresh records for retry and management checks, and deletes its temporary transactions/accounts/cards. Investment CRUD exercises the unused Filhos seed bucket and restores its name and zero balance. Canceled temporary commitment templates remain in the isolated test database.

## Required native validation still outstanding

No Xcode/iOS simulator or Android SDK/emulator is installed on this Mac. The user selected a physical iPhone with Expo; account/signing setup is pending. See [iPhone testing](./IPHONE-TESTING.md). Native Google PKCE callback, native secure-session cold start, microphone recording/transcription, native keyboard/date picker/safe areas, and VoiceOver/TalkBack still require an installed development build and configured Google/AI services. They must not be described as validated based on a web export. Import end-to-end is excluded from the user's required coverage; prior import UI fixture tests are not real import verification.

## Build and automated validation

- Repository typecheck: 17/17 tasks passed.
- Mobile tests: 51 passed.
- Web tests: 185 passed.
- Bot tests from shared-intake integration: 1,850 passed.
- Final Next.js production build passed; real API regression was rerun against that build.
- Final Expo export passed for iOS, Android and web. Exports are bundles, not installed signed apps.
- Git whitespace check passed.

## Brazilian date presentation

Full dates display and accept `DD/MM/AAAA`; month fields use `MM/AAAA`. API values retain ISO formatting. Browser UI verification changed Mercado E2E revisado to `04/09/2026`, confirmed Postgres stored `2026-09-04`, and confirmed the list displayed `04/09/2026`. Four date tests cover round trips, partial input, invalid calendar dates and month conversion. The Portuguese native date picker still requires the iPhone check.

## Real-household development access (2026-09-09)

The development flag now replaces Google OAuth with a one-time code verified by the real Supabase Auth server for the configured existing account. The sample-data root was removed. The resulting regular session opens LiveApp and keeps all API membership/RLS checks. Release builds ignore the development flag. Real production-household bootstrap, projection, design-system and import-history GETs returned 200; unauthenticated bootstrap returned 401. A real email/code exchange succeeded. These checks made no financial mutations. The user still needs to complete the code entry on the iPhone; this does not establish native E2E completion. Mobile checks: 59 tests passed and typecheck passed.

## Inline category creation and copy (2026-09-09)

All remaining mobile UI occurrences of the singular movimento were changed to movimentação with matching grammar. Capture now creates/selects categories inline and retains the transaction draft. Six regression tests cover valid creation, equivalent existing names, lost responses, archived categories, invalid input and unreconciled failure. A real isolated API/Postgres check created a category, reused it on retry, saved a transaction and verified its category foreign key and amount; disposable records were removed. Mobile tests: 65 passed; typecheck passed. Browser UI verification stopped at the local development-code sign-in failure, so this check does not establish native/UI end-to-end completion.

## PR preparation after integrating main (2026-09-09)

Integrated current main including import reconciliation and commitment-page updates. Fresh checks passed: all 17 typecheck tasks, 65 mobile tests, 364 web tests, 1,850 bot tests, Next.js production build and Expo exports for iOS/Android/web. The native critical-flow E2E and standalone deployment gates above remain outstanding. Generated builds, environment files and device access codes are not part of the PR.
