import { useEffect, useState, type PropsWithChildren } from "react";
import {
  Text,
  AccessibilityInfo,
  View,
  Pressable,
  StyleSheet,
  TextInput,
  type TextStyle,
  type ViewStyle,
  type StyleProp,
  type TextInputProps,
  Platform,
  useWindowDimensions,
} from "react-native";
import * as Haptics from "expo-haptics";
import {
  ArrowDownLeft,
  ArrowUpRight,
  ShoppingBasket,
  Car,
  House,
  Heart,
  Sparkles,
  ShoppingBag,
  CircleHelp,
  type LucideIcon,
} from "lucide-react-native";
import { useTheme } from "./theme";
import { money, type Entry } from "./finance";
export function haptic() {
  if (Platform.OS !== "web") void Haptics.selectionAsync().catch(() => {});
}
export function Label({
  children,
  style,
  muted,
  serif,
  size = 14,
  color,
  bold,
}: PropsWithChildren<{
  style?: StyleProp<TextStyle>;
  muted?: boolean;
  serif?: boolean;
  size?: number;
  color?: string;
  bold?: boolean;
}>) {
  const { tokens: t } = useTheme();
  return (
    <Text
      style={[
        {
          color: color ?? (muted ? t.muted : t.ink),
          fontFamily: serif ? t.display : bold ? "Inter_600SemiBold" : t.body,
          fontSize: size * t.typeScale,
          lineHeight: Math.round(size * t.typeScale * 1.4),
        },
        style,
      ]}
    >
      {children}
    </Text>
  );
}
export function Button({
  children,
  onPress,
  secondary,
  disabled,
  icon: Icon,
  small,
  label,
}: PropsWithChildren<{
  onPress: () => void;
  secondary?: boolean;
  disabled?: boolean;
  icon?: LucideIcon;
  small?: boolean;
  label?: string;
}>) {
  const { tokens: t } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={() => {
        haptic();
        onPress();
      }}
      style={({ pressed }) => [
        {
          minHeight: small ? 44 : t.controlHeight,
          borderRadius: 16,
          paddingHorizontal: small ? 14 : 20,
          paddingVertical: 12,
          alignItems: "center",
          justifyContent: "center",
          flexDirection: "row",
          gap: 8,
          backgroundColor: secondary ? t.tint : t.accent,
          opacity: disabled ? 0.45 : pressed ? 0.75 : 1,
        },
        pressed && { transform: [{ scale: 0.98 }] },
      ]}
    >
      {Icon ? (
        <Icon
          size={18}
          color={secondary ? t.accent : t.onAccent}
          strokeWidth={1.8}
        />
      ) : null}
      <Label
        bold
        size={small ? 12 : 14}
        color={secondary ? t.accent : t.onAccent}
      >
        {children}
      </Label>
    </Pressable>
  );
}
export function IconButton({
  icon: Icon,
  label,
  onPress,
}: {
  icon: LucideIcon;
  label: string;
  onPress: () => void;
}) {
  const { tokens: t } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => ({
        width: 46,
        height: 46,
        borderRadius: 23,
        backgroundColor: t.surface,
        alignItems: "center",
        justifyContent: "center",
        opacity: pressed ? 0.6 : 1,
        borderColor: t.border,
        borderWidth: StyleSheet.hairlineWidth,
      })}
    >
      <Icon size={20} color={t.ink} strokeWidth={1.5} />
    </Pressable>
  );
}
export function Card({
  children,
  style,
}: PropsWithChildren<{ style?: StyleProp<ViewStyle> }>) {
  const { tokens: t } = useTheme();
  return (
    <View
      style={[
        {
          padding: t.cardPadding,
          backgroundColor: t.surface,
          borderRadius: t.radius,
          borderColor: t.border,
          borderWidth: StyleSheet.hairlineWidth,
          gap: 14,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}
export function Section({
  title,
  action,
  onPress,
}: {
  title: string;
  action?: string;
  onPress?: () => void;
}) {
  const { tokens: t } = useTheme();
  return (
    <View style={s.between}>
      <Label serif size={23}>
        {title}
      </Label>
      {action ? (
        <Pressable
          accessibilityRole="button"
          onPress={onPress}
          hitSlop={10}
          style={{ minHeight: 44, justifyContent: "center" }}
        >
          <Label size={12} color={t.accent} bold>
            {action}
          </Label>
        </Pressable>
      ) : null}
    </View>
  );
}
export function Chip({
  children,
  active,
  onPress,
}: PropsWithChildren<{ active?: boolean; onPress: () => void }>) {
  const { tokens: t } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: !!active }}
      onPress={onPress}
      style={({ pressed }) => ({
        borderWidth: 1,
        borderColor: active ? t.accent : t.border,
        backgroundColor: active ? t.tint : "transparent",
        minHeight: 44,
        borderRadius: 24,
        paddingHorizontal: 16,
        justifyContent: "center",
        opacity: pressed ? 0.65 : 1,
      })}
    >
      <Label size={12} bold={active} color={active ? t.accent : t.muted}>
        {children}
      </Label>
    </Pressable>
  );
}
export function Field({ label, ...props }: TextInputProps & { label: string }) {
  const { tokens: t } = useTheme();
  return (
    <View style={{ gap: 8 }}>
      <Label muted size={12}>
        {label}
      </Label>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={t.muted}
        {...props}
        style={[
          {
            backgroundColor: t.soft,
            color: t.ink,
            fontFamily: t.body,
            fontSize: 16,
            minHeight: 52,
            borderRadius: 14,
            paddingHorizontal: 16,
            paddingVertical: 12,
            borderWidth: 1,
            borderColor: t.border,
          },
          props.style,
        ]}
      />
    </View>
  );
}
export const categoryIcons: Record<string, LucideIcon> = {
  Alimentação: ShoppingBasket,
  Transporte: Car,
  Moradia: House,
  Saúde: Heart,
  Lazer: Sparkles,
  Compras: ShoppingBag,
  Receitas: ArrowDownLeft,
  Outros: CircleHelp,
};
export function EntryRow({ entry }: { entry: Entry }) {
  const { tokens: t } = useTheme();
  const Icon = categoryIcons[entry.category] ?? CircleHelp;
  return (
    <View style={[s.row, { paddingVertical: 13 }]}>
      <View
        style={{
          height: 44,
          width: 44,
          borderRadius: 15,
          backgroundColor: t.tint,
          justifyContent: "center",
          alignItems: "center",
        }}
      >
        <Icon
          size={19}
          color={entry.kind === "income" ? t.positive : t.accent}
          strokeWidth={1.6}
        />
      </View>
      <View style={{ flex: 1, gap: 3 }}>
        <Label bold>{entry.description}</Label>
        <Label muted size={11}>
          {entry.category} · {entry.payment}
        </Label>
      </View>
      <Label
        bold
        size={14}
        color={entry.kind === "income" ? t.positive : t.ink}
      >
        {entry.kind === "income" ? "+" : "−"}{" "}
        {money(entry.amountCents).replace("R$", "").trim()}
      </Label>
    </View>
  );
}
export function Stat({
  label,
  value,
  positive,
}: {
  label: string;
  value: number;
  positive?: boolean;
}) {
  const { tokens: t } = useTheme();
  const compact = useWindowDimensions().width < 370;
  const Icon = positive ? ArrowDownLeft : ArrowUpRight;
  return (
    <View style={{ flex: 1, gap: 6 }}>
      <View style={{ flexDirection: "row", gap: 5, alignItems: "center" }}>
        <Icon size={14} color={positive ? t.positive : t.negative} />
        <Label muted size={11}>
          {label}
        </Label>
      </View>
      <Label bold size={compact ? 14 : 19}>
        {money(value)}
      </Label>
    </View>
  );
}
export const s = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 12 },
  between: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  stack: { gap: 20 },
  wrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  content: {
    paddingHorizontal: 24,
    paddingTop: 22,
    paddingBottom: 30,
    gap: 24,
  },
  eyebrow: { textTransform: "uppercase", letterSpacing: 2, fontSize: 10 },
  divider: { height: StyleSheet.hairlineWidth, width: "100%" },
});

export function useReducedMotion() {
  const [reduced, setReduced] = useState(true);
  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => {
      if (mounted) setReduced(value);
    });
    const listener = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      setReduced,
    );
    return () => {
      mounted = false;
      listener.remove();
    };
  }, []);
  return reduced;
}
