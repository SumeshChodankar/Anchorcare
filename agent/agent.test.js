// Tests for the agent's safety boundary and its handling of model output.
//
//   npm run agent:test
//
// No database, no network, no API key. These assert the properties that make an
// always-on agent safe to point at someone with dementia, so they should fail loudly
// if anyone widens the boundary.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { AgentStore, AgentApprovalError } from "./store.js";
import {
  ACTION_POLICY, evaluatePolicy, escalationDecision, outsideSafeZone, withoutWanderingClaims,
  fastRecall, groundedCare, callReply, isMedicationChange, isDistress, CALLS_CARE_TEAM,
  orientationAnswer, herWordsRecall, herWordsCare, isBookingRequest, lifeRecall, lifeCare, planAnswer,
  lifeFitsBetter, asksAboutFuture, asQuestion
} from "./pipeline.js";
import { validate, ACTION_TYPES, hedged } from "./gemini.js";
import { rmsDbfs, downsample, encodeWav, UtteranceDetector, SAMPLE_RATE } from "./voice-capture.js";
import { classifySpeaker } from "./speaker.js";
import { lifeEvidence, patientNameFrom, draftPersonalRecord } from "./life-memory.js";
import { stripEcho, SpokenLog } from "./echo.js";
import { composeAlertMessage, sendCaregiverMessage, resetMessageCooldowns } from "./message-service.js";

/** A store with a driver-shaped stub underneath; nothing reaches a cluster. */
const stubStore = () => new AgentStore({}, {
  collection: () => ({ insertOne: async () => {}, updateOne: async () => {} })
});

const companionTurn = extra => ({
  _id: "turn_x_000001", role: "companion", epistemic: "generated",
  sourceId: null, groundedOn: [], ...extra
});

// ───────────────────────── the write guard ──────────────────────────────────

test("guard: the agent cannot approve anything", async () => {
  const store = stubStore();
  await assert.rejects(
    () => store.safeInsert("conversation_turns", { _id: "x", reviewStatus: "approved" }),
    AgentApprovalError);
  await assert.rejects(
    () => store.safeUpdate("conversation_turns", { _id: "x" }, { $set: { reviewStatus: "approved" } }),
    AgentApprovalError);
});

test("guard: the agent cannot write outside its collection set", async () => {
  const store = stubStore();
  for (const collection of ["episodes", "semantic_nodes", "semantic_edges", "memory_links",
                            "identity_core", "safety_constraints", "consent_records",
                            "procedures", "preferences", "life_chapters"]) {
    await assert.rejects(() => store.safeInsert(collection, { _id: "x" }), AgentApprovalError,
      `${collection} must not be agent-writable`);
  }
});

test("guard: episodes are caregiver territory, inferences are not", async () => {
  const store = stubStore();
  // It may propose into the quarantine…
  await store.safeInsert("inferences", {
    _id: "inf_1", visibility: "caregiver_only", epistemicStatus: "inferred",
    promotion: { state: "none" }
  });
  // …but never into the approved store.
  await assert.rejects(() => store.safeInsert("episodes", { _id: "e1" }), AgentApprovalError);
});

test("guard: an inference can never be made patient-visible", async () => {
  const store = stubStore();
  for (const visibility of ["patient", "public", "everyone"]) {
    await assert.rejects(
      () => store.safeInsert("inferences", { _id: "x", visibility }), AgentApprovalError);
  }
});

test("guard: the agent cannot promote or confirm its own inference", async () => {
  const store = stubStore();
  await assert.rejects(
    () => store.safeInsert("inferences", { _id: "x", promotion: { state: "promoted" } }),
    AgentApprovalError);
  for (const status of ["caregiver_confirmed", "caregiver_rejected"]) {
    await assert.rejects(
      () => store.safeInsert("inferences", { _id: "x", epistemicStatus: status }),
      AgentApprovalError);
  }
  // proposing is allowed — that is what the review queue is for
  await store.safeInsert("inferences", {
    _id: "x", visibility: "caregiver_only", promotion: { state: "proposed" }
  });
});

test("guard: a generated turn may never carry a sourceId", async () => {
  const store = stubStore();
  await assert.rejects(
    () => store.safeInsert("conversation_turns", companionTurn({ sourceId: "source_1" })),
    AgentApprovalError);
});

test("guard: the agent cannot cite its own output as evidence", async () => {
  const store = stubStore();
  await assert.rejects(
    () => store.safeInsert("conversation_turns", companionTurn({
      groundedOn: [{ collection: "conversation_turns", epistemic: "generated",
                     role: "evidence", id: "turn_x_000000" }]
    })), AgentApprovalError);

  // citing a past turn as CONTEXT is fine; that is how the thread stays coherent
  await store.safeInsert("conversation_turns", companionTurn({
    groundedOn: [{ collection: "conversation_turns", epistemic: "generated",
                   role: "context", id: "turn_x_000000" }]
  }));
});

test("guard: the agent cannot cite an inference as evidence", async () => {
  const store = stubStore();
  await assert.rejects(
    () => store.safeInsert("conversation_turns", companionTurn({
      groundedOn: [{ collection: "inferences", role: "evidence", id: "inf_1" }]
    })), AgentApprovalError);
});

test("guard: a correct companion turn is allowed", async () => {
  const store = stubStore();
  await store.safeInsert("conversation_turns", companionTurn({
    groundedOn: [{ store: "episodic", collection: "episodes", role: "evidence", id: "episode_1" }]
  }));
  assert.equal(store.refusals, 0);
});

test("guard: every refusal is counted", async () => {
  const store = stubStore();
  for (const attempt of [
    () => store.safeInsert("episodes", { _id: "x" }),
    () => store.safeInsert("inferences", { _id: "x", visibility: "patient" }),
    () => store.safeInsert("conversation_turns", { _id: "x", reviewStatus: "approved" })
  ]) await assert.rejects(attempt, AgentApprovalError);
  assert.equal(store.refusals, 3, "a silent refusal is no better than a silent write");
});

// ───────────────────── policy parity with the Python side ───────────────────

test("policy: ACTION_POLICY matches caregiver/policy.py exactly", () => {
  const source = readFileSync(new URL("../caregiver/policy.py", import.meta.url), "utf8");
  const fromPython = Object.fromEntries(
    source.split("\n")
      .map(line => line.match(/ActionType\.([A-Z_]+):\s*ExecutionPolicy\.([A-Z_]+)/))
      .filter(Boolean)
      .map(match => [match[1].toLowerCase(), match[2].toLowerCase()]));

  assert.ok(Object.keys(fromPython).length >= 10, "failed to parse policy.py");
  for (const [action, policy] of Object.entries(fromPython)) {
    assert.equal(ACTION_POLICY[action], policy,
      `${action}: policy.py says ${policy}, agent says ${ACTION_POLICY[action]}`);
  }
  assert.deepEqual(Object.keys(ACTION_POLICY).sort(), Object.keys(fromPython).sort());
});

