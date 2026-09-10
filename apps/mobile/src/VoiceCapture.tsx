import { useState, useEffect } from "react";
import { View } from "react-native";
import {
  useAudioRecorder,
  useAudioRecorderState,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
} from "expo-audio";
import { File } from "expo-file-system";
import { Button, Label } from "./ui";
import { CasaApi } from "./api";
export function VoiceCapture({
  api,
  disabled,
  onText,
  onBusy,
}: {
  api: CasaApi;
  disabled: boolean;
  onText: (text: string) => void;
  onBusy: (busy: boolean) => void;
}) {
  const [clip, setClip] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState("");
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY, (status) => {
    if (status.isFinished) {
      if (status.url) setClip(status.url);
      onBusy(false);
    }
    if (status.hasError) {
      setMessage("A gravação foi interrompida. Tente novamente.");
      onBusy(false);
    }
  });
  useEffect(
    () => () => {
      if (clip) {
        try {
          new File(clip).delete();
        } catch {
          /* Cache may already be removed by the OS. */
        }
      }
    },
    [clip],
  );
  const state = useAudioRecorderState(recorder, 250);
  async function record() {
    setWorking(true);
    onBusy(true);
    setMessage("");
    try {
      if (state.isRecording) {
        await recorder.stop();
        setClip(recorder.uri);
      } else {
        const permission = await requestRecordingPermissionsAsync();
        if (!permission.granted)
          throw new Error("Permita o microfone para gravar, ou use texto.");
        await setAudioModeAsync({
          allowsRecording: true,
          playsInSilentMode: true,
        });
        await recorder.prepareToRecordAsync();
        setClip(null);
        recorder.record({ forDuration: 60 });
      }
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Não foi possível gravar.");
      onBusy(false);
    } finally {
      setWorking(false);
    }
  }
  async function transcribe() {
    if (!clip) return;
    setWorking(true);
    onBusy(true);
    setMessage("");
    try {
      const form = new FormData();
      form.append("file", new File(clip), "voice.m4a");
      const result = await api.request<{ text: string }>("audio", form);
      onText(result.text);
      setClip(null);
    } catch (e) {
      setMessage(
        e instanceof Error ? e.message : "Não foi possível transcrever.",
      );
    } finally {
      setWorking(false);
      onBusy(false);
    }
  }
  return (
    <View style={{ gap: 10 }}>
      <Button
        secondary
        disabled={working || (disabled && !state.isRecording)}
        onPress={() => void record()}
      >
        {state.isRecording
          ? `Parar gravação · ${Math.round(state.durationMillis / 1000)}s`
          : clip
            ? "Gravar novamente"
            : "Descrever por áudio"}
      </Button>
      {clip && (
        <>
          <Label muted size={11}>
            Áudio pronto. Transcreva para revisar o texto antes de preencher.
          </Label>
          <Button
            secondary
            disabled={working || disabled}
            onPress={() => void transcribe()}
          >
            {working ? "Transcrevendo…" : "Transcrever áudio"}
          </Button>
          <Button
            secondary
            small
            disabled={working}
            onPress={() => {
              setClip(null);
              onBusy(false);
            }}
          >
            Descartar áudio
          </Button>
        </>
      )}
      {message ? <Label>{message}</Label> : null}
      <Label muted size={10}>
        Até 1 minuto. O áudio é enviado somente ao tocar em Transcrever.
      </Label>
    </View>
  );
}
