import { useState } from "react";
import { View } from "react-native";
import { CasaApi } from "./api";
import { Button, Card, Label } from "./ui";
type Batch = {
  id: string;
  source: string;
  created_at: string;
  total_rows: number;
  imported_rows: number;
  duplicate_rows: number;
  error_rows: number;
};
export function ImportHistory({ api }: { api: CasaApi }) {
  const [items, setItems] = useState<Batch[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <View style={{ gap: 12 }}>
      <Button
        secondary
        disabled={busy}
        onPress={() => {
          setBusy(true);
          setError("");
          void api
            .request<Batch[]>("imports/history")
            .then(setItems)
            .catch(() => setError("Não foi possível carregar o histórico."))
            .finally(() => setBusy(false));
        }}
      >
        {busy ? "Carregando…" : "Ver importações anteriores"}
      </Button>
      {error ? <Label>{error}</Label> : null}
      {items?.map((batch) => (
        <Card key={batch.id}>
          <Label bold>
            {batch.source === "mercado-pago"
              ? "Mercado Pago"
              : batch.source === "nubank"
                ? "Nubank"
                : "Minhas Finanças"}
          </Label>
          <Label muted>
            {new Intl.DateTimeFormat("pt-BR", {
              day: "2-digit",
              month: "2-digit",
              year: "numeric",
              timeZone: "America/Sao_Paulo",
            }).format(new Date(batch.created_at))}
          </Label>
          <Label>
            {batch.imported_rows} importados · {batch.duplicate_rows} duplicatas
            · {batch.error_rows} erros
          </Label>
        </Card>
      ))}
      {items?.length === 0 && <Label muted>Nenhuma importação anterior.</Label>}
    </View>
  );
}