test("policy: an unknown action is prohibited, not permitted", () => {
  assert.equal(evaluatePolicy("exfiltrate_everything"), "prohibited");
  assert.equal(evaluatePolicy(undefined), "prohibited");
  assert.equal(evaluatePolicy(""), "prohibited");
});

test("policy: the three dangerous actions stay prohibited", () => {
  for (const action of ["change_medication_dose", "unlock_door", "contact_emergency_services"]) {
    assert.equal(ACTION_POLICY[action], "prohibited");
  }
});

// ───────────────────── model output is never trusted raw ────────────────────

const evidence = [
  { id: "episode_visit_001", when: "Thu", text: "Sarah visited." },
  { id: "episode_tea_002", when: "Fri", text: "Tea in the garden." }
];
const model = { name: "gemini-4-argon", version: "2026-09" };

test("validate: fabricated evidence ids are dropped, not stored", () => {
  const result = validate({
    answer: "Sarah came on Thursday.",
    evidence_ids: ["episode_visit_001", "episode_that_does_not_exist"],
    epistemic_basis: "observed", has_conflicting_evidence: false, uncertainty: ""
  }, evidence, model);

  assert.deepEqual(result.evidenceIds, ["episode_visit_001"]);
  assert.deepEqual(result.hallucinatedIds, ["episode_that_does_not_exist"]);
});

test("validate: prompt aliases resolve to real ids", () => {
  const result = validate({
    answer: "Sarah came.", evidence_ids: ["E1", "E2"],
    epistemic_basis: "observed", has_conflicting_evidence: false, uncertainty: ""
  }, evidence, model);
  assert.deepEqual(result.evidenceIds, ["episode_visit_001", "episode_tea_002"]);
  assert.deepEqual(result.hallucinatedIds, []);
});

test("validate: claimed grounding with nothing cited is downgraded", () => {
  const result = validate({
    answer: "Yes, Sarah came on Tuesday.", evidence_ids: [],
    epistemic_basis: "observed", has_conflicting_evidence: false, uncertainty: ""
  }, evidence, model);

  assert.equal(result.epistemicBasis, "insufficient_evidence",
    "an answer citing nothing cannot claim to be observed");
  assert.equal(result.downgraded, true);
});

test("validate: every citation fabricated means the basis is downgraded too", () => {
  const result = validate({
    answer: "She went to the pier.", evidence_ids: ["episode_invented"],
    epistemic_basis: "observed", has_conflicting_evidence: false, uncertainty: ""
  }, evidence, model);
  assert.deepEqual(result.evidenceIds, []);
  assert.equal(result.epistemicBasis, "insufficient_evidence");
  assert.equal(result.downgraded, true);
});

test("validate: an unknown action type is discarded", () => {
  const result = validate({
    answer: "ok", evidence_ids: ["E1"], epistemic_basis: "observed",
    has_conflicting_evidence: false, uncertainty: "",
    proposed_action: { action_type: "wire_the_money", summary: "x", target_person_id: "margaret" }
  }, evidence, model);
  assert.equal(result.proposedAction, null);
});

test("validate: a known action type survives for the policy gate to judge", () => {
  const result = validate({
    answer: "ok", evidence_ids: ["E1"], epistemic_basis: "observed",
    has_conflicting_evidence: false, uncertainty: "",
    proposed_action: { action_type: "create_reminder", summary: "Remind about tea",
                       target_person_id: "margaret" }
  }, evidence, model);
  assert.equal(result.proposedAction.action_type, "create_reminder");
  assert.equal(evaluatePolicy(result.proposedAction.action_type), "require_approval");
});

test("validate: ACTION_TYPES matches the Python enum", () => {
  const source = readFileSync(new URL("../caregiver/models.py", import.meta.url), "utf8");
  const fromPython = [...source.matchAll(/^\s{4}[A-Z_]+ = "([a-z_]+)"$/gm)]
    .map(m => m[1])
    .filter(value => ACTION_TYPES.includes(value) || /^(change_|unlock_|contact_|flag_|log_|show_|alert_|create_|draft_|mark_)/.test(value));
  for (const action of ACTION_TYPES) {
    assert.ok(fromPython.includes(action), `${action} is not in models.py ActionType`);
  }
});

test("validate: a conflict flag survives to the routing layer", () => {
  const result = validate({
    answer: "There are two accounts of that.", evidence_ids: ["E1", "E2"],
    epistemic_basis: "reported", has_conflicting_evidence: true, uncertainty: "They disagree."
  }, evidence, model);
  assert.equal(result.hasConflictingEvidence, true);
  assert.equal(result.evidenceIds.length, 2);
});

// ───────────────────── wandering & distress MVP guardrails ──────────────────

test("guard: telemetry_ts is agent-writable via safeInsert", async () => {
  const store = stubStore();
  const res = await store.safeInsert("telemetry_ts", {
    _id: "ts_123", householdId: "demo-household", subjectId: "margaret",
    metric: "geofence_status", state: "left_safe_zone", distanceMiles: 0.5
  });
  assert.equal(res.inserted, true);
});

test("validate: wandering fields are correctly validated and preserved", () => {
  const result = validate({
    answer: "Jane knows where you are and is coming to help.",
    evidence_ids: [],
    epistemic_basis: "inferred",
    has_conflicting_evidence: false,
    uncertainty: "Patient appears disoriented outside safe zone.",
    escalation_required: true,
    wandering_detected: true,
    inferred_triples: [
      { subject: "Patient", predicate: "State", object: "Disoriented" },
      { subject: "Patient", predicate: "Location", object: "Outside Safe Zone" }
    ]
  }, evidence, model);

  assert.equal(result.escalationRequired, true);
  assert.equal(result.wanderingDetected, true);
  assert.equal(result.inferredTriples.length, 2);
  assert.equal(result.inferredTriples[0].subject, "Patient");
  assert.equal(result.inferredTriples[0].object, "Disoriented");
});

test("guard: wandering inference cannot be made patient-visible or approved", async () => {
  const store = stubStore();
  // Attempting to make inference patient-visible throws AgentApprovalError
  await assert.rejects(
    () => store.safeInsert("inferences", {
      _id: "inf_wander_1",
      inferenceType: "topic",
      claim: "Patient -> State -> Disoriented",
      visibility: "patient" // Illegal!
    }),
    AgentApprovalError
  );

  // Attempting to auto-approve throws AgentApprovalError
  await assert.rejects(
    () => store.safeInsert("inferences", {
      _id: "inf_wander_2",
      inferenceType: "topic",
      claim: "Patient -> Location -> Unknown Street",
      reviewStatus: "approved" // Illegal!
    }),
    AgentApprovalError
  );

  // Correct quarantined inference is accepted
  const allowed = await store.safeInsert("inferences", {
    _id: "inf_wander_3",
    inferenceType: "topic",
    claim: "Patient -> State -> Disoriented",
    visibility: "caregiver_only",
    epistemicStatus: "inferred",
    reviewStatus: "draft",
    promotion: { state: "none" }
  });
  assert.equal(allowed.inserted, true);
});

