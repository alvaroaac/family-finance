import { displayDate, inputDate } from "./dates";
import { useState } from "react";
import { Platform, View } from "react-native";
import DateTimePicker from "@react-native-community/datetimepicker";
import { Button, Field, Label } from "./ui";
import { useTheme } from "./theme";
export function DateField({
  label,
  value,
  onChangeText,
  editable = true,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  editable?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { theme, tokens } = useTheme();
  if (Platform.OS === "web")
    return (
      <Field
        label={label}
        value={displayDate(value)}
        onChangeText={(text) => onChangeText(inputDate(text))}
        placeholder="DD/MM/AAAA"
        keyboardType="numbers-and-punctuation"
        editable={editable}
      />
    );
  const parsed = new Date(`${value}T12:00:00`);
  const valid = !Number.isNaN(parsed.getTime());
  return (
    <View style={{ gap: 8 }}>
      <Label muted size={12}>
        {label.replace(" (DD/MM/AAAA)", "")}
      </Label>
      <Button
        secondary
        disabled={!editable}
        label={label}
        onPress={() => setOpen(true)}
      >
        {valid ? displayDate(value) : "Escolher data"}
      </Button>
      {open && (
        <>
          <DateTimePicker
            value={valid ? parsed : new Date()}
            mode="date"
            locale="pt-BR"
            display={Platform.OS === "ios" ? "spinner" : "default"}
            themeVariant={theme === "esmeralda" ? "dark" : "light"}
            accentColor={tokens.accent}
            onChange={(event, date) => {
              if (Platform.OS === "android") setOpen(false);
              if (event.type === "set" && date)
                onChangeText(
                  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`,
                );
            }}
          />
          {Platform.OS === "ios" && (
            <Button secondary small onPress={() => setOpen(false)}>
              Usar esta data
            </Button>
          )}
        </>
      )}
    </View>
  );
}
