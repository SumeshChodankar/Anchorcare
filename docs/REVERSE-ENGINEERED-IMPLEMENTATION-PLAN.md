# AnchorCare + Engram: Master Reverse-Engineered System Specification & Implementation Plan

**Repository:** `hackathon/Engram-Hackathon` (Anchorcare)  
**Authors:** Sumesh Chodankar & Athul J.K. (London Encode Hackathon, October 2026)  
**Target Architecture:** Multi-Agent Dementia Cognitive Assistant with MongoDB Atlas 8.0+ Biomimetic Persistence & Google Gemini 4 Argon Acoustic Cognitive Engine  
**Document Status:** Master Reverse-Engineered Specification (v2.0 Exhaustive)

---

## 1. Executive Summary & Problem Formulation

### 1.1 The Dementia Cognitive Loop Problem
Dementia and Alzheimer's Disease progressively destroy episodic memory while initially preserving semantic and procedural associations. As patients experience rapid memory decay, they encounter profound disorientation, leading to **repetitive questioning loops** (e.g., asking "When is my daughter visiting?" or "Where are my glasses?" dozens of times per hour), severe agitation, and fatal **wandering behavior**.

Standard LLM solutions fail catastrophically in clinical dementia environments due to four fatal flaws:
1. **Hallucinatory Confabulation:** Unconstrained models fabricate plausible but false memories (e.g. inventing visits, confirming incorrect pill intakes).
2. **The Confabulation Feedback Loop:** When an LLM stores its generated output into its conversational history, it subsequently retrieves its own hallucinations as historical ground truth, permanently corrupting the patient's episodic record.
3. **Acoustic Confusion & Identity Loss:** Ambient listening devices cannot distinguish the patient's voice from the caregiver, visiting physiotherapist, TV background noise, or strangers.
4. **Autonomous Action Danger:** An autonomous agent that can unilaterally modify medication schedules, call emergency services (999/911), or unlock doors poses an existential hazard.

### 1.2 The AnchorCare Philosophy & Solution
AnchorCare solves this through a non-negotiable core philosophy:
$$\text{Autonomy of Operation} \neq \text{Autonomy of Authority}$$

The system operates 24/7 unattended at the edge, capturing ambient acoustics and monitoring geofences. However, **it possesses zero autonomous authority to approve memories or mutate clinical care plans.** Every action, memory promotion, and alert is governed by a 3-tier deterministic policy gate, a 6-store biomimetic memory hierarchy, and strict epistemic verification.

---

## 2. High-Level System Architecture & Component Map

AnchorCare is structured as a decoupled, multi-tier distributed cognitive system operating across two server processes, an edge hardware listening daemon, and a dual-surface web application:

```mermaid
flowchart TB
    subgraph Edge Layer [Edge Acoustic & Physical Telemetry]
        MIC[Continuous Ambient Mic<br/>HTML5 MediaRecorder 16kHz]
        VAD[RMS Energy Voice Activity Detector<br/>Pre-speech 12s Ring Buffer]
        GPS[Mobile GPS & Beacon Telemetry<br/>50m Safe Harbor Radius]
        MIC --> VAD
    end

    subgraph Daemon Layer [Edge Multi-Agent Daemon :4319]
        A1[Agent 1: Acoustic Ear & Diarizer<br/>Gemini 4 Argon Audio Ingestion]
        A2[Agent 2: Episodic Memory Reasoner<br/>Atlas Contextual Reasoning]
        A3[Agent 3: Neural Voice Companion<br/>Web Audio Speech Synthesis]
        A4[Agent 4: Care Escalation & Geofence<br/>Twilio Voice & Anonymous Telephony]
        VAD -->|POST /capture/audio| A1
        A1 -->|Diarized Turn & Spec Match| A2
        A2 -->|Grounded Reassurance| A3
        GPS -->|POST /geofence/telemetry| A4
    end

    subgraph Gatekeeper Layer [Express & Vite Gateway :3000]
        SEC[HTTP Security & Credential Bucket<br/>In-memory Tokens, No localStorage]
        ENG[Engram Integration Service<br/>routeQuestion & answerJobs]
        POL[Caregiver Policy Engine<br/>3-Tier Execution Gate & SHA-256 Idempotency]
        GRD[GridFS Image Service<br/>Facial & Photo Album Recall]
        MED[Medication Reminder Worker<br/>Deterministic 2s Tick Loop]
    end

    subgraph Atlas Layer [MongoDB Atlas 8.0+ Database 'engram']
        S1[(Store 1: Working Memory<br/>12h TTL, sessions, dedupe)]
        S2[(Store 2: Episodic Memory<br/>episodes, sources, traces)]
        S3[(Store 3: Semantic Memory<br/>nodes, edges, links)]
        S4[(Store 4: Procedural Memory<br/>plans, procedures, context)]
        S5[(Store 5: Autobiographical<br/>identity, chapters, daily logs)]
        S6[(Store 6: Safety & Clinical<br/>alerts, consent, audit)]
        ASP[Atlas Stream Processing<br/>EngramContextStream Join]
    end

    subgraph User Surface Layer [Dual-Surface Application]
        CG[Caregiver Mission Control<br/>React 18 / Vite Cockpit]
        PT[Patient Mobile Companion<br/>PWA /phone with Service Worker]
    end

    A2 <-->|Authenticated /api/engram| ENG
    ENG --> POL
    POL --> S2 & S3 & S4 & S6
    ASP --> S4
    GRD --> S2
    MED --> S4 & S6
    ENG <--> CG
    ENG <--> PT
```

