// One turn, end to end. The fixed cycle from ATLAS-MEMORY-SCHEMA.md §12, with the
// write routing from GEMINI-WRITE-ROUTING.md §§1–4.
//
//   0  safety precheck        can end the turn by itself
//   1  working context        her recent words only, never the agent's
//   2  retrieval              $rankFusion over approved, source-backed episodes
//   3  canonical re-check     candidates are not answers
//   4  disclosure resolution  constraint ▸ script ▸ lifeStatus ▸ plain
//   5  cognition              gemini-4-argon → CareResponse
//   6  routing                every field to exactly one collection
//
// The patient turn is written BEFORE this runs (daemon.js), so a crash here loses the
// answer, never her words.

import {
  episodicRecallPipeline, groundCandidates, rankForAnswer,
  resolveDisclosure, constraintCovers, activeConstraintsFilter,
  recentTurnsQuery, assertNotSelfCitation
} from "../db/retrieval.js";
// buildCompanionTurn, not recordCompanionTurn: the recorder writes through
// `store.db` directly, which would bypass the guard in agent/store.js. Building the
// document here and inserting it through safeInsert keeps every generated write on
// the guarded path.
import {
  buildCompanionTurn, buildInference, inferenceUpsert, buildAlert,
  severityTier, deterministicId, sha256
} from "../db/ingest.js";
import * as callService from "./call-service.js";

/** Mirrors ACTION_POLICY_MAP in caregiver/policy.py. */
export const ACTION_POLICY = Object.freeze({
  flag_memory_conflict: "auto_execute",
  log_patient_mood_report: "auto_execute",
  show_orientation_card: "auto_execute",
  alert_caregiver_loop_detected: "auto_execute",
  create_reminder: "require_approval",
  draft_family_message: "require_approval",
  mark_routine_completed: "require_approval",
  change_medication_dose: "prohibited",
  unlock_door: "prohibited",
  contact_emergency_services: "prohibited"
});
export const evaluatePolicy = type => ACTION_POLICY[type] ?? "prohibited";

const DEFER = "Let me check that with Jane and come back to you.";
const NO_MEMORY = "I don't have anything written down about that. Shall we ask Jane?";

const words = text => String(text).toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];

