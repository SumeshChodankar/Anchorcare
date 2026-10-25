// Tests for the cognitive memory schema's pure builders and guards.
// No database required.
//
//   node --test db/
//
// These tests assert the schema's safety properties, not just its shapes:
// nothing reaches the patient as approved, filters are pre-filters, scope is
// repeated inside $graphLookup, safety data cannot be TTL'd, and no builder
// invents a confidence number.

import test from "node:test";
import assert from "node:assert/strict";

import collections, { NO_TTL, WRITE_ONCE, WORKING_CAPACITY, APPEND_ONLY, views } from "./collections.js";
import {
  episodicRecallPipeline, semanticExpandPipeline, chapterSearchPipeline,
  episodeFilter, tokenFilters, effectiveActivation, liveSlots, slotsToEvict,
  resolveDisclosure, constraintCovers, vetoFor, recencyKernel, procedureCandidateQuery,
  currentPreferencesFilter, activeConstraintsFilter,
  PATIENT_ONLY, PATIENT_UTTERANCE_VIEW, conversationReadTarget, recentTurnsQuery,
  conversationSearchPipeline, evidenceFromTurns, assertNotSelfCitation, inferenceReviewQuery
} from "./retrieval.js";
import {
  buildSource, buildEpisodeDraft, buildEdgePair, buildLink, buildAlert,
  chainedAudit, buildRoutineProposal, computeSalience, stripDerived,
  firstClause, recurrenceHash, deterministicId, severityTier, GENESIS,
  turnId, buildPatientTurn, buildHeardTurn, buildCompanionTurn, buildConversationSession,
  buildInference, inferenceUpsert, proposeInference, rejectInference,
  PROMOTABLE, INFERENCE_TTL_DAYS, CORROBORATION_THRESHOLD
} from "./ingest.js";

const scope = { householdId: "demo-household", subjectId: "margaret" };
const cfg = {
  searchIndex: "episodes_text", vectorIndex: "episodes_auto", embeddingMode: "auto",
  nativeRerank: false, embeddingModel: "voyage-4", dimensions: 1024
};
const now = new Date("2026-10-24T09:18:41Z");

// ───────────────────────────── registry ──────────────────────────────────────

test("registry: every spec is well formed and uniquely named", () => {
  const names = new Set();
  for (const c of collections) {
    assert.ok(c.name, "spec without a name");
    assert.ok(!names.has(c.name), `duplicate spec: ${c.name}`);
    names.add(c.name);
    for (const index of c.indexes ?? []) {
      assert.ok(index.keys && Object.keys(index.keys).length, `index without keys in ${c.name}`);
    }
    if (c.kind === "timeseries") assert.ok(c.timeseries?.timeField, `${c.name} has no timeField`);
  }
});

test("registry: scoped collections lead every regular index with householdId+subjectId", () => {
  const unscoped = new Set(["tool_registry", "identity_core", "audit_counters", "ts_dedupe", "procedures"]);
  // Two deliberate exceptions, each named rather than waved through:
  //   device_auth     — the token IS the identifier and is looked up BEFORE a scope
  //                     is known. Unique and global so a token cannot collide across
  //                     households, which a scoped unique index would permit.
  //   endpoint_dedupe — one browser push endpoint must not be registered under two
  //                     households, so the uniqueness question is cross-scope.
  const unscopedIndexes = new Set(["device_auth", "endpoint_dedupe"]);
  for (const c of collections) {
    if (unscoped.has(c.name) || c.kind === "timeseries") continue;
    for (const { keys, options = {} } of c.indexes ?? []) {
      if (options.expireAfterSeconds !== undefined) continue;   // TTL indexes are single-field
      if (options.name && unscopedIndexes.has(options.name)) continue;
      if (Object.keys(keys)[0] === "boundTo.id") continue;       // invalidation index, scope follows
      const [first, second] = Object.keys(keys);
      assert.equal(first, "householdId", `${c.name}: index does not lead with householdId (${JSON.stringify(keys)})`);
      assert.equal(second, "subjectId", `${c.name}: index does not lead with subjectId (${JSON.stringify(keys)})`);
    }
  }
});

test("device link: every mobile collection the app writes to is in the registry", () => {
  // Found by auditing the live cluster: these are created implicitly on first insert
  // and appear in no index script in this repo.
  const names = collections.map(c => c.name);
  for (const name of ["mobile_devices", "mobile_pairings", "mobile_commands", "mobile_policies",
                      "mobile_sos", "mobile_sos_gates", "mobile_push", "mobile_push_attempts",
                      "integration_requests", "demo_scenarios"]) {
    assert.ok(names.includes(name), `${name} is written by integration/ but has no spec`);
  }
});

test("device link: the SOS path is indexed for the queries the worker actually runs", () => {
  const spec = collections.find(c => c.name === "mobile_sos");
  assert.equal(spec.store, "safety");
  const byName = new Map(spec.indexes.map(i => [i.options.name, i.keys]));
  // worker: list({...scope, status:'queued', expiresAt:{$gt:now}})
  assert.deepEqual(byName.get("queued_sos_sweep"),
    { householdId: 1, subjectId: 1, status: 1, expiresAt: 1 });
  // worker: callState pending/dispatching claims and the active-call poll
  assert.deepEqual(byName.get("call_state_machine"),
    { householdId: 1, subjectId: 1, callState: 1, createdAt: 1 });
  assert.deepEqual(byName.get("sos_history"),
    { householdId: 1, subjectId: 1, createdAt: -1 });
});

test("device link: expiresAt collections are TTL landmines and are protected", () => {
  // mobile_sos, mobile_commands and mobile_devices all carry expiresAt for business
  // logic. A TTL index added "to clean up" would delete emergency records.
  for (const name of ["mobile_sos", "mobile_sos_gates", "mobile_commands",
                      "mobile_devices", "mobile_push", "mobile_push_attempts",
                      "integration_requests"]) {
    assert.ok(NO_TTL.includes(name), `${name} must be in NO_TTL`);
    const spec = collections.find(c => c.name === name);
    const ttl = (spec.indexes ?? []).filter(i => i.options?.expireAfterSeconds !== undefined);
    assert.equal(ttl.length, 0, `${name} declares a TTL index`);
  }
});

