// The agent hearing itself.
//
// A speaker in the room is also a voice in the room. Muting the microphone while the
// page talks covers most of it, but not a second tab speaking out of step, a slow
// speaker tail, or someone talking over the reply. The transcript then contains the
// agent's own sentence ("…I've asked your care team to book that for you"), which is
// stored as her words, re-triggers the action it describes, and gets attributed to
// whoever the recogniser guesses ("Jane (Caregiver)").
//
// So everything sent to text-to-speech is remembered for a short while, and any long
// run of those exact words is cut out of a new transcript before it is used.

const WINDOW_MS = 45_000;       // how long a spoken reply can come back as echo
const MIN_RUN = 4;              // words in a row that make a match deliberate, not chance

const key = token => token.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");

/** Remembers what the agent said aloud. */
export class SpokenLog {
  constructor(windowMs = WINDOW_MS) { this.windowMs = windowMs; this.items = []; }
  add(text, at = Date.now()) {
    if (!text) return;
    this.items.push({ text: String(text), at });
    this.items = this.items.filter(i => at - i.at <= this.windowMs).slice(-12);
  }
  recent(now = Date.now()) { return this.items.filter(i => now - i.at <= this.windowMs).map(i => i.text); }
}

/** Longest run of identical consecutive words: [start in a, start in b, length]. */
function longestRun(a, b) {
  let best = [0, 0, 0];
  const prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let diag = 0;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j];
      prev[j] = a[i - 1] && a[i - 1] === b[j - 1] ? diag + 1 : 0;
      if (prev[j] > best[2]) best = [i - prev[j], j - prev[j], prev[j]];
      diag = up;
    }
  }
  return best;
}

/**
 * Removes the agent's own recent words from a transcript.
 * @returns {{ text: string, removed: number, echoOnly: boolean }}
 *   echoOnly: nothing of the person's own is left, so the clip should be dropped.
 */
export function stripEcho(transcript, spoken = []) {
  let tokens = String(transcript ?? "").trim().split(/\s+/).filter(Boolean);
  const original = tokens.length;
  for (const said of spoken) {
    const saidKeys = String(said).split(/\s+/).map(key).filter(Boolean);
    for (;;) {
      const keys = tokens.map(key);
      const [start, , length] = longestRun(keys, saidKeys);
      // A short run counts too when it is the whole transcript (a speaker tail).
      if (length < MIN_RUN && !(length >= 2 && length === keys.filter(Boolean).length)) break;
      tokens = [...tokens.slice(0, start), ...tokens.slice(start + length)];
      if (!tokens.length) break;
    }
  }
  const text = tokens.join(" ").replace(/\s+([?.!,])/g, "$1").trim();
  const ownWords = tokens.map(key).filter(k => k.length > 1).length;
  return { text, removed: original - tokens.length, echoOnly: original > 0 && ownWords < 2 };
}
