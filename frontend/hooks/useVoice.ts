"use client";

// The mic button:
//   hold   -> listens while held, sends what you said when you let go
//   tap    -> keeps listening; every sentence is a command; tap again to stop
// Uses the browser's speech-to-text (Chrome/Safari; needs HTTPS or localhost).
//
// iPhones (Safari) behave differently from Chrome, which this handles:
// - The mic stops whenever the app plays sound (the spoken reply, a turn instruction) and
//   reports it as "aborted". That is not an error: we wait until the app is quiet and
//   listen again.
// - It dislikes being restarted the instant it stops, so restarts wait a moment.
// - It often never marks a sentence as finished, so after a short pause what was heard is
//   sent anyway (lib/heard.ts works out what is new).
// Pressing the mic also stops the app talking, so the rider's words aren't thrown away.

import { useCallback, useEffect, useRef, useState } from "react";
import { heardText, readyToSend, type Heard } from "@/lib/heard";
import { isSpeaking, stopSpeaking } from "@/lib/speak";

export type VoiceMode = "off" | "hold" | "continuous";

const HOLD_MS = 350; // pressed longer than this = hold-to-talk; shorter = a tap
const PAUSE_MS = 1500; // keep-listening: a pause this long ends a command
const RESTART_MS = 300; // wait this long before listening again after the mic stops
const QUICK_END_MS = 1000; // a session this short with nothing heard counts as a failed start
const MAX_QUICK_ENDS = 4; // after this many failed starts in a row, give up and say so

// The clock, for timing presses and sessions. Only called from button handlers and
// timers, never while React is drawing the screen.
const now = () => Date.now();

// The bits of the browser's SpeechRecognition API we use
interface SpeechResults {
  length: number;
  [i: number]: { isFinal: boolean; [j: number]: { transcript: string } };
}
interface SpeechRec {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult:
    | ((e: { resultIndex: number; results: SpeechResults }) => void)
    | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
}

function recognizer(): (new () => SpeechRec) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRec;
    webkitSpeechRecognition?: new () => SpeechRec;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

// The browser's results as plain {text, final} items (lib/heard.ts)
function toHeard(results: SpeechResults): Heard[] {
  const out: Heard[] = [];
  for (let k = 0; k < results.length; k++) {
    out.push({ text: results[k][0].transcript, final: results[k].isFinal });
  }
  return out;
}

// Errors that really stop the mic. ("no-speech" and "aborted" are not on the list: they
// are silence, or an iPhone pausing the mic, and we simply listen again.)
const MIC_ERRORS: Record<string, string> = {
  "not-allowed": "Microphone blocked: allow it in the browser's site settings.",
  "service-not-allowed":
    "Speech recognition isn't allowed. On an iPhone, turn on Siri or Dictation in Settings.",
  "audio-capture": "No microphone found.",
  network: "Speech recognition needs an internet connection.",
};

