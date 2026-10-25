"use client";

// The mic button:
//   hold   -> listens while held, sends what you said when you let go
//   tap    -> keeps listening; every sentence is a command; tap again to stop
// Uses the browser's speech-to-text (Chrome/Safari; needs HTTPS or localhost).

import { useCallback, useEffect, useRef, useState } from "react";
import { isSpeaking } from "@/lib/speak";

export type VoiceMode = "off" | "hold" | "continuous";

const HOLD_MS = 350; // pressed longer than this = hold-to-talk; shorter = a tap

// The bits of the browser's SpeechRecognition API we use
interface SpeechRec {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult:
    | ((e: {
        resultIndex: number;
        results: { length: number; [i: number]: { isFinal: boolean; [j: number]: { transcript: string } } };
      }) => void)
    | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
}

function recognizer(): (new () => SpeechRec) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: new () => SpeechRec; webkitSpeechRecognition?: new () => SpeechRec };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

const MIC_ERRORS: Record<string, string> = {
  "not-allowed": "Microphone blocked: allow it in the browser's site settings.",
  "service-not-allowed": "Speech recognition isn't allowed in this browser.",
  "audio-capture": "No microphone found.",
  network: "Speech recognition needs an internet connection.",
};

/** `onCommand` gets each thing the rider said. `error` explains why the mic stopped, if it did. */
export function useVoice(onCommand: (text: string) => void) {
  const [mode, setMode] = useState<VoiceMode>("off");
  const [error, setError] = useState<string | null>(null);
  const modeRef = useRef<VoiceMode>("off");
  const rec = useRef<SpeechRec | null>(null);
  const heard = useRef<string[]>([]); // hold mode: everything said while the button is down
  const downAt = useRef(0);
  const onCommandRef = useRef(onCommand);
  useEffect(() => {
    onCommandRef.current = onCommand;
  });

  const setBoth = (m: VoiceMode) => {
    modeRef.current = m;
    setMode(m);
  };

  // Close a listening session for good (no "send" on the way out)
  const abort = useCallback(() => {
    const r = rec.current;
    rec.current = null;
    if (!r) return;
    r.onresult = r.onend = r.onerror = null;
    try {
      r.abort();
    } catch {
      // already closed
    }
  }, []);

  const start = useCallback(() => {
    abort(); // never two sessions at once
    const SR = recognizer();
    if (!SR) {
      setError("Speech recognition isn't supported in this browser.");
      setBoth("off");
      return;
    }
    setError(null);
    heard.current = [];
    const r = new SR();
    r.lang = "en-GB";
    r.continuous = true; // keep going until we stop it
    r.interimResults = false; // only finished sentences
    r.onresult = (e) => {
      for (let k = e.resultIndex; k < e.results.length; k++) {
        if (!e.results[k].isFinal) continue;
        const text = e.results[k][0].transcript.trim();
        if (!text || isSpeaking()) continue; // ignore the app's own voice
        if (modeRef.current === "continuous") onCommandRef.current(text);
        else heard.current.push(text);
      }
    };
    r.onerror = (e) => {
      if (e.error === "no-speech") {
        // silence: fine while listening non-stop; when holding, say so (in onend)
        return;
      }
      if (e.error === "aborted") {
        // we never get this for our own stops (handlers are removed first): something else took the mic
        setError("The microphone was taken by another tab or app. Close other OxRide tabs and try again.");
        abort();
        setBoth("off");
        return;
      }
      setError(MIC_ERRORS[e.error] ?? `Microphone error: ${e.error}`);
      abort();
      setBoth("off");
    };
    r.onend = () => {
      if (rec.current !== r) return; // an old session
      if (modeRef.current === "continuous") {
        try {
          r.start(); // browsers stop every so often: carry on listening
        } catch {
          setBoth("off");
        }
        return;
      }
      // hold mode: the button was released -> send what was said
      rec.current = null;
      const text = heard.current.join(" ").trim();
      heard.current = [];
      setBoth("off");
      if (text) onCommandRef.current(text);
      else setError("Didn't catch that. Hold the mic and speak, then let go.");
    };
    rec.current = r;
    try {
      r.start();
    } catch {
      setError("Couldn't start the microphone. Try again.");
      rec.current = null;
      setBoth("off");
    }
  }, [abort]);

  /** Mic button pressed. */
  const press = useCallback(() => {
    if (modeRef.current === "continuous") {
      downAt.current = -1; // a tap to switch it off (handled on release)
      return;
    }
    downAt.current = Date.now();
    setBoth("hold");
    start();
  }, [start]);

  /** Mic button released. */
  const release = useCallback(() => {
    if (downAt.current === -1) {
      abort(); // tapped while listening non-stop: stop
      setBoth("off");
      return;
    }
    if (modeRef.current !== "hold") return;
    if (Date.now() - downAt.current < HOLD_MS) {
      setBoth("continuous"); // a quick tap: keep listening until tapped again
      return;
    }
    try {
      rec.current?.stop(); // held: stop and send (in onend)
    } catch {
      setBoth("off");
    }
  }, [abort]);

  // Let go of the microphone when the page is hidden or closed, so another tab (or this
  // one after a refresh) can use it; Chrome lets only one page do speech recognition.
  useEffect(() => {
    const release = () => {
      if (document.visibilityState === "hidden") {
        abort();
        setBoth("off");
      }
    };
    document.addEventListener("visibilitychange", release);
    window.addEventListener("pagehide", abort);
    return () => {
      document.removeEventListener("visibilitychange", release);
      window.removeEventListener("pagehide", abort);
      abort();
    };
  }, [abort]);
  return { mode, error, press, release, supported: !!recognizer() };
}
