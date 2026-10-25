import dns from "node:dns";
try { dns.setServers(["8.8.8.8", "1.1.1.1"]); } catch {}

// The autonomous agent.
//
//   npm run agent
//   npm run agent -- --dry-run        connect, open a session, answer nothing
//
// WHAT "AUTONOMOUS" MEANS HERE
//
// It runs unattended, indefinitely, with nobody watching: it listens, decides when
// something is worth processing, retrieves, reasons, writes, and escalates on its
// own. That is autonomy of OPERATION.
//
// It is not autonomy of AUTHORITY. It cannot approve a memory, promote an inference,
// or carry out a prohibited action. agent/store.js throws at write time if it tries.
// Those two kinds of autonomy are usually conflated; keeping them apart is what makes
// an always-on agent safe to point at a person with dementia.
//
// WHAT IT DOES EACH TICK
//   1. accept captured speech on POST /capture (written immediately, before reasoning)
//   2. claim the oldest unanswered patient turn
//   3. run the cycle in agent/pipeline.js
//   4. close idle sessions
//
// Press Ctrl-C once for a clean stop: the in-flight turn finishes, the session is
// closed, and the connection drains.

import { createServer } from "node:http";
import { hostname } from "node:os";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { config } from "./config.js";
import { connect, AgentApprovalError } from "./store.js";
import { createReasoner, hedged, thinking } from "./gemini.js";
import { createPipeline } from "./pipeline.js";
import * as callService from "./call-service.js";
import { composeAlertMessage, composeCallScript, sendCaregiverMessage, smsStatus } from "./message-service.js";
import { loadLifeMemory, patientNameFrom } from "./life-memory.js";
import { classifySpeaker } from "./speaker.js";
import { SpokenLog, stripEcho } from "./echo.js";
import { watchOutputs } from "./audio-output.js";
import { buildConversationSession, recordHeardTurn, turnId, appendSeries } from "../db/ingest.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DRY = process.argv.includes("--dry-run");

// HOSTED: running as a Vercel function (vercel/agent-handler.js), not a process on the
// patient's machine. There is no disk, no Windows speaker check and no interval loop,
// and an instance may freeze once its response is sent, so work that outlives a
// response (the rest of a turn, a call, a text) is handed to Vercel's waitUntil.
const HOSTED = process.env.VERCEL === "1";
const background = promise => {
  globalThis[Symbol.for("@vercel/request-context")]?.get?.()?.waitUntil?.(promise);
  return promise;
};

const cfg = config();
const scope = { householdId: cfg.householdId, subjectId: cfg.subjectId };

const stamp = () => new Date().toISOString().slice(11, 19);
const log = (tag, message = "") =>
  console.log(`${stamp()}  ${String(tag).padEnd(18)} ${message}`);

let store, pipeline, server;
let sessionId = null;
let sessionSeq = 0;
let lastActivity = Date.now();
let stopping = false;
let inFlight = null;
const stats = { captured: 0, notRecorded: 0, answered: 0, vetoed: 0, escalated: 0, failed: 0, refused: 0, telemetry: 0 };
let lastLocationState = {
  state: "inside_safe_zone",
  distanceFromHomeMeters: 0,
  distance_from_home: "0.0 miles",
  status_description: "Inside Safe Zone (Home)",
  at: new Date()
};

