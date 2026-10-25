// Declarative registry for the Anchorcare cognitive memory schema.
// Single source of truth for collections, $jsonSchema validators, regular indexes,
// Atlas Search / Vector Search index definitions, and time-series options.
//
// Spec: docs/ATLAS-MEMORY-SCHEMA.md
// Consumed by: db/provision.js (create/ensure), db/reconcile.js (cache checks).
//
// This file is ADDITIVE to engram-retrieval/scripts/indexes.js, which stays
// authoritative for the collections it already provisions. Nothing here drops or
// redefines an existing index or search index.

const H = "householdId";
const S = "subjectId";
const scope = { [H]: 1, [S]: 1 };

/** Scope fields every document carries (invariant I1). */
export const SCOPE_FIELDS = [H, S];

/** Store taxonomy, used by provision.js output and by memory_links validation. */
export const STORES = ["working", "episodic", "semantic", "procedural", "autobiographical", "safety"];

/** Collections that must never carry a TTL index (invariant I6). Asserted at provision time. */
export const NO_TTL = [
  // Device link: every one of these carries an `expiresAt` field for business logic,
  // which makes them TTL landmines. A TTL index added "to clean up" would silently
  // delete emergency assistance requests and the record of what was pushed to a
  // caregiver's phone. mobile_pairings is the deliberate exception (see its spec).
  "mobile_sos", "mobile_sos_gates", "mobile_commands", "mobile_devices",
  "mobile_push", "mobile_push_attempts", "integration_requests",
  "conversation_sessions", "conversation_turns",
  "episodes", "sources", "semantic_nodes", "semantic_edges", "memory_links",
  "identity_core", "life_chapters", "preferences", "personal_records", "daily_logs",
  "safety_constraints", "care_alerts", "medication_responses", "consent_records",
  "deletion_requests", "audit_events", "procedures", "procedure_runs",
  "memory_state", "recall_attempts", "rehearsal_sets", "practice_slots", "symptom_ts"
];

/** Collections the application credential may insert into and read, but not update or remove. */
export const WRITE_ONCE = [
  "sources", "audit_events", "medication_responses", "recall_attempts",
  "procedure_runs", "consent_records", "procedures", "rehearsal_sets"
];

/**
 * Append-only: inserts plus a named, narrow set of permitted field updates.
 * Anything not listed here is not updatable by the application at all.
 */
export const APPEND_ONLY = Object.freeze({
  care_alerts: ["transitions", "state", "notifications", "acknowledgedBy", "acknowledgedAt", "resolution"],
  conversation_turns: ["caregiverAnnotation", "redacted", "redactionRef", "inferenceIds", "endedAt", "latency"],
  conversation_sessions: ["endedAt", "durationMs", "turnCount", "patientTurnCount", "signals",
                          "summaryEpisodeId", "closeReason", "procedureRunIds", "modelRefs", "redacted"],
  inferences: ["epistemicStatus", "confidence", "observationCount", "lastObservedAt",
               "promotion", "contradicts", "basis", "expiresAt"]
});

/**
 * Read-only views, created by provision.js. A view plus a role grant is how this
 * schema gets row-level read control out of MongoDB: the companion credential has
 * `find` on `patient_utterances` and NO `find` on `conversation_turns`, so it
 * physically cannot read back its own generated output and treat it as evidence.
 */
export const views = [
  {
    name: "patient_utterances",
    viewOn: "conversation_turns",
    pipeline: [
      { $match: { role: "patient", epistemic: "observed", redacted: { $ne: true } } },
      { $project: {
        householdId: 1, subjectId: 1, sessionId: 1, seq: 1,
        text: 1, startedAt: 1, sourceId: 1,
        "transcript.confidence": 1, "transcript.isFinal": 1, "transcript.engine": 1
      } }
    ],
    note: "What the person actually said. The only conversation history the companion may read."
  },
  {
    name: "inference_review_queue",
    viewOn: "inferences",
    pipeline: [
      { $match: { "promotion.state": "proposed", epistemicStatus: { $in: ["inferred", "corroborated"] } } },
      { $sort: { observationCount: -1, lastObservedAt: -1 } }
    ],
    note: "Caregiver console inbox. Not readable by the companion credential."
  }
];

const str = (extra = {}) => ({ bsonType: "string", ...extra });
const num = (extra = {}) => ({ bsonType: ["double", "int", "long"], ...extra });
const unit = () => ({ bsonType: ["double", "int", "null"], minimum: 0, maximum: 1 });
const date = () => ({ bsonType: "date" });
const dateOrNull = () => ({ bsonType: ["date", "null"] });
const strOrNull = () => ({ bsonType: ["string", "null"] });
const arrOf = (items, extra = {}) => ({ bsonType: "array", items, ...extra });
const enumOrNull = values => ({ enum: [...values, null] });

/** Wraps a properties map into a strict $jsonSchema with the scope fields required. */
function schema(properties, { required = [], closed = false } = {}) {
  return {
    $jsonSchema: {
      bsonType: "object",
      required: [...SCOPE_FIELDS, ...required],
      properties: { _id: {}, [H]: str(), [S]: str(), ...properties },
      ...(closed ? { additionalProperties: false } : {})
    }
  };
}

