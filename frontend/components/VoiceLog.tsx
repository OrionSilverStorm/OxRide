"use client";

// On-screen log of what the mic is doing, for debugging on a phone (no dev tools there).
// Only shows when the address has ?voicelog, e.g. https://oxride.vercel.app/?voicelog
// - newest lines at the top
// - "Mic:" switches between the browser's speech-to-text and recording for Gemini
// - Copy puts the whole log (oldest first) on the clipboard to paste into a chat

import { useState, useSyncExternalStore } from "react";
import {
  clearLog,
  formatLog,
  getLines,
  getMicEngine,
  setMicEngine,
  subscribeLog,
  type MicEngine,
} from "@/lib/voiceLog";

const BUTTON = "h-10 rounded-full bg-surface px-4 text-sm text-foreground";

export default function VoiceLog() {
  const [enabled] = useState(() =>
    new URLSearchParams(window.location.search).has("voicelog"),
  );
  const [hidden, setHidden] = useState(false);
  const [engine, setEngine] = useState<MicEngine>(getMicEngine);
  const [copied, setCopied] = useState(false);
  const lines = useSyncExternalStore(subscribeLog, getLines, getLines);
  if (!enabled) return null;

  if (hidden) {
    return (
      <button
        onClick={() => setHidden(false)}
        className={`absolute left-4 top-1/2 z-[1100] -translate-y-1/2 shadow-md ${BUTTON}`}
      >
        Voice log
      </button>
    );
  }

  const text = formatLog(lines);
  const switchEngine = () => {
    const next: MicEngine = engine === "speech" ? "record" : "speech";
    setMicEngine(next);
    setEngine(next);
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false); // clipboard blocked: the text can still be selected by hand
    }
  };

  return (
    <div className="absolute inset-x-2 top-[max(8px,env(safe-area-inset-top))] z-[1100] flex max-h-[45%] flex-col rounded-2xl bg-card text-foreground shadow-md">
      <div className="flex flex-wrap items-center gap-2 border-b border-border p-2">
        <span className="px-2 text-sm font-bold">Voice log</span>
        <button onClick={switchEngine} className={BUTTON}>
          Mic: {engine === "speech" ? "speech-to-text" : "record for Gemini"}
        </button>
        <button onClick={copy} className={BUTTON}>
          {copied ? "Copied" : "Copy"}
        </button>
        <button onClick={clearLog} className={BUTTON}>
          Clear
        </button>
        <button onClick={() => setHidden(true)} className={BUTTON}>
          Hide
        </button>
      </div>
      <pre className="min-h-0 flex-1 select-text overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-snug">
        {text
          ? text.split("\n").reverse().join("\n")
          : "Nothing yet. Press the mic."}
      </pre>
    </div>
  );
}
