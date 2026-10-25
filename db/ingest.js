// Reference write path for the cognitive memory schema.
// Pure document builders plus the transaction shapes that must be atomic.
//
// Spec: docs/ATLAS-MEMORY-SCHEMA.md §13
//
// Four rules hold for every write:
//   1. scope-stamped (householdId + subjectId)
//   2. idempotent (deterministic _id, or a scoped unique dedupeKey)
//   3. transactional across collections when a partial write would mislead a human
//   4. audited with a named actor and a risk tier

import { createHash, randomUUID } from "node:crypto";
import { ALERT_SLA_MS, SLOT_HALF_LIFE } from "./collections.js";

export const sha256 = (...parts) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
export const uid = prefix => `${prefix}_${randomUUID()}`;

/** Deterministic id for anything a client may retry (matches life-records.js). */
export const deterministicId = (prefix, ...parts) => `${prefix}_${sha256(...parts)}`;

// ───────────────────────────── sources ───────────────────────────────────────

/**
 * Raw artefact first, always. A derived interpretation (transcript, caption) is a
 * SEPARATE source with `derivedFrom` + `processor`, so "did she say that, or did the
 * recogniser mishear it?" stays answerable.
 */
export function buildSource(scope, input, now) {
  const digest = sha256(input.content ?? input.bytesDigest);
  const derived = input.derivedFrom != null;
  if (derived && !input.processor) throw new Error("A derived source requires `processor`");
  return {
    _id: deterministicId("source", scope, digest),
    ...scope,
    sourceType: input.sourceType,            // caregiver_report | user_report | recording_transcript | media_reference
    modality: input.modality,                // text | speech | image | video | device
    content: input.modality === "text" ? input.content : null,
    mediaPtr: input.mediaPtr ?? null,
    derivedFrom: input.derivedFrom ?? null,
    processor: input.processor ?? null,
    digest,
    inspection: { required: input.modality !== "text" || derived, by: null, at: null },
    recordedAt: now
  };
}

// ───────────────────────────── episodes ──────────────────────────────────────

export function firstClause(text, max = 280) {
  if (!text) return "";
  const stop = text.search(/[.!?](\s|$)/);
  const clause = stop > 0 ? text.slice(0, stop + 1) : text;
  return clause.length <= max ? clause.trim() : `${clause.slice(0, max - 1).trim()}…`;
}

export function recurrenceHash({ what, place, eventStart }) {
  if (!what || !place || !eventStart) return null;
  const hour = new Date(eventStart).getUTCHours();
  const bucket = hour < 11 ? "morning" : hour < 17 ? "afternoon" : "evening";
  return [slug(what), slug(place), bucket].join("|");
}

export const slug = value => String(value).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

/**
 * Candidate episode. ALWAYS `reviewStatus: "draft"` — nothing this function produces
 * can be spoken to the patient (invariant I3).
 */
export function buildEpisodeDraft(scope, input, sourceIds, cfg, now) {
  if (!sourceIds?.length) throw new Error("An episode requires source evidence");
  if (+input.eventStart > +now) throw new Error("Future events belong in plans, not episodes");
  const narrative = input.narrative ?? input.summary ?? "";
  const searchText = [narrative, input.keywordTail].filter(Boolean).join(" ").slice(0, 6000);
  return {
    _id: uid("episode"),
    ...scope,
    summary: narrative.slice(0, 2000),
    gist: firstClause(narrative, 280),
    searchText,
    what: input.what ?? null,
    place: input.place ?? null,
    sourceIds,
    personIds: [],                 // populated at approval from approved `about` links
    semanticRefs: [],
    chapterId: null,
    eventStart: input.eventStart,
    eventEnd: input.eventEnd ?? null,
    recordedAt: now,
    reviewStatus: "draft",
    reviewedAt: null,
    eventStatus: "reported_completed",
    isCurrent: true,
    supersedes: null,
    supersededBy: null,
    confidence: input.confidence ?? null,     // upstream metadata, uncalibrated (I5)
    salience: null,                           // computed by consolidation from evidence
    emotionalTone: null,                      // only ever set from a human report
    sensitivity: input.sensitivity ?? "normal",
    mediaPtr: input.mediaPtr ?? null,
    derivedModalities: input.derivedModalities ?? [],
    visualEmbedding: null,
    visualEmbeddingModel: null,
    visualEmbeddingAt: null,
    embeddingMeta: {
      textModel: cfg.embeddingModel, textDims: cfg.dimensions,
      visualModel: null, visualDims: null,
      inputDigest: sha256(searchText), generatedAt: null
    },
    consolidation: { state: "labile", rehearsalCount: 0, lastConsolidatedAt: null, promotedNodeIds: [] },
    recurrenceKey: recurrenceHash(input),
    dedupeKey: input.dedupeKey ?? [input.kind, input.personId, localDayKey(input.eventStart)].join("|")
  };
}