---

## 3. Multi-Agent Orchestration Architecture

AnchorCare coordinates four specialized autonomous agents running within `agent/daemon.js` and `agent/pipeline.js`:

| Agent | Name | Engine / Model | Trigger / Ingestion | Output & Boundary |
|---|---|---|---|---|
| **Agent 1** | **Acoustic Ear & Diarizer** | Gemini 4 Argon (`gemini-4-argon`) | Ambient speech audio chunks via `POST /capture/audio` | Transcribed text, identified speaker (`Sumesh`, `Margaret`, `Jane`, `David Lee`, `Others`), confidence score. |
| **Agent 2** | **Episodic Memory Reasoner** | Gemini 4 Argon + Atlas Native Search | Diarized turn from Agent 1 | Structured JSON answer citing exact database record IDs and quotes; prohibited from confabulating. |
| **Agent 3** | **Neural Voice Companion** | Edge Web Speech API / `/tts` | Completed reasoning from Agent 2 | Calm, dementia-friendly neural audio; mutes ambient mic during playback to prevent acoustic feedback loops. |
| **Agent 4** | **Care Escalation & Geofence** | Haversine Vector Math + Twilio PSTN | GPS telemetry / Disorientation / SOS trigger | Safe-harbor boundary tracking, SMS/push caregiver alerts, anonymous outbound phone calls. |

---

## 4. The 6-Stage Cognitive Turn Execution Cycle (`agent/pipeline.js`)

Every human speech utterance or text query executes through an invariant 6-stage cognitive pipeline:

```mermaid
sequenceDiagram
    participant U as Speaker (Sumesh / Margaret)
    participant P as Pipeline (pipeline.js)
    participant S as Guarded Store (store.js)
    participant A as Atlas Engine ($rankFusion)
    participant G as Gemini 4 Argon

    U->>P: Utterance (Audio / Text)
    Note over P: Stage 0: Safety Precheck & Veto Gate
    Note over P: Stage 1: Working Context Assembly
    P->>A: Stage 2: Episodic Retrieval ($rankFusion)
    A-->>P: Top Candidate Episodes & Evidence
    P->>S: Stage 3: Canonical Re-Check (Filter Retracted/Unapproved)
    S-->>P: Verified Active Evidence
    Note over P: Stage 4: Disclosure Resolution (Filter Sensitive Data)
    P->>G: Stage 5: Cognitive Reasoning (Strict JSON Schema)
    G-->>P: Grounded Answer + Evidence Quotes
    P->>S: Stage 6: Write Routing & Guarded Storage
    S-->>P: Immutable Turn Recorded
    P-->>U: Synthesized Neural Voice Answer
```

### Stage 0: Safety Precheck & Veto Gate
- Validates the speaker's biometric identity against active safety constraints in Store 6 (`safety_constraints`).
- If an active alert exists (e.g. `wandering_detected` or `medical_emergency`), immediate priority guidance overrides standard recall.

### Stage 1: Working Context Assembly
- Loads the recent 12-hour conversational context from Store 1 (`working_memory`).
- Retrieves active orientation cards (current day, time, home location).

### Stage 2: Episodic Retrieval ($rankFusion)
- Queries MongoDB Atlas using the `$rankFusion` aggregation pipeline combining BM25 lexical text search (`episodes_text`) and cosine vector similarity (`episodes_auto`).

