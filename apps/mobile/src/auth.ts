import { verifyDevelopmentCode } from "./developmentSession";
import { developmentPreview } from "./development";
import { randomUUID } from "expo-crypto";
import { chunkedSessionStorage } from "./secureSessionStorage";
import "react-native-url-polyfill/auto";
import { AppState, Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import * as WebBrowser from "expo-web-browser";
import { makeRedirectUri } from "expo-auth-session";
import { createClient } from "@supabase/supabase-js";
export const apiUrl = process.env.EXPO_PUBLIC_API_URL ?? "";
const url = process.env.EXPO_PUBLIC_SUPABASE_URL ?? "";
const key = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? "";
export const configured = Boolean(apiUrl && url && key);
const nativeStorage = chunkedSessionStorage(
  {
    getItem: SecureStore.getItemAsync,
    setItem: SecureStore.setItemAsync,
    removeItem: SecureStore.deleteItemAsync,
  },
  randomUUID,
);
const storage =
  Platform.OS === "web"
    ? {
        getItem: async (key: string) =>
          globalThis.sessionStorage?.getItem(key) ?? null,
        setItem: async (key: string, value: string) => {
          globalThis.sessionStorage?.setItem(key, value);
        },
        removeItem: async (key: string) => {
          globalThis.sessionStorage?.removeItem(key);
        },
      }
    : nativeStorage;
export const auth = configured
  ? createClient(url, key, {
      auth: {
        storage,
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: Platform.OS === "web",
        flowType: "pkce",
      },
    })
  : null;
WebBrowser.maybeCompleteAuthSession();
export function watchAuthRefresh() {
  if (Platform.OS === "web" || !auth) return () => {};
  const sub = AppState.addEventListener("change", (state) => {
    if (state === "active") auth.auth.startAutoRefresh();
    else auth.auth.stopAutoRefresh();
  });
  if (AppState.currentState === "active") auth.auth.startAutoRefresh();
  return () => {
    sub.remove();
    auth.auth.stopAutoRefresh();
  };
}
export async function signIn() {
  if (!auth) throw new Error("Configure a conexão com sua Casa para entrar.");
  const redirectTo = makeRedirectUri({ scheme: "casa", path: "auth/callback" });
  const { data, error } = await auth.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo, skipBrowserRedirect: Platform.OS !== "web" },
  });
  if (error) throw error;
  if (Platform.OS !== "web" && data.url) {
    const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
    if (result.type === "success") {
      const callback = new URL(result.url);
      const code = callback.searchParams.get("code");
      if (!code) throw new Error("O login não foi concluído. Tente novamente.");
      const { error: exchangeError } =
        await auth.auth.exchangeCodeForSession(code);
      if (exchangeError) throw exchangeError;
    }
  }
}

export async function connectDevelopmentSession(code: string) {
  if (!developmentPreview || !auth)
    throw new Error("A conexão de desenvolvimento não está disponível.");
  return verifyDevelopmentCode({
    enabled: developmentPreview,
    email: process.env.EXPO_PUBLIC_DEVELOPMENT_EMAIL,
    code,
    verify: (input) => auth!.auth.verifyOtp(input),
  });
}