const localDayKey = instant => new Date(instant).toISOString().slice(0, 10);

/**
 * Fields that must NOT be copied onto a correction: a vector computed from the old
 * text would defeat the staleness check that embeddingMeta.inputDigest exists for.
 */
export function stripDerived(doc) {
  const { embedding, visualEmbedding, visualEmbeddingModel, visualEmbeddingAt,
          embeddingMeta, contractDigest, consolidation, salience, ...rest } = doc;
  return rest;
}

// ───────────────────────────── links & edges ─────────────────────────────────

export function buildLink(scope, { fromStore, fromId, linkType, toStore, toId, weight = null,
                                   createdBy, sourceIds = [], confidence = null, reviewStatus = "draft" }, now) {
  return {
    _id: deterministicId("link", scope, fromStore, fromId, linkType, toStore, toId),
    ...scope,
    fromStore, fromId, toStore, toId, linkType,
    weight, createdBy, reviewStatus, sourceIds, confidence,
    recordedAt: now, reviewedAt: reviewStatus === "approved" ? now : null,
    isCurrent: true, supersedes: null, supersededBy: null
  };
}

const INVERSE = {
  child_of: "parent_of", parent_of: "child_of",
  sibling_of: "sibling_of", spouse_of: "spouse_of", friend_of: "friend_of", neighbour_of: "neighbour_of",
  cares_for: "cared_for_by", cared_for_by: "cares_for",
  lives_at: "located_in", owns: "owned_by", owned_by: "owns",
  occurs_at: "part_of_routine", part_of_routine: "occurs_at",
  refers_to: "refers_to", same_as: "same_as", contradicts: "contradicts"
};

/**
 * Both directions are materialized so $graphLookup (which traverses one direction
 * per stage) can answer either way. They share a pairId and move together.
 */
export function buildEdgePair(scope, { fromId, toId, edgeType, weight = 0.5, temporal = null,
                                       status = "current", sourceIds = [], confidence = null,
                                       reviewStatus = "draft" }, now) {
  const inverseType = INVERSE[edgeType] ?? null;
  const pairId = deterministicId("pair", scope, [fromId, toId].sort(), edgeType);
  const base = {
    ...scope, edgeType, inverseType, pairId, weight, temporal, status,
    sourceIds, confidence, reviewStatus, isCurrent: true,
    supersedes: null, supersededBy: null, version: 1,
    recordedAt: now
  };
  const forward = { _id: deterministicId("edge", scope, fromId, edgeType, toId),
                    ...base, fromId, toId, direction: "forward" };
  forward.digest = sha256(forward.fromId, forward.toId, forward.edgeType, forward.temporal, forward.status);

  if (!inverseType) return [forward];

  const reverse = { _id: deterministicId("edge", scope, toId, inverseType, fromId),
                    ...base, edgeType: inverseType, inverseType: edgeType,
                    fromId: toId, toId: fromId, direction: "reverse" };
  reverse.digest = sha256(reverse.fromId, reverse.toId, reverse.edgeType, reverse.temporal, reverse.status);
  return [forward, reverse];
}

// ───────────────────────────── audit chain ───────────────────────────────────

export const GENESIS = "GENESIS";

