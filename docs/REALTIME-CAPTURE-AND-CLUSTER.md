# Anchorcare — Real-Time Capture, Inference Persistence, and Cluster Architecture

**Status:** design specification, v1 (2026-10-24)
**Continues:** [`ATLAS-MEMORY-SCHEMA.md`](./ATLAS-MEMORY-SCHEMA.md) §§0–17. Section numbering continues from there.
**Implements:** `conversation_sessions`, `conversation_turns`, `inferences`, two read-only views
**Code:** [`db/collections.js`](../db/collections.js), [`db/ingest.js`](../db/ingest.js), [`db/retrieval.js`](../db/retrieval.js), [`db/schema.test.js`](../db/schema.test.js)

---

## 18. The epistemic model: what is stored versus what may be said

### 18.1 The gap this fixes

v1 of the schema had a hole. It stored what the companion **learned** — approved
episodes, semantic facts, medication reports — but not what it **said**, and not what
it **worked out**. Working memory evaporated after twelve hours, so there was no
durable answer to the single most important question a caregiver can ask about an
automated system sitting next to a vulnerable person:

> *"What did it tell her at three in the morning?"*

And by refusing to store inferences at all, v1 made the system unauditable
(you cannot review a judgement that was never written down) and unimprovable
(you cannot measure an error rate on discarded output).

The fix is not to relax the safety rules. It is to separate two things v1 had
conflated: **what we record** and **what we are willing to repeat to the patient.**

### 18.2 Three epistemic tiers

Every fact in the system now carries one of three statuses, and the status decides
the read path it is eligible for:

```
┌──────────────┬──────────────────────────┬────────────────┬──────────────────────┐
│ TIER         │ MEANING                  │ STORED?        │ SPEAKABLE TO PATIENT?│
├──────────────┼──────────────────────────┼────────────────┼──────────────────────┤
│ observed     │ It happened and we have  │ YES,           │ Only once promoted   │
│              │ the artefact: her words, │ write-once     │ into an approved     │
│              │ a photo, a device read   │                │ record               │
├──────────────┼──────────────────────────┼────────────────┼──────────────────────┤
│ generated    │ The companion produced   │ YES,           │ NEVER as evidence.   │
│              │ this sentence            │ append-only    │ Context only         │
├──────────────┼──────────────────────────┼────────────────┼──────────────────────┤
│ inferred     │ The system worked it out │ YES,           │ NEVER. Promotion is  │
│              │ from observations        │ quarantined    │ the only route out   │
├──────────────┼──────────────────────────┼────────────────┼──────────────────────┤
│ approved     │ A named human ratified   │ YES, the       │ YES, with citations  │
│              │ it                       │ canonical form │                      │
└──────────────┴──────────────────────────┴────────────────┴──────────────────────┘
```

The one rule that makes the model work:

> **An observation or an inference becomes speakable only by being promoted into an
> approved record with a human's name on it.** Storing something has no bearing on
> whether it can be said.

### 18.3 Why `generated` is its own tier

This is the subtlest and most important distinction in the whole schema, so it is
worth being explicit about the failure it prevents.

Suppose the companion is asked "did Sarah visit?", retrieval finds nothing, and the
model produces a plausible-sounding "Yes, Sarah came on Tuesday." If that sentence is
stored as ordinary conversation history and the history is searchable as evidence,
then tomorrow's question retrieves it, cites it, and repeats it. The day after, the
consolidation job sees the claim three times and proposes it as a routine. Within a
week an invention has become a fact in the knowledge graph, supported by three
"independent" observations that are all the same hallucination echoing.

That is the **confabulation loop**, and in dementia care it is not a quality problem.
A person with dementia frequently cannot challenge a confident false memory — the
system's account will win. So:

- Patient speech is `observed` and gets a write-once `sources` record. **Her words
  are evidence.**
- Companion output is `generated`, gets `sourceId: null`, and is excluded from every
  evidence path. **Its words are not evidence, at any confidence level.**

Enforcement is layered, not a convention (§21):

| Layer | Mechanism |
| --- | --- |
| Data | `conversation_turns.epistemic`, and `sourceId` is `null` on every generated turn |
| Query | `PATIENT_ONLY` filter inside `$vectorSearch` and `$search`, re-asserted after fusion |
| Code | `buildCompanionTurn()` throws if `groundedOn` cites a generated turn or an inference |
| Database | the companion credential has **no `find`** on `conversation_turns`; it reads the `patient_utterances` view |
| Test | eight tests in `db/schema.test.js` assert each of the above |

Citing a generated turn as `role: "context"` is fine and necessary — it is how the
thread stays coherent across turns ("as I mentioned"). Citing it as
`role: "evidence"` throws.

---

## 19. Real-time capture

### 19.1 `conversation_sessions` — the durable counterpart

`working_sessions` (§3.1) is the volatile scratchpad: attention focus, pending
confirmations, TTL twelve hours. `conversation_sessions` is the permanent record that
the conversation happened. **They share the same `_id`**, so one session identifier
addresses both lifetimes.

| Field | Purpose |
| --- | --- |
| `_id` | `= working_sessions._id`. One id, two lifetimes |
| `channel`, `initiatedBy` | Who started it. `initiatedBy: "companion"` means the system reached out — the thing consent governs |
| `startedAt`, `endedAt`, `durationMs` | — |
| `turnCount`, `patientTurnCount` | A session with 40 companion turns and 3 patient turns is a system talking to itself; the ratio is a usable health signal |
| `signals` | Counters only: `repeatedQuestionCount`, `distressReports`, `safetyVetoes`, `escalations`, `scriptedDisclosures`, `retrievalFailures`. **Reported events, never an inferred cognitive state** |
| `summaryEpisodeId` | The draft episode written at close, if any. Draft like any other ingested claim |
| `consentRef` | Which consent version governed this conversation |
| `modelRefs` | Every model used, so a bad release is traceable to the sessions it touched |
| `closeReason` | `patient_ended` \| `idle_timeout` \| `caregiver_ended` \| `error` \| `escalated` |

`signals.retrievalFailures` counts turns the companion answered with
`groundedOn: []` — nothing retrieved. It is the honest measure of how often the
system is talking without evidence, and it should be on the caregiver dashboard.

### 19.2 `conversation_turns` — what was actually said

Durable, append-only, one document per turn in both directions.

