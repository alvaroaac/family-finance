# Obrigações page redesign — design (option A)

**Status:** approved by Alvaro on 2026-09-04 ("go with option A, ship").
**Mockups:** `docs/design/2026-09-04-obrigacoes-mockups/` (Main, Mobile,
NovaObrigacao, EditarObrigacao — Claude Design artboards; open the canvas at
https://claude.ai/code/artifact/eea06b8a-3b49-42a9-aed5-681552bb2ff8).
**Feature context:** `thoughts/features/recurring-obligations/design.md`
(obligation = template; projections computed; marking paid materializes a
transaction).

## Problem

`/obligations` today: the 12-month list repeats every obligation's name and
amount on every row (pure noise — nothing changes month to month); every
obligation card carries an always-visible inline edit form plus a danger
"Cancelar" button that reads like "cancel the edit" but ends the obligation;
creating one is a flat 7-field grid with a cryptic "Prazo (meses, vazio = sem
prazo)" field. B2C product for a couple; it must read like a household
checklist, not an admin table.

## What changes (page, top to bottom)

1. **Header** — kicker "Nossa casa", h1 "Obrigações fixas", lead
   "Financiamentos e contas que se repetem todo mês — projetados, não
   lançados." Primary button "+ Nova obrigação" on the right (desktop) /
   sticky at the bottom (mobile). Opens the create dialog.
2. **Three stats** (`StatCard`):
   - "Comprometido por mês" — sum of all ACTIVE templates' monthly amount.
     Hint: "N ativas", plus " · a partir de <mês>" when at least one active
     template starts after the current month (the latest such start).
   - "Este mês · <mês>" — "R$ paid de R$ total" as value + a progress bar
     (positive fill) + hint "x de y pagas".
   - "Próximo vencimento" — relative label ("hoje", "amanhã", "em N dias",
     or "atrasada · dia D" when the earliest unpaid due day already passed);
     hint "<obrigação> · dia D". Falls back to next month's first entry when
     this month is fully paid; "—" when nothing is projected.
3. **Este mês checklist** (card): unpaid entries sorted by due day. Each row:
   day chip ("DIA 05"), name + sub ("Conta · categoria" when known),
   status badge, amount, button "Marcar como paga" (existing payment
   dialog). Row states: overdue (dueDay < today) → negative wash + inset
   stripe + badge "atrasada"; due today/tomorrow/≤3 days → warn wash + badge
   "vence hoje" / "vence amanhã" / "vence em N dias"; otherwise plain. Paid
   entries at the bottom, faded (`ff-off`), check bubble, badge "paga",
   sub "Paga em D de mmm · Conta", and a link-button "desfazer" that deletes
   the materialized transaction (undo).
4. **Próximos 12 meses** (card): one row per month = month label, a
   proportional bar (width ∝ month total / max total; the paid slice of the
   current month in positive color), total on the right. A row gets a badge
   ONLY when something changes that month: "+ <nome> · R$ x" (template
   starts), "última parcela · <nome>" (last month of a term), "− <nome>
   quitada · R$ x" (first month after a term ends). Note under the title:
   "Só o que muda de um mês pro outro aparece marcado. Clique num mês pra ver
   o detalhe." plus, when some term ends inside the window, "↓ alívio de
   R$ x/mês a partir de <mês>". Each row is a `<details>` — open shows the
   month's entries (name · dia D · amount, paid ones marked). The first row
   carrying a badge is open by default; none open when no month changes.
5. **Suas obrigações** (card): desktop `Table` (Obrigação / Prazo / Por mês
   / actions), mobile `RowCardList`. Row: icon bubble, name, sub "vence dia
   D · Conta · categoria"; term cell = progress "n de N pagas · até mmm/aaaa"
   with a track, or badge "sem prazo", or "começa em mmm/aaaa · N parcelas"
   for future starts; amount; pencil icon-button → edit dialog. Footer: link
   "ver encerradas →" (toggles `?encerradas=1`, which appends a faded list of
   ended/canceled templates) and the total "R$ x por mês".

## Create dialog ("Nova obrigação", 720px, `ff-dialog--transaction`)

Four numbered sections, one column each on mobile:

1. **O que é** — Nome (placeholder "Placas solares"), Valor por mês (R$).
2. **Quando** — Primeira parcela: month `Select` listing current month − 3
   … current month + 12 (labels "outubro de 2026"), default current month;
   hint "Já pagou alguma? Escolha o mês da primeira parcela — as passadas
   você marca depois." Vence todo dia: number 1–28.
3. **Por quanto tempo** — segmented control "Sem prazo | Parcelado". When
   Parcelado: "Quantas parcelas" number ≥ 1 and a live badge
   "até mmm/aaaa · total R$ x". Helper: "Sem prazo = todo mês até você
   encerrar (aluguel, plano de saúde). Parcelado = acaba sozinho na última
   parcela (financiamento, carnê)."
4. **Sai de onde** — Conta (required), Categoria (optional, "Sem categoria
   (a definir)").

Accent-edge summary card (live, plain Portuguese, same sentence the bot
confirms): "<Nome> — R$ x por mês, N vezes, de mmm/aaaa a mmm/aaaa. Vence dia
D, sai da <Conta>." (no-term variant: "todo mês a partir de mmm/aaaa").
Second line, when the start month is inside the 12-month window: "A partir
de <mês>, o mês da casa passa a R$ y." (y = that month's projected total +
the new amount). Actions: "Cancelar" (ghost) / "Criar obrigação" (primary,
pending "Criando…"). Errors inline (`ff-alert--negative`) + toast; success
toast "Obrigação criada." and dialog closes.

## Edit dialog ("Editar obrigação · <Nome>", 720px)

- Read-only progress panel (soft card): "Parcela n de N · começou em
  mmm/aaaa · termina em mmm/aaaa", "faltam R$ x", track; or "Sem prazo ·
  desde mmm/aaaa". Note: "Prazo e primeiro mês não mudam — pra isso, encerre
  esta e crie outra."
- Editable: Nome, Valor por mês (hint "Vale para os meses ainda não
  pagos."), Vence todo dia, Conta, Categoria.
- Actions: "Cancelar" / "Salvar alterações" (pending "Salvando…").
- Danger zone below a divider: title "Encerrar obrigação", copy "Some dos
  próximos meses. O que já foi pago continua nas transações.", ghost-danger
  button "Encerrar…". Clicking reveals a confirm row (negative wash, inset
  stripe): "Encerrar <Nome>? A partir de <próximo mês>, esta obrigação sai
  dos próximos meses. As n parcelas pagas continuam nas transações." with
  "Deixa pra lá" / "Sim, encerrar" (danger-solid). Success toast
  "Obrigação encerrada."

## Behaviour / data decisions

- Undo payment = delete the materialized transaction (it carries
  `obligation_id` + `obligation_month`). Refuse when the row is not an
  obligation payment of this household.
- Editing amount/due day applies to every not-yet-paid month (existing
  semantics; the hint says so). Account/category edits now allowed (the
  repository already supports them); ownership of the chosen account /
  category is verified like on create.
- Server actions return `{ ok, error? }` (like transactions) so dialogs
  show inline errors; they never throw to the client.
- "today" = household calendar date (`currentHouseholdDate`), never the
  server's UTC day.
- Mobile ≤ 720px: stacked stats (2 columns), row cards, sticky CTA.

## Out of scope

Alternative B (obligation × month grid), variable-amount obligations,
editing term/start month, bulk "mark all paid", Playwright coverage.