test("guard: companion reassurance cannot cite the wandering inference as evidence", async () => {
  const store = stubStore();
  await assert.rejects(
    () => store.safeInsert("conversation_turns", companionTurn({
      text: "Don't worry, Jane is on her way.",
      groundedOn: [{
        collection: "inferences",
        role: "evidence",
        id: "inf_wander_3"
      }]
    })),
    AgentApprovalError,
    "Companion turn must never cite an inference as evidence"
  );

  // Generated companion turn with ungrounded reassurance or approved context is valid
  const valid = await store.safeInsert("conversation_turns", companionTurn({
    text: "Don't worry, Jane is on her way.",
    groundedOn: []
  }));
  assert.equal(valid.inserted, true);
});

// ───────────────────────── speaker routing ──────────────────────────────────

test("speaker: the diarized primary user is the patient", () => {
  const { role, speaker } = classifySpeaker({
    speaker: "Margaret", speakerType: "primary_user", confidence: 0.92, method: "diarization"
  });
  assert.equal(role, "patient");
  assert.deepEqual(speaker, { name: "Margaret", kind: "patient", method: "diarization", confidence: 0.92, verified: false });
});

test("speaker: typed console text with no type is the patient", () => {
  assert.equal(classifySpeaker({ speaker: "Margaret" }).role, "patient");
  assert.equal(classifySpeaker({}).role, "patient");
});

test("speaker: a caregiver or named visitor is recorded, never as the patient", () => {
  assert.equal(classifySpeaker({ speaker: "Jane (Caregiver)", speakerType: "caregiver" }).role, "caregiver");
  const physio = classifySpeaker({ speaker: "David Lee (Physiotherapist)", speakerType: "visitor" });
  assert.equal(physio.role, "caregiver");
  assert.equal(physio.speaker.kind, "visitor");
});

test("speaker: an unidentified voice is not recorded at all", () => {
  for (const input of [
    { speaker: "Others", speakerType: "others" },
    { speaker: "Others", speakerType: "primary_user" },   // a name of 'Others' wins over the type
    { speakerType: "visitor" },                           // a visitor nobody can name is a bystander
    { speaker: "TV", speakerType: "background" }          // an unknown type fails closed
  ]) {
    assert.equal(classifySpeaker(input).role, null, JSON.stringify(input));
  }
});

test("speaker: an out-of-range confidence is not stored as calibrated", () => {
  assert.equal(classifySpeaker({ speakerType: "primary_user", confidence: 95 }).speaker.confidence, null);
  assert.equal(classifySpeaker({ speakerType: "primary_user", confidence: "high" }).speaker.confidence, null);
});

// ───────────────────────── wandering alerts ─────────────────────────────────

const HOME = { state: "inside_safe_zone", distanceFromHomeMeters: 0 };
const AWAY = { state: "left_safe_zone", distanceFromHomeMeters: 320 };
const flagged = extra => ({ wanderingDetected: true, escalationRequired: true, inferredTriples: [], ...extra });

test("wandering: the geofence, not the model, decides whether she is outside", () => {
  assert.equal(outsideSafeZone(HOME), false);
  assert.equal(outsideSafeZone(AWAY), true);
  assert.equal(outsideSafeZone({ distanceFromHomeMeters: 51 }), true);
  assert.equal(outsideSafeZone({ distanceFromHomeMeters: 50 }), false);
  assert.equal(outsideSafeZone(null), false, "no geofence reading is not evidence she left");
});

test("wandering: a model flag at home is vetoed, not escalated", () => {
  // The live glasses test raised urgent alerts from exactly this shape.
  for (const care of [flagged(), flagged({ wanderingDetected: false }), flagged({ escalationRequired: false })]) {
    const d = escalationDecision(care, HOME);
    assert.equal(d.alert, false);
    assert.equal(d.vetoed, true);
  }
  assert.equal(escalationDecision(flagged(), null).alert, false, "unknown location fails closed");
});

test("wandering: a model flag outside the safe zone raises the alert", () => {
  const d = escalationDecision(flagged(), AWAY);
  assert.deepEqual([d.alert, d.reason, d.vetoed], [true, "wandering_distress", false]);
});

test("wandering: call requests and loop reports still alert at home", () => {
  assert.equal(escalationDecision({}, HOME, true).reason, "phone_call_dispatched");
  const modelCall = flagged({ wanderingDetected: false,
    inferredTriples: [{ subject: "Margaret", predicate: "ContactStatus", object: "CallInitiated" }] });
  assert.equal(escalationDecision(modelCall, HOME).reason, "call_requested");
  const loop = { proposedAction: { action_type: "alert_caregiver_loop_detected" } };
  assert.equal(escalationDecision(loop, HOME).reason, "loop_detected");
  assert.equal(escalationDecision({}, HOME).alert, false, "an ordinary answer raises nothing");
});

test("wandering: a vetoed claim leaves no flag or wandering triple behind", () => {
  const cleaned = withoutWanderingClaims(flagged({ inferredTriples: [
    { subject: "Patient", predicate: "State", object: "Disoriented" },
    { subject: "Patient", predicate: "Location", object: "Outside Safe Zone" },
    { subject: "Alex", predicate: "Owns", object: "Glasses" }
  ] }));
  assert.equal(cleaned.wanderingDetected, false);
  assert.equal(cleaned.escalationRequired, false);
  assert.deepEqual(cleaned.inferredTriples, [{ subject: "Alex", predicate: "Owns", object: "Glasses" }]);
});

// ───────────────────────── answer claims ────────────────────────────────────

/** ts_dedupe as the driver behaves: unique _id, upsert only through a lapsed lease. */
function leaseStore() {
  const docs = new Map();
  const col = {
    updateOne: async (filter, update, options) => {
      await Promise.resolve();                       // let concurrent callers interleave
      const doc = docs.get(filter._id);
      if (doc && doc.expiresAt < filter.expiresAt.$lt) { Object.assign(doc, update.$set); return; }
      if (doc || !options.upsert) throw Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
      docs.set(filter._id, { _id: filter._id, ...update.$set });
    }
  };
  return { store: new AgentStore({}, { collection: () => col }), docs };
}

test("claim: two workers racing for one turn, exactly one wins", async () => {
  const { store } = leaseStore();
  const now = new Date("2026-10-25T02:00:00Z");
  const results = await Promise.all([1, 2, 3].map(n =>
    store.claim("answer:turn_x_000004", { owner: `w${n}`, leaseMs: 120_000, now })));
  assert.equal(results.filter(Boolean).length, 1);
});

