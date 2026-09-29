# Telegram installment routing fix — implementation plan

**Date:** 2026-08-21  
**Status:** approved by user on 2026-08-22 after plan review  
**Scope:** Telegram text/audio interpretation, conversation routing, tests, and
safe production telemetry. No web behavior or database schema redesign.

## Goal

Make Telegram reliably distinguish a true card installment purchase from a
normal one-charge credit purchase, an account/cash expense, a recurring
obligation, a payment, or an ambiguous message. An explicit installment
purchase must still reach the installment confirmation flow when every AI
provider is unavailable, while an ordinary credit purchase must never create
an installment group.

## Confirmed findings

- The targeted bot suite is green, but its webhook installment story injects a
  ready-made `card_installment` result instead of exercising the real
  classifier.
- If classification fails or incorrectly returns `plain`, the current fallback
  can build an ordinary expense draft.
- Production telemetry reports provider success/fallback, but not the final
  intent or conversation route.
- The production `create_installment_purchase(jsonb,jsonb)` RPC exists, the bot
  service role can execute it, and no recent RPC error was observed.
- The classifier already rejects `card_installment` with fewer than two
  installments. The domain accepts count `1` as a general plan primitive, but
  Telegram must not use that primitive for a normal one-charge credit expense.

## 1. Required routing contract

### 1.1 Truth table

| Evidence in the message | Route | Persistence after confirmation |
|---|---|---|
| Known card or explicit credit language, with no installment evidence | `plain` card expense | One `transactions` row; no installment group |
| `1x`, `uma vez`, `uma parcela`, `à vista no crédito`, `pagamento único` | `plain` card expense | One `transactions` row; no installment group |
| Installment count `>= 2` plus card/purchase evidence | `card_installment` | One group plus exactly N installments |
| Explicit `parcelado`/`parcelas`/`parcelei`, but count missing | Partial `card_installment` draft | Ask for count; persist nothing yet |
| Installment purchase clear, but card missing or ambiguous | Partial `card_installment` draft | Ask for card; persist nothing yet |
| Financing, loan, boleto plan, or recurring-account evidence, even with `Nx` | `obligation` | Obligation flow; no card installment group |
| Conflicting evidence such as `parcelado em 1x`, invalid count, or incompatible amounts | Clarification | Persist nothing |
| Non-financial message | `non_financial` | Persist nothing |

### 1.2 Non-negotiable boundary

Using a credit card does **not** imply `card_installment`. The following remain
ordinary `plain` card expenses:

- `mercado 230 no Nubank`
- `posto 100 no crédito`
- `notebook 3600 em 1x no Inter`
- `notebook 3600 à vista no crédito`
- `passei 250 no cartão`

Only evidence of two or more installments, or explicit installment wording
that opens a draft and asks for the missing count, may enter
`card_installment`.

### 1.3 Deterministic evidence and AI precedence

Add a pure installment-routing detector before final conversation routing. It
returns one of:

- `installment`: strong evidence of a card installment purchase;
- `single_credit`: strong evidence of one-charge credit;
- `obligation`: financing/recurring-account evidence;
- `ambiguous`: contradictory or insufficient evidence requiring a question;
- `none`: no deterministic decision; use the existing interpreter.

Precedence rules:

1. `single_credit` must override an AI `card_installment` result.
2. `installment` must override an AI `plain` result or provider failure.
3. `obligation` must not be converted to a card installment merely because it
   contains `Nx`; explicit card/credit evidence is required to cross that
   boundary.
4. `ambiguous` must produce a focused question and must never silently persist.
5. AI may enrich description, dates, amount semantics, card selection, and
   category, but may not weaken these safety boundaries.

### 1.4 Obligation versus card-installment decision ladder

An `Nx` expression by itself is not enough to decide between an obligation and
a card installment. Apply these rules in order:

