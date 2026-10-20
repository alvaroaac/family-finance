"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type ReactNode,
} from "react";

import {
  loadCaptureOptionsAction,
  suggestCaptureDraftAction,
} from "../../app/(app)/capture/actions";
import { createCategoryAction } from "../../app/(app)/categories/actions";
import { createManualTransactionAction } from "../../app/(app)/transactions/actions";
import { captureMessage, type CaptureMessage } from "../../lib/capture-copy";
import {
  emptyTransactionFieldValues,
  toTransactionFormData,
  TransactionFields,
  validateTransactionFields,
  type CategoryOption,
  type TransactionFieldOptions,
  type TransactionFieldValues,
} from "../transaction-fields";
import {
  Button,
  IconClose,
  IconWifiOff,
  Input,
  Skeleton,
  useToast,
} from "../ui";
import { useCaptureDraft } from "./use-capture-draft";

/**
 * Quick capture: describe a transaction in free text, let the AI fill the
 * fields, review and save. `variant="sheet"` is the bottom sheet (mobile) /
 * centered modal (desktop) opened from the AppShell; `variant="page"` is the
 * same content as the `/capture` route. Options load once per page session.
 */

type Loaded = { options: TransactionFieldOptions; defaults: TransactionFieldValues };

const FOCUSABLE = "button, input, select, textarea, a[href]";
const CONFLICT_COPY = "Há regras conflitantes para este lugar — escolha a categoria";
const OFFLINE_COPY = "Sem conexão — seu rascunho está salvo";

function cx(...parts: Array<string | false | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export function CaptureSheet({
  open,
  onClose,
  variant,
  voice,
}: {
  open: boolean;
  onClose: () => void;
  variant: "sheet" | "page";
  /** Slot for the voice button (Task 10); the AI box shows no mic without it. */
  voice?: ReactNode;
}): ReactElement | null {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const loading = useRef(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const titleId = useId();
  const isSheet = variant === "sheet";

  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!open || loaded !== null || loading.current) return;
    loading.current = true;
    loadCaptureOptionsAction()
      .then(({ options, today, defaultResponsible }) => {
        setLoaded({
          options,
          defaults: {
            ...emptyTransactionFieldValues(options, today),
            responsible: defaultResponsible,
          },
        });
      })
      .catch(() => setLoadFailed(true))
      .finally(() => {
        loading.current = false;
      });
  }, [open, loaded]);

  // Esc closes the sheet; closing returns focus to whatever opened it.
  useEffect(() => {
    if (!open || !isSheet) return;
    const opener =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      opener?.focus();
    };
  }, [open, isSheet]);

  const ready = loaded !== null;
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    const target =
      panel?.querySelector<HTMLElement>("textarea") ??
      panel?.querySelector<HTMLElement>(".ff-capture__close");
    target?.focus();
  }, [open, ready]);

  if (!open) return null;

  const addCategory = (category: CategoryOption) =>
    setLoaded((current) =>
      current === null
        ? current
        : {
            ...current,
            options: {
              ...current.options,
              categories: [...current.options.categories, category],
            },
          },
    );

  const trapFocus = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab" || panelRef.current === null) return;
    const items = [
      ...panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE),
    ].filter((el) => !(el as HTMLButtonElement).disabled);
    const first = items[0];
    const last = items[items.length - 1];
    if (first === undefined || last === undefined) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className={cx("ff-capture", `ff-capture--${variant}`)}>
      {isSheet ? (
        <div className="ff-capture__backdrop" aria-hidden="true" onClick={onClose} />
      ) : null}
      <div
        ref={panelRef}
        className="ff-capture__panel"
        role={isSheet ? "dialog" : undefined}
        aria-modal={isSheet || undefined}
        aria-labelledby={titleId}
        onKeyDown={isSheet ? trapFocus : undefined}
      >
        {isSheet ? <span className="ff-capture__handle" aria-hidden="true" /> : null}
        <header className="ff-capture__header">
          <h2 id={titleId} className="ff-capture__title">
            Novo lançamento
          </h2>
          <button
            type="button"
            className="ff-capture__close"
            aria-label="Fechar"
            title={isSheet ? "Fechar (Esc)" : "Fechar"}
            onClick={onClose}
          >
            <IconClose size={18} />
          </button>
        </header>
        {loaded === null ? (
          <CaptureLoading failed={loadFailed} />
        ) : (
          <CaptureBody
            options={loaded.options}
            defaults={loaded.defaults}
            onCategoryCreated={addCategory}
            onClose={onClose}
            closeOnNavigate={isSheet}
            voice={voice}
          />
        )}
      </div>
    </div>
  );
}

