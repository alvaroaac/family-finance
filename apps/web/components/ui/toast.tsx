"use client";

/**
 * Toast system — self-contained, no external deps.
 *
 * `ToastProvider` owns the queue and renders a fixed stack via `createPortal`
 * to `document.body` (guarded for SSR — only portals after mount). Consumers
 * call `useToast()` from anywhere inside the provider to fire toasts.
 *
 * Design firewall: presentational only — no workspace packages, no web lib
 * helpers, no app routes, no server context. Pure React + CSS, reusing the
 * `.ff-alert` tone language via `.ff-toast--*` classes in ui.css.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

export type ToastTone = "negative" | "positive" | "warn";

export type ToastInput = {
  message: string;
  tone?: ToastTone;
  /** Override the default ~5000ms auto-dismiss. */
  durationMs?: number;
};

export type ToastRecord = {
  id: number;
  message: string;
  tone: ToastTone;
  durationMs: number;
};

const DEFAULT_DURATION_MS = 5000;

/** Pure queue helpers — exported for unit testing without a DOM environment. */
export function addToast(
  queue: ReadonlyArray<ToastRecord>,
  id: number,
  input: ToastInput,
): ToastRecord[] {
  const record: ToastRecord = {
    id,
    message: input.message,
    tone: input.tone ?? "negative",
    durationMs: input.durationMs ?? DEFAULT_DURATION_MS,
  };
  return [...queue, record];
}

export function removeToast(
  queue: ReadonlyArray<ToastRecord>,
  id: number,
): ToastRecord[] {
  return queue.filter((toast) => toast.id !== id);
}

export type ToastApi = {
  /** Generic entry point — tone defaults to "negative". */
  show: (input: ToastInput) => void;
  error: (message: string, durationMs?: number) => void;
  success: (message: string, durationMs?: number) => void;
  warn: (message: string, durationMs?: number) => void;
  dismiss: (id: number) => void;
};

const ToastContext = createContext<ToastApi | null>(null);

/** `useToast()` outside a `<ToastProvider>` throws — misuse should fail loudly. */
export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast() must be called within a <ToastProvider>.");
  }
  return ctx;
}

function toneRoleAndLive(tone: ToastTone): { role: "status" | "alert"; ariaLive: "polite" | "assertive" } {
  if (tone === "negative") {
    return { role: "alert", ariaLive: "assertive" };
  }
  return { role: "status", ariaLive: "polite" };
}

function ToastCard({
  toast,
  onDismiss,
}: {
  toast: ToastRecord;
  onDismiss: (id: number) => void;
}): ReactElement {
  const { role, ariaLive } = toneRoleAndLive(toast.tone);
  return (
    <div className={`ff-toast ff-toast--${toast.tone}`} role={role} aria-live={ariaLive}>
      <span className="ff-toast__message">{toast.message}</span>
      <button
        type="button"
        className="ff-toast__close"
        aria-label="Fechar"
        onClick={() => onDismiss(toast.id)}
      >
        ×
      </button>
    </div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }): ReactElement {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const [mounted, setMounted] = useState(false);
  const nextId = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    setMounted(true);
    return () => {
      for (const timer of timers.current.values()) {
        clearTimeout(timer);
      }
      timers.current.clear();
    };
  }, []);

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((current) => removeToast(current, id));
  }, []);

  const show = useCallback(
    (input: ToastInput) => {
      const id = nextId.current;
      nextId.current += 1;
      setToasts((current) => addToast(current, id, input));
      const durationMs = input.durationMs ?? DEFAULT_DURATION_MS;
      const timer = setTimeout(() => dismiss(id), durationMs);
      timers.current.set(id, timer);
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      show,
      error: (message, durationMs) => show({ message, tone: "negative", durationMs }),
      success: (message, durationMs) => show({ message, tone: "positive", durationMs }),
      warn: (message, durationMs) => show({ message, tone: "warn", durationMs }),
      dismiss,
    }),
    [show, dismiss],
  );

  const stack = (
    <div className="ff-toast-stack" aria-live="off">
      {toasts.map((toast) => (
        <ToastCard key={toast.id} toast={toast} onDismiss={dismiss} />
      ))}
    </div>
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      {mounted && typeof document !== "undefined" ? createPortal(stack, document.body) : null}
    </ToastContext.Provider>
  );
}