| Field | Type | Purpose |
| --- | --- | --- |
| `_id` | `turn_<sessionId>_<seq:6>` | Deterministic (a retried write cannot duplicate) **and** lexically sortable in turn order |
| `sessionId`, `seq` | string, int | Unique together per scope |
| `role` | `patient` \| `companion` \| `caregiver` \| `system` | — |
| `epistemic` | `observed` \| `generated` | Hard-wired by role (§18.3) |
| `text` | string ≤8000 | Immutable. Not in the `APPEND_ONLY` mutable set |
| `transcript` | `{ engine, version, language, confidence, isFinal, partialCount, alternatives[] }` \| null | Speech turns only. `confidence` is the engine's own number — uncalibrated, like every other confidence in this schema. `partialCount` is kept for diagnostics; **partial hypotheses are not stored**, only finals |
| `audio` | `{ storage, ref, bytes, durationMs, retainUntil }` | **Pointer only, and retention defaults to `none`.** See §19.4 |
| `sourceId` | string \| null | The write-once `sources` document for a patient turn. Always `null` for a companion turn |
| `groundedOn` | array of `{ store, collection, id, role }` | Explainability for ordinary conversation, not just for procedures. `role` ∈ `evidence` \| `filter` \| `veto` \| `context` \| `script` |
| `disclosure` | `{ policy, nodeId, scriptUsed, constraintIds[] }` | If the companion read a caregiver's bereavement script, that is recorded. `scriptUsed: true` turns are reviewable as a group |
| `safety` | `{ precheck, vetoConstraintId, alertIds[] }` | What the safety gate did on this turn |
| `model` | `{ name, version, promptDigest, temperature, tokensIn, tokensOut }` | **Required on generated turns.** Without it a response cannot be reproduced, attributed to a release, or distrusted after the fact |
| `latency` | `{ retrievalMs, generationMs, firstTokenMs, totalMs }` | — |
| `inferenceIds` | array | What was inferred from or for this turn |
| `caregiverAnnotation` | `{ flag, note, by, at }` | `good` \| `wrong` \| `concerning` \| `unclear`. The improvement signal a transcript alone cannot give |
| `redacted`, `redactionRef` | bool, string | Erasure without breaking the sequence |

```json
{
  "_id": "turn_wsession_2026-10-24T09:12Z_margaret_000004",
  "householdId": "demo-household",
  "subjectId": "margaret",
  "sessionId": "wsession_2026-10-24T09:12Z_margaret",
  "seq": 4,
  "role": "patient",
  "epistemic": "observed",
  "text": "Is Sarah coming today?",
  "startedAt": { "$date": "2026-10-24T09:15:02.000Z" },
  "endedAt": { "$date": "2026-10-24T09:15:04.000Z" },
  "transcript": {
    "engine": "whisper-large-v3", "version": "2026-04", "language": "en-GB",
    "confidence": 0.91, "isFinal": true, "partialCount": 6, "alternatives": []
  },
  "audio": { "storage": "none", "ref": null, "bytes": 0, "durationMs": 2100, "retainUntil": null },
  "sourceId": "source_9ee9e3a1c4b7…",
  "groundedOn": [],
  "disclosure": null,
  "safety": { "precheck": "pass", "vetoConstraintId": null, "alertIds": [] },
  "model": null,
  "latency": null,
  "inferenceIds": ["inf_576afee434a7fc…"],
  "caregiverAnnotation": null,
  "redacted": false,
  "redactionRef": null
}
```

The companion's reply to it:

```json
{
  "_id": "turn_wsession_2026-10-24T09:12Z_margaret_000005",
  "householdId": "demo-household",
  "subjectId": "margaret",
  "sessionId": "wsession_2026-10-24T09:12Z_margaret",
  "seq": 5,
  "role": "companion",
  "epistemic": "generated",
  "text": "Sarah isn't due today — she came on Thursday and you had tea in the garden. Jane has her down for this Thursday again.",
  "startedAt": { "$date": "2026-10-24T09:15:05.000Z" },
  "endedAt": { "$date": "2026-10-24T09:15:06.000Z" },
  "transcript": null,
  "audio": { "storage": "none", "ref": null, "bytes": 0, "durationMs": 0, "retainUntil": null },
  "sourceId": null,
  "groundedOn": [
    { "store": "episodic", "collection": "episodes", "id": "episode_visit_001", "role": "evidence" },
    { "store": "procedural", "collection": "plans", "id": "plan_visit_sarah_20261029", "role": "evidence" },
    { "store": "semantic", "collection": "semantic_nodes", "id": "person_sarah", "role": "context" },
    { "store": "safety", "collection": "safety_constraints", "id": "constraint_do_not_mention_house_sale", "role": "filter" }
  ],
  "disclosure": { "policy": "state_plainly", "nodeId": "person_sarah", "scriptUsed": false, "constraintIds": [] },
  "safety": { "precheck": "pass", "vetoConstraintId": null, "alertIds": [] },
  "model": {
    "name": "gemini-4-argon", "version": "2026-09",
    "promptDigest": "c1b7e94a0df25386", "temperature": 0.2,
    "tokensIn": 1844, "tokensOut": 34
  },
  "latency": { "retrievalMs": 412, "generationMs": 760, "firstTokenMs": 240, "totalMs": 1198 },
  "inferenceIds": [],
  "caregiverAnnotation": null,
  "redacted": false,
  "redactionRef": null
}
```

Those two documents together are the artefact that makes the system reviewable: her
exact words, the companion's exact words, the four records it read, the policy that
governed the phrasing, the model version, and the time it took.

### 19.3 The turn write path

Ordering is a safety property, not an optimization:

```
   t=0ms   audio / text arrives
           │
     2ms   ├─ load session frame (process cache, keyed on working_sessions.expiresAt)
     5ms   ├─ SAFETY PRECHECK  (constraints cached 60s, invalidated by change stream)
           │     └─ veto / emergency → write turn, escalate, STOP
           │
    25ms   ├─ ▓▓ WRITE: patient turn + source  ── transaction, w:"majority"
           │     • BEFORE retrieval and generation, deliberately.
           │     • If anything downstream crashes, the record of what she
           │       said survives. The alternative is a system that loses her
           │       words precisely when it fails to answer her.
           │     • Both inserts tolerate E11000: a retried request is a no-op.
           │
    35ms   ├─ assemble working context (decayed slots, canonical revalidation)
   450ms   ├─ RETRIEVAL  $rankFusion(text, semantic[, visual])
   480ms   ├─ canonical re-check  (approved ∧ isCurrent ∧ sources ∧ inspected)
   485ms   ├─ disclosure resolution
  1245ms   ├─ GENERATION
           │
  1250ms   ├─ ◀── EMIT TO PATIENT  (user-perceived latency ends here)
           │
  1260ms   ├─ ░░ WRITE: companion turn + session counters   w:1
  1270ms   └─ ░░ WRITE: inference upserts, engagement_ts    w:1, fire-and-forget
```

| | Added by durable capture | Share of budget |
| --- | --- | --- |
| Pre-generation (blocking) | ~20–25 ms | ≈ 2% |
| Post-emission (non-blocking) | ~20 ms | 0% perceived |

**Durable capture is cheap.** The argument for discarding conversation was never
about cost; it was an unexamined default. Two small documents per turn, one
transaction, about 2% of a turn's latency budget.

Implementation: `recordPatientTurn()` and `recordCompanionTurn()` in
[`db/ingest.js`](../db/ingest.js). Only the patient-turn write is transactional —
a lost companion turn is a gap in the record, while a lost patient turn plus its
source would be a claim with no evidence, which the approval gate would then reject
and the caregiver would never understand.

### 19.4 Audio: default off, pointer only, consent-governed

Audio is the highest-risk and highest-volume artefact in the system, so:

