// What the mic heard -> what to send as a command. Pure functions so they can be unit
// tested (npm run test:unit, lib/heard.test.ts); hooks/useVoice.ts uses them.
//
// The browser's speech recognition gives a list of results, one per sentence, each with
// its text so far and whether it is finished. Browsers differ:
// - Chrome marks each sentence finished as soon as you pause.
// - iPhones (Safari) often never mark it finished while listening, and sometimes keep
//   adding the next sentence onto the same result instead of starting a new one.
// So besides finished sentences we also send unfinished ones after a pause (the caller
// decides when, with `includeUnfinished`), and only ever send the new part of a result.

export interface Heard {
  text: string;
  final: boolean; // the browser says this sentence is finished
}

/** Everything heard in this listening session, as one string (hold-to-talk). */
export function heardText(results: Heard[]): string {
  return results
    .map((r) => r.text.trim())
    .filter(Boolean)
    .join(" ");
}

/**
 * Keep-listening mode: the commands to send now. `sent` remembers, per result, the
 * text already sent; it is updated, so nothing is sent twice.
 * - finished results are sent straight away
 * - unfinished ones only when `includeUnfinished` (after a pause, or when the mic stops)
 */
export function readyToSend(
  results: Heard[],
  sent: Map<number, string>,
  includeUnfinished: boolean,
): string[] {
  const out: string[] = [];
  results.forEach((r, i) => {
    if (!r.final && !includeUnfinished) return;
    const text = r.text.trim();
    const before = sent.get(i) ?? "";
    // Only the part that is new since last time. If the browser rewrote words it had
    // already sent, leave it: sending it again would repeat the command.
    if (!text.startsWith(before)) return;
    const fresh = text.slice(before.length).trim();
    if (!fresh) return;
    sent.set(i, text);
    out.push(fresh);
  });
  return out;
}
