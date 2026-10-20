"use client";

import { useEffect, useRef, useState, type ReactElement } from "react";

import { transcribeCaptureAudioAction } from "../../app/(app)/capture/actions";
import { captureMessage, type CaptureMessage } from "../../lib/capture-copy";
import { IconMic, Spinner } from "../ui";

/**
 * "Gravar" → record up to a minute → "Transcrevendo…" → hand the text back.
 * Records the first type the browser supports of audio/mp4 (Safari) and
 * audio/webm (Chrome) and sends it with its base type, which is what the bot
 * accepts. Renders nothing where MediaRecorder can't do either. Unmounting
 * (the sheet closing) stops the recorder, releases the mic and sends nothing.
 */

export type VoicePhase = "idle" | "recording" | "transcribing";

type Props = {
  disabled: boolean;
  onPhase(phase: VoicePhase): void;
  onText(text: string): void;
  onError(message: CaptureMessage): void;
};

type Recording = { recorder: MediaRecorder; stream: MediaStream; timer: number };

const RECORDING_TYPES = ["audio/mp4", "audio/webm"];
const MAX_SECONDS = 60;
const MAX_AUDIO_BYTES = 1024 * 1024;
/** Keeps a full minute well under MAX_AUDIO_BYTES; plenty for speech. */
const AUDIO_BITS_PER_SECOND = 64_000;

function recordingType(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  if (navigator.mediaDevices?.getUserMedia === undefined) return null;
  return RECORDING_TYPES.find((type) => MediaRecorder.isTypeSupported(type)) ?? null;
}

/** "audio/webm;codecs=opus" → "audio/webm". */
function baseType(mimeType: string): string {
  return (mimeType.split(";")[0] ?? "").trim().toLowerCase();
}

function releaseMic(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function VoiceButton(props: Props): ReactElement | null {
  const [mimeType, setMimeType] = useState<string | null>(null);
  const [phase, setPhase] = useState<VoicePhase>("idle");
  const [seconds, setSeconds] = useState(0);
  // Recording callbacks outlive the render that started them; read props fresh.
  const latest = useRef(props);
  const recording = useRef<Recording | null>(null);
  const starting = useRef(false);
  const alive = useRef(true);

  useEffect(() => {
    latest.current = props;
  });

  // Read on mount, not during render, so the server render matches.
  useEffect(() => {
    setMimeType(recordingType());
  }, []);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      const current = recording.current;
      recording.current = null;
      if (current === null) return;
      window.clearInterval(current.timer);
      if (current.recorder.state !== "inactive") current.recorder.stop();
      releaseMic(current.stream);
    };
  }, []);

  function changePhase(next: VoicePhase): void {
    setPhase(next);
    latest.current.onPhase(next);
  }

  async function start(type: string): Promise<void> {
    if (starting.current || recording.current !== null) return;
    starting.current = true;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      if (alive.current) latest.current.onError(captureMessage("mic_denied"));
      return;
    } finally {
      starting.current = false;
    }
    if (!alive.current) {
      releaseMic(stream);
      return;
    }

    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, {
        mimeType: type,
        audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
      });
      recorder.start();
    } catch {
      releaseMic(stream);
      latest.current.onError(captureMessage("transcribe_failed"));
      return;
    }

    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.onstop = () => {
      releaseMic(stream);
      if (!alive.current) return;
      void send(new Blob(chunks, { type: baseType(recorder.mimeType || type) }));
    };
    let elapsed = 0;
    const timer = window.setInterval(() => {
      elapsed += 1;
      setSeconds(elapsed);
      if (elapsed >= MAX_SECONDS) stop();
    }, 1000);
    recording.current = { recorder, stream, timer };
    setSeconds(0);
    changePhase("recording");
  }

  function stop(): void {
    const current = recording.current;
    recording.current = null;
    if (current === null) return;
    window.clearInterval(current.timer);
    changePhase("transcribing");
    current.recorder.stop();
  }

  async function send(audio: Blob): Promise<void> {
    let outcome: Awaited<ReturnType<typeof transcribeCaptureAudioAction>>;
    if (audio.size === 0 || audio.size > MAX_AUDIO_BYTES) {
      outcome = { ok: false, message: captureMessage("transcribe_failed") };
    } else {
      const form = new FormData();
      form.set("audio", audio);
      form.set("mimeType", audio.type);
      try {
        outcome = await transcribeCaptureAudioAction(form);
      } catch {
        outcome = { ok: false, message: captureMessage("transcribe_failed") };
      }
    }
    if (!alive.current) return;
    changePhase("idle");
    if (outcome.ok) latest.current.onText(outcome.text);
    else latest.current.onError(outcome.message);
  }

  if (mimeType === null) return null;

  if (phase === "recording") {
    return (
      <>
        <button
          type="button"
          className="ff-capture__mic ff-capture__mic--stop"
          onClick={stop}
        >
          <span className="ff-capture__rec-dot" aria-hidden="true" />
          Parar
        </button>
        <span className="ff-capture__timer">
          {clock(seconds)} <span className="ff-capture__timer-cap">/ 1:00</span>
        </span>
      </>
    );
  }

  if (phase === "transcribing") {
    return (
      <span className="ff-capture__transcribing">
        <Spinner />
        Transcrevendo…
      </span>
    );
  }

  return (
    <button
      type="button"
      className="ff-capture__mic"
      onClick={() => void start(mimeType)}
      disabled={props.disabled}
    >
      <IconMic size={17} />
      Gravar
    </button>
  );
}