### Stage 3: Canonical Re-Check
- Prevents stale retrieval: cross-references candidate IDs against the primary `episodes` and `sources` collections.
- Discards any record where `reviewStatus !== "approved"` or `isCurrent === false`.

### Stage 4: Disclosure Resolution
- Checks the subject's cognitive state and privacy level.
- Filters out sensitive financial records or deceased family member trauma triggers if marked `sensitivity: "high"`.

### Stage 5: Cognition (Gemini 4 Argon Structured Reasoning)
- Calls Gemini 4 Argon with strict system instructions:
  - Speak in 1–3 short, gentle sentences directly to the patient.
  - Never quiz, shame, or infantilize.
  - Every claim MUST cite exact quotes from raw sources.
  - If evidence is absent, output `status: "no_support"` rather than guessing.

### Stage 6: Write Routing & Guarded Storage
- Stores the completed turn in `conversation_turns` with `epistemic: "generated"` and `sourceId: null`.
- Protects the episodic store: the daemon CANNOT self-approve memories without throwing an `AgentApprovalError`.

---

## 5. MongoDB Atlas Biomimetic Memory Schema Architecture

AnchorCare implements a persistent cognitive memory model across **6 biomimetic stores**, **46 partitioned collections**, **4 time-series collections**, and **2 read-only epistemic views**.

### 5.1 The Six Biomimetic Stores (`db/collections.js`)

| Store Name | Cognitive Role | Partitioned Collections | Retention & Behavior |
|---|---|---|---|
| **1. Working** | Sensory buffer & immediate session focus | `working_sessions`, `working_memory`, `active_tasks`, `ts_dedupe` | 12-hour TTL expiration. Slot half-life decay. Fast in-memory caching. |
| **2. Episodic** | Autobiographical event history with spatial/temporal ground | `episodes`, `sources`, `memory_state`, `recall_attempts`, `memory_images`, `memory_trace_ts` (time-series), `conversation_sessions`, `conversation_turns`, `inferences` | Permanent append-only audit trail. Invariant: only human-approved records are citeable. |
| **3. Semantic** | Knowledge graph of people, entities, preferences, and facts | `semantic_nodes`, `semantic_edges`, `memory_links` | Graph relationships (`isA`, `relativeOf`, `caresFor`, `residesAt`). Updated upon caregiver verification. |
| **4. Procedural** | Habits, daily routines, device integrations, and future plans | `procedures`, `tool_registry`, `procedure_runs`, `plans`, `context_events`, `mobile_devices`, `mobile_pairings`, `mobile_commands`, `mobile_policies`, `mobile_push`, `mobile_push_attempts`, `integration_requests`, `demo_scenarios` | Future appointments, photo-album triggers, phone pairing commands, routine completion tracking. |
| **5. Autobiographical** | Long-term identity core, life chapters, and daily personal logs | `identity_core`, `life_chapters`, `preferences`, `personal_records`, `daily_logs` | The patient's foundational self ("Born in Bristol 1944", "Married Arthur in 1968", "Loves Earl Grey tea"). |
| **6. Safety & Clinical** | Guardrails, vital signs, clinical responses, and consent | `safety_constraints`, `care_alerts`, `medication_responses`, `symptom_ts` (time-series), `physiology_ts` (time-series), `engagement_ts` (time-series), `consent_records`, `deletion_requests`, `audit_events`, `audit_counters`, `mobile_sos`, `mobile_sos_gates` | Strict clinical SLA tracking (under 120s for emergencies). Immutable cryptographic audit logs. |

### 5.2 The 4 MongoDB Time-Series Collections
Configured with `timeField: "timestamp"`, `metaField: "metadata"`, and `granularity: "seconds"`:
1. `memory_trace_ts`: Tracks episodic retrieval frequency, access latency, and stability degradation.
2. `symptom_ts`: High-frequency clinical observations (tremors, speech latency, repetition counts).
3. `physiology_ts`: Biometric telemetry from wearable smartwatches (heart rate, SpO2, skin temperature).
4. `engagement_ts`: Patient interaction cadence, voice response time, and cognitive responsiveness.