- **Retention defaults to `storage: "none"`.** The transcript is kept; the waveform
  is not. Turning it on requires `consent_records.scopeOfConsent` to say so.
- When retained, bytes go to **object storage (S3), not GridFS.** Reasons: at
  15 min/day/household, audio is ~1.8 MB/day versus ~1.5 MB/day for *everything else
  combined*; GridFS puts that on the cluster's hot storage and its index; and
  Online Archive does not support GridFS, so archived audio would have nowhere to go.
  GridFS stays where it already is in this codebase — small approved images
  (`engram_images`, ≤1 MB, `image-memory.ts`).
- `audio.retainUntil` is a hard deadline enforced by a sweeper, separate from any TTL
  index, because the object lives outside MongoDB.
- The raw audio and its transcript are **two separate source records** linked by
  `derivedFrom`, so "she never said that, the recogniser invented it" is answerable.

### 19.5 Conversation search, and its horizon

Two indexes on `conversation_turns`:

| Index | Type | Use |
| --- | --- | --- |
| `conversation_text` | `search` | Exact-ish lookup: "when did she mention the pier?" |
| `conversation_auto` | `vectorSearch`, autoEmbed on `text` | Semantic recall over what she has said |

Both declare `role`, `epistemic` and `redacted` as **filter** fields, which is what
makes the patient-only constraint a pre-filter rather than a hope.
`conversationSearchPipeline()` applies it unconditionally and throws if a caller
tries to widen it.

**Sizing, which forces a design decision.** At ~200 patient turns/day, one household
generates ~73,000 utterance vectors per year. At 1024 dimensions and 4 bytes per
dimension that is ~300 MB of raw vectors per household-year; a thousand households
would be ~300 GB of vector index. Vector-indexing every utterance forever does not
scale, so:

1. **Bound the vector index with a rolling window.** Turns older than 90 days go to
   Online Archive, which removes them from the cluster and therefore from the search
   indexes (§23.1). Turn-level *semantic* recall covers 90 days.
2. **Long-term semantic recall lives in `episodes`**, which are far fewer (a handful
   per day) and are caregiver-approved — the right unit for "tell me about the
   seaside trip" anyway.
3. **Quantization** on the vector index cuts footprint substantially; whether
   `type: "autoEmbed"` accepts a `quantization` setting is listed as unverified in
   §24. The manual `episodes_visual` index already specifies `scalar`.
4. **Surface the horizon.** The caregiver console must show that the companion can
   semantically search the last 90 days of conversation while the caregiver can read
   the full history through the archive. A silently shrinking recall window is the
   open question §17.6 flagged; this is the answer.
---

## 20. Inference persistence

### 20.1 `inferences` — stored, quarantined, promotable

Everything the system works out for itself now gets written down. What it does *not*
get is a route to the patient.

| Field | Purpose |
| --- | --- |
| `_id` | `inf_<sha256(scope, type, claimDigest)>` — the same claim is one record, however many times it is observed |
| `inferenceType` | `entity_link` · `intent` · `topic` · `repeated_question` · `orientation_signal` · `affect_signal` · `routine_candidate` · `preference_candidate` · `relationship_candidate` · `symptom_signal` · `session_summary` · `contradiction_candidate` · `retrieval_miss` |
| `claim` | Structured payload, shape per type |
| `claimDigest` | `sha256(type, claim)`; unique with `inferenceType` per scope |
| `epistemicStatus` | `inferred` → `corroborated` → `caregiver_confirmed` \| `caregiver_rejected` \| `expired`. The system may only ever write the first two |
| `confidence` | 0–1, the model's own score |
| `calibration` | **`"uncalibrated"` is the only permitted value.** A validator-enforced label saying this number is not a probability of truth |
| `visibility` | **`"caregiver_only"` is the only permitted value.** There is deliberately no patient-visible inference. The enum has no second member to set |
| `basis` | **Required, `minItems: 1`.** An inference that cannot name what it was derived from cannot be inserted |
| `observationCount` | Independent observations. Crossing `CORROBORATION_THRESHOLD` (3) flips the status word to `corroborated` |
| `firstObservedAt`, `lastObservedAt` | — |
| `sessionId`, `turnId` | Provenance back into the capture layer |
| `model` | Name, version, prompt digest |
| `promotion` | `{ state, targetCollection, targetId, decidedBy, decidedAt, reason }` |
| `contradicts` | Other inference ids this one disagrees with |
| `expiresAt` | **Sparse TTL.** Written only for low-stakes types. See §20.3 |

```json
{
  "_id": "inf_576afee434a7fc1b0d9e2a4c7f853016",
  "householdId": "demo-household",
  "subjectId": "margaret",
  "inferenceType": "routine_candidate",
  "claim": { "label": "Afternoon tea in the garden", "rrule": "FREQ=WEEKLY;BYDAY=TH", "timeOfDay": "afternoon" },
  "claimDigest": "9c4b1e70a2f5d386…",
  "epistemicStatus": "corroborated",
  "confidence": 0.72,
  "calibration": "uncalibrated",
  "visibility": "caregiver_only",
  "basis": [
    { "store": "episodic", "collection": "conversation_turns", "id": "turn_…_000004" },
    { "store": "episodic", "collection": "episodes", "id": "episode_visit_001" },
    { "store": "episodic", "collection": "episodes", "id": "episode_visit_019" },
    { "store": "episodic", "collection": "episodes", "id": "episode_visit_027" }
  ],
  "observationCount": 4,
  "firstObservedAt": { "$date": "2026-10-01T15:02:00.000Z" },
  "lastObservedAt": { "$date": "2026-10-24T09:15:02.000Z" },
  "sessionId": "wsession_2026-10-24T09:12Z_margaret",
  "turnId": "turn_…_000004",
  "model": { "name": "gemini-4-argon", "version": "2026-09", "promptDigest": "a71b4c9e205d38f6" },
  "promotion": {
    "state": "proposed", "targetCollection": "semantic_nodes", "targetId": null,
    "decidedBy": null, "decidedAt": null, "reason": null
  },
  "contradicts": [],
  "recordedAt": { "$date": "2026-10-01T15:02:00.000Z" }
}
```

Note `expiresAt` is absent: a routine candidate is clinical-adjacent context about
someone's life and must not quietly vanish.

### 20.2 Lifecycle

```
  turn / episode / device reading
            │
            ▼
   ┌──────────────────┐   observed again (same claimDigest)
   │  inferred        │◀─────────────────────────────┐
   │  observationCount│                              │
   │  = 1             │─── $inc observationCount ────┘
   └────────┬─────────┘      $addToSet basis
            │  observationCount ≥ 3
            ▼
   ┌──────────────────┐
   │  corroborated    │   repetition, NOT truth. The word changes; nothing else does.
   └────────┬─────────┘
            │  promotable type only (§20.4)
            ▼
   ┌──────────────────┐
   │  proposed        │──▶ inference_review_queue  ──▶  caregiver console
   └────────┬─────────┘
            │
      ┌─────┴──────┐
      ▼            ▼
 caregiver_    caregiver_
 confirmed     rejected        (both terminal, both named, both audited)
      │
      ▼
 DRAFT document in the target store
      │
      ▼
 ordinary approval gate (§13.2)  ──▶  approved, speakable, cited
```

