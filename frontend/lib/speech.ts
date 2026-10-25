// Speaking out loud: ElevenLabs through /speak, the browser's own voice as fallback.
import { speak } from "./api";

let current: HTMLAudioElement | null = null;
let unlocked = false;

/**
 * Phones (iPhones especially) only allow sound after a tap. Call this inside a tap
 * handler (Start ride, the voice button) so later spoken directions can play.
 */
export function unlockAudio() {
  if (unlocked || typeof window === "undefined") return;
  unlocked = true;
  try {
    const silent = new Audio("data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA");
    silent.play().catch(() => {});
    window.speechSynthesis?.speak(new SpeechSynthesisUtterance(""));
  } catch {
    // nothing to unlock on this browser
  }
}

function browserVoice(text: string): Promise<void> {
  return new Promise((resolve) => {
    const synth = typeof window !== "undefined" ? window.speechSynthesis : undefined;
    if (!synth) return resolve();
    synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "en-GB";
    u.onend = () => resolve();
    u.onerror = () => resolve();
    synth.speak(u);
  });
}

/** Say `text`; a newer sentence cuts off the one still playing. Never throws. */
export async function say(text: string): Promise<void> {
  if (!text) return;
  current?.pause();
  window.speechSynthesis?.cancel();
  try {
    const { audio } = await speak(text);
    if (audio) {
      const el = new Audio(`data:audio/mpeg;base64,${audio}`);
      current = el;
      await new Promise<void>((resolve) => {
        el.onended = () => resolve();
        el.onerror = () => resolve();
        el.play().catch(() => resolve());
      });
      return;
    }
  } catch {
    // backend down or ElevenLabs out of credits: use the browser voice
  }
  await browserVoice(text);
}