/** digest = sha256(prevDigest ‖ seq ‖ scope ‖ action ‖ recordId ‖ detail ‖ at) */
export function chainedAudit(scope, { action, recordId, detail = {}, actor, actorRole, riskTier = 0 },
                             { seq, prevDigest }, now) {
  if (!actor) throw new Error("An audit event without an actor is not audit");
  const event = {
    _id: uid("audit"), ...scope,
    action, recordId, detail, at: now,
    actor, actorRole: actorRole ?? null,
    seq, prevDigest: prevDigest ?? GENESIS, riskTier
  };
  event.digest = sha256(event.prevDigest, seq, scope.householdId, scope.subjectId,
                        action, recordId, detail, now.toISOString());
  return event;
}

/** Claim the next seq for a scope. Must run inside the same transaction as the event. */
export async function nextAuditSeq(db, scope, session) {
  const counterId = sha256("audit_counter", scope);
  const counter = await db.collection("audit_counters").findOneAndUpdate(
    { _id: counterId },
    { $inc: { seq: 1 }, $setOnInsert: { ...scope } },
    { upsert: true, returnDocument: "after", includeResultMetadata: false, session }
  );
  const previous = counter.seq > 1
    ? await db.collection("audit_events").findOne({ ...scope, seq: counter.seq - 1 }, { projection: { digest: 1 }, session })
    : null;
  return { seq: counter.seq, prevDigest: previous?.digest ?? GENESIS };
}

// ───────────────────────────── alerts ────────────────────────────────────────

export function buildAlert(scope, { alertType, severity, triggerRefs, evidenceSummary,
                                    procedureRunId = null }, now) {
  if (!triggerRefs?.length) throw new Error("An alert that cannot name its evidence cannot be written");
  return {
    _id: uid("alert"), ...scope,
    idempotencyKey: sha256(alertType, triggerRefs.map(r => r.id).sort(), localDayKey(now)),
    alertType, severity, state: "raised",
    transitions: [{ from: null, to: "raised", at: now, by: "agent", note: evidenceSummary }],
    triggerRefs, evidenceSummary, procedureRunId,
    slaDeadlineAt: new Date(+now + (ALERT_SLA_MS[severity] ?? ALERT_SLA_MS.advisory)),
    notifications: [], acknowledgedBy: null, acknowledgedAt: null, resolution: null,
    createdAt: now
  };
}

export const severityTier = severity =>
  ({ info: 1, advisory: 1, urgent: 2, emergency: 3 })[severity] ?? 1;

/**
 * Alert + escalation task + audit must be atomic: an alert with no task means no
 * escalation, which is the failure mode that matters.
 */
export async function raiseAlert(store, scope, input, now) {
  const alert = buildAlert(scope, input, now);
  const session = store.client.startSession();
  try {
    let result = null;
    await session.withTransaction(async () => {
      try {
        await store.db.collection("care_alerts").insertOne(alert, { session });
      } catch (error) {
        if (error.code !== 11000) throw error;
        await store.db.collection("care_alerts").updateOne(
          { ...scope, idempotencyKey: alert.idempotencyKey },
          { $push: { transitions: { from: "raised", to: "raised", at: now, by: "agent", note: "repeat signal" } } },
          { session });
        result = { duplicate: true };
        return;
      }
      // No expiresAt: the sparse TTL index cannot reach a tier>=2 task (§3.3).
      await store.db.collection("active_tasks").insertOne({
        _id: deterministicId("task", scope, alert.idempotencyKey), ...scope,
        sessionId: null, taskType: "escalate", status: "pending",
        riskTier: severityTier(input.severity),
        procedureId: null, procedureVersion: null,
        payload: { alertId: alert._id },
        dueAt: now, slaDeadlineAt: alert.slaDeadlineAt,
        blockedBy: [], leaseToken: null, leaseUntil: null, attempts: 0, createdAt: now
      }, { session });

      const chain = await nextAuditSeq(store.db, scope, session);
      await store.db.collection("audit_events").insertOne(chainedAudit(scope, {
        action: "alert_raised", recordId: alert._id,
        detail: { alertType: input.alertType, severity: input.severity, triggerRefs: input.triggerRefs },
        actor: { kind: "agent", id: "companion", credentialRef: null },
        actorRole: "agent", riskTier: severityTier(input.severity)
      }, chain, now), { session });

      result = { alert };
    }, { writeConcern: { w: "majority", j: true } });
    return result;
  } finally {
    await session.endSession();
  }
}

// ───────────────────────── time-series append gate ───────────────────────────

