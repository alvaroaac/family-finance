"use client";

import type { CSSProperties, ReactElement, ReactNode } from "react";

import { useToast } from "../../../components/ui";
import type { BucketActionResult } from "./actions";

/**
 * A form that runs a caixinha server action and toasts its outcome, so the
 * household sees why a create, rename or delete did not go through.
 */
export function BucketActionForm({
  action,
  className,
  style,
  children,
}: {
  action: (formData: FormData) => Promise<BucketActionResult>;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}): ReactElement {
  const toast = useToast();

  async function submit(formData: FormData) {
    const result = await action(formData);
    if (result.ok) {
      toast.success(result.message);
    } else {
      toast.error(result.message);
    }
  }

  return (
    <form action={submit} className={className} style={style}>
      {children}
    </form>
  );
}
