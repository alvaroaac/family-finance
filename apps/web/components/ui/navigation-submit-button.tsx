"use client";

import { useState, type ReactElement, type ReactNode } from "react";

import { Button } from "./primitives";

export function NavigationSubmitButton({
  children,
  pendingLabel,
  variant = "ghost",
}: {
  children: ReactNode;
  pendingLabel: ReactNode;
  variant?: "primary" | "ghost";
}): ReactElement {
  const [pending, setPending] = useState(false);

  return (
    <Button
      type="submit"
      variant={variant}
      loading={pending}
      loadingText={pendingLabel}
      onClick={() => setPending(true)}
    >
      {children}
    </Button>
  );
}
