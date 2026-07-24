"use client";

/**
 * ThemePicker — the floating "Estilo" pill with the two theme bolinhas
 * (mockup: fixed bottom-right, dark glass pill, gold ring on the active one).
 *
 * Design firewall: the persistence is injected — `onSelect` is the server
 * action (`setThemeAction`) passed down by `(app)/layout.tsx`. After it
 * resolves we `router.refresh()` so the `data-theme` cookie re-renders the
 * tree with zero flash.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { useToast } from "./toast";
import { Spinner } from "./primitives";

type ThemeId = "esmeralda" | "salvia";

/** Swatch colors are theme-constant identity colors, verbatim from mockups. */
const SWATCHES: ReadonlyArray<{ id: ThemeId; label: string; dot: string }> = [
  { id: "salvia", label: "Sálvia", dot: "#A8853C" },
  { id: "esmeralda", label: "Esmeralda", dot: "#D4AF6A" },
];

export function ThemePicker(props: {
  current: ThemeId;
  onSelect: (theme: ThemeId) => Promise<void>;
}) {
  const { current, onSelect } = props;
  const router = useRouter();
  const toast = useToast();
  const [isPending, startTransition] = useTransition();
  const [pendingTheme, setPendingTheme] = useState<ThemeId | null>(null);

  function pick(theme: ThemeId): void {
    if (theme === current) {
      return;
    }
    setPendingTheme(theme);
    startTransition(async () => {
      try {
        await onSelect(theme);
        toast.success("Tema atualizado.");
        router.refresh();
      } catch {
        toast.error("Não foi possível trocar o tema.");
      } finally {
        setPendingTheme(null);
      }
    });
  }

  return (
    <div className="ff-themepicker">
      <span className="ff-themepicker__label">Estilo</span>
      {SWATCHES.map((swatch) => {
        const active = swatch.id === current;
        return (
          <button
            key={swatch.id}
            type="button"
            title={swatch.label}
            aria-label={`Tema ${swatch.label}`}
            aria-pressed={active}
            disabled={isPending}
            onClick={() => pick(swatch.id)}
            className={[
              "ff-themepicker__swatch",
              `ff-themepicker__swatch--${swatch.id}`,
              active ? "ff-themepicker__swatch--active" : "",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            {pendingTheme === swatch.id ? (
              <Spinner />
            ) : (
              <span className="ff-themepicker__dot" style={{ background: swatch.dot }} />
            )}
          </button>
        );
      })}
    </div>
  );
}
