"use client";

import { useState, useTransition } from "react";

import type { HouseholdMemberProfile } from "@family-finance/db";

import { setThemeAction, updateMemberAction } from "./actions";
import { THEMES, telegramDisplayValue, type ThemeId } from "./helpers";
import {
  Badge,
  Button,
  Field,
  Input,
  Spinner,
  useToast,
} from "../../../components/ui";

/**
 * Client widgets for "Configurações": the theme picker (two theme-preview
 * cards writing the `ff-theme` cookie via a server action) and the per-member
 * profile form (nome de exibição + Telegram vinculado). The household is
 * always re-resolved from the session inside the actions.
 */

// ---------------------------------------------------------------------------
// Theme picker — "Estilo da casa" cards (Configuracoes.dc.html)
// ---------------------------------------------------------------------------

/** Theme-constant preview colors, verbatim from the mockup cards. */
const THEME_CARD: Record<
  ThemeId,
  { description: string; dots: Array<{ background: string; border?: string }> }
> = {
  esmeralda: {
    description: "escuro, aconchego de noite",
    dots: [
      { background: "#D4AF6A" },
      { background: "#1E4133", border: "1px solid rgba(242,237,224,0.2)" },
      { background: "#F2EDE0" },
    ],
  },
  salvia: {
    description: "claro, manhã com café",
    dots: [
      { background: "#A8853C" },
      { background: "#F7F9F3", border: "1px solid #CBD6C0" },
      { background: "#2E3A2A" },
    ],
  },
};

export function ThemePicker({ activeTheme }: { activeTheme: ThemeId }) {
  const toast = useToast();
  const [isPending, startTransition] = useTransition();
  const [pendingTheme, setPendingTheme] = useState<ThemeId | null>(null);

  return (
    <div className="ff-themecards">
      {THEMES.map((theme) => {
        const isActive = theme.id === activeTheme;
        const preview = THEME_CARD[theme.id];
        return (
          <button
            key={theme.id}
            type="button"
            disabled={isPending}
            aria-pressed={isActive}
            onClick={() => {
              setPendingTheme(theme.id);
              startTransition(async () => {
                try {
                  await setThemeAction(theme.id);
                  toast.success("Tema atualizado.");
                } catch {
                  toast.error("Não foi possível trocar o tema.");
                } finally {
                  setPendingTheme(null);
                }
              });
            }}
            className={[
              "ff-themecard",
              `ff-themecard--${theme.id}`,
              isActive ? "ff-themecard--active" : "",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            <div className="ff-themecard__dots">
              {preview.dots.map((dot, index) => (
                <span
                  key={index}
                  className="ff-themecard__dot"
                  style={{ background: dot.background, border: dot.border }}
                />
              ))}
            </div>
            <div className="ff-themecard__name">{theme.label}</div>
            <div className="ff-themecard__desc">{preview.description}</div>
            {pendingTheme === theme.id ? (
              <span className="ff-theme-pending" role="status">
                <Spinner /> Aplicando…
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Member profile form
// ---------------------------------------------------------------------------

const roleLabelPtBr: Record<string, string> = {
  owner: "responsável",
  member: "membro",
};

/** Avatar initial from the display name (fallback: house member glyph). */
function memberInitial(member: HouseholdMemberProfile): string {
  const name = member.displayName?.trim() ?? "";
  return name.length > 0 ? name.charAt(0).toUpperCase() : "?";
}

export function MemberRow({ member }: { member: HouseholdMemberProfile }) {
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [isPending, startTransition] = useTransition();

  function submit(formData: FormData) {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await updateMemberAction(formData);
      if (!result.ok) {
        const message = result.error ?? "Não foi possível salvar o perfil.";
        setError(message);
        toast.error(message);
      } else {
        setSaved(true);
        toast.success("Perfil salvo.");
      }
    });
  }

  return (
    <div className="ff-member">
      <span className="ff-member__avatar">{memberInitial(member)}</span>
      <form
        action={submit}
        style={{
          display: "flex",
          alignItems: "flex-end",
          flexWrap: "wrap",
          gap: 16,
          flex: 1,
        }}
      >
        <input type="hidden" name="memberId" value={member.id} />
        <div className="ff-member__field">
          <Field label="Nome de exibição">
            <Input
              name="displayName"
              defaultValue={member.displayName ?? ""}
              placeholder="Nome de exibição"
              aria-label="Nome de exibição"
            />
          </Field>
        </div>
        <div className="ff-member__field">
          <Field label="Telegram (@username ou ID)">
            <Input
              name="telegram"
              defaultValue={telegramDisplayValue(member)}
              placeholder="@username"
              aria-label="Telegram (@username ou ID)"
            />
          </Field>
        </div>
        <Badge tone="accent">{roleLabelPtBr[member.role] ?? member.role}</Badge>
        <Button
          type="submit"
          className="ff-btn--ghost-sm"
          loading={isPending}
          loadingText="Salvando…"
        >
          Salvar
        </Button>
        {saved ? <span className="ff-hint-pos">Salvo ✓</span> : null}
        {error ? (
          <span role="alert" className="ff-note" style={{ color: "var(--ff-negative)" }}>
            {error}
          </span>
        ) : null}
      </form>
    </div>
  );
}
