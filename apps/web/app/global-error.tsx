"use client";

import { useEffect } from "react";

/**
 * Root fallback — only rendered when the RootLayout itself (theme, fonts,
 * global CSS) fails to render, so this file cannot rely on ui.css, tokens,
 * or the `(app)` shell. It must render its own <html><body> and stays
 * dependency-free on purpose.
 */
export default function GlobalError({
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
    <html lang="pt-BR">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          background: "#16352b",
          color: "#f2ede0",
          fontFamily:
            "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        }}
      >
        <div
          style={{
            width: "100%",
            maxWidth: 420,
            textAlign: "center",
            background: "#1e4133",
            border: "1px solid rgba(212, 175, 106, 0.24)",
            borderRadius: 16,
            padding: "40px 32px",
          }}
        >
          <p
            style={{
              margin: 0,
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: "0.24em",
              textTransform: "uppercase",
              color: "#d4af6a",
            }}
          >
            Nossa casa
          </p>
          <h1
            style={{
              margin: "14px 0 0",
              fontSize: 26,
              fontWeight: 600,
              color: "#f2ede0",
            }}
          >
            Algo deu ruim por aqui
          </h1>
          <p
            style={{
              margin: "10px 0 0",
              fontSize: 14,
              lineHeight: 1.6,
              color: "rgba(242, 237, 224, 0.66)",
            }}
          >
            O app inteiro travou nessa. Recarregar a página costuma resolver — se continuar,
            volta mais tarde que a gente já dá um jeito.
          </p>
          <button
            type="button"
            onClick={() => reset()}
            style={{
              marginTop: 22,
              background: "#d4af6a",
              color: "#16352b",
              border: "none",
              borderRadius: 12,
              padding: "11px 20px",
              fontWeight: 600,
              fontSize: 14,
              cursor: "pointer",
            }}
          >
            Recarregar
          </button>
        </div>
      </body>
    </html>
  );
}