export function createPipeline(ctx) {
  const { cfg, store, reason, log = () => {} } = ctx;
  const scope = { householdId: cfg.householdId, subjectId: cfg.subjectId };
  const db = store.db;

  let constraintCache = { at: 0, value: [] };

  async function constraints(now) {
    if (now - constraintCache.at < 60_000) return constraintCache.value;
    const value = await db.collection("safety_constraints")
      .find(activeConstraintsFilter(scope, new Date(now))).toArray();
    constraintCache = { at: now, value };
    return value;
  }

  /** Lets a caregiver's change reach a live conversation without waiting for a cache. */
  function invalidateConstraints() { constraintCache = { at: 0, value: [] }; }

  async function run(turn, locationContext = null) {
    const started = Date.now();
    const now = new Date();
    const active = await constraints(started);
    const trace = { retrievalMs: 0, generationMs: 0 };

    // ── 0. safety precheck ────────────────────────────────────────────────
    const veto = active.find(c =>
      c.severity === "absolute" && constraintCovers(c, { text: turn.text }));
    if (veto) {
      log("veto", `${veto._id} — answering from its script`);
      return emit(turn, {
        answer: veto.rule?.responseScript || DEFER,
        evidenceIds: [], epistemicBasis: "insufficient_evidence",
        hasConflictingEvidence: false, uncertainty: "Blocked by a safety constraint.",
        proposedAction: null, hallucinatedIds: [], downgraded: false,
        escalationRequired: false, wanderingDetected: false, inferredTriples: [],
        model: { name: "scripted", version: "constraint_response", promptDigest: null,
                 temperature: null, tokensIn: 0, tokensOut: 0 }
      }, {
        groundedOn: [
          { store: "safety", collection: "safety_constraints", id: veto._id, role: "veto" },
          { store: "safety", collection: "safety_constraints", id: veto._id, role: "script" }
        ],
        disclosure: { policy: "redirect", nodeId: null, scriptUsed: true, constraintIds: [veto._id] },
        precheck: "veto", vetoConstraintId: veto._id,
        locationContext,
        latency: { ...trace, firstTokenMs: Date.now() - started, totalMs: Date.now() - started }
      }, now);
    }

    // ── 1. working context: HER words only (patient_utterances view) ───────
    const recentQuery = recentTurnsQuery(scope, turn.sessionId, { limit: 6 });
    const recent = (await db.collection(recentQuery.collection)
      .find(recentQuery.filter).sort(recentQuery.sort).limit(recentQuery.limit).toArray())
      .filter(t => t.seq < turn.seq).reverse();

    // ── 2–3. retrieval, then canonical re-check ───────────────────────────
    const t0 = Date.now();
    let ranked = [];
    try {
      const candidates = await db.collection("episodes")
        .aggregate(episodicRecallPipeline(cfg, scope, turn.text, {}), { maxTimeMS: 20000 })
        .toArray();
      const grounded = await groundCandidates(db, scope, candidates);
      ranked = rankForAnswer(grounded, now).slice(0, 5);
    } catch (error) {
      log("retrieval-failed", error.message);
    }
    trace.retrievalMs = Date.now() - t0;

    // ── 4. disclosure ─────────────────────────────────────────────────────
    const nodeIds = [...new Set(ranked.flatMap(g => g.doc.semanticRefs ?? []))];
    const nodes = nodeIds.length
      ? await db.collection("semantic_nodes").find({
          ...scope, _id: { $in: nodeIds }, reviewStatus: "approved", isCurrent: true
        }).toArray()
      : [];
    const identity = await db.collection("identity_core").findOne({ _id: cfg.subjectId });

    // A question that names a grief-sensitive or non-current person is answered from
    // the caregiver's script, verbatim, and the model is not asked to compose.
    const mentioned = nodes.find(n =>
      (n.sensitivity && n.sensitivity !== "normal") || ["deceased", "former"].includes(n.lifeStatus));
    let script = null;
    if (mentioned) {
      const named = words(turn.text);
      const hit = [n => n.label, n => n.aliases].some(() =>
        named.some(w => w === String(mentioned.label).toLowerCase()
          || (mentioned.aliases ?? []).some(a => String(a).toLowerCase() === w)));
      if (hit) {
        const loss = (identity?.knownLosses ?? []).find(l => l.nodeId === mentioned._id);
        const resolved = resolveDisclosure(
          [{ nodeId: mentioned._id, node: mentioned, text: turn.text, sourceIds: mentioned.sourceIds }],
          identity ?? {}, active);
        if (resolved[0]?.mode === "script") script = resolved[0].text;
        else if (resolved[0]?.mode === "redirect") script = loss?.script ?? DEFER;
        else if (!resolved.length) script = DEFER;
      }
    }

    // ── 5. cognition ──────────────────────────────────────────────────────
    const evidence = ranked.map(g => ({
      id: g.doc._id,
      when: g.doc.eventStart ? new Date(g.doc.eventStart).toDateString() : "unknown",
      text: g.doc.summary ?? g.doc.searchText ?? "",
      people: (g.doc.semanticRefs ?? [])
        .map(id => nodes.find(n => n._id === id)?.label).filter(Boolean)
    }));

    let care;
    const t1 = Date.now();
    try {
      care = await reason({ utterance: turn.text, evidence, identity, script, recent, locationContext });
    } catch (error) {
      log("cognition-failed", error.message);
      care = {
        answer: NO_MEMORY, evidenceIds: [], epistemicBasis: "insufficient_evidence",
        hasConflictingEvidence: false, uncertainty: `Model unavailable: ${error.message}`,
        proposedAction: null, hallucinatedIds: [], downgraded: false,
        escalationRequired: false, wanderingDetected: false, inferredTriples: [],
        model: { name: cfg.geminiModel, version: null, promptDigest: null,
                 temperature: cfg.temperature, tokensIn: 0, tokensOut: 0 }
      };
    }
    trace.generationMs = Date.now() - t1;

    const groundedOn = [
      ...care.evidenceIds.map(id => ({ store: "episodic", collection: "episodes", id, role: "evidence" })),
      ...nodes.map(n => ({ store: "semantic", collection: "semantic_nodes", id: n._id, role: "context" })),
      ...active.filter(c => c.severity === "absolute")
        .map(c => ({ store: "safety", collection: "safety_constraints", id: c._id, role: "filter" })),
      ...(script ? [{ store: "semantic", collection: "semantic_nodes", id: mentioned._id, role: "script" }] : [])
    ];
    assertNotSelfCitation(groundedOn);

    return emit(turn, care, {
      groundedOn,
      disclosure: script
        ? { policy: "defer_to_caregiver", nodeId: mentioned?._id ?? null, scriptUsed: true, constraintIds: [] }
        : { policy: "state_plainly", nodeId: null, scriptUsed: false, constraintIds: [] },
      precheck: "pass", vetoConstraintId: null,
      locationContext,
      latency: { ...trace, firstTokenMs: null, totalMs: Date.now() - started }
    }, now);
  }

  // ── 6. routing ──────────────────────────────────────────────────────────
  async function emit(turn, care, meta, now) {
    const alertIds = [];

    // 6a. a prohibited action is vetoed and escalated; it is never carried out.
    if (care.proposedAction) {
      const policy = evaluatePolicy(care.proposedAction.action_type);
      if (policy === "prohibited") {
        const alert = buildAlert(scope, {
          alertType: "manual", severity: "urgent",
          triggerRefs: [{ store: "episodic", collection: "conversation_turns", id: turn._id }],
          evidenceSummary:
            `The assistant proposed a prohibited action (${care.proposedAction.action_type}) ` +
            `in response to: "${turn.text.slice(0, 200)}". It was refused and not carried out. ` +
            `Its stated reason: ${String(care.proposedAction.summary).slice(0, 400)}`
        }, now);
        await store.safeInsert("care_alerts", alert);
        await store.safeInsert("active_tasks", {
          _id: deterministicId("task", scope, alert.idempotencyKey), ...scope,
          sessionId: turn.sessionId, taskType: "escalate", status: "pending",
          riskTier: severityTier("urgent"), procedureId: null, procedureVersion: null,
          payload: { alertId: alert._id, refusedAction: care.proposedAction.action_type },
          dueAt: now, slaDeadlineAt: alert.slaDeadlineAt,
          blockedBy: [], leaseToken: null, leaseUntil: null, attempts: 0, createdAt: now
        });
        alertIds.push(alert._id);
        log("prohibited", `${care.proposedAction.action_type} refused and escalated`);
      } else if (policy === "require_approval") {
        await store.safeInsert("active_tasks", {
          _id: deterministicId("task", scope, turn._id, care.proposedAction.action_type), ...scope,
          sessionId: turn.sessionId, taskType: "await_caregiver_approval", status: "pending",
          riskTier: 2, procedureId: null, procedureVersion: null,
          payload: { action: care.proposedAction, turnId: turn._id },
          dueAt: now, slaDeadlineAt: new Date(+now + 4 * 3600_000),
          blockedBy: [], leaseToken: null, leaseUntil: null, attempts: 0, createdAt: now
          // no expiresAt: a tier-2 task must not be reaped by TTL
        });
        log("approval-needed", care.proposedAction.action_type);
      }
    }

    // 6a-1. wandering distress or explicit escalation required: immediate urgent alert
    const isCallRequest = callService.detectCallIntent(turn.text);
    if (care.escalationRequired || care.wanderingDetected || care.proposedAction?.action_type === "alert_caregiver_loop_detected" || isCallRequest) {
      if (isCallRequest) {
        log("call-intent", `Explicit call requested: "${turn.text}"`);
        if (ctx.onCall) {
          ctx.onCall(turn);
        } else {
          callService.initiateCall({ reason: turn.text });
        }
      }
      const alert = buildAlert(scope, {
        alertType: "manual", severity: "urgent",
        triggerRefs: [{ store: "episodic", collection: "conversation_turns", id: turn._id }],
        evidenceSummary:
          (isCallRequest ? `Voice Call Triggered: Patient/User requested "${turn.text.slice(0, 200)}". Outbound anonymous call dispatched. ` : `Wandering / distress escalation: Patient voiced "${turn.text.slice(0, 200)}". `) +
          (meta.locationContext ? `Location: ${meta.locationContext.status_description || meta.locationContext.state}. ` : "") +
          `Assistant note: ${String(care.uncertainty || care.answer).slice(0, 300)}`
      }, now);
      await store.safeInsert("care_alerts", alert);
      await store.safeInsert("active_tasks", {
        _id: deterministicId("task", scope, alert.idempotencyKey), ...scope,
        sessionId: turn.sessionId, taskType: "escalate", status: "pending",
        riskTier: severityTier("urgent"), procedureId: null, procedureVersion: null,
        payload: { alertId: alert._id, reason: isCallRequest ? "phone_call_dispatched" : "wandering_distress", locationContext: meta.locationContext ?? null },
        dueAt: now, slaDeadlineAt: alert.slaDeadlineAt,
        blockedBy: [], leaseToken: null, leaseUntil: null, attempts: 0, createdAt: now
      });
      alertIds.push(alert._id);
      log(isCallRequest ? "call-alert" : "wandering-alert", alert._id);
    }

    // 6b. the companion turn — generated, unciteable, model-attributed.
    // buildCompanionTurn throws on a missing model or a self-citation; safeInsert
    // then re-checks at write time. Two independent gates, deliberately.
    const companion = buildCompanionTurn(scope, {
      sessionId: turn.sessionId, seq: turn.seq + 1, text: care.answer,
      model: care.model, groundedOn: meta.groundedOn, disclosure: meta.disclosure,
      safetyPrecheck: meta.precheck, vetoConstraintId: meta.vetoConstraintId,
      alertIds, latency: meta.latency, inferenceIds: []
    }, now);
    await store.safeInsert("conversation_turns", companion);
    await store.safeUpdate("conversation_sessions",
      { _id: turn.sessionId, ...scope }, { $inc: { turnCount: 1 } });

    // 6c. inferences — stored, quarantined, never citable
    const inferences = [];
    if (care.inferredTriples?.length) {
      for (const t of care.inferredTriples) {
        inferences.push({
          inferenceType: "topic",
          claim: {
            subject: t.subject,
            predicate: t.predicate,
            object: t.object,
            triple: `${t.subject} -> ${t.predicate} -> ${t.object}`
          },
          confidence: null
        });
      }
    }
    if (care.epistemicBasis === "inferred") {
      inferences.push({
        inferenceType: "topic",
        claim: { answer: care.answer.slice(0, 500), basis: "inferred", turnId: turn._id },
        confidence: null
      });
    }
    if (care.uncertainty && care.epistemicBasis === "insufficient_evidence") {
      inferences.push({
        inferenceType: "retrieval_miss",
        claim: { question: turn.text.slice(0, 500), uncertainty: care.uncertainty.slice(0, 500) },
        confidence: null
      });
    }
    if (care.hallucinatedIds.length) {
      inferences.push({
        inferenceType: "retrieval_miss",
        claim: { kind: "fabricated_citation", ids: care.hallucinatedIds.slice(0, 10), turnId: turn._id },
        confidence: null
      });
      log("fabricated-citation", care.hallucinatedIds.join(", "));
    }

    const inferenceIds = [];
    for (const spec of inferences) {
      const built = buildInference(scope, {
        ...spec,
        basis: [{ store: "episodic", collection: "conversation_turns", id: turn._id }],
        sessionId: turn.sessionId, turnId: turn._id, model: care.model
      }, now);
      const upsert = inferenceUpsert(scope, {
        ...spec,
        basis: built.basis, sessionId: turn.sessionId, turnId: turn._id, model: care.model
      }, now);
      await store.safeUpdate("inferences", upsert.filter, upsert.update, upsert.options);
      inferenceIds.push(built._id);
    }
    if (inferenceIds.length) {
      await store.safeUpdate("conversation_turns",
        { _id: companion._id }, { $set: { inferenceIds } });
    }

    // 6d. a flagged conflict becomes a contradiction for a caregiver to look at
    if (care.hasConflictingEvidence && care.evidenceIds.length >= 2) {
      log("conflict", care.evidenceIds.slice(0, 2).join(" ↔ "));
    }

    // 6e. session counters
    await store.safeUpdate("conversation_sessions",
      { _id: turn.sessionId, ...scope },
      { $inc: {
          ...(meta.disclosure?.scriptUsed ? { "signals.scriptedDisclosures": 1 } : {}),
          ...(meta.precheck === "veto" ? { "signals.safetyVetoes": 1 } : {}),
          ...(alertIds.length ? { "signals.escalations": alertIds.length } : {}),
          ...(care.evidenceIds.length === 0 ? { "signals.retrievalFailures": 1 } : {})
        },
        $set: { lastTurnAt: now } });

    return { companion, care, alertIds, inferenceIds };
  }

  return { run, invalidateConstraints };
}