1. **Existing-payment language wins first.** `paguei`, `pago`, `paga`,
   `quitado`, or `quitei` plus a match to an existing obligation/card bill is a
   payment (`MP`), never a new purchase or obligation.
2. **Explicit registered-card evidence plus `2x+` means card installment.** A
   known active card name—including `Mercado Pago` in this household—or words
   such as `cartão`, `cartão de crédito`, and `crédito` combined with a count
   of two or more routes to `CI`.
3. **Explicit recurring/financing evidence without a card means obligation.**
   `financiamento`, `empréstimo`, `consórcio`, `boleto(s)`, `todo mês`,
   `mensal`, `por N meses`, a recurring due day, or an account/debit plan
   routes to `OB` when no explicit registered-card evidence contradicts it.
4. **Retail purchase evidence supports, but does not invent, a card.** Product
   or merchant language plus `parcelado`, `parcelas`, or `2x+` opens a partial
   CI draft; if the card is absent, ask for it before persistence.
5. **Conflicting strong evidence requires clarification.** A message that says
   both `financiamento` and `no cartão`, or a bare `72x` with no meaningful
   description/instrument, must ask whether this is a card purchase or a
   recurring obligation. Persist nothing until answered.

Examples:

| Message | Decision | Why |
|---|---|---|
| `Notebook 3600 em 12x no Nubank` | CI | Registered card + 12 installments |
| `Notebook 3600 em 12x no Mercado Pago` | CI | Mercado Pago is a registered card |
| `Curso parcelado no boleto, 10 boletos de 200` | OB | Boleto plan, no card evidence |
| `Financiamento do carro 1500 por 48 meses` | OB | Explicit financing and recurring term |
| `710 reais em 72x` | CL | No description or instrument establishes which model applies |
| `Nubank pago` | MP | Existing card-bill payment language |

## 2. Deterministic parsing changes

Implement a pure parser/detector for:

- counts: `12x`, `12 x`, `12 vezes`, `12 parcelas`, `em doze vezes`,
  `duas parcelas`;
- installment terms: `parcelado`, `parcelada`, `parcelei`, `parcelas`,
  `prestações`, `dividido em`, `sem juros`, `com juros`;
- one-charge terms: `1x`, `uma vez`, `uma parcela`, `à vista`, `crédito à
  vista`, `pagamento único`, `sem parcelar`, `não foi parcelado`;
- card evidence: a uniquely known card, `cartão`, `cartão de crédito`,
  `crédito`, or an explicit disambiguator such as `crédito Mercado Pago`;
- obligation evidence: `financiamento`, `empréstimo`, `consórcio`, recurring
  bills, boleto/debit plans, and existing-obligation payment language;
- amount semantics:
  - `3600 em 12x` = total amount;
  - `12x de 300`, `12 parcelas de 300`, `cada parcela 300` = per-installment;
  - consistent redundant values such as `3x de 50, total 150` are accepted;
  - conflicting redundant values require clarification.

The detector must preserve partial drafts. Missing amount, count, description,
or card should prompt only for that field instead of falling back to a flat
expense.

### 2.1 Canonical description contract

Every route must produce and test an explicit canonical description before a
confirmation can be persisted. Description cleanup is a shared final boundary,
not a best-effort behavior owned by a particular AI provider.

For card purchases and plain expenses, strip:

- amount expressions (`3600`, `R$ 300`, `mil e duzentos`);
- installment expressions (`em 12x`, `12x de 300`, `12 parcelas`,
  `parcelado`, `sem juros`);
- payment-instrument wording (`no crédito`, `no cartão`) and the resolved card
  name when it is only an instrument reference;
- purchase boilerplate (`comprei`, `compra de`, `passei`), dates,
  responsibility hints, and category instructions.

Preserve the meaningful product, service, or merchant. Merchant/item separation
still prefers the item when both exist. Obligation descriptions are cleaned
with obligation-aware rules so meaningful names such as `Parcela solar` are
not damaged by purchase-only stripping. If cleanup leaves no meaningful
description, ask the user for it and persist nothing.

