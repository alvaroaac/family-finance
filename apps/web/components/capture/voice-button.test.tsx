// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { captureMessage } from "../../lib/capture-copy";
import { VoiceButton } from "./voice-button";
import {
  FakeMediaRecorder,
  installFakeMedia,
  uninstallFakeMedia,
  type FakeMedia,
} from "./voice-test-fakes";

const mocks = vi.hoisted(() => ({ transcribe: vi.fn() }));

vi.mock("../../app/(app)/capture/actions", () => ({
  transcribeCaptureAudioAction: mocks.transcribe,
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let media: FakeMedia;
const onPhase = vi.fn();
const onText = vi.fn();
const onError = vi.fn();

async function render(disabled = false): Promise<void> {
  await act(async () =>
    root.render(
      <VoiceButton
        disabled={disabled}
        onPhase={onPhase}
        onText={onText}
        onError={onError}
      />,
    ),
  );
}

/** Lets promise chains (getUserMedia, recorder stop, the action) settle. */
const settle = () =>
  act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });

function button(name: string): HTMLButtonElement | null {
  return (
    [...container.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === name,
    ) ?? null
  );
}

async function click(element: Element | null): Promise<void> {
  if (!(element instanceof HTMLElement)) throw new Error("Nothing to click");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await settle();
}

async function record(): Promise<void> {
  await click(button("Gravar"));
}

async function stopRecording(): Promise<void> {
  await click(button("Parar"));
}

const sent = () => mocks.transcribe.mock.calls[0]?.[0] as FormData | undefined;

beforeEach(async () => {
  vi.clearAllMocks();
  media = installFakeMedia();
  mocks.transcribe.mockResolvedValue({ ok: true, text: "85 no mercado no nubank" });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  uninstallFakeMedia();
  vi.useRealTimers();
});

describe("support", () => {
  it("renders nothing without MediaRecorder", async () => {
    vi.stubGlobal("MediaRecorder", undefined);
    await render();
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing when neither audio/mp4 nor audio/webm can be recorded", async () => {
    FakeMediaRecorder.supported = new Set(["audio/ogg"]);
    await render();
    expect(container.innerHTML).toBe("");
  });
});

describe("recording", () => {
  it("asks for the mic and records audio/mp4 when the browser supports it", async () => {
    await render();
    await record();

    expect(media.getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(media.recorder().options?.mimeType).toBe("audio/mp4");
    expect(media.recorder().start).toHaveBeenCalled();
    expect(onPhase).toHaveBeenLastCalledWith("recording");
    expect(button("Gravar")).toBeNull();
    expect(button("Parar")).not.toBeNull();
  });

  it("falls back to audio/webm", async () => {
    FakeMediaRecorder.supported = new Set(["audio/webm"]);
    await render();
    await record();
    expect(media.recorder().options?.mimeType).toBe("audio/webm");
  });

  it("shows the elapsed time against the one-minute cap", async () => {
    vi.useFakeTimers();
    await render();
    await record();
    expect(container.textContent).toContain("0:00 / 1:00");

    await act(async () => vi.advanceTimersByTime(7000));
    expect(container.textContent).toContain("0:07 / 1:00");
  });

  it("stops on its own at 60 seconds", async () => {
    vi.useFakeTimers();
    await render();
    await record();

    await act(async () => vi.advanceTimersByTime(59_000));
    expect(media.recorder().stop).not.toHaveBeenCalled();

    await act(async () => vi.advanceTimersByTime(1000));
    await settle();
    expect(media.recorder().stop).toHaveBeenCalled();
    expect(mocks.transcribe).toHaveBeenCalledTimes(1);
  });

  it("reports mic_denied when permission is refused and stays idle", async () => {
    media.getUserMedia.mockRejectedValueOnce(
      new DOMException("Permission denied", "NotAllowedError"),
    );
    await render();
    await record();

    expect(onError).toHaveBeenCalledWith(captureMessage("mic_denied"));
    expect(FakeMediaRecorder.instances).toHaveLength(0);
    expect(onPhase).not.toHaveBeenCalledWith("recording");
    expect(button("Gravar")).not.toBeNull();
  });

  it("releases the mic and reports transcribe_failed when the recorder can't start", async () => {
    vi.stubGlobal(
      "MediaRecorder",
      class extends FakeMediaRecorder {
        constructor(stream: MediaStream, options?: MediaRecorderOptions) {
          super(stream, options);
          throw new DOMException("Unsupported", "NotSupportedError");
        }
      },
    );
    await render();
    await record();

    expect(media.track.stop).toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(captureMessage("transcribe_failed"));
    expect(button("Gravar")).not.toBeNull();
  });

  it("disables Gravar when told to", async () => {
    await render(true);
    expect(button("Gravar")?.disabled).toBe(true);
  });
});

describe("after stop", () => {
  it("reads Transcrevendo… while the transcription runs", async () => {
    mocks.transcribe.mockReturnValueOnce(new Promise(() => undefined));
    await render();
    await record();
    await stopRecording();

    expect(onPhase).toHaveBeenLastCalledWith("transcribing");
    expect(container.textContent).toContain("Transcrevendo…");
    expect(button("Parar")).toBeNull();
    expect(button("Gravar")).toBeNull();
  });

  it("releases the mic and sends the clip with its base mime type", async () => {
    FakeMediaRecorder.supported = new Set(["audio/webm"]);
    FakeMediaRecorder.reportedType = "audio/webm;codecs=opus";
    await render();
    await record();
    await stopRecording();

    expect(media.track.stop).toHaveBeenCalled();
    const form = sent();
    expect(form?.get("mimeType")).toBe("audio/webm");
    const audio = form?.get("audio");
    expect(audio).toBeInstanceOf(Blob);
    expect((audio as Blob).type).toBe("audio/webm");
  });

  it("hands the text over and goes back to idle", async () => {
    await render();
    await record();
    await stopRecording();

    expect(onText).toHaveBeenCalledWith("85 no mercado no nubank");
    expect(onError).not.toHaveBeenCalled();
    expect(onPhase).toHaveBeenLastCalledWith("idle");
    expect(button("Gravar")).not.toBeNull();
  });

  it("passes the action's failure message on and sends no text", async () => {
    mocks.transcribe.mockResolvedValueOnce({
      ok: false,
      message: captureMessage("transcribe_failed"),
    });
    await render();
    await record();
    await stopRecording();

    expect(onError).toHaveBeenCalledWith(captureMessage("transcribe_failed"));
    expect(onText).not.toHaveBeenCalled();
    expect(onPhase).toHaveBeenLastCalledWith("idle");
  });

  it("reports transcribe_failed when the action throws", async () => {
    mocks.transcribe.mockRejectedValueOnce(new Error("fetch failed"));
    await render();
    await record();
    await stopRecording();

    expect(onError).toHaveBeenCalledWith(captureMessage("transcribe_failed"));
    expect(onText).not.toHaveBeenCalled();
    expect(onPhase).toHaveBeenLastCalledWith("idle");
  });

  it("does not send a clip over 1 MB", async () => {
    FakeMediaRecorder.nextData = new Blob([new Uint8Array(1024 * 1024 + 1)], {
      type: "audio/mp4",
    });
    await render();
    await record();
    await stopRecording();

    expect(mocks.transcribe).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(captureMessage("transcribe_failed"));
    expect(onPhase).toHaveBeenLastCalledWith("idle");
  });
});

describe("unmounting", () => {
  it("stops the recorder, releases the mic and sends nothing", async () => {
    await render();
    await record();
    const recorder = media.recorder();

    await act(async () => root.render(<></>));
    await settle();

    expect(recorder.stop).toHaveBeenCalled();
    expect(media.track.stop).toHaveBeenCalled();
    expect(mocks.transcribe).not.toHaveBeenCalled();
    expect(onText).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("releases a mic granted after the button went away", async () => {
    let grant!: (stream: unknown) => void;
    media.getUserMedia.mockReturnValueOnce(
      new Promise((resolve) => {
        grant = resolve;
      }),
    );
    await render();
    await click(button("Gravar"));

    await act(async () => root.render(<></>));
    await act(async () => grant({ getTracks: () => [media.track] }));
    await settle();

    expect(FakeMediaRecorder.instances).toHaveLength(0);
    expect(media.track.stop).toHaveBeenCalled();
  });

  it("drops a transcription that arrives after unmount", async () => {
    let answer!: (value: unknown) => void;
    mocks.transcribe.mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    await render();
    await record();
    await stopRecording();

    await act(async () => root.render(<></>));
    await act(async () => answer({ ok: true, text: "tarde demais" }));
    await settle();

    expect(onText).not.toHaveBeenCalled();
  });
});
