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
import { ACTION_POLICY, evaluatePolicy } from "./pipeline.js";
import { validate, ACTION_TYPES } from "./gemini.js";
import { classifySpeaker } from "./speaker.js";

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
  assert.deepEqual(speaker, { name: "Margaret", kind: "patient", method: "diarization", confidence: 0.92 });
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
