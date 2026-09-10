import { developmentPreview } from "./development";
import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  InputAccessoryView,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { Session } from "@supabase/supabase-js";
import { auth, configured, apiUrl, signIn, watchAuthRefresh, connectDevelopmentSession } from "./auth";
import { CasaApi } from "./api";
import { DesignSystemProvider, useTheme } from "./theme";
import { Button, Card, Field, Label, s } from "./ui";
import { LiveApp } from "./LiveApp";
export function SessionGate() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(!configured);
  const [connectionCode, setConnectionCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { tokens: t } = useTheme();
  useEffect(() => {
    if (!auth) return;
    let alive = true;
    void auth.auth.getSession().then(({ data, error }) => {
      if (alive) {
        setSession(data.session);
        setReady(true);
        if (error)
          setError("Sua sessão não pôde ser restaurada. Entre novamente.");
      }
    });
    const {
      data: { subscription },
    } = auth.auth.onAuthStateChange((_event, next) => {
      if (alive) {
        setSession(next);
        setReady(true);
      }
    });
    const stop = watchAuthRefresh();
    return () => {
      alive = false;
      subscription.unsubscribe();
      stop();
    };
  }, []);
  const api = useMemo(
    () =>
      new CasaApi(apiUrl, async () => {
        if (!auth) throw new Error("Conexão não configurada.");
        const { data, error } = await auth.auth.getSession();
        if (error || !data.session)
          throw new Error("Entre novamente para continuar.");
        return data.session.access_token;
      }),
    [],
  );
  if (!ready)
    return (
      <View
        style={{
          flex: 1,
          justifyContent: "center",
          alignItems: "center",
          backgroundColor: t.bg,
        }}
      >
        <ActivityIndicator color={t.accent} />
      </View>
    );
  if (session)
    return (
      <DesignSystemProvider key={session.user.id} source={api.designSystem}>
        <LiveApp
          api={api}
          onSignOut={async () => {
            const { error } = await auth!.auth.signOut({ scope: "local" });
            if (error) throw error;
            setSession(null);
          }}
        />
      </DesignSystemProvider>
    );
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
      <ScrollView
        style={{ flex: 1 }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
        contentContainerStyle={[
          s.content,
          {
            flexGrow: 1,
            justifyContent: "center",
            maxWidth: 500,
            width: "100%",
            alignSelf: "center",
          },
        ]}
      >
        <Label serif size={48}>
          casa
        </Label>
        <Label serif size={30}>
          Mais leve no dia a dia.
        </Label>
        <Label muted>
          Seu dinheiro organizado. Seus planos com espaço para crescer.
        </Label>
        <Card>
          <Label bold>{developmentPreview ? "Conectar esta instalação" : "Entre na sua casa"}</Label>
          <Label muted>
            {configured
              ? developmentPreview
                ? "Use seu código de acesso uma vez. Esta instalação acessa os dados reais da sua casa."
                : "Use a mesma conta Google do seu painel."
              : "A conexão com sua casa ainda não está configurada."}
          </Label>
          {developmentPreview && (
            <Field
              label="Código de acesso"
              value={connectionCode}
              onChangeText={setConnectionCode}
              keyboardType="number-pad"
              textContentType="oneTimeCode"
              autoComplete="one-time-code"
              maxLength={8}
              returnKeyType="done"
              onSubmitEditing={Keyboard.dismiss}
              inputAccessoryViewID={Platform.OS === "ios" ? "casa-access-code-keyboard" : undefined}
              editable={!busy}
              placeholder="Código de uso único"
            />
          )}
          {error ? <Label>{error}</Label> : null}
          <Button
            disabled={busy || !configured}
            onPress={() => {
              Keyboard.dismiss();
              setBusy(true);
              setError("");
              void (developmentPreview ? connectDevelopmentSession(connectionCode) : signIn())
                .then(() => setConnectionCode(""))
                .catch((error: unknown) =>
                  setError(developmentPreview && error instanceof Error
                    ? error.message
                    : "Não foi possível entrar. Confira a conexão e tente novamente."),
                )
                .finally(() => setBusy(false));
            }}
          >
            {busy ? "Conectando…" : developmentPreview ? "Acessar minha casa" : "Continuar com Google"}
          </Button>
        </Card>
      </ScrollView>
      </KeyboardAvoidingView>
      {Platform.OS === "ios" && developmentPreview && (
        <InputAccessoryView nativeID="casa-access-code-keyboard" backgroundColor={t.soft}>
          <View style={{ paddingHorizontal: 16, paddingVertical: 8, alignItems: "flex-end" }}>
            <Button secondary small onPress={Keyboard.dismiss}>
              Fechar teclado
            </Button>
          </View>
        </InputAccessoryView>
      )}
    </SafeAreaView>
  );
}
