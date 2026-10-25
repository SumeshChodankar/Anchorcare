# Anchorcare — MongoDB Atlas Cognitive Memory Schema

**Status:** design specification, v1 (2026-10-24)
**Database:** `engram` (existing, `MONGODB_DATABASE`)
**Target platform:** MongoDB Atlas 8.0+ (`$rankFusion` verified live on 8.0.34 — see [LIVE-ATLAS-VERIFICATION.md](./LIVE-ATLAS-VERIFICATION.md))
**Provisioning:** [`db/collections.js`](../db/collections.js) + [`db/provision.js`](../db/provision.js)
**Reference pipelines:** [`db/retrieval.js`](../db/retrieval.js), [`db/ingest.js`](../db/ingest.js)
**Example documents:** [`db/examples/`](../db/examples/)
**Continues in:** [`REALTIME-CAPTURE-AND-CLUSTER.md`](./REALTIME-CAPTURE-AND-CLUSTER.md) §§18–25 —
real-time conversation capture, inference persistence, and the cluster architecture.
**§23 there corrects four claims made here**, so read it before implementing §9.6
(erasure), §11.4 (archiving) or §14.5 (field-level encryption).

This document specifies the complete persistence layer for Anchorcare's biomimetic
memory system: six memory stores, their collections, field-level rationale, index
strategy, retrieval and write algorithms, and the safety constraints that make the
thing fit to sit next to a person with dementia.

It **extends** the collections that already exist in `engram-retrieval/` rather than
replacing them. Where a collection is already in code, this document marks it
`EXISTING` and specifies only the additions. New collections are marked `NEW`.

---

## 0. What this system is, and what it is not

Design decisions below are only defensible if the honest framing is kept in view:

| This system does | This system does not |
| --- | --- |
| Store caregiver-approved, source-backed reports of events | Establish that an event happened |
| Store self-reports of medication actions | Verify ingestion, dose, or adherence |
| Compute an engineering retention heuristic (`memory_state`) | Measure cognition or predict decline |
| Surface conflicting accounts side by side | Resolve which account is true |
| Raise alerts to named humans with evidence IDs | Make clinical decisions or triage autonomously |
| Record who approved what, when, immutably | Substitute for a clinical record system |

Every schema choice in this document follows from one of six invariants:

1. **I1 — Scope.** Every document carries `householdId` + `subjectId`. Every index
   leads with them. There is no cross-subject read path.
2. **I2 — Evidence.** No patient-facing claim exists without `sourceIds` pointing at
   write-once `sources`. Retrieval re-checks sources after search; search hits are
   candidates, not answers.
3. **I3 — Approval gate.** `reviewStatus: "approved"` + `isCurrent: true` is the only
   state readable by the companion. Drafts are caregiver-only. The agent never
   self-approves.
4. **I4 — Append-only history.** Facts are corrected by superseding, never by
   overwrite (`supersedes` / `supersededBy` / `isCurrent`, as in `ledger.ts`).
5. **I5 — Uncalibrated confidence.** `confidence` and `salience` are upstream
   metadata in [0,1] used as engineering filters. They are never rendered as
   probabilities of truth or of recall.
6. **I6 — Human escalation.** Any action above risk tier 1 requires a named human.
   Safety collections are never TTL'd, never hard-deleted by the agent.

---

## 1. Store map

```
STORE                   PRIMARY COLLECTIONS                         VOLATILITY
─────────────────────────────────────────────────────────────────────────────────
Working memory          working_sessions, working_memory,           TTL seconds–hours
                        active_tasks
Real-time capture       conversation_sessions,                      durable, append-only
  (§19)                 conversation_turns                            never TTL'd
Inference quarantine    inferences                                  durable; sparse TTL
  (§20)                                                               on low-stakes types
Episodic memory         episodes*, sources*, memory_images*,        durable, append-only
                        memory_state*, recall_attempts*,
                        rehearsal_sets*, practice_slots*,
                        memory_trace_ts
Semantic memory         semantic_nodes, semantic_edges, people*     durable, versioned
Procedural memory       procedures, tool_registry, procedure_runs,  durable, write-once
                        plans*, prompt_jobs*, prompts*,               per version
                        context_events*
Autobiographical        identity_core, life_chapters, preferences,  durable, versioned
                        personal_records*, daily_logs*
Safety & medical        safety_constraints, care_alerts,            durable, immutable
                        medication_responses*, symptom_ts,
                        physiology_ts, consent_records,
                        audit_events*, deletion_requests
Cross-store spine       memory_links, ts_dedupe                     durable / TTL
```

`*` = already in `scripts/indexes.js` or in `integration/*.ts`.

### 1.1 Why six stores and not one collection with a `type` field

The six are not a taxonomy for its own sake. They differ along axes that MongoDB
makes you choose per collection:

- **Volatility** → TTL vs no TTL. Working memory must evaporate; `care_alerts` must
  never evaporate. One collection cannot hold both policies.
- **Write pattern** → `episodes` is insert + supersede; `symptom_ts` is
  append-only time-series (no updates at all); `procedures` is write-once-per-version.
- **Index shape** → episodic needs vector + text + date-range; semantic needs
  graph adjacency; procedural needs trigger-matching; safety needs state + SLA
  deadline scans. A single collection would carry every index and every document
  would pay for all of them.
- **Access control** → the app's DB user has `insert`+`find` only on write-once
  collections (§14.2). Role grants are per-collection; mixing stores would destroy
  the mechanism.
- **Blast radius** → a bad consolidation job that corrupts semantic edges must not
  be able to touch medication records.

---

## 2. Shared spine

### 2.1 Scope and identity conventions

```js
scope = { householdId: "<string>", subjectId: "<string>" }   // on EVERY document
```

| Convention | Rule | Why |
| --- | --- | --- |
| `_id` prefix | `episode_`, `source_`, `person_`, `node_`, `edge_`, `proc_`, `alert_`, `wm_`, `link_` | Makes every cross-store reference self-describing in logs and audit trails; a stray id in the wrong field is visible by eye |
| Deterministic `_id` | `sha256(collection, scope, recordId)` for anything a client may retry (as `life-records.js` already does) | Idempotency without transactions; a retried HTTP request cannot create a second record |
| `dedupeKey` | Natural key, unique per scope | Second line of defence when `_id` is a UUID (already used by `prompt_jobs`, `prompts`) |
| `version` | Monotonic integer, bumped under optimistic filter | `medication.ts` already relies on this; extended to all mutable docs |
| `digest` | `sha256` of the immutable payload | Detects a reused id with changed content (returns 409), and underpins the hash-chained audit log |
| Timestamps | `*At` suffix, always BSON `Date`, always UTC | Local-day logic belongs in `memory-model.js` with the configured `TIMEZONE`, never in stored strings |
| Status vocabulary | `reported_*` / `uncertain`, never `confirmed_*` | I5. A schema that offers a `confirmed` enum will get one written into it |

### 2.2 `sources` — the evidence substrate `EXISTING`

Unchanged in shape, elevated in status: **write-once**, and the only collection the
agent may cite. Additions for multimodal intake:

| Field | Type | Purpose |
| --- | --- | --- |
| `_id` | `source_*` | — |
| `householdId`, `subjectId` | string | I1 |
| `sourceType` | enum `caregiver_report` \| `user_report` \| `recording_transcript` \| `media_reference` | Already enforced in `service.js`. Drives whether `content` may be null |
| `content` | string (≤12000) \| null | Null only for `media_reference`, which requires human inspection before approval |
| `mediaPtr` | string | GridFS id or external pointer. Never fetched by the retrieval backend |
| `recordedAt` | Date | Ingestion time, not event time |
| **`modality`** `NEW` | enum `text` \| `speech` \| `image` \| `video` \| `device` | Routes the ingestion pipeline (§13.1) |
| **`derivedFrom`** `NEW` | string \| null | Parent source id when this is a transcript or caption of another source. Keeps the raw artefact and its machine interpretation as two separate, separately-citable records |
| **`processor`** `NEW` | `{ name, version, at }` \| null | Which ASR/captioner produced a derived source. Required for `derivedFrom != null`. Without it you cannot re-run or distrust a model's output after the fact |
| **`digest`** `NEW` | hex | Content hash; makes `sources` tamper-evident and lets ingestion dedupe identical uploads |
| **`inspection`** `NEW` | `{ required: bool, by: string\|null, at: Date\|null }` | `media_reference` and any `derivedFrom` source starts `required: true`. Approval of a dependent episode is blocked until inspected |

**Why `derivedFrom` instead of storing the transcript on the raw source:** when a
caregiver later disputes what the companion said, the question "did the person say
that, or did the recogniser mishear it?" must be answerable. Two records, two
digests, one link.

### 2.3 `audit_events` — append-only, hash-chained `EXISTING`

| Field | Type | Purpose |
| --- | --- | --- |
| `_id` | `audit_*` | — |
| scope | — | I1 |
| `action` | string | e.g. `episode_corrected`, `medication_plan_approved`, `alert_acknowledged` |
| `recordId` | string | Subject of the action |
| `detail` | object | Free-form; must not contain clinical conclusions |
| `at` | Date | Server clock |
| **`actor`** `NEW` | `{ kind: "caregiver"\|"patient"\|"agent"\|"system", id, credentialRef }` | `ledger.ts` currently writes `detail.actor: "caregiver_access_key"`. Promote it to a first-class, indexed field — audit without a subject is not audit |
| **`actorRole`** `NEW` | enum `primary_caregiver` \| `secondary` \| `clinician` \| `agent` \| `admin` | Answers "was this person allowed to do this?" at review time |
| **`seq`** `NEW` | long | Per-scope monotonic counter (see §14.3) |
| **`prevDigest`**, **`digest`** `NEW` | hex | Hash chain. `digest = sha256(prevDigest, seq, scope, action, recordId, detail, at)` |
| **`riskTier`** `NEW` | 0–3 | Lets the caregiver console show tier ≥2 events without scanning everything |

The chain makes silent deletion or back-dating detectable: `db/verify-audit.js`
walks the chain per scope and reports the first break. This is the honest version of
"immutable" on a platform where a project owner always holds `dropDatabase`.

### 2.4 `memory_links` — typed cross-store edges `NEW`

Authoritative, auditable edge store for requirement 7. See §6.

### 2.5 `ts_dedupe` — idempotency for time-series writes `NEW`

Time-series collections accept no unique indexes and no updates. Writers therefore
insert into `ts_dedupe` first (`_id = sha256(series, sourceEventId)`, unique, TTL
30 days) and only append the measurement when that insert succeeds. Without this,
a retried device webhook double-counts a symptom.
---

## 3. Working memory — volatile cognitive state

Working memory is the only store that is allowed to be wrong, cheap, and
short-lived. It holds what the agent is *currently* holding in mind: the live turn,
the unresolved question, the person just mentioned, the fact that a safety flag
fired ninety seconds ago. Nothing here is ever shown to a caregiver as a record of
the patient's life, and nothing here survives a day.

Three collections, because they have three different lifetimes.

### 3.1 `working_sessions` `NEW`

One document per conversation frame (a visit, a voice call, a phone session).

| Field | Type | Purpose / cognitive role |
| --- | --- | --- |
| `_id` | `wsession_*` | — |
| scope | — | I1 |
| `channel` | enum `voice` \| `phone_pwa` \| `console` \| `device` | Response-shaping: voice sessions get shorter sentences (`identity_core.communication`) |
| `startedAt`, `lastTurnAt` | Date | Idle detection; `lastTurnAt` drives TTL refresh |
| `turnCount` | int | Cheap guard against runaway loops |
| `attentionFocus` | `{ topic, personIds[], placeId, chapterId, since }` | The "spotlight". Retrieval biases toward the focus before falling back to global search — this is what stops the companion from answering a follow-up question as if it were a new one |
| `orientationSignals` | `{ repeatedQuestionCount, timeConfusionReports, placeConfusionReports, lastSignalAt }` | **Reported signals, not a diagnosis.** Used only to (a) slow down, (b) prefer concrete anchors, (c) surface to the caregiver as counts with timestamps. No field in this schema stores an inferred cognitive state |
| `affect` | `{ reportedValence, reportedArousal, basis: "self_report"\|"caregiver_report"\|"unknown", at }` | Allows "you sound upset — shall we look at the garden photos?" only when the basis is a report, never when inferred from audio |
| `distressFlag` | `{ raised: bool, reason, at, alertId }` | Set by the safety precheck; mirrors to `care_alerts` if it survives one turn |
| `activeProcedureId`, `activeProcedureVersion` | string, int | Which policy is mid-execution, so a dropped connection resumes the same version |
| `pendingConfirmations` | array of `{ question, expectedAnswers[], raisedAt, expiresAt }` | Unfinished clarifications; the thing a stateless chatbot forgets |
| `expiresAt` | Date | TTL. Default `lastTurnAt + 12h`, refreshed each turn |
| `closedAt`, `closeReason` | Date, enum | Explicit close writes a single summary episode draft (§13.3) |

```json
{
  "_id": "wsession_2026-10-24T09:12Z_margaret",
  "householdId": "demo-household",
  "subjectId": "margaret",
  "channel": "voice",
  "startedAt": { "$date": "2026-10-24T09:12:04.000Z" },
  "lastTurnAt": { "$date": "2026-10-24T09:18:41.000Z" },
  "turnCount": 7,
  "attentionFocus": {
    "topic": "sarah_visit",
    "personIds": ["person_sarah"],
    "placeId": "node_place_margarets_garden",
    "chapterId": null,
    "since": { "$date": "2026-10-24T09:15:02.000Z" }
  },
  "orientationSignals": {
    "repeatedQuestionCount": 3,
    "timeConfusionReports": 1,
    "placeConfusionReports": 0,
    "lastSignalAt": { "$date": "2026-10-24T09:18:10.000Z" }
  },
  "affect": { "reportedValence": null, "reportedArousal": null, "basis": "unknown", "at": null },
  "distressFlag": { "raised": false, "reason": null, "at": null, "alertId": null },
  "activeProcedureId": "proc_repeated_question_support",
  "activeProcedureVersion": 3,
  "pendingConfirmations": [],
  "expiresAt": { "$date": "2026-10-24T21:18:41.000Z" },
  "closedAt": null,
  "closeReason": null
}
```

### 3.2 `working_memory` — activation slots `NEW`

One document per item currently activated. Capacity-bounded and decay-ranked; this
is the closest thing in the schema to a biological working-memory buffer.

| Field | Type | Purpose / cognitive role |
| --- | --- | --- |
| `_id` | `wm_*` | — |
| scope, `sessionId` | — | Slots are session-local |
| `slotType` | enum `percept` \| `goal` \| `topic` \| `unresolved_question` \| `salient_person` \| `safety_flag` \| `scratch_fact` | Different eviction rules per type: `safety_flag` is never evicted by capacity, only by expiry or resolution |
| `content` | string (≤500) | The surface form the agent will reuse verbatim |
| `boundTo` | array of `{ store, id }` | Pointers into durable memory. A slot is a *handle*, not a copy — so a mid-session correction in `episodes` is reflected on the next read |
| `activation` | double 0–1 | Current strength at `lastTouchedAt` |
| `decayHalfLifeSeconds` | int | Per-type: `percept` 120s, `topic` 900s, `goal` 3600s, `safety_flag` 86400s |
| `reinforcementCount` | int | Number of times re-mentioned; feeds the consolidation decision (§13.3) |
| `provenance` | enum `patient_utterance` \| `caregiver_input` \| `retrieval` \| `device` \| `agent_inference` | `agent_inference` slots may never be promoted to an episode without caregiver approval, and may never be cited as evidence |
| `createdAt`, `lastTouchedAt` | Date | Decay is computed, never stored stale |
| `expiresAt` | Date | **TTL index, `expireAfterSeconds: 0`** |

Effective activation is always derived at read time, never written back:

```
effective = activation * 2 ** ( -(now - lastTouchedAt) / decayHalfLifeSeconds )
```

**Capacity rule.** At most 9 non-`safety_flag` slots per session (7±2, chosen as a
budget discipline, not a claim about human capacity). On insert, if the count
exceeds 9, evict the lowest effective activation. Eviction is a delete, plus one
`working_memory_evicted` audit event only when `reinforcementCount ≥ 2` — a
repeatedly-mentioned item that fell out of the buffer is worth a caregiver seeing.

```json
{
  "_id": "wm_01JB2X7Q9K",
  "householdId": "demo-household",
  "subjectId": "margaret",
  "sessionId": "wsession_2026-10-24T09:12Z_margaret",
  "slotType": "unresolved_question",
  "content": "Is Sarah coming today?",
  "boundTo": [
    { "store": "semantic", "id": "person_sarah" },
    { "store": "procedural", "id": "plan_visit_sarah_20261024" }
  ],
  "activation": 0.92,
  "decayHalfLifeSeconds": 900,
  "reinforcementCount": 3,
  "provenance": "patient_utterance",
  "createdAt": { "$date": "2026-10-24T09:15:02.000Z" },
  "lastTouchedAt": { "$date": "2026-10-24T09:18:10.000Z" },
  "expiresAt": { "$date": "2026-10-24T13:18:10.000Z" }
}
```

### 3.3 `active_tasks` — short-horizon intents `NEW`

Working memory for *doing*, not for knowing. Survives disconnection because a
half-finished medication confirmation must not vanish with the socket.