### 5.3 The 2 Epistemic Read Views
1. **`patient_utterances` (View on `conversation_turns`):**
   - Filter: `{ role: "patient", epistemic: "observed", redacted: { $ne: true } }`
   - Purpose: Contains ONLY what the patient actually said. **This is the only conversational history the companion model is permitted to inspect**, mathematically eliminating prompt-injection attacks and self-reinforcing AI hallucinations.
2. **`inference_review_queue` (View on `inferences`):**
   - Filter: `{ "promotion.state": "proposed", epistemicStatus: { $in: ["inferred", "corroborated"] } }`
   - Purpose: Inbox for the Caregiver Mission Control dashboard. Displays candidate insights derived by Gemini for one-click caregiver ratification.

### 5.4 The Six Hard Schema Invariants (I1–I6)
- **Invariant I1 (Household Scoping):** Every single document in all 46 collections MUST contain `householdId` and `subjectId`. Unscoped cross-tenant queries are blocked at the driver level.
- **Invariant I2 (Audit Immutability):** Documents in `audit_events` and `sources` are strictly write-once. Updates and deletions throw a database-level authorization violation.
- **Invariant I3 (Evidence Grounding):** An episode in `episodes` MUST reference an existing `source_id` in `sources`.
- **Invariant I4 (Epistemic Hygiene):** The companion's question-answering route (`/ask`) MUST filter on `{ reviewStatus: "approved", isCurrent: true }`. Unreviewed drafts are invisible to the patient.
- **Invariant I5 (Idempotent Execution):** Every action, reminder, or state change MUST carry a unique `idempotency_key` preventing replay attacks or duplicate reminders.
- **Invariant I6 (Cryptographic Non-Repudiation):** Caregiver approvals and overrides MUST record the authenticated `actor_id`, timestamp, and client signature.

---

## 6. Mathematical Spaced-Retrieval & Memory Decay Engine

AnchorCare implements a biomimetic memory stability and decay model inspired by Hermann Ebbinghaus's forgetting curve and SuperMemo SM-2 research (`engram-retrieval/src/rehearsal.js`):

### 6.1 The Forgetting Curve Formula
The probability of a patient successfully retrieving a memory item at time $t$ (days since last recall) is defined as:
$$R(t) = \exp\left(-\frac{t}{S}\right)$$
Where:
- $R(t) \in (0, 1]$ is the memory **Retrievability**.
- $t$ is the elapsed time in fractional calendar days.
- $S \ge 0.5$ is the memory **Stability** (measured in days).

### 6.2 Stability Growth Function
When a memory is successfully practiced and recalled, its stability increases according to:
$$S' = S \cdot \left(1 + \alpha \cdot \exp(-\beta \cdot R)\right)$$
Default system parameters:
- Baseline initial stability: $S_0 = 1.0\text{ day}$ (minimum bound $S_{\min} = 0.5\text{ days}$).
- Growth factor: $\alpha = 1.5$.
- Decay sensitivity: $\beta = 0.5$.
- Target retrievability threshold: $r = 0.70$.

### 6.3 Nightly Consolidation Worker (`engram-retrieval/scripts/nightly.js`)
- Runs daily at 02:00 UTC.
- Evaluates memory items where $R(t) < 0.70$.
- **Cognitive Safety Cap:** Selects at most **3 candidate memories per day** for gentle conversational rehearsal.
- If the patient was already tested today, duplicate attempts are rejected to prevent cognitive exhaustion.

---

## 7. MongoDB Atlas Native Hybrid Search ($rankFusion) & Reranking

In `engram-retrieval/src/search.js` and `db/retrieval.js`, AnchorCare executes a unified Atlas 8.0+ aggregation pipeline:

```json
[
  {
    "$rankFusion": {
      "branches": [
        {
          "$search": {
            "index": "episodes_text",
            "text": {
              "query": "Where did I put my glasses?",
              "path": "canonical_text"
            }
          }
        },
        {
          "$vectorSearch": {
            "index": "episodes_auto",
            "path": "embedding",
            "queryVector": [0.014, -0.052, "... 768-dim vector ..."],
            "numCandidates": 100,
            "limit": 20,
            "filter": {
              "householdId": "household_richmond_01",
              "subjectId": "margaret",
              "reviewStatus": "approved",
              "isCurrent": true
            }
          }
        }
      ]
    }
  },
  {
    "$project": {
      "_id": 1,
      "event_id": 1,
      "canonical_text": 1,
      "eventStart": 1,
      "source_id": 1,
      "score": { "$meta": "searchScore" }
    }
  }
]
```

