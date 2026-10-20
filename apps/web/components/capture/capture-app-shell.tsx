"use client";

import { usePathname } from "next/navigation";
import { useState, type ComponentProps, type ReactElement } from "react";

import { AppShell } from "../ui";
import { CaptureSheet } from "./capture-sheet";

/**
 * The AppShell with its "Novo lançamento" entry points wired to the capture
 * sheet. Lives outside `components/ui` because the sheet talks to the app's
 * server actions, which the design system must not import.
 *
 * On `/capture` the entries are hidden: the page already is the capture form,
 * and two forms would fight over the same stored draft.
 */
export function CaptureAppShell(
  props: Omit<ComponentProps<typeof AppShell>, "onNewTransaction">,
): ReactElement {
  const [open, setOpen] = useState(false);
  const onCapturePage = usePathname() === "/capture";
  return (
    <>
      <AppShell
        {...props}
        onNewTransaction={onCapturePage ? undefined : () => setOpen(true)}
      />
      <CaptureSheet open={open} variant="sheet" onClose={() => setOpen(false)} />
    </>
  );
}