Two gates stand between an inference and the patient's ears: a caregiver has to
*promote* it, and the promoted document still lands as a **draft** that has to be
*approved*. A promotion is a statement that the claim is worth considering, not that
it is true.

### 20.3 Retention: the sparse-TTL discipline, again

| Type | TTL | Reason |
| --- | --- | --- |
| `intent`, `topic` | 30 days | Routing diagnostics. Useless after the conversation |
| `retrieval_miss`, `entity_link` | 90 days | Quality telemetry; a quarter is enough to spot a regression |
| `session_summary` | 180 days | Superseded by the approved episode if one was made |
| `routine_candidate`, `preference_candidate`, `relationship_candidate`, `symptom_signal`, `contradiction_candidate` | **none** | Claims about a person's life and health. These never receive an `expiresAt`, so the TTL monitor cannot reach them — the same mechanism that protects tier-2 `active_tasks` (§3.3) |

`INFERENCE_TTL_DAYS` in `db/ingest.js` is the single place this is decided, and a
test asserts that every promotable type is absent from it.

### 20.4 What stays a diagnostic, permanently

`PROMOTABLE` maps only five types to a target store:

```js
routine_candidate       → semantic_nodes
preference_candidate    → preferences
relationship_candidate  → semantic_edges
symptom_signal          → symptom_ts
contradiction_candidate → memory_links
```

Everything else — `intent`, `topic`, `orientation_signal`, `affect_signal`,
`retrieval_miss`, `repeated_question`, `session_summary`, `entity_link` — has **no
promotion path at all.** `proposeInference()` throws on them.

`orientation_signal` and `affect_signal` are the ones worth dwelling on. The system
can notice that the same question was asked five times in ten minutes, and it stores
that. What it must never do is turn that into a stored conclusion about the person's
cognition or mood. So the signal is recorded with its basis, shown to the caregiver
as *"asked about Sarah five times between 09:08 and 09:18"*, and has nowhere to be
promoted to. There is no `cognitiveScore` field for it to become, which §14.7
already promised and this section honours.

`affect_signal` is stored, and the corresponding **approved** field
(`episodes.emotionalTone`) still requires `basis` to be a human report. An inferred
affect signal can prompt a caregiver to write one; it cannot become one by itself.

### 20.5 What the inference store buys

| Capability | Why it needed persistence |
| --- | --- |
| Error measurement | `caregiver_rejected / (confirmed + rejected)` per `inferenceType` is a real precision metric. Discarded inferences give you nothing to measure |
| Corroboration | Promotion waits for three *independent* observations, which requires remembering the first two |
| Incident reconstruction | "Why did it say that?" is answered by the turn's `groundedOn` plus the inferences live at the time |
| Prompt and threshold tuning | `model.promptDigest` groups inferences by prompt version, so a change's effect on precision is measurable |
| Caregiver leverage | One review queue, ranked by `observationCount`, instead of the caregiver having to notice patterns unaided |
| Contradiction surfacing | `contradicts[]` lets two incompatible candidates sit side by side, consistent with the existing "conflicting reports remain separate" rule |

---

## 21. How MongoDB enforces this (not conventions)

Three mechanisms, in increasing order of how hard they are to bypass.

### 21.1 Read-only views give row-level read control

MongoDB has no field- or row-level read ACL, but it has views, and a role can be
granted `find` on a view while being denied `find` on the underlying collection.
That is genuine row-level read control.

```js
// db/collections.js — created by db/provision.js
patient_utterances  = view on conversation_turns
  [ { $match: { role: "patient", epistemic: "observed", redacted: { $ne: true } } },
    { $project: { householdId:1, subjectId:1, sessionId:1, seq:1, text:1,
                  startedAt:1, sourceId:1,
                  "transcript.confidence":1, "transcript.isFinal":1, "transcript.engine":1 } } ]

inference_review_queue = view on inferences
  [ { $match: { "promotion.state": "proposed",
                epistemicStatus: { $in: ["inferred", "corroborated"] } } },
    { $sort: { observationCount: -1, lastObservedAt: -1 } } ]
```

The companion credential has `find` on `patient_utterances` and **no `find` on
`conversation_turns`**. It writes generated turns and can never read them back. Not
"should not" — cannot.

**Known limitation, stated rather than papered over:** Atlas Search and Vector Search
indexes are defined on collections, not views, so `conversationSearchPipeline()` must
run against `conversation_turns` directly. For that path the guarantee is the
mandatory `role`/`epistemic` pre-filter plus the post-fusion `$match`, backed by
tests — code-enforced, not role-enforced. It is the one place in this design where the
database is not the last line of defence, and it is the place to look first if
something goes wrong.

### 21.2 Four database users, least privilege

| Role | Grants | Notably **denied** |
| --- | --- | --- |
| `anchorcare_companion` | `find`+`insert` on episodic/semantic/procedural reads; `insert` on `conversation_turns`, `sources`, `audit_events`; `find` on `patient_utterances`; `find`+`insert`+`update` on `working_*`, `active_tasks`; `insert` on `inferences` | **no `find` on `conversation_turns`** · **no `find` on `inferences`** · no `update` on anything write-once · no `remove` outside `working_*`, `ts_dedupe`, `prompt_jobs` |
| `anchorcare_caregiver` | adds `find` on `conversation_turns`, `inferences`, `inference_review_queue`; `update` on the `APPEND_ONLY` field sets; `insert` on `safety_constraints`, `consent_records` | no `remove` anywhere |
| `anchorcare_policy_admin` | adds `update` on `procedures.approval` | nothing else |
| `anchorcare_stream` | `insert` on `symptom_ts`, `physiology_ts`, `engagement_ts`, `ts_dedupe`; `find` on `devices` | no access to any memory or safety collection |

Insert-without-find on `inferences` is the shape that matters: the companion is
*required* to write down what it worked out, and *unable* to read it back and act on
it. In-session use of an inference goes through `working_memory` with
`provenance: "agent_inference"`, which is TTL'd and non-citable by §3.2.

A fifth, break-glass admin user exists for incident response, kept out of any
deployment config, with an Atlas alert on its authentication.

### 21.3 Validators close the doors that should not exist

`additionalProperties: false` and single-value enums do work that documentation
cannot:

```js
inferences.visibility   : { enum: ["caregiver_only"] }   // no patient value exists
inferences.calibration  : { enum: ["uncalibrated"] }     // no "calibrated" value exists
inferences.basis        : { minItems: 1 }                // no unsourced inference
care_alerts             : additionalProperties: false    // no clinicalClaim can be added
symptom_ts.observerKind : excludes "agent"               // the system cannot observe a symptom
```

A future contributor who wants to make an inference patient-visible has to change the
schema, the validator, the role grants, the view, and four tests. That is the point:
the barrier should be visible, and crossing it should require a decision.

---

## 22. Cluster architecture

### 22.1 Organization and project layout

