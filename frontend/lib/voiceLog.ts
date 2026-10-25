// A small log of what the mic is doing, for debugging on a phone (phones have no dev
// tools). hooks/useVoice.ts, lib/speak.ts and Map.tsx write to it; open the app with
// ?voicelog in the address to see it on screen (components/VoiceLog.tsx), with a Copy
// button to paste it into a chat. Lines also go to the browser console.
//
// It also keeps the mic engine choice (the switch in that panel):
//   speech  the browser's speech-to-text (default)
//   record  record the audio and let Gemini listen to it (skips the browser's
//           speech recognition, which is unreliable on iPhones)

export interface LogLine {
  t: number; // when (ms since 1970)
  msg: string;
}

const MAX_LINES = 300;
let lines: LogLine[] = [];
const listeners = new Set<() => void>();

/** Add one line to the log. */
export function vlog(msg: string): void {
  lines = [...lines.slice(-(MAX_LINES - 1)), { t: Date.now(), msg }];
  console.log("[voice]", msg);
  listeners.forEach((l) => l());
}

/** Empty the log. */
export function clearLog(): void {
  lines = [];
  listeners.forEach((l) => l());
}

/** For React's useSyncExternalStore: the current lines, and change notifications. */
export function getLines(): LogLine[] {
  return lines;
}
export function subscribeLog(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

/** The log as text: "10:42:07.250  +1.2s  message", one line each. */
export function formatLog(log: LogLine[]): string {
  return log
    .map((l, i) => {
      const d = new Date(l.t);
      const time =
        [d.getHours(), d.getMinutes(), d.getSeconds()]
          .map((n) => String(n).padStart(2, "0"))
          .join(":") +
        "." +
        String(d.getMilliseconds()).padStart(3, "0");
      const gap = i === 0 ? 0 : (l.t - log[i - 1].t) / 1000;
      return `${time}  +${gap.toFixed(1)}s  ${l.msg}`;
    })
    .join("\n");
}

// --- Mic engine -------------------------------------------------------------------------

export type MicEngine = "speech" | "record";
const ENGINE_KEY = "oxride-mic-engine";

// Default: record and let Gemini listen. The browser's speech-to-text often works once and
// then hears nothing (especially on iPhones); it stays available as an option in ?voicelog.
export function getMicEngine(): MicEngine {
  try {
    return localStorage.getItem(ENGINE_KEY) === "speech" ? "speech" : "record";
  } catch {
    return "record";
  }
}

export function setMicEngine(engine: MicEngine): void {
  try {
    localStorage.setItem(ENGINE_KEY, engine);
  } catch {
    // not saved: applies until the page reloads
  }
  vlog(`mic engine set to "${engine}"`);
}
