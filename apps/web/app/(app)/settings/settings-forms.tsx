"use client";

import { useState, useTransition } from "react";

import type { HouseholdMemberProfile } from "@family-finance/db";

import { setThemeAction, updateMemberAction } from "./actions";
import { THEMES, type ThemeId } from "./helpers";

/**
 * Client widgets for "Configurações": the theme picker (two swatch buttons
 * writing the `ff-theme` cookie via a server action) and the per-member
 * profile form (nome de exibição + Telegram vinculado). The household is
 * always re-resolved from the session inside the actions.
 */

// ---------------------------------------------------------------------------
// Theme picker
// ---------------------------------------------------------------------------

export function ThemePicker({ activeTheme }: { activeTheme: ThemeId }) {
  const [isPending, startTransition] = useTransition();

  return (
    <div style={{ display: "flex", gap: 12 }}>
      {THEMES.map((theme) => {
        const isActive = theme.id === activeTheme;
        return (
          <button
            key={theme.id}
            type="button"
            disabled={isPending}
            aria-pressed={isActive}
            onClick={() => {
              startTransition(async () => {
                await setThemeAction(theme.id);
              });
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "10px 16px",
              borderRadius: 12,
              border: isActive ? "2px solid #1f5b3c" : "1px solid #cbd2d9",
              background: "#fff",
              cursor: isPending ? "wait" : "pointer",
              fontSize: 14,
              fontWeight: isActive ? 700 : 500,
            }}
          >
            <span
              aria-hidden
              style={{
                width: 28,
                height: 28,
                borderRadius: 999,
                background: theme.swatch.background,
                border: `3px solid ${theme.swatch.accent}`,
                display: "inline-block",
              }}
            />
            {theme.label}
            {isActive ? " ✓" : ""}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Member profile form
// ---------------------------------------------------------------------------

const inputStyle = {
  padding: "6px 8px",
  border: "1px solid #cbd2d9",
  borderRadius: 8,
  fontSize: 14,
} as const;

const roleLabelPtBr: Record<string, string> = {
  owner: "responsável",
  member: "membro",
};

export function MemberRow({ member }: { member: HouseholdMemberProfile }) {
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [isPending, startTransition] = useTransition();

  function submit(formData: FormData) {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await updateMemberAction(formData);
      if (!result.ok) {
        setError(result.error ?? "Não foi possível salvar o perfil.");
      } else {
        setSaved(true);
      }
    });
  }

  return (
    <tr>
      <td style={{ padding: "10px 8px", borderBottom: "1px solid #eef1f4" }}>
        <form
          action={submit}
          style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}
        >
          <input type="hidden" name="memberId" value={member.id} />
          <input
            name="displayName"
            defaultValue={member.displayName ?? ""}
            placeholder="Nome de exibição"
            aria-label="Nome de exibição"
            style={{ ...inputStyle, minWidth: 160 }}
          />
          <input
            name="telegramUserId"
            defaultValue={
              member.telegramUserId === null ? "" : String(member.telegramUserId)
            }
            placeholder="ID do Telegram"
            aria-label="ID do Telegram"
            inputMode="numeric"
            style={{ ...inputStyle, width: 140 }}
          />
          <span
            style={{
              display: "inline-block",
              background: "#eef2f6",
              border: "1px solid #d5dde5",
              color: "#3d4b5c",
              borderRadius: 999,
              padding: "2px 10px",
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            {roleLabelPtBr[member.role] ?? member.role}
          </span>
          <button
            type="submit"
            disabled={isPending}
            style={{
              padding: "6px 14px",
              borderRadius: 8,
              border: "1px solid #1f5b3c",
              background: "#1f5b3c",
              color: "#fff",
              fontSize: 13,
              fontWeight: 600,
              cursor: isPending ? "wait" : "pointer",
            }}
          >
            {isPending ? "Salvando..." : "Salvar"}
          </button>
          {saved ? (
            <span style={{ color: "#1f5b3c", fontSize: 13 }}>Salvo ✓</span>
          ) : null}
          {error ? (
            <span role="alert" style={{ color: "#8a2020", fontSize: 13 }}>
              {error}
            </span>
          ) : null}
        </form>
      </td>
    </tr>
  );
}