/**
 * Time-series collections accept no unique indexes, so idempotency is a gate:
 * insert the dedupe token first, append only if that insert won.
 */
export async function appendSeries(db, collection, { series, sourceEventId, measurement, timeField, now }) {
  const token = {
    _id: deterministicId("ts", collection, series, sourceEventId),
    series: JSON.stringify(series), sourceEventId,
    expiresAt: new Date(+now + 30 * 86400000)
  };
  try {
    await db.collection("ts_dedupe").insertOne(token);
  } catch (error) {
    if (error.code === 11000) return { appended: false, reason: "duplicate" };
    throw error;
  }
  await db.collection(collection).insertOne({ [timeField]: measurement[timeField] ?? now, series, ...measurement });
  return { appended: true };
}

// ───────────────────────── working memory write-back ─────────────────────────

export function workingSlotUpdate(scope, sessionId, item, now) {
  const halfLife = SLOT_HALF_LIFE[item.slotType] ?? 900;
  return {
    filter: { _id: deterministicId("wm", scope, sessionId, item.slotType, item.contentKey) },
    update: {
      $set: {
        ...scope, sessionId,
        slotType: item.slotType, content: String(item.content).slice(0, 500),
        boundTo: item.boundTo ?? [], provenance: item.provenance,
        activation: Math.min(1, item.activation ?? 1),
        decayHalfLifeSeconds: halfLife,
        lastTouchedAt: now,
        expiresAt: new Date(+now + 4 * halfLife * 1000)
      },
      $inc: { reinforcementCount: 1 },
      $setOnInsert: { createdAt: now }
    },
    options: { upsert: true }
  };
}

// ─────────────────── real-time conversation capture ──────────────────────────

/** Deterministic and naturally sortable: a retried turn write cannot duplicate. */
export const turnId = (sessionId, seq) => `turn_${sessionId}_${String(seq).padStart(6, "0")}`;

/**
 * A patient turn produces TWO documents: the turn (the observation) and a
 * write-once source (the citable evidence). Speech sources start
 * `inspection.required: true` because the recogniser may have misheard her, and
 * nothing built on an uninspected transcript can be approved.
 */
export function buildPatientTurn(scope, input, now) {
  return buildHeardTurn(scope, { ...input, role: "patient" }, now);
}

/** Roles a heard (observed) turn may carry. Strangers are not recorded at all. */
export const HEARD_ROLES = Object.freeze(["patient", "caregiver"]);

/**
 * Speech we heard, from the patient or from someone in her care team. Both are
 * `observed`, but only HER words get a source: a caregiver's remark is kept for the
 * record, yet it is not her report, so it must not reach patient_utterances or
 * become citable evidence. `speaker` is the label the capture surface reported
 * (diarizer or console), never a biometric identification.
 */
