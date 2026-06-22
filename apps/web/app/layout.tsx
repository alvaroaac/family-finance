import type { ReactNode } from "react";

export const metadata = {
  title: "Family Finance",
  description: "Private family finance MVP"
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