function CaptureLoading({ failed }: { failed: boolean }): ReactElement {
  return (
    <div className="ff-capture__body">
      {failed ? <Banner message={captureMessage("unavailable")} /> : null}
      <div className="ff-capture__skeleton" aria-busy="true">
        <Skeleton height={84} />
        <div className="ff-skeleton-fields">
          {[82, 108, 82, 108].map((width, index) => (
            <div className="ff-skeleton-field" key={`field-${index + 1}`}>
              <Skeleton width={width} height={10} />
              <Skeleton height={40} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Banner({
  message,
  onDismiss,
  onNavigate,
}: {
  message: CaptureMessage;
  onDismiss?: () => void;
  onNavigate?: () => void;
}): ReactElement {
  return (
    <div
      className={cx("ff-capture__banner", `ff-capture__banner--${message.tone}`)}
      role="status"
    >
      <span className="ff-capture__banner-text">{message.text}</span>
      {message.href !== undefined ? (
        <Link
          href={message.href}
          className="ff-capture__banner-link"
          onClick={onNavigate}
        >
          Abrir Obrigações →
        </Link>
      ) : null}
      {onDismiss !== undefined ? (
        <button
          type="button"
          className="ff-capture__banner-dismiss"
          aria-label="Dispensar"
          onClick={onDismiss}
        >
          <IconClose size={14} />
        </button>
      ) : null}
    </div>
  );
}

/** Mounted once per open, so edit protection and the restored draft are per open. */
function CaptureBody({
  options,
  defaults,
  onCategoryCreated,
  onClose,
  closeOnNavigate,
  voice,
}: {
  options: TransactionFieldOptions;
  defaults: TransactionFieldValues;
  onCategoryCreated: (category: CategoryOption) => void;
  onClose: () => void;
  closeOnNavigate: boolean;
  voice?: ReactNode;
}): ReactElement {
  const draft = useCaptureDraft(defaults);
  const { text, values, result, setField } = draft;
  const router = useRouter();
  const toast = useToast();
  const alive = useRef(true);
  const fillRunning = useRef(false);
  const [filling, setFilling] = useState(false);
  const [message, setMessage] = useState<CaptureMessage | null>(null);
  const [online, setOnline] = useState(() => navigator.onLine);
  const [networkError, setNetworkError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [creatingCategory, setCreatingCategory] = useState(false);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  const canFill = text.trim() !== "" && !filling && online;
  const canSave = values.amount.trim() !== "" && !saving;

  async function fill(): Promise<void> {
    if (fillRunning.current || !canFill) return;
    fillRunning.current = true;
    setFilling(true);
    setMessage(null);
    try {
      const response = await suggestCaptureDraftAction(text);
      if (!alive.current) return;
      if (response.ok) draft.applyDraft(response.draft, options);
      else setMessage(response.message);
    } catch {
      if (alive.current) setMessage(captureMessage("unavailable"));
    } finally {
      fillRunning.current = false;
      if (alive.current) setFilling(false);
    }
  }

  function changeText(next: string): void {
    draft.setText(next);
    if (message?.text === captureMessage("non_financial").text) setMessage(null);
  }

  function onTextKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
      return;
    }
    event.preventDefault();
    void fill();
  }

  async function save(): Promise<void> {
    const invalid = validateTransactionFields(values);
    if (invalid !== null) {
      setSaveError(invalid);
      return;
    }
    setSaving(true);
    setSaveError(null);
    setNetworkError(false);
    try {
      const response = await createManualTransactionAction(
        toTransactionFormData(values),
      );
      if (response.ok) {
        draft.discard();
        toast.success("Lançamento salvo");
        router.refresh();
        if (alive.current) onClose();
        return;
      }
      if (alive.current) {
        setSaveError(response.error ?? "Não foi possível salvar o lançamento.");
      }
    } catch {
      if (alive.current) setNetworkError(true);
    } finally {
      if (alive.current) setSaving(false);
    }
  }

  function cancel(): void {
    draft.discard();
    onClose();
  }

  const needsCategory = result?.needsReview === true && values.categoryId === "";

  return (
    <div className="ff-capture__body">
      {!online || networkError ? (
        <div className="ff-capture__offline" role="status">
          <IconWifiOff size={16} />
          <span>{OFFLINE_COPY}</span>
        </div>
      ) : null}

      <div className={cx("ff-capture__ai", filling && "ff-capture__ai--filling")}>
        <textarea
          className="ff-capture__text"
          aria-label="Descreva o lançamento"
          placeholder="Ex.: 85 no mercado no nubank"
          rows={2}
          maxLength={500}
          value={text}
          onChange={(event) => changeText(event.target.value)}
          onKeyDown={onTextKeyDown}
        />
        <div className="ff-capture__actions">
          {voice}
          <span className="ff-capture__hint">Enter preenche</span>
          <Button
            variant="primary"
            className="ff-capture__fill"
            onClick={() => void fill()}
            disabled={!canFill}
            loading={filling}
            loadingText="Preenchendo…"
          >
            Preencher
          </Button>
        </div>
        {filling ? <span className="ff-capture__fillbar" aria-hidden="true" /> : null}
      </div>

      {message !== null ? (
        <Banner
          message={message}
          onDismiss={() => setMessage(null)}
          onNavigate={closeOnNavigate ? onClose : undefined}
        />
      ) : null}

      {result !== null ? (
        <div className="ff-capture__result">
          {result.explanation !== "" ? (
            <p className="ff-capture__explanation">{result.explanation}</p>
          ) : null}
          {result.needsReview ? (
            <p className="ff-capture__conflict">{CONFLICT_COPY}</p>
          ) : null}
          {result.candidates.length > 0 ? (
            <div className="ff-capture__chips">
              {result.candidates.slice(0, 3).map((candidate) => (
                <button
                  key={`${candidate.categoryId}:${candidate.subcategoryId ?? ""}`}
                  type="button"
                  className="ff-capture__chip"
                  aria-pressed={values.categoryId === candidate.categoryId}
                  onClick={() => {
                    setField("categoryId", candidate.categoryId);
                    setField("subcategoryId", candidate.subcategoryId ?? "");
                  }}
                >
                  {candidate.name}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      <TransactionFields
        values={values}
        onChange={setField}
        options={options}
        aiFilled={draft.aiFilled}
        categoryHighlight={needsCategory ? "warn" : undefined}
        categoryAction={
          <button
            type="button"
            className="ff-capture__category-toggle"
            onClick={() => setCreatingCategory((current) => !current)}
          >
            {creatingCategory ? "Cancelar" : "+ Nova categoria"}
          </button>
        }
        categoryField={
          creatingCategory ? (
            <NewCategoryInput
              kind={values.kind}
              onCreated={(category) => {
                onCategoryCreated(category);
                setField("categoryId", category.id);
                setField("subcategoryId", "");
                setCreatingCategory(false);
              }}
              onNetworkError={() => setNetworkError(true)}
            />
          ) : undefined
        }
      />

      {saveError !== null ? (
        <p className="ff-capture__save-error" role="alert">
          {saveError}
        </p>
      ) : null}

      <footer className="ff-capture__footer">
        <Button variant="ghost" className="ff-capture__cancel" onClick={cancel}>
          Cancelar
        </Button>
        <Button
          variant="primary"
          className="ff-capture__save"
          onClick={() => void save()}
          disabled={!canSave}
          loading={saving}
          loadingText="Salvando…"
        >
          Salvar
        </Button>
      </footer>
    </div>
  );
}

/** The inline "+ Nova categoria" input; creates with the current kind. */
function NewCategoryInput({
  kind,
  onCreated,
  onNetworkError,
}: {
  kind: TransactionFieldValues["kind"];
  onCreated: (category: CategoryOption) => void;
  onNetworkError: () => void;
}): ReactElement {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  async function create(): Promise<void> {
    const trimmed = name.trim();
    if (trimmed === "" || busy) return;
    const formData = new FormData();
    formData.set("name", trimmed);
    formData.set("kind", kind);
    setBusy(true);
    setError(null);
    try {
      const response = await createCategoryAction(formData);
      if (!alive.current) return;
      if (response.ok) onCreated({ id: response.id, name: trimmed, kind });
      else setError(response.message);
    } catch {
      if (alive.current) onNetworkError();
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  return (
    <div className="ff-capture__category-new">
      <div className="ff-capture__category-row">
        <Input
          aria-label="Nome da nova categoria"
          placeholder="Nome da nova categoria"
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            void create();
          }}
        />
        <Button
          variant="primary"
          onClick={() => void create()}
          disabled={name.trim() === ""}
          loading={busy}
        >
          Criar
        </Button>
      </div>
      {error !== null ? (
        <p className="ff-capture__category-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