### Critical Implementation Rules:
1. **Pre-Filtering Inside `$vectorSearch`:** All security and patient filters MUST sit *inside* the vector search branch. Post-filtering risks returning an empty set when matching memories exist.
2. **No `$project` Inside Fusion Branches:** Atlas prohibits projections inside `$rankFusion` child branches; projections execute only after fusion.
3. **Graceful Fallback Hierarchy:**
   $$\text{Atlas \$rankFusion} \longrightarrow \text{Local In-Memory BM25 Search} \longrightarrow \text{Deterministic Schedule Fallback}$$

---

## 8. Atlas Stream Processing (ASP) Architecture

The real-time context assistance engine uses Atlas Stream Processing (`engram-retrieval/STREAM-PROCESSING.md`, `atlas/context-pipeline.json`):

```mermaid
flowchart LR
    A[Raw Sensor Telemetry<br/>BLE Beacon / GPS Fix] --> B[Collection: context_events]
    B --> C[Atlas Stream Processor<br/>EngramContextStream]
    C --> D[Windowed Join<br/>Matching Approved Plans]
    D --> E[Idempotent Upsert<br/>assistance_candidates]
    E --> F[Background Worker<br/>Deduplication & Cooldown]
    F --> G[Deliverable Patient Prompt<br/>GET /prompts?patient_id=margaret]
```

- When Margaret walks near the desk, a BLE beacon emits a `place_id: "desk"` event into `context_events`.
- The ASP continuous stream joins this against active records in `plans` (e.g. `album_desk_001`).
- An idempotent record is inserted into `assistance_candidates`.
- The companion displays: *"Would you like to look at the family photo album on your desk?"*

---

## 9. Epistemic Hygiene & The Anti-Confabulation Loop

To mathematically eliminate hallucination feedback loops, AnchorCare classifies every system entity into three rigid epistemic tiers:

```mermaid
stateDiagram-v2
    direction TB
    [*] --> Tier1_Observed: Microphone Audio / GPS / Hardware Beacon
    Tier1_Observed --> Tier2_Approved: Human Caregiver Review & Ratification
    Tier2_Approved --> LLM_Reasoning: Valid Citation Evidence Input
    LLM_Reasoning --> Tier3_Generated: Gemini 4 Argon Output
    Tier3_Generated --> Tier1_Observed: FORBIDDEN (Driver Level Violation)
    Tier3_Generated --> Tier2_Approved: ONLY via Caregiver Cryptographic Signature
```

### The Inviolable Epistemic Law
- **Tier 1 (Observed):** Raw, immutable sensor facts (audio stream, GPS fix).
- **Tier 2 (Approved):** Human-verified facts (`reviewStatus: "approved"`). **Only Tier 2 facts can ever be cited by Gemini as historical truth.**
- **Tier 3 (Generated / Inferred):** Machine-generated claims (`epistemic: "generated"`). Must have `sourceId: null`.
- **The Guarantee:** An LLM-generated inference can NEVER enter the episodic search path without explicit human caregiver ratification.

---

## 10. Edge Hardware Audio & VAD Pipeline (`agent/capture.html`)

The edge web interface implements a resilient acoustic ingestion pipeline that operates reliably in adverse browser environments:

```mermaid
flowchart TD
    MIC[Microphone Input] --> AGC[Web Audio AGC & 16kHz Downsampler]
    AGC --> VAD[RMS Voice Activity Detector]
    VAD --> BUF[Rolling 12s Pre-Speech Ring Buffer]
    BUF --> REC{Speaking Detected?}
    REC -->|Yes| ACC[Accumulate Speech Audio]
    REC -->|Silence > 900ms| POST[POST /capture/audio FormData WebM]
    POST --> DAEMON[Agent 1: Gemini 4 Argon Diarization]
    DAEMON --> SYNTH[Web Audio Speech Synthesis]
    SYNTH -->|aiSpeaking Flag| MUTE[Auto-Mute Mic to Stop Feedback]
```

### Key Acoustic Engineering Features:
- **HTML5 MediaRecorder Integration:** Eliminates buggy Chrome `webkitSpeechRecognition` crashes on non-HTTPS origins.
- **Zero-Flicker State Machine:** Strict transitions (`idle` $\leftrightarrow$ `speaking` $\leftrightarrow$ `processing` $\leftrightarrow$ `muted` $\leftrightarrow$ `manual_recording`) eliminate high-frequency DOM rewrites.
- **Acoustic Self-Echo Cancellation:** Automatically asserts `aiSpeaking = true` during speech synthesis playback, discarding incoming audio packets to prevent the AI from hearing and responding to itself.

