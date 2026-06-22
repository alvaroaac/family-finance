export const metadata = {
  title: "Dashboard — Casa"
};

/**
 * Minimal dashboard placeholder. The real monthly summary (income, expenses,
 * card pressure, caixinhas, pending review) is built in Task 10. This page only
 * confirms the authenticated Casa workspace shell renders for allowed members.
 */
export default function DashboardPage() {
  return (
    <section>
      <h1 style={{ marginTop: 0 }}>Dashboard</h1>
      <p style={{ color: "#555", maxWidth: 640 }}>
        Bem-vindo ao workspace <strong>Casa</strong>. Aqui ficará o resumo mensal
        da família: quanto entrou, quanto sobrou, pressão dos cartões, caixinhas e
        o que precisa de revisão.
      </p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: 16,
          marginTop: 24
        }}
      >
        {[
          { label: "Entradas do mês", value: "—" },
          { label: "Saídas do mês", value: "—" },
          { label: "Saldo estimado", value: "—" },
          { label: "Pendentes de revisão", value: "—" }
        ].map((card) => (
          <div
            key={card.label}
            style={{
              background: "#fff",
              border: "1px solid #e3e6ea",
              borderRadius: 12,
              padding: 16
            }}
          >
            <div style={{ fontSize: 13, color: "#6b7280" }}>{card.label}</div>
            <div style={{ fontSize: 26, fontWeight: 700, marginTop: 8 }}>
              {card.value}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
