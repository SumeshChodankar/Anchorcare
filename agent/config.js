// Configuration for the ambient agent daemon.
//
// Reads the same .env the rest of the app uses, so there is one place to change a
// connection string. Validates loudly at startup rather than failing on turn 40.

import { existsSync } from "node:fs";
if (existsSync(".env")) process.loadEnvFile(".env");

const integer = (name, fallback, min, max) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
};

export function config() {
  const uri = process.env.MONGODB_URI_NEW || process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is required. The agent writes to Atlas, not to memory.");

  const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!geminiKey) throw new Error("GEMINI_API_KEY is required for the cognition stage.");

  const subjectIds = (process.env.SUBJECT_IDS || "margaret").split(",").map(s => s.trim()).filter(Boolean);
  if (subjectIds.length !== 1) {
    throw new Error(`The desktop agent serves exactly one subject; SUBJECT_IDS has ${subjectIds.length}. ` +
                    `Set SUBJECT_IDS to a single id, or run one daemon per subject.`);
  }

  const timezone = process.env.TIMEZONE || "Europe/London";
  new Intl.DateTimeFormat("en", { timeZone: timezone });   // throws on a bad zone

  const quiet = (value, fallback) => {
    const time = process.env[value] || fallback;
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error(`${value} must be HH:MM`);
    return time;
  };

  return {
    uri,
    database: process.env.MONGODB_DATABASE || "engram",
    householdId: process.env.HOUSEHOLD_ID || "demo-household",
    subjectId: subjectIds[0],
    timezone,

    // retrieval — must match what db/provision.js built
    searchIndex: process.env.SEARCH_INDEX || "episodes_text",
    vectorIndex: process.env.VECTOR_INDEX || "episodes_auto",
    embeddingMode: process.env.EMBEDDING_MODE || "auto",
    embeddingModel: process.env.VOYAGE_EMBED_MODEL || "voyage-4",
    dimensions: integer("VOYAGE_DIMENSIONS", 1024, 128, 4096),
    nativeRerank: process.env.NATIVE_RERANK === "true",
    nativeRerankModel: process.env.NATIVE_RERANK_MODEL || "rerank-2.5",

    // cognition
    geminiKey,
    geminiModel: process.env.AGENT_MODEL || process.env.GEMINI_MODEL || "gemini-4-argon",
    temperature: Number(process.env.AGENT_TEMPERATURE ?? 0.2),

    // latency — see docs/LATENCY.md. "off" sends no thinking setting at all.
    thinkingLevel: ["", "off"].includes(process.env.AGENT_THINKING_LEVEL ?? "low") ? null
      : (process.env.AGENT_THINKING_LEVEL ?? "low"),
    hedgeAfterMs: integer("AGENT_HEDGE_AFTER_MS", 3500, 500, 60000),
    maxModelAttempts: integer("AGENT_MAX_MODEL_ATTEMPTS", 3, 1, 5),
    transcriptionDeadlineMs: integer("AGENT_TRANSCRIPTION_DEADLINE_MS", 14000, 1000, 120000),
    cognitionDeadlineMs: integer("AGENT_COGNITION_DEADLINE_MS", 12000, 1000, 120000),
    // Answer a plain recall question straight from its one matching approved record.
    fastRecall: process.env.AGENT_FAST_RECALL !== "false",

    // daemon
    host: process.env.AGENT_HOST || "127.0.0.1",
    port: integer("AGENT_PORT", 4319, 1, 65535),
    tickMs: integer("AGENT_TICK_MS", 1500, 250, 60000),
    idleSessionMinutes: integer("AGENT_IDLE_SESSION_MINUTES", 20, 1, 1440),
    maxTurnsPerSession: integer("AGENT_MAX_TURNS_PER_SESSION", 500, 10, 10000),

    // ambient guardrails
    quietStart: quiet("QUIET_START", "22:00"),
    quietEnd: quiet("QUIET_END", "07:00"),
    minUtteranceChars: integer("AGENT_MIN_UTTERANCE_CHARS", 3, 1, 200),
    captureToken: process.env.AGENT_CAPTURE_TOKEN || null
  };
}
