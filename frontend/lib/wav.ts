// Recorded sound -> a WAV file, the plainest audio format, which Gemini accepts.
// Phones record in different formats (iPhones mp4, Chrome webm); converting everything
// to 16 kHz mono WAV means the backend always sends Gemini the same thing.
// Pure functions so they can be unit tested (lib/wav.test.ts); lib/recorder.ts uses them.

/** Mix channels to one, by averaging. */
export function toMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const out = new Float32Array(channels[0].length);
  for (const ch of channels) {
    for (let i = 0; i < out.length; i++) out[i] += ch[i] / channels.length;
  }
  return out;
}

/** 16-bit PCM WAV bytes for mono samples in -1..1 at `sampleRate`. */
export function encodeWav(
  samples: Float32Array,
  sampleRate: number,
): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const v = new DataView(bytes.buffer);
  const text = (at: number, s: string) =>
    [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true); // file size after this field
  text(8, "WAVE");
  text(12, "fmt ");
  v.setUint32(16, 16, true); // format block size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); // bytes per second
  v.setUint16(32, 2, true); // bytes per sample
  v.setUint16(34, 16, true); // bits per sample
  text(36, "data");
  v.setUint32(40, samples.length * 2, true);
  samples.forEach((s, i) => {
    const c = Math.max(-1, Math.min(1, s));
    v.setInt16(44 + i * 2, c < 0 ? c * 0x8000 : c * 0x7fff, true);
  });
  return bytes;
}

/** Loudest sample (0..1): near 0 means the mic recorded silence. */
export function peakLevel(samples: Float32Array): number {
  let peak = 0;
  for (const s of samples) peak = Math.max(peak, Math.abs(s));
  return peak;
}

/** Bytes as base64 (what /voice expects in audio_b64). */
export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}
