# Card-bill payments — local e2e evidence

Browser run of [`apps/web/e2e/card-bill-payments.spec.ts`](../../../../apps/web/e2e/card-bill-payments.spec.ts)
on 2026-10-06 (São Paulo time). **Result: 2/2 passed** (setup + scenario). Full
output is in [run.log](run.log).

## How it was run

```bash
pnpm --filter @family-finance/web test:e2e:local
```

- **Local only.** [`scripts/e2e-local-stack.sh`](../../../../scripts/e2e-local-stack.sh)
  starts a throwaway Supabase stack in `.e2e-supabase/` (gitignored, project
  `ff-e2e-local`, ports 564xx). Each run resets that database and applies every
  migration in `supabase/migrations/`, including
  `202610070000_card_bill_closing_and_payments.sql`. No dev or production data
  is involved.
- [`local-auth.setup.ts`](../../../../apps/web/e2e/local-auth.setup.ts) refuses
  to run against a non-local host. It seeds the following, then signs in and
  saves the session cookies:
  - a password user, the household "Casa E2E" and the account "Conta E2E";
  - the card "Nubank E2E" (closes on day 28, due on day 5);
  - one purchase of R$ 300,00 dated today.
- Next.js dev server on `localhost:3100`, Chromium, Playwright trace and
  screenshots on.
- Stop the stack afterwards with `scripts/e2e-local-stack.sh stop`.

The run date was 2026-10-06, so the open fatura was **10/2026**. Steps 03–12
then work with:

| Fatura | Role in the scenario |
| ------ | -------------------- |
| 10/2026 | Closed by hand: it becomes the pending (closed) fatura. |
| 11/2026 | The next open fatura. |
| 01/2027 | Future month used in step 10. |

## Steps

| # | What is checked | Spec IDs | Result | Screenshot |
| - | --------------- | -------- | ------ | ---------- |
| 01 | The seeded purchase shows in open Fatura 10/2026: Total R$ 300,00, badge "aberta". | — | ✅ | [01](screenshots/01-open-fatura.png) |
| 02 | An à vista purchase of R$ 100,00 from the form raises the total to R$ 400,00. | — | ✅ | [02](screenshots/02-purchase-added.png) |
| 03 | "Fechar fatura" with a corrected total of R$ 380,00: toast "Fatura fechada.", Total R$ 380,00, badge "fechada · a pagar R$ 380,00", note "total ajustado". | C6, C18 | ✅ | [03](screenshots/03-closed-corrected-total.png) |
| 04 | A R$ 50,00 purchase dated today lands in Fatura 11/2026. The closed 10/2026 is listed above the open 11/2026. | C25, P1, P9 | ✅ | [04](screenshots/04-pending-and-open.png) |
| 05 | The payment form is prefilled with R$ 380,00. A partial payment of R$ 100,00 gives Pago R$ 100,00, Falta R$ 280,00 and badge "fechada · parcial, falta R$ 280,00". | E2, C26 | ✅ | [05](screenshots/05-partial-payment.png) |
| 06 | Double-clicking "Registrar pagamento" for R$ 30,00 saves exactly one payment (2 rows after a reload, Falta R$ 250,00). | E11 | ✅ | [06](screenshots/06-double-submit-single-payment.png) |
| 07 | Paying the remaining R$ 250,00 removes Fatura 10/2026 from "Faturas de agora", leaving only 11/2026. /resumo no longer shows "Fatura 10 · fechada". | E3, P3 | ✅ | [07](screenshots/07-paid-collapses-to-open.png), [07b](screenshots/07b-resumo-after-paid.png) |
| 08 | `/cards?fatura=2026-10` shows the paid fatura ("paga ✅"). "Desfazer" on the R$ 250,00 payment gives toast "Pagamento desfeito.", 2 rows and Falta R$ 250,00. | E13 | ✅ | [08a](screenshots/08a-paid-month-view.png), [08b](screenshots/08b-payment-undone.png) |
| 09 | Paying R$ 0,00 shows the inline alert "Informe um valor maior que zero." and saves nothing. | E7 | ✅ | [09](screenshots/09-invalid-amount.png) |
| 10 | `/cards?fatura=2027-01`, a future fatura, accepts a R$ 20,00 payment: Pago R$ 20,00. | E5 | ✅ | [10](screenshots/10-future-month-payment.png) |
| 11 | A 3x parcelado preview dated today shows "Fatura de 10/2026 já fechada — começa em 11/2026." | C15 | ✅ | [11](screenshots/11-parcelado-shift-note.png) |
| 12 | /resumo shows the pair "Fatura 10 · fechada" (R$ 380,00, partial) with "Próxima 11 · aberta" (R$ 50,00). | P1 | ✅ | [12](screenshots/12-resumo-pair.png) |

The HTML report and trace are not committed because they are about 26 MB. Rerun
the command above and open them with:

- `pnpm --filter @family-finance/web exec playwright show-report`
- `pnpm --filter @family-finance/web exec playwright show-trace test-results/card-bill-payments-*/trace.zip`

The bot side (T6) is covered by unit and integration tests rather than this
browser run.
