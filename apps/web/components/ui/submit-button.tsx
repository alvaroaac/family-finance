"use client";

import type { ReactElement, ReactNode } from "react";
import { useFormStatus } from "react-dom";

import { Button } from "./primitives";

export function SubmitButton({
  children,
  pendingLabel,
  variant = "ghost",
  className,
  unstyled = false,
}: {
  children: ReactNode;
  pendingLabel: ReactNode;
  variant?: "primary" | "ghost" | "danger" | "link";
  className?: string;
  unstyled?: boolean;
}): ReactElement {
  const { pending } = useFormStatus();

  if (unstyled) {
    return (
      <button
        type="submit"
        className={className}
        disabled={pending}
        aria-busy={pending}
      >
        {pending ? (
          <span className="ff-btn__pending">
            <span className="ff-spinner" aria-hidden="true" />
            {pendingLabel}
          </span>
        ) : (
          children
        )}
      </button>
    );
  }

  return (
    <Button
      type="submit"
      variant={variant}
      className={className}
      loading={pending}
      loadingText={pendingLabel}
    >
      {children}
    </Button>
  );
}