Required exact regression:

```text
Input: Notebook em 12x de 300 no credito nubank
Route: card_installment
Description: Notebook
Per-installment amount: 30000
Installment count: 12
Card: Nubank
```

The description must equal `Notebook` in the initial draft, confirmation
message, installment group, and every generated installment. Values such as
`Notebook 12x`, `Notebook crédito`, or `Notebook Nubank` fail the test.

## 3. Hand-labelled 100-message corpus

### Expected-route legend

- `CI`: `card_installment` confirmation or partial installment draft.
- `PC`: `plain` one-charge card expense.
- `PA`: `plain` non-card expense.
- `OB`: recurring obligation/account-financed plan.
- `MP`: mark an existing obligation or card bill paid.
- `CL`: clarification required; nothing may persist.
- `NF`: non-financial; nothing may persist.

Every case becomes a fixture with: raw message, input kind, expected route,
**required expected canonical description**, amount kind (`total`,
`per_installment`, or `single`), amount in
cents when present, installment count when present, expected card resolution,
expected next conversation state, and whether persistence is allowed.

### A. True card installment purchases — 40 cases

| ID | Telegram message | Expected assertions |
|---|---|---|
| 001 | `Notebook 3600 em 12x no Nubank` | CI; description `Notebook`; total 360000; count 12; Nubank |
| 002 | `Notebook em 12x de 300 no credito nubank` | CI; description exactly `Notebook`; per installment 30000; total 360000; count 12; Nubank |
| 003 | `Airfryer no Mercado Livre, 600 em 6x no Nubank` | CI; description `Airfryer`; total 60000; count 6 |
| 004 | `TV 8 parcelas de 250 no C6` | CI; description `TV`; per installment 25000; total 200000; count 8 |
| 005 | `Geladeira de 4.800 parcelada em 10 vezes no Inter` | CI; description `Geladeira`; total 480000; count 10 |
| 006 | `Sofá 5400, parcelei em 18x no Nubank` | CI; description `Sofá`; total 540000; count 18 |
| 007 | `Curso 1200 dividido em 6 vezes no cartão Inter` | CI; description `Curso`; total 120000; count 6 |
| 008 | `Celular 4800 em 24x sem juros no Nubank` | CI; description `Celular`; total 480000; count 24 |
| 009 | `Óculos 800 em 4x com juros no C6` | CI; description `Óculos`; total 80000; count 4; do not invent interest-adjusted total |
| 010 | `Tênis de R$ 1.999,90 em 10x no Inter` | CI; description `Tênis`; total 199990; count 10 |
| 011 | `Mercado Livre 1.200,00 em 12 vezes usando Nubank` | CI; description `Mercado Livre`; total 120000; count 12 |
| 012 | `ml 1200 12x nubank` | CI; description `Mercado Livre`; total 120000; count 12; Nubank |
| 013 | `comprei um aspirador mil e duzentos em doze vezes no nubank` | CI; description `Aspirador`; voice-like; total 120000; count 12 |
| 014 | `iPhone 4800 12x Nubank` | CI; description `iPhone`; shorthand; total 480000; count 12 |
| 015 | `Comprei uma cadeira parcelada no Nubank` | CI partial; description `Cadeira`; missing amount/count; ask focused questions |
| 016 | `Notebook em 12x no cartão` | CI partial; description `Notebook`; count 12; missing amount/card selection |
| 017 | `Notebook 3600 em 12x` | CI partial; description `Notebook`; total 360000; count 12; ask card when needed |
| 018 | `Notebook 3600 em 12x no cartão XP` | CI; description `Notebook`; unknown card must open card picker, never invent XP id |
| 019 | `Notebook 3600 em 12x no crédito Mercado Pago` | CI; description `Notebook`; explicit credit resolves Mercado Pago card |
| 020 | `Notebook 3600 em 12x no Mercado Pago` | CI; description `Notebook`; total 360000; count 12; resolve registered Mercado Pago card |
| 021 | `Comprei a TV ontem por 2400 em 12x no Nubank` | CI; description `TV`; total 240000; count 12; yesterday date |
| 022 | `Geladeira 3000 em 10x no Inter dia 12/08` | CI; description `Geladeira`; explicit purchase date; count 10 |
| 023 | `Karol comprou um celular 2400 em 12x no Nubank` | CI; description `Celular`; responsibility hint Karol; count 12 |
| 024 | `Farmácia 300 em 3x no cartão, categoria saúde` | CI; description `Farmácia`; total 30000; count 3; category is only a hint |
| 025 | `Furadeira na Leroy Merlin por 600 em 6x no Nubank` | CI; description `Furadeira`; item prioritized over merchant; total 60000; count 6 |
| 026 | `Comprei no Magazine Luiza uma máquina de lavar de 3600 em 12x no Inter` | CI; description `Máquina de lavar`; total 360000; count 12 |
| 027 | `PS5 3500 10x C6` | CI; description `PS5`; shorthand; total 350000; count 10 |
| 028 | `Mesa 900 em nove vezes no Nubank` | CI; description `Mesa`; spelled count 9 |
| 029 | `Ventilador 200 em duas parcelas no Inter` | CI; description `Ventilador`; count 2; total 20000 |
| 030 | `Fone 300 em 2x no Nubank` | CI; description `Fone`; lower boundary count 2 |
| 031 | `Carro usado, entrada já paga, saldo 48000 em 48x no cartão` | CI only if explicit card remains credible; description `Carro usado`; total 4800000; count 48 |
| 032 | `Comprei uma cama 🛏️ por 1800 em 6x no Inter` | CI; description `Cama`; emoji tolerated; total 180000; count 6 |
| 033 | `R$1200 em 12x - Nubank - Mercado Livre` | CI; description `Mercado Livre`; punctuation variant; total 120000; count 12 |
| 034 | `Mercado Livre: 8 parcelas de R$ 75,00 no Mercado Pago` | CI; description `Mercado Livre`; per installment 7500; total 60000; count 8 |
| 035 | `Notebook em 10 prestações de 350 no cartão Nubank` | CI; description `Notebook`; per installment 35000; total 350000; count 10 |
| 036 | `Cada parcela da cadeira ficou 89,90, são 5 vezes no Inter` | CI; description `Cadeira`; per installment 8990; total 44950; count 5 |
| 037 | `Total 899 pelo celular em 9x no C6` | CI; description `Celular`; total 89900; count 9 |
| 038 | `Cadeira parcelada no Nubank, 3 parcelas, 150 no total` | CI; description `Cadeira`; total 15000; count 3 |
| 039 | `Cadeira 3x de 50, total 150, no Inter` | CI; description `Cadeira`; consistent redundant amounts; count 3; total 15000 |
| 040 | `eu comprei uma cadeira de escritório por novecentos reais e dividi em seis vezes no cartão inter` | CI; description `Cadeira de escritório`; voice-like; total 90000; count 6 |