test("claim: a lapsed lease can be taken over, a live one cannot", async () => {
  const { store, docs } = leaseStore();
  const t0 = new Date("2026-10-25T02:00:00Z");
  assert.equal(await store.claim("answer:t", { owner: "crashed", leaseMs: 120_000, now: t0 }), true);
  assert.equal(await store.claim("answer:t", { owner: "w2", leaseMs: 120_000, now: new Date(+t0 + 60_000) }), false);
  assert.equal(await store.claim("answer:t", { owner: "w2", leaseMs: 120_000, now: new Date(+t0 + 121_000) }), true);
  assert.equal(docs.get("answer:t").owner, "w2");
});

test("claim: a database failure is not mistaken for losing the race", async () => {
  const store = new AgentStore({}, { collection: () => ({
    updateOne: async () => { throw Object.assign(new Error("not primary"), { code: 10107 }); }
  }) });
  await assert.rejects(() => store.claim("answer:t", { owner: "w", leaseMs: 1000 }), /not primary/);
});

// ───────────────────────── hands-free capture ───────────────────────────────

const BLOCK = 683;                                   // ~43 ms at 16 kHz, like the page
const tone = (ms, amplitude, hz = 220) => {
  const n = Math.round(SAMPLE_RATE * ms / 1000), out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amplitude * Math.sin(2 * Math.PI * hz * i / SAMPLE_RATE);
  return out;
};
const hiss = (ms, amplitude) =>
  Float32Array.from({ length: Math.round(SAMPLE_RATE * ms / 1000) }, () => (Math.random() * 2 - 1) * amplitude);
function feed(detector, ...parts) {
  const all = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.length; }
  const out = [];
  for (let i = 0; i < all.length; i += BLOCK) {
    const u = detector.push(all.subarray(i, i + BLOCK));
    if (u) out.push(u);
  }
  return out;
}

test("voice: loudness is measured in dBFS", () => {
  assert.equal(rmsDbfs(new Float32Array(512)), -100, "digital silence");
  assert.ok(Math.abs(rmsDbfs(tone(100, 1)) - -3.01) < 0.1, "full-scale sine is -3 dBFS");
  assert.ok(Math.abs(rmsDbfs(tone(100, 0.01)) - -43.01) < 0.1, "40 dB quieter is 40 dB lower");
});

test("voice: a sentence in a quiet room becomes exactly one utterance, with pre-roll", () => {
  const d = new UtteranceDetector();
  const out = feed(d, hiss(2000, 0.001), tone(1500, 0.1), hiss(1500, 0.001));
  assert.equal(out.length, 1);
  const seconds = out[0].length / SAMPLE_RATE;
  assert.ok(seconds > 2.0 && seconds < 3.5, `utterance ${seconds.toFixed(2)} s holds speech, pre-roll and hangover`);
  assert.equal(d.speaking, false, "listening again afterwards");
});

test("voice: a click, or noise no louder than the room, is not an utterance", () => {
  const d = new UtteranceDetector();
  assert.equal(feed(d, hiss(2000, 0.001), tone(60, 0.5), hiss(1500, 0.001)).length, 0, "60 ms click");
  const noisy = new UtteranceDetector();
  assert.equal(feed(noisy, hiss(3000, 0.05), hiss(1500, 0.06), hiss(1500, 0.05)).length, 0, "fan noise getting a bit louder");
});

test("voice: the noise floor follows the room, so speech over a fan still triggers", () => {
  const d = new UtteranceDetector();
  feed(d, hiss(4000, 0.02));
  assert.ok(d.level().floorDb > -45, `floor learned the fan (${d.level().floorDb.toFixed(1)} dBFS)`);
  assert.equal(feed(d, tone(1200, 0.3), hiss(1500, 0.02)).length, 1);
});

test("voice: a monologue is cut at the maximum length rather than never sent", () => {
  const d = new UtteranceDetector({ maxUtteranceMs: 3000 });
  const syllables = Array.from({ length: 24 }, () => [tone(250, 0.1), hiss(60, 0.001)]).flat();
  assert.ok(feed(d, hiss(1000, 0.001), ...syllables).length >= 2);
});

test("voice: a steady hum that never pauses stops passing for speech", () => {
  const d = new UtteranceDetector();
  const out = feed(d, hiss(1000, 0.001), tone(8000, 0.1), hiss(1500, 0.001));
  assert.ok(out.length <= 1, "at most the onset is sent, not an endless utterance");
  assert.equal(d.speaking, false);
});

test("voice: WAV header and length are what the transcription model expects", () => {
  const wav = encodeWav(tone(250, 0.5));
  const view = new DataView(wav.buffer);
  assert.equal(String.fromCharCode(...wav.slice(0, 4)), "RIFF");
  assert.equal(String.fromCharCode(...wav.slice(8, 12)), "WAVE");
  assert.equal(view.getUint32(24, true), 16000, "sample rate");
  assert.equal(view.getUint16(34, true), 16, "bits per sample");
  assert.equal(wav.length, 44 + 4000 * 2);
  assert.equal(downsample(new Float32Array(48000), 48000).length, 16000, "48 kHz input becomes 16 kHz");
});

// ───────────────────────── latency: hedged requests ─────────────────────────

const after = (ms, value, fail) => signal => new Promise((resolve, reject) => {
  const t = setTimeout(() => fail ? reject(new Error(value)) : resolve(value), ms);
  signal.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")); });
});

test("hedge: a stalled first request is overtaken by the second", async () => {
  let calls = 0;
  const t0 = Date.now();
  const value = await hedged(signal => (++calls === 1 ? after(5000, "slow") : after(20, "fast"))(signal),
    { hedgeAfterMs: 50, deadlineMs: 2000 });
  assert.equal(value, "fast");
  assert.equal(calls, 2);
  assert.ok(Date.now() - t0 < 1000);
});

test("hedge: a quick answer does not start a second request", async () => {
  let calls = 0;
  assert.equal(await hedged(signal => { calls++; return after(10, "ok")(signal); }, { hedgeAfterMs: 200 }), "ok");
  await new Promise(r => setTimeout(r, 250));
  assert.equal(calls, 1);
});

test("hedge: an early failure retries at once; two failures reject", async () => {
  let calls = 0;
  assert.equal(await hedged(signal => (++calls === 1 ? after(5, "503", true) : after(5, "ok"))(signal),
    { hedgeAfterMs: 5000 }), "ok");
  await assert.rejects(hedged(after(5, "503", true), { hedgeAfterMs: 5000 }), /503/);
});

test("hedge: the deadline rejects so the caller can fall back", async () => {
  await assert.rejects(hedged(after(5000, "late"), { hedgeAfterMs: 20, deadlineMs: 80 }), /no answer within 80 ms/);
});

// ───────────────────────── latency: grounded fast path ──────────────────────

