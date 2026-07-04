# MASTER PROMPT — cole no Claude design (tudo abaixo da linha)

> Este é o prompt pronto para uso. Fonte canônica:
> `docs/superpowers/specs/2026-07-01-ui-redesign-claude-design-prompt.md` (commit `e6ff9b3`).
> Anexe, se possível: screenshot da landing do chá de casa nova (vibe) + screenshot do
> dashboard atual (o que substituir). Traga os mockups de volta — eles destravam o plano
> da Fase 1 (UI foundation).

---

Quero o redesign completo da UI do **app de finanças da nossa família** (eu e minha
esposa Karol). O app funciona, mas a cara atual é "B2B SaaS genérico" — sidebar escura
qualquer, cards brancos, cinza por todo lado. Esse app é da **nossa casa**: precisa ser
aconchegante, bonito de abrir todo dia, com cara de coisa nossa — não de ferramenta de
trabalho.

## A vibe (obrigatória, não sugerida)

A referência é a landing page do nosso chá de casa nova, cuja direção de design se chama
**"Editorial acolhedor"**: sensação de convite impresso, elegante sem ser frio, quente
sem ser infantil. Replique esta linguagem fielmente:

**Cores — dois temas, CSS custom properties:**

Esmeralda (escuro, TEMA PADRÃO):
- fundo da página `#16352B` (verde esmeralda profundo)
- superfície de card `#1E4133`, painel suave `#1A3A2E`
- texto `#F2EDE0` (marfim quente), texto secundário `rgba(242,237,224,0.66)`
- **acento dourado antigo `#D4AF6A`** (hover `#E4C488`) — ícones, kickers, botões,
  estados ativos. É a cor-assinatura.
- bordas `rgba(212,175,106,0.24)`, wash dourado `rgba(212,175,106,0.14)`
- texto sobre dourado: `#16352B`

Sálvia (claro, alternativo — o app tem toggle):
- fundo `#E8EDE3`, card `#F7F9F3`, painel `#EFF3EA`
- texto `#2E3A2A`, secundário `#5F6B58`
- acento `#A8853C` (hover `#C2A258`), borda `#CBD6C0`, sobre acento `#FFFFFF`

Semânticas que o app de finanças precisa e a landing não tinha — derive em harmonia com
a paleta (nada de verde-limão/vermelho-alarme de dashboard B2B):
- `positive` (receitas/saldo bom), `negative` (despesas — família do vermelho-terroso
  `#B4552F`), `warn` (pendente de revisão — âmbar na família do dourado).

**Tipografia:**
- Títulos/display: **Playfair Display** 500/600 (serif — é o que dá o ar de convite).
- Corpo/UI: **Inter** 300-600.
- Kickers/eyebrows: Inter uppercase com letter-spacing largo (0.15-0.3em) — ex.
  "GASTO DO MÊS", "NOSSA CASA".

**Forma e profundidade:**
- Cantos 10-16px em cards/botões/inputs; pills 999px para chips, badges, tabs.
- Bordas hairline 1px (cor de borda do tema) em quase todo card — linguagem de convite.
- Sombras SEMPRE quentes: `rgba(20,14,8, 0.05-0.16)` — nunca preto puro.
- Ícones line-art traço ~1.5-2, monocromáticos (currentColor), cantos arredondados.
- Animações curtas e contidas (0.15-0.5s): fade+slide de painéis, pop de badges,
  `translateY(-1px)` em hover de card.

**Tom de copy (pt-BR, em todas as telas):**
Quente, íntimo, primeira pessoa do plural, diminutivos naturais — "a gente", "nossa
casa", "caixinhas". Exemplos do estilo: "Sua presença é o presente mais importante",
"Mais que presentes, queremos a sua presença". No app: "Como estão as contas da casa?",
"Tudo revisado por aqui ✨", "Falta categorizar 3 lançamentos". Nunca corporativês
("Gerencie suas transações" → não).

