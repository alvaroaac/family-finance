"use client";

import { useRouter } from "next/navigation";

import { CaptureSheet } from "../../../components/capture/capture-sheet";

/** Quick capture as a full page (PWA shortcut target); closing goes home. */
export default function CapturePage() {
  const router = useRouter();
  return <CaptureSheet open variant="page" onClose={() => router.push("/")} />;
}
