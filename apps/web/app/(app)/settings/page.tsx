import { cookies } from "next/headers";

import { requireAuthorizedUser } from "../../../lib/auth";
import { Badge, Card, IconHome, PageTitle } from "../../../components/ui";
import {
  loadSettingsData,
  botStatusLabel,
  inputKindLabel,
  parseTheme,
  THEME_COOKIE,
} from "./queries";
import { ThemePicker, MemberRow } from "./settings-forms";

export const metadata = {
  title: "Configurações — Casa",
};

// Per-request, RLS-scoped data; never statically prerender.
export const dynamic = "force-dynamic";

/**
 * "/settings" — Configurações da casa: tema (Esmeralda/Sálvia via cookie),
 * perfis dos membros (nome de exibição + Telegram vinculado + papel) e o
 * cartão de status do bot ("o bot tá vivo?").
 */
export default async function SettingsPage() {
  await requireAuthorizedUser();
  const cookieStore = await cookies();
  const activeTheme = parseTheme(cookieStore.get(THEME_COOKIE)?.value);
  const { members, lastBotInteraction, loadError } = await loadSettingsData();

  return (
    <section style={{ maxWidth: 880, margin: "0 auto" }}>
      <PageTitle
        kicker="Nossa casa"
        title="Configurações"
        lead="O jeitinho da casa: tema, quem somos e o bot."
      />

      {loadError ? (
        <div role="alert" className="ff-alert ff-alert--negative" style={{ marginTop: 20 }}>
          Não foi possível carregar as configurações agora. ({loadError})
        </div>
      ) : null}

      {/* Estilo */}
      <div style={{ marginTop: 32 }}>
        <Card>
          <h2 className="ff-h2">Estilo da casa</h2>
          <p className="ff-sub">
            Vale pros dois — o tema fica salvo pra próxima visita.
          </p>
          <ThemePicker activeTheme={activeTheme} />
        </Card>
      </div>

      {/* Membros */}
      <div style={{ marginTop: 20 }}>
        <Card>
          <h2 className="ff-h2">Quem mora aqui</h2>
          <p className="ff-sub">
            Nome de exibição e o Telegram de cada um pro bot saber quem lançou.
          </p>
          <div className="ff-rows" style={{ marginTop: 20 }}>
            {members.length === 0 ? (
              <p className="ff-muted">Nenhum membro encontrado.</p>
            ) : (
              members.map((member) => <MemberRow key={member.id} member={member} />)
            )}
            <div className="ff-member ff-member--ghost">
              <span className="ff-member__avatar ff-member__avatar--dashed">
                <IconHome size={17} />
              </span>
              <div style={{ flex: 1 }}>
                <div className="ff-member__name">a casa</div>
                <div className="ff-member__desc">
                  responsável padrão dos gastos de todo mundo — sempre por aqui
                </div>
              </div>
            </div>
          </div>
        </Card>
      </div>

      {/* Status do bot */}
      <div style={{ marginTop: 20 }}>
        <Card>
          <div className="ff-panel__head">
            <div>
              <h2 className="ff-h2">Bot do Telegram</h2>
              <p className="ff-sub">
                Manda um áudio ou texto no grupo e o lançamento cai aqui.
              </p>
            </div>
            {lastBotInteraction !== null ? (
              <Badge tone="positive" dot>
                funcionando
              </Badge>
            ) : null}
          </div>
          <div className="ff-botrow">
            <span className="ff-botrow__emoji" aria-hidden>
              🎙️
            </span>
            <div style={{ flex: 1 }}>
              <div className="ff-botrow__title">
                {botStatusLabel(lastBotInteraction)}
              </div>
              {lastBotInteraction !== null ? (
                <div className="ff-botrow__meta">
                  Tipo: {inputKindLabel(lastBotInteraction.input_kind)}
                  {lastBotInteraction.transaction_id !== null
                    ? " · virou lançamento"
                    : ""}
                </div>
              ) : null}
            </div>
          </div>
        </Card>
      </div>
    </section>
  );
}