test("device link: mobile_pairings is the one deliberate TTL exception", () => {
  assert.ok(!NO_TTL.includes("mobile_pairings"), "five-minute pairing codes should expire");
  const spec = collections.find(c => c.name === "mobile_pairings");
  const ttl = spec.indexes.find(i => i.options?.expireAfterSeconds !== undefined);
  assert.ok(ttl, "mobile_pairings should have a TTL index");
  assert.deepEqual(ttl.keys, { expiresAt: 1 });
  assert.ok(ttl.options.expireAfterSeconds > 0, "use a grace period so a just-expired code reports 'expired', not 'not found'");
});

test("device link: the device auth lookup is uniquely indexed and intentionally unscoped", () => {
  const spec = collections.find(c => c.name === "mobile_devices");
  const auth = spec.indexes.find(i => i.options?.name === "device_auth");
  assert.deepEqual(auth.keys, { tokenHash: 1 });
  assert.equal(auth.options.unique, true, "a token must not collide across households");
  assert.ok(!("householdId" in auth.keys),
    "the token is the identifier; the lookup happens before a scope is known");
});

test("device link: specs are additive — no validator is imposed on a live collection", () => {
  for (const name of ["mobile_devices", "mobile_pairings", "mobile_commands", "mobile_policies",
                      "mobile_sos", "mobile_sos_gates", "mobile_push", "mobile_push_attempts",
                      "integration_requests", "demo_scenarios"]) {
    const spec = collections.find(c => c.name === name);
    assert.equal(spec.existing, true, `${name} must be marked existing`);
    assert.equal(spec.validator, undefined,
      `${name} must not carry a validator: current writes would start failing`);
  }
});

test("registry: no TTL is declared on a collection that must never expire", () => {
  for (const c of collections) {
    if (!NO_TTL.includes(c.name)) continue;
    const ttl = (c.indexes ?? []).filter(i => i.options?.expireAfterSeconds !== undefined);
    assert.equal(ttl.length, 0, `${c.name} declares a TTL index`);
    assert.equal(c.expireAfterSeconds, undefined, `${c.name} declares expireAfterSeconds`);
  }
  for (const name of ["care_alerts", "safety_constraints", "medication_responses",
                      "audit_events", "procedure_runs", "consent_records", "symptom_ts"]) {
    assert.ok(NO_TTL.includes(name), `${name} must be in NO_TTL`);
  }
});

test("registry: care_alerts cannot carry a clinical conclusion", () => {
  const alerts = collections.find(c => c.name === "care_alerts");
  const schema = alerts.validator.$jsonSchema;
  assert.equal(schema.additionalProperties, false, "additionalProperties must be closed");
  assert.ok(!("clinicalClaim" in schema.properties));
  assert.ok(schema.required.includes("triggerRefs"), "evidence is required");
  assert.equal(schema.properties.triggerRefs.minItems, 1, "at least one evidence ref");
});

test("registry: safety_constraints accepts approved records only, with a named authority", () => {
  const spec = collections.find(c => c.name === "safety_constraints").validator.$jsonSchema;
  assert.deepEqual(spec.properties.reviewStatus.enum, ["approved"]);
  assert.ok(spec.required.includes("authority"));
  assert.deepEqual(spec.properties.authority.required, ["kind", "name", "role", "recordedAt"]);
  assert.equal(spec.properties.sourceIds.minItems, 1);
});

test("registry: active_tasks TTL is sparse so tier-2 tasks cannot be reaped", () => {
  const spec = collections.find(c => c.name === "active_tasks");
  const ttl = spec.indexes.find(i => i.options?.expireAfterSeconds !== undefined);
  assert.equal(ttl.options.sparse, true);
  assert.deepEqual(ttl.keys, { expiresAt: 1 });
});

test("consent: a record cannot exist without a named grantor and a capacity", () => {
  const spec = collections.find(c => c.name === "consent_records").validator.$jsonSchema;
  assert.ok(spec.required.includes("grantedBy"));
  assert.deepEqual(spec.properties.grantedBy.required, ["kind", "name"],
    "both who consented and in what capacity are required — capacity fluctuates in dementia");
  assert.deepEqual(spec.properties.grantedBy.properties.kind.enum,
    ["subject", "attorney", "next_of_kin"]);
  for (const field of ["proactiveContactAllowed", "rehearsalAllowed"]) {
    assert.ok(spec.required.includes(field), `${field} must be explicit, never defaulted`);
  }
});

test("consent: the document db/seed-consent.js builds satisfies the validator", () => {
  // Mirrors the record in seed-consent.js field for field. If that script changes
  // shape, this test fails before a live write does.
  const record = {
    _id: "consent_2026_10_24_abc12345", householdId: "demo-household", subjectId: "margaret",
    version: 1,
    grantedBy: { kind: "subject", name: "Margaret Doyle", role: null, evidenceRef: null },
    scopeOfConsent: { collections: [], purposes: [], recipients: [] },
    proactiveContactAllowed: true, rehearsalAllowed: true,
    dataRetention: { episodesDays: 1825, mediaDays: 1825, tsDays: 365, auditDays: 2555 },
    withdrawnAt: null, withdrawnBy: null, supersededBy: null,
    recordedAt: new Date(), digest: "deadbeef"
  };
  const spec = collections.find(c => c.name === "consent_records").validator.$jsonSchema;
  for (const field of spec.required) {
    assert.ok(field in record, `seed-consent.js omits required field ${field}`);
  }
  for (const field of spec.properties.grantedBy.required) {
    assert.ok(field in record.grantedBy, `seed-consent.js omits grantedBy.${field}`);
  }
});

test("registry: write-once collections are the expected set", () => {
  for (const name of ["sources", "audit_events", "medication_responses", "recall_attempts",
                      "procedure_runs", "consent_records", "procedures", "rehearsal_sets"]) {
    assert.ok(WRITE_ONCE.includes(name), `${name} should be write-once`);
  }
});

test("registry: procedures are write-once per version", () => {
  const spec = collections.find(c => c.name === "procedures");
  const unique = spec.indexes.find(i => i.options?.unique);
  assert.deepEqual(unique.keys, { procedureId: 1, version: 1 });
});

// ───────────────────────────── retrieval ─────────────────────────────────────

test("episodic recall: filters are pre-filters inside $vectorSearch", () => {
  const pipeline = episodicRecallPipeline(cfg, scope, "did Sarah visit",
    { from: new Date("2026-10-20T00:00:00Z"), personId: "person_sarah" });
  const vs = pipeline[0].$rankFusion.input.pipelines.semantic[0].$vectorSearch;
  assert.equal(vs.filter.householdId, "demo-household");
  assert.equal(vs.filter.reviewStatus, "approved");
  assert.equal(vs.filter.isCurrent, true);
  assert.equal(vs.filter.semanticRefs, "person_sarah");
  assert.ok(vs.filter.eventStart.$gte instanceof Date);
  assert.equal(vs.numCandidates, vs.limit * 20);
});

