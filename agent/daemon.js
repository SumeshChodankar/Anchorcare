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
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { config } from "./config.js";
import { connect, AgentApprovalError } from "./store.js";
import { createReasoner } from "./gemini.js";
import { createPipeline } from "./pipeline.js";
import * as callService from "./call-service.js";
import { classifySpeaker } from "./speaker.js";
import { buildConversationSession, recordHeardTurn, turnId, appendSeries } from "../db/ingest.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DRY = process.argv.includes("--dry-run");

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
let genAiAudioClient = null;
async function transcribeAndDiarizeAudio(audioBuffer, mimeType = "audio/webm", primarySpeaker = "Sumesh") {
  if (!genAiAudioClient) {
    const { GoogleGenAI } = await import("@google/genai");
    genAiAudioClient = new GoogleGenAI({ apiKey: cfg.geminiKey });
  }

  const cleanMime = (mimeType || "audio/webm").split(";")[0].trim();
  const prompt = `You are the Acoustic Ear & Speaker Diarization Agent for AnchorCare, powered by Gemini 4 Argon.
Household & Care Database Context:
- Primary User: "${primarySpeaker}" (the user speaking directly into the microphone; representing the patient/user persona e.g. Sumesh or Margaret).
- Caregiver & Clinician Profiles in Database Specs:
  * Jane (Primary Caregiver): Checks on daily care, safety, comfort, routines.
  * Sam (Care Assistant): Prepared meals, oatmeal and Earl Grey tea.
  * David Lee (Physiotherapist): Conducted seated leg exercises in early evening.
  * Priya (Daughter): Family contact.
  * Dr. Patel (Clinical Physician): Medical oversight.
- Others: Unknown visitors, background television, ambient chatter, or unverified speakers.

Tasks:
1. Transcribe the audio verbatim. If only background static or silent, return empty string for transcription.
2. Identify the speaker:
   - If this is the primary user speaking into the device (asking personal memory questions, asking where glasses are, what they had for breakfast, asking about home, expressing distress, or talking directly), attribute speaker to "${primarySpeaker}".
   - If the voice clearly matches a known caregiver or clinician in the database specs, attribute to "Jane (Caregiver)", "David Lee (Physiotherapist)", "Sam", or "Priya".
   - If anyone else, background talk, or unverified voice, attribute to "Others".
3. Check if the speech matches any approved memory specs in the database:
   - "glasses" -> glasses on bookshelf by living-room window
   - "breakfast" -> oatmeal and Earl Grey tea on Friday
   - "david_lee" -> physiotherapist seated leg exercises in early evening
   - "garden" -> 20-minute walk in courtyard garden
   - "wandering" -> lost or looking for house outside safe zone
   - "call_margaret" -> emergency outbound phone reassurance
   - "medication" -> medication dose change policy veto

Return strictly valid JSON:
{
  "transcription": "<exact words spoken>",
  "speaker": "${primarySpeaker}" | "Jane (Caregiver)" | "David Lee (Physiotherapist)" | "Others",
  "speakerType": "primary_user" | "caregiver" | "visitor" | "others",
  "confidence": 0.95,
  "matchedDbTopic": "<matched topic or null>"
}`;

  try {
    const response = await genAiAudioClient.models.generateContent({
      model: "gemini-4-argon",
      contents: [
        {
          inlineData: {
            mimeType: cleanMime,
            data: audioBuffer.toString("base64")
          }
        },
        prompt
      ]
    });

    const raw = response.text || "";
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      return JSON.parse(match[0]);
    }
  } catch (err) {
    log("gemini-audio-error", err.message);
  }

  return {
    transcription: "",
    speaker: primarySpeaker,
    speakerType: "primary_user",
    confidence: 0.5,
    matchedDbTopic: null
  };
}

