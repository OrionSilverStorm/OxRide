// "Hey OxRide" wake word for hands-free voice. Pure text handling, unit tested in voice.test.ts.

// Speech-to-text spells the name in different ways: "OxRide", "ox ride", "Ox-Ride", "ox right", "ox ryde".
const WAKE = /\b(?:(?:hey|hi|ok|okay)[\s,]+)?ox[\s-]?(?:rides?|right|ryde)\b[\s,.!?:]*/i;

/** Did the rider say the wake word, and what did they say after it? */
export function parseWake(transcript: string): { heard: boolean; command: string } {
  const m = WAKE.exec(transcript);
  if (!m) return { heard: false, command: "" };
  return { heard: true, command: transcript.slice(m.index + m[0].length).trim() };
}
