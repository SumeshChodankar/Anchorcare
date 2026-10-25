# Anchorcare — Gemini write routing

**Status:** specification, v1 (2026-10-24)
**Question answered:** a question is asked, `gemini-4-argon` processes it — what gets
saved, and into which collection?
**Tooling:** [`db/restructure-test-db.js`](../db/restructure-test-db.js) migrates the `test` scratch database into this routing
**Related:** [`ATLAS-MEMORY-SCHEMA.md`](./ATLAS-MEMORY-SCHEMA.md) · [`REALTIME-CAPTURE-AND-CLUSTER.md`](./REALTIME-CAPTURE-AND-CLUSTER.md) §§18–21

---

## 0. There are four data layers, not one

This is the thing to fix before anything else. Four places currently hold the same
kinds of fact, written by different code, in different databases:

| Layer | Database | Collections | Written by |
| --- | --- | --- | --- |
| **Node retrieval** | `engram` | `episodes`, `sources`, `people`, `plans`, `prompts`, `mobile_*` | `engram-retrieval/`, `integration/` |
| **Python / Gemini** | `caregiver_demo` | `events`, `actions`, `reminders`, `audit_logs` | `caregiver/`, the Python layer in `src/lib/pythonCodebase.ts` |
| **Scratch capture** | `test` | `conversations`, `memories`, `alerts` | by hand, to test input without breaking `engram` |
| **New cognitive schema** | `engram` | 46 collections | `db/provision.js` |

`caregiver/policy.py` queries `db.events`; `pythonCodebase.ts` defaults to
`MONGODB_DATABASE=caregiver_demo`; the Node side defaults to `engram`. So the same
household's events can live in two databases depending on which process wrote them,
and the scratch data lives in a third.

**The routing below collapses all four into `engram`.** Nothing is lost: §3 maps every
Python collection onto its destination, and `db/restructure-test-db.js` maps the
scratch database.

---

## 1. The round trip, step by step

A question arrives. Here is every write, in order, with what it is for.

```
  she asks "Is Sarah coming today?"
        │
  ① ────┴──▶  sources            write-once · sourceType "user_report"
              conversation_turns role "patient" · epistemic "observed"
              conversation_sessions  $inc turnCount
              ── written BEFORE Gemini is called ──
        │
  ② ────┴──▶  [ safety precheck ]  safety_constraints · hard veto, no write
        │
  ③ ────┴──▶  [ retrieval ]        episodes + semantic_nodes + identity_core
                                   read-only; the ids become groundedOn
        │
  ④ ────┴──▶  gemini-4-argon → CareResponse (caregiver/models.py)
        │
  ⑤ ────┴──▶  conversation_turns role "companion" · epistemic "generated"
                                  sourceId NULL · model{name,version,promptDigest}
                                  groundedOn ← CareResponse.evidence_ids
        │
  ⑥ ────┴──▶  inferences          CareResponse.uncertainty, intent, signals
                                  visibility "caregiver_only" · never spoken
        │
  ⑦ ────┴──▶  care_alerts         only if a PROHIBITED action was proposed
              procedure_runs      the policy decision and its evidence
              engagement_ts       prompt delivered / answered / latency
              working_memory      slot upserts for the next turn
```

Step ① happens **before** Gemini is called, not after. If the model call fails, times
out or the process dies, the record of what she said survives. The alternative is a
system that loses her words precisely when it fails to answer her.

---

## 2. `CareResponse` field by field

`caregiver/models.py` already returns structured output. Every field has exactly one
destination.

| `CareResponse` field | Goes to | Why there |
| --- | --- | --- |
| `answer` | `conversation_turns.text` (role `companion`) | The sentence the companion said. `epistemic: "generated"`, `sourceId: null` |
| `evidence_ids` | `conversation_turns.groundedOn[]` with `role: "evidence"` | The explainability record: which memories produced this answer |
| `epistemic_basis` | routes the write — see below | `observed`/`reported` → citable; `inferred` → `inferences`; `insufficient_evidence` → `signals.retrievalFailures` |
| `has_conflicting_evidence` | `memory_links` `linkType: "contradicts"` between the conflicting episodes | Conflicts are surfaced, never merged |
| `uncertainty` | `inferences` (`inferenceType: "retrieval_miss"`) | A model's own hedge is a machine judgement, so it is quarantined |
| `proposed_action` | `procedure_runs`, and `care_alerts` if escalating | §4 |

### 2.1 `epistemic_basis` is the routing switch

