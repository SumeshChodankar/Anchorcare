# `db/` — cognitive memory schema

Provisioning and reference implementation for Anchorcare's six-store memory system,
plus real-time conversation capture and the inference quarantine.

- Stores, fields, indexes, retrieval and write algorithms, safety rules:
  [`docs/ATLAS-MEMORY-SCHEMA.md`](../docs/ATLAS-MEMORY-SCHEMA.md) §§0–17
- Conversation capture, inference persistence, cluster architecture:
  [`docs/REALTIME-CAPTURE-AND-CLUSTER.md`](../docs/REALTIME-CAPTURE-AND-CLUSTER.md) §§18–25
- Moving to a new Atlas cluster, phase by phase:
  [`docs/MIGRATION-RUNBOOK.md`](../docs/MIGRATION-RUNBOOK.md)
- What Gemini produces and which collection each part lands in:
  [`docs/GEMINI-WRITE-ROUTING.md`](../docs/GEMINI-WRITE-ROUTING.md)

| File | What it is |
| --- | --- |
| `collections.js` | Declarative registry: collections, `$jsonSchema` validators, regular indexes, Atlas Search / Vector Search definitions, time-series options. Single source of truth |
| `provision.js` | Idempotent provisioner. Creates what is missing, changes nothing that exists, fails if a TTL index appears on a safety collection |
| `retrieval.js` | Pure pipeline builders and scoring functions for §12 (hybrid recall, graph expansion, disclosure gate, working-memory decay) |
| `ingest.js` | Pure document builders and the transaction shapes for §13 (ingestion, audit chain, alerts, time-series gate) |
| `audit-live.js` | **Read-only** audit of a live cluster against the registry: stray databases, unindexed collections, TTL landmines, missing/non-queryable search indexes, unscoped documents. Writes nothing. Ranked P0→P3 |
| `migration-verify.js` | **Read-only** proof that a migration moved everything: exact counts, order-independent `_id`-set checksum, index parity, validator presence. `--deep` hashes every document. Runbook: [`docs/MIGRATION-RUNBOOK.md`](../docs/MIGRATION-RUNBOOK.md) |
| `seed-consent.js` | Creates a `consent_records` document. **Refuses without a named grantor and an explicit capacity** — see below |
| `restructure-test-db.js` | Maps the `test` scratch database (`conversations`, `memories`, `alerts`) into the real collections. Inspects first; `--apply` to write. Routing: [`docs/GEMINI-WRITE-ROUTING.md`](../docs/GEMINI-WRITE-ROUTING.md) |
| `backfill-semantic.js` | Migration §16.1 steps 3–6: `people` → draft nodes, relationship edges, `about` links, derived episode fields. Drafts only |
| `reconcile.js` | Reports cache divergence and the invariants a validator cannot express. Reports; never repairs |
| `verify-audit.js` | Walks the audit hash chain per scope and reports the first break |
| `schema.test.js` | 80 tests over the pure builders and guards. `npm run schema:test`. No database required |
| `examples/examples.json` | One or more example documents for all 39 collections, as Extended JSON keyed by collection name |

## Why consent is not provisioned

`provision.js` creates structure. A consent record is not structure: it asserts that a
named person granted permission, on a date, in a stated capacity. Software must not
manufacture that, so `seed-consent.js` refuses to run without `--granted-by` and
`--kind`, and has no defaults for either.

What `provision.js` and `audit-live.js` do instead is **report the absence**, because
a missing consent record is a silent product failure rather than a visible error:
procedures gated on `consent_allows_proactive_contact` refuse to run, so the companion
never speaks first and looks broken rather than blocked.

```sh
node db/seed-consent.js --subject margaret --granted-by "Margaret Doyle" --kind subject
#   dry run; prints the record and what it permits
node db/seed-consent.js --subject margaret --granted-by "Margaret Doyle" --kind subject --apply
```

`--kind` is one of `subject`, `attorney`, `next_of_kin`. Capacity fluctuates in
dementia, so who consented and in what capacity is part of the record, not metadata.

## Environment variables

| Variable | Used by | Notes |
| --- | --- | --- |
| `MONGODB_URI` | everything | The target cluster |
| `MONGODB_DATABASE` | everything | Defaults to `engram` |
| `MONGODB_URI_NEW` | `migration-verify.js`, `audit-live.js`, `seed-consent.js` | Wins over `MONGODB_URI` when set |
| `MONGODB_URI_OLD` / `SOURCE_URI` | `migration-verify.js`, `audit-live.js --old` | The source cluster |

Both naming conventions work, so the shell that runs `provision.js` also runs the
verification without re-exporting anything.

## The device-link collections

`mobile_devices`, `mobile_pairings`, `mobile_commands`, `mobile_policies`,
`mobile_sos`, `mobile_sos_gates`, `mobile_push`, `mobile_push_attempts`,
`integration_requests` and `demo_scenarios` are written by `integration/mobile-link.ts`,
`mobile-push.ts`, `capability-hooks.ts` and the seed scripts. **None of them appear in
`engram-retrieval/scripts/indexes.js`**, so in a live cluster they are created
implicitly on first insert and carry only the default `_id` index.

