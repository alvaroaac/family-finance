import { cookies } from "next/headers";

import { requireAuthorizedUser } from "../../../lib/auth";
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

const panel = {
  background: "#fff",
  border: "1px solid #e3e6ea",
  borderRadius: 12,
  padding: 20,
} as const;

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
    <section
      style={{ maxWidth: 720, display: "flex", flexDirection: "column", gap: 16 }}
    >
      <header>
        <h1 style={{ margin: 0 }}>Configurações</h1>
        <p style={{ color: "#555", margin: "6px 0 0", fontSize: 15 }}>
          Do jeitinho da casa: tema, quem é quem e o nosso bot.
        </p>
      </header>

      {loadError ? (
        <div
          role="alert"
          style={{
            background: "#fdecec",
            border: "1px solid #f3b4b4",
            color: "#8a2020",
            borderRadius: 10,
            padding: 12,
            fontSize: 14,
          }}
        >
          Não foi possível carregar as configurações agora.{" "}
          <span style={{ color: "#a85b5b" }}>({loadError})</span>
        </div>
      ) : null}

      {/* Tema */}
      <div style={panel}>
        <h2 style={{ marginTop: 0, fontSize: 18 }}>Tema</h2>
        <p style={{ color: "#6b7280", fontSize: 14, marginTop: 0 }}>
          Escolha o clima da casa — fica salvo neste navegador.
        </p>
        <ThemePicker activeTheme={activeTheme} />
      </div>

      {/* Membros */}
      <div style={panel}>
        <h2 style={{ marginTop: 0, fontSize: 18 }}>Quem mora aqui</h2>
        <p style={{ color: "#6b7280", fontSize: 14, marginTop: 0 }}>
          Nome de exibição e o ID do Telegram vinculado ao bot (deixe em branco
          para desvincular).
        </p>
        {members.length === 0 ? (
          <p style={{ color: "#6b7280", fontSize: 14, margin: 0 }}>
            Nenhum membro encontrado.
          </p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <tbody>
              {members.map((member) => (
                <MemberRow key={member.id} member={member} />
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Status do bot */}
      <div style={panel}>
        <h2 style={{ marginTop: 0, fontSize: 18 }}>Bot da casa</h2>
        <p style={{ fontSize: 15, margin: 0 }}>
          {botStatusLabel(lastBotInteraction)}
        </p>
        {lastBotInteraction !== null ? (
          <p style={{ color: "#6b7280", fontSize: 13, margin: "6px 0 0" }}>
            Tipo: {inputKindLabel(lastBotInteraction.input_kind)}
            {lastBotInteraction.transaction_id !== null
              ? " · virou lançamento"
              : ""}
          </p>
        ) : null}
      </div>
    </section>
  );
}
