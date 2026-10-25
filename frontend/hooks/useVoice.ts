"use client";

// The mic button:
//   hold   -> listens while held, sends what you said when you let go
//   tap    -> keeps listening; every sentence is a command; tap again to stop
//
// Two engines (the switch is in the ?voicelog panel, lib/voiceLog.ts):
//   record  the mic is recorded and Gemini listens to the audio itself (default); hold and
//           let go to send, or tap to start and tap again to send
//   speech  the browser's speech-to-text turns your words into text (unreliable on phones)
// Every step is written to the voice log, so a failure on a phone can be read back.
//
// iPhones (Safari) behave differently from Chrome with speech-to-text, which this handles:
// - The mic stops whenever the app plays sound and reports "aborted": we wait until the
//   app is quiet and listen again.
// - It dislikes being restarted the instant it stops, so restarts wait a moment.
// - It often never marks a sentence as finished, so after a short pause what was heard is
//   sent anyway (lib/heard.ts works out what is new).
// Pressing the mic also stops the app talking, so the rider's words aren't thrown away.

import { useCallback, useEffect, useRef, useState } from "react";
import { heardText, readyToSend, type Heard } from "@/lib/heard";
import { isSpeaking, stopSpeaking } from "@/lib/speak";
import { canRecord, Recorder } from "@/lib/recorder";
import { getMicEngine, vlog, type MicEngine } from "@/lib/voiceLog";
import { toBase64 } from "@/lib/wav";

export type VoiceMode = "off" | "hold" | "continuous";

const HOLD_MS = 350; // pressed longer than this = hold-to-talk; shorter = a tap
const PAUSE_MS = 1500; // keep-listening: a pause this long ends a command
const RESTART_MS = 300; // wait this long before listening again after the mic stops
const QUICK_END_MS = 1000; // a session this short with nothing heard counts as a failed start
const MAX_QUICK_ENDS = 4; // after this many failed starts in a row, give up and say so
const MAX_RECORD_MS = 15000; // record engine: send automatically after this long

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
  onerror: ((e: { error: string; message?: string }) => void) | null;
  // only logged, to see how far a session got
  onstart: (() => void) | null;
  onaudiostart: (() => void) | null;
  onspeechstart: (() => void) | null;
  onspeechend: (() => void) | null;
  onnomatch: (() => void) | null;
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

const errorText = (e: unknown) =>
  e instanceof Error ? `${e.name}: ${e.message}` : String(e);

/**
 * `onCommand` gets each thing the rider said (speech engine); `onAudio` gets a recording
 * as base64 WAV (record engine). `error` explains why the mic stopped, if it did.
 */