They are now in the registry with additive index definitions derived from the actual
query filters in that code, and **no validators** — a validator on a live collection
would start rejecting current writes.

`mobile_sos` is the emergency path and is treated as a safety collection:
it is in `NO_TTL`, and its three indexes match the three scans the worker runs on a
timer. It carries an `expiresAt` field for business logic, which makes it a TTL
landmine: an index added "to clean up" would silently delete assistance requests.
`mobile_pairings` is the one deliberate exception — five-minute pairing codes are
ephemeral credentials, not records of anything that happened.

## Running it

```sh
export STORE=mongodb
export MONGODB_URI='mongodb+srv://…'     # never commit this
export MONGODB_DATABASE=engram
export EMBEDDING_MODE=auto HYBRID_BACKEND=native

npm run schema:test                               # no cluster needed
npm run schema:audit-live                         # READ-ONLY: what is actually in the cluster
npm run atlas:indexes --prefix engram-retrieval   # existing collections (unchanged)
npm run schema:plan                               # print the plan, touch nothing
npm run schema:provision                          # apply
npm run schema:backfill                           # dry run; add -- --apply to write
npm run schema:reconcile                          # divergence + invariant report
npm run schema:audit                              # hash-chain walk
```

`provision.js` is additive and safe against a cluster already serving the existing
`engram` collections. It is not a migration tool: see §16.1 of the spec for the
ordered backfill, which produces drafts only, so patient-facing behaviour cannot
change until a caregiver approves.

## Non-negotiables encoded here

- **Nothing reaches the patient without caregiver approval.** Every builder in
  `ingest.js` writes `reviewStatus: "draft"`; approval is a separate, audited
  transaction.
- **Every claim is source-backed.** `groundCandidates()` re-reads canonical records
  after search and drops anything without sources or with uninspected media.
- **Safety data never expires.** `NO_TTL` in `collections.js` is asserted at
  provision time, and tier-≥2 `active_tasks` are written without `expiresAt` so the
  sparse TTL index cannot reach them.
- **Filters go inside `$vectorSearch`.** Post-filtering can return nothing while
  approved memories exist, which the companion would voice as "I don't remember".
- **`$graphLookup` repeats the scope** inside `restrictSearchWithMatch`. It does not
  inherit the outer `$match`; omitting it is a cross-tenant leak.
- **Search index definitions are never edited.** A model, mode or mapping change
  takes a new index name (`VECTOR_INDEX`, `SEARCH_INDEX`, `VISUAL_VECTOR_INDEX`).
- **No field stores a clinical conclusion.** `care_alerts` has closed
  `additionalProperties`; `symptom_ts.observerKind` excludes `agent`; medication
  vocabulary stays `reported_*` / `uncertain`.
- **The companion cannot cite its own output.** A companion turn is
  `epistemic: "generated"` with `sourceId: null`; `buildCompanionTurn()` throws if
  `groundedOn` cites one as evidence; `conversationSearchPipeline()` is patient-only
  and cannot be widened; and the companion credential has **no `find`** on
  `conversation_turns` — it reads the `patient_utterances` view. Her words are
  evidence; its words are not, at any confidence level.
- **Inferences are stored but quarantined.** `visibility` has exactly one permitted
  value (`caregiver_only`) and `calibration` exactly one (`uncalibrated`); `basis` is
  required; the companion credential has `insert` without `find`; and 5 of 13
  inference types have any promotion path at all. Promotion needs a named caregiver
  and still produces a draft.
- **What was said is never deleted by a timer.** `conversation_turns` and
  `conversation_sessions` are in `NO_TTL`; retention runs through consent and Online
  Archive, which the provisioner asserts.

## Reading diffs in this checkout

The working tree is CRLF while git stores LF (`core.autocrlf` unset, no
`.gitattributes`), so `git diff` reports every tracked file as fully rewritten.
Use `git diff --ignore-cr-at-eol` to see real changes. Normalising the repo is a
separate decision — it rewrites every tracked file.

## Unverified

`episodes_visual`, `semantic_auto`, `semantic_text`, `chapters_*`,
`procedures_text`, `conversation_text`, `conversation_auto`, Queryable Encryption, the
two views and the four Atlas custom roles have **not** been executed against a live
cluster. `voyage-multimodal-3` availability through the Atlas project integration is
assumed. Verify before claiming any of them in a demo — index configuration is not
proof of execution (see `engram-retrieval/NATIVE-ATLAS.md`).

Two items are blocking for the cluster build and should be checked first:
**dedicated Search Node availability in `eu-west-2`** (it can change the cloud
provider) and **whether `type: "autoEmbed"` accepts a quantization setting** (it
affects conversation-turn index sizing). Both are in §25 of the cluster document with
the reasoning.