---

## 11. Gemini 4 Argon Acoustic Diarization & Biometrics

Inside `agent/daemon.js`, raw audio chunks are dispatched to Gemini 4 Argon with acoustic persona instructions:

### 11.1 Person Identification Spec
```javascript
const KNOWN_IDENTITIES = [
  { name: "Sumesh", role: "user", relation: "User / Engineer" },
  { name: "Margaret", role: "patient", relation: "Elderly Patient with Dementia" },
  { name: "Jane", role: "caregiver", relation: "Primary Family Caregiver" },
  { name: "David Lee", role: "physiotherapist", relation: "Visiting Healthcare Professional" },
  { name: "Sam", role: "friend", relation: "Family Friend" }
];
```

### 11.2 Atlas Care Spec Pattern Matching
Transcripts are continuously cross-referenced against approved care specs seeded in Atlas:
- `glasses`: Bedside table / reading desk location.
- `breakfast`: Porridge with honey and tea at 08:30 AM.
- `david_lee`: Physiotherapist appointment on Tuesday at 14:00.
- `garden`: Gentle afternoon walk in Richmond courtyard.
- `call_margaret`: Outbound telephony escalation request.

---

## 12. GPS Geofencing & Wandering Prevention Engine

The geofencing subsystem (`agent/daemon.js`, `caregiver/policy.py`) executes continuous spatial monitoring:

### 12.1 Mathematical Formulation (Haversine Metric)
Given the patient's current coordinate $(\phi_2, \lambda_2)$ and home safe-harbor coordinate $(\phi_1, \lambda_1)$:
$$a = \sin^2\left(\frac{\Delta\phi}{2}\right) + \cos(\phi_1)\cos(\phi_2)\sin^2\left(\frac{\Delta\lambda}{2}\right)$$
$$d = 2R \cdot \text{atan2}\left(\sqrt{a}, \sqrt{1-a}\right)$$
Where $R = 6,371,000\text{ meters}$. Safe harbor radius is set to **$r_{\text{safe}} = 50.0\text{ meters}$**.

### 12.2 Boundary State Transitions
```mermaid
stateDiagram-v2
    [*] --> SAFE: Distance <= 50m
    SAFE --> WARNING: 50m < Distance <= 120m
    WARNING --> SAFE: Returns Home
    WARNING --> BREACH: Distance > 120m OR Rapid Heading Drift
    BREACH --> ESCALATION: Automated Alert + Caregiver SMS + Twilio Call
```

---

## 13. Caregiver Action Policy Engine & TOCTOU Safeguards

The policy engine (`caregiver/policy.py`, `src/lib/caregiverEngine.ts`) governs all agent-initiated intents:

### 13.1 The 3-Tier Policy Matrix
| Policy Tier | Permitted Action Types | Execution Gate |
|---|---|---|
| **AUTO_EXECUTE** (Low Risk) | `FLAG_MEMORY_CONFLICT`, `LOG_PATIENT_MOOD_REPORT`, `SHOW_ORIENTATION_CARD`, `ALERT_CAREGIVER_LOOP_DETECTED` | Executed immediately; logged to `audit_events`. |
| **REQUIRE_APPROVAL** (Medium Risk) | `CREATE_REMINDER`, `DRAFT_FAMILY_MESSAGE`, `MARK_ROUTINE_COMPLETED` | Held in `pending_approval` queue; requires authenticated caregiver click. |
| **PROHIBITED** (High Risk) | `CHANGE_MEDICATION_DOSE`, `UNLOCK_DOOR`, `CONTACT_EMERGENCY_SERVICES` | Blocked at runtime; raises fatal permission violation. |

### 13.2 Idempotency Key Formulation
To eliminate duplicate actions during network retries:
$$\text{Key} = \text{idem\_} + \text{action\_type} + \text{\_} + \text{SHA256}(\text{action\_type} : \text{target\_id} : \text{summary} : \text{evidence\_ids})[:16]$$

### 13.3 TOCTOU (Time-of-Check to Time-of-Use) Protection
Before executing an approved action, the engine re-queries MongoDB Atlas:
1. Verifies that all `supporting_evidence_ids` still exist and have `status: "active"`.
2. If a caregiver retracted an evidence event while the action was pending, the action is **aborted immediately with an invalidation error**.

