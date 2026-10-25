// Hands-free speech capture: loudness in decibels, voice activity detection against
// the room's own noise floor, a short pre-roll so the first syllable is not lost,
// and WAV encoding. No browser APIs here, so the same code runs in the capture page
// (served at /capture/voice.js) and under node --test.
//
// Why PCM and not MediaRecorder chunks: a WebM stream's header lives only in its
// first chunk, so trimming a rolling chunk buffer produced files nothing could
// decode. Raw samples can be trimmed anywhere and wrapped in a fresh WAV header.

export const SAMPLE_RATE = 16_000;          // what the transcription model is sent
export const SILENCE_DB = -100;

/** Root-mean-square level of a block of samples in [-1, 1], in dBFS (0 = full scale). */
export function rmsDbfs(samples) {
  if (!samples.length) return SILENCE_DB;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  const rms = Math.sqrt(sum / samples.length);
  return rms > 0 ? Math.max(SILENCE_DB, 20 * Math.log10(rms)) : SILENCE_DB;
}

/** Box-filter downsampling; plenty for speech going to a recogniser. */
export function downsample(samples, fromRate, toRate = SAMPLE_RATE) {
  if (fromRate === toRate) return Float32Array.from(samples);
  const ratio = fromRate / toRate;
  const out = new Float32Array(Math.floor(samples.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio), end = Math.min(samples.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += samples[j];
    out[i] = end > start ? sum / (end - start) : 0;
  }
  return out;
}

/** 16-bit mono PCM WAV. */
export function encodeWav(samples, sampleRate = SAMPLE_RATE) {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset, text) => { for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i); };
  ascii(0, "RIFF"); view.setUint32(4, 36 + samples.length * 2, true); ascii(8, "WAVE");
  ascii(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  ascii(36, "data"); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return bytes;
}

export const VAD_DEFAULTS = Object.freeze({
  startMarginDb: 12,      // speech must be this far above the room's noise floor…
  minSpeechDb: -55,       // …and never quieter than this, however quiet the room
                          // (raw mic input, no auto-gain: a soft voice at a metre is ~-45)
  stopMarginDb: 6,        // below floor + this counts as silence (hysteresis)
  attackMs: 120,          // loud for this long before it counts as speech (skips clicks)
  hangoverMs: 900,        // quiet for this long ends the utterance
  minUtteranceMs: 350,    // shorter than this is a cough or a knock: discarded
  maxUtteranceMs: 15_000, // cut and send anyway, so one long monologue cannot stall
  preRollMs: 800,         // audio kept from before speech started
  initialFloorDb: -60,
  // The noise floor is the quietest block of the last few seconds. Speech always has
  // dips between words, so it cannot drag the floor up; a fan that stays on becomes
  // the floor within this window, so it cannot pass for speech for long.
  floorWindowMs: 3000
});

/**
 * Feed it blocks of samples at SAMPLE_RATE; it returns a finished utterance (a
 * Float32Array) when one ends, otherwise null. `level()` is for the UI.
 */
export class UtteranceDetector {
  constructor(options = {}) {
    this.o = { ...VAD_DEFAULTS, ...options };
    this.recentDb = [];                 // [db, ms] per block, newest last
    this.recentMs = 0;
    this.lastDb = SILENCE_DB;
    this.reset();
  }

  /** Clears the utterance in progress; keeps what it has learned about the room. */
  reset() {
    this.speaking = false;
    this.loudMs = 0;
    this.quietMs = 0;
    this.chunks = [];
    this.chunkMs = 0;
    this.preRoll = [];
    this.preRollMs = 0;
    this.leadMs = 0;                    // pre-roll at the front of chunks: not speech
  }

  get floorDb() {
    if (!this.recentDb.length) return this.o.initialFloorDb;
    let min = Infinity;
    for (const [db] of this.recentDb) if (db < min) min = db;
    return min;
  }

  learn(db, ms) {
    this.recentDb.push([db, ms]);
    this.recentMs += ms;
    while (this.recentDb.length > 1 && this.recentMs - this.recentDb[0][1] >= this.o.floorWindowMs) {
      this.recentMs -= this.recentDb.shift()[1];
    }
  }

  get startThresholdDb() { return Math.max(this.floorDb + this.o.startMarginDb, this.o.minSpeechDb); }
  get stopThresholdDb() { return Math.max(this.floorDb + this.o.stopMarginDb, this.o.minSpeechDb - 6); }
  level() { return { db: this.lastDb, floorDb: this.floorDb, thresholdDb: this.startThresholdDb, speaking: this.speaking }; }

  push(block) {
    const ms = (block.length / SAMPLE_RATE) * 1000;
    const db = rmsDbfs(block);
    this.lastDb = db;
    this.learn(db, ms);

    if (!this.speaking) {
      this.preRoll.push(block);
      this.preRollMs += ms;
      while (this.preRoll.length > 1 && this.preRollMs - (this.preRoll[0].length / SAMPLE_RATE) * 1000 >= this.o.preRollMs) {
        this.preRollMs -= (this.preRoll.shift().length / SAMPLE_RATE) * 1000;
      }
      if (db >= this.startThresholdDb) {
        this.loudMs += ms;
        if (this.loudMs >= this.o.attackMs) {
          this.speaking = true;
          this.quietMs = 0;
          this.chunks = this.preRoll;
          this.chunkMs = this.preRollMs;
          // The loud blocks that confirmed speech are its start, not pre-roll.
          this.leadMs = Math.max(0, this.preRollMs - this.loudMs);
          this.preRoll = [];
          this.preRollMs = 0;
        }
      } else {
        this.loudMs = 0;
      }
      return null;
    }

    this.chunks.push(block);
    this.chunkMs += ms;
    this.quietMs = db < this.stopThresholdDb ? this.quietMs + ms : 0;
    if (this.quietMs >= this.o.hangoverMs || this.chunkMs >= this.o.maxUtteranceMs) return this.finish();
    return null;
  }

  /** Ends the current utterance now (push-to-talk release). */
  finish() {
    const spokenMs = this.chunkMs - this.leadMs - this.quietMs;
    const parts = this.chunks;
    this.reset();
    if (spokenMs < this.o.minUtteranceMs) return null;
    const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const p of parts) { out.set(p, offset); offset += p.length; }
    return out;
  }
}