const ep = (id, summary) => ({ doc: { _id: id, summary, eventStart: new Date("2026-10-23T09:00:00Z") } });
const RANKED = [
  ep("water", "FICTIONAL DEMO — Sam reported that Alex drank a glass of water after the garden walk."),
  ep("glasses", "FICTIONAL DEMO — Alex reported leaving his glasses on the bookshelf beside the living-room window."),
  ep("walk", "FICTIONAL DEMO — Sam reported accompanying Alex on a 20-minute walk in the courtyard garden."),
  ep("breakfast", "FICTIONAL DEMO — Sam reported that Alex had oatmeal and Earl Grey tea for breakfast."),
  ep("physio", "FICTIONAL DEMO — Sam reported that physiotherapist David Lee visited Alex in the early evening.")
];

test("fast recall: a plain question finds its one record", () => {
  assert.equal(fastRecall("Where did I put my glasses?", RANKED)?.doc._id, "glasses", "not the glass of water");
  assert.equal(fastRecall("What did I have for breakfast?", RANKED)?.doc._id, "breakfast");
  assert.equal(fastRecall("When did David Lee visit?", RANKED)?.doc._id, "physio", "visit finds visited");
  assert.equal(fastRecall("Did I go for a walk?", RANKED)?.doc._id, "water", "a tie goes to the better-ranked record");
});

test("fast recall: requests, safety signals and unmatched questions go to the model", () => {
  for (const q of ["Can you double my medication dose?", "Call Margaret", "I don't know where I am.",
                   "Where is my house?", "What did I have for dinner last Tuesday?", "Help me", "Hello there"]) {
    assert.equal(fastRecall(q, RANKED), null, q);
  }
});

test("fast recall: the record is read back verbatim, dated, and cited", () => {
  const care = groundedCare(RANKED[1], new Date("2026-10-25T02:00:00Z"), "Europe/London");
  assert.equal(care.answer,
    "Your notes from Friday say: Alex reported leaving his glasses on the bookshelf beside the living-room window.");
  assert.deepEqual(care.evidenceIds, ["glasses"]);
  assert.equal(care.model.name, "grounded-recall");
  assert.ok(groundedCare(RANKED[1], new Date("2026-11-20T09:00:00Z"), "Europe/London")
    .answer.startsWith("Your notes from 23 October say:"));
});

test("call reply: only claims a call when one can actually be placed", () => {
  const sim = { twilioConfigured: false, liveAllowed: false, targetPhoneNumber: "" };
  const live = { twilioConfigured: true, liveAllowed: true, targetPhoneNumber: "+447700900077" };
  assert.doesNotMatch(callReply("phone_call_dispatched", sim), /calling|call for you now/i);
  assert.match(callReply("phone_call_dispatched", live), /making that call/);
  assert.doesNotMatch(callReply("call_requested", live), /making that call/, "a model-only request dials nothing");
});

test("medication: a request to change a dose is recognised, an ordinary question is not", () => {
  for (const q of ["Can you double my medication dose?", "Should I take more pills?", "Can I skip my tablets today?", "Change my medicine"]) {
    assert.equal(isMedicationChange(q), true, q);
  }
  for (const q of ["Did I take my medicine?", "Where are my glasses?", "What time is my medication?"]) {
    assert.equal(isMedicationChange(q), false, q);
  }
});

test("hedge: up to maxAttempts copies start, each a hedge interval apart", async () => {
  let calls = 0;
  const value = await hedged(signal => (++calls < 3 ? after(5000, "stuck") : after(10, "third"))(signal),
    { hedgeAfterMs: 40, deadlineMs: 2000, maxAttempts: 3 });
  assert.equal(value, "third");
  assert.equal(calls, 3);
});

// ───────────────────────── distress calls & caregiver messages ──────────────

test("distress: spoken distress is recognised, ordinary speech is not", () => {
  for (const q of ["Help me", "Help!", "I'm scared. Where am I going?", "I am lost", "I've fallen",
                   "I fell in the kitchen", "I can't breathe", "Please help", "I'm in pain"]) {
    assert.equal(isDistress(q), true, q);
  }
  for (const q of ["I lost my glasses", "Where did I put my glasses?", "What did I have for breakfast?",
                   "The film was scary", "Call Margaret"]) {
    assert.equal(isDistress(q), false, q);
  }
});

test("distress: it calls the care team even at home, and outranks the model's opinion", () => {
  const d = escalationDecision({ wanderingDetected: false, escalationRequired: false }, HOME, false, true);
  assert.deepEqual([d.alert, d.reason, d.vetoed], [true, "distress_call", false]);
  assert.ok(CALLS_CARE_TEAM.includes("distress_call"));
  assert.ok(CALLS_CARE_TEAM.includes("wandering_distress"), "wandering outside the zone also rings");
  assert.ok(!CALLS_CARE_TEAM.includes("loop_detected"), "a repeated question does not ring anyone");
});

test("distress: the reply only claims a call when a live call was really placed", () => {
  const live = { twilioConfigured: true, liveAllowed: true, targetPhoneNumber: "+447700900077" };
  assert.match(callReply("distress_call", live), /calling your care team now/);
  assert.match(callReply("distress_call", live, { placed: false }), /alerted your care team/, "cooldown: no new call");
  assert.match(callReply("distress_call", { twilioConfigured: false }), /alerted your care team/);
});

test("message: an alert becomes a short caregiver text naming what happened", () => {
  const body = composeAlertMessage({ reason: "distress_call", headline: "Distress", subjectName: "Alex",
    said: "I'm scared.", location: { state: "left_safe_zone", distanceFromHomeMeters: 400 },
    now: new Date("2026-10-25T09:30:00Z"), timezone: "Europe/London" });
  assert.match(body, /^AnchorCare alert \(9:30\s?am\): Alex has asked for help\./);
  assert.match(body, /They said: "I'm scared\."/, "her words, punctuated once");
  assert.match(body, /about 0\.2 miles from home/);
  assert.ok(body.length <= 480);
});

test("message: without live SMS configured it is simulated, and nothing is sent", async () => {
  resetMessageCooldowns();
  let calls = 0;
  const sent = await sendCaregiverMessage({ body: "x", reason: "distress_call", fetchImpl: async () => { calls++; } });
  assert.equal(sent.mode, "simulation");
  assert.equal(sent.status, "simulated");
  assert.equal(calls, 0);
});

test("message: one text per alert reason per cooldown, so repeats do not spam", async () => {
  resetMessageCooldowns();
  const t = Date.parse("2026-10-25T03:00:00Z");
  assert.equal((await sendCaregiverMessage({ body: "a", reason: "distress_call", now: t })).status, "simulated");
  assert.equal((await sendCaregiverMessage({ body: "b", reason: "distress_call", now: t + 60_000 })).status, "skipped_cooldown");
  assert.equal((await sendCaregiverMessage({ body: "c", reason: "wandering_distress", now: t + 60_000 })).status, "simulated");
  assert.equal((await sendCaregiverMessage({ body: "d", reason: "distress_call", now: t + 11 * 60_000 })).status, "simulated");
});