### B. Normal one-charge credit purchases — 25 cases

These are critical negative controls: every case is `plain`, never
`card_installment`, and confirmation creates one transaction with no
installment group.

| ID | Telegram message | Expected assertions |
|---|---|---|
| 041 | `Mercado 230 no Nubank` | PC; description `Mercado`; single 23000; Nubank |
| 042 | `Posto 100 no crédito` | PC; description `Posto`; single 10000; choose/resolve card |
| 043 | `Farmácia 45 no cartão Inter` | PC; description `Farmácia`; single 4500; Inter |
| 044 | `Notebook 3600 em 1x no Nubank` | PC; description `Notebook`; explicit one charge; Nubank |
| 045 | `Notebook 3600 em uma vez no Nubank` | PC; description `Notebook`; explicit one charge |
| 046 | `Notebook 3600 à vista no crédito` | PC; description `Notebook`; explicit one charge |
| 047 | `Notebook 3600 em uma parcela no Nubank` | PC; description `Notebook`; explicit one charge |
| 048 | `Monitor 600, compra única no cartão C6` | PC; description `Monitor`; payment unique |
| 049 | `Uber 32 no crédito Nubank` | PC; description `Uber`; single 3200 |
| 050 | `iFood 68,90 no C6` | PC; description `iFood`; single 6890; C6 |
| 051 | `Hotel 750 no cartão Inter` | PC; description `Hotel`; single 75000 |
| 052 | `Passei 250 no cartão` | PC; description missing, so ask user and persist nothing; never CI |
| 053 | `Mercado 100 no crédito` | PC; description `Mercado`; multiple cards may open payment picker; never installment picker |
| 054 | `Mercado 100 no Nubank` | PC; description `Mercado`; if Nubank account/card ambiguous, ask payment instrument; never CI |
| 055 | `Mercado 100 no Mercado Pago` | PC; description `Mercado`; single 10000; resolve registered Mercado Pago card; never CI |
| 056 | `Tênis 400 no cartão de crédito` | PC; description `Tênis`; one charge; choose card if needed |
| 057 | `Tênis 400 no crédito à vista` | PC; description `Tênis`; one charge |
| 058 | `Tênis 600, 1 parcela de 600, Nubank` | PC; description `Tênis`; consistent single charge; no group |
| 059 | `Mochila 300 em uma prestação no cartão Inter` | PC; description `Mochila`; one charge despite word prestação |
| 060 | `Celular 2000 no Nubank sem parcelar` | PC; description `Celular`; explicit negative installment evidence |
| 061 | `A cadeira de 500 no Inter não foi parcelada` | PC; description `Cadeira`; explicit negative installment evidence |
| 062 | `Mercado no cartão Nubank, pagamento único de 250` | PC; description `Mercado`; single 25000 |
| 063 | `Comprei no crédito ontem, 180 reais, cartão C6` | PC; description missing, so ask user and persist nothing; yesterday date; single 18000 |
| 064 | `Assinatura anual 120 no cartão Nubank cobrada de uma vez` | PC; description `Assinatura anual`; one annual charge, not recurring obligation |
| 065 | `Mercado 100 no cartão da Karol` | PC; description `Mercado`; responsibility/card resolution; never CI |

