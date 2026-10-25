"use client";

import { useCallback, useRef, useState } from "react";
import { sendVoice, type LatLon, type RouteResult, type VoiceResult } from "@/lib/api";
import { say } from "@/lib/speech";

export type VoiceState = "idle" | "listening" | "thinking";

// Recording formats in order of preference. Chrome/Android: webm. iPhone/Safari: mp4.
const FORMATS = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/**
 * Push-to-talk: start() records the mic, stop() sends it to /voice, speaks the reply
 * (ElevenLabs, browser voice as fallback) and returns Gemini's {action, settings, reply}.
 * ask(text) does the same from typed text, for browsers without a microphone.
 */
export function useVoice() {
  const [state, setState] = useState<VoiceState>("idle");
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const supported =
    typeof window !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined";

  const start = useCallback(async () => {
    if (!supported || recorder.current) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = FORMATS.find((f) => MediaRecorder.isTypeSupported(f));
      const r = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunks.current = [];
      r.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
      r.start();
      recorder.current = r;
      setState("listening");
    } catch {
      await say("I can't use the microphone. Check the browser's permission.");
      setState("idle");
    }
  }, [supported]);

  const finish = useCallback(async (body: Parameters<typeof sendVoice>[0]): Promise<VoiceResult | null> => {
    setState("thinking");
    try {
      const result = await sendVoice(body);
      await say(result.reply);
      return result;
    } catch {
      await say("Sorry, I couldn't reach OxRide. Try again in a moment.");
      return null;
    } finally {
      setState("idle");
    }
  }, []);

  const stop = useCallback(
    async (position: LatLon | null, route: RouteResult | null): Promise<VoiceResult | null> => {
      const r = recorder.current;
      if (!r) return null;
      recorder.current = null;
      await new Promise<void>((resolve) => {
        r.onstop = () => resolve();
        r.stop();
      });
      r.stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(chunks.current, { type: r.mimeType });
      if (blob.size < 1000) {
        setState("idle"); // a tap, not speech
        return null;
      }
      return finish({
        audio_b64: await blobToBase64(blob),
        mime: (r.mimeType || "audio/webm").split(";")[0],
        position: position ?? undefined,
        route: route ?? undefined,
      });
    },
    [finish],
  );

  const ask = useCallback(
    (text: string, position: LatLon | null, route: RouteResult | null) =>
      finish({ text, position: position ?? undefined, route: route ?? undefined }),
    [finish],
  );

  return { state, supported, start, stop, ask };
}