test("message: with live SMS configured it posts to Twilio's Messages API", async () => {
  resetMessageCooldowns();
  const saved = { ...process.env };
  Object.assign(process.env, { TWILIO_ACCOUNT_SID: "AC" + "0".repeat(32), TWILIO_AUTH_TOKEN: "test", TWILIO_FROM_NUMBER: "+447700900000",
                               CAREGIVER_SMS_NUMBER: "+447700900123", ENABLE_LIVE_SMS: "true" });
  try {
    let request = null;
    const sent = await sendCaregiverMessage({ body: "hello", reason: "distress_call", fetchImpl: async (url, init) => {
      request = { url, body: String(init.body) };
      return { ok: true, json: async () => ({ sid: "SM1", status: "queued" }) };
    } });
    assert.match(request.url, /\/Messages\.json$/);
    assert.match(request.body, /To=%2B447700900123/);
    assert.deepEqual([sent.mode, sent.status, sent.sid], ["twilio_live", "queued", "SM1"]);
    assert.equal(sent.to, "+•••••••••123", "the number is masked in logs and records");
  } finally {
    for (const k of ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER", "CAREGIVER_SMS_NUMBER", "ENABLE_LIVE_SMS"]) {
      if (k in saved) process.env[k] = saved[k]; else delete process.env[k];
    }
  }
});

// ───────────────────────── orientation, her own words, booking ──────────────

const NOW = new Date("2026-10-25T15:05:00Z");       // 3:05 pm in London (GMT after the clocks change)
const TYPED = { method: "declared", verified: null };
const SPOKEN_UNVERIFIED = { method: "diarization", verified: false };
const SPOKEN_VERIFIED = { method: "diarization", verified: true };