export const collections = [
  // ───────────────────────────── WORKING MEMORY ─────────────────────────────
  {
    name: "working_sessions",
    store: "working",
    note: "Conversation frame. TTL-expired; never a record of the patient's life.",
    validator: schema({
      channel: { enum: ["voice", "phone_pwa", "console", "device"] },
      startedAt: date(),
      lastTurnAt: date(),
      turnCount: num({ minimum: 0 }),
      attentionFocus: {
        bsonType: ["object", "null"],
        properties: {
          topic: strOrNull(), personIds: arrOf(str()), placeId: strOrNull(),
          chapterId: strOrNull(), since: dateOrNull()
        }
      },
      orientationSignals: {
        bsonType: "object",
        description: "Reported signal counts only. Never an inferred cognitive state.",
        properties: {
          repeatedQuestionCount: num({ minimum: 0 }),
          timeConfusionReports: num({ minimum: 0 }),
          placeConfusionReports: num({ minimum: 0 }),
          lastSignalAt: dateOrNull()
        }
      },
      affect: {
        bsonType: ["object", "null"],
        required: ["basis"],
        properties: {
          reportedValence: { bsonType: ["double", "int", "null"] },
          reportedArousal: { bsonType: ["double", "int", "null"] },
          basis: { enum: ["self_report", "caregiver_report", "unknown"] },
          at: dateOrNull()
        }
      },
      distressFlag: { bsonType: ["object", "null"] },
      activeProcedureId: strOrNull(),
      activeProcedureVersion: { bsonType: ["int", "null"] },
      pendingConfirmations: arrOf({ bsonType: "object" }),
      expiresAt: date(),
      closedAt: dateOrNull(),
      closeReason: strOrNull()
    }, { required: ["channel", "startedAt", "lastTurnAt", "expiresAt"] }),
    indexes: [
      { keys: { ...scope, channel: 1, lastTurnAt: -1 } },
      { keys: { expiresAt: 1 }, options: { expireAfterSeconds: 0, name: "ttl_expiresAt" } }
    ]
  },
  {
    name: "working_memory",
    store: "working",
    note: "Activation slots. Capacity 9 non-safety slots per session; decay computed at read.",
    validator: schema({
      sessionId: str(),
      slotType: {
        enum: ["percept", "goal", "topic", "unresolved_question", "salient_person", "safety_flag", "scratch_fact"]
      },
      content: str({ maxLength: 500 }),
      boundTo: arrOf({
        bsonType: "object", required: ["store", "id"],
        properties: { store: { enum: STORES }, id: str() }
      }),
      activation: { bsonType: ["double", "int"], minimum: 0, maximum: 1 },
      decayHalfLifeSeconds: num({ minimum: 1 }),
      reinforcementCount: num({ minimum: 0 }),
      provenance: {
        enum: ["patient_utterance", "caregiver_input", "retrieval", "device", "agent_inference"],
        description: "agent_inference slots may never be promoted or cited as evidence."
      },
      createdAt: date(),
      lastTouchedAt: date(),
      expiresAt: date()
    }, { required: ["sessionId", "slotType", "content", "activation", "decayHalfLifeSeconds", "provenance", "lastTouchedAt", "expiresAt"] }),
    indexes: [
      { keys: { ...scope, sessionId: 1, slotType: 1, lastTouchedAt: -1 } },
      { keys: { ...scope, sessionId: 1, activation: -1 } },
      { keys: { "boundTo.id": 1, ...scope }, options: { name: "boundTo_invalidation" } },
      { keys: { expiresAt: 1 }, options: { expireAfterSeconds: 0, name: "ttl_expiresAt" } }
    ]
  },
  {
    name: "active_tasks",
    store: "working",
    note: "Short-horizon intents. Sparse TTL: riskTier>=2 documents never receive expiresAt.",
    validator: schema({
      sessionId: strOrNull(),
      taskType: {
        enum: ["await_medication_response", "await_caregiver_approval", "deliver_prompt",
               "clarify", "escalate", "rehearsal_offer"]
      },
      status: { enum: ["pending", "in_progress", "blocked", "done", "expired", "superseded"] },
      riskTier: { bsonType: "int", minimum: 0, maximum: 3 },
      procedureId: strOrNull(),
      procedureVersion: { bsonType: ["int", "null"] },
      payload: { bsonType: "object" },
      dueAt: dateOrNull(),
      slaDeadlineAt: dateOrNull(),
      blockedBy: arrOf({ bsonType: "object" }),
      leaseToken: strOrNull(),
      leaseUntil: dateOrNull(),
      attempts: num({ minimum: 0 }),
      createdAt: date(),
      expiresAt: { bsonType: "date", description: "Written only for riskTier<=1 terminal tasks." }
    }, { required: ["taskType", "status", "riskTier", "createdAt"] }),
    indexes: [
      { keys: { ...scope, status: 1, dueAt: 1 } },
      { keys: { ...scope, taskType: 1, status: 1 } },
      { keys: { ...scope, riskTier: 1, slaDeadlineAt: 1 },
        options: { name: "sla_tier2", partialFilterExpression: { riskTier: { $gte: 2 } } } },
      { keys: { ...scope, leaseUntil: 1 },
        options: { name: "lease_recovery", partialFilterExpression: { status: "in_progress" } } },
      { keys: { expiresAt: 1 }, options: { expireAfterSeconds: 0, sparse: true, name: "ttl_expiresAt_sparse" } }
    ]
  },

  // ───────────────────────────── EPISODIC (additive) ─────────────────────────
  {
    name: "episodes",
    store: "episodic",
    existing: true,
    note: "EXISTING collection. Additive indexes only; no validator is installed so current writes keep working.",
    indexes: [
      { keys: { ...scope, reviewStatus: 1, isCurrent: 1, eventStart: -1 },
        options: { name: "companion_read_path",
                   partialFilterExpression: { reviewStatus: "approved", isCurrent: true } } },
      { keys: { ...scope, dedupeKey: 1 }, options: { unique: true, sparse: true, name: "dedupe_unique" } },
      { keys: { ...scope, chapterId: 1, eventStart: -1 }, options: { sparse: true } },
      { keys: { ...scope, semanticRefs: 1, eventStart: -1 } },
      { keys: { ...scope, recurrenceKey: 1, eventStart: -1 }, options: { sparse: true } },
      { keys: { ...scope, "consolidation.state": 1, recordedAt: 1 } },
      { keys: { ...scope, supersededBy: 1 }, options: { sparse: true } },
      { keys: { ...scope, sensitivity: 1, eventStart: -1 },
        options: { name: "sensitive_review", partialFilterExpression: { sensitivity: { $ne: "normal" } } } }
    ],
    searchIndexes: [
      {
        name: process.env.VISUAL_VECTOR_INDEX || "episodes_visual",
        type: "vectorSearch",
        definition: {
          fields: [
            { type: "vector", path: "visualEmbedding",
              numDimensions: Number(process.env.VISUAL_DIMENSIONS || 1024),
              similarity: "cosine", quantization: "scalar" },
            ...["householdId", "subjectId", "reviewStatus", "isCurrent", "sensitivity",
                "eventStart", "personIds", "chapterId", "semanticRefs"]
              .map(path => ({ type: "filter", path }))
          ]
        }
      }
    ]
  },
  {
    name: "sources",
    store: "episodic",
    existing: true,
    note: "EXISTING, write-once. Additive indexes for digest dedupe, derived sources and the inspection queue.",
    indexes: [
      { keys: { ...scope, recordedAt: -1 } },
      { keys: { ...scope, digest: 1 }, options: { unique: true, sparse: true, name: "digest_unique" } },
      { keys: { ...scope, derivedFrom: 1 }, options: { sparse: true } },
      { keys: { ...scope, "inspection.required": 1 },
        options: { name: "inspection_queue", partialFilterExpression: { "inspection.required": true } } }
    ]
  },
  {
    name: "memory_state",
    store: "episodic",
    existing: true,
    indexes: [
      { keys: { ...scope, episodeId: 1 }, options: { unique: true, name: "one_state_per_episode" } },
      { keys: { ...scope, suppressUntil: 1 }, options: { sparse: true } }
    ]
  },
  {
    name: "recall_attempts",
    store: "episodic",
    existing: true,
    indexes: [
      { keys: { ...scope, attemptId: 1 }, options: { unique: true, sparse: true, name: "attempt_idempotency" } },
      { keys: { ...scope, applied: 1 },
        options: { name: "unapplied_inspection", partialFilterExpression: { applied: false } } }
    ]
  },
  {
    name: "memory_images",
    store: "episodic",
    existing: true,
    note: "EXISTING (image-memory.ts). Bytes live in GridFS bucket engram_images.",
    indexes: [
      { keys: { ...scope, targetType: 1, targetId: 1, createdAt: -1 } },
      { keys: { ...scope, reviewStatus: 1 },
        options: { name: "image_inspection_queue", partialFilterExpression: { reviewStatus: "draft" } } }
    ]
  },
  {
    name: "memory_trace_ts",
    store: "episodic",
    kind: "timeseries",
    timeseries: { timeField: "at", metaField: "series", granularity: "hours" },
    expireAfterSeconds: 365 * 24 * 3600,
    note: "Samples of a DERIVED heuristic. Never read back as model input; authoritative state is memory_state.",
    indexes: [{ keys: { "series.episodeId": 1, at: -1 } }]
  },

  // ──────────────── REAL-TIME CAPTURE (observed) ────────────────────────────
  {
    name: "conversation_sessions",
    store: "episodic",
    note: "Durable record that a conversation happened. Shares its _id with the volatile working_sessions scratchpad. Never TTL'd.",
    validator: schema({
      channel: { enum: ["voice", "phone_pwa", "console", "device"] },
      initiatedBy: { enum: ["patient", "companion", "caregiver", "schedule"] },
      startedAt: date(),
      endedAt: dateOrNull(),
      durationMs: { bsonType: ["int", "long", "null"] },
      turnCount: num({ minimum: 0 }),
      patientTurnCount: num({ minimum: 0 }),
      procedureRunIds: arrOf(str()),
      summaryEpisodeId: { ...strOrNull(), description: "Draft episode written at close. Draft, like any other ingested claim." },
      signals: {
        bsonType: "object",
        description: "Counts of reported signals and system events. Never an inferred cognitive state.",
        properties: {
          repeatedQuestionCount: num({ minimum: 0 }),
          distressReports: num({ minimum: 0 }),
          safetyVetoes: num({ minimum: 0 }),
          escalations: num({ minimum: 0 }),
          scriptedDisclosures: num({ minimum: 0 }),
          retrievalFailures: num({ minimum: 0 })
        }
      },
      consentRef: strOrNull(),
      modelRefs: arrOf({ bsonType: "object" }),
      closeReason: enumOrNull(["patient_ended", "idle_timeout", "caregiver_ended", "error", "escalated"]),
      redacted: { bsonType: "bool" }
    }, { required: ["channel", "initiatedBy", "startedAt", "turnCount"] }),
    indexes: [
      { keys: { ...scope, startedAt: -1 } },
      { keys: { ...scope, channel: 1, startedAt: -1 } },
      { keys: { ...scope, endedAt: 1 }, options: { sparse: true, name: "open_sessions" } },
      { keys: { ...scope, "signals.escalations": 1, startedAt: -1 },
        options: { name: "escalating_sessions",
                   partialFilterExpression: { "signals.escalations": { $gte: 1 } } } }
    ]
  },
  {
    name: "conversation_turns",
    store: "episodic",
    note: [
      "Durable, append-only record of what was said, in both directions. This is the",
      "answer to 'what did it say to her at 3am?'. Mutable only for caregiver",
      "annotation and redaction. Never TTL'd: retention is consent-driven via",
      "Online Archive, not an index that silently deletes the audit trail.",
      "epistemic: 'observed' = we heard it; 'generated' = the companion produced it.",
      "A generated turn is NEVER evidence (see the patient_utterances view)."
    ].join(" "),
    validator: schema({
      sessionId: str(),
      seq: { bsonType: "int", minimum: 0 },
      role: { enum: ["patient", "companion", "caregiver", "system"] },
      epistemic: {
        enum: ["observed", "generated"],
        description: "Hard-wired by role: patient/caregiver speech is observed, companion output is generated."
      },
      speaker: {
        bsonType: ["object", "null"],
        description: "Who was heard, as the diarizer or capture console labelled it. A label, not biometric identification (§14.7). Only kind 'patient' may carry role 'patient'.",
        properties: {
          name: strOrNull(),
          kind: { enum: ["patient", "caregiver", "visitor"] },
          method: { enum: ["diarization", "declared"] },
          confidence: unit()
        }
      },
      text: str({ maxLength: 8000 }),
      startedAt: date(),
      endedAt: dateOrNull(),
      transcript: {
        bsonType: ["object", "null"],
        description: "Speech recognition metadata. confidence is the engine's own number and is uncalibrated.",
        properties: {
          engine: str(), version: str(), language: strOrNull(),
          confidence: unit(), isFinal: { bsonType: "bool" },
          partialCount: num({ minimum: 0 }),
          alternatives: arrOf({ bsonType: "object" })
        }
      },
      audio: {
        bsonType: ["object", "null"],
        description: "Pointer only. Audio retention defaults OFF and is governed by consent, not by this schema.",
        properties: {
          storage: { enum: ["s3", "gridfs", "none"] },
          ref: strOrNull(), bytes: num({ minimum: 0 }),
          durationMs: num({ minimum: 0 }), retainUntil: dateOrNull()
        }
      },
      sourceId: {
        ...strOrNull(),
        description: "Write-once sources document for a PATIENT turn, so her own words are citable. Always null for a companion turn."
      },
      groundedOn: arrOf({
        bsonType: "object", required: ["store", "id", "role"],
        properties: {
          store: { enum: STORES }, collection: strOrNull(), id: str(),
          role: { enum: ["evidence", "filter", "veto", "context", "script"] }
        }
      }, { description: "Explainability for a generated turn: every record read in order to say this." }),
      disclosure: {
        bsonType: ["object", "null"],
        properties: {
          policy: enumOrNull(["state_plainly", "redirect", "defer_to_caregiver", "withhold"]),
          nodeId: strOrNull(), scriptUsed: { bsonType: "bool" },
          constraintIds: arrOf(str())
        }
      },
      safety: {
        bsonType: "object",
        properties: {
          precheck: { enum: ["pass", "veto", "escalated"] },
          vetoConstraintId: strOrNull(),
          alertIds: arrOf(str())
        }
      },
      model: {
        bsonType: ["object", "null"],
        description: "Required on generated turns: without it a response cannot be reproduced or distrusted later.",
        properties: {
          name: str(), version: strOrNull(), promptDigest: strOrNull(),
          temperature: { bsonType: ["double", "int", "null"] },
          tokensIn: num({ minimum: 0 }), tokensOut: num({ minimum: 0 })
        }
      },
      latency: { bsonType: ["object", "null"] },
      inferenceIds: arrOf(str()),
      caregiverAnnotation: {
        bsonType: ["object", "null"],
        description: "Lets a caregiver mark a response wrong or concerning. The improvement signal that a transcript alone cannot give.",
        properties: {
          flag: { enum: ["good", "wrong", "concerning", "unclear"] },
          note: strOrNull(), by: str(), at: date()
        }
      },
      redacted: { bsonType: "bool" },
      redactionRef: strOrNull()
    }, { required: ["sessionId", "seq", "role", "epistemic", "text", "startedAt"] }),
    indexes: [
      { keys: { ...scope, sessionId: 1, seq: 1 }, options: { unique: true, name: "turn_order_unique" } },
      { keys: { ...scope, startedAt: -1 } },
      { keys: { ...scope, role: 1, startedAt: -1 } },
      { keys: { ...scope, epistemic: 1, startedAt: -1 } },
      { keys: { ...scope, sourceId: 1 }, options: { sparse: true, name: "turn_to_source" } },
      { keys: { ...scope, "safety.precheck": 1, startedAt: -1 },
        options: { name: "veto_review",
                   partialFilterExpression: { "safety.precheck": { $in: ["veto", "escalated"] } } } },
      { keys: { ...scope, "caregiverAnnotation.flag": 1, startedAt: -1 },
        options: { sparse: true, name: "flagged_responses" } },
      { keys: { ...scope, "disclosure.scriptUsed": 1, startedAt: -1 },
        options: { name: "scripted_disclosures",
                   partialFilterExpression: { "disclosure.scriptUsed": true } } },
      { keys: { ...scope, "groundedOn.id": 1 }, options: { name: "what_did_this_memory_say" } },
      { keys: { ...scope, inferenceIds: 1 } }
    ],
    searchIndexes: [
      {
        name: "conversation_text",
        type: "search",
        definition: {
          mappings: {
            dynamic: false,
            fields: {
              text: { type: "string", analyzer: "lucene.standard" },
              householdId: { type: "token" }, subjectId: { type: "token" },
              role: { type: "token" }, epistemic: { type: "token" },
              sessionId: { type: "token" }, redacted: { type: "boolean" },
              startedAt: { type: "date" }
            }
          }
        }
      },
      {
        name: "conversation_auto",
        type: "vectorSearch",
        definition: {
          fields: [
            { type: "autoEmbed", modality: "text", path: "text",
              model: process.env.VOYAGE_EMBED_MODEL || "voyage-4" },
            // `role` and `epistemic` are filter fields so a query can be constrained
            // to observed patient speech. retrieval.js REQUIRES that filter; a search
            // that omits it would let the companion cite its own past output as fact.
            ...["householdId", "subjectId", "role", "epistemic", "redacted", "startedAt"]
              .map(path => ({ type: "filter", path }))
          ]
        }
      }
    ]
  },

  // ──────────────── INFERENCE QUARANTINE (inferred) ──────────────────────────
  {
    name: "inferences",
    store: "episodic",
    note: [
      "Everything the system worked out for itself, stored rather than discarded —",
      "but quarantined. There is no 'patient' value in `visibility`, the companion's",
      "DB role has insert without find, and no retrieval path reads this collection.",
      "An inference becomes speakable only by being promoted into an approved record",
      "with a human's name on it."
    ].join(" "),
    validator: schema({
      inferenceType: {
        enum: ["entity_link", "intent", "topic", "repeated_question", "orientation_signal",
               "affect_signal", "routine_candidate", "preference_candidate",
               "relationship_candidate", "symptom_signal", "session_summary",
               "contradiction_candidate", "retrieval_miss"]
      },
      claim: { bsonType: "object", description: "Structured payload, shape per inferenceType." },
      claimDigest: str({ description: "Dedupe key: the same inference twice reinforces one record." }),
      epistemicStatus: {
        enum: ["inferred", "corroborated", "caregiver_confirmed", "caregiver_rejected", "expired"],
        description: "Starts at 'inferred'. Only a human moves it to confirmed or rejected."
      },
      confidence: unit(),
      calibration: {
        enum: ["uncalibrated"],
        description: "The only permitted value. `confidence` is a model score, never a probability of truth."
      },
      visibility: {
        enum: ["caregiver_only"],
        description: "The only permitted value. There is deliberately no patient-visible inference."
      },
      basis: {
        bsonType: "array", minItems: 1,
        description: "An inference that cannot name what it was derived from cannot be written.",
        items: {
          bsonType: "object", required: ["store", "id"],
          properties: { store: { enum: STORES }, collection: strOrNull(), id: str() }
        }
      },
      observationCount: num({ minimum: 1, description: "Independent observations supporting it; drives 'corroborated'." }),
      firstObservedAt: date(),
      lastObservedAt: date(),
      sessionId: strOrNull(),
      turnId: strOrNull(),
      model: { bsonType: ["object", "null"] },
      promotion: {
        bsonType: "object",
        properties: {
          state: { enum: ["none", "proposed", "promoted", "rejected"] },
          targetCollection: strOrNull(), targetId: strOrNull(),
          decidedBy: strOrNull(), decidedAt: dateOrNull(), reason: strOrNull()
        }
      },
      contradicts: arrOf(str()),
      recordedAt: date(),
      expiresAt: {
        bsonType: "date",
        description: "Sparse TTL. Written only for low-stakes types (intent, topic, retrieval_miss). Clinical-adjacent inferences never receive it."
      }
    }, { required: ["inferenceType", "claim", "claimDigest", "epistemicStatus", "calibration",
                    "visibility", "basis", "firstObservedAt", "lastObservedAt", "recordedAt"] }),
    indexes: [
      { keys: { ...scope, inferenceType: 1, claimDigest: 1 },
        options: { unique: true, name: "one_record_per_claim" } },
      { keys: { ...scope, epistemicStatus: 1, lastObservedAt: -1 } },
      { keys: { ...scope, inferenceType: 1, epistemicStatus: 1, lastObservedAt: -1 } },
      { keys: { ...scope, "promotion.state": 1, lastObservedAt: -1 },
        options: { name: "review_queue",
                   partialFilterExpression: { "promotion.state": "proposed" } } },
      { keys: { ...scope, observationCount: -1, lastObservedAt: -1 },
        options: { name: "corroboration_ranking" } },
      { keys: { ...scope, "basis.id": 1 }, options: { name: "what_did_this_turn_imply" } },
      { keys: { ...scope, turnId: 1 }, options: { sparse: true } },
      { keys: { ...scope, sessionId: 1, recordedAt: -1 }, options: { sparse: true } },
      { keys: { expiresAt: 1 },
        options: { expireAfterSeconds: 0, sparse: true, name: "ttl_expiresAt_sparse" } }
    ]
  },

  // ───────────────────────────── SEMANTIC ───────────────────────────────────
  {
    name: "semantic_nodes",
    store: "semantic",
    note: "Knowledge graph nodes. Person nodes REUSE people._id in the same scope (asserted by db/reconcile.js).",
    validator: schema({
      nodeType: { enum: ["person", "place", "routine", "object", "organisation", "concept", "pet", "event_type"] },
      label: str({ maxLength: 120 }),
      aliases: arrOf(str({ maxLength: 120 })),
      attributes: { bsonType: "object" },
      lifeStatus: { enum: ["current", "former", "deceased", "unknown"] },
      lifeStatusChangedAt: dateOrNull(),
      sensitivity: { enum: ["normal", "grief_sensitive", "withheld"] },
      disclosure: {
        bsonType: "object",
        required: ["policy"],
        description: "Caregiver-authored. The companion reads `script` verbatim; it does not compose sensitive answers.",
        properties: {
          policy: { enum: ["state_plainly", "redirect", "defer_to_caregiver", "withhold"] },
          script: strOrNull(),
          decidedBy: strOrNull(),
          decidedAt: dateOrNull(),
          reviewNote: strOrNull()
        }
      },
      searchText: str({ maxLength: 2000 }),
      embedding: { bsonType: ["array", "null"] },
      sourceIds: arrOf(str()),
      confidence: unit(),
      reviewStatus: { enum: ["draft", "approved"] },
      isCurrent: { bsonType: "bool" },
      supersedes: strOrNull(),
      supersededBy: strOrNull(),
      hotEdges: { bsonType: "array", maxItems: 12, description: "Derived cache of semantic_edges. Never authoritative." },
      activation: { bsonType: ["object", "null"] },
      version: { bsonType: "int", minimum: 1 },
      digest: strOrNull(),
      recordedAt: date(),
      reviewedAt: dateOrNull()
    }, { required: ["nodeType", "label", "lifeStatus", "sensitivity", "disclosure", "sourceIds", "reviewStatus", "isCurrent", "version", "recordedAt"] }),
    indexes: [
      { keys: { ...scope, nodeType: 1, reviewStatus: 1, isCurrent: 1 } },
      { keys: { ...scope, label: 1 } },
      { keys: { ...scope, aliases: 1 } },
      { keys: { ...scope, lifeStatus: 1 },
        options: { name: "non_current_lives", partialFilterExpression: { lifeStatus: { $in: ["former", "deceased", "unknown"] } } } },
      { keys: { ...scope, "activation.score": -1 },
        options: { name: "activation_tiebreak",
                   partialFilterExpression: { reviewStatus: "approved", isCurrent: true } } }
    ],
    searchIndexes: [
      {
        name: "semantic_text",
        type: "search",
        definition: {
          mappings: {
            dynamic: false,
            fields: {
              label: [{ type: "string", analyzer: "lucene.standard" }, { type: "token" }],
              aliases: { type: "string", analyzer: "lucene.standard" },
              searchText: { type: "string", analyzer: "lucene.standard" },
              householdId: { type: "token" }, subjectId: { type: "token" },
              nodeType: { type: "token" }, lifeStatus: { type: "token" },
              sensitivity: { type: "token" }, reviewStatus: { type: "token" },
              isCurrent: { type: "boolean" }
            }
          }
        }
      },
      {
        name: "semantic_auto",
        type: "vectorSearch",
        definition: {
          fields: [
            { type: "autoEmbed", modality: "text", path: "searchText",
              model: process.env.VOYAGE_EMBED_MODEL || "voyage-4" },
            ...["householdId", "subjectId", "nodeType", "reviewStatus", "isCurrent", "lifeStatus"]
              .map(path => ({ type: "filter", path }))
          ]
        }
      }
    ]
  },
  {
    name: "semantic_edges",
    store: "semantic",
    note: "Authoritative relationships. Both directions are materialized and share a pairId.",
    validator: schema({
      fromId: str(), toId: str(),
      edgeType: str(), inverseType: strOrNull(),
      pairId: str(),
      direction: { enum: ["forward", "reverse"] },
      weight: { bsonType: ["double", "int"], minimum: 0, maximum: 1 },
      temporal: {
        bsonType: ["object", "null"],
        properties: {
          validFrom: dateOrNull(), validTo: dateOrNull(),
          granularity: enumOrNull(["day", "month", "year", "decade"])
        }
      },
      status: { enum: ["current", "historical", "disputed"] },
      sourceIds: arrOf(str()),
      confidence: unit(),
      reviewStatus: { enum: ["draft", "approved"] },
      isCurrent: { bsonType: "bool" },
      supersedes: strOrNull(), supersededBy: strOrNull(),
      version: { bsonType: "int", minimum: 1 },
      digest: strOrNull(),
      recordedAt: date()
    }, { required: ["fromId", "toId", "edgeType", "pairId", "direction", "status", "sourceIds", "reviewStatus", "isCurrent", "version", "recordedAt"] }),
    indexes: [
      { keys: { ...scope, fromId: 1, edgeType: 1, status: 1, reviewStatus: 1 },
        options: { name: "graphlookup_forward" } },
      { keys: { ...scope, toId: 1, edgeType: 1, status: 1, reviewStatus: 1 },
        options: { name: "graphlookup_reverse" } },
      { keys: { ...scope, pairId: 1 } },
      { keys: { ...scope, "temporal.validTo": 1 }, options: { sparse: true } }
    ]
  },
  {
    name: "memory_links",
    store: "semantic",
    note: "Typed cross-store edges. Authoritative for every denormalized reference cache.",
    validator: schema({
      fromStore: { enum: STORES }, fromId: str(),
      toStore: { enum: STORES }, toId: str(),
      linkType: {
        enum: ["instantiates", "evidences", "about", "in_chapter", "derived_from",
               "triggers", "governs", "grounds", "contradicts", "supersedes"]
      },
      weight: unit(),
      createdBy: { enum: ["caregiver", "ingestion", "consolidation", "agent_proposal"] },
      reviewStatus: { enum: ["draft", "approved"] },
      sourceIds: arrOf(str()),
      confidence: unit(),
      recordedAt: date(), reviewedAt: dateOrNull(),
      isCurrent: { bsonType: "bool" },
      supersedes: strOrNull(), supersededBy: strOrNull()
    }, { required: ["fromStore", "fromId", "toStore", "toId", "linkType", "createdBy", "reviewStatus", "isCurrent", "recordedAt"] }),
    indexes: [
      { keys: { ...scope, fromStore: 1, fromId: 1, linkType: 1 } },
      { keys: { ...scope, toStore: 1, toId: 1, linkType: 1 } },
      { keys: { ...scope, linkType: 1, reviewStatus: 1 } },
      { keys: { ...scope, linkType: 1 },
        options: { name: "contradiction_review", partialFilterExpression: { linkType: "contradicts" } } }
    ]
  },

  // ───────────────────────────── PROCEDURAL ─────────────────────────────────
  {
    name: "procedures",
    store: "procedural",
    note: "Write-once per version. Only approval.status may change, and only to 'retired'.",
    validator: schema({
      procedureId: str(), version: { bsonType: "int", minimum: 1 },
      title: str({ maxLength: 200 }), intent: str({ maxLength: 2000 }),
      riskTier: { bsonType: "int", minimum: 0, maximum: 3 },
      trigger: {
        bsonType: "object", required: ["kind", "match"],
        properties: {
          kind: { enum: ["schedule", "context", "utterance", "observation", "state"] },
          match: { bsonType: "object" }
        }
      },
      preconditions: arrOf({ bsonType: "object", required: ["check"], properties: { check: str(), params: { bsonType: "object" } } }),
      steps: arrOf({
        bsonType: "object", required: ["stepId", "toolId"],
        properties: {
          stepId: str(), toolId: str(), args: { bsonType: "object" },
          onFailure: enumOrNull(["abort", "retry", "retry_then_escalate", "escalate", "continue"]),
          requiresConfirmation: { bsonType: "bool" }
        }
      }),
      guardrails: {
        bsonType: "object",
        properties: {
          maxPerDay: num({ minimum: 0 }), cooldownSeconds: num({ minimum: 0 }),
          quietHours: { bsonType: ["object", "null"] },
          requiresApprovedSource: { bsonType: "bool" },
          forbiddenTopics: arrOf(str())
        }
      },
      escalation: {
        bsonType: "object",
        properties: { ladder: arrOf({ bsonType: "object" }), slaSeconds: num({ minimum: 0 }) }
      },
      approval: {
        bsonType: "object", required: ["status"],
        properties: {
          status: { enum: ["draft", "active", "retired"] },
          approvedBy: strOrNull(), approvedAt: dateOrNull(),
          retiredAt: dateOrNull(), retiredReason: strOrNull()
        }
      },
      supersedes: strOrNull(),
      digest: str(),
      searchText: strOrNull()
    }, { required: ["procedureId", "version", "title", "riskTier", "trigger", "steps", "approval", "digest"] }),
    indexes: [
      { keys: { procedureId: 1, version: 1 }, options: { unique: true, name: "version_write_once" } },
      { keys: { ...scope, "trigger.kind": 1, "approval.status": 1, riskTier: 1 } },
      { keys: { ...scope, "approval.status": 1 },
        options: { name: "active_policies", partialFilterExpression: { "approval.status": "active" } } }
    ],
    searchIndexes: [
      {
        name: "procedures_text",
        type: "search",
        definition: {
          mappings: {
            dynamic: false,
            fields: {
              title: { type: "string", analyzer: "lucene.standard" },
              intent: { type: "string", analyzer: "lucene.standard" },
              searchText: { type: "string", analyzer: "lucene.standard" },
              procedureId: { type: "token" },
              "approval.status": { type: "token" },
              riskTier: { type: "number" },
              householdId: { type: "token" }, subjectId: { type: "token" }
            }
          }
        }
      }
    ]
  },
  {
    name: "tool_registry",
    store: "procedural",
    note: "Household-independent catalog of permitted actions. A disabled tool disables its procedures.",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: ["_id", "sideEffectClass", "maxRiskTier", "status"],
        properties: {
          _id: str(),
          title: str(), inputSchema: { bsonType: "object" },
          sideEffectClass: { enum: ["read", "notify_patient", "write_record", "contact_human", "device_action"] },
          maxRiskTier: { bsonType: "int", minimum: 0, maximum: 3 },
          requiresCaregiverApproval: { bsonType: "bool" },
          rateLimit: { bsonType: ["object", "null"] },
          reversible: { bsonType: "bool" },
          status: { enum: ["active", "deprecated", "disabled"] }
        }
      }
    },
    indexes: [{ keys: { status: 1, sideEffectClass: 1 } }]
  },
  {
    name: "procedure_runs",
    store: "procedural",
    note: "Write-once execution trace. decisionTrace is the explainability record. Never TTL'd.",
    validator: schema({
      idempotencyKey: str(),
      procedureId: str(), procedureVersion: { bsonType: "int" }, procedureDigest: str(),
      triggerRef: { bsonType: ["object", "null"] },
      decisionTrace: arrOf({
        bsonType: "object", required: ["store", "id", "role"],
        properties: {
          store: { enum: STORES }, collection: strOrNull(), id: str(),
          role: { enum: ["evidence", "filter", "veto", "context"] }
        }
      }),
      preconditionResults: arrOf({ bsonType: "object" }),
      stepResults: arrOf({ bsonType: "object" }),
      outcome: { enum: ["completed", "refused_precondition", "vetoed_safety", "failed", "escalated", "superseded", "running"] },
      vetoedBy: { bsonType: ["object", "null"] },
      escalatedTo: arrOf({ bsonType: "object" }),
      startedAt: date(), endedAt: dateOrNull()
    }, { required: ["idempotencyKey", "procedureId", "procedureVersion", "procedureDigest", "outcome", "startedAt"] }),
    indexes: [
      { keys: { ...scope, idempotencyKey: 1 }, options: { unique: true, name: "exactly_once" } },
      { keys: { ...scope, procedureId: 1, startedAt: -1 } },
      { keys: { ...scope, outcome: 1, startedAt: -1 } },
      { keys: { ...scope, "decisionTrace.id": 1 }, options: { name: "reverse_influence" } }
    ]
  },
  {
    name: "plans",
    store: "procedural",
    existing: true,
    indexes: [
      { keys: { ...scope, kind: 1, dueAt: 1 },
        options: { name: "due_approved_plans",
                   partialFilterExpression: { reviewStatus: "approved", eventStatus: "planned" } } }
    ]
  },
  {
    name: "context_events",
    store: "procedural",
    existing: true,
    indexes: [{ keys: { ...scope, observedAt: -1 } }]
  },

  // ───────────────────────── AUTOBIOGRAPHICAL ───────────────────────────────
  {
    name: "identity_core",
    store: "autobiographical",
    note: "Singleton per subject: _id === subjectId. Encrypt legalName / dateOfBirth / capacityNote (QE).",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: ["_id", "householdId", "preferredName", "version"],
        properties: {
          _id: str(), householdId: str(),
          preferredName: str({ maxLength: 120 }),
          legalName: {}, dateOfBirth: {}, capacityNote: {},
          pronouns: strOrNull(), birthPlace: strOrNull(),
          languages: arrOf({ bsonType: "object" }),
          communication: { bsonType: ["object", "null"] },
          lifeRoles: arrOf({ bsonType: "object" }),
          anchorPeople: arrOf({ bsonType: "object" }),
          comfortTopics: arrOf({ bsonType: "object" }),
          comfortObjects: arrOf({ bsonType: "object" }),
          comfortMusic: arrOf({ bsonType: "object" }),
          distressTopics: arrOf({
            bsonType: "object", required: ["label", "decidedBy"],
            properties: { label: str(), nodeId: strOrNull(), reason: strOrNull(), decidedBy: str(), decidedAt: dateOrNull() }
          }),
          knownLosses: arrOf({
            bsonType: "object", required: ["kind", "disclosurePolicy", "decidedBy"],
            properties: {
              nodeId: strOrNull(),
              kind: { enum: ["bereavement", "estrangement", "relocation", "pet_loss"] },
              disclosurePolicy: { enum: ["state_plainly", "redirect", "defer_to_caregiver", "withhold"] },
              script: strOrNull(), decidedBy: str(), decidedAt: dateOrNull()
            }
          }),
          faithAndCulture: { bsonType: ["object", "null"] },
          consentRef: strOrNull(),
          version: { bsonType: "int", minimum: 1 },
          digest: strOrNull(),
          approvedBy: strOrNull(), approvedAt: dateOrNull()
        }
      }
    },
    indexes: [{ keys: { householdId: 1 } }]
  },
  {
    name: "life_chapters",
    store: "autobiographical",
    note: "Eras, not dates. fuzzyPhrases is what resolves 'when the children were small'.",
    validator: schema({
      label: str({ maxLength: 200 }),
      from: dateOrNull(), to: dateOrNull(),
      granularity: { enum: ["year", "decade", "era"] },
      fuzzyPhrases: arrOf(str({ maxLength: 200 })),
      placeIds: arrOf(str()), personIds: arrOf(str()),
      narrative: str({ maxLength: 4000 }),
      searchText: strOrNull(), embedding: { bsonType: ["array", "null"] },
      sourceIds: arrOf(str()), confidence: unit(),
      reviewStatus: { enum: ["draft", "approved"] },
      sensitivity: { enum: ["normal", "grief_sensitive", "withheld"] },
      episodeCount: num({ minimum: 0 }),
      recordedAt: date()
    }, { required: ["label", "granularity", "sourceIds", "reviewStatus", "sensitivity", "recordedAt"] }),
    indexes: [
      { keys: { ...scope, from: 1, to: 1 } },
      { keys: { ...scope, reviewStatus: 1 } }
    ],
    searchIndexes: [
      {
        name: "chapters_text",
        type: "search",
        definition: {
          mappings: {
            dynamic: false,
            fields: {
              label: { type: "string", analyzer: "lucene.standard" },
              fuzzyPhrases: { type: "string", analyzer: "lucene.standard" },
              narrative: { type: "string", analyzer: "lucene.standard" },
              householdId: { type: "token" }, subjectId: { type: "token" },
              reviewStatus: { type: "token" },
              from: { type: "date" }, to: { type: "date" }
            }
          }
        }
      },
      {
        name: "chapters_auto",
        type: "vectorSearch",
        definition: {
          fields: [
            { type: "autoEmbed", modality: "text", path: "searchText",
              model: process.env.VOYAGE_EMBED_MODEL || "voyage-4" },
            ...["householdId", "subjectId", "reviewStatus"].map(path => ({ type: "filter", path }))
          ]
        }
      }
    ]
  },
  {
    name: "preferences",
    store: "autobiographical",
    note: "Time-bounded. An expired preference stops matching; it is not deleted.",
    validator: schema({
      domain: { enum: ["food", "drink", "music", "routine", "environment", "touch", "clothing", "activity", "communication"] },
      label: str({ maxLength: 200 }),
      polarity: { enum: ["likes", "dislikes", "refuses", "requires"] },
      strength: unit(),
      validFrom: date(), validTo: dateOrNull(),
      confirmedBy: strOrNull(), confirmedAt: dateOrNull(),
      confirmationCount: num({ minimum: 0 }),
      sourceIds: arrOf(str()),
      reviewStatus: { enum: ["draft", "approved"] },
      isCurrent: { bsonType: "bool" },
      supersedes: strOrNull(),
      recordedAt: date()
    }, { required: ["domain", "label", "polarity", "validFrom", "sourceIds", "reviewStatus", "isCurrent", "recordedAt"] }),
    indexes: [
      { keys: { ...scope, domain: 1, polarity: 1, isCurrent: 1 } },
      { keys: { ...scope, validFrom: 1, validTo: 1 } },
      { keys: { ...scope, domain: 1, label: 1 },
        options: { unique: true, name: "one_current_per_label",
                   partialFilterExpression: { isCurrent: true } } }
    ]
  },
  {
    name: "personal_records",
    store: "autobiographical",
    existing: true,
    indexes: [{ keys: { ...scope, promotedTo: 1 }, options: { sparse: true } }]
  },
  {
    name: "daily_logs",
    store: "autobiographical",
    existing: true,
    indexes: [{ keys: { ...scope, activity: 1, occurredAt: -1 } }]
  },

  // ───────────────────────── SAFETY & MEDICAL ───────────────────────────────
  {
    name: "safety_constraints",
    store: "safety",
    note: "Veto store. Inserted approved-only, with a named authority. Never TTL'd.",
    validator: schema({
      constraintType: {
        enum: ["allergy", "drug_interaction_flag", "do_not_mention", "do_not_contact",
               "fall_risk", "wandering_risk", "dietary", "device_restriction",
               "communication_restriction", "legal_directive_present"]
      },
      subjectRef: { bsonType: ["object", "null"] },
      rule: { bsonType: "object" },
      severity: { enum: ["advisory", "strict", "absolute"] },
      legalDirectiveRef: { ...strOrNull(), description: "Pointer only. Directive content is never stored here." },
      effectiveFrom: date(), effectiveTo: dateOrNull(),
      authority: {
        bsonType: "object", required: ["kind", "name", "role", "recordedAt"],
        properties: {
          kind: { enum: ["clinician", "caregiver", "legal"] },
          name: str(), role: str(), recordedAt: date(), documentRef: strOrNull()
        }
      },
      sourceIds: arrOf(str(), { minItems: 1 }),
      reviewStatus: { enum: ["approved"], description: "Drafts are not permitted: a half-entered allergy is worse than none." },
      version: { bsonType: "int", minimum: 1 },
      supersedes: strOrNull(), isCurrent: { bsonType: "bool" }, digest: strOrNull()
    }, { required: ["constraintType", "rule", "severity", "effectiveFrom", "authority", "sourceIds", "reviewStatus", "version", "isCurrent"] }),
    indexes: [
      { keys: { ...scope, constraintType: 1, isCurrent: 1, effectiveFrom: -1 } },
      { keys: { ...scope, severity: 1 },
        options: { name: "absolute_veto_set",
                   partialFilterExpression: { severity: "absolute", isCurrent: true } } }
    ]
  },
  {
    name: "care_alerts",
    store: "safety",
    note: "Append-only transitions. No TTL, no delete path. additionalProperties is closed so no clinical conclusion can be added.",
    validator: schema({
      idempotencyKey: str(),
      alertType: {
        enum: ["medication_no_response", "medication_reported_not_taken", "distress_reported",
               "repeated_disorientation", "fall_reported", "device_offline",
               "symptom_threshold", "wandering_signal", "audit_chain_break", "manual"]
      },
      severity: { enum: ["info", "advisory", "urgent", "emergency"] },
      state: { enum: ["raised", "notified", "acknowledged", "resolved", "expired_unacknowledged"] },
      transitions: arrOf({
        bsonType: "object", required: ["to", "at", "by"],
        properties: { from: strOrNull(), to: str(), at: date(), by: str(), note: strOrNull() }
      }),
      triggerRefs: {
        bsonType: "array", minItems: 1,
        description: "An alert that cannot name its evidence cannot be written.",
        items: {
          bsonType: "object", required: ["store", "id"],
          properties: { store: { enum: STORES }, collection: strOrNull(), id: str() }
        }
      },
      evidenceSummary: str({ maxLength: 2000 }),
      procedureRunId: strOrNull(),
      slaDeadlineAt: dateOrNull(),
      notifications: arrOf({ bsonType: "object" }),
      acknowledgedBy: strOrNull(), acknowledgedAt: dateOrNull(),
      resolution: { bsonType: ["object", "null"] },
      createdAt: date()
    }, {
      required: ["idempotencyKey", "alertType", "severity", "state", "transitions", "triggerRefs", "evidenceSummary", "createdAt"],
      closed: true
    }),
    indexes: [
      { keys: { ...scope, state: 1, slaDeadlineAt: 1 } },
      { keys: { ...scope, idempotencyKey: 1 }, options: { unique: true, name: "alert_storm_suppression" } },
      { keys: { ...scope, severity: 1, state: 1 },
        options: { name: "needs_attention",
                   partialFilterExpression: { state: { $in: ["raised", "notified"] } } } },
      { keys: { ...scope, "triggerRefs.id": 1 }, options: { name: "reverse_evidence" } }
    ]
  },
  {
    name: "medication_responses",
    store: "safety",
    existing: true,
    note: "EXISTING, write-once self-reports. Vocabulary stays reported_* / uncertain; no adherence metric exists.",
    indexes: [
      { keys: { ...scope, promptId: 1 }, options: { unique: true, name: "one_response_per_prompt" } },
      { keys: { ...scope, occurredAt: -1 } },
      { keys: { ...scope, caregiverReviewed: 1 },
        options: { name: "unreviewed", partialFilterExpression: { caregiverReviewed: false } } }
    ]
  },
  {
    name: "symptom_ts",
    store: "safety",
    kind: "timeseries",
    timeseries: { timeField: "observedAt", metaField: "series", granularity: "minutes" },
    note: "Caregiver/clinician/self reports. observerKind never includes 'agent'. No TTL: retention is policy-driven.",
    indexes: [{ keys: { "series.symptomCode": 1, observedAt: -1 } }]
  },
  {
    name: "physiology_ts",
    store: "safety",
    kind: "timeseries",
    timeseries: { timeField: "observedAt", metaField: "series", granularity: "seconds" },
    expireAfterSeconds: 180 * 24 * 3600,
    indexes: [{ keys: { "series.deviceId": 1, observedAt: -1 } }]
  },
  {
    name: "engagement_ts",
    store: "safety",
    kind: "timeseries",
    timeseries: { timeField: "at", metaField: "series", granularity: "minutes" },
    expireAfterSeconds: 180 * 24 * 3600,
    indexes: [{ keys: { "series.channel": 1, at: -1 } }]
  },
  {
    name: "consent_records",
    store: "safety",
    note: "Write-once. Withdrawal is a new record plus a pointer; the original is never erased.",
    validator: schema({
      version: { bsonType: "int", minimum: 1 },
      grantedBy: {
        bsonType: "object", required: ["kind", "name"],
        properties: {
          kind: { enum: ["subject", "attorney", "next_of_kin"] },
          name: {}, role: strOrNull(), evidenceRef: {}
        }
      },
      scopeOfConsent: { bsonType: "object" },
      proactiveContactAllowed: { bsonType: "bool" },
      rehearsalAllowed: { bsonType: "bool" },
      dataRetention: { bsonType: "object" },
      withdrawnAt: dateOrNull(), withdrawnBy: strOrNull(), supersededBy: strOrNull(),
      recordedAt: date(), digest: strOrNull()
    }, { required: ["version", "grantedBy", "proactiveContactAllowed", "rehearsalAllowed", "recordedAt"] }),
    indexes: [
      { keys: { ...scope, version: -1 } },
      { keys: { ...scope, withdrawnAt: 1 }, options: { sparse: true } }
    ]
  },
  {
    name: "deletion_requests",
    store: "safety",
    note: "Erasure plan. Audit events are tombstoned, never removed, so the hash chain still verifies.",
    validator: schema({
      requestedBy: str(), requestedAt: date(),
      authority: { bsonType: "object" },
      target: {
        bsonType: "object", required: ["kind", "id"],
        properties: { kind: { enum: ["subject", "episode", "media", "person_node"] }, id: str() }
      },
      cascade: arrOf({
        bsonType: "object", required: ["collection", "mode"],
        properties: {
          collection: str(), filter: { bsonType: "object" },
          mode: { enum: ["hard_delete", "tombstone", "retain_with_reason"] }
        }
      }),
      retainedForReason: arrOf({ bsonType: "object" }),
      state: { enum: ["requested", "approved", "executing", "completed", "rejected"] },
      executionLog: arrOf({ bsonType: "object" })
    }, { required: ["requestedBy", "requestedAt", "target", "state"] }),
    indexes: [{ keys: { ...scope, state: 1, requestedAt: 1 } }]
  },
  {
    name: "audit_events",
    store: "safety",
    existing: true,
    note: "EXISTING, append-only. Additive indexes for the hash chain and high-risk review.",
    indexes: [
      { keys: { ...scope, at: -1 } },
      { keys: { ...scope, seq: 1 }, options: { unique: true, name: "chain_order", partialFilterExpression: { seq: { $type: "number" } } } },
      { keys: { ...scope, action: 1, at: -1 } },
      { keys: { ...scope, recordId: 1, at: -1 } },
      { keys: { ...scope, riskTier: 1, at: -1 },
        options: { name: "high_risk_review", partialFilterExpression: { riskTier: { $gte: 2 } } } }
    ]
  },
  {
    name: "audit_counters",
    store: "safety",
    note: "One document per scope holding the monotonic seq used by the audit hash chain.",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: ["_id", "seq"],
        properties: { _id: str(), seq: { bsonType: ["int", "long"], minimum: 0 }, lastDigest: strOrNull() }
      }
    },
    indexes: []
  },

  // ──────────────── DEVICE LINK (live in Atlas, previously unindexed) ────────
  // These collections are written by integration/mobile-link.ts, mobile-push.ts and
  // capability-hooks.ts. They are created implicitly on first insert and appear in
  // NO index script in this repo, so in a live cluster they carry only the default
  // _id index. Every index below is derived from an actual query in that code.
  // No validators are installed: these are additive index definitions only, so
  // current writes cannot start failing.
  {
    name: "mobile_devices",
    store: "procedural",
    existing: true,
    note: "Linked phones. tokenHash is the authentication lookup and runs on EVERY mobile request.",
    indexes: [
      // Deliberately unscoped: the token IS the identifier, and the lookup happens
      // before a scope is known. Unique prevents a token colliding across households.
      { keys: { tokenHash: 1 }, options: { unique: true, sparse: true, name: "device_auth" } },
      { keys: { ...scope, revoked: 1, expiresAt: 1, createdAt: -1 }, options: { name: "active_devices" } },
      { keys: { ...scope, role: 1, revoked: 1 }, options: { name: "devices_by_role" } }
    ]
  },
  {
    name: "mobile_pairings",
    store: "procedural",
    existing: true,
    note: "Five-minute pairing codes. The ONE device-link collection where a TTL is correct.",
    indexes: [
      // Safe to expire: a pairing code is an ephemeral credential, not a record of
      // anything that happened. Grace period so a just-expired code still reports
      // 'expired' rather than 'not found'.
      { keys: { expiresAt: 1 }, options: { expireAfterSeconds: 3600, name: "ttl_pairing_codes" } }
    ]
  },
  {
    name: "mobile_commands",
    store: "procedural",
    existing: true,
    note: "Commands pushed to a linked phone, including sos_alert fan-out. Audit trail of what reached a caregiver's device.",
    indexes: [
      // ESR: equality (scope, deviceId, state) → sort (createdAt) → range (expiresAt)
      { keys: { ...scope, deviceId: 1, state: 1, createdAt: 1, expiresAt: 1 },
        options: { name: "device_queue_poll" } },
      { keys: { ...scope, deviceId: 1, createdAt: -1, expiresAt: 1 },
        options: { name: "device_history" } },
      { keys: { ...scope, deviceId: 1, kind: 1, expiresAt: 1 },
        options: { name: "command_kind_check" } },
      { keys: { ...scope, createdAt: -1 }, options: { name: "actions_feed" } }
    ]
  },
  {
    name: "mobile_policies",
    store: "procedural",
    existing: true,
    note: "One policy document per scope, addressed by a deterministic _id. No secondary index needed.",
    indexes: []
  },
  {
    name: "mobile_sos",
    store: "safety",
    existing: true,
    note: [
      "THE EMERGENCY PATH. A patient-initiated assistance request, its caregiver",
      "fan-out and its call state machine. The worker scans this collection on a",
      "timer; without these indexes every sweep is a collection scan on the one",
      "code path where latency is measured in someone's safety.",
      "It carries an `expiresAt` field and must NEVER receive a TTL index — see NO_TTL."
    ].join(" "),
    indexes: [
      { keys: { ...scope, status: 1, expiresAt: 1 }, options: { name: "queued_sos_sweep" } },
      { keys: { ...scope, callState: 1, createdAt: 1 }, options: { name: "call_state_machine" } },
      { keys: { ...scope, createdAt: -1 }, options: { name: "sos_history" } }
    ]
  },
  {
    name: "mobile_sos_gates",
    store: "safety",
    existing: true,
    note: "Ten-minute SOS cooldown, one document per scope by deterministic _id. Must never be TTL'd: losing the gate re-opens the fan-out.",
    indexes: []
  },
  {
    name: "mobile_push",
    store: "procedural",
    existing: true,
    note: "Web-push subscriptions. The endpoint lookup is intentionally cross-scope (one browser endpoint must not be registered twice) and is currently a collection scan.",
    indexes: [
      { keys: { endpoint: 1 }, options: { name: "endpoint_dedupe" } },
      { keys: { ...scope, enabled: 1 }, options: { name: "enabled_subscriptions" } }
    ]
  },
  {
    name: "mobile_push_attempts",
    store: "procedural",
    existing: true,
    note: "Per-command push idempotency, addressed by _id.",
    indexes: []
  },
  {
    name: "integration_requests",
    store: "procedural",
    existing: true,
    note: "Capability-hook request log (integration/capability-hooks.ts).",
    indexes: [
      { keys: { ...scope, createdAt: -1 }, options: { name: "request_log" } }
    ]
  },
  {
    name: "demo_scenarios",
    store: "procedural",
    existing: true,
    note: "Seed/demo fixtures written by integration/seed-*.ts. See db/audit-live.js: demo data should not share a database with patient records.",
    indexes: [
      { keys: { ...scope, createdAt: -1 }, options: { sparse: true, name: "scenario_lookup" } }
    ]
  },

  // ───────────────────────────── SPINE ──────────────────────────────────────
  {
    name: "ts_dedupe",
    store: "working",
    note: "Idempotency gate for time-series appends, which cannot have unique indexes.",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: ["_id", "expiresAt"],
        properties: { _id: str(), series: str(), sourceEventId: strOrNull(), expiresAt: date() }
      }
    },
    indexes: [{ keys: { expiresAt: 1 }, options: { expireAfterSeconds: 0, name: "ttl_expiresAt" } }]
  }
];

/** Half-lives used by the working-memory decay model (seconds). */
export const SLOT_HALF_LIFE = Object.freeze({
  percept: 120,
  scratch_fact: 300,
  topic: 900,
  salient_person: 1800,
  unresolved_question: 900,
  goal: 3600,
  safety_flag: 86400
});

/** Non-safety working-memory capacity per session. A budget discipline, not a claim about human capacity. */
export const WORKING_CAPACITY = 9;

/** SLA windows by alert severity (ms). */
export const ALERT_SLA_MS = Object.freeze({
  info: 24 * 3600 * 1000,
  advisory: 4 * 3600 * 1000,
  urgent: 30 * 60 * 1000,
  emergency: 5 * 60 * 1000
});

export default collections;
