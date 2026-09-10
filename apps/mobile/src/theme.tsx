import {
  createContext,
  useContext,
  useEffect,
  useState,
  type PropsWithChildren,
} from "react";
import { Platform } from "react-native";
import {
  themes,
  demoDesignSystem,
  validateDesignSystem,
  type ThemeId,
  type DesignSystemSource,
} from "./design-system";
export { themes, apiDesignSystem, validateDesignSystem } from "./design-system";
const ThemeContext = createContext({
  tokens: themes.esmeralda,
  theme: "esmeralda" as ThemeId,
  toggle: () => {},
  fallback: false,
});
export function DesignSystemProvider({
  children,
  source = demoDesignSystem,
}: PropsWithChildren<{ source?: DesignSystemSource }>) {
  const [theme, setTheme] = useState<ThemeId>("esmeralda");
  const [tokens, setTokens] = useState(themes.esmeralda);
  const [fallback, setFallback] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setTokens(themes[theme]);
    setFallback(false);
    source
      .load(theme, controller.signal)
      .then((d) => {
        if (!controller.signal.aborted)
          setTokens(validateDesignSystem(d, theme).tokens);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFallback(true);
      });
    return () => controller.abort();
  }, [theme, source]);
  return (
    <ThemeContext.Provider
      value={{
        tokens,
        theme,
        toggle: () =>
          setTheme((t) => (t === "esmeralda" ? "salvia" : "esmeralda")),
        fallback,
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
}
export const useTheme = () => useContext(ThemeContext);
export const fallbackBody = Platform.OS === "ios" ? "System" : "sans-serif";