test("episodic recall: no $project inside a fusion branch; projection comes last", () => {
  const pipeline = episodicRecallPipeline(cfg, scope, "tea in the garden", {});
  const branches = JSON.stringify(pipeline[0].$rankFusion.input.pipelines);
  assert.ok(!branches.includes("$project"), "a $project inside a branch silently drops documents");
  assert.deepEqual(pipeline.at(-1), { $project: { embedding: 0, visualEmbedding: 0 } });
  assert.ok(pipeline.some(s => s.$match), "canonical re-match stage present");
});

test("episodic recall: the visual branch appears only with a query vector", () => {
  const without = episodicRecallPipeline(cfg, scope, "the garden photo", {});
  assert.deepEqual(Object.keys(without[0].$rankFusion.input.pipelines), ["text", "semantic"]);

  const withVector = episodicRecallPipeline(cfg, scope, "the garden photo",
    { visualQueryVector: new Array(1024).fill(0.01) });
  assert.deepEqual(Object.keys(withVector[0].$rankFusion.input.pipelines), ["text", "semantic", "visual"]);
  assert.equal(withVector[0].$rankFusion.combination.weights.visual, 0.6);
});

test("episodic recall: $rerank is added only when enabled", () => {
  const off = episodicRecallPipeline(cfg, scope, "x", {});
  assert.ok(!off.some(s => s.$rerank));
  const on = episodicRecallPipeline({ ...cfg, nativeRerank: true }, scope, "x", {});
  assert.ok(on.some(s => s.$rerank));
  assert.equal(on.at(-1).$project.embedding, 0, "rerank precedes projection");
});

test("filters: approved + current is the only read path, and both forms agree", () => {
  const mongo = episodeFilter(scope, {});
  assert.equal(mongo.reviewStatus, "approved");
  assert.equal(mongo.isCurrent, true);

  const search = tokenFilters(scope, {});
  assert.ok(search.some(f => f.equals?.path === "reviewStatus" && f.equals.value === "approved"));
  assert.ok(search.some(f => f.equals?.path === "isCurrent" && f.equals.value === true));
  assert.ok(search.some(f => f.equals?.path === "householdId"));
});

test("graph traversal: scope is repeated inside restrictSearchWithMatch", () => {
  const pipeline = semanticExpandPipeline(scope, ["person_sarah"], { maxDepth: 2 });
  const restrict = pipeline[1].$graphLookup.restrictSearchWithMatch;
  assert.equal(restrict.householdId, "demo-household", "$graphLookup does not inherit the outer $match");
  assert.equal(restrict.subjectId, "margaret");
  assert.equal(restrict.reviewStatus, "approved", "draft edges must never traverse");
});

test("graph traversal: disputed edges are never traversed, depth is bounded", () => {
  const pipeline = semanticExpandPipeline(scope, ["person_sarah"], { maxDepth: 2 });
  const lookup = pipeline[1].$graphLookup;
  assert.ok(!lookup.restrictSearchWithMatch.status.$in.includes("disputed"));
  assert.equal(lookup.maxDepth, 1, "maxDepth 2 hops == $graphLookup maxDepth 1");
  assert.throws(() => semanticExpandPipeline(scope, ["x"], { maxDepth: 3 }), RangeError);
  assert.throws(() => semanticExpandPipeline(scope, ["x"], { maxDepth: 0 }), RangeError);
});

test("graph traversal: the reachable array is bounded before the neighbour lookup", () => {
  const pipeline = semanticExpandPipeline(scope, ["node_place_care_home"], { maxEdges: 40 });
  const slice = pipeline[2].$addFields.reachable.$slice;
  assert.equal(slice[1], 40, "a hub node must not blow the 16MB document limit");
});

test("chapter search: fuzzy phrases outrank narrative text", () => {
  const pipeline = chapterSearchPipeline(scope, "when the children were small");
  const should = pipeline[0].$search.compound.should;
  const fuzzy = should.find(s => s.text.path === "fuzzyPhrases");
  assert.equal(fuzzy.text.score.boost.value, 3);
  assert.ok(pipeline[0].$search.compound.filter.some(f => f.equals.value === "approved"));
});

test("preference and constraint windows exclude expired records", () => {
  const prefs = currentPreferencesFilter(scope, now);
  assert.equal(prefs.isCurrent, true);
  assert.ok(prefs.$or.some(c => c.validTo === null));
  const constraints = activeConstraintsFilter(scope, now);
  assert.ok(constraints.effectiveFrom.$lte instanceof Date);
});

test("procedure selection: a subject override outranks the household default", () => {
  const { filter, sort } = procedureCandidateQuery(scope, "schedule");
  assert.deepEqual(filter.subjectId.$in, ["margaret", "*"]);
  assert.equal(filter["approval.status"], "active", "only active policies execute");
  assert.equal(sort.subjectId, -1, "'margaret' sorts before '*'");
});

// ───────────────────────── working memory decay ──────────────────────────────

test("working memory: one half-life halves the activation", () => {
  const slot = { slotType: "topic", activation: 1, decayHalfLifeSeconds: 900,
                 lastTouchedAt: new Date(+now - 900_000) };
  assert.ok(Math.abs(effectiveActivation(slot, now) - 0.5) < 1e-12);
});

test("working memory: capacity evicts the weakest, safety flags are exempt", () => {
  const slots = Array.from({ length: 12 }, (_, i) => ({
    _id: `s${i}`, slotType: "topic", activation: (i + 1) / 12,
    decayHalfLifeSeconds: 900, lastTouchedAt: now
  }));
  slots.push({ _id: "safety", slotType: "safety_flag", activation: 0.01,
               decayHalfLifeSeconds: 86400, lastTouchedAt: new Date(0) });

  const evicted = slotsToEvict(slots, now, WORKING_CAPACITY);
  assert.equal(evicted.length, 3);
  assert.ok(!evicted.some(s => s.slotType === "safety_flag"));
  assert.deepEqual(evicted.map(s => s._id), ["s2", "s1", "s0"], "weakest first");

  const live = liveSlots(slots, now);
  assert.ok(live.some(s => s._id === "safety"), "a stale safety flag still surfaces");
});

