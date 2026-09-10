/** Local test entrypoint only. Real Supabase authentication and production App. */
import { useState } from "react";
import { View, Text, Pressable } from "react-native";
import App from "../App";
import { auth, apiUrl } from "../src/auth";
export default function LocalEndToEndApp() {
  const [message, setMessage] = useState("");
  if (apiUrl !== "http://127.0.0.1:8087")
    throw new Error("The end-to-end entrypoint is restricted to localhost.");
  return (
    <View style={{ flex: 1 }}>
      <View style={{ backgroundColor: "#fff4cb", padding: 8 }}>
        <Text>TESTE E2E · banco local isolado</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Entrar como usuário de teste local"
          onPress={async () => {
            const result = await auth!.auth.signInWithPassword({
              email: "mobile-e2e@example.test",
              password: "CasaLocalTest-2026!",
            });
            setMessage(
              result.error ? result.error.message : "Sessão local autenticada",
            );
          }}
        >
          <Text>Entrar como usuário de teste local</Text>
        </Pressable>
        {message ? <Text>{message}</Text> : null}
      </View>
      <App />
    </View>
  );
}
