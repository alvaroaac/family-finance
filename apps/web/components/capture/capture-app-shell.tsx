"use client";

import { useState, type ComponentProps, type ReactElement } from "react";

import { AppShell } from "../ui";
import { CaptureSheet } from "./capture-sheet";

/**
 * The AppShell with its "Novo lançamento" entry points wired to the capture
 * sheet. Lives outside `components/ui` because the sheet talks to the app's
 * server actions, which the design system must not import.
 */
export function CaptureAppShell(
  props: Omit<ComponentProps<typeof AppShell>, "onNewTransaction">,
): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <>
      <AppShell {...props} onNewTransaction={() => setOpen(true)} />
      <CaptureSheet open={open} variant="sheet" onClose={() => setOpen(false)} />
    </>
  );
}