/** `onCommand` gets each thing the rider said. `error` explains why the mic stopped, if it did. */
export function useVoice(onCommand: (text: string) => void) {
  const [mode, setMode] = useState<VoiceMode>("off");
  const [error, setError] = useState<string | null>(null);
  const modeRef = useRef<VoiceMode>("off");
  const rec = useRef<SpeechRec | null>(null); // the current listening session
  const heard = useRef<Heard[]>([]); // what the current session has heard so far
  const sent = useRef(new Map<number, string>()); // keep-listening: what was already sent
  const held = useRef(""); // hold-to-talk: text from earlier sessions while still held
  const holding = useRef(false); // the button is down right now
  const downAt = useRef(0);
  const quickEnds = useRef(0);
  const pauseTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const restartTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const onCommandRef = useRef(onCommand);
  useEffect(() => {
    onCommandRef.current = onCommand;
  });

  const setBoth = (m: VoiceMode) => {
    modeRef.current = m;
    setMode(m);
  };

  // Close the current listening session for good (nothing is sent on the way out)
  const abort = useCallback(() => {
    clearTimeout(pauseTimer.current);
    clearTimeout(restartTimer.current);
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

  // Turn the mic off, with a message for the rider if something went wrong
  const stopWith = (message: string | null) => {
    abort();
    holding.current = false;
    setBoth("off");
    if (message) setError(message);
  };

  // Keep-listening: send what is ready, but never the app's own voice
  const sendReady = (includeUnfinished: boolean) => {
    const texts = readyToSend(heard.current, sent.current, includeUnfinished);
    if (isSpeaking()) return; // heard while the app was talking: its own voice, not a command
    texts.forEach((t) => onCommandRef.current(t));
  };

  // Hold-to-talk is over: send everything said while the button was down
  const finishHold = () => {
    abort();
    const text = [held.current, heardText(heard.current)]
      .filter(Boolean)
      .join(" ");
    held.current = "";
    heard.current = [];
    setBoth("off");
    if (text) onCommandRef.current(text);
    else setError("Didn't catch that. Hold the mic and speak, then let go.");
  };

  // The mic stopped on its own (iPhone pausing it for the app's voice, a pause in speech,
  // or the browser's time limit): listen again in a moment, unless it keeps failing
  const listenAgain = (startedAt: number) => {
    const failed =
      heard.current.length === 0 && now() - startedAt < QUICK_END_MS;
    quickEnds.current = failed ? quickEnds.current + 1 : 0;
    if (quickEnds.current >= MAX_QUICK_ENDS) {
      if (modeRef.current === "hold" && !holding.current) return finishHold();
      return stopWith(
        "The microphone keeps stopping. Tap the mic to try again.",
      );
    }
    const retry = () => {
      if (modeRef.current === "off") return;
      if (modeRef.current === "hold" && !holding.current) return finishHold();
      if (isSpeaking()) {
        restartTimer.current = setTimeout(retry, RESTART_MS); // wait until the app is quiet
        return;
      }
      listen();
    };
    restartTimer.current = setTimeout(retry, RESTART_MS);
  };

  // One listening session. Keep-listening runs one after another; hold-to-talk usually
  // needs one, but starts another if the phone stops the mic while the button is held.
  const listen = () => {
    const SR = recognizer();
    if (!SR)
      return stopWith("Speech recognition isn't supported in this browser.");
    heard.current = [];
    sent.current = new Map();
    const startedAt = now();
    const r = new SR(); // a fresh one each time: iPhones don't like restarting an old one
    r.lang = "en-GB";
    r.continuous = true; // keep going until we stop it
    r.interimResults = true; // unfinished text too: iPhones may never mark it finished
    r.onresult = (e) => {
      heard.current = toHeard(e.results);
      if (modeRef.current !== "continuous") return; // hold-to-talk: sent when you let go
      sendReady(false); // finished sentences now
      clearTimeout(pauseTimer.current);
      pauseTimer.current = setTimeout(() => sendReady(true), PAUSE_MS); // the rest after a pause
    };
    r.onerror = (e) => {
      if (e.error === "no-speech" || e.error === "aborted") return; // handled in onend
      stopWith(MIC_ERRORS[e.error] ?? `Microphone error: ${e.error}`);
    };
    r.onend = () => {
      if (rec.current !== r) return; // an old session
      clearTimeout(pauseTimer.current);
      rec.current = null;
      if (modeRef.current === "continuous") {
        sendReady(true); // whatever was still waiting for a pause
        return listenAgain(startedAt);
      }
      if (holding.current) {
        // Still held: keep what was heard and listen again
        held.current = [held.current, heardText(heard.current)]
          .filter(Boolean)
          .join(" ");
        heard.current = [];
        return listenAgain(startedAt);
      }
      finishHold(); // let go: send it
    };
    rec.current = r;
    try {
      r.start();
    } catch {
      stopWith("Couldn't start the microphone. Try again.");
    }
  };

  /** Mic button pressed. */
  const press = () => {
    if (modeRef.current === "continuous") {
      downAt.current = -1; // a tap to switch it off (handled on release)
      return;
    }
    stopSpeaking(); // the rider wants to talk: stop the app mid-sentence
    abort(); // never two sessions at once
    downAt.current = now();
    holding.current = true;
    held.current = "";
    quickEnds.current = 0;
    setError(null);
    setBoth("hold");
    listen();
  };

  /** Mic button released. */
  const release = () => {
    holding.current = false;
    if (downAt.current === -1) {
      downAt.current = 0;
      stopWith(null); // tapped while listening non-stop: stop
      return;
    }
    if (modeRef.current !== "hold") return;
    if (now() - downAt.current < HOLD_MS) {
      setBoth("continuous"); // a quick tap: keep listening until tapped again
      return;
    }
    if (!rec.current) return finishHold(); // between two sessions: send now
    try {
      rec.current.stop(); // held: stop and send (in onend)
    } catch {
      finishHold();
    }
  };

  // Let go of the microphone when the page is hidden or closed, so another tab (or this
  // one after a refresh) can use it; Chrome lets only one page do speech recognition.
  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState !== "hidden") return;
      abort();
      holding.current = false;
      modeRef.current = "off";
      setMode("off");
    };
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("pagehide", abort);
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("pagehide", abort);
      abort();
    };
  }, [abort]);

  return { mode, error, press, release, supported: !!recognizer() };
}
