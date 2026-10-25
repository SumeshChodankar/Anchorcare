// Reference retrieval pipelines for the cognitive memory schema.
// Pure builders and pure scoring functions: no database handle, so they are unit
// testable without Atlas. Execution belongs in engram-retrieval/src/store.js.
//
// Spec: docs/ATLAS-MEMORY-SCHEMA.md §12
//
// Conventions carried over from engram-retrieval/src/search.js:
//   * filters go INSIDE $vectorSearch (pre-filter). Post-filtering can return an
//     empty set while approved episodes exist — a false "I don't remember that".
//   * no $project inside a $rankFusion branch; projection comes after fusion/rerank.
//   * $graphLookup does not inherit the outer $match: scope MUST be repeated in
//     restrictSearchWithMatch.

import { SLOT_HALF_LIFE, WORKING_CAPACITY } from "./collections.js";

const APPROVED_CURRENT = { reviewStatus: "approved", isCurrent: true };

// ───────────────────────────── shared filter helpers ─────────────────────────

/** Mongo-query form of the episode read-path filter (invariants I3, I4). */
export function episodeFilter(scope, options = {}) {
  const filter = { ...scope, ...APPROVED_CURRENT };
  if (options.from || options.to) {
    filter.eventStart = {
      ...(options.from ? { $gte: options.from } : {}),
      ...(options.to ? { $lt: options.to } : {})
    };
  }
  if (options.personId) filter.semanticRefs = options.personId;
  if (options.chapterId) filter.chapterId = options.chapterId;
  if (options.excludeSensitive) filter.sensitivity = "normal";
  return filter;
}

/** Atlas Search `compound.filter` form of the same predicate. */
export function tokenFilters(scope, options = {}) {
  const filter = [
    ...Object.entries(scope).map(([path, value]) => ({ equals: { path, value } })),
    { equals: { path: "reviewStatus", value: "approved" } },
    { equals: { path: "isCurrent", value: true } }
  ];
  if (options.from || options.to) {
    filter.push({ range: {
      path: "eventStart",
      ...(options.from ? { gte: options.from } : {}),
      ...(options.to ? { lt: options.to } : {})
    } });
  }
  if (options.personId) filter.push({ equals: { path: "semanticRefs", value: options.personId } });
  if (options.chapterId) filter.push({ equals: { path: "chapterId", value: options.chapterId } });
  if (options.excludeSensitive) filter.push({ equals: { path: "sensitivity", value: "normal" } });
  return filter;
}

// ───────────────────────────── episodic recall ───────────────────────────────

export function episodicTextBranch(cfg, scope, query, options = {}) {
  return [
    { $search: { index: cfg.searchIndex, compound: {
      must: [{ text: { query, path: "searchText" } }],
      filter: tokenFilters(scope, options)
    } } },
    { $limit: options.branchLimit ?? 20 }
  ];
}

export function episodicSemanticBranch(cfg, scope, query, options = {}) {
  const limit = options.branchLimit ?? 20;
  return [
    { $vectorSearch: {
      index: cfg.vectorIndex,
      path: cfg.embeddingMode === "auto" ? "searchText" : "embedding",
      ...(cfg.embeddingMode === "auto" ? { query: { text: query } } : { queryVector: options.queryVector }),
      numCandidates: limit * 20,
      limit,
      filter: episodeFilter(scope, options)
    } }
  ];
}

/**
 * Visual branch. Requires an application-side multimodal query vector; when one is
 * absent the branch is omitted entirely rather than degraded silently.
 */
export function episodicVisualBranch(cfg, scope, options = {}) {
  if (!options.visualQueryVector) return null;
  const limit = options.branchLimit ?? 20;
  return [
    { $vectorSearch: {
      index: cfg.visualVectorIndex || "episodes_visual",
      path: "visualEmbedding",
      queryVector: options.visualQueryVector,
      numCandidates: limit * 20,
      limit,
      filter: episodeFilter(scope, options)
    } }
  ];
}

/**
 * One aggregation: text + semantic (+ visual) candidate generation, native rank
 * fusion, canonical-field re-match, optional native rerank, then projection.
 */