`models.py` has `EpistemicStatus = observed | reported | inferred`, and `CareResponse`
adds `insufficient_evidence`. These map onto the schema's tiers (§18.2) exactly:

| `epistemic_basis` | Tier | Write |
| --- | --- | --- |
| `observed` | observed | The cited episodes already exist and are approved. Only the companion turn is written |
| `reported` | observed | Same. A report is evidence of a report, which is what `sourceType` records |
| `inferred` | **inferred** | The claim goes to `inferences`, quarantined. It is **not** citable and the companion must not state it as fact |
| `insufficient_evidence` | — | No claim is written. `conversation_sessions.signals.retrievalFailures` is incremented, which is the honest measure of how often the system answers without evidence |

**The rule this encodes:** a model saying `epistemic_basis: "inferred"` is the model
telling you its answer is not evidence-backed. The schema takes it at its word and
routes it away from anything the companion may repeat later.

### 2.2 Why `answer` never becomes a source

`evidence_ids` points at episodes that already existed. The `answer` itself gets
`sourceId: null` and `epistemic: "generated"`.

If a generated answer became a citable source, then tomorrow's retrieval finds it,
cites it, and repeats it; by the third repetition the consolidation job sees "three
independent observations" that are the same sentence echoing, and proposes it as a
routine. An invention becomes a fact in the knowledge graph within a week.

This is the confabulation loop (§18.3), and the companion credential **cannot** read
`conversation_turns` — it reads the `patient_utterances` view, which filters to
`role: "patient"`. Her words are evidence; its words are not.

---

## 3. The Python layer maps straight across

`caregiver/models.py` and `caregiver/policy.py` are closer to this schema than the
Node side is. Almost every field has a counterpart.

| Python (`models.py`) | Schema | Note |
| --- | --- | --- |
| `EventRecord` | `episodes` + `sources` | One event = one episode and at least one source |
| `event_id` | `episodes._id` | — |
| `person_id` | `subjectId` (+ `semanticRefs` for others named) | — |
| `occurred_at` / `recorded_at` | `eventStart` / `recordedAt` | Already the same distinction |
| `statement` | `episodes.summary` + `searchText` | `gist` derived from the first clause |
| `EventSource.type` | `sources.sourceType` | `caregiver_observation`→`caregiver_report`, `patient_self_report`→`user_report`, `family_call`→`caregiver_report` |
| `EventSource.author` | `sources` + the approving `audit_events.actor` | — |
| `epistemic_status` | `episodes` vs `inferences` | §2.1 |
| `confidence` | `episodes.confidence` | Uncalibrated in both — `calibration: "uncalibrated"` makes that explicit |
| `EventStatus.ACTIVE` | `isCurrent: true` | — |
| `EventStatus.SUPERSEDED` | `isCurrent: false` + `supersededBy` | Identical ledger pattern |
| `EventStatus.RETRACTED` | `isCurrent: false` + `retractionReason` | — |
| `supersedes` / `superseded_by` | same field names | — |
| `conflict_with_ids` | `memory_links` `linkType: "contradicts"` | Moved out of the document so each conflict carries its own provenance |
| `ProposedAction` | `procedure_runs` + `procedures` | §4 |
| `compute_idempotency_key` | `procedure_runs.idempotencyKey` (unique) | Same idea; the index makes it enforced rather than advisory |
| `verify_supporting_evidence_active` | the canonical re-check (§12.2) | Both re-read evidence after the fact and drop what is no longer active |
| `check_approval_permission` | the four database roles (§21.2) | Moves from an application check to a database grant |
| `db.audit_logs` | `audit_events` | Gains `seq` + `prevDigest` hash chaining |
| `db.reminders` | `plans` + `prompts` + `prompt_jobs` | Already exists on the Node side |
| `db.actions` | `procedure_runs` | — |
| `db.smoke_tests` | — | Test scaffolding; do not migrate |

**One field has no home, deliberately.** `EventRecord` has no place to store a clinical
conclusion, and neither does `episodes`. That is not an oversight in either.

---

## 4. `ProposedAction` and `ExecutionPolicy`

`policy.py`'s `ACTION_POLICY_MAP` is a risk model. The schema already has one, so they
join up directly:

| `ExecutionPolicy` | `procedures.riskTier` | `tool_registry` | What is written |
| --- | --- | --- | --- |
| `AUTO_EXECUTE` | 0–1 | `maxRiskTier: 1`, `requiresCaregiverApproval: false` | `procedure_runs` with `outcome: "completed"` |
| `REQUIRE_APPROVAL` | 2 | `requiresCaregiverApproval: true` | `active_tasks` (`taskType: "await_caregiver_approval"`, **no `expiresAt`**) + `procedure_runs` `outcome: "refused_precondition"` until approved |
| `PROHIBITED` | — | **no tool exists** | `procedure_runs` `outcome: "vetoed_safety"` + a `care_alerts` record naming what was proposed |