export function buildHeardTurn(scope, input, now) {
  const role = input.role ?? "patient";
  if (!HEARD_ROLES.includes(role)) {
    throw new Error(`A heard turn is from the patient or a caregiver, not '${role}'`);
  }
  const modality = input.modality ?? "text";
  const source = role !== "patient" ? null : buildSource(scope, {
    sourceType: "user_report",
    modality,
    content: input.text,
    mediaPtr: input.audio?.ref ?? null
  }, now);
  // A speech turn's text is a machine transcription of audio: it is derived.
  if (source && modality === "speech") {
    // The transcript is the content. Audio retention is off by default, so without it
    // the source would hold neither her voice nor her words — only a digest — and
    // nothing she said could ever be cited. inspection.required marks it unverified.
    source.content = String(input.text).slice(0, 8000);
    source.derivedFrom = input.audio?.ref ?? null;
    source.processor = {
      name: input.transcript?.engine ?? "unknown",
      version: input.transcript?.version ?? "unknown",
      at: now
    };
    source.inspection = { required: true, by: null, at: null };
  }

  const turn = {
    _id: turnId(input.sessionId, input.seq),
    ...scope,
    sessionId: input.sessionId,
    seq: input.seq,
    role,
    epistemic: "observed",
    speaker: input.speaker
      ? { name: input.speaker.name ?? null, kind: input.speaker.kind ?? role,
          method: input.speaker.method ?? "declared", confidence: input.speaker.confidence ?? null,
          verified: input.speaker.verified ?? null }
      : null,
    text: String(input.text).slice(0, 8000),
    startedAt: input.startedAt ?? now,
    endedAt: input.endedAt ?? null,
    transcript: modality === "speech" ? {
      engine: input.transcript?.engine ?? "unknown",
      version: input.transcript?.version ?? "unknown",
      language: input.transcript?.language ?? null,
      confidence: input.transcript?.confidence ?? null,   // the engine's own number (I5)
      isFinal: input.transcript?.isFinal ?? true,
      partialCount: input.transcript?.partialCount ?? 0,
      alternatives: input.transcript?.alternatives ?? []
    } : null,
    // Audio retention is OFF unless consent says otherwise; the pointer is all that
    // is stored here either way.
    audio: input.audio
      ? { storage: input.audio.storage ?? "none", ref: input.audio.ref ?? null,
          bytes: input.audio.bytes ?? 0, durationMs: input.audio.durationMs ?? 0,
          retainUntil: input.audio.retainUntil ?? null }
      : { storage: "none", ref: null, bytes: 0, durationMs: 0, retainUntil: null },
    sourceId: source?._id ?? null,
    groundedOn: [],
    disclosure: null,
    safety: { precheck: input.safetyPrecheck ?? "pass", vetoConstraintId: null, alertIds: [] },
    model: null,
    latency: null,
    inferenceIds: [],
    caregiverAnnotation: null,
    redacted: false,
    redactionRef: null
  };
  return { turn, source };
}

/**
 * A companion turn is `generated`, carries no sourceId, and must record the model
 * and what it read. Without `model` a response cannot be reproduced or distrusted
 * after the fact, which is the whole point of keeping it.
 */
export function buildCompanionTurn(scope, input, now) {
  if (!input.model?.name) throw new Error("A generated turn requires model provenance");
  const offenders = (input.groundedOn ?? []).filter(ref =>
    ref.role === "evidence" && (ref.collection === "inferences" ||
      (ref.collection === "conversation_turns" && ref.epistemic === "generated")));
  if (offenders.length) {
    throw new Error(`Generated output or inferences cited as evidence: ${offenders.map(o => o.id).join(", ")}`);
  }
  return {
    _id: turnId(input.sessionId, input.seq),
    ...scope,
    sessionId: input.sessionId,
    seq: input.seq,
    role: "companion",
    epistemic: "generated",
    text: String(input.text).slice(0, 8000),
    startedAt: input.startedAt ?? now,
    endedAt: input.endedAt ?? now,
    transcript: null,
    audio: { storage: "none", ref: null, bytes: 0, durationMs: 0, retainUntil: null },
    sourceId: null,                       // a sentence the system produced is not evidence
    groundedOn: input.groundedOn ?? [],
    disclosure: input.disclosure ?? null,
    safety: {
      precheck: input.safetyPrecheck ?? "pass",
      vetoConstraintId: input.vetoConstraintId ?? null,
      alertIds: input.alertIds ?? [],
      alertReasons: input.alertReasons ?? []
    },
    model: {
      name: input.model.name, version: input.model.version ?? null,
      promptDigest: input.model.promptDigest ?? null,
      temperature: input.model.temperature ?? null,
      tokensIn: input.model.tokensIn ?? 0, tokensOut: input.model.tokensOut ?? 0
    },
    latency: input.latency ?? null,
    inferenceIds: input.inferenceIds ?? [],
    caregiverAnnotation: null,
    redacted: false,
    redactionRef: null
  };
}

/**
 * The patient turn and its source are written BEFORE generation, in one
 * transaction. If generation then crashes, the record of what she said survives —
 * the alternative is a system that loses her words whenever it fails to answer.
 */
export async function recordPatientTurn(store, scope, input, now) {
  return recordHeardTurn(store, scope, { ...input, role: "patient" }, now);
}