test("orientation: her name comes from the identity record, never a guess", () => {
  const known = orientationAnswer("What is my name?", { identity: { preferredName: "Margaret" }, speaker: TYPED });
  assert.equal(known.answer, "Your name is Margaret.");
  const unknown = orientationAnswer("Can you tell me my name?", { identity: null, speaker: TYPED });
  assert.ok(orientationAnswer("Uh, can you tell me like what my name is?", { speaker: TYPED }), "the order he actually said it in");
  assert.match(unknown.answer, /don't have your name written down/);
  assert.doesNotMatch(unknown.answer, /Alex/);
});

test("orientation: an unverified voice is not told personal details", () => {
  const stranger = orientationAnswer("What's my name?", { identity: { preferredName: "Margaret" }, speaker: SPOKEN_UNVERIFIED });
  assert.doesNotMatch(stranger.answer, /Margaret/);
  assert.match(stranger.answer, /can't tell who is speaking/);
  assert.match(orientationAnswer("What's my name?", { identity: { preferredName: "Margaret" }, speaker: SPOKEN_VERIFIED }).answer, /Margaret/);
});

test("orientation: time and day come from the clock; two questions get two answers", () => {
  const both = orientationAnswer("What is the time now? Hey, what's my name?",
    { identity: { preferredName: "Margaret" }, now: NOW, timezone: "Europe/London", speaker: TYPED });
  assert.match(both.answer, /^Your name is Margaret\. It's 3:05\s?pm\.$/i);
  assert.match(orientationAnswer("What day is it today?", { now: NOW, timezone: "Europe/London" }).answer, /Sunday 25 October/);
});

test("orientation: location says home or how far from home, and flags wandering when away", () => {
  const home = orientationAnswer("Where am I?", { location: { state: "inside_safe_zone", distanceFromHomeMeters: 0 } });
  assert.deepEqual([home.answer, home.wandering], ["You're at home.", false]);
  const away = orientationAnswer("What is my location right now?",
    { location: { state: "left_safe_zone", distanceFromHomeMeters: 650, placeName: "Old Street, Hoxton, London" } });
  assert.match(away.answer, /about 0\.4 miles from home, near Old Street, Hoxton, London/);
  assert.equal(away.wandering, true, "routing escalates it");
  assert.match(orientationAnswer("Where am I?", {}).answer, /can't tell where you are/);
  assert.equal(orientationAnswer("I'm scared. Where am I going?", {}), null, "distress, handled elsewhere");
});

const said = (id, text, at) => ({ _id: id, text, startedAt: new Date(at) });
const UTTERANCES = [                                 // newest first, as the pipeline reads them
  said("t9", "When is my appointment?", "2026-10-25T15:04:00Z"),
  said("t5", "I have an appointment with the dentist tomorrow, can you book it?", "2026-10-25T14:10:00Z"),
  said("t2", "My daughter Priya is visiting on Sunday afternoon.", "2026-10-24T10:00:00Z")
];

test("her words: a later question finds what she said, not her own earlier question", () => {
  assert.equal(herWordsRecall("When is my appointment?", UTTERANCES, "t9")?._id, "t5");
  assert.equal(herWordsRecall("When is Priya visiting?", UTTERANCES)?._id, "t2");
  assert.equal(herWordsRecall("Where are my glasses?", UTTERANCES), null, "nothing she said matches");
  assert.equal(herWordsRecall("Call Margaret", UTTERANCES), null, "a request, not a recall question");
});

test("her words: read back as a dated quotation, marked unconfirmed, citing her turn", () => {
  const care = herWordsCare(UTTERANCES[1], NOW, "Europe/London");
  assert.match(care.answer, /^Earlier today at 2:10\s?pm you told me: "I have an appointment with the dentist tomorrow, can you book it\?" Your care team hasn't confirmed that yet\.$/i);
  assert.deepEqual(care.patientWordIds, ["t5"]);
  assert.deepEqual(care.evidenceIds, [], "never cited as an approved record");
  assert.match(herWordsCare(UTTERANCES[2], NOW, "Europe/London").answer, /^Yesterday at 11:00\s?am you told me/i);
});

test("booking: a request to book goes to the caregiver, a question about it does not", () => {
  for (const q of ["I have an appointment tomorrow, can you book it?", "Please book a doctor's appointment",
                   "Remind me to call Priya", "Can you schedule a visit with the GP?",
                   "I have an appointment with Dr Patel tomorrow at nine, can you set a reminder?"]) {
    assert.equal(isBookingRequest(q), true, q);
  }
  for (const q of ["When is my appointment?", "Where are my glasses?", "Can you double my medication dose?"]) {
    assert.equal(isBookingRequest(q), false, q);
  }
  assert.equal(evaluatePolicy("create_reminder"), "require_approval", "the agent queues it, a caregiver approves it");
});

test("message: an alert with a position carries a map link for the care team", () => {
  const body = composeAlertMessage({ headline: "Wandering / distress outside the safe zone", subjectName: "Margaret",
    location: { state: "left_safe_zone", distance_from_home: "0.40 miles", coords: { lat: 51.527628, lng: -0.083863 } } });
  assert.match(body, /Map: https:\/\/maps\.google\.com\/\?q=51\.52763,-0\.08386/);
});

test("wandering: a reported inside state beats a stray distance (the false 2.35-mile alarm)", () => {
  const atHome = { state: "inside_safe_zone", distanceFromHomeMeters: 3782 };
  assert.equal(outsideSafeZone(atHome), false);
  assert.equal(escalationDecision({ wanderingDetected: true }, atHome).alert, false);
  assert.equal(orientationAnswer("Where am I right now?", { location: atHome }).answer, "You're at home.");
});

// ───────────────────────── the rest of Engram: read and draft ───────────────

const LIFE = {
  records: [
    { _id: "pr_name", kind: "fact", title: "Patient name and identity", reviewStatus: "approved", sourceType: "caregiver_report",
      originalText: "FICTIONAL DEMO — The patient using this memory companion is named Alex Mercer.", recordedAt: new Date("2026-10-24T07:15:00Z") },
    { _id: "pr_tea", kind: "preference", title: "Tea preference", reviewStatus: "approved", sourceType: "caregiver_report",
      originalText: "FICTIONAL DEMO — Alex prefers Earl Grey tea without sugar.", recordedAt: new Date("2026-10-24T06:18:00Z") },
    { _id: "pr_music", kind: "preference", title: "Favourite music", reviewStatus: "approved", sourceType: "caregiver_report",
      originalText: "FICTIONAL DEMO — Alex enjoys quiet piano music.", recordedAt: new Date("2026-10-24T06:18:00Z") }
  ],
  people: [{ _id: "p_sarah", name: "Sarah Mercer", relationship: "daughter" }, { _id: "p_sam", name: "Sam Rivera", relationship: "caregiver" }],
  logs: [{ _id: "dl_lunch", label: "Lunch", activity: "meal", outcome: "reported_done", originalText: "Sam reported vegetable soup.",
           occurredAt: new Date("2026-10-23T11:30:00Z") }],
  plans: [{ _id: "pl_visit", kind: "visit", personId: "p_sarah", eventStart: new Date("2026-10-26T14:00:00Z") }],
  nodes: [], edges: []
};
const ITEMS = lifeEvidence(LIFE, "Europe/London");

test("life: her name comes from an approved identity record when identity_core is empty", () => {
  assert.equal(patientNameFrom(LIFE), "Alex Mercer");
  assert.equal(patientNameFrom({ records: [] }), null);
  const typed = { method: "declared" };
  assert.equal(orientationAnswer("What is my name?", { identity: { preferredName: patientNameFrom(LIFE) }, speaker: typed }).answer,
    "Your name is Alex Mercer.");
});

test("life: people, preferences and logs answer plain questions, citing their own collection", () => {
  const sarah = lifeRecall("Who is Sarah?", ITEMS);
  assert.deepEqual([sarah.item.collection, lifeCare(sarah.item).answer], ["people", "Sarah Mercer is your daughter."]);
  const tea = lifeRecall("What tea do I like?", ITEMS);
  assert.equal(tea.item.id, "pr_tea");
  assert.equal(lifeCare(tea.item).answer, "Your notes say: Alex prefers Earl Grey tea without sugar.");
  assert.match(lifeCare(lifeRecall("What did I have for lunch?", ITEMS).item).answer, /^Your notes from Friday .* say: Sam reported vegetable soup.$/, "the note itself, not its internal label");
  assert.equal(lifeRecall("Call Sarah", ITEMS), null, "a request, not a question");
  assert.equal(lifeRecall("What is the weather?", ITEMS), null, "nothing approved matches");
});

test("life: an approved upcoming plan answers 'when is my appointment'", () => {
  const care = planAnswer("When is my next visit?", ITEMS);
  assert.match(care.answer, /^Your planned visit with Sarah Mercer is on Monday 26 October at 2:00\s?pm\.$/i);
  assert.deepEqual(care.evidenceIds, ["pl_visit"]);
  assert.equal(planAnswer("When is my appointment?", ITEMS.filter(i => !i.plan)), null, "no plan: fall through to her own words");
});

test("life: a statement becomes a DRAFT personal record; questions and greetings do not", () => {
  const scope = { householdId: "anchorcare-demo", subjectId: "demo-person-001" };
  const now = new Date("2026-10-25T15:00:00Z");
  const turn = (text, speaker = { method: "diarization", verified: true }) => ({ _id: "turn_s_000004", text, speaker });
  const pref = draftPersonalRecord(scope, turn("I really like listening to the radio in the morning."), now);
  assert.deepEqual([pref.kind, pref.reviewStatus, pref.sourceType], ["preference", "draft", "user_report"]);
  assert.match(pref.originalText, /voice-verified/);
  assert.equal(draftPersonalRecord(scope, turn("My daughter Priya is visiting on Sunday afternoon."), now).kind, "fact");
  for (const t of ["Where are my glasses?", "Hello", "Good morning.", "Thanks", "Is it raining?"]) {
    assert.equal(draftPersonalRecord(scope, turn(t), now), null, t);
  }
});

test("life: the caregiver's existing review endpoint finds and approves the agent's draft", async () => {
  const { LifeRecords } = await import("../engram-retrieval/src/life-records.js");
  const scope = { householdId: "anchorcare-demo", subjectId: "demo-person-001" };
  const draft = draftPersonalRecord(scope, { _id: "turn_s_000006", text: "I have a dentist appointment on Tuesday at ten.",
                                             speaker: { method: "declared" } }, new Date("2026-10-25T15:00:00Z"));
  const docs = new Map([[draft._id, draft]]);
  const service = {
    store: { update: async (_c, filter, set) => docs.has(filter._id) ? Object.assign(docs.get(filter._id), set) : null },
    scope: () => scope, clock: () => new Date("2026-10-25T16:00:00Z"), audit: async () => {}
  };
  const out = await new LifeRecords(service).review({ patient_id: "demo-person-001", collection: "personal_records",
                                                      id: draft.recordId, status: "approved" });
  assert.equal(out.record.reviewStatus, "approved", "same _id derivation as life-records.js");
});

test("guard: the agent may draft a personal record but never approve one", async () => {
  const store = stubStore();
  assert.equal((await store.safeInsert("personal_records", { _id: "x", reviewStatus: "draft" })).inserted, true);
  await assert.rejects(() => store.safeInsert("personal_records", { _id: "y", reviewStatus: "approved" }), AgentApprovalError);
});

test("life: on a tie, who-questions get the person card and preference questions the preference", () => {
  const sarah = ITEMS.find(i => i.id === "p_sarah"), tea = ITEMS.find(i => i.id === "pr_tea");
  assert.equal(lifeFitsBetter("Who is Sarah?", sarah), true, "not the phone-call episode that mentions her");
  assert.equal(lifeFitsBetter("What tea do I like?", tea), true, "not the breakfast episode that mentions tea");
  assert.equal(lifeFitsBetter("What did I have for lunch?", ITEMS.find(i => i.id === "dl_lunch")), false, "the episode keeps a plain tie");
});

test("life: a question about the future is not answered with a past record", () => {
  assert.equal(asksAboutFuture("When is my next visit?"), true);
  assert.equal(asksAboutFuture("Who is coming tomorrow?"), true);
  assert.equal(asksAboutFuture("When did David Lee visit?"), false);
});

test("life: preferences stored as facts still win a preference question; time words are not content", () => {
  const chamomile = { id: "pr_c", collection: "personal_records", kind: "fact", sourceType: "user_report",
                      text: "Prefers chamomile tea: I prefer chamomile tea." };
  assert.equal(lifeFitsBetter("What tea do I like?", chamomile), true);
  assert.equal(lifeRecall("What tea do I like?", [chamomile, ...ITEMS]).item.id, "pr_tea", "the caregiver record outranks her own report");
  assert.equal(lifeCare(chamomile).answer, 'You told your care team: "I prefer chamomile tea."');
  assert.equal(herWordsRecall("When is my next visit?", [{ _id: "x", text: "Riya is next to me standing.", startedAt: new Date() }]), null);
});

// ───────────────────────── echo, polite questions, mixed turns ──────────────

test("echo: the agent's own reply is cut out of a transcript, and an echo-only clip is dropped", () => {
  const said = ["I've asked your care team to book that for you. I'll remember you told me about it."];
  const merged = stripEcho("Can you tell me at which GP I have an appointment tomorrow? I've asked your care team to book that for you. I'll remember you told me about it.", said);
  assert.deepEqual([merged.text, merged.echoOnly], ["Can you tell me at which GP I have an appointment tomorrow?", false]);
  const tail = stripEcho("team to book that for you. I'll remember you told me about it.", said);
  assert.equal(tail.echoOnly, true, "the tail once labelled 'Jane (Caregiver)'");
  assert.deepEqual(stripEcho("Can you tell me which appointment I have tomorrow?", said).removed, 0, "her own words untouched");
  assert.equal(stripEcho("I'll tell you about it later", said).removed, 0, "two shared words are chance, not echo");
});

test("echo: the spoken log forgets old replies", () => {
  const log = new SpokenLog(1000);
  log.add("Your glasses are on the bookshelf.", 0);
  assert.deepEqual(log.recent(500), ["Your glasses are on the bookshelf."]);
  assert.deepEqual(log.recent(5000), []);
});

test("recall: a politely phrased question is still a question", () => {
  assert.equal(asQuestion("Can you tell me which appointment I have tomorrow?"), "which appointment I have tomorrow?");
  assert.equal(asQuestion("Can you tell me at which GP I have an appointment tomorrow?"), "which GP I have an appointment tomorrow?");
  assert.equal(asQuestion("Do you know where my glasses are?"), "where my glasses are?");
  assert.equal(fastRecall("Could you tell me where did I put my glasses?", RANKED)?.doc._id, "glasses");
});

test("her words: a turn that opens with a question but states a fact is remembered", () => {
  const appointment = { _id: "t1", startedAt: new Date("2026-10-25T05:04:00Z"),
    text: "Can you please check? I have an appointment tomorrow. Make sure there's a reminder set up for me at 9 o'clock in the GP Guildowns Group Practice." };
  assert.equal(herWordsRecall("Can you tell me which appointment I have tomorrow?", [appointment])?._id, "t1");
  const draft = draftPersonalRecord({ householdId: "h", subjectId: "s" }, { ...appointment, speaker: { method: "declared" } }, new Date());
  assert.equal(draft.title, "Reported: I have an appointment tomorrow.", "drafted, titled by the fact, not the question");
  assert.equal(herWordsRecall("Which appointment?", [{ _id: "q", text: "When is my appointment?", startedAt: new Date() }]), null,
    "a turn that is only a question is not a statement");
});

test("orientation: \"I don't know where I am\" is a location question, answered from the geofence", () => {
  assert.equal(orientationAnswer("I don't know where I am.", { location: { state: "inside_safe_zone" } }).answer, "You're at home.");
});

// ───────────────────────── Windows speaker state ────────────────────────────

test("speakers: a muted default output is flagged, and an audible alternative is noticed", async () => {
  const { summarise } = await import("./audio-output.js");
  const s = summarise([
    { name: "Odyssey G5", volume: 100, muted: true, isDefault: true },
    { name: "Speaker (Realtek)", volume: 46, muted: false, isDefault: false }
  ]);
  assert.equal(s.default.name, "Odyssey G5");
  assert.equal(s.default.silent, true);
  assert.equal(s.allSilent, false, "the laptop speaker could still be used");
  assert.equal(summarise([{ name: "A", volume: 3, muted: false, isDefault: true }]).allSilent, true, "3% is effectively silent");
  assert.equal(summarise([]), null);
});

test("call script: the caregiver hears who, what happened, her words and where", async () => {
  const { composeCallScript, locationSentence } = await import("./message-service.js");
  const home = { state: "inside_safe_zone", distanceFromHomeMeters: 0 };
  const script = composeCallScript({ reason: "distress_call", subjectName: "Alex Mercer",
    said: "Help me, I have fallen and I cannot get up.", location: home, textSent: true });
  assert.equal(script, "This is an urgent call from AnchorCare. Alex Mercer has asked for help. They said: Help me, I have fallen " +
    "and I cannot get up. Their location shows them at home. A text message with their map location has been sent to this phone.");
  assert.match(composeCallScript({ reason: "wandering_distress", subjectName: "Alex", location:
    { state: "left_safe_zone", distanceFromHomeMeters: 1609, placeName: "Old Street" } }), /may be lost.*about 1\.0 miles from home, near Old Street\.$/);
  assert.equal(locationSentence(null), "Their location is not known.");
  assert.doesNotMatch(composeCallScript({ reason: "distress_call", subjectName: "Alex", location: home }), /text message/,
    "no promise of a text when texts are not live");
});

test("call script: spoken text is escaped for Twilio's XML", async () => {
  const saved = { ...process.env };
  delete process.env.TWILIO_ACCOUNT_SID;               // simulation: nothing leaves the machine
  try {
    const { initiateCall, getCallStatus } = await import("./call-service.js");
    await initiateCall({ script: "They said: <help> & \"now\"", subjectName: "Alex" });
    assert.equal(getCallStatus().mode, "simulation");
    assert.equal(getCallStatus().lastMessage, "They said: <help> & \"now\"", "the script is what is spoken");
  } finally { Object.assign(process.env, saved); }
});
