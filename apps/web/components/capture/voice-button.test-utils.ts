import { vi } from "vitest";

/**
 * Test doubles for the browser recording APIs jsdom lacks: a MediaRecorder
 * that emits one chunk on stop (asynchronously, like browsers do) and a
 * getUserMedia whose stream hands out one stoppable track.
 */

export class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  static supported = new Set(["audio/mp4", "audio/webm"]);
  /** Browsers report parameters on the recorder's type; null keeps the requested one. */
  static reportedType: string | null = null;
  /** What the next recording yields on stop; null emits a small clip. */
  static nextData: Blob | null = null;

  static isTypeSupported(type: string): boolean {
    return FakeMediaRecorder.supported.has(type);
  }

  readonly mimeType: string;
  readonly options: MediaRecorderOptions | undefined;
  state: "inactive" | "recording" = "inactive";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  start = vi.fn(() => {
    this.state = "recording";
  });
  stop = vi.fn(() => {
    if (this.state === "inactive") return;
    this.finish();
  });

  /** The browser ending the recording on its own (a call, the OS taking the mic). */
  stopFromBrowser(): void {
    this.finish();
  }

  /** A recording error: browsers fire `error`, then stop with what they have. */
  fail(): void {
    this.onerror?.(new Event("error"));
    this.finish();
  }

  private finish(): void {
    this.state = "inactive";
    queueMicrotask(() => {
      this.ondataavailable?.({
        data:
          FakeMediaRecorder.nextData ?? new Blob(["voz"], { type: this.mimeType }),
      });
      this.onstop?.();
    });
  }

  constructor(
    readonly stream: MediaStream,
    options?: MediaRecorderOptions,
  ) {
    this.options = options;
    this.mimeType = FakeMediaRecorder.reportedType ?? options?.mimeType ?? "";
    FakeMediaRecorder.instances.push(this);
  }
}

export type FakeMedia = {
  getUserMedia: ReturnType<typeof vi.fn>;
  track: { stop: ReturnType<typeof vi.fn> };
  recorder: () => FakeMediaRecorder;
};

/** Installs both fakes on the jsdom globals; `uninstallFakeMedia` removes them. */
export function installFakeMedia(): FakeMedia {
  FakeMediaRecorder.instances = [];
  FakeMediaRecorder.supported = new Set(["audio/mp4", "audio/webm"]);
  FakeMediaRecorder.reportedType = null;
  FakeMediaRecorder.nextData = null;
  const track = { stop: vi.fn() };
  const getUserMedia = vi.fn(async () => ({ getTracks: () => [track] }));
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  Object.defineProperty(window.navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia },
  });
  return {
    getUserMedia,
    track,
    recorder: () => {
      const last = FakeMediaRecorder.instances.at(-1);
      if (last === undefined) throw new Error("No MediaRecorder was created");
      return last;
    },
  };
}

export function uninstallFakeMedia(): void {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window.navigator, "mediaDevices");
}