### C. Plain non-card expenses — 10 cases

| ID | Telegram message | Expected assertions |
|---|---|---|
| 066 | `Mercado 230 no Pix` | PA; description `Mercado`; single 23000; account-funded |
| 067 | `Padaria 28 em dinheiro` | PA; description `Padaria`; single 2800; no card |
| 068 | `Farmácia 45 no débito Nubank` | PA; description `Farmácia`; account/debit; never CI |
| 069 | `Uber 32 na conta Inter` | PA; description `Uber`; account Inter |
| 070 | `Escola 500 no boleto` | PA; description `Escola`; unless explicit recurring-plan evidence exists |
| 071 | `Almoço 75` | PA; description `Almoço`; default account path |
| 072 | `Ontem gastei 84,50 no mercado` | PA; description `Mercado`; yesterday; default account |
| 073 | `paguei trinta e dois reais no café hoje cedo` | PA; description `Café`; voice-like; single 3200 |
| 074 | `Cinema R$ 60,00 dinheiro` | PA; description `Cinema`; cash/default-account policy; never CI |
| 075 | `Conta de luz deste mês 210 no débito` | PA; description `Conta de luz`; one-off payment, not a new recurring obligation without recurrence language |

### D. Obligations and non-card financing — 10 cases

| ID | Telegram message | Expected assertions |
|---|---|---|
| 076 | `Parcela solar 710,44 72x a partir de 05/10` | OB; description `Parcela solar`; monthly 71044; term 72; no card group |
| 077 | `Financiamento do carro 1500 por 48 meses` | OB; description `Financiamento do carro`; monthly 150000; term 48 |
| 078 | `Empréstimo 24 parcelas de 500 debitadas na conta` | OB; description `Empréstimo`; monthly 50000; term 24 |
| 079 | `Aluguel 1200 todo mês dia 10` | OB; description `Aluguel`; indefinite recurring; due day 10 |
| 080 | `Internet 119,90 mensal no débito` | OB; description `Internet`; indefinite recurring; monthly 11990 |
| 081 | `Academia 99 todo mês na conta Nubank` | OB; description `Academia`; recurring account charge; not card installment |
| 082 | `Curso parcelado no boleto, 10 boletos de 200` | OB; description `Curso`; monthly 20000; term 10; no card group |
| 083 | `Consórcio 850 por 60 meses` | OB; description `Consórcio`; monthly 85000; term 60 |
| 084 | `IPTU em 10x no boleto, parcela de 180` | OB; description `IPTU`; monthly 18000; term 10 |
| 085 | `Placas solares 51.000 em 72x no financiamento` | OB; description `Placas solares`; total-to-month semantics; term 72; no card group |

