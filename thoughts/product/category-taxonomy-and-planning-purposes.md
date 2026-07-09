# Category taxonomy and planning purposes

**Status:** product/design direction, not implemented

**Date:** 2026-07-09

## Goal

Let the family answer two different questions without forcing one taxonomy to do
both jobs:

1. **What was this?** Category and optional subcategory.
2. **Why are we allocating money to it?** Planning purpose.

The current database already supports `category -> subcategory`. It does not
support a separate planning purpose, ranked category candidates, merchant
canonicalization, or pending subcategory proposals. Those are future behavior
and schema changes; this note does not implement them.

## Separate dimensions

Planning purposes are household budget/envelope concepts. Initial candidates:

- **Essenciais** — groceries, health, necessary transport, education.
- **Custos fixos** — recurring bills, contracts, financing, housing commitments.
- **Metas** — holidays, travel, renovation, and other finite goals.
- **Independência financeira** — investing and allocations to the children's
  caixinhas.
- **Lazer** — restaurants, outings, events, and entertainment.
- **Conforto** — household conveniences, an air fryer, housekeeping, and treats.

These names need a short household brainstorm before seeding. In particular,
`Essenciais` fills the gap for necessary variable costs that are not fixed.

Categories describe the purchase or movement itself. A starting catalog could be:

- **Alimentação:** Mercado, Restaurante, Delivery.
- **Contas:** Energia, Água, Internet, Telefonia, Assinaturas.
- **Moradia:** Reforma, Manutenção, Energia solar, Housekeeping.
- **Comprinhas/Mimos:** Casa, Eletrodomésticos, Pessoal.
- **Rolezinhos:** Passeios, Eventos.
- **Viagem:** Hospedagem, Passagens, Alimentação em viagem.
- **Investimentos:** Reserva, Filhos, Independência financeira.
- **Transporte, Saúde, Educação, Receitas, Outros.**

Names and hierarchy are examples, not a seed decision. The important constraint
is that a planning purpose is not implemented as a macro category. The same
category can serve different purposes: `Moradia > Reforma` may be a Meta,
`Moradia > Energia solar` may be a Custo fixo, and a household convenience may
be Conforto. Purpose therefore belongs on the financial event, with optional
merchant/category defaults that the user can override.

## Accounting semantics

`Independência financeira` is not consumption and must not count as expense or
spend. Contributions to investments or children's caixinhas are transfers/outflows:

- **Consumo / gasto:** sum only `expense` events. Existing spending reports stay
  unchanged.
- **Aportes de independência financeira:** sum qualifying `transfer` events to
  investment/caixinha destinations.
- **Saldo disponível (visual):** income minus consumption expenses minus those
  qualifying financial-independence transfers.

This lowers the money shown as available to spend without claiming that the
family consumed it. Net worth is unchanged by an internal investment transfer.
Ordinary account-to-account transfers do not reduce available balance unless
they are explicitly an allocation. Card-bill settlement transfers must also be
excluded because the underlying card purchases already reduced the relevant
spending/available view; subtracting the settlement would double count.

Future data modeling should link allocation transfers to the existing
`investment_buckets` (or an equivalent destination ledger). The current
caixinhas store manually edited balances and do not yet provide a contribution
ledger.

## Merchant aliases and memory

A merchant profile should be household-scoped and auditable:

- match pattern or aliases, accent/case insensitive;
- canonical display name;
- optional default category/subcategory;
- optional default planning purpose;
- active/archived state and source (`seed`, user correction, import).

Example: `GIASSI`, statement variants, and known store suffixes normalize to
description `Giassi`, then suggest `Alimentação > Mercado`. Categorization memory
currently stores only substring -> category/subcategory; it cannot canonicalize
the description, so merchant aliases should not be hidden inside that table.

Common Brazilian merchants may be pre-seeded, but household corrections win.
Changing only `supabase/seed.sql` affects fresh environments; an existing
production household needs an idempotent migration/backfill or an explicit
catalog-management flow.

## Ambiguity and top-three suggestions

Merchant-only descriptions can be inherently ambiguous. `Mercado Livre` does
not reveal whether the family bought furniture, a gift, or electronics. The bot
should not manufacture certainty.

When evidence is insufficient, return up to three ranked existing category paths:

- one-tap buttons, highest-ranked first;
- short explanations grounded in merchant history, message text, or household
  patterns;
- an explicit `Outra categoria` / `Sem categoria` path;
- no automatic persistence before confirmation.

Ranking should prefer confirmed household history, then deterministic merchant
profiles/rules, then model suggestions. A model's self-reported confidence is
supporting metadata, not the only ranking signal.

The current categorizer returns one candidate. An implementation will need a
candidate-list/ambiguous result rather than overloading the existing single
`suggestion` field.

## New category and subcategory proposals

The model may propose a genuinely useful name, but it must remain pending until
the user accepts it.

- Distinguish a new macro category from a new subcategory under an existing macro.
- Offer existing close matches before creating anything.
- Let the user accept, choose a different parent, rename, or reject the proposal.
- Deduplicate case- and accent-insensitively, including archived entries.
- Seed memory only after the financial draft and accepted taxonomy change persist.

Today, an unknown macro can become a pending new category, but an unknown
subcategory under a known macro is silently dropped and the bot can create only
macro categories. That behavior must change before the proposed two-level
catalog can be managed safely through chat.

The database should also enforce that a selected subcategory belongs to the
selected category. Same-household composite foreign keys from migration `0013`
prevent cross-household references, but they do not by themselves guarantee the
category/subcategory parent pair.

## Reference examples

- `Compra no Mercado Livre de 3600 reais em 12 vezes, usando o Nubank`:
  card-installment intent, canonical merchant `Mercado Livre`, total R$ 3.600,
  12 installments, Nubank card, and up to three category choices because the
  item is unknown.
- `Conta recorrente nova, Placas solares em 72x de 710,44`:
  obligation intent, description `Placas solares`, R$ 710,44/month for 72 months,
  category `Moradia > Energia solar`, planning purpose `Custos fixos`.
- `Adicionar compra no Giassi, X reais, Mercado Pago`:
  plain expense, description exactly `Giassi`, category
  `Alimentação > Mercado`, Mercado Pago card.

Exact category labels in automated tests should follow the approved household
catalog rather than freezing these brainstorm examples prematurely.

## Model evaluation

Build a versioned, anonymized pt-BR dataset containing ordinary expenses,
obligations, card installments, bill settlement, merchant cleanup, ambiguous
categories, corrections, and abstention cases. Compare Claude and GPT candidates
on exact intent/field accuracy, top-three category usefulness, invalid invention,
latency, and cost. Use Codex to review the prompt and dataset for leakage,
contradictory labels, missing edge cases, and weak expected outputs before using
scores to select a production model.

## Implementation sequence after approval

1. Approve purpose names and the initial category/subcategory catalog.
2. Define accounting queries and transfer destinations before changing dashboard
   totals.
3. Design the purpose and merchant-profile schema plus safe production backfill.
4. Extend categorization contracts for ranked candidates and pending subcategories.
5. Add chat/web confirmation UX and parent-pair validation.
6. Run the model evaluation before changing the production default.