export function useVoice(
  onCommand: (text: string) => void,
  onAudio: (audioB64: string, mime: string) => void,
) {
  const [mode, setMode] = useState<VoiceMode>("off");
  const [engine, setEngine] = useState<MicEngine>("record"); // of the current press
  const [error, setError] = useState<string | null>(null);
  const modeRef = useRef<VoiceMode>("off");
  const engineRef = useRef<MicEngine>("record");
  const rec = useRef<SpeechRec | null>(null); // the current listening session
  const recorder = useRef<Recorder | null>(null); // the current recording
  const heard = useRef<Heard[]>([]); // what the current session has heard so far
  const sent = useRef(new Map<number, string>()); // keep-listening: what was already sent
  const held = useRef(""); // hold-to-talk: text from earlier sessions while still held
  const holding = useRef(false); // the button is down right now
  const downAt = useRef(0);
  const quickEnds = useRef(0);
  const pauseTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const restartTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const recordTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const onCommandRef = useRef(onCommand);
  const onAudioRef = useRef(onAudio);
  useEffect(() => {
    onCommandRef.current = onCommand;
    onAudioRef.current = onAudio;
  });

  const setBoth = (m: VoiceMode) => {
    modeRef.current = m;
    setMode(m);
  };

  // Close the current listening session or recording for good (nothing is sent)
  const abort = useCallback(() => {
    clearTimeout(pauseTimer.current);
    clearTimeout(restartTimer.current);
    clearTimeout(recordTimer.current);
    recorder.current?.cancel();
    recorder.current = null;
    const r = rec.current;
    rec.current = null;
    if (!r) return;
    r.onresult = r.onend = r.onerror = null;
    r.onstart =
      r.onaudiostart =
      r.onspeechstart =
      r.onspeechend =
      r.onnomatch =
        null;
    try {
      r.abort();
    } catch {
      // already closed
    }
  }, []);

  // Turn the mic off, with a message for the rider if something went wrong
  const stopWith = (message: string | null) => {
    vlog(`mic off${message ? `: ${message}` : ""}`);
    abort();
    holding.current = false;
    setBoth("off");
    if (message) setError(message);
  };

  // --- speech engine ----------------------------------------------------------------------

  // Keep-listening: send what is ready, but never the app's own voice
  const sendReady = (includeUnfinished: boolean) => {
    const texts = readyToSend(heard.current, sent.current, includeUnfinished);
    if (!texts.length) return;
    if (isSpeaking()) {
      vlog(`ignored while the app was talking: "${texts.join(" ")}"`);
      return;
    }
    texts.forEach((t) => {
      vlog(`send: "${t}"`);
      onCommandRef.current(t);
    });
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
    if (text) {
      vlog(`send: "${text}"`);
      onCommandRef.current(text);
    } else {
      vlog("nothing heard while the mic was held");
      setError("Didn't catch that. Hold the mic and speak, then let go.");
    }
  };

  // The mic stopped on its own (iPhone pausing it for the app's voice, a pause in speech,
  // or the browser's time limit): listen again in a moment, unless it keeps failing
  const listenAgain = (startedAt: number) => {
    const failed =
      heard.current.length === 0 && now() - startedAt < QUICK_END_MS;
    quickEnds.current = failed ? quickEnds.current + 1 : 0;
    if (failed)
      vlog(
        `speech: quick end with nothing heard (${quickEnds.current} in a row)`,
      );
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
      vlog("speech: listening again");
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
    const secs = () => ((now() - startedAt) / 1000).toFixed(1);
    const r = new SR(); // a fresh one each time: iPhones don't like restarting an old one
    r.lang = "en-GB";
    r.continuous = true; // keep going until we stop it
    r.interimResults = true; // unfinished text too: iPhones may never mark it finished
    r.onstart = () => vlog(`speech: started (${secs()} s)`);
    r.onaudiostart = () => vlog(`speech: audio flowing (${secs()} s)`);
    r.onspeechstart = () => vlog(`speech: voice detected (${secs()} s)`);
    r.onspeechend = () => vlog(`speech: voice stopped (${secs()} s)`);
    r.onnomatch = () => vlog("speech: no match");
    r.onresult = (e) => {
      heard.current = toHeard(e.results);
      for (let k = e.resultIndex; k < e.results.length; k++) {
        const h = heard.current[k];
        vlog(`speech: heard #${k} "${h.text}"${h.final ? " (final)" : ""}`);
      }
      if (modeRef.current !== "continuous") return; // hold-to-talk: sent when you let go
      sendReady(false); // finished sentences now
      clearTimeout(pauseTimer.current);
      pauseTimer.current = setTimeout(() => sendReady(true), PAUSE_MS); // the rest after a pause
    };
    r.onerror = (e) => {
      vlog(`speech error: ${e.error}${e.message ? ` (${e.message})` : ""}`);
      if (e.error === "no-speech" || e.error === "aborted") return; // handled in onend
      stopWith(MIC_ERRORS[e.error] ?? `Microphone error: ${e.error}`);
    };
    r.onend = () => {
      if (rec.current !== r) return; // an old session
      vlog(
        `speech: ended after ${secs()} s, ${heard.current.length} result(s)`,
      );
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
    vlog(`speech: start (${modeRef.current})`);
    try {
      r.start();
    } catch (e) {
      vlog(`speech: start() threw ${errorText(e)}`);
      stopWith("Couldn't start the microphone. Try again.");
    }
  };

  // --- record engine ----------------------------------------------------------------------

  const startRecording = () => {
    if (!canRecord()) return stopWith("This browser can't record audio.");
    const r = new Recorder();
    recorder.current = r;
    r.start().catch((e) => {
      vlog(`record: couldn't start, ${errorText(e)}`);
      if (recorder.current !== r) return;
      recorder.current = null;
      const blocked = e instanceof Error && e.name === "NotAllowedError";
      stopWith(
        blocked
          ? MIC_ERRORS["not-allowed"]
          : "Couldn't start the microphone. Try again.",
      );
    });
    recordTimer.current = setTimeout(() => {
      if (recorder.current !== r) return;
      vlog("record: 15 s limit, sending");
      finishRecording();
    }, MAX_RECORD_MS);
  };

  // Stop recording, check there's something in it, and send it to Gemini
  const finishRecording = async () => {
    clearTimeout(recordTimer.current);
    const r = recorder.current;
    recorder.current = null;
    setBoth("off");
    if (!r) return;
    try {
      const got = await r.stop();
      if (!got || got.seconds < 0.3) {
        vlog("record: too short or empty");
        return setError(
          "Didn't catch that. Hold the mic and speak, then let go.",
        );
      }
      vlog(
        `record: ${got.seconds.toFixed(1)} s, loudest ${got.peak.toFixed(2)}`,
      );
      if (got.peak < 0.01) {
        return setError(
          "The mic only recorded silence. Check the browser can use it.",
        );
      }
      onAudioRef.current(toBase64(got.wav), "audio/wav");
    } catch (e) {
      vlog(`record: couldn't convert, ${errorText(e)}`);
      setError("Couldn't process the recording. Try again.");
    }
  };

  // --- the button -------------------------------------------------------------------------

  /** Mic button pressed. */
  const press = () => {
    vlog(`press (mode ${modeRef.current})`);
    if (modeRef.current === "continuous") {
      downAt.current = -1; // a tap to switch it off or send (handled on release)
      return;
    }
    stopSpeaking(); // the rider wants to talk: stop the app mid-sentence
    abort(); // never two sessions at once
    const e = getMicEngine(); // read now, so the switch works without a reload
    engineRef.current = e;
    setEngine(e);
    downAt.current = now();
    holding.current = true;
    held.current = "";
    quickEnds.current = 0;
    setError(null);
    setBoth("hold");
    if (e === "record") startRecording();
    else listen();
  };

  /** Mic button released. */
  const release = () => {
    holding.current = false;
    if (downAt.current === -1) {
      downAt.current = 0;
      vlog("release: tap to finish");
      if (engineRef.current === "record") finishRecording();
      else stopWith(null); // tapped while listening non-stop: stop
      return;
    }
    if (modeRef.current !== "hold") return;
    const heldMs = now() - downAt.current;
    vlog(`release after ${heldMs} ms`);
    if (heldMs < HOLD_MS) {
      vlog("tap: keep listening until the next tap");
      setBoth("continuous");
      return;
    }
    if (engineRef.current === "record") return void finishRecording();
    if (!rec.current) return finishHold(); // between two sessions: send now
    try {
      rec.current.stop(); // held: stop and send (in onend)
    } catch {
      finishHold();
    }
  };

  // Say what this phone supports, once, at the top of the log
  useEffect(() => {
    const sr = window as unknown as Record<string, unknown>;
    vlog(
      `ready: speech-to-text ${sr.SpeechRecognition ? "yes" : sr.webkitSpeechRecognition ? "yes (webkit)" : "no"}, ` +
        `recording ${canRecord() ? "yes" : "no"}, engine "${getMicEngine()}"`,
    );
    vlog(`browser: ${navigator.userAgent}`);
    navigator.permissions
      ?.query({ name: "microphone" as PermissionName })
      .then((p) => vlog(`mic permission: ${p.state}`))
      .catch(() => {});
  }, []);

  // Let go of the microphone when the page is hidden or closed, so another tab (or this
  // one after a refresh) can use it; Chrome lets only one page do speech recognition.
  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState !== "hidden") return;
      if (modeRef.current !== "off") vlog("page hidden: mic released");
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

  return { mode, engine, error, press, release, supported: canRecord() || !!recognizer() };
}