// ── place names (opt-in) ──────────────────────────────────────────────────
// REVERSE_GEOCODE=osm turns coordinates into a street and area using OpenStreetMap's
// Nominatim service. Off by default: it sends her coordinates to a third party, which
// is a data-protection decision for the care team, not a default. One lookup per
// ~100 m cell, cached, and never more than one request a second (Nominatim's policy).
const placeCache = new Map();
let lastGeocodeAt = 0;
async function placeName({ lat, lng }) {
  if (process.env.REVERSE_GEOCODE !== "osm" || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const cell = `${lat.toFixed(3)},${lng.toFixed(3)}`;
  if (placeCache.has(cell)) return placeCache.get(cell);
  if (Date.now() - lastGeocodeAt < 1100) return null;
  lastGeocodeAt = Date.now();
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=17&lat=${lat}&lon=${lng}`, {
      headers: { "User-Agent": "AnchorCare-prototype/0.1 (local demo)" }, signal: AbortSignal.timeout(4000)
    });
    const a = (await res.json()).address ?? {};
    const name = [a.road, a.suburb || a.neighbourhood || a.quarter, a.city || a.town || a.village].filter(Boolean).join(", ") || null;
    placeCache.set(cell, name);
    return name;
  } catch { return null; }
}

let subjectDisplayName = null;           // identity_core.preferredName, read at boot
const subjectName = () => subjectDisplayName || cfg.subjectId;
const answerWaiters = new Map();       // companion turn id → capture() waiting on it
const spokenLog = new SpokenLog();      // what was said aloud, to recognise it coming back as echo
const turnOrigin = new Map();           // patient turn id → the capture page that asked
let micLogKey = "", micLogAt = 0;
let audioOutput = null;                 // Windows speaker state watcher (agent/audio-output.js)       // de-duplicates /telemetry/mic log lines
const sseClients = new Set();
const recentFeed = [];

function broadcast(event) {
  recentFeed.unshift(event);
  if (recentFeed.length > 50) recentFeed.pop();
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of sseClients) {
    try { client.write(payload); } catch { sseClients.delete(client); }
  }
}

// ── session handling ──────────────────────────────────────────────────────
async function openSession(now) {
  const id = `csession_${now.toISOString().replace(/[:.]/g, "-")}_${cfg.subjectId}`;
  const consent = await store.db.collection("consent_records")
    .findOne({ ...scope, withdrawnAt: null, supersededBy: null });
  const session = buildConversationSession(scope, {
    sessionId: id, channel: "voice", initiatedBy: "patient",
    consentRef: consent?._id ?? null
  }, now);
  await store.safeInsert("conversation_sessions", session);
  sessionId = id;
  sessionSeq = 0;
  log("session-open", id + (consent ? "" : "  (no consent record — proactive actions will refuse)"));
  return id;
}

async function closeSession(reason) {
  if (!sessionId) return;
  const now = new Date();
  await store.safeUpdate("conversation_sessions", { _id: sessionId, ...scope },
    { $set: { endedAt: now, closeReason: reason } });
  log("session-close", `${sessionId}  (${reason})`);
  sessionId = null;
  sessionSeq = 0;
}

async function currentSession(now) {
  if (sessionId && now - lastActivity < cfg.idleSessionMinutes * 60_000
      && sessionSeq < cfg.maxTurnsPerSession) return sessionId;
  if (sessionId) await closeSession(sessionSeq >= cfg.maxTurnsPerSession ? "turn_limit" : "idle_timeout");
  return openSession(new Date(now));
}

// ── Gemini 4 Argon Audio Acoustic Ear & Diarization Engine ───────────────
// Who is speaking is decided by VOICE, never by what is said: a visitor asking "what
// is my name?" is not the patient because the question is personal. With an enrolled
// reference clip the model compares voices; without one, nobody is "verified", and
// spoken personal questions are not answered (see orientationAnswer in pipeline.js).
//
// This is a model's judgement, not biometric verification. A dedicated speaker-
// verification engine (e.g. Picovoice Eagle, on-device) is the production answer.
const ENROLL_DIR = join(HERE, "..", ".voice-enrollment");
let enrollment = null;                  // { audio: Buffer, mimeType, seconds, enrolledAt }

// Hosted, there is no disk: the clip is kept in Atlas (voice_enrollments, one per
// patient), and each instance re-reads it when another one has changed it.
const enrollments = () => store.db.collection("voice_enrollments");

async function loadEnrollment() {
  try {
    if (HOSTED) {
      const doc = await enrollments().findOne({ _id: cfg.subjectId, ...scope });
      enrollment = doc ? { mimeType: doc.mimeType, seconds: doc.seconds, enrolledAt: doc.enrolledAt, audio: Buffer.from(doc.audio.buffer) } : null;
      return;
    }
    const meta = JSON.parse(await readFile(join(ENROLL_DIR, `${cfg.subjectId}.json`), "utf8"));
    const audio = await readFile(join(ENROLL_DIR, `${cfg.subjectId}.wav`));
    enrollment = { ...meta, audio };
  } catch { enrollment = null; }
}
async function refreshEnrollment() {
  if (!HOSTED) return;
  const doc = await enrollments().findOne({ _id: cfg.subjectId, ...scope }, { projection: { enrolledAt: 1 } }).catch(() => undefined);
  if (doc !== undefined && (doc?.enrolledAt ?? null) !== (enrollment?.enrolledAt ?? null)) await loadEnrollment();
}
async function saveEnrollment(meta, audio) {
  if (HOSTED) {
    await enrollments().replaceOne({ _id: cfg.subjectId, ...scope }, { _id: cfg.subjectId, ...scope, ...meta, audio }, { upsert: true });
  } else {
    await mkdir(ENROLL_DIR, { recursive: true });
    await writeFile(join(ENROLL_DIR, `${cfg.subjectId}.wav`), audio);
    await writeFile(join(ENROLL_DIR, `${cfg.subjectId}.json`), JSON.stringify(meta));
  }
  enrollment = { ...meta, audio };
}
async function removeEnrollment() {
  if (HOSTED) await enrollments().deleteOne({ _id: cfg.subjectId, ...scope });
  else {
    await rm(join(ENROLL_DIR, `${cfg.subjectId}.wav`), { force: true });
    await rm(join(ENROLL_DIR, `${cfg.subjectId}.json`), { force: true });
  }
  enrollment = null;
}
const enrollmentInfo = () => enrollment
  ? { enrolled: true, seconds: enrollment.seconds, enrolledAt: enrollment.enrolledAt }
  : { enrolled: false };

let genAiAudioClient = null;
async function transcribeAndDiarizeAudio(audioBuffer, mimeType = "audio/webm", primarySpeaker = "Sumesh") {
  if (!genAiAudioClient) {
    const { GoogleGenAI } = await import("@google/genai");
    genAiAudioClient = new GoogleGenAI({ apiKey: cfg.geminiKey });
  }

  const cleanMime = (mimeType || "audio/webm").split(";")[0].trim();
  const reference = enrollment;
  const prompt = `You are the Acoustic Ear for AnchorCare. Transcribe the NEW CLIP and say who is speaking.

RULES FOR WHO IS SPEAKING
- Decide from the VOICE ONLY (pitch, timbre, accent, age, pace). NEVER from the words: a
  personal question ("what is my name?", "where are my glasses?") says nothing about who asked it.
${reference
  ? `- The REFERENCE CLIP is the enrolled voice of the primary user, "${primarySpeaker}".
  Compare the NEW CLIP's voice with it. sameVoiceAsReference is "yes" only if you are
  confident it is the same person; "no" if it is clearly someone else; otherwise "unsure".
- If the voice is not the reference voice, the speaker is "Others". There is no reference
  recording for anyone else, so never name another person from the voice.`
  : `- No reference voice is enrolled, so you cannot verify anyone. Use "${primarySpeaker}" for
  a single close voice speaking to the device, "Others" for distant voices, several voices,
  a TV or radio, and set sameVoiceAsReference to "unsure".`}
- Background television, radio or chatter is always "Others".
- A synthetic or computer voice (this assistant replying through a speaker) is always "Others".

Return strictly valid JSON:
{
  "transcription": "<exact words spoken in the NEW CLIP, or empty if silence>",
  "speaker": "${primarySpeaker}" | "Others",
  "speakerType": "primary_user" | "others",
  "sameVoiceAsReference": "yes" | "no" | "unsure",
  "confidence": <0..1, how sure you are about the speaker>,
  "matchedDbTopic": "glasses" | "breakfast" | "david_lee" | "garden" | "wandering" | "call_margaret" | "medication" | null
}`;

  const contents = reference
    ? ["REFERENCE CLIP (enrolled primary user):",
       { inlineData: { mimeType: reference.mimeType, data: reference.audio.toString("base64") } },
       "NEW CLIP:",
       { inlineData: { mimeType: cleanMime, data: audioBuffer.toString("base64") } },
       prompt]
    : [{ inlineData: { mimeType: cleanMime, data: audioBuffer.toString("base64") } }, prompt];

  try {
    const response = await hedged(signal => genAiAudioClient.models.generateContent({
      model: cfg.geminiModel,
      contents,
      config: { responseMimeType: "application/json", ...thinking(cfg), abortSignal: signal }
    }), { hedgeAfterMs: cfg.hedgeAfterMs, deadlineMs: cfg.transcriptionDeadlineMs, maxAttempts: cfg.maxModelAttempts });

    const raw = response.text || "";
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      const heard = JSON.parse(match[0]);
      // With a reference enrolled, only a confident voice match is the primary user.
      heard.verified = Boolean(reference) && heard.sameVoiceAsReference === "yes";
      if (reference && heard.speakerType === "primary_user" && !heard.verified) {
        heard.speakerType = "others";
        heard.speaker = "Others";
      }
      return heard;
    }
  } catch (err) {
    log("gemini-audio-error", err.message);
    // Not silence: someone spoke and was not heard, so the caller must say so.
    return { transcription: "", failed: true, speaker: primarySpeaker, speakerType: "primary_user",
             confidence: null, matchedDbTopic: null };
  }

  return {
    transcription: "",
    speaker: primarySpeaker,
    speakerType: "primary_user",
    confidence: 0.5,
    matchedDbTopic: null
  };
}

const NOT_HEARD = "Sorry, I didn't catch that. Could you say it again?";

// ── capture ingest ────────────────────────────────────────────────────────
// Writes words BEFORE anything else happens to them. If the model call, the
// retrieval or the process itself dies next, the record of what she said survives.
async function capture({ text, confidence, engine, language, speaker, speakerType, speakerMethod, verified, locationContext, clientId }) {
  if (locationContext && locationContext.state) {
    const meters = Number(locationContext.distanceFromHomeMeters ?? 0);
    const distanceMiles = (meters / 1609.34).toFixed(2);
    lastLocationState = {
      ...lastLocationState,
      ...locationContext,
      distanceFromHomeMeters: meters,
      distance_from_home: `${distanceMiles} miles`,
      status_description: locationContext.state === "left_safe_zone"
        ? `Outside Safe Zone, ${distanceMiles} miles from Home`
        : "Inside Safe Zone (Home)",
      at: new Date()
    };
  }

  const trimmed = String(text ?? "").trim();
  if (trimmed.length < cfg.minUtteranceChars) return { ignored: "too short" };

  // Only her own words become patient turns; see agent/speaker.js.
  const { role, speaker: heard } = classifySpeaker({
    speaker, speakerType, confidence, method: speakerMethod ?? "declared", verified
  });
  const speakerName = heard.name ?? (role === "patient" ? "Patient" : "Unidentified");
  if (!role) {
    stats.notRecorded++;
    log("not-recorded", `[${speakerName}] unidentified speaker, ${trimmed.length} chars dropped`);
    return { ignored: "unidentified_speaker", speaker: speakerName, speakerType: speakerType ?? heard.kind };
  }

  const now = Date.now();
  const id = await currentSession(now);
  const seq = sessionSeq;
  sessionSeq += role === "patient" ? 2 : 1;   // a patient turn reserves the next seq for its answer
  lastActivity = now;

  const { turn } = await recordHeardTurn(store, scope, {
    sessionId: id, seq, role, speaker: heard, text: trimmed, modality: "speech",
    transcript: { engine: engine ?? "gemini-4-argon", version: "multimodal-audio",
                  language: language ?? "en-GB", confidence: heard.confidence,
                  isFinal: true, partialCount: 0, alternatives: [] },
    audio: { storage: "none" },          // retention is off by default; see §19.4
    startedAt: new Date(now)
  }, new Date(now));

  stats.captured++;
  log("captured", `[${speakerName} · ${role}] seq ${seq}  "${trimmed.slice(0, 60)}${trimmed.length > 60 ? "…" : ""}"`);
  broadcast({
    type: role === "patient" ? "patient_turn" : "heard_turn",
    turnId: turn._id,
    sessionId: id,
    seq,
    role,
    text: trimmed,
    speaker: speakerName,
    speakerType: speakerType ?? heard.kind,
    at: new Date(now)
  });

  // The loop answers only the patient; a caregiver's remark is recorded, not replied to.
  if (role !== "patient") {
    return {
      turnId: turn._id, sessionId: id, seq, role,
      speaker: speakerName, speakerType: speakerType ?? heard.kind,
      companionTurnId: null, answer: null, basis: null, alertIds: []
    };
  }

  // Hand this turn straight to the loop, and wait for its answer so the caller gets a
  // voice-ready reply. The loop resolves the waiter the moment the answer exists; the
  // database poll only covers an answer written by another worker.
  const expectedTurnId = turnId(id, seq + 1);
  if (clientId) {
    turnOrigin.set(turn._id, String(clientId).slice(0, 64));
    if (turnOrigin.size > 200) turnOrigin.delete(turnOrigin.keys().next().value);
  }
  const companionTurn = await new Promise(resolve => {
    let done = false;
    const settle = doc => {
      if (done) return;
      done = true;
      clearInterval(poll); clearTimeout(timer);
      answerWaiters.delete(expectedTurnId);
      resolve(doc);
    };
    answerWaiters.set(expectedTurnId, settle);
    const poll = setInterval(async () => {
      try {
        const doc = await store.db.collection("conversation_turns").findOne({ _id: expectedTurnId });
        if (doc?.text) settle(doc);
      } catch {}
    }, 1000);
    const timer = setTimeout(() => settle(null), 22_000);
    setImmediate(() => { background(tick(turn).catch(() => {})); });
    // Hosted, no interval loop backs this up: if a turn was in flight, offer this one
    // again until it has its answer (the timer above bounds the wait).
    if (HOSTED) background((async () => {
      while (answerWaiters.has(expectedTurnId)) {
        await new Promise(r => setTimeout(r, 400));
        await tick(turn).catch(() => {});
      }
    })());
  });

  return {
    turnId: turn._id,
    sessionId: id,
    seq,
    role,
    speaker: speakerName,
    speakerType: speakerType ?? heard.kind,
    companionTurnId: expectedTurnId,
    answer: companionTurn?.text || null,
    basis: companionTurn?.epistemic || null,
    alertIds: companionTurn?.safety?.alertIds || [],
    alertReasons: companionTurn?.safety?.alertReasons || []
  };
}

// ── the loop ──────────────────────────────────────────────────────────────
// A turn is answered by exactly one worker: unanswered is not enough, the worker must
// also win the turn's lease. Outlives the model deadline, and a crashed worker's turn
// becomes claimable again once it lapses.
const ANSWER_LEASE_MS = 120_000;
const WORKER_ID = `${hostname()}:${process.pid}`;

async function firstClaimable(turns, claim) {
  for (const turn of turns) {
    const answered = await store.db.collection("conversation_turns")
      .countDocuments({ _id: turnId(turn.sessionId, turn.seq + 1) }, { limit: 1 });
    if (answered) continue;
    if (!claim) return turn;
    if (await store.claim(`answer:${turn._id}`, { owner: WORKER_ID, leaseMs: ANSWER_LEASE_MS })) return turn;
  }
  return null;
}

async function claimNext({ claim = true } = {}) {
  // If there is an active session, answer turns in THIS session first!
  if (sessionId) {
    const sessionPending = await store.db.collection("conversation_turns")
      .find({ ...scope, sessionId, role: "patient" }).sort({ seq: 1 }).limit(10).toArray();
    const turn = await firstClaimable(sessionPending, claim);
    if (turn) return turn;
  }

  // Otherwise, the latest unanswered patient turn
  const pending = await store.db.collection("conversation_turns")
    .find({ ...scope, role: "patient" }).sort({ startedAt: -1 }).limit(10).toArray();
  return firstClaimable(pending, claim);
}

/** capture() hands its turn in directly, which skips scanning for it. */
async function claimPreferred(preferred) {
  if (!preferred || DRY) return null;
  return await store.claim(`answer:${preferred._id}`, { owner: WORKER_ID, leaseMs: ANSWER_LEASE_MS })
    ? preferred : null;
}

async function tick(preferred = null) {
  if (stopping || inFlight) return;
  // Held across the claim's awaits: set only after them, a second tick (capture's
  // immediate one and the interval's) could pass the check above and claim it too.
  inFlight = "claiming";
  let turn;
  try {
    turn = await claimPreferred(preferred)
      ?? await claimNext({ claim: !DRY });     // a dry run must not lease turns away
  } finally {
    if (!turn || DRY) inFlight = null;
  }
  if (!turn) {
    if (sessionId && Date.now() - lastActivity > cfg.idleSessionMinutes * 60_000) {
      await closeSession("idle_timeout");
    }
    return;
  }
  if (DRY) { log("dry-run", `would answer ${turn._id}`); return; }

  inFlight = turn._id;
  const started = Date.now();
  try {
    const result = await pipeline.run(turn, lastLocationState);
    stats.answered++;
    if (result.alertIds.length) stats.escalated += result.alertIds.length;
    if (result.care.model.name === "scripted") stats.vetoed++;

    log("answered",
      `${Date.now() - started}ms  basis=${result.care.epistemicBasis}  ` +
      `cited=${result.care.evidenceIds.length}  model=${result.care.model.name}  "${result.care.answer.slice(0, 70)}…"`);
    answerWaiters.get(result.companion._id)?.(result.companion);
    spokenLog.add(result.care.answer);

    broadcast({
      type: "companion_answer",
      turnId: result.companion._id,
      patientTurnId: turn._id,
      originClientId: turnOrigin.get(turn._id) ?? null,
      patientText: turn.text,
      answer: result.care.answer,
      basis: result.care.epistemicBasis,
      latencyMs: Date.now() - started,
      alertIds: result.alertIds,
      alertReasons: result.alertReasons,
      wanderingDetected: result.care.wanderingDetected,
      escalationRequired: result.care.escalationRequired,
      at: new Date()
    });

    await appendSeries(store.db, "engagement_ts", {
      series: { ...scope, channel: "voice", eventType: "turn_answered" },
      sourceEventId: result.companion._id,
      measurement: { at: new Date(), latencyMs: Date.now() - started,
                     cited: result.care.evidenceIds.length,
                     basis: result.care.epistemicBasis },
      timeField: "at", now: new Date()
    }).catch(() => {});
  } catch (error) {
    if (error instanceof AgentApprovalError) {
      stats.refused++;
      log("REFUSED", error.message);     // the guard did its job
    } else {
      stats.failed++;
      log("failed", `${turn._id}: ${error.message}`);
      // Mark it answered-with-nothing so the loop does not spin on one bad turn.
      await store.safeInsert("conversation_turns", {
        _id: turnId(turn.sessionId, turn.seq + 1), ...scope,
        sessionId: turn.sessionId, seq: turn.seq + 1,
        role: "companion", epistemic: "generated",
        text: "I'm having trouble just now. Jane can help.",
        startedAt: new Date(), endedAt: new Date(), transcript: null,
        audio: { storage: "none", ref: null, bytes: 0, durationMs: 0, retainUntil: null },
        sourceId: null, groundedOn: [], disclosure: null,
        safety: { precheck: "pass", vetoConstraintId: null, alertIds: [] },
        model: { name: "fallback", version: String(error.message).slice(0, 120),
                 promptDigest: null, temperature: null, tokensIn: 0, tokensOut: 0 },
        latency: null, inferenceIds: [], caregiverAnnotation: null,
        redacted: false, redactionRef: null
      }).catch(() => {});
    }
  } finally {
    inFlight = null;
  }
}

// ── access (hosted) ───────────────────────────────────────────────────────
// On a public URL this page can place real calls, so every route but the page itself
// needs the care team's key. The browser sends it once to /login and then holds a
// digest of it in an HttpOnly cookie, which also covers the page's EventSource.
// Locally the daemon listens on 127.0.0.1 only and stays open unless AGENT_ACCESS_KEY is set.
const ACCESS_KEY = process.env.AGENT_ACCESS_KEY || (HOSTED ? process.env.ANCHORCARE_COMPANION_KEY : "") || "";
const accessDigest = key => createHash("sha256").update("anchorcare-agent:" + key).digest("hex");
const sameText = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const OPEN_PAGES = new Set(["/", "/capture", "/capture/voice.js"]);
const failedLogins = new Map();          // ip → { count, until }

function withAccess(handle) {
  return async (req, res) => {
    if (!ACCESS_KEY) return handle(req, res);
    const path = new URL(req.url, "http://agent").pathname;
    if (req.method === "GET" && OPEN_PAGES.has(path)) return handle(req, res);
    const json = { "content-type": "application/json" };
    if (req.method === "POST" && path === "/login") {
      const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
      const failed = failedLogins.get(ip);
      if (failed && failed.until > Date.now() && failed.count >= 10) { res.writeHead(429, json).end(JSON.stringify({ error: "too many attempts; wait a minute" })); return; }
      let body = "";
      for await (const chunk of req) { body += chunk; if (body.length > 4096) { res.writeHead(413).end(); return; } }
      let key = "";
      try { key = String(JSON.parse(body || "{}").key || ""); } catch {}
      if (!sameText(accessDigest(key), accessDigest(ACCESS_KEY))) {
        failedLogins.set(ip, { count: (failed && failed.until > Date.now() ? failed.count : 0) + 1, until: Date.now() + 60_000 });
        res.writeHead(401, json).end(JSON.stringify({ error: "that key is not right" }));
        return;
      }
      res.writeHead(204, { "Set-Cookie": `agent_access=${accessDigest(ACCESS_KEY)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${HOSTED ? "; Secure" : ""}` }).end();
      return;
    }
    const cookie = /(?:^|;\s*)agent_access=([a-f0-9]{64})/.exec(req.headers.cookie || "")?.[1] || "";
    if (!sameText(cookie, accessDigest(ACCESS_KEY))) {
      res.writeHead(401, json).end(JSON.stringify({ error: "access key required" }));
      return;
    }
    return handle(req, res);
  };
}

/** The request handler for Vercel (vercel/agent-handler.js); the module has booted by the time it is imported. */
export const handler = withAccess((req, res) => handleRequest(req, res));

// ── http: capture endpoint + the capture page ─────────────────────────────
function httpServer() {
  return createServer(withAccess(handleRequest));
}

async function handleRequest(req, res) {
  const origin = req.headers.origin;
  res.setHeader("Access-Control-Allow-Origin", origin ?? "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type, x-agent-token");
  if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }

  const url = new URL(req.url, `http://${cfg.host}:${cfg.port}`);

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/capture")) {
    const html = await readFile(join(HERE, "capture.html"), "utf8");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
    return;
  }

  // Voice enrolment: one reference clip of the primary user, kept on this machine only
  // (.voice-enrollment/, git-ignored) and deletable from the capture page.
  if (url.pathname === "/voice/enroll") {
    if (cfg.captureToken && req.headers["x-agent-token"] !== cfg.captureToken) {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "bad token" }));
      return;
    }
    try {
      if (req.method === "GET") {
        await refreshEnrollment();
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(enrollmentInfo()));
        return;
      }
      if (req.method === "DELETE") {
        await removeEnrollment();
        log("voice-enroll", "removed");
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(enrollmentInfo()));
        return;
      }
      if (req.method === "POST") {
        let body = "";
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 3_000_000) { res.writeHead(413).end(); return; }
        }
        const p = JSON.parse(body || "{}");
        const audio = Buffer.from(String(p.audio || ""), "base64");
        const seconds = Number(p.seconds);
        if (audio.length < 1000 || !(seconds >= 3 && seconds <= 30)) {
          res.writeHead(400, { "content-type": "application/json" })
             .end(JSON.stringify({ error: "a 3–30 second clip of one voice is needed" }));
          return;
        }
        const meta = { mimeType: p.mimeType === "audio/wav" ? "audio/wav" : "audio/webm", seconds, enrolledAt: new Date().toISOString() };
        await saveEnrollment(meta, audio);
        log("voice-enroll", `${seconds.toFixed(1)} s reference saved`);
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(enrollmentInfo()));
        return;
      }
      res.writeHead(405).end();
    } catch (error) {
      res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/capture/voice.js") {
    const js = await readFile(join(HERE, "voice-capture.js"), "utf8");
    res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" }).end(js);
    return;
  }

  if (req.method === "GET" && url.pathname === "/status") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
      subjectId: cfg.subjectId, sessionId, sessionSeq, stats,
      model: cfg.geminiModel, embeddingMode: cfg.embeddingMode, dryRun: DRY,
      location: lastLocationState,
      audioOutput: audioOutput?.get() ?? null,
      latestFeed: recentFeed.slice(0, 10)
    }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    });
    res.write(`data: ${JSON.stringify({ type: "init", recent: recentFeed.slice(0, 30), location: lastLocationState, stats, audioOutput: audioOutput?.get() ?? null })}\n\n`);
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  if (req.method === "GET" && url.pathname === "/feed") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
      feed: recentFeed,
      location: lastLocationState,
      stats
    }));
    return;
  }

  if (req.method === "POST" && (url.pathname === "/telemetry/gps" || url.pathname === "/gps")) {
    if (cfg.captureToken && req.headers["x-agent-token"] !== cfg.captureToken) {
      res.writeHead(401, { "content-type": "application/json" })
         .end(JSON.stringify({ error: "bad token" }));
      return;
    }
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 64_000) { res.writeHead(413).end(); return; }
    }
    try {
      const payload = JSON.parse(body || "{}");
      // The capture page measures distance from the home it calibrated; 0 means "at home",
      // not "unknown". Only a sender that gives no distance at all is measured here, and
      // only against a home configured in .env — never a made-up default, which once put
      // a person sitting at home "2.35 miles away" and called her care team.
      const given = payload.distanceFromHomeMeters ?? payload.distanceMeters;
      let meters = Number(given ?? 0);
      const homeLat = Number(process.env.HOME_LAT), homeLng = Number(process.env.HOME_LNG);
      if (given == null && payload.latitude != null && payload.longitude != null
          && Number.isFinite(homeLat) && Number.isFinite(homeLng) && process.env.HOME_LAT) {
        const R = 6371e3;
        const phi1 = homeLat * Math.PI / 180, phi2 = payload.latitude * Math.PI / 180;
        const dPhi = (payload.latitude - homeLat) * Math.PI / 180;
        const dLambda = (payload.longitude - homeLng) * Math.PI / 180;
        const a = Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
        meters = Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
      }
      const distanceMiles = (meters / 1609.34).toFixed(2);
      // The capture page already judged inside/outside against the fix's accuracy; trust
      // its state. Without one, apply the same rule here.
      const isOutside = payload.state
        ? ["left_safe_zone", "outside_safe_zone"].includes(payload.state)
        : meters - (Number(payload.accuracy) || 0) > 50;
      const coords = payload.latitude != null && payload.longitude != null
        ? { lat: Number(payload.latitude), lng: Number(payload.longitude) } : null;
      lastLocationState = {
        state: isOutside ? "left_safe_zone" : "inside_safe_zone",
        distanceFromHomeMeters: meters,
        distance_from_home: `${distanceMiles} miles`,
        status_description: isOutside ? `Outside Safe Zone, ${distanceMiles} miles from Home` : "Inside Safe Zone (Home)",
        coords,
        accuracy: payload.accuracy ?? null,
        placeName: coords ? await placeName(coords) : null,
        at: new Date(payload.timestamp || Date.now())
      };
      stats.telemetry++;
      log("gps-telemetry", `${lastLocationState.state} (${lastLocationState.distance_from_home})`);

      broadcast({
        type: "gps",
        state: lastLocationState.state,
        distance: lastLocationState.distance_from_home,
        description: lastLocationState.status_description,
        coords: lastLocationState.coords,
        at: lastLocationState.at
      });

      await appendSeries(store.db, "telemetry_ts", {
        series: { ...scope, metric: "geofence_status" },
        sourceEventId: `gps_${payload.timestamp || Date.now()}`,
        measurement: {
          state: lastLocationState.state,
          distanceMiles: parseFloat(distanceMiles),
          statusDescription: lastLocationState.status_description,
          at: lastLocationState.at
        },
        timeField: "at", now: new Date()
      }).catch(() => {});

      res.writeHead(200, { "content-type": "application/json" })
         .end(JSON.stringify({ status: "recorded", location: lastLocationState }));
    } catch (error) {
      log("gps-failed", error.message);
      res.writeHead(500, { "content-type": "application/json" })
         .end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/capture") {
    if (cfg.captureToken && req.headers["x-agent-token"] !== cfg.captureToken) {
      res.writeHead(401, { "content-type": "application/json" })
         .end(JSON.stringify({ error: "bad token" }));
      return;
    }
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 64_000) { res.writeHead(413).end(); return; }
    }
    try {
      const result = await capture(JSON.parse(body || "{}"));
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
    } catch (error) {
      log("capture-failed", error.message);
      res.writeHead(500, { "content-type": "application/json" })
         .end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/capture/audio") {
    if (cfg.captureToken && req.headers["x-agent-token"] !== cfg.captureToken) {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "bad token" }));
      return;
    }
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 15_000_000) { res.writeHead(413).end(); return; }
    }
    try {
      await refreshEnrollment();
      const payload = JSON.parse(body || "{}");
      const audioBase64 = payload.audio;
      const mimeType = payload.mimeType || "audio/webm";
      const locationContext = payload.locationContext;
      const clientId = payload.clientId;
      const primarySpeaker = (payload.primarySpeaker || payload.userName || "Sumesh").trim();

      if (!audioBase64) {
        res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "missing audio" }));
        return;
      }

      const audioBuf = Buffer.from(audioBase64, "base64");
      const diarization = await transcribeAndDiarizeAudio(audioBuf, mimeType, primarySpeaker);
      log("acoustic-ear", `[${diarization.speaker}] (${diarization.confidence}) "${diarization.transcription}"`);

      let trimmed = (diarization.transcription || "").trim();
      const echo = stripEcho(trimmed, spokenLog.recent());
      if (echo.removed) {
        log("echo", `removed ${echo.removed} word(s) of the agent's own reply${echo.echoOnly ? ": whole clip was echo, dropped" : `, kept "${echo.text.slice(0, 60)}"`}`);
        if (echo.echoOnly) {
          res.writeHead(200, { "content-type": "application/json" })
             .end(JSON.stringify({ ignored: "echo", speaker: diarization.speaker, speakerType: diarization.speakerType }));
          return;
        }
        trimmed = echo.text;
      }
      if (diarization.failed) {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          ignored: "transcription_unavailable",
          answer: NOT_HEARD,
          companionTurnId: `not_heard_${Date.now()}`,
          speaker: diarization.speaker,
          speakerType: diarization.speakerType
        }));
        return;
      }
      if (!trimmed || trimmed.length < 2) {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          ignored: "silence",
          speaker: diarization.speaker,
          speakerType: diarization.speakerType
        }));
        return;
      }

      const captureResult = await capture({
        text: trimmed,
        clientId,
        engine: "gemini-4-argon-audio",
        speaker: diarization.speaker,
        speakerType: diarization.speakerType,
        speakerMethod: "diarization",
        verified: diarization.verified === true,
        confidence: diarization.confidence,
        locationContext
      });

      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        transcription: trimmed,
        speaker: diarization.speaker,
        speakerType: diarization.speakerType,
        confidence: diarization.confidence,
        matchedDbTopic: diarization.matchedDbTopic,
        ...captureResult
      }));
    } catch (error) {
      log("capture-audio-failed", error.message);
      res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/tts") {
    const text = (url.searchParams.get("text") || "").trim();
    spokenLog.add(text);
    if (!text) { res.writeHead(400).end("Missing text"); return; }
    try {
      const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [text];
      const buffers = [];
      for (const s of sentences) {
        const trimmed = s.trim();
        if (!trimmed) continue;
        const ttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=en-GB&q=${encodeURIComponent(trimmed.slice(0, 200))}`;
        const ttsRes = await fetch(ttsUrl, {
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
          signal: AbortSignal.timeout(6000)
        });
        if (ttsRes.ok) {
          buffers.push(Buffer.from(await ttsRes.arrayBuffer()));
        }
      }
      if (!buffers.length) throw new Error("No audio generated");
      const combined = Buffer.concat(buffers);
      log("tts", `${buffers.length}/${sentences.length} sentence(s), ${combined.length} bytes  "${text.slice(0, 50)}"`);
      res.writeHead(200, {
        "Content-Type": "audio/mpeg",
        "Content-Length": combined.length,
        "Accept-Ranges": "bytes",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=86400"
      });
      res.end(combined);
    } catch (err) {
      log("tts-failed", err.message);
      res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Mic health from the capture page, logged when something changes or every 30 s.
  if (req.method === "POST" && url.pathname === "/telemetry/mic") {
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 4_000) { res.writeHead(413).end(); return; }
    }
    try {
      const m = JSON.parse(body || "{}");
      const db = v => Number.isFinite(v) ? `${Math.round(v)}` : "?";
      const line = `peak ${db(m.peakDb)} dBFS · room ${db(m.floorDb)} · trigger ${db(m.thresholdDb)} · ` +
        `${m.active ? (m.aiSpeaking ? "muted (AI talking)" : m.speaking ? "hearing speech" : "listening") : "mic OFF"}` +
        `${m.enrolling ? " · waiting for enrolment sentence" : ""} · ${m.utterances} utterance(s)` +
        `${m.event ? ` · ${m.event}${Number.isFinite(m.seconds) ? ` ${m.seconds.toFixed(1)} s` : ""}` : ""}` +
        `${m.track ? ` · mic "${String(m.track).slice(0, 50)}"` : ""}`;
      const key = line.replace(/peak -?\d+|room -?\d+|trigger -?\d+/g, "");
      if (m.event || key !== micLogKey || Date.now() - micLogAt > 30_000 || m.peakDb > m.thresholdDb) {
        log("mic", line);
        micLogKey = key;
        micLogAt = Date.now();
      }
    } catch {}
    res.writeHead(204).end();
    return;
  }

  // The capture page reports what happened to each spoken reply, so a silent speaker
  // can be told apart from a reply that never played.
  if (req.method === "POST" && url.pathname === "/telemetry/playback") {
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 4_000) { res.writeHead(413).end(); return; }
    }
    try {
      const p = JSON.parse(body || "{}");
      const num = v => Number.isFinite(v) ? `${v.toFixed(1)}s` : "";
      if (p.phase === "started" && Number.isFinite(p.seconds)) {
        broadcast({ type: "speaking", until: Date.now() + Math.round(p.seconds * 1000) + 600 });
      }
      log("playback", [p.engine, p.phase, num(p.seconds), p.playedSeconds != null ? `played ${num(p.playedSeconds)}` : "",
                       `ctx=${p.ctx}`, `speaker="${String(p.speaker ?? "").slice(0, 60)}"`,
                       p.error ? `error="${String(p.error).slice(0, 120)}"` : ""].filter(Boolean).join("  "));
    } catch {}
    res.writeHead(204).end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/call/status") {
    res.writeHead(200, { "content-type": "application/json" })
       .end(JSON.stringify(callService.getCallStatus()));
    return;
  }

  if (req.method === "POST" && url.pathname === "/call/trigger") {
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 64_000) { res.writeHead(413).end(); return; }
    }
    try {
      const payload = JSON.parse(body || "{}");
      const result = await callService.initiateCall({
        targetNumber: payload.to,
        reason: payload.reason || "Manual Call Request",
        anonymous: payload.anonymous !== false,
        broadcast
      });
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
    } catch (error) {
      res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/call/config") {
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 64_000) { res.writeHead(413).end(); return; }
    }
    try {
      const payload = JSON.parse(body || "{}");
      if (payload.targetPhoneNumber !== undefined) {
        callService.setTargetPhoneNumber(payload.targetPhoneNumber);
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(callService.getCallStatus()));
    } catch (error) {
      res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  res.writeHead(404).end();
}

// ── boot ──────────────────────────────────────────────────────────────────
try {
  store = await connect(cfg);
  const build = await store.db.admin().command({ buildInfo: 1 });

  console.log(`
  Anchorcare ambient agent${DRY ? "  [DRY RUN]" : ""}
  subject   ${cfg.subjectId} · household ${cfg.householdId}
  cluster   MongoDB ${build.version} · db ${cfg.database}
  model     ${cfg.geminiModel} · embedding ${cfg.embeddingMode}
  capture   http://${cfg.host}:${cfg.port}/capture
`);

  if (Number(build.version.split(".")[0]) < 8) {
    log("warning", `MongoDB ${build.version}: $rankFusion needs 8.0+. Hybrid recall will fail.`);
  }
  const consent = await store.db.collection("consent_records")
    .countDocuments({ ...scope, withdrawnAt: null, supersededBy: null });
  if (!consent) {
    log("warning", `no consent record for ${cfg.subjectId} — see npm run schema:seed-consent`);
  }
  await loadEnrollment();
  log("voice", enrollment ? `enrolled reference voice: ${enrollment.seconds.toFixed(1)} s` : "no voice enrolled: spoken personal questions will not be answered");
  const identity = await store.db.collection("identity_core")
    .findOne({ _id: cfg.subjectId }, { projection: { preferredName: 1 } });
  // The name callers and texts use: identity_core first, else the approved identity record.
  subjectDisplayName = identity?.preferredName
    ?? patientNameFrom(await loadLifeMemory(store.db, scope, new Date()).catch(() => null)) ?? null;
  log("subject", `calls and texts will name ${subjectName()}`);
  const approved = await store.db.collection("episodes")
    .countDocuments({ ...scope, reviewStatus: "approved", isCurrent: true });
  log("ready", `${approved} approved episode(s) retrievable`);
  if (!approved) log("warning", "nothing approved: every answer will be 'I don't have anything written down'");

  pipeline = createPipeline({
    cfg,
    store,
    reason: createReasoner(cfg),
    log,
    onCall: (turn, reason) => {
      // The caregiver hears what is happening, her own words and where she is.
      const script = composeCallScript({ reason, subjectName: subjectName(), said: turn.text,
                                         location: lastLocationState, textSent: smsStatus().live });
      background(callService.initiateCall({
        reason: `${reason}: ${turn.text}`,
        anonymous: false,
        broadcast,
        subjectName: subjectName(),
        script
      }));
    },
    // Every alert texts the care team on its own (simulated until live SMS is set up),
    // and the outcome is written onto the alert so the caregiver view shows it.
    onAlert: ({ alert, reason, headline, turn, locationContext }) => {
      const body = composeAlertMessage({
        headline, reason, subjectName: subjectName(), said: turn.text, location: locationContext, timezone: cfg.timezone
      });
      background(sendCaregiverMessage({ body, reason }).then(async sent => {
        log("message", `${sent.mode} ${sent.status} → ${sent.to}  "${body.slice(0, 70)}…"${sent.note ? `  (${sent.note})` : ""}`);
        broadcast({ type: "caregiver_message", alertId: alert._id, ...sent });
        if (sent.status !== "skipped_cooldown") {
          await store.safeUpdate("care_alerts", { _id: alert._id, ...scope }, { $push: { notifications: sent } });
        }
      }).catch(error => log("message-failed", error.message)));
    }
  });

  // A caregiver changing a constraint must reach a live conversation in seconds.
  // (Hosted, an instance lives minutes at most: the 60 s constraint cache is enough.)
  if (!HOSTED) try {
    const watch = store.db.collection("safety_constraints")
      .watch([{ $match: { "fullDocument.subjectId": cfg.subjectId } }], { fullDocument: "updateLookup" });
    watch.on("change", () => { pipeline.invalidateConstraints(); log("constraints", "cache invalidated"); });
    watch.on("error", () => {});
  } catch { log("constraints", "change stream unavailable; using the 60s cache"); }

  try {
    const pastTurns = await store.db.collection("conversation_turns")
      .find({ ...scope }).sort({ startedAt: -1 }).limit(20).toArray();
    for (const t of pastTurns.reverse()) {
      if (t.role === "patient" || t.role === "caregiver") {
        recentFeed.unshift({ type: t.role === "patient" ? "patient_turn" : "heard_turn", turnId: t._id,
                             role: t.role, text: t.text, speaker: t.speaker?.name ?? null, at: t.startedAt });
      } else if (t.role === "companion") {
        recentFeed.unshift({ type: "companion_answer", turnId: t._id, answer: t.text, basis: t.epistemic, alertIds: t.safety?.alertIds ?? [], alertReasons: t.safety?.alertReasons ?? [], at: t.startedAt });
      }
    }
  } catch {}

  // Hosted: Vercel calls `handler` per request, so there is no server, loop or speaker
  // check to start. Turns are run by the capture request that brought them in.
  if (HOSTED) {
    log("hosted", "serving the capture page as a Vercel function");
  } else {
    // Windows speaker mute/volume, so the capture page can say when replies are inaudible.
    audioOutput = watchOutputs(state => {
      if (!state) return;
      const d = state.default;
      log("speakers", state.outputs.map(o => `${o.isDefault ? "*" : ""}${o.name}: ${o.muted ? "MUTED" : `${o.volume}%`}`).join(" · ")
        + (state.allSilent ? "  <- replies cannot be heard" : d?.silent ? "  <- default output is silent" : ""));
      broadcast({ type: "audio_output", ...state });
    });

    server = httpServer();
    await new Promise(resolve => server.listen(cfg.port, cfg.host, resolve));
    log("listening", `http://${cfg.host}:${cfg.port}/capture — open it in Chrome and leave it open`);

    const timer = setInterval(() => { tick().catch(e => log("tick-failed", e.message)); }, cfg.tickMs);

    const shutdown = async signal => {
      if (stopping) return;
      stopping = true;
      log("stopping", `${signal} — finishing the turn in flight`);
      clearInterval(timer);
      for (let i = 0; inFlight && i < 60; i++) await new Promise(r => setTimeout(r, 500));
      await closeSession("agent_stopped").catch(() => {});
      await new Promise(resolve => server.close(resolve));
      await store.close();
      console.log(`\n  captured ${stats.captured} · answered ${stats.answered} · vetoed ${stats.vetoed}` +
                  ` · escalated ${stats.escalated} · failed ${stats.failed} · refused ${stats.refused}\n`);
      process.exit(0);
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  }
} catch (error) {
  console.error(`\nAgent failed to start: ${error.message}\n`);
  await store?.close().catch(() => {});
  if (HOSTED) throw error;               // the function reports it; the next request retries
  process.exit(1);
}
