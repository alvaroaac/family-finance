import { ActivityIndicator, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { useFonts } from "expo-font";
import { Inter_400Regular } from "@expo-google-fonts/inter/400Regular";
import { Inter_600SemiBold } from "@expo-google-fonts/inter/600SemiBold";
import { PlayfairDisplay_500Medium } from "@expo-google-fonts/playfair-display/500Medium";
import { DesignSystemProvider } from "./src/theme";
import { SessionGate } from "./src/SessionGate";

export default function App() {
  const [loaded, error] = useFonts({
    Inter_400Regular,
    Inter_600SemiBold,
    PlayfairDisplay_500Medium,
  });
  if (!loaded && !error)
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: "#16352b",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <ActivityIndicator color="#d4af6a" accessibilityLabel="Abrindo Casa" />
      </View>
    );
  return (
    <SafeAreaProvider>
      <DesignSystemProvider>
        <SessionGate />
      </DesignSystemProvider>
    </SafeAreaProvider>
  );
}