### E. Payment messages that must not create purchases — 5 cases

| ID | Telegram message | Expected assertions |
|---|---|---|
| 086 | `Nubank pago` | MP; target description `Nubank`; card bill; never create purchase/installment |
| 087 | `Paguei a fatura do Inter 2350` | MP; target description `Inter`; card bill with actual paid amount 235000 |
| 088 | `Parcela solar paga` | MP; target description `Parcela solar`; existing obligation; never create a new obligation or installment group |
| 089 | `Paguei o financiamento do carro este mês` | MP; target description `Financiamento do carro`; resolve or ask which obligation |
| 090 | `Fatura Mercado Pago quitada` | MP; target description `Mercado Pago`; resolve registered Mercado Pago card bill |

### F. Contradictory, invalid, or ambiguous messages — 8 cases

| ID | Telegram message | Expected assertions |
|---|---|---|
| 091 | `Notebook 3600 parcelado em 1x no Nubank` | CL; candidate description `Notebook`; ask à vista versus 2+ installments; persist nothing |
| 092 | `Notebook 3600 em 0x no Nubank` | CL; candidate description `Notebook`; invalid count; persist nothing |
| 093 | `Notebook 3600 em -3x no Nubank` | CL; candidate description `Notebook`; invalid count; persist nothing |
| 094 | `Parcela 3 de 10 do notebook 300 no Nubank` | CL; candidate description `Notebook`; existing-parcel observation versus new purchase; do not create a new group |
| 095 | `Notebook entrada 500 mais 10x de 200 no Nubank` | CL; candidate description `Notebook`; compound entry-plus-installments unsupported; do not misstate total |
| 096 | `Notebook 3x de 50, total 200, no Inter` | CL; candidate description `Notebook`; conflicting redundant amounts; persist nothing |
| 097 | `710 reais em 72x` | CL; description missing, so ask; insufficient card versus financing context; persist nothing |
| 098 | `Paguei a parcela do carro 900` | CL/MP; target description `Carro`; resolve existing obligation; never infer a new card purchase |

### G. Non-financial controls — 2 cases

| ID | Telegram message | Expected assertions |
|---|---|---|
| 099 | `Bom dia, tudo bem?` | NF; expected financial description absent; no draft persistence beyond safe conversation response |
| 100 | `Qual a previsão do tempo hoje?` | NF; expected financial description absent; no financial write |

## 4. Automated test layers

### 4.1 Corpus fixture and pure detector tests

- Store the 100 cases as a versioned fixture consumed by parameterized tests.
- Assert the expected deterministic route, exact canonical description, and
  extracted strong evidence for every case.
- For cases with a meaningful description, assert equality rather than
  substring containment so suffixes such as `12x`, `crédito`, or a card name
  cannot leak through unnoticed.