---

## 14. Double-Checked Evidence Citation & Model Entailment

AnchorCare enforces a strict 4-phase generation and quote validation loop (`integration/engram.ts`):

```mermaid
sequenceDiagram
    participant C as Patient Companion
    participant G as Gemini 4 Argon
    participant Q as checkedSourceQuotes()
    participant V as verifyConversation()
    participant DB as MongoDB Atlas

    C->>DB: 1. Pre-Retrieval (Household-Scoped)
    DB-->>C: Retrieved Context & Sources
    C->>G: 2. Generate Structured Answer
    G-->>C: JSON: { status, claims: [ { text, citations: [ { quote, sourceId } ] } ] }
    C->>Q: 3. Substring Exactness Match
    Note over Q: Verifies that every quoted string<br/>exists verbatim in DB source text
    Q-->>C: Quotes Verified: OK
    C->>V: 4. Secondary Entailment Check
    V-->>C: Entailment Validated: OK
    C->>DB: 5. Fresh Database Re-Read
    Note over DB: Guards against concurrent<br/>retractions during inference
    DB-->>C: DB Unchanged
    C-->>Patient: Answer Presented
```

If any quoted text does not match the raw source record, or if the database changed during generation, the answer is discarded and replaced with a calm fallback: *"I couldn't confirm that from the current saved reports. Let's check with your caregiver."*

---

## 15. Telephony & Emergency SOS Subsystem (`agent/call-service.js`, `mobile-link.ts`)

- **Natural Language Intent Recognition:** Spoken phrases such as *"call Margaret"*, *"phone my daughter"*, *"I am lost"*, or *"call my caregiver"* trigger outbound telephony.
- **Double Permission Gate:** Both `liveCalls === true` AND `allowSos === true` must be satisfied.
- **Twilio Voice Integration:** Places outbound PSTN calls to real phone numbers using Amazon Polly's calm neural voice (`Polly.Amy`).
- **Anonymous Caregiver Mode:** When anonymous mode is active, caregiver personal numbers are concealed, providing a synthetic bridge.

---

## 16. GridFS Image Memory & Cross-Device PWA Synchronization

- **Image Persistence:** Family photo albums are stored in MongoDB GridFS (`engram_images.files` and `engram_images.chunks`).
- **Conversational Photo Recall:** When Margaret asks *"Do you have a picture of Sarah?"*, the system locates the image via semantic tags and pushes it via Web Push / WebSockets to the paired `/phone` companion app.
- **Patient Comfort:** The mobile PWA displays the photograph with high-contrast familiar captions ("Sarah at your birthday in Richmond").

---

## 17. Dual-Surface Web Application Architecture

AnchorCare provides two purpose-built, responsive user interfaces:

### Surface A: Caregiver Mission Control (`http://localhost:3000`)
- Built with React 18, Vite, and TailwindCSS.
- **Memory Ledger:** Real-time inspection of Episodic, Semantic, Procedural, and Autobiographical memories.
- **Policy Actions View:** 1-click Approve / Reject interface for pending actions with TOCTOU simulation buttons.
- **Acoustic Timeline Cockpit:** Live display of diarized turns with confidence ratings and speaker badges.
- **Medication & Routine Monitor:** Visual indicators of daily medication compliance and routine anomalies.

### Surface B: Patient Mobile Companion (`http://localhost:3000/phone`)
- Progressive Web App (PWA) with Service Worker offline caching (`public/phone-sw.js`).
- Dementia-friendly design: large typography, high contrast, uncluttered layout.
- One-touch Emergency SOS button and familiar family photo carousel.

---

## 18. Medication Reminder Workflow (`integration/medication.ts`)

- **Deterministic 2-Second Worker:** A local worker monitors active medication plans.
- **Atomic Compliance Reporting:** When a medication reminder is due, it triggers a gentle spoken prompt.
- When the patient reports completion, an atomic record is logged in `daily_logs` and `medication_responses` with outcome `reported_done`.

---

## 19. Security, Compliance & Clinical Ethics Matrix

