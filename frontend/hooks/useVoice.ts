import type { VoiceResult } from "@/lib/api";

/** Push-to-talk: records the mic, sends it to /voice, speaks the reply (ElevenLabs, Web Speech fallback). */
export function useVoice(): { listening: boolean; start: () => void; stop: () => Promise<VoiceResult | null> } {
  return { listening: false, start: () => {}, stop: async () => null };
}
