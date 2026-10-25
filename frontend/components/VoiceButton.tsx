"use client";

import { useRef } from "react";
import { Loader2, Mic } from "lucide-react";
import type { LatLon, RouteResult, VoiceResult } from "@/lib/api";
import { unlockAudio } from "@/lib/speech";
import type { useVoice } from "@/hooks/useVoice";

interface Props {
  voice: ReturnType<typeof useVoice>;
  context: () => { position: LatLon | null; route: RouteResult | null };
  onResult: (r: VoiceResult) => void;
  className?: string;
}

/** Big round push-to-talk button: hold, speak, let go. Without a mic: tap and type. */
export default function VoiceButton({ voice, context, onResult, className = "" }: Props) {
  const pressed = useRef(false);

  const down = async (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    unlockAudio();
    if (!voice.supported) return;
    pressed.current = true;
    await voice.start();
    // let go while the browser was still asking for mic permission: discard
    if (!pressed.current) await voice.stop(null, null);
  };

  const up = async () => {
    if (!voice.supported) {
      const text = window.prompt("What would you like? (e.g. take me to the Radcliffe Camera)");
      if (text?.trim()) {
        const { position, route } = context();
        const r = await voice.ask(text, position, route);
        if (r) onResult(r);
      }
      return;
    }
    if (!pressed.current) return;
    pressed.current = false;
    const { position, route } = context();
    const r = await voice.stop(position, route);
    if (r) onResult(r);
  };

  const label =
    voice.state === "listening" ? "Listening… let go when done" : voice.state === "thinking" ? "Thinking…" : "Hold to talk";

  return (
    <div className={`flex flex-col items-center gap-1 ${className}`}>
      <button
        aria-label={label}
        onPointerDown={down}
        onPointerUp={up}
        onPointerCancel={up}
        onContextMenu={(e) => e.preventDefault()}
        disabled={voice.state === "thinking"}
        className="relative flex h-[72px] w-[72px] touch-none select-none items-center justify-center rounded-full bg-blue-600 text-white shadow-lg disabled:opacity-70"
      >
        {voice.state === "listening" && (
          <span className="absolute inset-0 animate-ping rounded-full bg-blue-400 opacity-60" />
        )}
        {voice.state === "thinking" ? <Loader2 className="size-8 animate-spin" /> : <Mic className="relative size-8" />}
      </button>
      <span className="rounded bg-white/90 px-2 text-xs text-neutral-700 shadow">{label}</span>
    </div>
  );
}
