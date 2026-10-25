// Speaking out loud: ElevenLabs (via /speak), the browser's own voice if that fails.
import { speak } from "./api";
import { vlog } from "./voiceLog";

let speakingUntil = 0; // while the app is talking (plus a moment), the mic ignores what it hears
const playing = new Set<() => void>(); // stop functions of everything being said right now

/** True while the app's own voice is playing, so the mic doesn't take it as a command. */
export function isSpeaking(): boolean {
  return Date.now() < speakingUntil;
}

/** Stop everything the app is saying (pressing the mic: the rider wants to talk). */
export function stopSpeaking(): void {
  if (playing.size) vlog("say: stopped (mic pressed)");
  playing.forEach((stop) => stop());
}

/** Say `text`. Returns a function that stops the sound. */
export function say(text: string): () => void {
  let stopped = false;
  let audio: HTMLAudioElement | undefined;
  speakingUntil = Date.now() + 30_000; // until we know how long it is
  const done = () => {
    speakingUntil = Date.now() + 700; // echo dies down
    playing.delete(stop); // finished: nothing left to stop
  };
  vlog(`say: "${text.slice(0, 80)}"`);
  speak(text)
    .then((mp3) => {
      if (stopped) return done(); // Don't play outdated audio
      audio = new Audio(URL.createObjectURL(mp3));
      audio.onended = () => {
        vlog("say: finished");
        done();
      };
      audio.onerror = done;
      return audio.play();
    })
    .catch((e) => {
      // ElevenLabs failed, or the phone refused to play the sound (NotAllowedError)
      vlog(
        `say: ElevenLabs audio failed (${e instanceof Error ? `${e.name}: ${e.message}` : e}), using the phone's voice`,
      );
      if (stopped || !("speechSynthesis" in window)) return done();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "en-GB";
      u.onend = done;
      u.onerror = done;
      window.speechSynthesis.speak(u);
    });
  const stop = () => {
    stopped = true;
    audio?.pause();
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    done();
  };
  playing.add(stop);
  return stop;
}
