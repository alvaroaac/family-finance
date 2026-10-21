"use client";

import { useEffect, useState, type ReactElement } from "react";

import { IconClose, IconUpload } from "../ui";

const DISMISSED_KEY = "ff-install-banner-dismissed";

/** Chrome's `beforeinstallprompt` event; not in the DOM typings. */
type InstallPromptEvent = Event & { prompt: () => Promise<unknown> };

type Offer = { kind: "ios" } | { kind: "prompt"; event: InstallPromptEvent };

function isInstalled(): boolean {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function wasDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) !== null;
  } catch {
    return false;
  }
}

/**
 * Offers to install the app on a phone: Chrome's native prompt where the
 * browser allows one, the Share-sheet steps on iOS (which has no prompt).
 * Hidden in the installed app, after a dismissal, and above phone width (CSS).
 */
export function InstallBanner(): ReactElement | null {
  const [offer, setOffer] = useState<Offer | null>(null);

  useEffect(() => {
    if (isInstalled() || wasDismissed()) return;
    if (/iPhone|iPad|iPod/.test(navigator.userAgent)) {
      setOffer({ kind: "ios" });
      return;
    }
    function handlePrompt(event: Event): void {
      event.preventDefault();
      setOffer({ kind: "prompt", event: event as InstallPromptEvent });
    }
    window.addEventListener("beforeinstallprompt", handlePrompt);
    return () =>
      window.removeEventListener("beforeinstallprompt", handlePrompt);
  }, []);

  if (offer === null) return null;

  function dismiss(): void {
    setOffer(null);
    try {
      localStorage.setItem(DISMISSED_KEY, "1");
    } catch {
      // Storage blocked: the banner just comes back next visit.
    }
  }

  function install(event: InstallPromptEvent): void {
    // A prompt event can be used once; the banner goes either way.
    setOffer(null);
    void event.prompt();
  }

  return (
    <div
      className="ff-install-banner ff-capture__banner ff-capture__banner--accent"
      role="status"
    >
      {offer.kind === "ios" ? (
        <span className="ff-capture__banner-text">
          Instale: toque em Compartilhar{" "}
          <span className="ff-install-banner__share">
            <IconUpload size={14} />
          </span>{" "}
          e “Adicionar à Tela de Início”
        </span>
      ) : (
        <>
          <span className="ff-capture__banner-text">
            Instale o app no celular
          </span>
          <button
            type="button"
            className="ff-install-banner__install"
            onClick={() => install(offer.event)}
          >
            Instalar
          </button>
        </>
      )}
      <button
        type="button"
        className="ff-capture__banner-dismiss"
        aria-label="Dispensar"
        onClick={dismiss}
      >
        <IconClose size={14} />
      </button>
    </div>
  );
}