/** recordPatientTurn for any heard role; a caregiver turn writes no source. */
export async function recordHeardTurn(store, scope, input, now) {
  const { turn, source } = buildHeardTurn(scope, input, now);
  if (store.mode !== "mongodb") {
    if (source) await store.insert("sources", source);
    await store.insert("conversation_turns", turn);
    return { turn, source };
  }
  const session = store.client.startSession();
  try {
    await session.withTransaction(async () => {
      const existingSource = source && await store.db.collection("sources")
        .findOne({ _id: source._id }, { session, projection: { _id: 1 } });
      if (source && !existingSource) {
        await store.db.collection("sources").insertOne(source, { session });
      }
      const existingTurn = await store.db.collection("conversation_turns")
        .findOne({ _id: turn._id }, { session, projection: { _id: 1 } });
      if (!existingTurn) {
        await store.db.collection("conversation_turns").insertOne(turn, { session });
      }
      await store.db.collection("conversation_sessions").updateOne(
        { _id: input.sessionId, ...scope },
        { $inc: { turnCount: 1, ...(source ? { patientTurnCount: 1 } : {}) }, $set: { lastTurnAt: now } },
        { session });
    }, { writeConcern: { w: "majority" } });
  } finally {
    await session.endSession();
  }
  return { turn, source };
}

/** Written after emission. Telemetry rides along so the turn costs one round trip. */
export async function recordCompanionTurn(store, scope, input, now) {
  const turn = buildCompanionTurn(scope, input, now);
  const increments = {
    turnCount: 1,
    ...(turn.disclosure?.scriptUsed ? { "signals.scriptedDisclosures": 1 } : {}),
    ...(turn.safety.precheck === "veto" ? { "signals.safetyVetoes": 1 } : {}),
    ...(turn.safety.alertIds.length ? { "signals.escalations": turn.safety.alertIds.length } : {}),
    ...(turn.groundedOn.length === 0 ? { "signals.retrievalFailures": 1 } : {})
  };
  if (store.mode !== "mongodb") {
    await store.insert("conversation_turns", turn);
    return { turn };
  }
  await store.db.collection("conversation_turns").insertOne(turn)
    .catch(error => { if (error.code !== 11000) throw error; });
  await store.db.collection("conversation_sessions").updateOne(
    { _id: input.sessionId, ...scope },
    { $inc: increments, $set: { lastTurnAt: now } });
  return { turn };
}

export function buildConversationSession(scope, input, now) {
  return {
    _id: input.sessionId, ...scope,
    channel: input.channel,
    initiatedBy: input.initiatedBy,
    startedAt: now,
    endedAt: null, durationMs: null,
    turnCount: 0, patientTurnCount: 0,
    procedureRunIds: [],
    summaryEpisodeId: null,
    signals: { repeatedQuestionCount: 0, distressReports: 0, safetyVetoes: 0,
               escalations: 0, scriptedDisclosures: 0, retrievalFailures: 0 },
    consentRef: input.consentRef ?? null,
    modelRefs: [],
    closeReason: null,
    redacted: false
  };
}

/**
 * Closing a session writes aggregates and, optionally, a DRAFT summary episode.
 * The summary is an ordinary ingested claim: machine-written, caregiver-approved
 * or not at all. It is never auto-approved just because the system wrote it.
 */
export function buildSessionSummaryDraft(scope, session, summaryText, sourceIds, cfg, now) {
  return buildEpisodeDraft(scope, {
    narrative: summaryText,
    what: "Conversation with the companion",
    place: null,
    eventStart: session.startedAt,
    eventEnd: session.endedAt ?? now,
    kind: "conversation",
    personId: null,
    dedupeKey: `conversation|${session._id}`,
    confidence: null
  }, sourceIds, cfg, now);
}

// ─────────────────── inference quarantine (inferred) ─────────────────────────

/** Low-stakes inference types expire; clinical-adjacent ones never receive expiresAt. */
export const INFERENCE_TTL_DAYS = Object.freeze({
  intent: 30, topic: 30, retrieval_miss: 90, entity_link: 90, session_summary: 180
});
export const CORROBORATION_THRESHOLD = 3;

/**
 * A stored inference. Note what is NOT configurable: `visibility` and `calibration`
 * are fixed, and `basis` is required. Storing the system's guesses is useful;
 * storing them in a way that could reach the patient is not.
 */