```
Atlas Organization: anchorcare
├── Project: anchorcare-dev        ── synthetic data ONLY
│   └── Cluster  engram-dev        M10, coupled search, no QE, no CMK
├── Project: anchorcare-staging    ── synthetic data ONLY, prod topology
│   ├── Cluster  engram-staging    M10 + 2 × S20 search nodes
│   └── Stream Processing workspace
└── Project: anchorcare-prod       ── real patient data
    ├── Cluster  engram-prod       M30 + 2 × S30 search nodes
    ├── Stream Processing workspace
    ├── Federated instance         (auto-created by Online Archive)
    └── Online Archive rules       conversation_turns, episodes, engagement_ts
```

A **project** is the boundary for network access lists, database users, and alerts,
so environments must not share one. Dev and staging carry a hard rule: **no real
patient data, ever**, which is why neither needs Queryable Encryption or
customer-managed keys — there is nothing there to protect. Enforce it with a seeding
script that refuses to run against a prod connection string, not with a wiki page.

### 22.2 Production cluster

| Choice | Value | Reason |
| --- | --- | --- |
| Tier | **M30** | M10 is the *minimum* that unlocks dedicated Search Nodes, Online Archive and private endpoints. M30 is the smallest tier I would run *this* workload on: retrieval executes on every conversational turn while change streams, multi-document transactions and TTL sweeps compete for the same CPU |
| Topology | 3-node replica set | `w: "majority"` needs two nodes to acknowledge; two-node deployments cannot survive one failure while keeping majority writes |
| Region | **eu-west-2 (London)**, single region | UK data residency for health-adjacent personal data. Multi-region would scatter it; see §22.7 for the growth path |
| MongoDB | **8.0+** | `$rankFusion` requires 8.0+ and is verified live on 8.0.34 (`docs/LIVE-ATLAS-VERIFICATION.md`). `$rerank` stays off: the current reference lists 9.0+ with additional cluster requirements (`engram-retrieval/NATIVE-ATLAS.md`) |
| Search | **Dedicated Search Nodes, 2 × S30** | Atlas requires a minimum of two for HA; S20+ is the production recommendation. See §22.3 |
| Storage | Auto-scaling enabled, alert at 70% | Growth is storage-driven, not CPU-driven (§22.8) |
| Backup | Continuous Cloud Backup + PITR | §22.6 |
| Encryption at rest | Customer-managed keys via AWS KMS | §22.5 |
| Network | AWS PrivateLink private endpoint, **no public access** | §22.4 |

### 22.3 Why dedicated Search Nodes, specifically

By default `mongod` and `mongot` share a node and its resources. For this workload
that coupling is the wrong trade in three distinct ways:

1. **Contention on the critical path.** A hybrid retrieval runs on *every* turn. On a
   coupled node it competes with the medication-reminder write, the TTL sweep and the
   change-stream readers. A 400 ms retrieval becoming 2 s is a conversation that
   stalls while someone is waiting for an answer.
2. **Availability during maintenance.** On coupled nodes `mongot` can become
   unavailable during scaling, failover, restarts and upgrades. With dedicated nodes a
   proxy routes queries only to healthy nodes where `mongot` is live. Degraded
   retrieval means the companion answers "I don't have a memory of that" to a question
   it could have answered — a false negative the person cannot challenge.
3. **Encryption coverage.** Customer-managed encryption applies to database data but
   **not** to search indexes on coupled nodes. Search Node Data Encryption, available
   only with dedicated nodes, brings the search indexes under the same keys. Since the
   indexes contain `searchText` — the narrative of someone's life in plaintext, which
   §14.5 admits cannot be field-encrypted because Atlas Search needs plaintext — this
   is the only way to get those bytes under customer keys.

**Blocking item to verify before committing to London.** Dedicated Search Nodes are
available in all supported Google Cloud regions but only a **subset** of AWS and Azure
regions. If `eu-west-2` is not among them, the choice is:

- coupled search in London (prototype-grade retrieval, keeps residency), or
- dedicated nodes in another AWS region (breaks single-region UK residency), or
- Google Cloud `europe-west2` (London) instead of AWS.

Check this first. It can change the cloud provider decision, and it is cheaper to
discover now than after the data is in.

### 22.4 Network and authentication

```
   caregiver console (ECS/Fargate)      companion service (ECS/Fargate)
            │                                      │
            └──────────────┬───────────────────────┘
                           │  VPC, private subnets only
                           ▼
                  AWS PrivateLink endpoint
                           │
                           ▼
              ┌────────────────────────────┐
              │  Atlas project: prod       │
              │  • public access: DISABLED │
              │  • IP access list: empty   │
              │    (PrivateLink only)      │
              └────────────────────────────┘
```

- **No public endpoint and an empty IP access list.** Every client reaches the cluster
  through PrivateLink from inside the VPC, including the caregiver console. A laptop
  on a home network cannot connect even with valid credentials.
- **AWS IAM authentication** for both services, so no database password exists in any
  environment variable, task definition or `.env`. This is a direct extension of the
  existing rule that `.env` is never committed — the strongest version of that rule is
  having no password to commit.
- **Atlas database auditing on**, with the audit log shipped to append-only object
  storage outside the project. That off-cluster destination is also where the
  `(scope, maxSeq, digest)` checkpoints from §14.3 go, which is what turns
  tamper-*evidence* into something an attacker with project-owner rights cannot
  silently defeat.

### 22.5 Encryption, and the constraint it imposes on retrieval

| Layer | Mechanism | Covers |
| --- | --- | --- |
| At rest | Customer-managed keys, AWS KMS | Database files, backups, oplog |
| At rest (search) | Search Node Data Encryption, same CMK | Search and vector indexes — **requires dedicated Search Nodes** |
| In transit | TLS 1.2+ | All client connections |
| Field level | Queryable Encryption | §14.5 field list |
| Archive | **Provider SSE (e.g. SSE-S3), not the cluster CMK** | Archived data. A compliance note, not a choice — Online Archive cannot use the cluster's encryption-at-rest keys |

**The constraint.** Queryable Encryption's automatic-encryption client supports only a
defined set of aggregation stages. `$text` is unsupported, `$search` is not on the
supported list, and `$rerank` is explicitly unsupported. A `$lookup` cannot join on an
encrypted field. So a single QE-enabled client cannot run the retrieval pipeline.

The architecture follows from that: **two client connections, by purpose.**

```
┌──────────────────────────────────────┬─────────────────────────────────────────┐
│ RETRIEVAL CLIENT (no QE)             │ IDENTITY CLIENT (QE enabled)            │
├──────────────────────────────────────┼─────────────────────────────────────────┤
│ episodes, sources, semantic_*,       │ identity_core, consent_records,         │
│ life_chapters, procedures,           │ safety_constraints.rule,                │
│ conversation_turns, memory_links     │ people.contact, encrypted sources       │
│                                      │                                         │
│ $search · $vectorSearch ·            │ find / equality only. No $search,       │
│ $rankFusion · $graphLookup           │ no $text, no $rerank, no join on an     │
│                                      │ encrypted field                         │
└──────────────────────────────────────┴─────────────────────────────────────────┘
```