Per action:

| `ActionType` | Policy | Destination |
| --- | --- | --- |
| `flag_memory_conflict` | auto | `memory_links` `contradicts` |
| `log_patient_mood_report` | auto | `symptom_ts` (`symptomCode: "mood_reported"`, `observerKind: "patient_self_report"`) |
| `show_orientation_card` | auto | `conversation_turns` + `working_memory` slot |
| `alert_caregiver_loop_detected` | auto | `inferences` (`orientation_signal`) → `care_alerts` if it persists |
| `create_reminder` | approval | `plans` draft → `prompts` after approval |
| `draft_family_message` | approval | `active_tasks` + a draft in the console |
| `mark_routine_completed` | approval | `daily_logs` draft |
| `change_medication_dose` | **prohibited** | `procedure_runs` `vetoed_safety` + `care_alerts`. **No tool exists**, so there is nothing to execute even if the veto were bypassed |
| `unlock_door` | **prohibited** | same |
| `contact_emergency_services` | **prohibited** | same — escalation goes to a named human, never to an emergency service |

The three prohibited actions are enforced twice: `safety_constraints` vetoes them at
retrieval time, and `tool_registry` contains no tool that could carry them out. A veto
you can route around is a suggestion.

> **`log_patient_mood_report` deserves a note.** It writes to `symptom_ts` with
> `observerKind: "patient_self_report"` — never `agent`. The schema's `observerKind`
> enum has no `agent` value, so a mood the model *inferred* cannot be written as an
> observation. It goes to `inferences` as an `affect_signal` instead, where a caregiver
> can see it and nobody can cite it.

---

## 5. What `db/restructure-test-db.js` does with the scratch data

```sh
node db/restructure-test-db.js            # inspect: reads, proposes, writes nothing
node db/restructure-test-db.js --apply    # write the mapped documents
```

| From | To | State on arrival |
| --- | --- | --- |
| `test.conversations` question | `sources` + `conversation_turns` (patient, observed) | Citable |
| `test.conversations` answer | `conversation_turns` (companion, generated) | `sourceId: null`, `model.name: "unknown-imported"` |
| `test.memories` | `sources` + `episodes` | **`reviewStatus: "draft"`** — approve before anything is spoken |
| `test.alerts` with evidence ids | `care_alerts` | `state: "resolved"`, not re-notified |
| `test.alerts` without evidence ids | **skipped and reported** | `care_alerts.triggerRefs` requires at least one; an alert that cannot name its evidence is not invented into existence |

The script inspects first because **nothing defines those document shapes** — they
were written by hand. It prints the field names it finds and the ones it looked for.
If a question landed under a field name it did not try, add it rather than letting the
import guess.

Nothing in `test` is modified or deleted. Drop it yourself once the import verifies.

---

## 6. Automated Embedding

Already configured. `EMBEDDING_MODE=auto` and `VECTOR_INDEX=episodes_auto` are set in
the live root `.env` and in both `.env.example` files, and
`engram-retrieval/src/config.js` defaults to `auto` regardless.

So there is **nothing to change in code or config.** Two things remain, and neither is
in this repo:

1. **The Atlas project integration.** Automated Embedding is enabled per project. The
   new cluster is in a different project, so it must be enabled there —
   `MIGRATION-RUNBOOK.md` §14.2 has the click path.
2. **Proof that the index matches the mode.** Configuration is not execution.

```sh
npm run schema:audit-live
```

`db/audit-live.js` now reports an `embedding mode` section: it reads the live
definition of `episodes_auto`, finds whether the vector field is `autoEmbed` or
`vector`, and raises a **P0 `embedding_mode_mismatch`** if it disagrees with
`EMBEDDING_MODE`.

That mismatch is the failure worth fearing. `provision.js` never edits an existing
search index, so a mode change with the same index name leaves a query that returns
**zero results without erroring** — and `atlas:check` still reports success, because
an empty result proves execution, not retrieval quality. The only symptom is the
companion saying it has no memory of things it remembers.

Then prove it end to end:

```sh
npm run atlas:check --prefix engram-retrieval
```

Confirm `featuresUsed` contains `atlas_automated_embedding_voyage`. If it reports
`voyage_embeddings` instead, the index is in manual mode. If it reports neither,
the integration is not enabled in the project.
