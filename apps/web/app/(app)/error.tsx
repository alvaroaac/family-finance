"use client";

import { useEffect } from "react";

import { Card, Kicker } from "../../components/ui";

/**
 * Route-level error boundary for the `(app)` group. Catches render/render-time
 * errors thrown by any protected page and offers a friendly, on-brand retry —
 * still rendered inside the app shell (sidebar/bottom nav keep working).
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <section style={{ maxWidth: 640, margin: "64px auto" }}>
      <Card>
        <Kicker>Ops</Kicker>
        <h1 className="ff-h2" style={{ marginTop: 10, fontSize: 26 }}>
          Algo deu ruim por aqui
        </h1>
        <p className="ff-muted" style={{ marginTop: 8 }}>
          Não conseguimos carregar essa página agora. Isso não dá pra desfazer sozinho, mas
          tentar de novo costuma resolver.
        </p>
        <button
          type="button"
          className="ff-btn ff-btn--primary"
          style={{ marginTop: 20 }}
          onClick={() => reset()}
        >
          Tentar de novo
        </button>
      </Card>
    </section>
  );
}