Which means the encrypted set must be chosen so that **nothing in it is ever a search
target or a join key** — satisfied by the §14.5 list (`legalName`, `dateOfBirth`,
`capacityNote`, contact details, constraint rules, consent grantor), all of which are
fetched by `_id` or by equality. Encrypting `episodes.summary` would have broken
retrieval entirely, which is why §14.5 ruled it out and why that trade-off is stated
plainly rather than hidden.

### 22.6 Backup, and what it cannot do

Continuous Cloud Backup with point-in-time recovery, retention aligned to
`consent_records.dataRetention.auditDays`.

**PITR is cluster-wide.** There is no mechanism to restore one household's documents
to an earlier moment. This is not a gap to work around but a fact that shapes the
operational model: single-household data errors are repaired *forward*, using the
mechanisms the schema already has —

- a wrong episode → `supersede()` (§13.5): the original stays, superseded, auditable
- a wrong semantic edge → correct the pair in one transaction
- a wrong promotion → `caregiver_rejected` plus a new proposal
- an accidental mass write → identify it via the audit chain by `seq` range and
  `actor`, then supersede the affected records

A restore is reserved for cluster-level loss. Practise it on staging and record the
RTO; an untested restore is a hope, not a plan.

### 22.7 Sharding: not yet, and the plan for when

Per-household data is small. The scaling axis is **number of households**, and a
replica set handles a great many of them. Shard when one of these is true, not before:

| Trigger | Threshold |
| --- | --- |
| Storage | > 2 TB, or the largest tier's storage in sight |
| Write throughput | sustained writes saturating the primary |
| Residency | a second jurisdiction requiring its data to stay put |

When that happens:

```
episodes, sources, conversation_turns,     →  ranged { householdId: 1, subjectId: 1, _id: 1 }
memory_links, audit_events, inferences         every query carries the scope prefix, so
                                               reads stay targeted to one shard

physiology_ts, engagement_ts,              →  { series.householdId: 1, series.subjectId: 1,
memory_trace_ts                                 <timeField>: 1 }

semantic_nodes, semantic_edges,            →  UNSHARDED, on the primary shard
identity_core, safety_constraints,
procedures, tool_registry, life_chapters

Residency                                  →  zone sharding: tag shards by jurisdiction,
                                               zone ranges on householdId
```

`semantic_edges` stays unsharded for two reasons: it is tiny (hundreds of documents
per household), and `$graphLookup`'s behaviour with a sharded `from` collection is
version-dependent. Keeping the graph on the primary shard avoids making the most
safety-sensitive traversal in the system depend on a detail that needs re-verifying
every upgrade.

**Hashed shard keys are not used.** Hashing `subjectId` would scatter every scoped
read across all shards, turning each turn's retrieval into a cluster-wide scatter-gather.

### 22.8 Capacity model

Per household per day, with audio retention off (the default):

| Data | Volume/day | Notes |
| --- | --- | --- |
| `conversation_turns` | ~400 turns × 1.5 KB ≈ 600 KB | The dominant collection |
| `sources` (patient turns) | ~200 × 0.5 KB ≈ 100 KB | |
| `inferences` | ~150 × 1 KB ≈ 150 KB | Most expire within 30–90 days |
| `engagement_ts` | ~400 points ≈ 20 KB | Time-series compression |
| `physiology_ts` | ~10 k points ≈ 200 KB | Device-dependent |
| `episodes` + links | ~3 × 3 KB ≈ 10 KB | |
| `working_*` | transient | TTL'd within hours |
| **Total** | **≈ 1.1 MB/day → ~400 MB/year** | ~2× with indexes |
| *audio, if enabled* | *~1.8 MB/day* | *Larger than everything else combined. S3, not GridFS, and off by default* |

Scaling that out:

| Households | Raw/year | With indexes | Hot (90-day window) |
| --- | --- | --- | --- |
| 10 (pilot) | 4 GB | 8 GB | 2 GB |
| 100 | 40 GB | 80 GB | 20 GB |
| 1,000 | 400 GB | 800 GB | 200 GB |

So: **a 90-day hot window plus Online Archive keeps the cluster small indefinitely,
while total retention grows linearly.** At 1,000 households the hot working set is
~200 GB — comfortable on M30 with auto-scaling storage — and the archive absorbs the
rest. Without archiving, the same deployment outgrows its tier in roughly two years.

Vector index sizing is the separate constraint, and the one that forced the 90-day
window in §19.5. Episodes contribute ~1,000 vectors/household/year (~4 MB raw);
conversation turns contribute ~73,000 (~300 MB raw). The turn index must be bounded
by retention, quantized, or both.

### 22.9 The reactive loop: change streams and Stream Processing

Two mechanisms with different jobs:

**Change streams (in-process, per household scope)** — the cache-invalidation and
live-update path:

| Watched | Purpose | Urgency |
| --- | --- | --- |
| `safety_constraints` | Invalidate the 60 s constraint cache | **Seconds.** A new allergy or do-not-mention must reach a live conversation, not wait for a cache to expire |
| `episodes` (`updatedFields.isCurrent`) | Kill `working_memory` slots bound to a retracted record | **Seconds.** Otherwise the companion repeats a retracted claim for the rest of the session |
| `identity_core`, `procedures` | Invalidate caches | Minutes |
| `conversation_turns` | Live transcript in the caregiver console | Seconds |
| `care_alerts` | Push to the caregiver app | **Immediate** |

Use `fullDocument: "updateLookup"` and persist resume tokens. **Resumability is bounded
by the oplog window**: a worker down longer than the window loses its position and must
fall back to a full reconciliation pass. That is why oplog window is an alerting metric
in §22.10, and why `db/reconcile.js` exists as the fallback.

**Atlas Stream Processing (separate workspace)** — device telemetry into the
time-series collections, as described in `engram-retrieval/STREAM-PROCESSING.md`:
device source → validate → `ts_dedupe` gate → `$merge` into `physiology_ts` /
`symptom_ts`. It runs in its own workspace with its own connection registry and its
own database user (`anchorcare_stream`), which has no access to any memory or safety
collection. A compromised device feed can write noisy readings; it cannot read
anyone's life story. Region availability for Stream Processing needs checking
alongside Search Nodes (§24).

### 22.10 Monitoring: the alert that matters most is a query

Infrastructure alerts, each tied to a care consequence rather than a dashboard colour:

| Alert | Threshold | Care consequence |
| --- | --- | --- |
| Replication lag | > 10 s | `w: "majority"` writes slow; escalation delivery is delayed |
| Oplog window | < 24 h | Change-stream workers cannot resume; cache invalidation silently stops |
| Search index not queryable | any | Retrieval degrades to false negatives |
| Connection saturation | > 80% | Turns start failing |
| Transaction abort rate, medication path | > 1% | Self-reports are being dropped |
| TTL deletion backlog | `working_memory` count rising monotonically | Working memory stops being bounded |
| CPU steal / IOPS saturation | sustained | Conversation latency |

And the one that actually matters:

```js
// Not a cluster metric. A data condition, evaluated every minute.
db.care_alerts.find({
  state: { $in: ["raised", "notified"] },
  slaDeadlineAt: { $lt: new Date() }
})
```

**A non-empty result means a human was asked for help and has not answered.** No
amount of green infrastructure makes that acceptable, and no infrastructure metric
will surface it. `db/reconcile.js` already reports this condition as a defect; in
production it should page someone. It is the clearest example of a principle worth
stating outright: in a care system, the critical alerts are about the people, and they
live in the data, not in the metrics.
---

## 23. Corrections to the v1 specification

Verifying the cluster features against current Atlas documentation invalidated four
things v1 asserted. They are corrected here rather than quietly edited, because the
reasoning that produced the wrong version is worth seeing.

### 23.1 Online Archive and the recall horizon — now authoritative

v1 §11.4 said archived episodes "are excluded from vector indexes" and §17.6 listed
the shrinking recall window as an open question. Both were right, but by inference.
The documented position is firmer: Online Archive inherits Atlas Data Federation's
limitations, and **`$search`, `$searchMeta` and `$vectorSearch` are not supported
against archived data.**

So the boundary is hard, not gradual:

| | On the cluster | Archived |
| --- | --- | --- |
| `find` by `_id` / range | yes | yes (slower; object storage) |
| `$search` / `$vectorSearch` | yes | **no** |
| Writes | yes | **no** (read-only) |
| GridFS | yes | **not archivable at all** |

Which makes the 90-day turn window in §19.5 a product decision to state openly rather
than a limitation to hide: *the companion can semantically search the last 90 days of
conversation; the caregiver can read the whole history.* Put that sentence in the
console.

The GridFS exclusion also means approved images cannot follow episodes into the
archive. Image lifecycle needs its own policy: keep (small, bounded) or delete per
`consent_records.dataRetention.mediaDays`. Archiving is not an option.

### 23.2 Erasure from the archive — v1's cascade was wrong

v1 §9.6 modelled `deletion_requests.cascade` with per-collection `hard_delete` /
`tombstone` modes, assuming documents could be deleted wherever they lived. **Online
Archive does not support deleting individual documents.** You can delete an entire
archive or set a retention period of 7–9125 days; nothing finer.

The real runbook for an erasure request touching archived data:

```
1. Restore the affected documents from the archive to the cluster, via $merge
2. Delete them on the cluster
3. Delete the entire online archive
4. Recreate the archive rule
   (Atlas purges a deleted archive's data five days later; irreversible)
```

Consequences the schema and the operations model have to absorb:

- Erasure requests touching archived data must be **batched**, not served
  individually. Step 3 is disruptive and steps 1–4 cost a full archive rebuild.
- Erasure has a **floor latency of days**, not minutes. Say so when a request is
  acknowledged rather than implying immediacy.
- `deletion_requests` needs a `cascade[].mode` of `"archive_rebuild"` alongside the
  existing modes, and `executionLog` needs to record the rebuild.
- Choose archive targets partly on erasure likelihood. `engagement_ts` is a safe
  archive target; conversation turns are the hardest, because they are exactly what a
  person is most likely to ask to have erased.

This cuts against the §22.8 capacity model, which wants aggressive archiving. There is
no clean resolution — it is a genuine trade between cost and erasure agility, and the
honest move is to decide it explicitly with the DPO rather than let the retention
default pick.

### 23.3 Queryable Encryption is incompatible with the retrieval path

v1 §14.5 listed encrypted fields and noted that `searchText` could not be among them.
Correct, but it understated the scope: under automatic encryption, `$text` errors,
`$search` is not among the supported stages, `$rerank` is explicitly unsupported, and
`$lookup` cannot use an encrypted field as a join key.

So it is not just that some fields cannot be encrypted — **a QE-enabled client cannot
run the retrieval pipeline at all.** Hence the two-client architecture in §22.5. This
is an addition to v1, not a contradiction, but anyone implementing from §14.5 alone
would have written one client and discovered this at the worst moment.

### 23.4 Search Node region availability is a cloud-provider decision

v1 recommended dedicated Search Nodes without noting that they are available in all
supported Google Cloud regions but only a **subset** of AWS and Azure regions. For a
deployment committed to London for data residency, that is not a tuning detail — it can
force the choice of cloud provider (§22.3). It belongs in the decisions made before
the first byte of real data lands.

---

## 24. Architecture

### 24.1 The real-time loop, end to end

```
╔═══════════════════════════════════════════════════════════════════════════════════════╗
║ LIVE TURN                                                                    t = 0 ms ║
╚═══════════════════════════════════════════════════════════════════════════════════════╝
   she speaks  ──▶  ASR (finals only; partials never stored)
        │
        ▼
 ┌─────────────────────────────────────────────────────────────────────┐
 │ ⛔ SAFETY PRECHECK   constraints cached 60 s, change-stream invalidated│  5 ms
 │    absolute veto → scripted deferral · emergency → escalate, STOP    │
 └───────────────────────────────┬─────────────────────────────────────┘
                                 ▼
 ┌─────────────────────────────────────────────────────────────────────┐
 │ ▓▓ WRITE BEFORE THINKING        transaction, w:"majority"            │ 25 ms
 │    conversation_turns  role=patient  epistemic=observed              │
 │    sources             user_report   inspection.required (if speech) │
 │    conversation_sessions  $inc turnCount, patientTurnCount           │
 │    ── if everything downstream crashes, her words survive ──         │
 └───────────────────────────────┬─────────────────────────────────────┘
                                 ▼
    working context ──▶ RETRIEVAL ──▶ canonical re-check ──▶ disclosure    485 ms
    (decayed slots)     $rankFusion    approved ∧ isCurrent    constraint ▸
                        text+vector    ∧ sources ∧ inspected   script ▸ plain
                        [+visual]
                                 │
                                 ▼
                           GENERATION                                     1245 ms
                                 │
                   ◀──────── EMIT TO PATIENT ────────                     1250 ms
                                 │
 ┌───────────────────────────────┴─────────────────────────────────────┐
 │ ░░ WRITE AFTER SPEAKING                               w:1            │ +20 ms
 │    conversation_turns  role=companion  epistemic=generated           │
 │                        sourceId=null   model={name,version,digest}   │
 │                        groundedOn=[every record read]                │
 │                        disclosure={policy, scriptUsed}               │
 │    conversation_sessions  $inc signals.*                             │
 │    inferences         upsert by claimDigest, $inc observationCount   │
 │    engagement_ts      via ts_dedupe gate                             │
 └─────────────────────────────────────────────────────────────────────┘

        ┌──────────────── THE THREE READ PATHS ────────────────┐
        │                                                       │
   COMPANION                  CAREGIVER                   CONSOLIDATION
   patient_utterances  ──┐    conversation_turns  ──┐     inferences ──┐
   episodes (approved)   │    inferences            │     episodes     │
   semantic (approved)   │    inference_review_queue│                  │
   identity_core         │    care_alerts · audit   │                  ▼
   safety_constraints    │                          │           proposes DRAFTS
        │                │                          │           approves NOTHING
        ▼                │                          ▼
   may speak, with       │                   may promote, with
   citations             │                   their name on it
                         │
            ✗ cannot read conversation_turns (no `find` grant)
            ✗ cannot read inferences        (insert-only grant)
```