export function episodicRecallPipeline(cfg, scope, query, options = {}) {
  const pipelines = {
    text: episodicTextBranch(cfg, scope, query, options),
    semantic: episodicSemanticBranch(cfg, scope, query, options)
  };
  const weights = { text: 1, semantic: 1 };

  const visual = episodicVisualBranch(cfg, scope, options);
  if (visual) { pipelines.visual = visual; weights.visual = 0.6; }

  const pipeline = [
    { $rankFusion: { input: { pipelines }, combination: { weights }, scoreDetails: true } },
    { $limit: options.fusionLimit ?? 20 },
    // Canonical re-match: fusion branches are candidate generators, not authorities.
    { $match: { ...episodeFilter(scope, options), searchText: { $type: "string" } } }
  ];

  if (cfg.nativeRerank) {
    pipeline.push({ $rerank: {
      query: { text: query },
      path: "searchText",
      numDocsToRerank: options.fusionLimit ?? 20,
      model: cfg.nativeRerankModel || "rerank-2.5"
    } });
  }

  pipeline.push({ $project: { embedding: 0, visualEmbedding: 0 } });
  return pipeline;
}

const DAY_MS = 86400000;

/** Recency kernel in [0,1]; 30-day half-life by default. */
export function recencyKernel(eventStart, now, halfLifeDays = 30) {
  const days = Math.max(0, (+now - +eventStart) / DAY_MS);
  return 2 ** (-days / halfLifeDays);
}

/**
 * Final ordering for ANSWERING a question. Deliberately excludes estimatedRetention:
 * retention ranks proactive rehearsal only (§12.7). Mixing them would answer with a
 * worse-matching memory because it happened to need practice.
 */