| Field | Type | Purpose |
| --- | --- | --- |
| `_id` | `task_*`, deterministic from `(scope, taskKey)` | Idempotent creation |
| scope, `sessionId` (nullable) | — | A task can outlive its session |
| `taskType` | enum `await_medication_response` \| `await_caregiver_approval` \| `deliver_prompt` \| `clarify` \| `escalate` \| `rehearsal_offer` | — |
| `status` | enum `pending` \| `in_progress` \| `blocked` \| `done` \| `expired` \| `superseded` | — |
| `riskTier` | 0–3 | Tier ≥2 tasks are never TTL'd and never auto-expired silently |
| `procedureId`, `procedureVersion` | string, int | The policy that created it |
| `payload` | object | Task-specific, schema-validated per `taskType` |
| `dueAt`, `slaDeadlineAt` | Date | `slaDeadlineAt` for tier ≥2: breach raises a `care_alert` |
| `blockedBy` | array of `{ store, id, reason }` | Explicit blocking, so the console can show *why* nothing happened |
| `leaseToken`, `leaseUntil`, `attempts` | — | Same claim pattern as `prompt_jobs` in `store.js`; lets a worker restart without double-delivering |
| `expiresAt` | Date \| **absent** | **Sparse TTL.** Written only for `riskTier ≤ 1` tasks in a terminal state. Tier ≥2 tasks never receive this field, so TTL cannot reach them |

The sparse-TTL trick is the mechanism behind I6: MongoDB's TTL monitor deletes only
documents that *have* the indexed field, so "safety records are never TTL'd" is
enforced by the absence of a field rather than by remembering not to write one.

---

## 4. Episodic memory — time-stamped, multimodal, source-backed

### 4.1 `episodes` `EXISTING` — extended

Existing fields (`summary`, `searchText`, `sourceIds`, `personIds`, `eventStart`,
`eventEnd`, `recordedAt`, `reviewStatus`, `eventStatus`, `isCurrent`, `place`,
`what`, `confidence`, `salience`, `mediaPtr`, `contractDigest`, `supersedes`,
`supersededBy`, `retractionReason`, `correctionReason`, `embedding`,
`embeddingModel`) stay exactly as `service.js` writes them. Additions:

| Field | Type | Purpose / cognitive role |
| --- | --- | --- |
| `gist` | string (≤280) | The one-line form used for rehearsal prompts and for "what happened yesterday?". Separating gist from `summary` mirrors gist-vs-detail recall and keeps prompts short on voice channels |
| `chapterId` | string \| null | → `life_chapters`. Lets "tell me about the Dublin years" become a single indexed range scan instead of a semantic search |
| `semanticRefs` | array of node ids | Denormalized read-path copy of `memory_links` edges of type `about` / `occurred_at`. Lets one `$vectorSearch` pre-filter on "episodes involving Sarah at the garden" |
| `emotionalTone` | `{ reported: enum, basis, sourceId }` \| null | `basis` must be `caregiver_report` or `user_report`. Never inferred. Drives *avoidance* (don't rehearse a distressing episode), never diagnosis |
| `sensitivity` | enum `normal` \| `grief_sensitive` \| `withheld` | `grief_sensitive` episodes are retrievable but routed through the disclosure policy in §5.4 — the schema-level answer to "the companion must not cheerfully announce that her husband died" |
| `visualEmbedding` | array\<double\>[1024] \| null | Multimodal vector from the approved image (voyage-multimodal-3). Separate path because `$vectorSearch` queries exactly one path per stage (§4.4) |
| `visualEmbeddingModel`, `visualEmbeddingAt` | string, Date | Re-embedding migrations |
| `embeddingMeta` | `{ textModel, textDims, visualModel, visualDims, inputDigest, generatedAt }` | `inputDigest = sha256(searchText)`. A mismatch at read time means the vector is stale relative to the text — detectable instead of silently wrong |
| `consolidation` | `{ state: "labile"\|"consolidating"\|"consolidated", rehearsalCount, lastConsolidatedAt, promotedNodeIds[] }` | Tracks episodic → semantic promotion (§13.3). `promotedNodeIds` is the audit trail for "where did the system learn that?" |
| `recurrenceKey` | string \| null | Hash of (activity, place, time-of-day bucket). Repeated near-identical episodes ("Tuesday chapel") collapse into a semantic routine rather than 200 episodes |
| `dedupeKey` | string | Unique per scope; stops double-ingestion of the same reported event |
| `derivedModalities` | array of `{ modality, sourceId, processor, inspection }` | Which modalities contributed, each pointing at its own source record |

```json
{
  "_id": "episode_visit_001",
  "householdId": "demo-household",
  "subjectId": "margaret",
  "summary": "Sarah visited and they had tea in the garden. Sarah brought photographs from the seaside trip.",
  "gist": "Sarah visited; tea in the garden.",
  "searchText": "Sarah visited and they had tea in the garden. Sarah brought photographs from the seaside trip. garden tea daughter visit photographs seaside",
  "what": "Afternoon visit with tea outdoors",
  "place": "Back garden",
  "sourceIds": ["source_caregiver_note_4411", "source_photo_garden_01"],
  "personIds": ["person_sarah"],
  "semanticRefs": ["person_sarah", "node_place_margarets_garden", "node_routine_afternoon_tea"],
  "chapterId": "chapter_oakfield_road",
  "eventStart": { "$date": "2026-10-22T14:30:00.000Z" },
  "eventEnd": { "$date": "2026-10-22T16:00:00.000Z" },
  "recordedAt": { "$date": "2026-10-22T18:04:12.000Z" },
  "reviewStatus": "approved",
  "reviewedAt": { "$date": "2026-10-22T19:20:00.000Z" },
  "eventStatus": "reported_completed",
  "isCurrent": true,
  "supersedes": null,
  "supersededBy": null,
  "confidence": 0.9,
  "salience": 0.8,
  "emotionalTone": { "reported": "warm", "basis": "caregiver_report", "sourceId": "source_caregiver_note_4411" },
  "sensitivity": "normal",
  "mediaPtr": "image_7c2f1a90",
  "derivedModalities": [
    { "modality": "text", "sourceId": "source_caregiver_note_4411", "processor": null,
      "inspection": { "required": false, "by": "carer_jane", "at": { "$date": "2026-10-22T19:20:00.000Z" } } },
    { "modality": "image", "sourceId": "source_photo_garden_01",
      "processor": { "name": "voyage-multimodal-3", "version": "2026-05", "at": { "$date": "2026-10-22T18:05:00.000Z" } },
      "inspection": { "required": true, "by": "carer_jane", "at": { "$date": "2026-10-22T19:19:40.000Z" } } }
  ],
  "visualEmbedding": null,
  "visualEmbeddingModel": "voyage-multimodal-3",
  "visualEmbeddingAt": { "$date": "2026-10-22T18:05:00.000Z" },
  "embeddingMeta": {
    "textModel": "voyage-4", "textDims": 1024,
    "visualModel": "voyage-multimodal-3", "visualDims": 1024,
    "inputDigest": "9f2c…", "generatedAt": { "$date": "2026-10-22T18:05:00.000Z" }
  },
  "consolidation": { "state": "consolidating", "rehearsalCount": 2,
    "lastConsolidatedAt": { "$date": "2026-10-23T02:10:00.000Z" },
    "promotedNodeIds": ["node_routine_afternoon_tea"] },
  "recurrenceKey": "tea|garden|afternoon",
  "dedupeKey": "visit|person_sarah|2026-10-22",
  "contractDigest": "a71b…"
}
```

> `visualEmbedding` is shown as `null` with model metadata present: the image was
> inspected and approved, the vector is generated asynchronously by the embedding
> worker, and retrieval must tolerate its absence rather than assume it.

### 4.2 Rehearsal and decay collections `EXISTING`

`memory_state`, `recall_attempts`, `rehearsal_sets`, `practice_slots` keep the exact
semantics documented in [`engram-retrieval/MEMORY-MODEL.md`](../engram-retrieval/MEMORY-MODEL.md):
stability in days, exponential retention, cue levels 0–3, three items per local day,
one accepted attempt per episode per day, optimistic `version`, immutable
`attempt_id`. Two additions only:

| Collection | Field | Purpose |
| --- | --- | --- |
| `memory_state` | `salienceAtSelection` | Snapshot of the salience used when the item was picked, so a later salience edit does not rewrite history |
| `memory_state` | `suppressUntil` | Set when an episode is marked `grief_sensitive` or a caregiver declines it; keeps the item eligible for recall but out of *proactive* rehearsal |
| `recall_attempts` | `applied` | Already described in MEMORY-MODEL.md; formalized in the validator so partial failures are queryable (`applied: false`) |

### 4.3 `memory_trace_ts` — decay and reinforcement time-series `NEW`

```js
{ timeseries: { timeField: "at", metaField: "series", granularity: "hours" },
  expireAfterSeconds: 31536000 }   // 365 days
```

| Field | Type | Purpose |
| --- | --- | --- |
| `at` | Date | Sample instant (`timeField`) |
| `series` | `{ householdId, subjectId, episodeId, modelVersion }` | `metaField`. Buckets by episode so a single chart is one bucket scan |
| `stabilityDays` | double | Model state after the event |
| `estimatedRetention` | double | Derived at sample time; **labelled experimental in every UI** |
| `event` | enum `nightly_sample` \| `attempt` \| `skip` \| `suppressed` \| `state_init` | — |
| `cueLevel` | int \| null | 0–3 for attempts |
| `outcome` | enum \| null | `recalled` \| `not_recalled` \| `skipped` |
| `attemptId` | string \| null | Join back to the authoritative `recall_attempts` record |

Time-series is correct here and *wrong* for `recall_attempts`: traces are
append-only, never corrected, and read as ranges; attempts need unique ids,
idempotent retries and an `applied` flag that gets updated. MEMORY-MODEL.md already
made that call; this formalizes both halves.

### 4.4 Embeddings: dimensions, storage, ANN strategy

| Concern | Decision | Rationale |
| --- | --- | --- |
| Text model | `voyage-4`, 1024 dims, cosine | Already the configured default (`VOYAGE_DIMENSIONS=1024`). 1024 is the quality/footprint knee for this corpus size; episodes per subject is in the thousands, not millions |
| Text generation | Atlas Automated Embedding (`EMBEDDING_MODE=auto`, `type: "autoEmbed"` on `searchText`) | No vector in the document, no re-embedding job, no drift between index and document. Verified live on 8.0.34 |
| Manual fallback | `EMBEDDING_MODE=manual` → `embedding` array + `embeddingModel` | Needed if the project integration is unavailable; the index definition differs, so it requires a **new index name**, never an edit |
| Image model | `voyage-multimodal-3`, 1024 dims, cosine, stored in `visualEmbedding` | Images cannot go through text autoEmbed. App-side generation after caregiver inspection — never before, so an un-inspected photo is never searchable |
| Quantization | `scalar` on the visual index; none on text | Visual vectors are the larger set (one per approved image) and recall loss is tolerable for a candidate-generation stage that is re-checked against canonical records |
| One path per query | `$vectorSearch` takes a single `path`. Multimodal recall = two branches inside `$rankFusion` | This is why `searchText` and `visualEmbedding` are separate top-level paths, not two keys under one `embeddings` object |
| `numCandidates` | `20 × limit` (200 for limit 10) | Standard Atlas guidance; raise only with measured recall@k on real approved records |
| Pre-filtering | Every filter field declared `type: "filter"` in the vector index: `householdId`, `subjectId`, `reviewStatus`, `isCurrent`, `sensitivity`, `eventStart`, `personIds`, `chapterId` | **Post-filtering is a correctness bug here**: filtering after ANN can return zero approved episodes while approved ones exist, which the companion would present as "I don't have a memory of that" |
| Projection | `{ embedding: 0, visualEmbedding: 0 }` **after** fusion/rerank | Already the rule in `search.js`; restated because a `$project` inside a fusion branch silently drops documents |
| Staleness | `embeddingMeta.inputDigest` vs `sha256(searchText)` | Detect vectors that predate a correction. Mismatch → exclude from vector branch, keep in text branch, flag for re-embed |

Vector index definitions live in `db/collections.js`. Index names are
config-driven (`VECTOR_INDEX`, `SEARCH_INDEX`) and **never edited in place** — a
model or mode change takes a new name, per `NATIVE-ATLAS.md`.
---

## 5. Semantic memory — a knowledge graph inside MongoDB

Episodic memory answers "what happened". Semantic memory answers "who is Sarah,
where do I live, what happens on Tuesdays" — the questions a person with dementia
asks most often, and the ones that must be answered identically every time.

### 5.1 Representation choice

MongoDB has no native graph type. Three patterns are available; the schema uses all
three, each where it is actually correct:

| Pattern | Used for | Why |
| --- | --- | --- |
| **Separate edge collection** (`semantic_edges`) + `$graphLookup` | All relationships | Edges need their own provenance, validity window, approval state and corrections. Embedding them in the node would make "who said Sarah is her daughter, and when was that approved?" unanswerable, and would make the node document grow unboundedly |
| **Embedded adjacency** (`semantic_nodes.hotEdges`) | The ≤12 highest-weight current edges | One-document answer for the hot path ("who is this person to me?") with no `$lookup`. Rebuilt by the consolidation job; always derivable, never authoritative |
| **Denormalized back-references** (`episodes.semanticRefs`, `episodes.personIds`) | Vector/text pre-filters | `$vectorSearch` can only pre-filter on fields in the same document |

The invariant: **`semantic_edges` is the source of truth; `hotEdges` and
`semanticRefs` are caches with a named rebuild job.** A reconciliation script
(`db/reconcile.js`) reports divergence rather than silently repairing it, because
silent repair hides ingestion bugs.

### 5.2 `semantic_nodes` `NEW` (+ `people` `EXISTING`)

Person nodes **reuse the `people._id`** (`person_sarah`). `people` stays the
canonical card that `service.js`, `life-records.js` and `image-memory.ts` already
validate against; `semantic_nodes` adds the graph and disclosure layer for the same
entity. Enforced by: `nodeType: "person"` ⇒ a `people` document with the same `_id`
and scope must exist (checked on insert, asserted by `db/reconcile.js`).

| Field | Type | Purpose / cognitive role |
| --- | --- | --- |
| `_id` | `person_*` for people, else `node_*` | — |
| scope | — | I1 |
| `nodeType` | enum `person` \| `place` \| `routine` \| `object` \| `organisation` \| `concept` \| `pet` \| `event_type` | Drives both traversal rules and disclosure defaults |
| `label` | string (≤120) | The canonical name the companion speaks |
| `aliases` | array of string | "Sal", "my girl", "the nurse". Indexed for exact lookup and fed into the `$search` index — essential when the person's own vocabulary drifts |
| `attributes` | object, type-specific | `person`: `{ relationship, lastSeenReportedAt, voiceSample: null }`. `place`: `{ addressRef, isCurrentResidence, formerResidenceFrom/To }`. `routine`: `{ rrule, timeOfDay, placeId, participants[] }` |
| `lifeStatus` | enum `current` \| `former` \| `deceased` \| `unknown` | **The single most safety-critical field in the semantic store.** `deceased` forces `disclosure.policy` to be explicit and bars the node from any proactive prompt |
| `sensitivity` | enum `normal` \| `grief_sensitive` \| `withheld` | — |
| `disclosure` | `{ policy: "state_plainly"\|"redirect"\|"defer_to_caregiver"\|"withhold", script, decidedBy, decidedAt, reviewNote }` | Caregiver-authored. The companion reads the script; it does not compose its own answer about a death or a conflict |
| `searchText` | string (≤2000) | Label + aliases + approved attribute prose; the autoEmbed path for `semantic_auto` |
| `embedding` | array[1024] \| null | Manual mode only |
| `sourceIds` | array | I2 — a node without evidence cannot be approved |
| `confidence` | double 0–1 \| null | I5 |
| `reviewStatus` | enum `draft` \| `approved` | I3 |
| `isCurrent`, `supersedes`, `supersededBy` | — | I4, same ledger pattern as episodes |
| `hotEdges` | array (≤12) of `{ edgeId, edgeType, toId, toLabel, weight }` | Read cache (§5.1) |
| `activation` | `{ score, lastRetrievedAt, retrievalCount }` | Spreading-activation prior: frequently-retrieved nodes rank earlier in ambiguity resolution. Updated by a batched `$inc`, never in the request path |
| `version`, `digest`, `recordedAt`, `reviewedAt` | — | — |

```json
{
  "_id": "person_sarah",
  "householdId": "demo-household",
  "subjectId": "margaret",
  "nodeType": "person",
  "label": "Sarah",
  "aliases": ["Sal", "my daughter"],
  "attributes": {
    "relationship": "daughter",
    "lastSeenReportedAt": { "$date": "2026-10-22T14:30:00.000Z" },
    "voiceSample": null
  },
  "lifeStatus": "current",
  "sensitivity": "normal",
  "disclosure": { "policy": "state_plainly", "script": null, "decidedBy": "carer_jane",
                  "decidedAt": { "$date": "2026-09-30T10:00:00.000Z" }, "reviewNote": null },
  "searchText": "Sarah, also called Sal, Margaret's daughter. Visits most Thursdays, usually brings photographs.",
  "embedding": null,
  "sourceIds": ["source_caregiver_intake_001"],
  "confidence": 0.95,
  "reviewStatus": "approved",
  "isCurrent": true,
  "supersedes": null,
  "supersededBy": null,
  "hotEdges": [
    { "edgeId": "edge_sarah_child_of_margaret", "edgeType": "child_of", "toId": "subject_margaret", "toLabel": "Margaret", "weight": 1.0 },
    { "edgeId": "edge_sarah_visits_garden", "edgeType": "frequents", "toId": "node_place_margarets_garden", "toLabel": "Back garden", "weight": 0.7 }
  ],
  "activation": { "score": 0.88, "lastRetrievedAt": { "$date": "2026-10-24T09:15:02.000Z" }, "retrievalCount": 214 },
  "version": 3,
  "digest": "4c81…",
  "recordedAt": { "$date": "2026-09-30T09:58:00.000Z" },
  "reviewedAt": { "$date": "2026-09-30T10:00:00.000Z" }
}
```

A `deceased` node, showing why `disclosure` exists:

```json
{
  "_id": "person_albert",
  "householdId": "demo-household",
  "subjectId": "margaret",
  "nodeType": "person",
  "label": "Albert",
  "aliases": ["Bert", "my husband"],
  "attributes": { "relationship": "husband", "lastSeenReportedAt": null, "voiceSample": null },
  "lifeStatus": "deceased",
  "sensitivity": "grief_sensitive",
  "disclosure": {
    "policy": "defer_to_caregiver",
    "script": "Albert isn't here just now. Would you like to tell me about him? Jane said you have the wedding photograph in the hall.",
    "decidedBy": "carer_jane",
    "decidedAt": { "$date": "2026-10-01T11:12:00.000Z" },
    "reviewNote": "Agreed with Sarah and the GP: do not state the bereavement unless Margaret states it first. Never volunteer it. Log every time she asks."
  },
  "searchText": "Albert, Margaret's husband. Married 1961. Worked on the railways.",
  "sourceIds": ["source_caregiver_intake_002"],
  "confidence": 1.0,
  "reviewStatus": "approved",
  "isCurrent": true,
  "lifeStatusChangedAt": { "$date": "2019-03-14T00:00:00.000Z" },
  "version": 2
}
```

The schema does not decide the ethics of therapeutic non-disclosure. It makes the
decision **a named human's, recorded, reviewable, and attached to the entity** — so
the agent can never improvise it, and an auditor can see who chose what and why.

### 5.3 `semantic_edges` `NEW`

| Field | Type | Purpose |
| --- | --- | --- |
| `_id` | `edge_*`, deterministic `sha256(scope, fromId, edgeType, toId)` | Idempotent re-ingestion |
| scope | — | I1 |
| `fromId`, `toId` | node ids | — |
| `edgeType` | enum (closed vocabulary, below) | A closed vocabulary is what makes traversal predictable; a free-text predicate turns `$graphLookup` into a guess |
| `inverseType` | enum | `child_of` ⇄ `parent_of` |
| `pairId` | string | Links the forward doc and its materialized reverse doc. **Both directions are stored**, because `$graphLookup` traverses one direction per stage; a correction updates both under one transaction keyed on `pairId` |
| `direction` | enum `forward` \| `reverse` | Which half of the pair this is. Query filters on `direction: "forward"` when the semantics matter, and ignore it when traversing |
| `weight` | double 0–1 | Associative strength; used to rank traversal results and to build `hotEdges` |
| `temporal` | `{ validFrom, validTo, granularity: "day"\|"month"\|"year"\|"decade" }` | Dementia-care reality: "lives at" changes, "married to" has an end. Fuzzy granularity avoids fabricating a precise date from "sometime in the sixties" |
| `status` | enum `current` \| `historical` \| `disputed` | `disputed` edges are retained and shown side by side, never merged — matching `life-records.js`'s "conflicting reports remain separate" |
| `sourceIds` | array | I2 |
| `confidence` | double \| null | I5 |
| `reviewStatus` | enum `draft` \| `approved` | I3. **Draft edges never enter traversal** — this is how an entity-linking mistake stays invisible to the patient |
| `isCurrent`, `supersedes`, `supersededBy`, `version`, `digest` | — | I4 |

Edge vocabulary:

```
Kinship / social : child_of, parent_of, sibling_of, spouse_of, grandchild_of,
                   friend_of, neighbour_of, cares_for, cared_for_by, clinician_for
Spatial          : lives_at, lived_at, located_in, frequents, born_in
Temporal / life  : occurred_during (→ life_chapters), worked_at, attended
Routine          : part_of_routine, occurs_at, occurs_with, precedes
Object / pet     : owns, owned_by, belongs_to, keeps
Epistemic        : refers_to, same_as, contradicts, derived_from
```

```json
{
  "_id": "edge_8a3f…",
  "householdId": "demo-household",
  "subjectId": "margaret",
  "fromId": "person_sarah",
  "toId": "subject_margaret",
  "edgeType": "child_of",
  "inverseType": "parent_of",
  "pairId": "pair_sarah_margaret_child",
  "direction": "forward",
  "weight": 1.0,
  "temporal": { "validFrom": { "$date": "1964-06-02T00:00:00.000Z" }, "validTo": null, "granularity": "day" },
  "status": "current",
  "sourceIds": ["source_caregiver_intake_001"],
  "confidence": 0.98,
  "reviewStatus": "approved",
  "isCurrent": true,
  "supersedes": null,
  "supersededBy": null,
  "version": 1,
  "digest": "1b9e…",
  "recordedAt": { "$date": "2026-09-30T09:58:00.000Z" }
}
```

### 5.4 Disclosure resolution — a schema-level safeguard

Graph traversal returns *facts*; what the companion may *say* is a separate
decision, resolved from three fields in priority order:

```
1. safety_constraints.doNotMention          → hard veto, no exceptions
2. node.disclosure.policy (if sensitivity != normal) → use `script` verbatim, or defer
3. node.lifeStatus != "current"             → past tense, never proactive
4. otherwise                                → state plainly with source citation
```

This resolution runs **after** retrieval and **before** generation, in
`resolveDisclosure()` (§12.6). It is deliberately not a model decision.

---

## 6. Cross-memory linking

### 6.1 `memory_links` `NEW`

| Field | Type | Purpose |
| --- | --- | --- |
| `_id` | `link_*`, deterministic `sha256(scope, fromStore, fromId, linkType, toStore, toId)` | Idempotent |
| scope | — | I1 |
| `fromStore`, `toStore` | enum `working` \| `episodic` \| `semantic` \| `procedural` \| `autobiographical` \| `safety` | Makes every link self-describing without a join |
| `fromId`, `toId` | string | — |
| `linkType` | enum (below) | — |
| `weight` | double 0–1 | — |
| `createdBy` | enum `caregiver` \| `ingestion` \| `consolidation` \| `agent_proposal` | `agent_proposal` links are drafts by definition |
| `reviewStatus` | enum `draft` \| `approved` | I3 |
| `sourceIds` | array | I2 |
| `confidence` | double \| null | I5 |
| `recordedAt`, `reviewedAt`, `isCurrent`, `supersedes`, `supersededBy` | — | I4 |

Link vocabulary and direction:

| `linkType` | From → To | Meaning and use |
| --- | --- | --- |
| `instantiates` | episodic → semantic | "This visit is an instance of Sarah's Thursday visit routine." Powers "does this happen often?" |
| `evidences` | episodic → semantic | The episode is the evidence for a semantic fact. **Required** before a consolidation job may approve a node or edge |
| `about` | episodic → semantic (person/place/object) | Denormalized into `episodes.semanticRefs` for vector pre-filter |
| `in_chapter` | episodic → autobiographical | Denormalized into `episodes.chapterId` |
| `derived_from` | semantic → episodic | Inverse of `evidences`, materialized for "where did this come from?" in the console |
| `triggers` | semantic → procedural | A routine node triggers a reminder policy. This is the join that turns "Tuesday chapel" into a prompt |
| `governs` | safety → procedural | A safety constraint restricts a procedure. Resolved as a veto, not a ranking signal |
| `grounds` | autobiographical → episodic | Identity anchor supported by episodes ("she was a nurse" ← three episodes) |
| `contradicts` | any → any (same store) | Two approved records disagree. Both stay; the console shows both; the companion says "there are two accounts" |
| `supersedes` | any → any (same store) | Correction lineage, mirrored from the record's own field for graph queries |

### 6.2 Denormalization contract

| Cache | Authoritative source | Rebuilt by | Why cached |
| --- | --- | --- | --- |
| `episodes.semanticRefs` | `memory_links` type `about` | `db/reconcile.js` | `$vectorSearch` pre-filter must be in-document |
| `episodes.personIds` | `memory_links` type `about` where node is a person | ingestion | Already in code and in the search index |
| `episodes.chapterId` | `memory_links` type `in_chapter` | consolidation | Range scan for era questions |
| `semantic_nodes.hotEdges` | `semantic_edges` | consolidation | One-document "who is this to me?" |
| `life_chapters.episodeCount` | `episodes` | nightly | Console display only |

Rule: **a cache may never be the only record of a link.** If `reconcile.js` finds a
`semanticRefs` entry with no approved `memory_links` document, it reports it as a
defect and the retrieval path ignores it (the post-search canonical re-check in
`service.js` already provides this backstop for sources; §12.2 extends it to links).

---

## 7. Procedural memory — rules, tools, action policies

Procedural memory is where a cognitive prosthetic becomes capable of doing harm, so
it is the most constrained store in the schema: **write-once per version, risk-tiered,
and vetoed by safety.**

### 7.1 `procedures` `NEW`

| Field | Type | Purpose |
| --- | --- | --- |
| `_id` | `proc_<procedureId>_v<version>` | Version is part of the identity: a new version is a new document, never an edit |
| scope | — | Household-level policies use `subjectId: "*"`; subject overrides use the real id and win |
| `procedureId`, `version` | string, int | Unique together |
| `title`, `intent` | string | Human-readable; shown in the caregiver console |
| `riskTier` | 0–3 | 0 informational answer · 1 reminder/prompt · 2 contacts a human or writes a medical record · 3 clinical or emergency escalation |
| `trigger` | `{ kind: "schedule"\|"context"\|"utterance"\|"observation"\|"state", match: {…} }` | Declarative, so matching is a query rather than model judgement. `match` is validated per `kind` |
| `preconditions` | array of `{ check, params }` | e.g. `quiet_hours_respected`, `cooldown_elapsed`, `caregiver_approved_plan_exists`, `source_backed` |
| `steps` | array of `{ stepId, toolId, args, onFailure, requiresConfirmation }` | Each `toolId` must exist in `tool_registry` with `maxRiskTier ≥ procedure.riskTier` |
| `guardrails` | `{ maxPerDay, cooldownSeconds, quietHours: {start,end}, requiresApprovedSource: bool, forbiddenTopics[] }` | Mirrors the existing `PROMPT_COOLDOWN_SECONDS` / `QUIET_START` / `QUIET_END` config, per policy instead of globally |
| `escalation` | `{ ladder: [{ afterSeconds, contactRole, channel }], slaSeconds }` | Tier ≥2 requires a non-empty ladder (validator-enforced) |
| `approval` | `{ status: "draft"\|"active"\|"retired", approvedBy, approvedAt, retiredAt, retiredReason }` | Only `active` procedures execute |
| `supersedes` | `_id` of previous version | I4 |
| `digest` | hex over `{trigger, preconditions, steps, guardrails, escalation, riskTier}` | Recomputed on read; mismatch = tampering, execution refused |
| `searchText` | string | `$search` index so caregivers can find a policy by description |

**Write-once enforcement.** `procedures` is in the app user's insert+find-only role
(§14.2). The one permitted mutation — `approval.status` → `retired` — runs under a
separate `policy_admin` role used only by the caregiver console with a named actor.
A behavioural change is a new `version`, so the audit log can answer "which exact
policy ran at 03:40 on the 12th?"

```json
{
  "_id": "proc_medication_reminder_v4",
  "householdId": "demo-household",
  "subjectId": "margaret",
  "procedureId": "medication_reminder",
  "version": 4,
  "title": "Care-plan medication reminder",
  "intent": "Deliver an approved medication reminder, record the self-report, escalate on no response.",
  "riskTier": 2,
  "trigger": {
    "kind": "schedule",
    "match": { "collection": "plans", "filter": { "kind": "medication", "reviewStatus": "approved", "eventStatus": "planned" }, "dueField": "dueAt" }
  },
  "preconditions": [
    { "check": "caregiver_approved_plan_exists", "params": {} },
    { "check": "plan_version_unchanged", "params": {} },
    { "check": "cooldown_elapsed", "params": { "seconds": 30 } },
    { "check": "not_in_quiet_hours", "params": { "override": "allow_for_medication" } }
  ],
  "steps": [
    { "stepId": "deliver", "toolId": "tool.prompt.deliver",
      "args": { "template": "medication_v2", "channel": "phone_pwa" }, "onFailure": "retry_then_escalate", "requiresConfirmation": false },
    { "stepId": "await", "toolId": "tool.task.await_response",
      "args": { "taskType": "await_medication_response", "windowSeconds": 600 }, "onFailure": "escalate", "requiresConfirmation": false },
    { "stepId": "record", "toolId": "tool.medication.record_self_report",
      "args": {}, "onFailure": "escalate", "requiresConfirmation": false }
  ],
  "guardrails": {
    "maxPerDay": 6, "cooldownSeconds": 30,
    "quietHours": { "start": "22:00", "end": "07:00" },
    "requiresApprovedSource": true,
    "forbiddenTopics": ["dose_changes", "diagnosis", "prognosis"]
  },
  "escalation": {
    "ladder": [
      { "afterSeconds": 600, "contactRole": "primary_caregiver", "channel": "push" },
      { "afterSeconds": 1800, "contactRole": "secondary", "channel": "sms" }
    ],
    "slaSeconds": 1800
  },
  "approval": { "status": "active", "approvedBy": "carer_jane", "approvedAt": { "$date": "2026-10-20T08:00:00.000Z" }, "retiredAt": null, "retiredReason": null },
  "supersedes": "proc_medication_reminder_v3",
  "digest": "d93a…",
  "searchText": "medication reminder care plan escalation self report"
}
```

### 7.2 `tool_registry` `NEW`

| Field | Type | Purpose |
| --- | --- | --- |
| `_id` | `tool.<domain>.<action>` | Readable in every trace |
| `inputSchema` | object (`$jsonSchema` fragment) | Args validated before execution, not inside the model |
| `sideEffectClass` | enum `read` \| `notify_patient` \| `write_record` \| `contact_human` \| `device_action` | — |
| `maxRiskTier` | 0–3 | A procedure may not use a tool whose ceiling is below its own tier |
| `requiresCaregiverApproval` | bool | True for every `write_record` touching medical data |
| `rateLimit` | `{ perMinute, perDay }` | Enforced by the executor, recorded in `procedure_runs` |
| `reversible` | bool | Irreversible tools (`contact_human`, `device_action`) require `requiresConfirmation` on the step |
| `status` | enum `active` \| `deprecated` \| `disabled` | A disabled tool disables every procedure that references it — reported by `reconcile.js`, not silently skipped |

### 7.3 `procedure_runs` `NEW` — write-once execution trace

| Field | Type | Purpose |
| --- | --- | --- |
| `_id` | `run_*` | — |
| `idempotencyKey` | string, **unique per scope** | `sha256(procedureId, version, triggerRef, localDay)`. Makes "did this reminder already fire?" a unique-index question, not a race |
| `procedureId`, `procedureVersion`, `procedureDigest` | — | Exactly which policy text ran |
| `triggerRef` | `{ store, id }` | The plan / observation / utterance that fired it |
| `decisionTrace` | array of `{ store, collection, id, role: "evidence"\|"filter"\|"veto"\|"context" }` | **Explainability.** Every memory read in order to act. Lets a caregiver see that the agent escalated *because of* observations X and Y |
| `preconditionResults` | array of `{ check, passed, detail }` | A refusal is as auditable as an action |
| `stepResults` | array of `{ stepId, toolId, status, startedAt, endedAt, error }` | — |
| `outcome` | enum `completed` \| `refused_precondition` \| `vetoed_safety` \| `failed` \| `escalated` \| `superseded` | — |
| `vetoedBy` | `{ constraintId, rule }` \| null | Which safety constraint stopped it |
| `escalatedTo` | array of `{ alertId, contactRole, channel, at }` | — |
| `startedAt`, `endedAt` | Date | — |

`procedure_runs` is append-only and **never TTL'd**: it is the record of what an
automated system did next to a vulnerable person.

### 7.4 Existing scheduling collections `EXISTING`

`plans`, `prompt_jobs`, `prompts`, `context_events` keep their current shape and
their current invariants (worker reconciliation, `dedupeKey` uniqueness, lease
claiming, `planVersion` checks). They are the *execution arm* of procedural memory;
`procedures` is the *policy*. The join is `prompt_jobs.procedureId` +
`procedureVersion` `NEW`, so a prompt in flight can always be traced to the exact
policy version that scheduled it.
---

## 8. Autobiographical memory — identity, history, preferences

Episodic memory holds events; autobiographical memory holds the **self that the
events happened to**. In dementia care this store does the most work per byte: it is
what lets the companion address someone as the person they are rather than as a
patient, and it is what degrades last in the person themselves.

### 8.1 `identity_core` `NEW` — one document per subject

Singleton: `_id = subjectId`. Small, read on almost every turn, cached in process
for the session's lifetime.

| Field | Type | Purpose / cognitive role |
| --- | --- | --- |
| `_id` | `= subjectId` | Singleton by construction; no duplicate-identity bug is possible |
| `householdId` | string | I1 |
| `preferredName` | string | What she is called, which is often not the legal name. First thing the companion needs and the thing a records system usually gets wrong |
| `legalName`, `pronouns`, `dateOfBirth`, `birthPlace` | — | `dateOfBirth` is **encrypted** (§14.5) |
| `languages` | array of `{ code, fluency, isPreferred }` | Reversion to a first language is common; the companion must be able to follow |
| `communication` | `{ paceWordsPerMinute, maxSentenceWords, prefersYesNo, needsRepetition, hearingSide, usesHearingAid, readingAbility }` | Directly parameterizes response generation. Caregiver-set, never inferred |
| `lifeRoles` | array of `{ role, from, to, granularity, sourceIds }` | "Nurse at St Mary's", "mother of three". Identity anchors that make a prompt land |
| `anchorPeople` | array of `{ nodeId, relationship, comfortRank }` | The 3–5 people whose names reliably orient her. Ordered, so a reorientation script has a deterministic first choice |
| `comfortTopics`, `comfortObjects`, `comfortMusic` | arrays of `{ label, nodeId, sourceIds }` | The redirect vocabulary for distress procedures |
| `distressTopics` | array of `{ label, nodeId, reason, decidedBy, decidedAt }` | **Avoid list.** Consulted before every generated response, and before every proactive prompt |
| `knownLosses` | array of `{ nodeId, kind: "bereavement"\|"estrangement"\|"relocation"\|"pet_loss", disclosurePolicy, script, decidedBy, decidedAt }` | Mirrors `semantic_nodes.disclosure` at identity level so a single read gives the companion every sensitive area before it says anything |
| `faithAndCulture` | `{ tradition, observances[], dietaryRules[], notes, sourceIds }` | Routine prompts that violate an observance are a dignity failure, not a bug |
| `consentRef` | `consent_records._id` | Current governing consent (§9.5) |
| `capacityNote` | `{ text, assessedBy, assessedAt, reviewDueAt }` \| null | **A caregiver/clinician's recorded note, not a system judgement.** No field anywhere stores a capacity determination made by software |
| `version`, `digest`, `approvedBy`, `approvedAt` | — | Every change is a version bump with a named approver |

```json
{
  "_id": "margaret",
  "householdId": "demo-household",
  "preferredName": "Margaret",
  "legalName": "Margaret Eileen Doyle",
  "pronouns": "she/her",
  "dateOfBirth": "<encrypted>",
  "birthPlace": "Dublin, Ireland",
  "languages": [{ "code": "en-GB", "fluency": "native", "isPreferred": true },
                { "code": "ga-IE", "fluency": "childhood", "isPreferred": false }],
  "communication": { "paceWordsPerMinute": 110, "maxSentenceWords": 12, "prefersYesNo": true,
                     "needsRepetition": true, "hearingSide": "left", "usesHearingAid": true, "readingAbility": "large_print" },
  "lifeRoles": [
    { "role": "Nurse, St Mary's Hospital", "from": "1962", "to": "1989", "granularity": "year", "sourceIds": ["source_caregiver_intake_003"] },
    { "role": "Mother of Sarah and Thomas", "from": "1964", "to": null, "granularity": "year", "sourceIds": ["source_caregiver_intake_001"] }
  ],
  "anchorPeople": [
    { "nodeId": "person_sarah", "relationship": "daughter", "comfortRank": 1 },
    { "nodeId": "person_thomas", "relationship": "son", "comfortRank": 2 }
  ],
  "comfortTopics": [{ "label": "the garden", "nodeId": "node_place_margarets_garden", "sourceIds": ["source_caregiver_intake_004"] },
                    { "label": "nursing days", "nodeId": null, "sourceIds": ["source_caregiver_intake_003"] }],
  "comfortMusic": [{ "label": "John McCormack recordings", "nodeId": null, "sourceIds": ["source_caregiver_intake_004"] }],
  "distressTopics": [{ "label": "the house sale", "nodeId": null, "reason": "Causes agitation; unresolved with family.",
                       "decidedBy": "carer_jane", "decidedAt": { "$date": "2026-10-01T11:20:00.000Z" } }],
  "knownLosses": [{ "nodeId": "person_albert", "kind": "bereavement", "disclosurePolicy": "defer_to_caregiver",
                    "script": "Albert isn't here just now. Would you like to tell me about him?",
                    "decidedBy": "carer_jane", "decidedAt": { "$date": "2026-10-01T11:12:00.000Z" } }],
  "faithAndCulture": { "tradition": "Roman Catholic", "observances": ["Sunday mass", "Friday abstinence"],
                       "dietaryRules": ["no meat on Fridays"], "notes": "Rosary on the bedside table matters to her.",
                       "sourceIds": ["source_caregiver_intake_005"] },
  "consentRef": "consent_2026_09_30_v2",
  "capacityNote": { "text": "Fluctuating; able to express preferences reliably in the morning.",
                    "assessedBy": "dr_okafor", "assessedAt": { "$date": "2026-09-28T00:00:00.000Z" },
                    "reviewDueAt": { "$date": "2027-03-28T00:00:00.000Z" } },
  "version": 7,
  "digest": "77ab…",
  "approvedBy": "carer_jane",
  "approvedAt": { "$date": "2026-10-01T11:25:00.000Z" }
}
```

### 8.2 `life_chapters` `NEW`

Eras, not dates. The retrieval unit for "tell me about…" questions, and the
scaffolding that makes a fuzzy date ("when the children were small") resolvable.

| Field | Type | Purpose |
| --- | --- | --- |
| `_id` | `chapter_*` | — |
| scope | — | I1 |
| `label` | string | "The Oakfield Road years" — her words where possible |
| `from`, `to` | Date \| null | Normalized bounds for range queries |
| `granularity` | enum `year` \| `decade` \| `era` | Prevents the UI from rendering "1964-01-01" as if the day were known |
| `fuzzyPhrases` | array of string | "when the children were small", "before we moved". Indexed in `$search`; this is how a vague question becomes a date range |
| `placeIds`, `personIds` | arrays of node ids | Pre-filter for episodic search within a chapter |
| `narrative` | string (≤4000) | Caregiver-approved prose; the companion may quote it |
| `searchText`, `embedding` | — | autoEmbed path for `chapters_auto` |
| `sourceIds`, `confidence`, `reviewStatus` | — | I2, I5, I3 |
| `episodeCount` | int | Cache (§6.2) |
| `sensitivity` | enum | A chapter can be sensitive as a whole (e.g. a war, a bereavement period) |

### 8.3 `preferences` `NEW`

Granular, provenance-carrying, and **time-bounded** — preferences change, and acting
on a stale one ("you love the radio on") is a small daily indignity.

| Field | Type | Purpose |
| --- | --- | --- |
| `_id` | `pref_*`, deterministic from `(scope, domain, label)` | Idempotent updates become supersessions |
| `domain` | enum `food` \| `drink` \| `music` \| `routine` \| `environment` \| `touch` \| `clothing` \| `activity` \| `communication` | — |
| `label`, `polarity` | string, enum `likes` \| `dislikes` \| `refuses` \| `requires` | `refuses` / `requires` are near-safety: surfaced to procedures as guardrails |
| `strength` | double 0–1 \| null | I5 |
| `validFrom`, `validTo` | Date | Range-queried at read; expired preferences are not deleted, they stop matching |
| `confirmedBy`, `confirmedAt`, `confirmationCount` | — | Repeated confirmation is the only thing that raises `strength` |
| `sourceIds`, `reviewStatus`, `isCurrent`, `supersedes` | — | I2, I3, I4 |

### 8.4 Existing intake collections `EXISTING`

`personal_records` and `daily_logs` keep their shape from `life-records.js`. They are
**intake**, not the autobiographical store: a caregiver or patient report arrives as
a `personal_record` (draft), is approved, and only then may a consolidation job
propose a `preferences` or `identity_core` change. One field is added:

| Collection | Field | Purpose |
| --- | --- | --- |
| `personal_records` | `promotedTo` `{ collection, id, at, by }` \| null | Closes the loop: a caregiver can see which approved report became which identity fact, and nothing is promoted twice |

---

## 9. Safety and medical memory

This store is held to a different standard than the rest of the schema: **write-once,
never TTL'd, never agent-approved, always evidence-linked, always escalatable to a
named human.**

### 9.1 `safety_constraints` `NEW` — the hard-rule store

Read on every turn before generation and before any procedure step. The only
collection in the system with veto power.

| Field | Type | Purpose |
| --- | --- | --- |
| `_id` | `constraint_*` | — |
| scope | — | I1 |
| `constraintType` | enum `allergy` \| `drug_interaction_flag` \| `do_not_mention` \| `do_not_contact` \| `fall_risk` \| `wandering_risk` \| `dietary` \| `device_restriction` \| `communication_restriction` \| `legal_directive_present` | — |
| `subjectRef` | `{ store, id }` \| null | What it is about (a node, a plan, a topic) |
| `rule` | object, typed per `constraintType` | Machine-checkable. `do_not_mention` → `{ nodeIds[], phrases[] }`; `dietary` → `{ forbidden[] }`; `device_restriction` → `{ toolIds[] }` |
| `severity` | enum `advisory` \| `strict` \| `absolute` | `absolute` cannot be overridden by any procedure at any tier |
| `legalDirectiveRef` | string \| null | **Pointer only.** Advance directives and DNR documents are referenced, never stored here. A care companion must not be the system of record for an end-of-life decision, and must not be able to recite one |
| `effectiveFrom`, `effectiveTo` | Date | — |
| `authority` | `{ kind: "clinician"\|"caregiver"\|"legal", name, role, recordedAt, documentRef }` | A constraint without a named authority is not enforceable or defensible |
| `sourceIds` | array | I2 |
| `reviewStatus` | `approved` only | **Drafts are not permitted**: a half-entered allergy is more dangerous than none, so the validator requires `approved` at insert, with `authority` present |
| `version`, `supersedes`, `isCurrent`, `digest` | — | I4 |

```json
{
  "_id": "constraint_allergy_penicillin",
  "householdId": "demo-household",
  "subjectId": "margaret",
  "constraintType": "allergy",
  "subjectRef": null,
  "rule": { "substance": "penicillin", "reaction": "reported rash and swelling", "action": "never_suggest_never_confirm" },
  "severity": "absolute",
  "legalDirectiveRef": null,
  "effectiveFrom": { "$date": "2026-09-30T00:00:00.000Z" },
  "effectiveTo": null,
  "authority": { "kind": "clinician", "name": "Dr Okafor", "role": "GP",
                 "recordedAt": { "$date": "2026-09-30T00:00:00.000Z" }, "documentRef": "gp_summary_2026_09" },
  "sourceIds": ["source_gp_summary_2026_09"],
  "reviewStatus": "approved",
  "version": 1,
  "isCurrent": true,
  "digest": "e31f…"
}
```

### 9.2 `care_alerts` `NEW` — escalation records

| Field | Type | Purpose |
| --- | --- | --- |
| `_id` | `alert_*` | — |
| scope | — | I1 |
| `idempotencyKey` | unique per scope | `sha256(alertType, triggerRefs, localDay)`. Stops an alert storm from one repeated signal |
| `alertType` | enum `medication_no_response` \| `medication_reported_not_taken` \| `distress_reported` \| `repeated_disorientation` \| `fall_reported` \| `device_offline` \| `symptom_threshold` \| `wandering_signal` \| `audit_chain_break` \| `manual` | — |
| `severity` | enum `info` \| `advisory` \| `urgent` \| `emergency` | Only `manual` alerts may be created at `emergency` by the agent — and `emergency` always means "a human is being contacted now", never "the system is handling it" |
| `state` | enum `raised` \| `notified` \| `acknowledged` \| `resolved` \| `expired_unacknowledged` | — |
| `transitions` | array of `{ from, to, at, by, note }` | **Append-only within the document.** The state field is a cache of `transitions[last].to` |
| `triggerRefs` | array of `{ store, collection, id }` | The evidence. An alert with no refs cannot be inserted |
| `evidenceSummary` | string | Plain language, quoting the record, never diagnosing. "Reminder at 09:00 had no response by 09:10; previous dose reported not taken on 22 Oct." |
| `procedureRunId` | string \| null | Which policy raised it |
| `slaDeadlineAt` | Date | Scanned by the escalation worker; a missed deadline escalates the ladder and appends a transition |
| `notifications` | array of `{ contactRole, contactId, channel, sentAt, deliveredAt, failureReason }` | Delivery is not acknowledgement |
| `acknowledgedBy`, `acknowledgedAt`, `resolution` | — | `resolution` = `{ outcome, note, by, at }` |
| `clinicalClaim` | **absent by design** | There is no field in which the system can record a clinical conclusion |

`care_alerts` has **no TTL index and no delete path in application code.** Resolution
is a transition, not a deletion.

```json
{
  "_id": "alert_01JB2YQ8ZK",
  "householdId": "demo-household",
  "subjectId": "margaret",
  "idempotencyKey": "7f0c…",
  "alertType": "medication_no_response",
  "severity": "urgent",
  "state": "acknowledged",
  "transitions": [
    { "from": null, "to": "raised", "at": { "$date": "2026-10-24T08:10:00.000Z" }, "by": "agent", "note": "No response within 600s window." },
    { "from": "raised", "to": "notified", "at": { "$date": "2026-10-24T08:10:04.000Z" }, "by": "system", "note": "push → primary_caregiver" },
    { "from": "notified", "to": "acknowledged", "at": { "$date": "2026-10-24T08:16:31.000Z" }, "by": "carer_jane", "note": "Calling her now." }
  ],
  "triggerRefs": [
    { "store": "procedural", "collection": "prompts", "id": "prompt_med_20261024_0800" },
    { "store": "procedural", "collection": "plans", "id": "med_8f21c0" },
    { "store": "safety", "collection": "medication_responses", "id": "medresp_20261022_0800" }
  ],
  "evidenceSummary": "The 08:00 medication reminder was delivered and had no response by 08:10. On 22 Oct the 08:00 reminder was answered 'not taken'. These are reported states, not verified doses.",
  "procedureRunId": "run_01JB2YQ4T0",
  "slaDeadlineAt": { "$date": "2026-10-24T08:40:00.000Z" },
  "notifications": [
    { "contactRole": "primary_caregiver", "contactId": "carer_jane", "channel": "push",
      "sentAt": { "$date": "2026-10-24T08:10:04.000Z" }, "deliveredAt": { "$date": "2026-10-24T08:10:09.000Z" }, "failureReason": null }
  ],
  "acknowledgedBy": "carer_jane",
  "acknowledgedAt": { "$date": "2026-10-24T08:16:31.000Z" },
  "resolution": null
}
```

### 9.3 `medication_responses` `EXISTING` — write-once self-reports

Shape unchanged from `medication.ts` (`promptId`, `planId`, `action`, `outcome`,
`sourceType`, `occurredAt`, `dailyLogId`, `dailyLogRecordId`, `caregiverReviewed`),
with `_id = sha256(scope, promptId)` making the retry semantics a unique-index
property. The existing transaction (plan lock → prompt update → daily log →
response → audit) is the reference pattern for every tier-2 write in this schema.

Two additions:

| Field | Purpose |
| --- | --- |
| `procedureRunId` | Join to the policy execution that produced the prompt |
| `contradicts` | `medication_responses._id` \| null — set when a caregiver later records a conflicting observation. **Both records survive**; nothing is rewritten |

The vocabulary stays `reported_done` / `reported_not_done` / `uncertain`. There is no
`administered`, no `adherence_rate`, and no computed compliance score anywhere in the
schema: a self-report is not an ingestion record, and a dashboard metric built from
self-reports would be read as one.

### 9.4 `symptom_ts` and `physiology_ts` `NEW` — time-series

```js
// symptom_ts
{ timeseries: { timeField: "observedAt", metaField: "series", granularity: "minutes" } }
// no expireAfterSeconds — clinical-adjacent observations are retained per policy, not per TTL
```

| Field | Type | Purpose |
| --- | --- | --- |
| `observedAt` | Date | `timeField`. Event time, which may differ from receipt |
| `series` | `{ householdId, subjectId, symptomCode, observerKind }` | `metaField`. `symptomCode` from a fixed internal list (`agitation`, `sleep_disturbance`, `appetite`, `pain_reported`, `confusion_reported`, `mood_reported`) |
| `value` | double \| null | Caregiver-entered ordinal (0–3) where applicable |
| `valueLabel` | string | The label the observer actually chose |
| `observerKind` | enum `caregiver` \| `patient_self_report` \| `clinician` \| `device` | Never `agent` |
| `sourceId` | string | I2 — every point is citable |
| `receivedAt` | Date | Lateness is visible; a chart must not imply a reading happened when it was recorded |
| `note` | string \| null | — |

`physiology_ts` is the same shape for device data (`heartRate`, `steps`,
`bedOccupancy`, `doorEvent`) with `series.deviceId` and a `quality` field
(`ok` \| `suspect` \| `calibration`). The existing `devices` and
`device_observations` collections remain the registry and the low-rate audit copy;
`physiology_ts` is the high-rate analytical store.

**Honesty constraint on these collections:** they support trend *display* to
caregivers with explicit "reported observations" labelling. The schema contains no
threshold that converts a trend into a diagnosis; `symptom_threshold` alerts carry
the caregiver-configured threshold in `triggerRefs` so the alert reads "agitation
reported at 3/3 on four of the last five evenings" rather than "deterioration".

### 9.5 `consent_records` `NEW` — write-once

| Field | Type | Purpose |
| --- | --- | --- |
| `_id` | `consent_*` | — |
| scope | — | I1 |
| `version` | int | New consent = new document |
| `grantedBy` | `{ kind: "subject"\|"attorney"\|"next_of_kin", name, role, evidenceRef }` | Capacity fluctuates; who consented and in what capacity must be on the record |
| `scopeOfConsent` | `{ collections[], purposes[], recipients[] }` | Which stores may be read by whom and for what. Enforced in the API layer, recorded here |
| `proactiveContactAllowed` | bool | Whether the companion may initiate (prompts, rehearsal offers) at all |
| `rehearsalAllowed` | bool | Memory practice is opt-in, as MEMORY-MODEL.md requires |
| `dataRetention` | `{ episodesDays, mediaDays, tsDays, auditDays }` | Drives `deletion_requests`, not TTL indexes |
| `withdrawnAt`, `withdrawnBy`, `supersededBy` | — | Withdrawal is a new record plus a pointer; the original consent is never erased |
| `recordedAt`, `digest` | — | — |

### 9.6 `deletion_requests` `NEW`

Erasure in a system with a hash-chained audit log and GridFS media needs a plan, not
a `deleteMany`.

| Field | Purpose |
| --- | --- |
| `_id`, scope, `requestedBy`, `requestedAt`, `authority` | Who asked, under what right |
| `target` | `{ kind: "subject"\|"episode"\|"media"\|"person_node", id }` |
| `cascade` | Resolved plan: ordered list of `{ collection, filter, mode: "hard_delete"\|"tombstone"\|"retain_with_reason" }` |
| `retainedForReason` | Array of `{ collection, reason }` — e.g. medication self-reports retained under care-record obligations; audit chain tombstoned (digest kept, payload cleared) so the chain still verifies |
| `state` | `requested` → `approved` → `executing` → `completed` \| `rejected` |
| `executionLog` | Per-step counts and timestamps |

Rule: **audit events are tombstoned, never removed** — `detail` is replaced with
`{ erased: true, requestId }` and the digest recomputed over the tombstone with the
original digest preserved in `priorDigest`, so §14.3 verification still terminates.
---

## 10. Time-series design rules

Four time-series collections, all created with `timeseries` options at
`createCollection` time (they cannot be converted later):

| Collection | `timeField` | `metaField` keys | Granularity | TTL | Purpose |
| --- | --- | --- | --- | --- | --- |
| `memory_trace_ts` | `at` | `householdId, subjectId, episodeId, modelVersion` | `hours` | 365d | Decay / reinforcement curve per episode |
| `symptom_ts` | `observedAt` | `householdId, subjectId, symptomCode, observerKind` | `minutes` | none | Caregiver-reported symptom observations |
| `physiology_ts` | `observedAt` | `householdId, subjectId, deviceId, metric` | `seconds` | 180d | Device readings |
| `engagement_ts` | `at` | `householdId, subjectId, channel, eventType` | `minutes` | 180d | Prompt delivered/answered/ignored, response latency, session length |

### 10.1 Why `metaField` is shaped this way

Atlas buckets documents by `metaField` and time. The meta keys are chosen so that
**every query the product actually runs is a single-bucket or contiguous-bucket
scan**:

- "Margaret's agitation this week" → `series.subjectId` + `series.symptomCode` + range.
- "This episode's decay curve" → `series.episodeId` + range. One bucket per ~hour.
- `modelVersion` in the meta, not the measurements, so changing the retention model
  does not mix incomparable curves in one bucket — and an old curve stays plottable
  under its own label.

Anti-pattern avoided: putting `episodeId` in the measurements and only
`subjectId` in meta would make every per-episode chart scan the whole subject's
history.

### 10.2 Constraints these collections impose on the application

| Constraint | Consequence in this design |
| --- | --- |
| No unique indexes | Idempotency via `ts_dedupe` (§2.5) before every append |
| No updates (and only recent deletes) | Nothing that may need correction goes here. `recall_attempts` stays a regular collection precisely because it has an `applied` flag that gets updated |
| `metaField` is immutable per bucket | `symptomCode` can never be renamed in place; a vocabulary change is a new code plus a mapping table |
| Secondary indexes only on `timeField`/`metaField` subfields | No "find all points with value ≥ 3" index — threshold scans are bounded by a meta+time prefix first |

### 10.3 Decay, reinforcement, and what is *not* stored

The retention model itself stays exactly where it is — pure functions in
`memory-model.js`, state in `memory_state`. `memory_trace_ts` is a **sample log of a
derived quantity**, written by the nightly job and by each attempt. Three rules:

1. `estimatedRetention` is written as a sample, never read back as an input. The
   authoritative state is `memory_state.stabilityDays` + `anchorAt`; retention is
   always recomputed. This prevents compounding drift, which MEMORY-MODEL.md already
   warns about ("nightly runs do not repeatedly multiply or mutate stability").
2. Every sample carries `modelVersion`. A parameter change invalidates comparisons,
   and the chart must be able to show where the model changed.
3. No field named `recall_ability`, `cognitive_score`, `decline_rate`, or
   `improvement`. The system logs a heuristic about *items*, not a measurement of a
   *person*.

---

## 11. Indexing strategy

Every index below is created by `db/provision.js`. Existing indexes from
`engram-retrieval/scripts/indexes.js` are preserved verbatim; new ones are additive.

### 11.1 Principles

1. **Scope prefix.** Every regular index starts `{ householdId: 1, subjectId: 1, … }`.
   This gives tenant isolation, index-prefix reuse for scope-only queries, and a
   natural ranged shard key.
2. **ESR order.** Equality → Sort → Range. `episodes` read path is
   `{ householdId, subjectId, reviewStatus, isCurrent, eventStart: -1 }`: four
   equalities, then the sort/range field last.
3. **Partial over sparse where a predicate is stable.** The companion only ever reads
   approved+current episodes, so the hot index is partial on exactly that predicate —
   a fraction of the size, and it cannot be accidentally used for a draft query.
4. **Sparse TTL for conditional expiry.** TTL fires only on documents that *have*
   `expiresAt`; safety-tier documents never get the field (§3.3).
5. **No index on vector arrays.** Only Atlas Vector Search touches them.
6. **Unique indexes carry the scope.** `{ householdId, subjectId, dedupeKey }` unique,
   never `{ dedupeKey }` alone.
7. **Search indexes are immutable.** A mapping or model change gets a new index name
   (`NATIVE-ATLAS.md`), and `provision.js` refuses to edit an existing definition.

### 11.2 Regular indexes

```
working_sessions
  {h,s,channel,lastTurnAt:-1}                           session pickup
  {expiresAt:1} TTL 0                                   expiry
working_memory
  {h,s,sessionId,slotType,lastTouchedAt:-1}             buffer read, per-type eviction
  {h,s,sessionId,activation:-1}                         capacity eviction scan
  {expiresAt:1} TTL 0                                   expiry
  {"boundTo.id":1,h:1,s:1}                              invalidate slots when a bound record is corrected
active_tasks
  {h,s,status,dueAt}                                    worker scan
  {h,s,taskType,status}                                 console
  {h,s,riskTier,slaDeadlineAt} partial{riskTier:{$gte:2}} SLA breach scan
  {h,s,leaseUntil} partial{status:"in_progress"}        lease recovery
  {expiresAt:1} TTL 0 sparse                            tier<=1 cleanup only

episodes                                                 (existing index retained)
  {h,s,reviewStatus,eventStart:-1}                      EXISTING
  {h,s,reviewStatus,isCurrent,eventStart:-1}
      partial {reviewStatus:"approved",isCurrent:true}   companion read path
  {h,s,dedupeKey} unique                                 ingestion idempotency
  {h,s,chapterId,eventStart:-1} sparse                   "the Dublin years"
  {h,s,semanticRefs,eventStart:-1}                       multikey: episodes about a person/place
  {h,s,recurrenceKey,eventStart:-1} sparse               routine detection
  {h,s,"consolidation.state",recordedAt:1}               consolidation queue
  {h,s,supersededBy:1} sparse                            ledger lineage
  {h,s,sensitivity,eventStart:-1} partial {sensitivity:{$ne:"normal"}}  disclosure review

sources
  {h,s,recordedAt:-1}
  {h,s,digest} unique                                    identical-upload dedupe
  {h,s,derivedFrom} sparse                               find transcripts of a recording
  {h,s,"inspection.required"} partial {"inspection.required":true}  caregiver inspection queue

memory_state      {h,s,nextDueAt}                        EXISTING
                  {h,s,episodeId} unique                 one state per episode
                  {h,s,suppressUntil} sparse
recall_attempts   {h,s,episodeId,recordedAt:-1}          EXISTING
                  {h,s,attemptId} unique                 retry idempotency
                  {h,s,applied} partial {applied:false}  recovery inspection
rehearsal_sets    {h,s,day} unique                       EXISTING
practice_slots    {h,s,day,episodeId} unique             EXISTING

semantic_nodes
  {h,s,nodeType,reviewStatus,isCurrent}                  type browse
  {h,s,label:1}                                          exact-name lookup
  {h,s,aliases:1}                                        multikey alias lookup
  {h,s,lifeStatus} partial {lifeStatus:{$ne:"current"}}  safety review queue
  {h,s,"activation.score":-1} partial {reviewStatus:"approved",isCurrent:true}  ambiguity tie-break
semantic_edges
  {h,s,fromId,edgeType,status,reviewStatus}              $graphLookup forward
  {h,s,toId,edgeType,status,reviewStatus}                reverse queries
  {h,s,pairId}                                           paired correction
  {_id}  (deterministic hash)                            idempotent re-ingestion
  {h,s,"temporal.validTo"} sparse                        historical edge sweeps

memory_links
  {h,s,fromStore,fromId,linkType}                         outbound
  {h,s,toStore,toId,linkType}                             inbound ("where did this come from?")
  {h,s,linkType,reviewStatus}                             approval queue
  {h,s,linkType} partial {linkType:"contradicts"}         conflict review

procedures
  {procedureId,version} unique                            write-once per version
  {h,s,"trigger.kind","approval.status",riskTier}          trigger matching
  {h,s,"approval.status"} partial {"approval.status":"active"}  active policy load
tool_registry      {_id} + {status}
procedure_runs
  {h,s,idempotencyKey} unique                             exactly-once execution
  {h,s,procedureId,startedAt:-1}                          policy history
  {h,s,outcome,startedAt:-1}                              failures/vetoes review
  {h,s,"decisionTrace.id"}                                "what did this memory cause?"

identity_core      {_id}  (= subjectId)                    singleton
life_chapters      {h,s,from:1,to:1} · {h,s,reviewStatus}
preferences        {h,s,domain,polarity,isCurrent}
                   {h,s,validFrom:1,validTo:1}
                   {h,s,domain,label} unique partial {isCurrent:true}
personal_records   {h,s,reviewStatus,personId}             EXISTING
                   {h,s,promotedTo:1} sparse
daily_logs         {h,s,reviewStatus,occurredAt}           EXISTING
                   {h,s,activity,occurredAt:-1}

safety_constraints
  {h,s,constraintType,isCurrent,effectiveFrom:-1}          per-turn load
  {h,s,severity} partial {severity:"absolute",isCurrent:true}  veto set
care_alerts
  {h,s,state,slaDeadlineAt}                                escalation worker
  {h,s,idempotencyKey} unique                              alert-storm suppression
  {h,s,severity,state} partial {state:{$in:["raised","notified"]}}  console "needs attention"
  {h,s,"triggerRefs.id"}                                   reverse evidence lookup
medication_responses
  {h,s,promptId} unique                                    EXISTING semantics, now enforced
  {h,s,occurredAt:-1} · {h,s,caregiverReviewed} partial {caregiverReviewed:false}
consent_records    {h,s,version:-1} · {h,s,withdrawnAt} sparse
deletion_requests  {h,s,state,requestedAt}
audit_events
  {h,s,at:-1}                                              timeline
  {h,s,seq} unique                                         hash-chain ordering
  {h,s,action,at:-1} · {h,s,recordId,at:-1}
  {h,s,riskTier,at:-1} partial {riskTier:{$gte:2}}         high-risk review

devices            {h,s,deviceId} unique                   EXISTING
device_observations {h,s,deviceId,observedAt:-1,receivedAt:-1}  EXISTING
assistance_requests {h,s,status,createdAt}                  EXISTING
assistance_candidates {h,s,status}                          EXISTING
plans              {h,s,eventStatus,eventStart}             EXISTING
                   {h,s,kind,dueAt} partial {reviewStatus:"approved",eventStatus:"planned"}
prompt_jobs        {h,status,dueAt} · {h,s,dedupeKey} unique EXISTING
prompts            {h,s,dedupeKey} unique
                   {h,s,status,availableAt}                 EXISTING
context_events     {h,s,observedAt:-1}
ts_dedupe          {_id} + {expiresAt:1} TTL 0
memory_images      {h,s,targetType,targetId,createdAt:-1}
                   {h,s,reviewStatus} partial {reviewStatus:"draft"}  inspection queue
```

`h,s` = `householdId, subjectId`.

### 11.3 Atlas Search and Vector Search indexes

| Index name | Collection | Type | Definition summary |
| --- | --- | --- | --- |
| `episodes_text` `EXISTING` | `episodes` | `search` | `searchText` (lucene.standard); token: `householdId`, `subjectId`, `reviewStatus`, `personIds`; boolean `isCurrent`; date `eventStart`. **Add:** token `sensitivity`, `chapterId`, multikey token `semanticRefs` |
| `episodes_auto` `EXISTING` | `episodes` | `vectorSearch` | `autoEmbed` on `searchText` (`voyage-4`, 1024, cosine) + filters `householdId`, `subjectId`, `reviewStatus`, `isCurrent`, `eventStart`, `personIds`. **Add filters:** `sensitivity`, `chapterId`, `semanticRefs` |
| `episodes_visual` `NEW` | `episodes` | `vectorSearch` | `vector` on `visualEmbedding` (1024, cosine, `scalar` quantization) + same filter set |
| `semantic_text` `NEW` | `semantic_nodes` | `search` | `label` + `aliases` + `searchText` (standard analyzer, plus a `keyword` sub-field on `label` for exact match); token `nodeType`, `lifeStatus`, `sensitivity`, `reviewStatus`; boolean `isCurrent` |
| `semantic_auto` `NEW` | `semantic_nodes` | `vectorSearch` | `autoEmbed` on `searchText` + filters `householdId`, `subjectId`, `nodeType`, `reviewStatus`, `isCurrent`, `lifeStatus` |
| `chapters_auto` `NEW` | `life_chapters` | `vectorSearch` | `autoEmbed` on `searchText` + filters scope, `reviewStatus` |
| `chapters_text` `NEW` | `life_chapters` | `search` | `label`, `fuzzyPhrases`, `narrative`; date `from`, `to` — this is what resolves "when the children were small" |
| `procedures_text` `NEW` | `procedures` | `search` | `title`, `intent`, `searchText`; token `procedureId`, `approval.status`; number `riskTier` |

Operational rules, from `NATIVE-ATLAS.md` and carried forward:

- Search index builds are asynchronous. `provision.js` requests them and prints
  status; it does not claim readiness. Check `READY`/queryable in Atlas before any
  timed demo.
- `provision.js` **never modifies** an existing search index definition. Changing
  model, mode or mappings requires a new name via `VECTOR_INDEX` / `SEARCH_INDEX`.
- Index configuration is not proof of execution. Only `featuresUsed` from a
  successful live query may be claimed.

### 11.4 Sharding and growth

Per-subject data volume is small (thousands of episodes, tens of thousands of
time-series points per year); the realistic scaling axis is **number of households**.

| Collection | Shard key | Why |
| --- | --- | --- |
| `episodes`, `sources`, `semantic_*`, `memory_links`, `audit_events` | `{ householdId: 1, subjectId: 1, _id: 1 }` ranged | Every query carries the scope prefix, so all reads are targeted single-shard. Ranged beats hashed because scope-range reads stay local |
| `physiology_ts`, `engagement_ts` | `{ series.householdId: 1, series.subjectId: 1, observedAt: 1 }` | Time-series sharding must include the meta prefix; appending on `observedAt` is acceptable because writes are already spread across households |
| `working_memory`, `working_sessions` | `{ householdId: 1, subjectId: 1, _id: 1 }` | TTL deletes stay local |
| Hashed | **not used** | Hashed `subjectId` would scatter every scoped read across shards. Revisit only if one household becomes a measured hotspot, and then shard that household's high-rate telemetry only |

Lifecycle: episodes older than `consent_records.dataRetention.episodesDays` go to
**Atlas Online Archive** (archive rule on `eventStart` + scope), keeping them
queryable through the federated endpoint for the caregiver console while leaving the
hot cluster small. Archived episodes are excluded from vector indexes, so the
companion's recall window and the caregiver's audit window are deliberately
different sizes.

Read/write concerns by criticality:

| Operation | Write concern | Read concern | Rationale |
| --- | --- | --- | --- |
| `care_alerts`, `medication_responses`, `safety_constraints`, `consent_records`, `audit_events`, `procedure_runs` | `{ w: "majority", j: true }` | `majority` | A lost acknowledgement or a rolled-back allergy is a safety event |
| `episodes`, `semantic_*`, `identity_core` | `{ w: "majority" }` | `majority` for the approval path, `local` acceptable for search candidates | Candidates are re-checked against canonical records anyway |
| `working_memory`, `engagement_ts`, `memory_trace_ts` | `{ w: 1 }` | `local` | Reconstructible; latency matters more |
---

## 12. Memory retrieval algorithms

The retrieval path is a fixed cycle. It is fixed deliberately: a cognitive prosthetic
that chooses a different route to the same answer on different days is one that
cannot be debugged after an incident.

```
                      ┌─────────────────────────────────────────┐
  utterance ─────────▶│ 0. SAFETY PRECHECK (hard veto)          │
                      └───────────────┬─────────────────────────┘
                                      ▼
        ┌─────────────────────────────────────────────────────────┐
        │ 1. WORKING CONTEXT  session frame + decayed slots       │
        └───────────────┬─────────────────────────────────────────┘
                        ▼
        ┌─────────────────────────────────────────────────────────┐
        │ 2. ROUTE  intent → which stores, in what order          │
        └───┬────────────┬────────────┬────────────┬──────────────┘
            ▼            ▼            ▼            ▼
      3. episodic   4. semantic   5. autobio   6. procedural
         hybrid        graph         chapter      policy match
         recall        expand        ground
            └────────────┴────────────┴────────────┘
                        ▼
        ┌─────────────────────────────────────────────────────────┐
        │ 7. CANONICAL RE-CHECK  (approval, sources, links)        │
        │ 8. DISCLOSURE RESOLUTION                                │
        │ 9. BUDGET + ASSEMBLE  → generation                      │
        │10. WRITE BACK  working slots, activation, engagement     │
        └─────────────────────────────────────────────────────────┘
```

### 12.0 Safety precheck — the short path

Runs before retrieval, on every turn, and can terminate the turn by itself.

```
function safetyPrecheck(scope, utterance, session, now):
    constraints ← cache.get(scope, "constraints", ttl=60s) or
        db.safety_constraints.find({ ...scope, isCurrent: true,
            effectiveFrom: {$lte: now},
            $or: [{effectiveTo: null}, {effectiveTo: {$gt: now}}] })

    # absolute constraints first; they cannot be overridden downstream
    for c in constraints where c.severity == "absolute":
        if matchesConstraint(c, utterance):          # phrase / nodeId / topic match
            audit(scope, "safety_veto", c._id, riskTier=2)
            return VETO(c, script = c.rule.responseScript or DEFAULT_DEFER)

    if detectsDistressReport(utterance):             # explicit self-report only
        raiseOrRefreshAlert(scope, "distress_reported", evidence=[utteranceSourceId])
        # continue; distress does not stop answering, it changes the policy chosen

    if detectsEmergencyReport(utterance):            # "I've fallen", "chest pain"
        run ← executeProcedure(scope, "emergency_escalation", triggerRef=utteranceSourceId)
        return ESCALATED(run)                        # no retrieval, no generation

    return PASS(constraints)
```

The emergency branch returns before any memory is read. A system that searches for
relevant photographs while someone reports chest pain has its priorities encoded
wrongly.

### 12.1 Working context assembly

```
function assembleWorkingContext(scope, sessionId, now):
    session ← db.working_sessions.findOne({ ...scope, _id: sessionId })
    if not session: session ← openSession(scope, channel)

    slots ← db.working_memory.find({ ...scope, sessionId })
                             .sort({ lastTouchedAt: -1 }).limit(24)

    for slot in slots:
        age ← (now - slot.lastTouchedAt) / 1000
        slot.effective ← slot.activation * 2 ** (-age / slot.decayHalfLifeSeconds)

    live ← [s for s in slots if s.effective ≥ 0.15 or s.slotType == "safety_flag"]
    live.sort(by effective desc)

    # bound records may have been corrected since the slot was created (I4)
    for slot in live where slot.boundTo:
        for ref in slot.boundTo where ref.store == "episodic":
            doc ← db.episodes.findOne({ ...scope, _id: ref.id }, { isCurrent: 1, supersededBy: 1 })
            if not doc or not doc.isCurrent:
                invalidate(slot, reason = "bound record superseded")

    return { session, slots: live, focus: session.attentionFocus }
```

Two details that matter in practice. **Decay is computed, never stored**: a nightly
job that wrote decayed activations back would make the buffer's contents depend on
whether the job ran. **Slots are revalidated against canonical records**: if a
caregiver retracted the episode behind "Sarah visited yesterday" ninety seconds ago,
the slot must die, or the companion repeats a retracted claim for the rest of the
session.

### 12.2 Episodic recall — hybrid, pre-filtered, source-re-checked

```
function episodicRecall(scope, query, options, focus, now):
    window ← resolveTimeWindow(query, options, now)      # question-date.ts
    filters ← { reviewStatus: "approved", isCurrent: true }
    if window:        filters.eventStart ← { $gte: window.from, $lt: window.to }
    if options.personId: filters.semanticRefs ← options.personId
    else if focus.personIds: boostIds ← focus.personIds   # soft bias, not a filter
    if options.chapterId: filters.chapterId ← options.chapterId

    # --- candidate generation: three branches, one aggregation -----------------
    pipeline ← [
      { $rankFusion: {
          input: { pipelines: {
            text:     [ $search    { index: "episodes_text", compound: {
                           must:   [{ text: { query, path: "searchText" } }],
                           filter: tokenFilters(scope, filters) } },
                        $limit 20 ],
            semantic: [ $vectorSearch { index: "episodes_auto", path: "searchText",
                           query: { text: query },
                           numCandidates: 200, limit: 20,
                           filter: { ...scope, ...filters } } ],
            visual:   visualBranchIfImageQuery(query)      # omitted when absent
          } },
          combination: { weights: { text: 1, semantic: 1, visual: 0.6 } },
          scoreDetails: true } },
      { $limit: 20 },
      { $match: { ...scope, ...filters, searchText: { $type: "string" } } },
      optional $rerank { query: {text: query}, path: "searchText", numDocsToRerank: 20 },
      { $project: { embedding: 0, visualEmbedding: 0 } }
    ]
    candidates ← episodes.aggregate(pipeline, { maxTimeMS: 20000 })

    # --- canonical re-check: candidates are not answers (I2, I3) ---------------
    grounded ← []
    for c in candidates:
        doc ← db.episodes.findOne({ ...scope, _id: c._id, reviewStatus: "approved", isCurrent: true })
        if not doc: continue                              # corrected between search and read
        srcs ← db.sources.find({ ...scope, _id: { $in: doc.sourceIds } })
        if srcs.isEmpty(): continue                       # I2
        if any(s.inspection.required and not s.inspection.at for s in srcs): continue
        if staleVector(doc): flagForReembed(doc)          # embeddingMeta.inputDigest
        grounded.push({ doc, sources: srcs, fusionScore: c.scoreDetails })

    # --- final ordering --------------------------------------------------------
    for g in grounded:
        g.score ← 0.55 * normalizedFusionRank(g)
                 + 0.20 * (g.doc.salience ?? 0.5)
                 + 0.15 * recencyKernel(g.doc.eventStart, now, halfLifeDays = 30)
                 + 0.10 * (1 if g.doc._id in boostIds-related else 0)
        if g.doc.sensitivity != "normal": g.score *= 0.8   # de-prioritize, never exclude

    return grounded.sort(by score desc).take(5)
```

Three choices worth defending:

- **Pre-filter, not post-filter.** `filter` goes *inside* `$vectorSearch`. Filtering
  after ANN can return an empty set while approved episodes exist, which the
  companion would voice as "I don't have a memory of that" — a false negative that a
  person with dementia has no way to challenge.
- **Retention is not in the ranking.** `estimatedRetention` deliberately does **not**
  appear here. When she asks a question, the most relevant true memory wins. Retention
  only ranks *proactive rehearsal* (§12.7). Mixing the two would mean answering with a
  worse-matching memory because it needed practice.
- **No `$project` inside fusion branches.** `search.js` already enforces this;
  projecting inside a branch silently drops documents from fusion.

### 12.3 Semantic expansion — bounded graph traversal

```
function semanticExpand(scope, seedIds, maxDepth = 2, edgeTypes = null):
    return db.semantic_nodes.aggregate([
      { $match: { ...scope, _id: { $in: seedIds },
                  reviewStatus: "approved", isCurrent: true } },
      { $graphLookup: {
          from: "semantic_edges",
          startWith: "$_id",
          connectFromField: "toId",
          connectToField: "fromId",
          as: "reachable",
          maxDepth: maxDepth - 1,                  # 0 = direct edges only
          depthField: "depth",
          restrictSearchWithMatch: {
            ...scope,
            reviewStatus: "approved",              # I3 — draft edges never traverse
            isCurrent: true,
            status: { $in: ["current", "historical"] },
            ...(edgeTypes ? { edgeType: { $in: edgeTypes } } : {})
          } } },
      { $addFields: { reachable: { $slice: [
          { $sortArray: { input: "$reachable", sortBy: { depth: 1, weight: -1 } } }, 40 ] } } },
      { $lookup: {
          from: "semantic_nodes", localField: "reachable.toId", foreignField: "_id",
          as: "neighbours",
          pipeline: [ { $match: { ...scope, reviewStatus: "approved", isCurrent: true } },
                      { $project: { label:1, nodeType:1, lifeStatus:1, sensitivity:1,
                                    disclosure:1, aliases:1, sourceIds:1, "activation.score":1 } } ] } },
      { $project: { embedding: 0, searchText: 0 } }
    ])
```

| Guard | Reason |
| --- | --- |
| `maxDepth ≤ 2` | Depth 3 in a family graph reaches "my daughter's husband's mother" — technically connected, cognitively noise, and a latency cliff |
| `restrictSearchWithMatch` includes scope | `$graphLookup` does not inherit the outer `$match`; omitting scope here is a cross-tenant leak, and it is the single most dangerous line in the file |
| `reviewStatus: "approved"` inside the restrict clause | An unapproved entity-link guess must not become a spoken relationship |
| `$slice` to 40 | Bounds the document before `$lookup` so a hub node (a care home with 60 residents) cannot blow the 16MB limit |
| `status: "disputed"` excluded | Disputed edges are shown in the console, never traversed for an answer |

For the hot "who is this person to me?" question, traversal is skipped entirely:
`semantic_nodes.hotEdges` answers it from one document, and the graph is only
consulted when the answer needs depth or when `hotEdges` is stale.

### 12.4 Autobiographical grounding

```
function autobiographicalGround(scope, query, now):
    identity ← cache.get(scope, "identity", ttl=300s) or db.identity_core.findOne({ _id: scope.subjectId })

    chapter ← null
    explicitRange ← parseDateExpression(query)            # "in 1972", "last Tuesday"
    if explicitRange:
        chapter ← db.life_chapters.findOne({ ...scope, reviewStatus: "approved",
                      from: { $lte: explicitRange.to }, to: { $gte: explicitRange.from } })
    else if containsFuzzyTimePhrase(query):               # "when the children were small"
        hits ← db.life_chapters.aggregate([
          { $search: { index: "chapters_text", compound: {
              should: [ { text: { query, path: "fuzzyPhrases", score: { boost: { value: 3 } } } },
                        { text: { query, path: ["label", "narrative"] } } ],
              filter: tokenFilters(scope, { reviewStatus: "approved" }),
              minimumShouldMatch: 1 } } },
          { $limit: 3 } ])
        chapter ← hits[0]

    prefs ← db.preferences.find({ ...scope, isCurrent: true, reviewStatus: "approved",
                validFrom: { $lte: now },
                $or: [{ validTo: null }, { validTo: { $gt: now } }] })

    return { identity, chapter, prefs,
             anchors: identity.anchorPeople,
             avoid: identity.distressTopics,
             losses: identity.knownLosses }
```

The chapter, once resolved, becomes an `episodes.chapterId` pre-filter for §12.2 —
turning a vague reminiscence prompt into a cheap indexed range instead of an
unbounded semantic search.

### 12.5 Procedural resolution

```
function proceduralResolve(scope, triggerKind, triggerDoc, context, now):
    candidates ← db.procedures.find({
        householdId: scope.householdId,
        subjectId: { $in: [scope.subjectId, "*"] },        # subject override beats household
        "trigger.kind": triggerKind,
        "approval.status": "active" })
      .sort({ subjectId: -1, riskTier: -1, version: -1 })

    for proc in candidates:
        if sha256(proc.trigger, proc.preconditions, proc.steps,
                  proc.guardrails, proc.escalation, proc.riskTier) != proc.digest:
            audit(scope, "procedure_digest_mismatch", proc._id, riskTier=3)
            raiseAlert(scope, "audit_chain_break", evidence=[proc._id])
            continue                                        # refuse to run tampered policy

        if not triggerMatches(proc.trigger.match, triggerDoc): continue

        # safety veto outranks every policy, at every tier
        veto ← vetoFor(proc, context.constraints)
        if veto: return REFUSED(proc, "vetoed_safety", veto)

        failed ← [c for c in proc.preconditions if not evaluate(c, context, now)]
        if failed: return REFUSED(proc, "refused_precondition", failed)

        for step in proc.steps:
            tool ← db.tool_registry.findOne({ _id: step.toolId, status: "active" })
            if not tool or tool.maxRiskTier < proc.riskTier:
                return REFUSED(proc, "tool_unavailable_or_under_tiered", step)

        if proc.riskTier ≥ 2 and proc.escalation.ladder.isEmpty():
            return REFUSED(proc, "tier2_requires_escalation_ladder", null)

        return SELECTED(proc)

    return NO_POLICY        # the agent does nothing. Silence is a valid, logged outcome.
```

`NO_POLICY` returning "do nothing" is the point: there is no fallback that lets the
model improvise an action when no approved policy matches.

### 12.6 Disclosure resolution

```
function resolveDisclosure(scope, facts, identity, constraints):
    out ← []
    for f in facts:
        node ← f.node or null

        if any(c.severity == "absolute" and f matches c.rule for c in constraints):
            continue                                   # omit entirely, log once per turn

        loss ← identity.knownLosses.find(l => l.nodeId == node?._id)
        policy ← loss?.disclosurePolicy or node?.disclosure?.policy or "state_plainly"

        switch policy:
          case "withhold":            continue
          case "defer_to_caregiver":  out.push({ mode: "script",
                                                 text: loss?.script or node.disclosure.script,
                                                 mayElaborate: false })
          case "redirect":            out.push({ mode: "redirect",
                                                 comfort: pickComfortTopic(identity) })
          case "state_plainly":
              tense ← node?.lifeStatus in ["former","deceased"] ? "past" : "present"
              out.push({ mode: "state", fact: f, tense, cite: f.sourceIds })
    return out
```

`mayElaborate: false` is load-bearing. For a scripted sensitive answer the generator
receives the caregiver's exact words and no latitude to extend them; the companion
reads a human's sentence rather than composing its own about a bereavement.

### 12.7 Rehearsal selection — a different ranking, deliberately

Per `MEMORY-MODEL.md`, unchanged, and shown here only to contrast with §12.2:

```
eligible ← episodes where reviewStatus="approved" ∧ isCurrent ∧ confidence ≥ 0.8
                        ∧ sources available ∧ inspected
                        ∧ sensitivity = "normal"              # added by this schema
                        ∧ memory_state.suppressUntil ∤ now    # added by this schema
                        ∧ memory_state.nextDueAt < endOfDay(day)
rank by  salience * (1 - estimatedRetentionAtDayStart)
take 3, snapshot immutably into rehearsal_sets
```

Answering ranks by **relevance**; rehearsing ranks by **need for practice**. They
share no scoring code, and `sensitivity != "normal"` episodes are eligible to be
*recalled on request* but never *offered* for practice.

### 12.8 Latency budget

| Stage | Budget | Technique |
| --- | --- | --- |
| Safety precheck | 5 ms | 60s in-process cache of `safety_constraints`, invalidated by change stream |
| Working context | 10 ms | Single scoped query, ≤24 docs |
| Identity + preferences | 5 ms | 300s cache keyed on `identity_core.version` |
| Episodic hybrid recall | 300–800 ms | One aggregation; `$rerank` off by default (`NATIVE_RERANK=false`) |
| Canonical re-check | 30 ms | `_id`-list `$in`, covered by `_id` index |
| Semantic expansion | 50 ms | `hotEdges` fast path; `$graphLookup` only when needed |
| Disclosure + assembly | 10 ms | In-process |
| **Total before generation** | **≈ 1.0 s p95** | Measure on the real cluster before any timed demo; `$rankFusion` + autoEmbed adds a model call per query |

Change streams (`engram-retrieval/STREAM-PROCESSING.md`) drive cache invalidation:
watch `safety_constraints`, `identity_core`, `procedures`, and episode
corrections (`updateDescription.updatedFields.isCurrent`) with `fullDocument:
"updateLookup"`, scoped per household. A retraction must reach the live session in
seconds, not at the next cache expiry.
---

## 13. Memory write algorithms

Every write in this system obeys four rules:

1. **Scope-stamped** — `householdId` + `subjectId` on insert, no exceptions.
2. **Idempotent** — deterministic `_id` or a scoped unique `dedupeKey`, so a retried
   request cannot create a second record.
3. **Transactional across collections** when a partial write would mislead a human.
4. **Audited** with a named actor and a risk tier.

### 13.1 Event ingestion — multimodal intake

```
function ingestEvent(scope, payload, actor, now):
    # ---- 1. raw artefact first, always ------------------------------------
    rawDigest ← sha256(payload.bytes or payload.text)
    rawId     ← "source_" + sha256(scope, rawDigest)
    inserted  ← db.sources.insertOne({
        _id: rawId, ...scope,
        sourceType: payload.sourceType,         # caregiver_report | user_report |
                                                # recording_transcript | media_reference
        modality: payload.modality,             # text | speech | image | video | device
        content: payload.modality == "text" ? payload.text : null,
        mediaPtr: payload.modality in ["image","video","speech"] ? gridfsId : null,
        derivedFrom: null, processor: null, digest: rawDigest,
        inspection: { required: payload.modality != "text", by: null, at: null },
        recordedAt: now })
    if duplicateKeyError: return EXISTING(rawId)   # same bytes, same scope → no-op

    # media bytes go to GridFS bucket "engram_images" (image-memory.ts pattern),
    # validated for magic bytes and ≤1MB BEFORE the source row is written

    # ---- 2. derived interpretations are separate, citable records ----------
    derived ← []
    if payload.modality == "speech":
        transcript ← asr(payload.bytes)
        derived.push(insertSource({ sourceType: "recording_transcript", modality: "text",
            content: transcript.text, derivedFrom: rawId,
            processor: { name: asr.name, version: asr.version, at: now },
            inspection: { required: true, by: null, at: null } }))
    if payload.modality == "image":
        caption ← captioner(payload.bytes)
        derived.push(insertSource({ sourceType: "media_reference", modality: "text",
            content: caption.text, derivedFrom: rawId,
            processor: { name: captioner.name, version: captioner.version, at: now },
            inspection: { required: true, by: null, at: null } }))

    # ---- 3. candidate episode, ALWAYS draft -------------------------------
    narrative ← derived.text or payload.text
    dedupeKey ← [payload.kind, payload.personId, localDay(payload.eventStart)].join("|")
    episode ← {
        _id: "episode_" + uuid(), ...scope,
        summary: narrative.slice(0, 2000),
        gist: firstClause(narrative, 280),
        searchText: narrative + " " + keywordTail(narrative, derived),
        sourceIds: [rawId, ...derived.ids],
        personIds: [], semanticRefs: [], chapterId: null,
        eventStart: payload.eventStart, eventEnd: payload.eventEnd ?? null,
        recordedAt: now,
        reviewStatus: "draft",                     # I3 — never auto-approved
        eventStatus: "reported_completed", isCurrent: true,
        place: payload.place ?? null, what: payload.what ?? null,
        confidence: payload.confidence ?? null,    # I5, upstream metadata only
        salience: null,
        sensitivity: "normal", emotionalTone: null,
        visualEmbedding: null,
        embeddingMeta: { textModel: cfg.embeddingModel, textDims: cfg.dimensions,
                         inputDigest: sha256(searchText), generatedAt: null },
        consolidation: { state: "labile", rehearsalCount: 0,
                         lastConsolidatedAt: null, promotedNodeIds: [] },
        recurrenceKey: recurrenceHash(payload), dedupeKey }

    if eventStart > now: reject(400, "Future events belong in plans")   # existing rule

    try: db.episodes.insertOne(episode)
    except DuplicateKey: return EXISTING_BY_DEDUPE(dedupeKey)

    # ---- 4. entity linking → DRAFT links, never approved edges ------------
    mentions ← linkEntities(narrative, scope)       # alias + vector match on semantic_nodes
    for m in mentions where m.score ≥ 0.75:
        db.memory_links.insertOne({
            _id: "link_" + sha256(scope, "episodic", episode._id, "about", "semantic", m.nodeId),
            ...scope, fromStore: "episodic", fromId: episode._id,
            toStore: "semantic", toId: m.nodeId, linkType: "about",
            weight: m.score, createdBy: "ingestion", reviewStatus: "draft",
            sourceIds: [rawId], confidence: m.score, recordedAt: now, isCurrent: true })

    # ---- 5. multimodal vectors, only for inspected media -----------------
    if payload.modality == "image" and inspectionComplete(rawId):
        enqueue(embedVisual, episode._id)           # worker writes visualEmbedding + meta
    # text vectors need no job: EMBEDDING_MODE=auto embeds `searchText` at index time

    audit(scope, "episode_ingested", episode._id, { actor, modality: payload.modality }, riskTier=0)
    return DRAFT(episode)
```

The ordering is the safety property: **raw artefact → machine interpretation →
draft claim → draft link**. Nothing in this function can produce something the
companion will say out loud.

### 13.2 Approval — the only path to patient-visible memory

```
function approveEpisode(scope, episodeId, caregiver, now):
    assert caregiver.role in ["primary_caregiver", "secondary", "clinician"]

    withTransaction:
        ep ← db.episodes.findOne({ ...scope, _id: episodeId, reviewStatus: "draft", isCurrent: true })
        if not ep: abort(409, "Not an approvable current draft")

        srcs ← db.sources.find({ ...scope, _id: { $in: ep.sourceIds } })
        if srcs.count() != ep.sourceIds.length: abort(409, "Missing source evidence")
        for s in srcs where s.inspection.required and not s.inspection.at:
            abort(409, "Inspect the media or transcript before approving")

        db.episodes.updateOne({ ...scope, _id: episodeId, reviewStatus: "draft" },
            { $set: { reviewStatus: "approved", reviewedAt: now,
                      approvedBy: caregiver.id } })

        # links the caregiver implicitly approved by approving the episode
        db.memory_links.updateMany(
            { ...scope, fromId: episodeId, linkType: "about", reviewStatus: "draft" },
            { $set: { reviewStatus: "approved", reviewedAt: now } })

        # read-path caches (§6.2)
        refs ← approved link targets
        db.episodes.updateOne({ _id: episodeId },
            { $set: { semanticRefs: refs, personIds: refs.filter(isPerson) } })

        db.memory_state.insertOne(initialState(ep, scope))    # memory-model.js
        db.memory_trace_ts.insertOne({ at: now,
            series: { ...scope, episodeId, modelVersion: MODEL_VERSION },
            stabilityDays: 1, estimatedRetention: 1.0, event: "state_init" })

        audit(scope, "episode_approved", episodeId, { actor: caregiver }, riskTier=1)
```

Approving the episode approves its `about` links in the same transaction — one
human decision, one atomic effect, rather than a second screen the caregiver will
never visit.

### 13.3 Consolidation — episodic → semantic, nightly

The biologically-motivated step, and the one with the most potential to quietly
corrupt the knowledge graph. It therefore **proposes** and never **approves**.

```
function consolidate(scope, now):             # nightly, after rehearsal generation
    # (a) salience from evidence, not from guesswork
    for ep in db.episodes.find({ ...scope, reviewStatus: "approved", isCurrent: true,
                                 "consolidation.state": { $in: ["labile","consolidating"] } }):
        mentions   ← count of approved memory_links where toId in ep.semanticRefs
        rehearsals ← db.recall_attempts.count({ ...scope, episodeId: ep._id, applied: true })
        anchorHit  ← ep.personIds ∩ identity.anchorPeople ≠ ∅
        salience ← clamp01( 0.4 * normalize(mentions) + 0.3 * normalize(rehearsals)
                          + 0.2 * (anchorHit ? 1 : 0) + 0.1 * (ep.confidence ?? 0.5) )
        db.episodes.updateOne({ _id: ep._id }, { $set: { salience } })

    # (b) routine detection: repeated episodes become a semantic proposal
    groups ← db.episodes.aggregate([
        { $match: { ...scope, reviewStatus: "approved", isCurrent: true,
                    recurrenceKey: { $ne: null } } },
        { $group: { _id: "$recurrenceKey", n: { $sum: 1 },
                    episodeIds: { $push: "$_id" }, last: { $max: "$eventStart" } } },
        { $match: { n: { $gte: 4 } } } ])

    for g in groups:
        nodeId ← "node_routine_" + slug(g._id)
        if db.semantic_nodes.findOne({ ...scope, _id: nodeId }): continue
        db.semantic_nodes.insertOne({
            _id: nodeId, ...scope, nodeType: "routine",
            label: humanize(g._id),
            attributes: { rrule: inferRRule(g.episodeIds), timeOfDay: bucket(g._id) },
            lifeStatus: "current", sensitivity: "normal",
            disclosure: { policy: "state_plainly", script: null, decidedBy: null, decidedAt: null },
            searchText: humanize(g._id) + " routine",
            sourceIds: union(sourceIdsOf(g.episodeIds)),      # I2 — inherited evidence
            confidence: null,                                  # I5 — frequency is not confidence
            reviewStatus: "draft",                             # I3 — PROPOSAL ONLY
            isCurrent: true, version: 1, recordedAt: now })

        for epId in g.episodeIds:
            upsertLink(scope, "episodic", epId, "instantiates", "semantic", nodeId,
                       createdBy = "consolidation", reviewStatus = "draft")
        audit(scope, "routine_proposed", nodeId, { episodes: g.episodeIds.length }, riskTier=1)

    # (c) contradiction detection — surface, never resolve
    for pair in findConflictingApprovedEpisodes(scope):        # same dedupe family, incompatible outcome
        upsertLink(scope, "episodic", pair.a, "contradicts", "episodic", pair.b,
                   createdBy = "consolidation", reviewStatus = "approved")
        audit(scope, "contradiction_detected", pair.a, { other: pair.b }, riskTier=1)

    # (d) trace samples + state advance
    for st in db.memory_state.find({ ...scope }):
        appendTrace(scope, st, event = "nightly_sample", now)  # via ts_dedupe
        # stability is NOT modified here — only attempts change it (MEMORY-MODEL.md)

    # (e) hot caches
    rebuildHotEdges(scope)
    db.episodes.updateMany({ ...scope, "consolidation.state": "labile",
                             salience: { $ne: null } },
        { $set: { "consolidation.state": "consolidating",
                  "consolidation.lastConsolidatedAt": now } })
```

`confidence: null` on a proposed routine is a deliberate refusal: observing something
four times is evidence of frequency, not a probability that it is true, and writing
`0.8` there would be the system inventing a number about someone's life.

### 13.4 Reinforcement on recall

```
function recordAttempt(scope, episodeId, attemptId, cueLevel, outcome, now):
    # immutable attempt first — survives a crash before state update (MEMORY-MODEL.md)
    try:
        db.recall_attempts.insertOne({ _id: attemptId, ...scope, episodeId,
            cueLevel, outcome, recordedAt: now, applied: false })
    except DuplicateKey:
        existing ← db.recall_attempts.findOne({ _id: attemptId, ...scope })
        if existing.cueLevel != cueLevel or existing.outcome != outcome: reject(409)
        if existing.applied: return existing              # true retry, already done

    st ← db.memory_state.findOne({ ...scope, episodeId })
    if outcome == "skipped":
        next ← st                                          # skip preserves everything
    else:
        s2 ← updateStability(st.stabilityDays, cueLevel, outcome == "recalled")
        next ← { stabilityDays: s2, anchorAt: now,
                 nextDueAt: nextDueAt(now, s2), lastRehearsalAt: now,
                 attempts: st.attempts + 1, version: st.version + 1 }

    updated ← db.memory_state.findOneAndUpdate(
        { ...scope, episodeId, version: st.version },      # optimistic concurrency
        { $set: next })
    if not updated: reject(409, "Memory state changed; reload")

    db.recall_attempts.updateOne({ _id: attemptId }, { $set: { applied: true } })
    appendTrace(scope, next, event = "attempt", cueLevel, outcome, attemptId)
    consumePracticeSlot(scope, episodeId, localDay(now))
```

### 13.5 Correction and retraction

The pattern already implemented in `ledger.ts`, generalized to every store:

```
function supersede(collection, scope, recordId, mode, reason, replacementPayload, actor, now):
    withTransaction:
        original ← db[collection].findOne({ ...scope, _id: recordId, isCurrent: true })
        if not original: abort(409, "Record is no longer current. Reload.")

        if mode == "correct":
            src ← insertSource({ sourceType: "caregiver_report", modality: "text",
                                 content: replacementPayload.statement, inspection: { required: false } })
            replacement ← { ...stripDerived(original), _id: newId(collection),
                            ...replacementPayload, sourceIds: [src._id],
                            reviewStatus: "draft",            # a correction is reviewed too
                            isCurrent: true, recordedAt: now, reviewedAt: null,
                            confidence: null,
                            supersedes: recordId, supersededBy: null,
                            correctionReason: reason }
            db[collection].insertOne(replacement)

        db[collection].updateOne({ ...scope, _id: recordId, isCurrent: true },
            { $set: { isCurrent: false, reviewStatus: "draft",
                      retractionReason: reason,
                      supersededBy: replacement?._id ?? null } })

        # paired semantic edges move together or not at all
        if collection == "semantic_edges":
            db.semantic_edges.updateMany({ ...scope, pairId: original.pairId, isCurrent: true },
                { $set: { isCurrent: false, supersededBy: replacement?._id ?? null } })
            insertReversePair(replacement)

        db.audit_events.insertOne(chained(scope, mode == "correct" ? "record_corrected" : "record_retracted",
            recordId, { reason, replacementId: replacement?._id, actor }, riskTier = 1))

    # out-of-band: kill live working-memory slots bound to the retracted record
    db.working_memory.deleteMany({ ...scope, "boundTo.id": recordId })
    invalidateCaches(scope)
```

`stripDerived` removes `embedding`, `visualEmbedding`, `embeddingMeta`,
`contractDigest` and `consolidation` — carrying a vector computed from the old text
onto the corrected record is the exact bug `embeddingMeta.inputDigest` exists to
catch, and copying it forward would defeat it.

### 13.6 Alert and escalation writes

```
function raiseAlert(scope, alertType, severity, triggerRefs, evidenceSummary, procedureRunId, now):
    key ← sha256(alertType, triggerRefs.map(r => r.id).sort(), localDay(now))
    withTransaction({ writeConcern: { w: "majority", j: true } }):
        try:
            db.care_alerts.insertOne({
                _id: "alert_" + uuid(), ...scope, idempotencyKey: key,
                alertType, severity, state: "raised",
                transitions: [{ from: null, to: "raised", at: now, by: "agent", note: evidenceSummary }],
                triggerRefs, evidenceSummary, procedureRunId,
                slaDeadlineAt: now + slaFor(severity),
                notifications: [], acknowledgedBy: null, acknowledgedAt: null, resolution: null })
        except DuplicateKey:
            db.care_alerts.updateOne({ ...scope, idempotencyKey: key },
                { $push: { transitions: { from: "raised", to: "raised", at: now,
                                          by: "agent", note: "repeat signal" } } })
            return EXISTING

        db.active_tasks.insertOne({ _id: taskId(scope, key), ...scope,
            taskType: "escalate", status: "pending", riskTier: severityTier(severity),
            payload: { alertId }, slaDeadlineAt: now + slaFor(severity) })
            # note: no expiresAt → sparse TTL cannot reach it (§3.3)

        db.audit_events.insertOne(chained(scope, "alert_raised", alertId,
            { alertType, severity, triggerRefs }, riskTier = severityTier(severity)))

    notifyLadder(alertId)        # outside the transaction; delivery is retried, not atomic
```

`triggerRefs` is validator-required and non-empty. An alert that cannot name its
evidence cannot be written, which is what stops "the system thinks something is
wrong" from ever reaching a caregiver's phone.

### 13.7 Working-memory write-back

```
function writeBackWorkingMemory(scope, sessionId, turn, now):
    for item in turn.salientItems:
        slotId ← "wm_" + sha256(scope, sessionId, item.slotType, item.contentKey)
        db.working_memory.updateOne({ _id: slotId },
            { $set: { ...scope, sessionId, slotType: item.slotType, content: item.content,
                      boundTo: item.boundTo, provenance: item.provenance,
                      activation: min(1, item.activation),
                      decayHalfLifeSeconds: HALF_LIFE[item.slotType],
                      lastTouchedAt: now,
                      expiresAt: now + 4 * HALF_LIFE[item.slotType] * 1000 },
              $inc: { reinforcementCount: 1 },
              $setOnInsert: { createdAt: now } }, { upsert: true })

    # capacity: 9 non-safety slots
    live ← db.working_memory.find({ ...scope, sessionId, slotType: { $ne: "safety_flag" } })
    if live.length > 9:
        for slot in byEffectiveActivation(live).slice(9):
            db.working_memory.deleteOne({ _id: slot._id })
            if slot.reinforcementCount ≥ 2:
                audit(scope, "working_memory_evicted", slot._id,
                      { content: slot.content, count: slot.reinforcementCount }, riskTier = 0)

    db.working_sessions.updateOne({ ...scope, _id: sessionId },
        { $set: { lastTurnAt: now, attentionFocus: turn.focus,
                  expiresAt: now + 12h },
          $inc: { turnCount: 1,
                  "orientationSignals.repeatedQuestionCount": turn.wasRepeat ? 1 : 0 } })

    appendEngagement(scope, sessionId, turn)     # engagement_ts via ts_dedupe
```

Note the content-keyed slot id: asking "is Sarah coming?" four times reinforces one
slot to `reinforcementCount: 4` instead of filling the buffer with four copies —
which is also how repeated-question support becomes measurable without inferring
anything about the person.

### 13.8 Idempotency and transaction summary

| Write | Idempotency mechanism | Transaction | Why |
| --- | --- | --- | --- |
| `sources` insert | `_id = sha256(scope, contentDigest)` | no | Single document |
| `episodes` ingest | `dedupeKey` unique per scope | no | Single document; links are separate and draft |
| Episode approval | Filtered update on `reviewStatus: "draft"` | **yes** | Episode + links + caches + `memory_state` + trace must agree |
| Medication self-report | `_id = sha256(scope, promptId)` | **yes** (existing) | Plan lock → prompt → daily log → response → audit |
| Recall attempt | `attemptId` unique + `applied` flag | no (two-phase) | Documented recoverable path; `applied: false` is inspectable |
| Correction / retraction | Filtered update on `isCurrent: true` | **yes** | Original + replacement + source + audit; paired edges together |
| Alert raise | `idempotencyKey` unique | **yes** | Alert + task + audit; a missing task means no escalation |
| Procedure run | `idempotencyKey` unique | no | Insert-first, then step results appended |
| Time-series append | `ts_dedupe` insert gate | no | Unique indexes unavailable on time-series |
| Working-memory slot | Content-keyed `_id` upsert | no | Reconstructible |
| Consolidation proposals | Deterministic node/link `_id` | no | Re-running the nightly job is a no-op |
---

## 14. Safety, immutability and compliance

### 14.1 Write-once collections

| Collection | Permitted operations | Permitted mutation |
| --- | --- | --- |
| `sources` | insert, find | `inspection` subdoc only (by caregiver, audited) |
| `audit_events` | insert, find | tombstone on erasure only (§9.6) |
| `medication_responses` | insert, find | `caregiverReviewed`, `contradicts` only |
| `recall_attempts` | insert, find | `applied: false → true` only |
| `procedure_runs` | insert, find | `stepResults` push, terminal `outcome` only |
| `consent_records` | insert, find | `withdrawnAt`, `supersededBy` only |
| `procedures` | insert, find | `approval.status → retired` only, by `policy_admin` |
| `rehearsal_sets` | insert, find | none (immutable daily snapshot, per MEMORY-MODEL.md) |
| `care_alerts` | insert, find, **append-only update** | `transitions` push + derived `state`, `notifications` push, `resolution` set once |
| `memory_trace_ts`, `symptom_ts`, `physiology_ts`, `engagement_ts` | insert, find | none (time-series) |

### 14.2 Enforcing immutability on a platform with no immutable collections

MongoDB has no per-collection write-once flag, so immutability is built from four
mechanisms that each fail safely:

1. **Database roles (the real enforcement).** Three Atlas custom roles:

| Role | Grants | Used by |
| --- | --- | --- |
| `anchorcare_app` | `find` + `insert` on write-once collections; `find`+`insert`+`update` on mutable ones; **no** `remove` anywhere except `working_*`, `ts_dedupe`, `prompt_jobs` | The companion service (`COMPANION_TOKEN` path) |
| `anchorcare_caregiver` | adds `update` on the narrow approved fields (`reviewStatus`, `inspection`, `transitions`, `resolution`), `insert` on `safety_constraints`, `consent_records` | Caregiver console (`ADMIN_TOKEN` path) |
| `anchorcare_policy_admin` | adds `update` on `procedures.approval` | Policy retirement only |

   The application cannot delete a `care_alert` because the credential it holds has
   no `remove` privilege on that collection. That is a stronger guarantee than any
   code review.

2. **Schema validators** (`validationLevel: "strict"`, `validationAction: "error"`)
   require the immutable fields to be present and correctly typed on every insert,
   and forbid the fields that must not exist (e.g. `additionalProperties` closed on
   `care_alerts` so no `clinicalClaim` can be smuggled in).

3. **Digest-on-immutable-core.** Mutable documents keep their immutable facts under a
   fixed subdoc (`procedures.{trigger,steps,guardrails}`,
   `safety_constraints.{rule,authority}`) with a `digest` over exactly those paths.
   Every read recomputes; a mismatch refuses the operation and raises an
   `audit_chain_break` alert (as in §12.5).

4. **Optimistic `version` filters** on every update, so a lost update becomes a 409
   rather than a silent overwrite — the pattern `medication.ts` already uses.

### 14.3 Audit chain

```
seq       = per-scope monotonic counter from a one-document `audit_counters` upsert
           ({_id: scope-hash}, $inc: {seq: 1}) in the same transaction as the event
digest    = sha256(prevDigest ‖ seq ‖ householdId ‖ subjectId ‖ action ‖ recordId ‖
                   canonicalJson(detail) ‖ at.toISOString())
prevDigest= digest of seq-1, or GENESIS for seq 1
```

`db/verify-audit.js` walks each scope in `seq` order and reports the first break, as
a scheduled job and on demand from the console. Properties this gives:

- An event deleted from the middle breaks the chain at the next event.
- A back-dated or edited `detail` breaks its own digest.
- An erasure tombstone (§9.6) preserves `priorDigest`, so the chain still verifies
  across a lawful deletion.

What it does not give: protection against an actor with project-owner rights
rewriting the whole chain. Honest mitigation is off-cluster: nightly export of
`(scope, maxSeq, digest)` checkpoints to append-only storage outside the Atlas
project. Claiming tamper-*proof* would be false; this is tamper-*evident*.

### 14.4 Retention and TTL policy

| Data | Policy | Mechanism |
| --- | --- | --- |
| Working memory, sessions | hours | TTL index |
| `ts_dedupe` | 30 days | TTL index |
| `engagement_ts`, `physiology_ts` | 180 days | time-series `expireAfterSeconds` |
| `memory_trace_ts` | 365 days | time-series `expireAfterSeconds` |
| Episodes, sources, semantic, autobiographical | per `consent_records.dataRetention` | Online Archive + `deletion_requests`, **never TTL** |
| `symptom_ts`, `medication_responses`, `care_alerts`, `safety_constraints`, `consent_records`, `audit_events`, `procedure_runs` | retained until a reviewed `deletion_request` | **No TTL index may exist on these collections.** `provision.js` asserts their absence and fails loudly if one appears |

The assertion in the provisioner matters more than the rule: it turns "we agreed not
to TTL safety data" into a check that runs on every deploy.

### 14.5 Field-level encryption

Atlas Queryable Encryption on the fields where a database-side breach would be a
dignity harm rather than an inconvenience:

| Collection | Encrypted fields | Query type |
| --- | --- | --- |
| `identity_core` | `legalName`, `dateOfBirth`, `capacityNote` | none (fetch-only) |
| `people` / `semantic_nodes` | `contact.phone`, `contact.email` | equality (caregiver lookup) |
| `safety_constraints` | `rule` (for `allergy`, `legal_directive_present`), `legalDirectiveRef` | none |
| `consent_records` | `grantedBy.name`, `grantedBy.evidenceRef` | none |
| `sources` | `content` where `sourceType = "recording_transcript"` | none |

Not encrypted: `episodes.summary`, `semantic_nodes.label`, `searchText`. They cannot
be — they feed Atlas Search and Automated Embedding, which require plaintext. This is
a real, stated trade-off: **the memory narrative itself is protected by network
isolation, scoped roles and audit, not by field encryption.** Private endpoint, IP
access list, no public cluster, and the existing rule that `.env` is never committed.

### 14.6 Clinical and escalation rules encoded in the schema

| Rule | Schema mechanism |
| --- | --- |
| The agent never diagnoses | No field anywhere accepts a diagnosis; `care_alerts` has closed `additionalProperties` and no `clinicalClaim` field; `symptom_ts.observerKind` excludes `agent` |
| Medication is never "verified" | Vocabulary limited to `reported_done` / `reported_not_done` / `uncertain`; no adherence metric field exists |
| No dose or regimen advice | `procedures.guardrails.forbiddenTopics` includes `dose_changes`, `diagnosis`, `prognosis`; tier-2 procedures validator-require an escalation ladder |
| Every patient-facing claim is source-backed | `sourceIds` required and non-empty on episodes, nodes, edges and constraints; retrieval re-checks after search |
| Conflicts are surfaced, not resolved | `memory_links.linkType = "contradicts"`; `semantic_edges.status = "disputed"` excluded from traversal but shown in console |
| A named human owns every sensitive decision | `disclosure.decidedBy`, `knownLosses.decidedBy`, `safety_constraints.authority`, `procedures.approval.approvedBy` — all required |
| Escalation cannot be silently dropped | `care_alerts.slaDeadlineAt` scanned by the worker; tier ≥2 `active_tasks` have no `expiresAt`, so TTL cannot remove them |
| Proactive contact is opt-in | `consent_records.proactiveContactAllowed` and `rehearsalAllowed` checked as procedure preconditions |
| Quiet hours respected | `procedures.guardrails.quietHours` per policy, defaulting to the existing `QUIET_START`/`QUIET_END` |
| Rehearsal is capped and consensual | Existing three-per-day snapshot + `practice_slots`, plus `suppressUntil` and `sensitivity != normal` exclusion |
| An automated action is always attributable | `procedure_runs.{procedureId, procedureVersion, procedureDigest, decisionTrace}` |

### 14.7 What the schema deliberately refuses to store

Listing these is part of the design, because an empty field invites a well-meaning
future contributor to fill it:

- No `cognitiveScore`, `mmseEstimate`, `declineRate`, `adherenceRate`,
  `riskScore`, `moodInference`.
- No inferred emotional state: `emotionalTone.basis` and `affect.basis` must name a
  human report.
- No capacity determination made by software: `capacityNote` carries `assessedBy`.
- No advance-directive or DNR content, only `legalDirectiveRef`.
- No biometric identification: `semantic_nodes.attributes.voiceSample` exists as
  `null` with no write path, and `image-memory.ts`'s existing note stands — approved
  photographs are retrieval material, not face recognition.
- No raw audio retention beyond the consent window, and no audio in the same
  document as its transcript.

---

## 15. Architecture

### 15.1 Text diagram

```
╔══════════════════════════════════════════════════════════════════════════════════╗
║  INPUT                                                                           ║
║  voice ─ phone PWA ─ caregiver console ─ devices ─ images                         ║
╚════════════════════════════════════╤═════════════════════════════════════════════╝
                                     ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│  INGESTION PIPELINE                         (db/ingest.js · §13.1)               │
│  raw bytes → GridFS "engram_images"                                              │
│  raw artefact ──▶ sources (write-once, digest, inspection.required)              │
│       └─ derived ──▶ sources (derivedFrom + processor)                           │
│  draft episode ──▶ episodes (reviewStatus:"draft")                               │
│  entity linking ─▶ memory_links (draft)                                          │
│  visual embed worker ─▶ episodes.visualEmbedding  [only after inspection]         │
└────────────────────────────────────┬─────────────────────────────────────────────┘
                                     ▼
                      ┌──────────────────────────────┐
                      │  CAREGIVER APPROVAL GATE     │  ← the only path to
                      │  (console · §13.2)           │    patient-visible memory
                      └──────────────┬───────────────┘
                                     ▼
╔══════════════════════════════════════════════════════════════════════════════════╗
║  ATLAS DATABASE  `engram`                                                        ║
║                                                                                  ║
║  WORKING            EPISODIC                     SEMANTIC                        ║
║  ┌───────────────┐  ┌──────────────────────────┐ ┌──────────────────────────────┐ ║
║  │working_sessions│ │episodes ◀── sources      │ │semantic_nodes ◀─┐            │ ║
║  │working_memory  │ │  ├ searchText → autoEmbed│ │  hotEdges cache │            │ ║
║  │active_tasks    │ │  ├ visualEmbedding       │ │semantic_edges ──┘ (pairId,   │ ║
║  │  (TTL / sparse)│ │  └ consolidation         │ │   $graphLookup, depth ≤ 2)   │ ║
║  └───────────────┘  │memory_state · attempts   │ │people (canonical cards)      │ ║
║                     │rehearsal_sets · slots    │ └──────────────────────────────┘ ║
║                     │memory_images → GridFS    │                                  ║
║                     └──────────────────────────┘                                  ║
║  AUTOBIOGRAPHICAL              PROCEDURAL                  SAFETY & MEDICAL       ║
║  ┌──────────────────────┐ ┌──────────────────────────┐ ┌────────────────────────┐ ║
║  │identity_core (1/subj)│ │procedures (v-immutable)  │ │safety_constraints ⛔VETO│ ║
║  │life_chapters         │ │tool_registry             │ │care_alerts (append-only)│ ║
║  │preferences           │ │procedure_runs (w-once)   │ │medication_responses    │ ║
║  │personal_records      │ │plans·prompt_jobs·prompts │ │consent_records         │ ║
║  │daily_logs            │ │context_events            │ │deletion_requests       │ ║
║  └──────────────────────┘ └──────────────────────────┘ └────────────────────────┘ ║
║                                                                                  ║
║  SPINE   memory_links (typed cross-store edges) · audit_events (hash-chained)     ║
║  TIME-SERIES  memory_trace_ts · symptom_ts · physiology_ts · engagement_ts        ║
║               (+ ts_dedupe idempotency gate)                                      ║
║                                                                                  ║
║  ATLAS FEATURES                                                                  ║
║   episodes_text ($search) · episodes_auto ($vectorSearch autoEmbed voyage-4/1024)║
║   episodes_visual (voyage-multimodal-3/1024) · semantic_text/_auto               ║
║   chapters_text/_auto · procedures_text                                          ║
║   $rankFusion · optional $rerank · change streams · Online Archive · QE          ║
╚════════════════════════════════════╤═════════════════════════════════════════════╝
                                     ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│  RETRIEVAL ORCHESTRATOR                   (db/retrieval.js · §12)                │
│  0 safety precheck ⛔ ──────────────── veto / emergency escalation → exit          │
│  1 working context (decay-weighted, canonical-revalidated)                        │
│  2 route by intent                                                                │
│  3 episodic hybrid recall   ($rankFusion: text + semantic + visual)               │
│  4 semantic expand          (hotEdges fast path │ $graphLookup ≤ 2)               │
│  5 autobiographical ground  (identity + chapter + preferences)                    │
│  6 procedural resolve       (active policy · digest check · tier gate)            │
│  7 canonical re-check       (approved ∧ isCurrent ∧ sources ∧ inspected)          │
│  8 disclosure resolution    (constraint ▸ script ▸ lifeStatus ▸ plain)            │
│  9 budget + assemble                                                              │
└────────────────────────────────────┬─────────────────────────────────────────────┘
                                     ▼
                    ┌────────────────────────────────────┐
                    │  RESPONSE GATE                     │
                    │  cite sources · no new claims ·    │
                    │  scripted text verbatim ·          │
                    │  pace from identity.communication  │
                    └──────────┬──────────────┬──────────┘
                               ▼              ▼
                    patient response    caregiver console
                                        (ledger · alerts · approvals ·
                                         contradictions · audit · trends)
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│  WRITE-BACK & BACKGROUND                                                         │
│  working slots + activation + engagement_ts   (every turn)                        │
│  consolidation: salience · routine PROPOSALS · contradictions  (nightly)          │
│  rehearsal set generation ≤3/day · trace samples               (nightly)          │
│  escalation worker: SLA scan → ladder → care_alerts transitions (continuous)      │
│  audit chain verification · reconcile caches · re-embed stale   (scheduled)       │
└──────────────────────────────────────────────────────────────────────────────────┘
```

### 15.2 The three control flows worth naming

**The fast reflex.** `safety_constraints` → veto or emergency escalation, before any
retrieval. One cached query, ~5 ms, and it can end the turn. Nothing downstream can
override it.

**The recall loop.** working context → hybrid episodic recall → canonical re-check →
disclosure → response. Every hop narrows: ANN gives 20 candidates, approval and
source checks cut to what is defensible, disclosure decides what may be said, and the
response cites source ids. A claim cannot enter at the end.

**The consolidation loop.** episodes → salience → routine proposals → caregiver
approval → semantic nodes → `triggers` links → procedures → prompts → episodes. This
is the loop that makes the system cumulatively more useful, and the one place a bug
compounds. It is therefore the only loop with a hard rule that it may never approve
its own output.

---

## 16. Provisioning and rollout

```sh
# 1. configure (never commit .env)
export STORE=mongodb MONGODB_URI='...' MONGODB_DATABASE=engram
export EMBEDDING_MODE=auto HYBRID_BACKEND=native
export SEARCH_INDEX=episodes_text VECTOR_INDEX=episodes_auto

# 2. existing collections and indexes (unchanged, still authoritative)
npm run atlas:indexes            # engram-retrieval/scripts/indexes.js

# 3. new cognitive stores: collections, validators, indexes, search indexes
node db/provision.js             # idempotent; prints a plan with --dry-run
node db/provision.js --dry-run

# 4. backfill the semantic layer from existing people/episodes
node db/backfill-semantic.js     # creates draft nodes/edges only

# 5. verify
node db/reconcile.js             # cache divergence report
node db/verify-audit.js          # hash-chain walk
npm run atlas:check              # live native pipeline execution
```

Rollout order matters: `provision.js` is additive and safe to run against a cluster
already serving the existing collections, but **search index builds are asynchronous**
and `backfill-semantic.js` produces only drafts, so the companion's behaviour does
not change until a caregiver approves the backfilled nodes. The sequence is designed
so that no step can make the patient-facing system worse while it is half-finished.

### 16.1 Migration from the current schema

| Step | Action | Reversible |
| --- | --- | --- |
| 1 | Add new collections + validators. No existing document is touched | yes (drop) |
| 2 | Add new indexes on `episodes`, `sources`, `plans`, `audit_events` | yes |
| 3 | Backfill `semantic_nodes` from `people` (same `_id`), `nodeType: "person"`, `reviewStatus: "draft"` | yes |
| 4 | Backfill `semantic_edges` from `personal_records.kind = "person"` relationships, as drafts | yes |
| 5 | Backfill `memory_links` type `about` from `episodes.personIds`, pre-approved (the caregiver already approved those episodes) | yes |
| 6 | Set `episodes.semanticRefs = personIds`, `gist = firstClause(summary)`, `sensitivity = "normal"`, `dedupeKey` from existing fields | yes |
| 7 | Create `identity_core` from existing `personal_records` of kind `fact`/`preference` — **as a draft document requiring approval** | yes |
| 8 | Add `episodes_visual`, `semantic_*`, `chapters_*` search indexes under new names | yes |
| 9 | Enable the three Atlas custom roles; rotate the app credential to `anchorcare_app` | yes, but test first: this is the step that removes delete privileges |
| 10 | Turn on `audit_events` chaining (`seq`/`digest`); chain starts at GENESIS from the migration point, with existing events marked `preChain: true` | one-way |

Step 10 is honest about its limitation: events written before the chain existed
cannot be retroactively protected, and pretending otherwise by computing digests over
them at migration time would manufacture a guarantee that was never there.

---

## 17. Open questions and known limits

These are design gaps, stated rather than hidden. Items 1 and 6 are superseded by
§§23–25 of [`REALTIME-CAPTURE-AND-CLUSTER.md`](./REALTIME-CAPTURE-AND-CLUSTER.md),
which verified them against current Atlas documentation and found this section too
optimistic in two places.

1. **No live validation of the new collections.** Everything here is specified
   against Atlas documentation and the one verified live run on 8.0.34 recorded in
   `docs/LIVE-ATLAS-VERIFICATION.md`. `episodes_visual`, `semantic_auto`,
   `chapters_auto`, Queryable Encryption and the custom roles are **unverified on a
   real cluster**. Verify before claiming them in a demo.
2. **`voyage-multimodal-3` availability** through the Atlas project integration is
   assumed, not confirmed. If unavailable, visual recall degrades to caption text in
   `searchText` — which is a supported path, not a failure, and should be the default
   until confirmed.
3. **Entity linking quality is unmeasured.** The 0.75 threshold in §13.1 is a
   placeholder. Draft-only output limits the harm, but a high false-positive rate
   would bury caregivers in approval work, which is its own failure mode.
4. **Consolidation thresholds** (4 occurrences for a routine, the salience weights)
   are engineering guesses with no evaluation behind them.
5. **Conflict resolution is deferred to humans by design**, which means a household
   with no active caregiver accumulates unresolved contradictions. There is no plan
   yet for what the companion should say after the third contradiction on one topic.
6. **Online Archive + vector search interaction**: archived episodes leave the
   vector index, so the companion's recall horizon silently shrinks at the archive
   boundary. The horizon should be surfaced in the console, and is not yet.
7. **Clinical governance, DPIA, and the ethics of therapeutic non-disclosure** are
   outside this document. The schema records who decided; it does not make the
   decision defensible.
8. **Capacity and consent over time.** `consent_records` models consent as versioned
   documents, but fluctuating capacity means a consent valid in the morning may not
   be valid at 4pm. The schema can record that; the product has not decided what to
   do about it.
