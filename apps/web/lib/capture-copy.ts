export type CaptureMessage = {
  text: string;
  tone: "muted" | "warn" | "neg" | "accent";
  href?: string;
};

export type CaptureMessageCode =
  | "unavailable"
  | "rate_limited"
  | "non_financial"
  | "unsupported_intent"
  | "transcribe_failed"
  | "mic_denied";

const MESSAGES: Record<CaptureMessageCode, CaptureMessage> = {
  unavailable: {
    text: "IA indisponível — preencha manualmente",
    tone: "muted",
  },
  rate_limited: {
    text: "Muitas tentativas — aguarde um minuto",
    tone: "warn",
  },
  non_financial: { text: "Não entendi como lançamento", tone: "warn" },
  unsupported_intent: {
    text: "Isso parece uma obrigação — use Obrigações",
    tone: "accent",
    href: "/obligations",
  },
  transcribe_failed: {
    text: "Não consegui transcrever — tente de novo ou digite",
    tone: "neg",
  },
  mic_denied: {
    text: "Permita o microfone nas configurações",
    tone: "warn",
  },
};

export function captureMessage(code: CaptureMessageCode): CaptureMessage {
  return MESSAGES[code];
}
