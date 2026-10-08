"use client";

import {
  startTransition,
  useActionState,
  type FormEvent,
  type ReactElement,
} from "react";

import { useToast } from "../../../components/ui";
import type { CardBillActionState } from "./actions";

type CardBillAction = (
  prev: CardBillActionState,
  formData: FormData,
) => Promise<CardBillActionState>;

const IDLE: CardBillActionState = { status: "idle" };

/**
 * `useActionState` for the fatura forms, submitted from `onSubmit` so a failed
 * submission keeps what the user typed (a form `action` resets the fields).
 * Success is toasted from inside the action, not from an effect: the
 * revalidated page re-renders the faturas (payment forms remount on a fresh
 * idempotency key), so the submitting component may never commit its success
 * state. Errors stay in `state` for the form to show inline.
 */
export function useCardBillAction(
  action: CardBillAction,
  onSuccess?: () => void,
): {
  state: CardBillActionState;
  pending: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
} {
  const toast = useToast();
  const [state, dispatch, pending] = useActionState(
    async (prev: CardBillActionState, formData: FormData) => {
      const next = await action(prev, formData);
      if (next.status === "success") {
        toast.success(next.message);
        onSuccess?.();
      }
      return next;
    },
    IDLE,
  );

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (pending) return;
    const formData = new FormData(event.currentTarget);
    startTransition(() => dispatch(formData));
  }

  return { state, pending, onSubmit };
}

/** The inline error under a fatura form; nothing while idle or after success. */
export function CardBillActionError({
  state,
}: {
  state: CardBillActionState;
}): ReactElement | null {
  if (state.status !== "error") return null;
  return (
    <div role="alert" className="ff-alert ff-alert--negative ff-fatura__error">
      {state.message}
    </div>
  );
}