### 24.2 Cluster topology

```
╔═══════════════════════════════════════════════════════════════════════════════════════╗
║ AWS eu-west-2 (London)              VPC, private subnets                              ║
║                                                                                       ║
║   ┌──────────────────┐   ┌──────────────────┐   ┌─────────────────────┐              ║
║   │ companion svc    │   │ caregiver console│   │ workers             │              ║
║   │ IAM auth         │   │ IAM auth         │   │ nightly · escalation│              ║
║   │ role: companion  │   │ role: caregiver  │   │ reconcile · audit   │              ║
║   └────────┬─────────┘   └────────┬─────────┘   └──────────┬──────────┘              ║
║            └──────────────────────┼────────────────────────┘                          ║
║                                   ▼                                                   ║
║                      ╔═══════════════════════════╗                                    ║
║                      ║  AWS PrivateLink endpoint ║   public access: DISABLED          ║
║                      ╚═════════════╤═════════════╝   IP access list: EMPTY            ║
╚════════════════════════════════════╪══════════════════════════════════════════════════╝
                                     ▼
┌───────────────────────────────────────────────────────────────────────────────────────┐
│ ATLAS PROJECT: anchorcare-prod                                                        │
│                                                                                       │
│  ┌──────────────── engram-prod · M30 · MongoDB 8.0+ ────────────────┐                │
│  │   PRIMARY          SECONDARY         SECONDARY                    │                │
│  │   mongod           mongod            mongod                       │                │
│  │   ├ writes w:maj   ├ caregiver reads ├ caregiver reads            │                │
│  │   ├ transactions   │  (secondaryPref) │                           │                │
│  │   ├ change streams │                 │                            │                │
│  │   └ TTL monitor    │                 │                            │                │
│  │   encryption at rest: AWS KMS customer-managed keys               │                │
│  └───────────────────────────┬───────────────────────────────────────┘                │
│                              │ replication of indexed fields                          │
│  ┌───────────────────────────▼───────────────────────────────────────┐                │
│  │  DEDICATED SEARCH NODES   2 × S30   (Atlas requires ≥ 2)          │                │
│  │  mongot only — no contention with the conversational write path   │                │
│  │  episodes_text · episodes_auto · episodes_visual                  │                │
│  │  semantic_text · semantic_auto · chapters_text · chapters_auto    │                │
│  │  procedures_text · conversation_text · conversation_auto          │                │
│  │  Search Node Data Encryption → indexes under the same CMK         │                │
│  └───────────────────────────────────────────────────────────────────┘                │
│                                                                                       │
│  ┌─────────────────────────┐  ┌──────────────────────────────────────┐               │
│  │ STREAM PROCESSING       │  │ ONLINE ARCHIVE → Federated instance  │               │
│  │ workspace               │  │ conversation_turns  > 90 d           │               │
│  │ role: anchorcare_stream │  │ episodes            > 5 y (consent)  │               │
│  │ device → ts_dedupe →    │  │ engagement_ts       > 180 d          │               │
│  │ $merge → physiology_ts  │  │ ⚠ read-only · no $search/$vectorSearch│               │
│  │                 symptom_ts│  │ ⚠ provider SSE, not cluster CMK      │               │
│  └─────────────────────────┘  └──────────────────────────────────────┘               │
│                                                                                       │
│  Continuous Cloud Backup + PITR  (cluster-wide; cannot restore one household)         │
│  Database auditing → append-only object storage outside the project                   │
│  + nightly (scope, maxSeq, digest) checkpoints for the §14.3 audit chain              │
└───────────────────────────────────────────────────────────────────────────────────────┘

TWO CLIENT CONNECTIONS, by purpose (§22.5)
  retrieval client  (no QE) ── $search · $vectorSearch · $rankFusion · $graphLookup
  identity client   (QE)    ── identity_core · consent_records · contacts · constraint rules
                               find/equality only; $search and $rerank unavailable here
```

### 24.3 Where each epistemic tier physically lives

```
observed   ▸ sources (write-once)              ▸ conversation_turns role=patient
           ▸ memory_images + GridFS            ▸ symptom_ts · physiology_ts
           ▸ device_observations

generated  ▸ conversation_turns role=companion    sourceId: null, model required
                                                  readable only by the caregiver role

inferred   ▸ inferences                           visibility: caregiver_only
                                                  companion: insert, no find
                                                  promotable types: 5 of 13

approved   ▸ episodes · semantic_nodes · semantic_edges · memory_links
           ▸ identity_core · life_chapters · preferences
           ▸ safety_constraints · procedures · consent_records
                                                  reviewStatus: approved ∧ isCurrent
                                                  the ONLY tier the companion may speak
```

---

## 25. Open questions and unverified items

Additions to the v1 list in §17. Verify before claiming any of these in a demo or a
deployment decision.

1. **Dedicated Search Node availability in `eu-west-2`.** Blocking: it can change the
   cloud provider (§22.3). Check before any data lands.
2. **Atlas Stream Processing region availability** in the chosen region, and whether
   its workspace can reach a PrivateLink-only cluster without a public endpoint.
3. **Quantization on `type: "autoEmbed"` vector index fields.** Whether it is accepted
   at all is unconfirmed; the conversation-turn index sizing in §19.5 assumes either
   quantization or the 90-day window, and the window alone is sufficient.
4. **Queryable Encryption on the chosen tier**, and the exact supported-stage list for
   the driver version in use. The two-client split in §22.5 is derived from
   documentation, not from a live run.
5. **`$graphLookup` with a sharded `from` collection** for the MongoDB version in use.
   §22.7 avoids the question by keeping `semantic_edges` unsharded; revisit only if
   that stops being viable.
6. **PITR restore rehearsal.** Untested restores are not backups. Run one on staging
   and record the actual RTO.
7. **The archive/erasure trade in §23.2** needs a DPO decision, not an engineering
   default. Aggressive archiving minimises cost and maximises erasure latency.
8. **Audio retention** stays off until there is a written clinical reason to turn it
   on, a consent flow that covers it, and an S3 lifecycle policy that enforces
   `retainUntil`. "We might want it later" is not a reason to record someone's home.
9. **Inference precision is unmeasured.** The store makes
   `rejected / (confirmed + rejected)` computable per `inferenceType`; nobody has
   computed it. Until someone has, `CORROBORATION_THRESHOLD = 3` and the 0.75
   entity-linking threshold remain guesses with a review queue behind them.
10. **Turn-volume assumptions** (~400 turns/day/household) come from nothing but
    judgement. The whole capacity model in §22.8 scales off that number, so measure it
    in the pilot before sizing anything.
11. **The `conversation_auto` search path is code-enforced, not role-enforced**
    (§21.1), because search indexes cannot be defined on views. It is the weakest link
    in the self-citation defence and the first place to look if the companion ever
    repeats something it invented.