export function rankForAnswer(grounded, now, { boostIds = [] } = {}) {
  const n = Math.max(1, grounded.length);
  return grounded
    .map((g, index) => {
      const fusion = 1 - index / n;                       // normalized fusion rank
      const salience = g.doc.salience ?? 0.5;
      const recency = recencyKernel(g.doc.eventStart, now);
      const focus = (g.doc.semanticRefs || []).some(id => boostIds.includes(id)) ? 1 : 0;
      let score = 0.55 * fusion + 0.20 * salience + 0.15 * recency + 0.10 * focus;
      if (g.doc.sensitivity && g.doc.sensitivity !== "normal") score *= 0.8;
      return { ...g, score };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * Candidates are not answers. Re-reads canonical records, requires sources, and
 * drops anything whose media or transcript has not been inspected (I2, I3).
 */
export async function groundCandidates(db, scope, candidates) {
  const grounded = [];
  for (const candidate of candidates) {
    const doc = await db.collection("episodes").findOne({ ...scope, _id: candidate._id, ...APPROVED_CURRENT });
    if (!doc) continue;                                   // corrected between search and read
    if (!Array.isArray(doc.sourceIds) || !doc.sourceIds.length) continue;
    const sources = await db.collection("sources")
      .find({ ...scope, _id: { $in: doc.sourceIds } }).toArray();
    if (!sources.length) continue;
    if (sources.some(s => s.inspection?.required && !s.inspection?.at)) continue;
    grounded.push({ doc, sources, scoreDetails: candidate.scoreDetails ?? null, stale: isVectorStale(doc) });
  }
  return grounded;
}

/** True when embeddingMeta.inputDigest no longer matches searchText (post-correction drift). */
export function isVectorStale(doc, digestFn = null) {
  if (!doc?.embeddingMeta?.inputDigest || !digestFn) return false;
  return digestFn(doc.searchText) !== doc.embeddingMeta.inputDigest;
}

// ───────────────────────────── semantic traversal ────────────────────────────

/**
 * Bounded graph traversal. `scope` is repeated inside restrictSearchWithMatch
 * because $graphLookup does not inherit the outer $match — omitting it is a
 * cross-tenant leak.
 */
export function semanticExpandPipeline(scope, seedIds, { maxDepth = 2, edgeTypes = null, maxEdges = 40 } = {}) {
  if (maxDepth < 1 || maxDepth > 2) throw new RangeError("maxDepth must be 1 or 2");
  return [
    { $match: { ...scope, _id: { $in: seedIds }, ...APPROVED_CURRENT } },
    { $graphLookup: {
      from: "semantic_edges",
      startWith: "$_id",
      connectFromField: "toId",
      connectToField: "fromId",
      as: "reachable",
      maxDepth: maxDepth - 1,
      depthField: "depth",
      restrictSearchWithMatch: {
        ...scope,
        reviewStatus: "approved",
        isCurrent: true,
        status: { $in: ["current", "historical"] },   // 'disputed' is shown, never traversed
        ...(edgeTypes ? { edgeType: { $in: edgeTypes } } : {})
      }
    } },
    { $addFields: { reachable: { $slice: [
      { $sortArray: { input: "$reachable", sortBy: { depth: 1, weight: -1 } } }, maxEdges
    ] } } },
    { $lookup: {
      from: "semantic_nodes",
      localField: "reachable.toId",
      foreignField: "_id",
      as: "neighbours",
      pipeline: [
        { $match: { ...scope, ...APPROVED_CURRENT } },
        { $project: { label: 1, nodeType: 1, lifeStatus: 1, sensitivity: 1,
                      disclosure: 1, aliases: 1, sourceIds: 1, "activation.score": 1 } }
      ]
    } },
    { $project: { embedding: 0, searchText: 0 } }
  ];
}

/** Fast path for "who is this person to me?" — one document, no traversal. */
export function hotEdgesQuery(scope, nodeId) {
  return {
    filter: { ...scope, _id: nodeId, ...APPROVED_CURRENT },
    projection: { label: 1, nodeType: 1, lifeStatus: 1, sensitivity: 1, disclosure: 1,
                  aliases: 1, hotEdges: 1, sourceIds: 1 }
  };
}

// ───────────────────────── autobiographical grounding ────────────────────────

/** Resolves a fuzzy time phrase to a chapter. fuzzyPhrases is boosted over narrative. */
export function chapterSearchPipeline(scope, query, { limit = 3 } = {}) {
  return [
    { $search: { index: "chapters_text", compound: {
      should: [
        { text: { query, path: "fuzzyPhrases", score: { boost: { value: 3 } } } },
        { text: { query, path: ["label", "narrative"] } }
      ],
      filter: [
        ...Object.entries(scope).map(([path, value]) => ({ equals: { path, value } })),
        { equals: { path: "reviewStatus", value: "approved" } }
      ],
      minimumShouldMatch: 1
    } } },
    { $limit: limit },
    { $project: { embedding: 0 } }
  ];
}

export function currentPreferencesFilter(scope, now) {
  return {
    ...scope, isCurrent: true, reviewStatus: "approved",
    validFrom: { $lte: now },
    $or: [{ validTo: null }, { validTo: { $gt: now } }]
  };
}

export function activeConstraintsFilter(scope, now) {
  return {
    ...scope, isCurrent: true,
    effectiveFrom: { $lte: now },
    $or: [{ effectiveTo: null }, { effectiveTo: { $gt: now } }]
  };
}

// ───────────────────────────── working memory ────────────────────────────────

/** Decay is computed at read time and never written back (§12.1). */
export function effectiveActivation(slot, now) {
  const halfLife = slot.decayHalfLifeSeconds || SLOT_HALF_LIFE[slot.slotType] || 900;
  const ageSeconds = Math.max(0, (+now - +slot.lastTouchedAt) / 1000);
  return slot.activation * 2 ** (-ageSeconds / halfLife);
}

export function liveSlots(slots, now, { floor = 0.15 } = {}) {
  return slots
    .map(slot => ({ ...slot, effective: effectiveActivation(slot, now) }))
    .filter(slot => slot.effective >= floor || slot.slotType === "safety_flag")
    .sort((a, b) => b.effective - a.effective);
}

/** Slots over capacity, lowest effective activation first. safety_flag is exempt. */
export function slotsToEvict(slots, now, capacity = WORKING_CAPACITY) {
  const evictable = slots.filter(s => s.slotType !== "safety_flag")
    .map(slot => ({ ...slot, effective: effectiveActivation(slot, now) }))
    .sort((a, b) => b.effective - a.effective);
  return evictable.slice(capacity);
}

// ───────────────────────────── disclosure gate ───────────────────────────────

export const DEFAULT_DEFER = "Let me check that with Jane and come back to you.";

/** Does an absolute constraint cover this fact? Phrase and node matching only — no inference. */
export function constraintCovers(constraint, fact) {
  const rule = constraint.rule || {};
  if (Array.isArray(rule.nodeIds) && fact.nodeId && rule.nodeIds.includes(fact.nodeId)) return true;
  if (Array.isArray(rule.phrases) && typeof fact.text === "string") {
    const haystack = fact.text.toLowerCase();
    if (rule.phrases.some(p => haystack.includes(String(p).toLowerCase()))) return true;
  }
  if (rule.substance && typeof fact.text === "string") {
    return fact.text.toLowerCase().includes(String(rule.substance).toLowerCase());
  }
  return false;
}

/**
 * Resolution order: absolute constraint ▸ known loss ▸ node disclosure ▸ lifeStatus ▸ plain.
 * Deliberately not a model decision. `mayElaborate: false` means the generator gets the
 * caregiver's exact sentence and no latitude to extend it.
 */
export function resolveDisclosure(facts, identity = {}, constraints = []) {
  const absolutes = constraints.filter(c => c.severity === "absolute");
  const losses = identity.knownLosses || [];
  const out = [];

  for (const fact of facts) {
    if (absolutes.some(c => constraintCovers(c, fact))) continue;      // omit entirely

    const loss = fact.nodeId ? losses.find(l => l.nodeId === fact.nodeId) : null;
    const node = fact.node || null;
    const policy = loss?.disclosurePolicy
      || (node && node.sensitivity !== "normal" ? node.disclosure?.policy : null)
      || "state_plainly";

    if (policy === "withhold") continue;

    if (policy === "defer_to_caregiver") {
      out.push({ mode: "script", text: loss?.script || node?.disclosure?.script || DEFAULT_DEFER,
                 mayElaborate: false, cite: fact.sourceIds || [] });
      continue;
    }
    if (policy === "redirect") {
      out.push({ mode: "redirect", comfort: (identity.comfortTopics || [])[0] || null, mayElaborate: false });
      continue;
    }
    out.push({
      mode: "state",
      fact,
      tense: node && ["former", "deceased"].includes(node.lifeStatus) ? "past" : "present",
      proactive: false,
      mayElaborate: true,
      cite: fact.sourceIds || []
    });
  }
  return out;
}

// ───────────────────────────── procedural gate ───────────────────────────────

/** Returns the vetoing constraint, or null. Absolute constraints cannot be overridden. */
export function vetoFor(procedure, constraints = []) {
  for (const c of constraints) {
    const rule = c.rule || {};
    if (Array.isArray(rule.toolIds) && procedure.steps?.some(s => rule.toolIds.includes(s.toolId))) return c;
    if (Array.isArray(rule.procedureIds) && rule.procedureIds.includes(procedure.procedureId)) return c;
    if (c.constraintType === "communication_restriction" && rule.channels
        && procedure.steps?.some(s => rule.channels.includes(s.args?.channel))) return c;
  }
  return null;
}

// ─────────────────── conversation history (real-time capture) ────────────────

/**
 * The only conversation predicate the companion's retrieval path may use.
 *
 * A companion turn is `epistemic: "generated"`. If the companion could search its
 * own past output, a sentence it once improvised would come back as a memory, be
 * cited, and harden into fact — the confabulation loop that makes a cognitive
 * prosthetic actively dangerous. Her own words are evidence; its words are not.
 */
export const PATIENT_ONLY = Object.freeze({ role: "patient", epistemic: "observed", redacted: false });

/** Read-only view the companion credential has `find` on. It has none on the base collection. */
export const PATIENT_UTTERANCE_VIEW = "patient_utterances";

/**
 * Picks which collection a conversation read goes to, so the choice is explicit
 * and testable rather than implicit in a caller's filter.
 * `audience: "caregiver"` is the only way to reach generated turns.
 */
export function conversationReadTarget({ audience = "companion", includeGenerated = false } = {}) {
  if (!includeGenerated) return { collection: PATIENT_UTTERANCE_VIEW, filter: {} };
  if (audience !== "caregiver") {
    throw new Error("Generated turns are caregiver-only. The companion may not read its own output back as history.");
  }
  return { collection: "conversation_turns", filter: {} };
}

/** Recent turns for context. Defaults to the patient-only view. */
export function recentTurnsQuery(scope, sessionId, { limit = 20, audience = "companion", includeGenerated = false } = {}) {
  const target = conversationReadTarget({ audience, includeGenerated });
  return {
    collection: target.collection,
    filter: { ...scope, ...(sessionId ? { sessionId } : {}) },
    sort: { seq: -1 },
    limit
  };
}

/**
 * Semantic search over what the person has said across sessions ("when did she last
 * mention the pier?"). The PATIENT_ONLY filter is applied unconditionally and a
 * caller cannot widen it.
 */
export function conversationSearchPipeline(cfg, scope, query, options = {}) {
  if (options.role && options.role !== "patient") {
    throw new Error("conversationSearchPipeline only searches observed patient speech");
  }
  const limit = options.branchLimit ?? 20;
  const filter = { ...scope, ...PATIENT_ONLY };
  if (options.from || options.to) {
    filter.startedAt = {
      ...(options.from ? { $gte: options.from } : {}),
      ...(options.to ? { $lt: options.to } : {})
    };
  }

  const tokens = [
    ...Object.entries(scope).map(([path, value]) => ({ equals: { path, value } })),
    { equals: { path: "role", value: "patient" } },
    { equals: { path: "epistemic", value: "observed" } },
    { equals: { path: "redacted", value: false } }
  ];
  if (filter.startedAt) {
    tokens.push({ range: { path: "startedAt",
      ...(options.from ? { gte: options.from } : {}),
      ...(options.to ? { lt: options.to } : {}) } });
  }

  return [
    { $rankFusion: {
      input: { pipelines: {
        text: [
          { $search: { index: "conversation_text", compound: {
            must: [{ text: { query, path: "text" } }], filter: tokens } } },
          { $limit: limit }
        ],
        semantic: [
          { $vectorSearch: {
            index: "conversation_auto", path: "text", query: { text: query },
            numCandidates: limit * 20, limit, filter } }
        ]
      } },
      combination: { weights: { text: 1, semantic: 1 } },
      scoreDetails: true
    } },
    { $limit: limit },
    // Re-asserted after fusion: a filter is not a guarantee until the output is checked.
    { $match: filter },
    { $project: { audio: 0, model: 0, groundedOn: 0 } }
  ];
}

/**
 * Turns usable as evidence: observed patient speech with a write-once source behind
 * it. Everything else is dropped rather than downweighted — there is no confidence
 * level at which the companion's own output becomes a citation.
 */
export function evidenceFromTurns(turns = []) {
  return turns.filter(t =>
    t.role === "patient" && t.epistemic === "observed" && !t.redacted && typeof t.sourceId === "string");
}

/**
 * Guard for a generated turn's explainability record. Throws rather than filtering,
 * because a response that believes it was grounded in its own prior output has a bug
 * upstream that silent filtering would hide.
 */
export function assertNotSelfCitation(groundedOn = []) {
  const offenders = groundedOn.filter(ref =>
    ref.role === "evidence" && ref.collection === "conversation_turns" && ref.epistemic === "generated");
  if (offenders.length) {
    throw new Error(`Generated turns cited as evidence: ${offenders.map(o => o.id).join(", ")}`);
  }
  const inferred = groundedOn.filter(ref => ref.collection === "inferences" && ref.role === "evidence");
  if (inferred.length) {
    throw new Error(`Inferences cited as evidence: ${inferred.map(o => o.id).join(", ")}. Promote it first, or cite it as context.`);
  }
  return groundedOn;
}

/** Caregiver-only. No companion read path queries `inferences` at all. */
export function inferenceReviewQuery(scope, { inferenceType = null, limit = 50 } = {}) {
  return {
    collection: "inference_review_queue",
    filter: { ...scope, ...(inferenceType ? { inferenceType } : {}) },
    sort: { observationCount: -1, lastObservedAt: -1 },
    limit,
    audience: "caregiver"
  };
}

/** Candidate ordering for policy selection: subject override beats household default. */
export function procedureCandidateQuery(scope, triggerKind) {
  return {
    filter: {
      householdId: scope.householdId,
      subjectId: { $in: [scope.subjectId, "*"] },
      "trigger.kind": triggerKind,
      "approval.status": "active"
    },
    sort: { subjectId: -1, riskTier: -1, version: -1 }
  };
}