- For cases whose expected description is missing, assert that the bot asks for
  it and that no financial write occurs.
- Assert all 25 PC cases are never `card_installment`.
- Assert all 40 CI cases never become flat expenses when AI returns `null`,
  times out, or incorrectly returns `plain`.
- Assert every CL/NF case performs no financial write.

### 4.2 Conversation routing tests

For representative cases in every partition, assert:

- next status and draft type;
- missing-field question;
- card/account ambiguity handling;
- total versus per-installment semantics;
- exact description in the draft and confirmation message;
- typed and callback confirmation parity;
- state survives JSON/DB round-trip;
- ordinary one-charge credit creates one transaction and no installment group.

### 4.3 Webhook tests without a pre-baked successful intent

Replace or supplement the current installment story with scenarios where:

- classifier returns `null`;
- classifier times out;
- classifier incorrectly returns `plain`;
- classifier returns a valid installment;
- classifier incorrectly returns `card_installment` for `1x`;
- voice transcription produces installment and one-charge-credit variants.

The webhook must exercise the real deterministic detector and conversation
router instead of injecting the outcome under test.

### 4.4 Database-backed integration

Using the disposable/local Supabase test environment:

- CI confirm creates one installment group plus exactly N installments;
- PC confirm creates one transaction and zero installment groups/installments;
- persisted group, generated installments, and flat transaction descriptions
  exactly match the fixture's canonical description;
- RPC failure produces the recovery message and no partial rows;
- ambiguous/invalid cases create nothing;
- repeat confirmation does not duplicate writes.

## 5. Safe production diagnostics

Add structured telemetry without raw financial text:

- correlation id;
- input kind (`text`/`audio`);
- provider outcome and fallback reason;
- deterministic evidence result;
- final mapped intent;
- conversation state transition;
- persistence operation and success/failure class.

Distinguish provider completion success, schema validation success, semantic
mapping success, and final conversation routing. Do not log message content,
amounts, descriptions, card ids, user ids, or chat ids.

## 6. Implementation sequence

1. Add the 100-case fixture and failing routing tests first.
2. Implement the pure deterministic evidence detector.
3. Integrate precedence into `startConversation` without changing downstream
   confirmation/persistence behavior.
4. Add focused clarification replies and partial-draft transitions.
5. Add webhook and database-backed integration coverage.
6. Add privacy-safe routing telemetry.
7. Run bot tests, typecheck, lint/build, and a real structured-output smoke.
8. Deploy only the bot after explicit approval.
9. Run controlled Telegram CI and PC smoke messages and verify database rows
   plus telemetry.

## 7. Acceptance criteria

- Every one of the 100 hand-labelled cases passes its expected route.
- Every case passes its explicit expected-description assertion; meaningful
  descriptions contain no leaked amount, installment, credit, or card syntax.
- `Notebook em 12x de 300 no credito nubank` produces exactly `Notebook` in the
  draft, confirmation, parent group, and generated installments.
- All explicit `2x+` card installment purchases reach installment confirmation
  even with every AI provider unavailable.
- All normal one-charge credit variants remain `plain` card expenses.
- Credit/card wording by itself never produces `card_installment`.
- Financing/account-recurring messages never produce card installment groups.
- Missing or ambiguous fields prompt for correction instead of being guessed.
- CI confirmation creates exactly one group plus N installments and no flat
  transaction.
- PC confirmation creates exactly one transaction and no group/installments.
- Text and voice-transcribed inputs follow the same boundaries.
- Production telemetry can identify the final route without exposing financial
  content or identifiers.

## Out of scope

- Changing web transaction-entry behavior.
- Changing installment due-month/accounting semantics.
- Supporting entry payments plus a financed remainder in one Telegram message;
  those messages require clarification until explicitly designed.
- Editing or deleting existing installment groups through Telegram.
- Deploying, publishing, opening a PR, or changing production before separate
  explicit approval.