export function buildInference(scope, input, now) {
  if (!input.basis?.length) throw new Error("An inference must name what it was derived from");
  if (input.epistemicStatus && !["inferred", "corroborated"].includes(input.epistemicStatus)) {
    throw new Error("Only a caregiver may set confirmed or rejected status");
  }
  const claimDigest = sha256(input.inferenceType, input.claim);
  const ttlDays = INFERENCE_TTL_DAYS[input.inferenceType];
  return {
    _id: deterministicId("inf", scope, input.inferenceType, claimDigest),
    ...scope,
    inferenceType: input.inferenceType,
    claim: input.claim,
    claimDigest,
    epistemicStatus: "inferred",
    confidence: input.confidence ?? null,
    calibration: "uncalibrated",
    visibility: "caregiver_only",
    basis: input.basis,
    observationCount: 1,
    firstObservedAt: now,
    lastObservedAt: now,
    sessionId: input.sessionId ?? null,
    turnId: input.turnId ?? null,
    model: input.model ?? null,
    promotion: { state: "none", targetCollection: null, targetId: null,
                 decidedBy: null, decidedAt: null, reason: null },
    contradicts: [],
    recordedAt: now,
    // Sparse TTL: the absence of this field is what protects the rest (§3.3).
    ...(ttlDays ? { expiresAt: new Date(+now + ttlDays * 86400000) } : {})
  };
}

/**
 * Re-observing the same claim reinforces one record instead of writing a hundred
 * copies, and crossing the corroboration threshold proposes it for review.
 * Corroboration is repetition, not truth — the status word says so.
 */
export function inferenceUpsert(scope, input, now) {
  const doc = buildInference(scope, input, now);
  const ttlDays = INFERENCE_TTL_DAYS[input.inferenceType];
  return {
    filter: { _id: doc._id },
    update: {
      $setOnInsert: {
        ...scope,
        inferenceType: doc.inferenceType, claim: doc.claim, claimDigest: doc.claimDigest,
        calibration: "uncalibrated", visibility: "caregiver_only",
        firstObservedAt: now, recordedAt: now,
        promotion: doc.promotion, contradicts: []
      },
      $set: {
        lastObservedAt: now,
        confidence: doc.confidence,
        epistemicStatus: (input.observationCountSoFar ?? 0) + 1 >= CORROBORATION_THRESHOLD
          ? "corroborated" : "inferred",
        sessionId: doc.sessionId, turnId: doc.turnId, model: doc.model,
        ...(ttlDays ? { expiresAt: new Date(+now + ttlDays * 86400000) } : {})
      },
      $inc: { observationCount: 1 },
      $addToSet: { basis: { $each: input.basis } }
    },
    options: { upsert: true }
  };
}

/** Types that may be proposed to a caregiver once corroborated. The rest stay diagnostics. */
export const PROMOTABLE = Object.freeze({
  routine_candidate: "semantic_nodes",
  preference_candidate: "preferences",
  relationship_candidate: "semantic_edges",
  symptom_signal: "symptom_ts",
  contradiction_candidate: "memory_links"
});

export function proposeInference(scope, inference, now) {
  const target = PROMOTABLE[inference.inferenceType];
  if (!target) throw new Error(`${inference.inferenceType} is a diagnostic signal, not a promotable claim`);
  if (inference.observationCount < CORROBORATION_THRESHOLD) {
    throw new Error(`Needs ${CORROBORATION_THRESHOLD} independent observations before review; has ${inference.observationCount}`);
  }
  return {
    filter: { _id: inference._id, ...scope, "promotion.state": "none" },
    update: { $set: { "promotion.state": "proposed", "promotion.targetCollection": target,
                      lastObservedAt: now } }
  };
}

/**
 * The only path from inferred to speakable. A caregiver's name goes on the record,
 * the promoted document is still created as a DRAFT in its target store, and the
 * inference keeps a pointer so "where did the system learn that?" is answerable.
 */
