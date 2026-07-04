import { Card, Kicker } from "../../components/ui";

/**
 * Route-level Suspense fallback for the whole `(app)` group — shown while
 * Next streams in any protected page (Resumo, Dashboard, Transações, ...).
 * Calm, on-brand skeleton; no data, no client JS needed.
 */
export default function AppLoading() {
  return (
    <section style={{ maxWidth: 980, margin: "0 auto" }}>
      <Kicker>Nossa casa</Kicker>
      <div className="ff-skeleton" style={{ width: 220, height: 34, marginTop: 12 }} />
      <div className="ff-skeleton" style={{ width: 160, height: 16, marginTop: 10 }} />

      <div className="ff-grid-resumo">
        <Card>
          <div className="ff-skeleton" style={{ width: 120, height: 12 }} />
          <div className="ff-skeleton" style={{ width: 200, height: 44, marginTop: 14 }} />
          <div className="ff-skeleton" style={{ width: "70%", height: 14, marginTop: 16 }} />
        </Card>
        <Card soft>
          <div className="ff-skeleton" style={{ width: 140, height: 12 }} />
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 16 }}>
            <div className="ff-skeleton" style={{ width: "100%", height: 44 }} />
            <div className="ff-skeleton" style={{ width: "100%", height: 44 }} />
            <div className="ff-skeleton" style={{ width: "100%", height: 44 }} />
          </div>
        </Card>
      </div>
    </section>
  );
}