| Standard / Principle | Requirement | AnchorCare Implementation |
|---|---|---|
| **UK GDPR & DPA 2018** | Article 9 Special Category Health Data | Household-scoped encryption at rest. In-memory access keys. Zero plain-text credentials in browser `localStorage`. |
| **NHS Caldicott Principles** | Principles 1–8 (Justify purpose, minimum necessary, strict need-to-know) | Read views (`patient_utterances`) hide system inferences from the patient. Access tokens partitioned by role (`caregiver` vs `patient`). |
| **Biometric Voice Privacy** | Protection of ambient voice data | Audio is processed in a 12-second rolling ring buffer in volatile memory; raw audio chunks are deleted immediately after transcription. |
| **Rate & Resource Limiting** | Denial of Service & Inference Exhaustion | Process-local limiters: 12 answer starts/minute per credential, 40 picture requests/minute, max 2 concurrent async inference jobs per actor. |

---

## 20. Complete HTTP & SSE API Catalog

### Port 3000 (Express & Engram Gateway)
- `POST /api/engram/ask` — Authenticated synchronous memory question answering.
- `POST /api/engram/asks` — Asynchronous SSE background job dispatch (returns `202 Accepted`).
- `GET /api/engram/asks/:jobId` — Polling status and result snapshot for async inference jobs.
- `GET /api/engram/ledger` — Lists active and historical memory records.
- `POST /api/engram/ledger/change` — Caregiver edit, retraction, or approval of memory records.
- `POST /api/engram/mobile/pair` — Pairs a new mobile phone receiver.
- `POST /api/engram/mobile/sos` — Initiates emergency SOS assistance.
- `GET /api/engram/images/:id/content` — Streams GridFS photo bytes.
- `GET /admin/gemini` — Diagnostics for Gemini models and API quota status.

### Port 4319 (Agent Ambient Daemon)
- `GET /capture` — Serves the Edge Acoustic Cockpit HTML interface.
- `POST /capture/audio` — Receives multipart WebM audio chunks; triggers Gemini 4 Argon diarization.
- `GET /capture/events` — Server-Sent Events (SSE) stream broadcasting live turns to all connected consoles.
- `GET /status` — Real-time telemetry: active speaker, VAD status, geofence coordinates, Twilio state.
- `POST /geofence/telemetry` — Receives GPS coordinates; evaluates Haversine safe-harbor boundary.
- `POST /call/trigger` — Initiates an outbound telephone call to Margaret or caregiver.

---

## 21. Operational Runbook & Reproduction Steps

### 21.1 Environment Setup (`.env`)
```dotenv
# Core Models & Providers
GEMINI_API_KEY=AIzaSy...
GEMINI_MODEL=gemini-4-argon

# MongoDB Atlas Database
MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/?retryWrites=true&w=majority
MONGODB_DATABASE=engram
STORE=mongodb
HYBRID_BACKEND=native

# Security & Ports
PORT=3000
DAEMON_PORT=4319
ANCHORCARE_ADMIN_KEY=anchorcare_admin_secret_key_2026
ANCHORCARE_COMPANION_KEY=anchorcare_companion_secret_key_2026
ANCHORCARE_PATIENT_ID=margaret

# Telephony (Optional Live Twilio)
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_FROM_NUMBER=+447700900000
ENABLE_LIVE_SOS_CALLS=false
MARGARET_PHONE_NUMBER=+447700900077
```

### 21.2 System Startup
```powershell
# Step 1: Install dependencies
npm install

# Step 2: Verify database schema and search indexes
npm run schema:verify

# Step 3: Launch ambient agent daemon (Port 4319)
node agent/daemon.js

# Step 4: In a second terminal, launch Caregiver Web Application (Port 3000)
npm run dev
```

### 21.3 Hackathon Verification Script (Live Demonstration)
1. **Live Ambient Diarization:** Speak into the browser microphone at `http://127.0.0.1:4319/capture`. Observe Gemini 4 Argon transcribing and correctly tagging your identity as **Sumesh**.
2. **Memory Spec Recall:** Ask *"Where did I leave my glasses?"*. Observe the agent retrieving the approved memory from Atlas and speaking the grounded answer in under 4 seconds.
3. **Outbound Anonymous Call:** Say *"Call Margaret"*. Observe the daemon transitioning to dialing mode, initiating the Twilio voice bridge with Polly.Amy synthetic reassurance.
4. **Caregiver Policy & TOCTOU Veto:** In the Caregiver Mission Control (`http://localhost:3000`), attempt to approve a pending reminder after retracting its evidence event. Observe the policy engine instantly blocking execution with a TOCTOU validation error.

---
*End of Master System Specification.*