export async function promoteInference(store, scope, { inference, caregiver, targetDoc, reason }, now) {
  if (!caregiver?.id) throw new Error("Promotion requires a named caregiver");
  if (inference.promotion?.state !== "proposed") throw new Error("Only a proposed inference may be promoted");
  const target = PROMOTABLE[inference.inferenceType];
  if (!target) throw new Error("Not a promotable inference type");

  const link = buildLink(scope, {
    fromStore: "semantic", fromId: targetDoc._id,
    linkType: "derived_from", toStore: "episodic",
    toId: inference.basis[0].id,
    createdBy: "caregiver", reviewStatus: "approved",
    sourceIds: targetDoc.sourceIds ?? [], confidence: null
  }, now);

  const apply = async session => {
    await store.db.collection(target).insertOne(targetDoc, { session })
      .catch(error => { if (error.code !== 11000) throw error; });
    await store.db.collection("inferences").updateOne(
      { _id: inference._id, ...scope, "promotion.state": "proposed" },
      { $set: { epistemicStatus: "caregiver_confirmed",
                "promotion.state": "promoted",
                "promotion.targetCollection": target,
                "promotion.targetId": targetDoc._id,
                "promotion.decidedBy": caregiver.id,
                "promotion.decidedAt": now,
                "promotion.reason": reason ?? null } },
      { session });
    await store.db.collection("memory_links").insertOne(link, { session })
      .catch(error => { if (error.code !== 11000) throw error; });
    const chain = await nextAuditSeq(store.db, scope, session);
    await store.db.collection("audit_events").insertOne(chainedAudit(scope, {
      action: "inference_promoted", recordId: inference._id,
      detail: { inferenceType: inference.inferenceType, target, targetId: targetDoc._id,
                observationCount: inference.observationCount, reason: reason ?? null },
      actor: { kind: "caregiver", id: caregiver.id, credentialRef: caregiver.credentialRef ?? null },
      actorRole: caregiver.role ?? "primary_caregiver", riskTier: 1
    }, chain, now), { session });
  };

  if (store.mode !== "mongodb") { await apply(null); return { promoted: true, targetId: targetDoc._id }; }
  const session = store.client.startSession();
  try {
    await session.withTransaction(() => apply(session), { writeConcern: { w: "majority", j: true } });
  } finally { await session.endSession(); }
  return { promoted: true, targetId: targetDoc._id };
}

export function rejectInference(scope, inference, caregiver, reason, now) {
  if (!caregiver?.id) throw new Error("Rejection requires a named caregiver");
  return {
    filter: { _id: inference._id, ...scope },
    update: { $set: { epistemicStatus: "caregiver_rejected",
                      "promotion.state": "rejected",
                      "promotion.decidedBy": caregiver.id,
                      "promotion.decidedAt": now,
                      "promotion.reason": reason ?? null } }
  };
}

// ───────────────────────── consolidation (proposals only) ─────────────────────

export function clamp01(value) { return Math.min(1, Math.max(0, value)); }

/** Salience from evidence, not guesswork. Weights are unvalidated engineering choices. */
export function computeSalience({ mentions = 0, rehearsals = 0, anchorHit = false, confidence = null }) {
  const n = x => Math.min(1, x / 5);
  return clamp01(0.4 * n(mentions) + 0.3 * n(rehearsals) + 0.2 * (anchorHit ? 1 : 0) + 0.1 * (confidence ?? 0.5));
}

/**
 * A detected routine is a DRAFT proposal with inherited evidence and `confidence: null`.
 * Observing something four times is evidence of frequency, not a probability that it
 * is true — writing a number there would be the system inventing a fact about a life.
 */
export function buildRoutineProposal(scope, { recurrenceKey, label, rrule, timeOfDay, sourceIds }, now) {
  return {
    _id: `node_routine_${slug(recurrenceKey)}`,
    ...scope,
    nodeType: "routine",
    label,
    aliases: [],
    attributes: { rrule, timeOfDay },
    lifeStatus: "current",
    sensitivity: "normal",
    disclosure: { policy: "state_plainly", script: null, decidedBy: null, decidedAt: null, reviewNote: null },
    searchText: `${label} routine`,
    embedding: null,
    sourceIds,
    confidence: null,
    reviewStatus: "draft",
    isCurrent: true,
    supersedes: null, supersededBy: null,
    hotEdges: [],
    activation: { score: 0, lastRetrievedAt: null, retrievalCount: 0 },
    version: 1,
    digest: sha256(label, rrule, timeOfDay),
    recordedAt: now,
    reviewedAt: null
  };
}