test("recency kernel is monotonic and bounded", () => {
  const recent = recencyKernel(new Date(+now - 86_400_000), now);
  const old = recencyKernel(new Date(+now - 365 * 86_400_000), now);
  assert.ok(recent > old && recent <= 1 && old > 0);
  assert.ok(Math.abs(recencyKernel(new Date(+now - 30 * 86_400_000), now) - 0.5) < 1e-9);
});

// ───────────────────────────── disclosure gate ───────────────────────────────

const identity = {
  knownLosses: [{ nodeId: "person_albert", disclosurePolicy: "defer_to_caregiver",
                  script: "Albert isn't here just now. Would you like to tell me about him?" }],
  comfortTopics: [{ label: "the garden" }]
};
const absolutes = [{ severity: "absolute", constraintType: "do_not_mention",
                     rule: { phrases: ["house sale", "the solicitor"] } }];

test("disclosure: an absolute constraint omits the fact entirely", () => {
  const out = resolveDisclosure(
    [{ nodeId: null, text: "The house sale completes next week", sourceIds: ["s1"] }],
    identity, absolutes);
  assert.equal(out.length, 0);
});

test("disclosure: a bereavement is answered with the caregiver's script, verbatim", () => {
  const out = resolveDisclosure([{
    nodeId: "person_albert", text: "Albert died in 2019",
    node: { lifeStatus: "deceased", sensitivity: "grief_sensitive",
            disclosure: { policy: "defer_to_caregiver" } },
    sourceIds: ["s1"]
  }], identity, []);
  assert.equal(out[0].mode, "script");
  assert.equal(out[0].mayElaborate, false, "the generator gets no latitude here");
  assert.match(out[0].text, /Albert isn't here just now/);
});

test("disclosure: a withheld node produces nothing at all", () => {
  const out = resolveDisclosure([{
    nodeId: "node_secret", text: "x",
    node: { lifeStatus: "current", sensitivity: "withheld", disclosure: { policy: "withhold" } }
  }], {}, []);
  assert.equal(out.length, 0);
});

test("disclosure: a former entity is stated in the past tense", () => {
  const out = resolveDisclosure([{
    nodeId: "node_place_oakfield_road", text: "She lived on Oakfield Road",
    node: { lifeStatus: "former", sensitivity: "normal" }, sourceIds: ["s1"]
  }], {}, []);
  assert.equal(out[0].mode, "state");
  assert.equal(out[0].tense, "past");
});

test("disclosure: an ordinary fact is stated plainly with its citations", () => {
  const out = resolveDisclosure([{
    nodeId: "person_sarah", text: "Sarah visited on Thursday",
    node: { lifeStatus: "current", sensitivity: "normal" }, sourceIds: ["source_1"]
  }], identity, absolutes);
  assert.equal(out[0].mode, "state");
  assert.equal(out[0].tense, "present");
  assert.deepEqual(out[0].cite, ["source_1"]);
});

test("constraintCovers matches phrases, node ids and substances without inference", () => {
  assert.ok(constraintCovers({ rule: { phrases: ["House Sale"] } }, { text: "about the house sale" }));
  assert.ok(constraintCovers({ rule: { nodeIds: ["person_x"] } }, { nodeId: "person_x" }));
  assert.ok(constraintCovers({ rule: { substance: "penicillin" } }, { text: "Penicillin was mentioned" }));
  assert.ok(!constraintCovers({ rule: { phrases: ["house sale"] } }, { text: "the garden" }));
});

test("safety veto outranks a procedure at any tier", () => {
  const procedure = { procedureId: "device_check", riskTier: 1,
                      steps: [{ toolId: "tool.device.unlock", args: {} }] };
  const constraint = { severity: "absolute", constraintType: "device_restriction",
                       rule: { toolIds: ["tool.device.unlock"] } };
  assert.equal(vetoFor(procedure, [constraint]), constraint);
  assert.equal(vetoFor(procedure, []), null);
});

// ───────────────────────────── write builders ────────────────────────────────

test("sources: text needs no inspection, media does, derived needs a processor", () => {
  const text = buildSource(scope, { sourceType: "caregiver_report", modality: "text",
                                    content: "Sarah came over." }, now);
  assert.ok(text._id.startsWith("source_"));
  assert.equal(text.inspection.required, false);
  assert.equal(text.digest.length, 64);

  const image = buildSource(scope, { sourceType: "media_reference", modality: "image",
                                     bytesDigest: "abc", mediaPtr: "image_1" }, now);
  assert.equal(image.inspection.required, true);
  assert.equal(image.content, null, "image bytes never live in `content`");

  assert.throws(() => buildSource(scope, {
    sourceType: "recording_transcript", modality: "text", content: "x", derivedFrom: "source_1"
  }, now), /processor/);
});

test("sources: identical bytes in one scope produce one id", () => {
  const a = buildSource(scope, { sourceType: "user_report", modality: "text", content: "same" }, now);
  const b = buildSource(scope, { sourceType: "user_report", modality: "text", content: "same" },
                        new Date(+now + 60_000));
  assert.equal(a._id, b._id, "retried upload must not create a second source");
});

test("episodes: ingestion always produces a draft and invents nothing", () => {
  const source = buildSource(scope, { sourceType: "caregiver_report", modality: "text", content: "n" }, now);
  const episode = buildEpisodeDraft(scope, {
    narrative: "Sarah visited. They had tea in the garden.",
    what: "visit", place: "garden",
    eventStart: new Date("2026-10-22T14:30:00Z"), kind: "visit", personId: "person_sarah"
  }, [source._id], cfg, now);

  assert.equal(episode.reviewStatus, "draft", "nothing from ingestion is patient-visible");
  assert.equal(episode.salience, null, "salience comes from evidence, later");
  assert.equal(episode.emotionalTone, null, "tone is only ever set from a human report");
  assert.deepEqual(episode.personIds, [], "links are approved separately");
  assert.equal(episode.gist, "Sarah visited.");
  assert.equal(episode.recurrenceKey, "visit|garden|afternoon");
  assert.equal(episode.embeddingMeta.inputDigest.length, 64);
  assert.equal(episode.dedupeKey, "visit|person_sarah|2026-10-22");
});

test("episodes: evidence is required and future events are refused", () => {
  assert.throws(() => buildEpisodeDraft(scope, { narrative: "x", eventStart: now }, [], cfg, now),
                /source evidence/);
  assert.throws(() => buildEpisodeDraft(scope, {
    narrative: "x", eventStart: new Date("2027-01-01T00:00:00Z")
  }, ["source_1"], cfg, now), /Future events/);
});

test("corrections: derived values are stripped so a stale vector cannot ride along", () => {
  const stripped = stripDerived({
    _id: "episode_1", summary: "s", embedding: [1, 2, 3], visualEmbedding: [4],
    embeddingMeta: { inputDigest: "old" }, consolidation: { state: "consolidated" },
    salience: 0.9, contractDigest: "d", sourceIds: ["s1"]
  });
  for (const key of ["embedding", "visualEmbedding", "embeddingMeta", "consolidation", "salience", "contractDigest"]) {
    assert.ok(!(key in stripped), `${key} must not survive a correction`);
  }
  assert.deepEqual(stripped.sourceIds, ["s1"]);
});

test("edges: both directions are materialized and share a pairId", () => {
  const pair = buildEdgePair(scope, {
    fromId: "person_sarah", toId: "subject_margaret", edgeType: "child_of", sourceIds: ["s1"]
  }, now);
  assert.equal(pair.length, 2);
  assert.equal(pair[0].pairId, pair[1].pairId, "a correction must move both halves");
  assert.equal(pair[0].direction, "forward");
  assert.equal(pair[1].direction, "reverse");
  assert.equal(pair[1].edgeType, "parent_of");
  assert.ok(pair.every(e => e.reviewStatus === "draft"), "entity-linking guesses stay invisible");
  assert.ok(pair.every(e => e.digest.length === 64));
});

test("edges: an edge with no inverse yields a single document", () => {
  const single = buildEdgePair(scope, {
    fromId: "person_sarah", toId: "node_org_choir", edgeType: "attended", sourceIds: ["s1"]
  }, now);
  assert.equal(single.length, 1);
});

test("links: ids are deterministic and agent proposals are drafts", () => {
  const input = { fromStore: "episodic", fromId: "episode_1", linkType: "about",
                  toStore: "semantic", toId: "person_sarah", createdBy: "agent_proposal" };
  const a = buildLink(scope, input, now);
  const b = buildLink(scope, input, new Date(+now + 1000));
  assert.equal(a._id, b._id);
  assert.equal(a.reviewStatus, "draft");
  assert.equal(a.reviewedAt, null);
});

test("alerts: evidence is mandatory and the SLA follows severity", () => {
  assert.throws(() => buildAlert(scope, {
    alertType: "manual", severity: "urgent", triggerRefs: [], evidenceSummary: "x"
  }, now), /evidence/);

  const urgent = buildAlert(scope, {
    alertType: "medication_no_response", severity: "urgent",
    triggerRefs: [{ store: "procedural", id: "prompt_1" }],
    evidenceSummary: "No response by 08:10. Reported state, not a verified dose."
  }, now);
  assert.equal(urgent.state, "raised");
  assert.equal(urgent.transitions.length, 1);
  assert.equal(+urgent.slaDeadlineAt - +now, 30 * 60 * 1000);
  assert.equal(urgent.resolution, null);

  const emergency = buildAlert(scope, {
    alertType: "fall_reported", severity: "emergency",
    triggerRefs: [{ store: "safety", id: "obs_1" }], evidenceSummary: "Self-reported fall."
  }, now);
  assert.equal(+emergency.slaDeadlineAt - +now, 5 * 60 * 1000);
  assert.equal(severityTier("emergency"), 3);
});

test("alerts: the same signal on the same day yields the same idempotency key", () => {
  const input = { alertType: "medication_no_response", severity: "urgent",
                  triggerRefs: [{ store: "procedural", id: "prompt_1" }], evidenceSummary: "x" };
  const a = buildAlert(scope, input, now);
  const b = buildAlert(scope, { ...input, triggerRefs: [...input.triggerRefs] },
                       new Date("2026-10-24T16:00:00Z"));
  assert.equal(a.idempotencyKey, b.idempotencyKey, "alert storms must collapse");
});

test("audit: an event without an actor is not audit", () => {
  assert.throws(() => chainedAudit(scope, { action: "x", recordId: "y" },
                                   { seq: 1, prevDigest: null }, now), /actor/);
});

test("audit: the chain starts at GENESIS and every digest depends on the previous", () => {
  const first = chainedAudit(scope, {
    action: "episode_approved", recordId: "episode_1",
    actor: { kind: "caregiver", id: "carer_jane" }, actorRole: "primary_caregiver", riskTier: 1
  }, { seq: 1, prevDigest: null }, now);
  assert.equal(first.prevDigest, GENESIS);
  assert.equal(first.digest.length, 64);

  const second = chainedAudit(scope, {
    action: "alert_raised", recordId: "alert_1",
    actor: { kind: "agent", id: "companion" }, riskTier: 2
  }, { seq: 2, prevDigest: first.digest }, now);

  const forged = chainedAudit(scope, {
    action: "alert_raised", recordId: "alert_1",
    actor: { kind: "agent", id: "companion" }, riskTier: 2
  }, { seq: 2, prevDigest: "tampered" }, now);

  assert.notEqual(second.digest, forged.digest, "altering the chain must be detectable");
});

test("consolidation: salience is evidence-driven and bounded", () => {
  const none = computeSalience({ mentions: 0, rehearsals: 0 });
  const lots = computeSalience({ mentions: 5, rehearsals: 5, anchorHit: true, confidence: 1 });
  assert.ok(none < lots);
  assert.ok(none >= 0 && lots <= 1);
});

test("consolidation: a detected routine is a draft with no invented confidence", () => {
  const routine = buildRoutineProposal(scope, {
    recurrenceKey: "tea|garden|afternoon", label: "Afternoon tea in the garden",
    rrule: "FREQ=WEEKLY;BYDAY=TH", timeOfDay: "afternoon",
    sourceIds: ["s1", "s2", "s3", "s4"]
  }, now);
  assert.equal(routine.reviewStatus, "draft", "consolidation proposes, it never approves");
  assert.equal(routine.confidence, null, "frequency is not a probability that something is true");
  assert.equal(routine.sourceIds.length, 4, "evidence is inherited, not invented");
  assert.equal(routine.lifeStatus, "current");
  assert.equal(routine.disclosure.policy, "state_plainly");
});

// ─────────────── real-time capture: what was actually said ───────────────────

test("capture: conversation turns and sessions are durable, never TTL'd", () => {
  for (const name of ["conversation_turns", "conversation_sessions"]) {
    assert.ok(NO_TTL.includes(name), `${name} must never expire`);
    const spec = collections.find(c => c.name === name);
    const ttl = (spec.indexes ?? []).filter(i => i.options?.expireAfterSeconds !== undefined);
    assert.equal(ttl.length, 0, `${name} declares a TTL index`);
  }
});

test("capture: turn ids are deterministic, unique per session and naturally sortable", () => {
  assert.equal(turnId("ws1", 4), "turn_ws1_000004");
  assert.ok(turnId("ws1", 9) < turnId("ws1", 10), "lexical order must match turn order");
  const spec = collections.find(c => c.name === "conversation_turns");
  const unique = spec.indexes.find(i => i.options?.unique);
  assert.deepEqual(unique.keys, { householdId: 1, subjectId: 1, sessionId: 1, seq: 1 });
});

test("capture: a patient turn yields a citable write-once source", () => {
  const { turn, source } = buildPatientTurn(scope, {
    sessionId: "ws1", seq: 4, text: "Is Sarah coming today?", modality: "text"
  }, now);
  assert.equal(turn.role, "patient");
  assert.equal(turn.epistemic, "observed");
  assert.equal(turn.sourceId, source._id, "her words must be citable");
  assert.equal(source.sourceType, "user_report");
  assert.equal(turn.model, null, "an observed turn has no model provenance");
});

test("capture: a speech turn's text is a derived source needing inspection", () => {
  const { turn, source } = buildPatientTurn(scope, {
    sessionId: "ws1", seq: 4, text: "Is Sarah coming today?", modality: "speech",
    transcript: { engine: "whisper", version: "v3", confidence: 0.91 },
    audio: { storage: "s3", ref: "s3://turns/ws1-4.opus", durationMs: 2100 }
  }, now);
  assert.equal(source.inspection.required, true, "the recogniser may have misheard her");
  assert.equal(source.content, "Is Sarah coming today?", "her words survive with audio retention off");
  assert.equal(source.processor.name, "whisper");
  assert.equal(turn.transcript.confidence, 0.91, "the engine's own number, uncalibrated");
  assert.equal(turn.audio.storage, "s3", "audio is a pointer, never inline");
});

test("capture: a caregiver turn is observed but never her words", () => {
  const { turn, source } = buildHeardTurn(scope, {
    sessionId: "ws1", seq: 6, role: "caregiver", text: "I've put your glasses by the window.",
    modality: "speech", speaker: { name: "Jane (Caregiver)", kind: "caregiver", method: "diarization", confidence: 0.8 }
  }, now);
  assert.equal(turn.role, "caregiver");
  assert.equal(turn.epistemic, "observed", "we did hear it");
  assert.equal(source, null, "a caregiver's remark is not a user_report source");
  assert.equal(turn.sourceId, null, "so it cannot be cited as her evidence");
  assert.deepEqual(turn.speaker, { name: "Jane (Caregiver)", kind: "caregiver", method: "diarization", confidence: 0.8, verified: null });
  const view = views.find(v => v.name === PATIENT_UTTERANCE_VIEW).pipeline[0].$match;
  assert.notEqual(turn.role, view.role, "excluded from patient_utterances");
  assert.notEqual(turn.role, PATIENT_ONLY.role, "excluded from the companion's read path");
});

test("capture: a patient turn keeps the speaker label it was captured with", () => {
  const { turn } = buildPatientTurn(scope, {
    sessionId: "ws1", seq: 2, text: "Where are my glasses?",
    speaker: { name: "Margaret", kind: "patient", method: "declared" }
  }, now);
  assert.deepEqual(turn.speaker, { name: "Margaret", kind: "patient", method: "declared", confidence: null, verified: null });
  assert.equal(buildPatientTurn(scope, { sessionId: "ws1", seq: 3, text: "hi" }, now).turn.speaker, null);
});

test("capture: a heard turn cannot claim to be companion or system output", () => {
  for (const role of ["companion", "system", "visitor"]) {
    assert.throws(() => buildHeardTurn(scope, { sessionId: "ws1", seq: 1, role, text: "x" }, now));
  }
});

test("capture: audio retention is off unless the caller supplies a policy", () => {
  const { turn } = buildPatientTurn(scope, { sessionId: "ws1", seq: 1, text: "hello" }, now);
  assert.equal(turn.audio.storage, "none");
  assert.equal(turn.audio.ref, null);
  assert.equal(turn.audio.retainUntil, null);
});

test("capture: a companion turn is generated, unciteable, and carries model provenance", () => {
  const turn = buildCompanionTurn(scope, {
    sessionId: "ws1", seq: 5, text: "Sarah came on Thursday.",
    model: { name: "gemini-4-argon", version: "2026-09", tokensOut: 12 },
    groundedOn: [{ store: "episodic", collection: "episodes", id: "episode_visit_001", role: "evidence" }]
  }, now);
  assert.equal(turn.epistemic, "generated");
  assert.equal(turn.sourceId, null, "a sentence the system produced is not evidence");
  assert.equal(turn.model.name, "gemini-4-argon");
  assert.equal(turn.groundedOn.length, 1, "explainability for an ordinary answer, not just procedures");
});

test("capture: a generated turn without model provenance is refused", () => {
  assert.throws(() => buildCompanionTurn(scope, { sessionId: "ws1", seq: 5, text: "x" }, now),
                /model provenance/);
});

test("capture: the companion cannot cite its own output as evidence", () => {
  assert.throws(() => buildCompanionTurn(scope, {
    sessionId: "ws1", seq: 6, text: "As I said, Sarah came on Thursday.",
    model: { name: "m" },
    groundedOn: [{ store: "episodic", collection: "conversation_turns",
                   id: "turn_ws1_000005", epistemic: "generated", role: "evidence" }]
  }, now), /cited as evidence/);
});

test("capture: an inference cannot be cited as evidence", () => {
  assert.throws(() => buildCompanionTurn(scope, {
    sessionId: "ws1", seq: 6, text: "You usually have tea at four.",
    model: { name: "m" },
    groundedOn: [{ store: "episodic", collection: "inferences", id: "inf_1", role: "evidence" }]
  }, now), /cited as evidence/);
});

test("capture: assertNotSelfCitation throws rather than silently filtering", () => {
  assert.throws(() => assertNotSelfCitation([
    { collection: "conversation_turns", id: "turn_1", epistemic: "generated", role: "evidence" }
  ]), /Generated turns cited as evidence/);
  assert.throws(() => assertNotSelfCitation([
    { collection: "inferences", id: "inf_1", role: "evidence" }
  ]), /Promote it first/);
  // citing a generated turn as CONTEXT is fine — it is how the thread stays coherent
  const ok = [{ collection: "conversation_turns", id: "turn_1", epistemic: "generated", role: "context" }];
  assert.deepEqual(assertNotSelfCitation(ok), ok);
});

test("capture: the companion reads patient utterances through a view, not the base collection", () => {
  const view = views.find(v => v.name === PATIENT_UTTERANCE_VIEW);
  assert.ok(view, "the patient_utterances view must exist");
  assert.equal(view.viewOn, "conversation_turns");
  const match = view.pipeline[0].$match;
  assert.equal(match.role, "patient");
  assert.equal(match.epistemic, "observed");
  assert.deepEqual(match.redacted, { $ne: true });

  assert.equal(conversationReadTarget().collection, PATIENT_UTTERANCE_VIEW);
  assert.equal(recentTurnsQuery(scope, "ws1").collection, PATIENT_UTTERANCE_VIEW);
});

test("capture: generated turns are reachable only by a caregiver audience", () => {
  assert.throws(() => conversationReadTarget({ includeGenerated: true }), /caregiver-only/);
  assert.throws(() => recentTurnsQuery(scope, "ws1", { includeGenerated: true }), /caregiver-only/);
  assert.equal(
    conversationReadTarget({ audience: "caregiver", includeGenerated: true }).collection,
    "conversation_turns");
});

test("capture: conversation search is patient-only and cannot be widened", () => {
  const pipeline = conversationSearchPipeline(cfg, scope, "the pier");
  const vs = pipeline[0].$rankFusion.input.pipelines.semantic[0].$vectorSearch;
  assert.equal(vs.filter.role, "patient");
  assert.equal(vs.filter.epistemic, "observed");
  assert.equal(vs.filter.redacted, false);

  const tokens = pipeline[0].$rankFusion.input.pipelines.text[0].$search.compound.filter;
  assert.ok(tokens.some(f => f.equals?.path === "role" && f.equals.value === "patient"));
  assert.ok(tokens.some(f => f.equals?.path === "epistemic" && f.equals.value === "observed"));

  const reassert = pipeline.find(s => s.$match);
  assert.equal(reassert.$match.role, "patient", "filter re-asserted after fusion");
  assert.throws(() => conversationSearchPipeline(cfg, scope, "x", { role: "companion" }),
                /observed patient speech/);
});

test("capture: role and epistemic are filterable on the conversation vector index", () => {
  const spec = collections.find(c => c.name === "conversation_turns");
  const vector = spec.searchIndexes.find(s => s.type === "vectorSearch");
  const filters = vector.definition.fields.filter(f => f.type === "filter").map(f => f.path);
  for (const path of ["householdId", "subjectId", "role", "epistemic", "redacted"]) {
    assert.ok(filters.includes(path), `${path} must be a pre-filter, not a post-filter`);
  }
});

test("capture: evidenceFromTurns keeps only sourced patient speech", () => {
  const { turn: patient } = buildPatientTurn(scope, { sessionId: "ws1", seq: 1, text: "Sarah came." }, now);
  const companion = buildCompanionTurn(scope, { sessionId: "ws1", seq: 2, text: "She did.", model: { name: "m" } }, now);
  const redacted = { ...patient, _id: "turn_ws1_000003", redacted: true };
  const unsourced = { ...patient, _id: "turn_ws1_000004", sourceId: null };
  const usable = evidenceFromTurns([patient, companion, redacted, unsourced]);
  assert.equal(usable.length, 1);
  assert.equal(usable[0].role, "patient");
});

test("capture: a session is a durable record with zeroed signal counters", () => {
  const session = buildConversationSession(scope, {
    sessionId: "ws1", channel: "voice", initiatedBy: "patient", consentRef: "consent_v2"
  }, now);
  assert.equal(session._id, "ws1", "shares its id with the volatile working_sessions scratchpad");
  assert.equal(session.turnCount, 0);
  assert.equal(session.summaryEpisodeId, null);
  for (const value of Object.values(session.signals)) assert.equal(value, 0);
  assert.equal(session.endedAt, null);
});

// ─────────────── inference quarantine: stored, not speakable ─────────────────

test("inference: visibility and calibration are single-valued by design", () => {
  const spec = collections.find(c => c.name === "inferences").validator.$jsonSchema;
  assert.deepEqual(spec.properties.visibility.enum, ["caregiver_only"],
                   "there must be no patient-visible inference");
  assert.deepEqual(spec.properties.calibration.enum, ["uncalibrated"],
                   "confidence must never be presentable as a probability of truth");
  assert.ok(spec.required.includes("basis"));
  assert.equal(spec.properties.basis.minItems, 1);
});

test("inference: a stored inference starts inferred, quarantined and evidence-linked", () => {
  const inference = buildInference(scope, {
    inferenceType: "routine_candidate",
    claim: { label: "Afternoon tea", rrule: "FREQ=WEEKLY;BYDAY=TH" },
    confidence: 0.72,
    basis: [{ store: "episodic", collection: "conversation_turns", id: "turn_ws1_000004" }],
    turnId: "turn_ws1_000004"
  }, now);
  assert.equal(inference.epistemicStatus, "inferred");
  assert.equal(inference.visibility, "caregiver_only");
  assert.equal(inference.calibration, "uncalibrated");
  assert.equal(inference.promotion.state, "none");
  assert.equal(inference.observationCount, 1);
  assert.equal(inference.confidence, 0.72);
});

test("inference: an inference that cannot name its basis cannot be written", () => {
  assert.throws(() => buildInference(scope, {
    inferenceType: "topic", claim: { topic: "garden" }, basis: []
  }, now), /must name what it was derived from/);
});

test("inference: the system cannot mark its own inference confirmed", () => {
  assert.throws(() => buildInference(scope, {
    inferenceType: "topic", claim: {}, basis: [{ store: "working", id: "wm1" }],
    epistemicStatus: "caregiver_confirmed"
  }, now), /Only a caregiver/);
  assert.throws(() => buildInference(scope, {
    inferenceType: "topic", claim: {}, basis: [{ store: "working", id: "wm1" }],
    epistemicStatus: "caregiver_rejected"
  }, now), /Only a caregiver/);
});

test("inference: clinical-adjacent types never receive a TTL, low-stakes ones do", () => {
  const symptom = buildInference(scope, {
    inferenceType: "symptom_signal", claim: { code: "agitation" },
    basis: [{ store: "episodic", id: "turn_1" }]
  }, now);
  assert.equal(symptom.expiresAt, undefined, "a symptom signal must not silently vanish");

  const intent = buildInference(scope, {
    inferenceType: "intent", claim: { intent: "ask_visit" },
    basis: [{ store: "working", id: "wm1" }]
  }, now);
  assert.ok(intent.expiresAt instanceof Date);
  assert.equal(+intent.expiresAt - +now, INFERENCE_TTL_DAYS.intent * 86400000);

  for (const type of ["routine_candidate", "preference_candidate", "relationship_candidate",
                      "symptom_signal", "contradiction_candidate"]) {
    assert.equal(INFERENCE_TTL_DAYS[type], undefined, `${type} must not be TTL'd`);
  }
});

test("inference: re-observation reinforces one record instead of duplicating", () => {
  const input = {
    inferenceType: "routine_candidate", claim: { label: "Afternoon tea" },
    basis: [{ store: "episodic", id: "turn_1" }]
  };
  const a = buildInference(scope, input, now);
  const b = buildInference(scope, { ...input, basis: [{ store: "episodic", id: "turn_2" }] },
                           new Date(+now + 86400000));
  assert.equal(a._id, b._id, "the same claim is one record");

  const upsert = inferenceUpsert(scope, input, now);
  assert.equal(upsert.options.upsert, true);
  assert.deepEqual(upsert.update.$inc, { observationCount: 1 });
  assert.ok(upsert.update.$addToSet.basis, "each observation adds its own basis");
  assert.equal(upsert.update.$set.epistemicStatus, "inferred");

  const crossing = inferenceUpsert(scope, { ...input, observationCountSoFar: CORROBORATION_THRESHOLD - 1 }, now);
  assert.equal(crossing.update.$set.epistemicStatus, "corroborated",
               "repetition changes the word, not the truth value");
});

test("inference: a claimDigest uniqueness index backs the dedupe", () => {
  const spec = collections.find(c => c.name === "inferences");
  const unique = spec.indexes.find(i => i.options?.unique);
  assert.deepEqual(unique.keys,
    { householdId: 1, subjectId: 1, inferenceType: 1, claimDigest: 1 });
});

test("inference: promotion requires corroboration and a promotable type", () => {
  const inference = buildInference(scope, {
    inferenceType: "routine_candidate", claim: { label: "Afternoon tea" },
    basis: [{ store: "episodic", id: "turn_1" }]
  }, now);

  assert.throws(() => proposeInference(scope, { ...inference, observationCount: 1 }, now),
                /independent observations/);

  const proposed = proposeInference(scope, { ...inference, observationCount: CORROBORATION_THRESHOLD }, now);
  assert.equal(proposed.update.$set["promotion.state"], "proposed");
  assert.equal(proposed.update.$set["promotion.targetCollection"], "semantic_nodes");
  assert.equal(proposed.filter["promotion.state"], "none", "a second proposal is a no-op");

  assert.throws(() => proposeInference(scope,
    { ...inference, inferenceType: "intent", observationCount: 9 }, now),
    /diagnostic signal, not a promotable claim/);
});

test("inference: only the listed types can ever reach a real store", () => {
  assert.deepEqual(Object.keys(PROMOTABLE).sort(), [
    "contradiction_candidate", "preference_candidate", "relationship_candidate",
    "routine_candidate", "symptom_signal"
  ]);
  for (const type of ["intent", "topic", "orientation_signal", "affect_signal", "retrieval_miss"]) {
    assert.equal(PROMOTABLE[type], undefined, `${type} must stay a diagnostic`);
  }
});

test("inference: rejection needs a named caregiver and is terminal", () => {
  const inference = buildInference(scope, {
    inferenceType: "preference_candidate", claim: { label: "dislikes the radio" },
    basis: [{ store: "episodic", id: "turn_1" }]
  }, now);
  assert.throws(() => rejectInference(scope, inference, {}, "wrong", now), /named caregiver/);
  const rejected = rejectInference(scope, inference, { id: "carer_jane" }, "She likes it on in the mornings.", now);
  assert.equal(rejected.update.$set.epistemicStatus, "caregiver_rejected");
  assert.equal(rejected.update.$set["promotion.decidedBy"], "carer_jane");
});

test("inference: the review queue is a caregiver-only view", () => {
  const view = views.find(v => v.name === "inference_review_queue");
  assert.ok(view);
  assert.equal(view.viewOn, "inferences");
  assert.equal(view.pipeline[0].$match["promotion.state"], "proposed");

  const query = inferenceReviewQuery(scope);
  assert.equal(query.collection, "inference_review_queue");
  assert.equal(query.audience, "caregiver");
});

test("append-only: the permitted mutations are named and narrow", () => {
  for (const name of ["conversation_turns", "conversation_sessions", "inferences", "care_alerts"]) {
    assert.ok(Array.isArray(APPEND_ONLY[name]), `${name} must declare its mutable fields`);
    assert.ok(APPEND_ONLY[name].length, `${name} declares no mutable fields`);
  }
  // the fields that make a record trustworthy are not in the mutable set
  assert.ok(!APPEND_ONLY.conversation_turns.includes("text"), "a turn's text is immutable");
  assert.ok(!APPEND_ONLY.conversation_turns.includes("sourceId"));
  assert.ok(!APPEND_ONLY.conversation_turns.includes("epistemic"));
  assert.ok(!APPEND_ONLY.conversation_turns.includes("model"));
  assert.ok(!APPEND_ONLY.inferences.includes("claim"), "an inference's claim is immutable");
  assert.ok(!APPEND_ONLY.inferences.includes("visibility"));
  assert.ok(!APPEND_ONLY.inferences.includes("calibration"));
});

test("helpers: gist, recurrence buckets and deterministic ids", () => {
  assert.equal(firstClause("Sarah visited. They had tea."), "Sarah visited.");
  assert.equal(firstClause("no terminator here"), "no terminator here");
  assert.ok(firstClause("x".repeat(400), 280).endsWith("…"));

  assert.equal(recurrenceHash({ what: "Chapel service", place: "St Mary's",
                                eventStart: new Date("2026-10-20T09:00:00Z") }),
               "chapel_service|st_mary_s|morning");
  assert.equal(recurrenceHash({ what: null, place: "x", eventStart: now }), null);

  assert.equal(deterministicId("x", scope, "a"), deterministicId("x", scope, "a"));
  assert.notEqual(deterministicId("x", scope, "a"),
                  deterministicId("x", { ...scope, subjectId: "other" }, "a"),
                  "scope must be part of every deterministic id");
});
