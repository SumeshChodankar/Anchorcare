# [AnchorCare + Engram](https://anchorcare-agent.vercel.app/)

# The Problem

Millions of people living with dementia, Alzheimer's disease, cognitive decline, brain injury, and age-related memory impairment struggle with retaining important information about their daily lives.

For patients, memory loss can lead to:

- Forgetting loved ones and important relationships
- Missing medications and appointments
- Losing context about recent events
- Increased anxiety and confusion
- Reduced independence and quality of life

For caregivers and family members, the challenge is equally difficult:

- Constantly repeating information
- Managing reminders manually
- Tracking changes in memory over time
- Providing context during conversations
- Ensuring important memories remain accessible

Current solutions are fragmented. Notes apps store information but cannot reason about it. Chatbots can converse but forget critical personal context. Medical systems are often focused on records rather than preserving meaningful day-to-day memories.

# Our Vision

AnchorCare aims to become a trusted AI memory companion that helps preserve personal identity, daily context, and meaningful relationships.

Rather than acting as a medical decision system, AnchorCare serves as a memory support layer between patients, caregivers, and AI.

The goal is to create a system that can:

- Remember important life events
- Recall family members, friends, and caregivers
- Surface relevant memories when needed
- Provide evidence-backed responses
- Assist with reminders and routines
- Help maintain continuity of personal identity over time

# What We Are Building

AnchorCare + Engram combines long-term memory retrieval, caregiver oversight, and conversational AI into a unified memory assistance platform.

The platform consists of:

### Memory Layer

A structured memory ledger that stores approved life events, people, routines, preferences, and contextual information.

### Retrieval Layer

Engram retrieves the most relevant memories based on the user's question, current context, and historical information.

### Companion Layer

An AI companion that answers questions using verified memory evidence rather than relying solely on model-generated responses.

### Caregiver Layer

A caregiver review system that allows memories, reminders, corrections, and images to be reviewed before becoming part of the patient's memory history.

### Proactive Support Layer

The system can surface reminders, familiar faces, important routines, and contextual information at appropriate moments.

# Why It Matters

Memory is more than information.

Memory is identity.

As cognitive decline progresses, people often lose access to the stories, relationships, and experiences that define who they are. We believe AI can help preserve and reconnect those memories, giving patients greater confidence and giving caregivers better tools to support them.

AnchorCare is designed to be the foundation for a future generation of memory-aware AI systems that can safely assist people living with cognitive challenges while keeping humans in control.





## AnchorCare's original React/TypeScript prototype with Engram's MongoDB retrieval and proactive-trigger component integrated into the Express backend.




## Demo Videos

- **System Overview & Walkthrough**  
  https://youtu.be/LCQWDoMntEg?is=JhPjxnf9YH5j61WX

- **Medication & Companion Workflow Demo**  
  https://youtu.be/wURSUnDup5M?is=qsPfqd5qlDpaIQ8K

## Run

Requires Node.js 22.12+ (tested with 24.22.1). Vite 8 does not support the previously installed Node 20.18 runtime.

