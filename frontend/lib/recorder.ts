// Records the mic for the "record" engine (see lib/voiceLog.ts): start() when the mic
// button goes down, stop() for 16 kHz mono WAV (lib/wav.ts) that Gemini listens to.
// Skips the browser's speech recognition, which on iPhones tends to work once per page.
// The mic is released after every recording: on iPhones an open mic turns the app's
// spoken replies down (they move to the earpiece).

import { encodeWav, peakLevel, toMono } from "./wav";
import { vlog } from "./voiceLog";

const RATE = 16000; // samples per second sent to Gemini (plenty for speech)
// Formats to try, in order (iPhones record mp4, Chrome and Firefox webm/ogg)
const TYPES = [
  "audio/mp4",
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
];

export interface Recording {
  wav: Uint8Array;
  seconds: number;
  peak: number; // loudest sample, 0..1 (about 0 = only silence was recorded)
}

/** This browser can record from the mic. */
export function canRecord(): boolean {
  return (
    typeof window !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== "undefined"
  );
}

export class Recorder {
  private stream: MediaStream | null = null;
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private done = false; // stop() or cancel() was called

  /** Open the mic and start recording. Throws if the mic can't be used. */
  async start(): Promise<void> {
    vlog("record: asking for the mic");
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    if (this.done) {
      // let go before the mic was ready (or the permission prompt was answered)
      stream.getTracks().forEach((t) => t.stop());
      vlog("record: button let go before the mic was ready");
      return;
    }
    this.stream = stream;
    const type = TYPES.find((t) => MediaRecorder.isTypeSupported(t));
    const rec = new MediaRecorder(
      stream,
      type ? { mimeType: type } : undefined,
    );
    this.chunks = [];
    rec.ondataavailable = (e) => {
      if (e.data.size) this.chunks.push(e.data);
    };
    rec.start(250); // hand over data every 250 ms
    this.rec = rec;
    vlog(`record: recording (${rec.mimeType || "default format"})`);
  }

  /** Stop and convert to WAV. null if nothing was recorded. */
  async stop(): Promise<Recording | null> {
    this.done = true;
    const rec = this.rec;
    this.rec = null;
    if (!rec) {
      this.release();
      return null;
    }
    const blob = await new Promise<Blob>((resolve) => {
      const finish = () =>
        resolve(new Blob(this.chunks, { type: rec.mimeType }));
      if (rec.state === "inactive") return finish();
      rec.onstop = finish;
      try {
        rec.stop();
      } catch {
        finish();
      }
    });
    this.release();
    vlog(
      `record: got ${Math.round(blob.size / 1024)} KB of ${blob.type || "audio"}`,
    );
    if (!blob.size) return null;
    // The browser decodes its own format and resamples to RATE (the context's rate)
    const ctx = new OfflineAudioContext(1, RATE, RATE);
    const audio = await ctx.decodeAudioData(await blob.arrayBuffer());
    const channels = Array.from({ length: audio.numberOfChannels }, (_, i) =>
      audio.getChannelData(i),
    );
    const samples = toMono(channels);
    return {
      wav: encodeWav(samples, RATE),
      seconds: samples.length / RATE,
      peak: peakLevel(samples),
    };
  }

  /** Throw away the recording and let go of the mic. */
  cancel(): void {
    this.done = true;
    const rec = this.rec;
    this.rec = null;
    if (rec && rec.state !== "inactive") {
      rec.ondataavailable = null;
      try {
        rec.stop();
      } catch {
        // already stopped
      }
    }
    this.release();
  }

  private release() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}