// ── capture ingest ────────────────────────────────────────────────────────
// Writes words BEFORE anything else happens to them. If the model call, the
// retrieval or the process itself dies next, the record of what she said survives.
async function capture({ text, confidence, engine, language, speaker, speakerType, speakerMethod, locationContext }) {
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
    speaker, speakerType, confidence, method: speakerMethod ?? "declared"
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

  // Prompt the pipeline loop immediately (0ms delay)
  setImmediate(() => { tick().catch(() => {}); });

  // Await companion turn so caller gets immediate voice-ready answer
  const expectedTurnId = turnId(id, seq + 1);
  const companionTurn = await new Promise(resolve => {
    let elapsed = 0;
    const interval = setInterval(async () => {
      elapsed += 100;
      try {
        const doc = await store.db.collection("conversation_turns").findOne({ _id: expectedTurnId });
        if (doc && doc.text) {
          clearInterval(interval);
          resolve(doc);
        }
      } catch (e) {}
      if (elapsed >= 22000) {
        clearInterval(interval);
        resolve(null);
      }
    }, 100);
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
    alertIds: companionTurn?.safety?.alertIds || []
  };
}

// ── the loop ──────────────────────────────────────────────────────────────
async function claimNext() {
  // If there is an active session, answer turns in THIS session first!
  if (sessionId) {
    const sessionPending = await store.db.collection("conversation_turns")
      .find({ ...scope, sessionId, role: "patient" }).sort({ seq: 1 }).limit(10).toArray();
    for (const turn of sessionPending) {
      const answered = await store.db.collection("conversation_turns")
        .countDocuments({ _id: turnId(turn.sessionId, turn.seq + 1) }, { limit: 1 });
      if (!answered) return turn;
    }
  }

  // Otherwise, the latest unanswered patient turn
  const pending = await store.db.collection("conversation_turns")
    .find({ ...scope, role: "patient" }).sort({ startedAt: -1 }).limit(10).toArray();

  for (const turn of pending) {
    const answered = await store.db.collection("conversation_turns")
      .countDocuments({ _id: turnId(turn.sessionId, turn.seq + 1) }, { limit: 1 });
    if (!answered) return turn;
  }
  return null;
}

async function tick() {
  if (stopping || inFlight) return;
  const turn = await claimNext();
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
      `cited=${result.care.evidenceIds.length}  "${result.care.answer.slice(0, 70)}…"`);

    broadcast({
      type: "companion_answer",
      turnId: result.companion._id,
      patientTurnId: turn._id,
      patientText: turn.text,
      answer: result.care.answer,
      basis: result.care.epistemicBasis,
      latencyMs: Date.now() - started,
      alertIds: result.alertIds,
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

// ── http: capture endpoint + the capture page ─────────────────────────────
function httpServer() {
  return createServer(async (req, res) => {
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

    if (req.method === "GET" && url.pathname === "/status") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        subjectId: cfg.subjectId, sessionId, sessionSeq, stats,
        model: cfg.geminiModel, embeddingMode: cfg.embeddingMode, dryRun: DRY,
        location: lastLocationState,
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
      res.write(`data: ${JSON.stringify({ type: "init", recent: recentFeed.slice(0, 30), location: lastLocationState, stats })}\n\n`);
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
        let meters = Number(payload.distanceFromHomeMeters ?? payload.distanceMeters ?? 0);
        if (meters === 0 && payload.latitude != null && payload.longitude != null) {
          const homeLat = 51.5074, homeLng = -0.1278; // London center default
          const R = 6371e3;
          const phi1 = homeLat * Math.PI / 180, phi2 = payload.latitude * Math.PI / 180;
          const dPhi = (payload.latitude - homeLat) * Math.PI / 180;
          const dLambda = (payload.longitude - homeLng) * Math.PI / 180;
          const a = Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
          meters = Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
        }
        const distanceMiles = (meters / 1609.34).toFixed(2);
        const isOutside = payload.state === "left_safe_zone" || payload.state === "outside_safe_zone" || meters > 50;
        lastLocationState = {
          state: isOutside ? "left_safe_zone" : "inside_safe_zone",
          distanceFromHomeMeters: meters,
          distance_from_home: `${distanceMiles} miles`,
          status_description: isOutside ? `Outside Safe Zone, ${distanceMiles} miles from Home` : "Inside Safe Zone (Home)",
          coords: { lat: payload.latitude, lng: payload.longitude },
          accuracy: payload.accuracy ?? null,
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
        const payload = JSON.parse(body || "{}");
        const audioBase64 = payload.audio;
        const mimeType = payload.mimeType || "audio/webm";
        const locationContext = payload.locationContext;
        const primarySpeaker = (payload.primarySpeaker || payload.userName || "Sumesh").trim();

        if (!audioBase64) {
          res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "missing audio" }));
          return;
        }

        const audioBuf = Buffer.from(audioBase64, "base64");
        const diarization = await transcribeAndDiarizeAudio(audioBuf, mimeType, primarySpeaker);
        log("acoustic-ear", `[${diarization.speaker}] (${diarization.confidence}) "${diarization.transcription}"`);

        const trimmed = (diarization.transcription || "").trim();
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
          engine: "gemini-4-argon-audio",
          speaker: diarization.speaker,
          speakerType: diarization.speakerType,
          speakerMethod: "diarization",
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
  });
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
  const approved = await store.db.collection("episodes")
    .countDocuments({ ...scope, reviewStatus: "approved", isCurrent: true });
  log("ready", `${approved} approved episode(s) retrievable`);
  if (!approved) log("warning", "nothing approved: every answer will be 'I don't have anything written down'");

  pipeline = createPipeline({
    cfg,
    store,
    reason: createReasoner(cfg),
    log,
    onCall: turn => {
      callService.initiateCall({
        reason: turn.text,
        anonymous: true,
        broadcast
      });
    }
  });

  // A caregiver changing a constraint must reach a live conversation in seconds.
  try {
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
        recentFeed.unshift({ type: "companion_answer", turnId: t._id, answer: t.text, basis: t.epistemic, alertIds: t.safety?.alertIds ?? [], at: t.startedAt });
      }
    }
  } catch {}

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
} catch (error) {
  console.error(`\nAgent failed to start: ${error.message}\n`);
  await store?.close().catch(() => {});
  process.exit(1);
}