```sh
npm ci --ignore-scripts --no-audit --no-fund
# Copy .env.example to a private .env and configure it locally.
npm run dev

AnchorCare's original React/TypeScript prototype with Engram's MongoDB retrieval and proactive-trigger component integrated into the Express backend.

## Run

Requires Node.js 22.12+ (tested with 24.22.1). Vite 8 does not support the previously installed Node 20.18 runtime.

```sh
npm ci --ignore-scripts --no-audit --no-fund
# Copy .env.example to a private .env and configure it locally.
npm run dev
```

Open http://127.0.0.1:3000 and choose **Open persistent memory workspace**. Enter the private ANCHORCARE_ADMIN_KEY for caregiver actions or ANCHORCARE_COMPANION_KEY for patient reads/responses. Keys remain in page memory and are not put in localStorage. The React role switcher in the original demo does not grant server caregiver permissions.

For real Atlas storage set STORE=mongodb and configure MONGODB_URI. Keep ANCHORCARE_PATIENT_ID in SUBJECT_IDS; the bridge uses this server-configured patient and ignores client-supplied patient IDs. Set distinct strong ADMIN_TOKEN/COMPANION_TOKEN and separate ANCHORCARE_ADMIN_KEY/ANCHORCARE_COMPANION_KEY values. Never commit .env. The server binds to loopback by default.

## What is connected

- `engram-retrieval/` contains Athul's tested backend component, copied from 4thul-jk/Engram-Hackathon at commit 22b37bb, including its tests, setup scripts and documentation.
- `integration/engram.ts` mounts `/api/engram/*` inside AnchorCare's Express process. The same process connects to Atlas and runs the reminder worker. No second server or database credentials in browser code are required.
- `src/components/EngramMemoryView.tsx` provides source-backed draft ingestion, caregiver approval/withdrawal, unified memory retrieval, optional Gemini answers and approved reminder creation/cancellation/responses.
- `/api/engram/answer` retrieves evidence on the server; it does not trust browser-supplied evidence. With no Gemini key it explicitly returns evidence_only, not a fake model answer. With a key it uses GEMINI_MODEL (default gemini-4-argon), Interactions structured output and typed citation membership checks with a fresh retrieval before response.
- Existing daily/person records and context-trigger endpoints are mounted and documented in the component. Stream Processing remains prepared but not deployed; CONTEXT_PROCESSING stays local.

The main **Memory Ledger** loads/saves through Atlas-backed routes with review and correction history. The main **Patient Companion** now asks the authenticated server, which selects Atlas records by question/time and displays evidence plus current reminders. Original browser companion/ledger examples remain collapsed separately. Policy & Actions and the Python reference view are still browser demos, not migrated server workflows. No browser sample data is silently promoted into approved memory.

## Important boundaries

This is a local synthetic-data integration. Entered keys are shared prototype credentials, not production user authentication. Production needs individual sessions, patient/guardian authorization and HTTPS before external access. The server-selected single patient does not implement a multi-patient login system.

No audio/video upload, face recognition, guardian calling, emergency response or clinical decision system is added. Citation/quote membership does not prove semantic support. Medical self-reports and plans retain their meaning; no medication instructions are executed. The old client-context `/api/gemini/reason` endpoint is disabled with HTTP 410. `/api/engram/ask` retrieves its own evidence and optionally invokes Gemini; a model outage is shown as failure, not silently replaced with browser sample answers.

Long-running operations can still overlap approval changes; refreshed citations reduce, but do not eliminate, races. Server ledger corrections now use a MongoDB transaction covering original/replacement/source/audit writes; replacements begin as drafts. Browser demo correction tests alone do not prove this behaviour; a separate live HTTP/Atlas correction check has passed.

## Validation

For realistic fictional patient records, run `npm run demo:seed-atlas`, then `npm run demo:verify-atlas` against the running app. See [demo scenario and questions](docs/DEMO-DATA.md). No real patient data is included.

```sh
npm test
npm run test:memory
npm run lint
npm run build
```

See [integration notes](docs/ANCHORCARE-INTEGRATION.md) for exact verification and remaining work. Engram APIs: [unified context](engram-retrieval/MEMORY-CONTEXT.md), [team handoff](engram-retrieval/TEAM-HANDOFF.md), [daily/personal records](engram-retrieval/DAILY-AND-PERSONAL.md), [stream setup](engram-retrieval/STREAM-PROCESSING.md).

### Fictional medication reminder demo

See [the medication demo guide](docs/MEDICATION-DEMO.md) for simulation data, caregiver approval, timed reminders, patient responses and caregiver review. Seed with `npm run demo:seed-medication`. All medication details are fictional; patient responses are reports, not proof of ingestion.

### Automatic Gemini recovery

The Patient Companion uses cancellable background reply jobs with bounded transient-error retries and fresh evidence checks. See [Gemini recovery](docs/GEMINI-RECOVERY.md) for endpoints, limits and verification. Jobs are in memory and do not survive server restart.

### Familiar people and memory pictures

Caregiver tools now support picture uploads and approval. The companion retrieves matching approved pictures from MongoDB GridFS. See [image recall](docs/IMAGE-RECALL.md). Seed labelled fictional illustrations with `npm run demo:seed-images`; upload real authorised family pictures through the caregiver panel.

### Phone receiver and SOS links

Open `/phone` on a phone on the same Wi-Fi and pair it from caregiver tools. Approved pictures can forward automatically, and caregiver/demo receivers can receive SOS browser alerts. See [phone-link setup](docs/PHONE-LINK.md). Actual voice calls require private provider setup and explicit enabling; real calls are disabled in the demo.

Phone delivery: see [PHONE-LINK.md](docs/PHONE-LINK.md). Background notification support and production deployment preparation: [DEPLOYMENT.md](docs/DEPLOYMENT.md). Local HTTP uses the open-page receiver; background Web Push requires HTTPS and handset opt-in. Real calls remain disabled by default.

Free conversation-provider setup (OpenRouter or local Ollama): [FREE-MODEL-SETUP.md](docs/FREE-MODEL-SETUP.md). Gemini settings are preserved for switching back.
