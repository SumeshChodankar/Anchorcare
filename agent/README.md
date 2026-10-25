# `agent/` — the ambient autonomous agent

A daemon that listens continuously, reasons over approved memory, answers, and
escalates — unattended, with nobody watching it.

```sh
npm install                 # node_modules must exist
npm run agent               # starts the daemon
npm run agent -- --dry-run  # connects, opens a session, answers nothing
```

Then open **http://127.0.0.1:4319/capture** in Chrome or Edge, allow the microphone,
and leave the tab open. No button, no wake word.

---

## The distinction this is built on

**Autonomy of operation** — it runs forever, decides when something is worth
processing, retrieves, reasons, writes and escalates with no human in the loop.

**Autonomy of authority** — deciding that something is true enough to tell a person
with dementia. **It does not have this, and cannot acquire it.**

Those two are usually conflated under "autonomous agent". Keeping them apart is what
makes an always-on agent safe to point at someone who often cannot challenge what it
says. `agent/store.js` enforces the boundary at write time, in the single place every
write passes through:

| The agent may | The agent may not |
| --- | --- |
| Write her words as evidence (`sources`, `conversation_turns`) | Set `reviewStatus: "approved"` on anything |
| Write its own answers as `epistemic: "generated"` | Give a generated turn a `sourceId` |
| Write inferences, quarantined | Make an inference patient-visible, promote one, or mark one confirmed |
| Raise `care_alerts` and open `active_tasks` | Carry out a prohibited action |
| Cite approved episodes | Cite its own output, or an inference, as evidence |

Each of those refusals is a thrown `AgentApprovalError`, not a convention. If the
model ever produces something that would cross the line, the write fails loudly and
the daemon logs `REFUSED`.

---

## What happens on each utterance

```
  she speaks
      │
   ①  POST /capture ──▶ sources + conversation_turns (patient, observed)
      │                 written BEFORE any reasoning: if the model call or the
      │                 process dies next, her words survive
      │
   ②  safety precheck  absolute constraints — can end the turn with a script
      │
   ③  retrieval        $rankFusion over approved, source-backed episodes,
      │                 then the canonical re-check
      │
   ④  disclosure       a grief-sensitive or non-current person is answered from
      │                 the caregiver's script, verbatim; the model is not asked
      │                 to compose
      │
   ⑤  cognition        gemini-4-argon → CareResponse (caregiver/models.py shape)
      │
   ⑥  routing          answer → conversation_turns (companion, generated)
                       evidence_ids → groundedOn
                       inferred / insufficient → inferences, quarantined
                       prohibited action → care_alerts + active_tasks, refused
                       approval-needed action → active_tasks, no expiresAt
                       telemetry → engagement_ts
```

Full routing table: [`docs/GEMINI-WRITE-ROUTING.md`](../docs/GEMINI-WRITE-ROUTING.md).

---

## Files

| File | What it is |
| --- | --- |
| `daemon.js` | The loop, the capture endpoint, session lifecycle, shutdown |
| `pipeline.js` | One turn end to end, plus `ACTION_POLICY` mirroring `caregiver/policy.py` |
| `gemini.js` | The structured `CareResponse` call, and validation of what comes back |
| `store.js` | The write guard. The boundary above lives here |
| `config.js` | Environment, validated at startup |
| `capture.html` | Continuous browser capture with auto-restart |

---

## Two things it checks that are easy to miss

**Fabricated citations.** `gemini.js` validates `evidence_ids` against the evidence it
actually supplied. An id the model invented is dropped, `epistemic_basis` is
downgraded to `insufficient_evidence`, and the fabrication is recorded as an inference
of type `retrieval_miss`. A citation that points nowhere is worse than no citation,
because it looks like grounding.

**Claimed grounding with nothing cited.** If the model says `observed` but cites
nothing, the basis is downgraded rather than trusted.

---

## Configuration

Reads the project `.env`. Agent-specific keys, all optional:

```dotenv
AGENT_PORT=4319                  # capture endpoint
AGENT_TICK_MS=1500               # how often the loop looks for unanswered turns
AGENT_IDLE_SESSION_MINUTES=20    # silence before a session closes
AGENT_MIN_UTTERANCE_CHARS=3      # ignore fragments shorter than this
AGENT_MODEL=gemini-4-argon       # defaults to GEMINI_MODEL
AGENT_TEMPERATURE=0.2
AGENT_CAPTURE_TOKEN=             # if set, /capture requires x-agent-token
```

It refuses to start without `MONGODB_URI` and `GEMINI_API_KEY`, and it refuses to
start if `SUBJECT_IDS` holds more than one subject — run one daemon per subject
rather than letting one process mix two people's memories.

At boot it warns, without stopping, when:

- the cluster is below MongoDB 8.0 (`$rankFusion` will fail)
- there is no current `consent_records` document (proactive procedures will refuse)
- no approved episodes exist (every answer will be "I don't have anything written down")

---

## What this is not, yet

The architecture you described has five input modalities. This implements **one**:
speech, through the browser. Deliberately — it is the one that works on a desktop
tonight with no hardware.

| Modality | Status |
| --- | --- |
| Continuous acoustic | **done** — browser VAD and recognition, auto-restarting |
| mmWave radar / LiDAR | not started. `physiology_ts` is ready for it |
| Targeted RGB | not started |
| IoT contact / appliance sensors | not started. `physiology_ts` + `context_events` |
| Wearable biometrics | not started. `physiology_ts` |

Three things to decide before the sensors exist, not after:

1. **Bystander consent.** `consent_records` models the subject. It has no concept of a
   visitor who never agreed to be recorded. Continuous far-field audio in a home makes
   that a live question rather than a theoretical one.
2. **Speaker identification is not diarization.** Telling Speaker 1 from Speaker 2 is
   fine. Matching against enrolled voiceprints to say "that is Sarah" is biometric
   identification, which `ATLAS-MEMORY-SCHEMA.md` §14.7 says this system does not do.
   If you want it, it needs its own collection, its own consent and its own retention
   — explicitly, not smuggled into `semantic_nodes.attributes`.
3. **Capacity.** The sizing in `REALTIME-CAPTURE-AND-CLUSTER.md` §22.8 assumes ~400
   conversational turns a day. Radar at 1 Hz is 86,400 samples per sensor per day.
   Downsample at the edge and write aggregates, or the credit model stops holding.

---

## Watching it work

```sh
curl http://127.0.0.1:4319/status
```

```sh
# what it has said, newest first
mongosh "$MONGODB_URI" --quiet --eval '
  db.getSiblingDB("engram").conversation_turns.find({ role: "companion" })
    .sort({ startedAt: -1 }).limit(5)
    .forEach(t => print(`${t.startedAt.toISOString().slice(11,19)}  cited ${t.groundedOn.filter(g=>g.role==="evidence").length}  ${t.text}`))'
```

```sh
# what it worked out but may not say
mongosh "$MONGODB_URI" --quiet --eval '
  db.getSiblingDB("engram").inferences.find().sort({ lastObservedAt: -1 }).limit(10)
    .forEach(i => print(`${i.inferenceType.padEnd(16)} x${i.observationCount}  ${JSON.stringify(i.claim).slice(0,100)}`))'
```

```sh
npm run schema:audit-live    # consent, FCV, embedding mode, TTL landmines
npm run schema:reconcile     # invariants a validator cannot express
npm run schema:audit         # audit hash chain
```