## O app (contexto funcional)

Next.js App Router, tudo em pt-BR. Estrutura: sidebar de navegação + conteúdo. Páginas:
**Resumo** (novo), **Dashboard**, **Transações** (novo), **Importação**, **Categorias**,
**Contas**, **Cartões**, **Investimentos** (caixinhas), **Configurações** (novo).
Conceitos: transações de conta ou cartão de crédito; parcelamentos (compras em N
parcelas com projeção mensal); "pendente de revisão" = lançamento sem categoria;
caixinhas de investimento com saldo; importação de CSV/fatura PDF com preview antes de
gravar; membros: Alvaro, Karol e "a casa" (responsável pelo gasto).

## Entregáveis (nesta ordem de prioridade)

Para cada tela: mockup HTML/CSS (ou JSX) completo, tema Esmeralda, mobile-first + versão
desktop (sidebar). Use dados realistas em pt-BR (mercado, farmácia, parcela 3 de 10 da
geladeira, caixinha "reserva de emergência"...), valores em R$.

1. **Design system base** — tokens dos dois temas, tipografia, e os componentes: Card,
   StatCard (kicker uppercase + número grande + delta), Badge (pendente/duplicata/novo/
   parcelamento), Button (primário dourado/ghost), Table (com colapso para lista de
   cards no mobile), inputs/selects, EmptyState, PageTitle serif, o app shell com
   sidebar (que também vira bottom-nav ou drawer no mobile) e o theme picker flutuante
   discreto (bolinhas de cor, como na landing).

2. **`/resumo` — A TELA MAIS IMPORTANTE.** Dashboard simplificado pra olhada de 10
   segundos no celular durante o dia — a persona é a Karol conferindo as contas na fila
   do mercado. Sem filtros, sem tabelas densas. Conteúdo: saudação (serif) + mês; gasto
   do mês em número GRANDE com comparação amigável vs mês passado ("R$ 320 a menos que
   junho 🌱"); fatura projetada de cada cartão; pendentes de revisão (chip com link);
   últimos 5 lançamentos (valor + descrição + quem). Hierarquia tipográfica forte,
   legível de longe, zero jargão.

3. **Dashboard completo** — visão do mês: resumo mensal (receitas/despesas/saldo),
   pressão dos cartões por mês (projeção de parcelas), caixinhas com saldos, últimos
   lançamentos, pendências. Pode ser denso, mas dentro da linguagem.

4. **Transações** — barra de filtros (stepper de mês, selects de conta/cartão/categoria/
   responsável, pill "pendentes"), tabela com edição inline de categoria/descrição/
   responsável, badge âmbar nos pendentes, exclusão com confirmação. Mobile: lista de
   cards.

5. **Importação** — o fluxo atual em 3 passos (enviar arquivo → revisar preview →
   confirmar), incluindo o painel "Parcelamentos detectados" (grupos inferidos da fatura
   com total/parcelas/data editáveis e badges "novo"/"já existe") e badges de duplicata
   ("duplicata provável", "já importada").

6. **Configurações** — theme picker, membros da casa (nome de exibição + Telegram
   vinculado), status do bot ("último lançamento pelo bot: hoje 14:32 🎙️").

7. **Telas restantes** (Categorias, Contas, Cartões, Investimentos, Login) — aplicação
   direta do design system, menos detalhamento.

## Restrições técnicas

- Sem biblioteca de componentes (nada de shadcn/MUI) — componentes próprios simples,
  estilizáveis com CSS vars. Pode usar CSS puro ou styled inline, como preferir mostrar.
- Google Fonts (Playfair Display + Inter) com preconnect.
- Acessibilidade: contraste AA nos pares texto/fundo dos DOIS temas (atenção ao dourado
  sobre esmeralda em texto pequeno — use dourado para acento/título, não para corpo).
- Os mockups devem ser fiéis o suficiente para um dev portar direto para React/Next
  sem redesenhar nada.
