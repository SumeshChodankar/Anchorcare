# Team Requirements & Integration Guide
**Project:** Engram Dementia Companion (Input & Memory Capture)  
**Date:** 24 October 2026  
**Target Ingestion / Retrieval System:** AnchorCare Express App  

---

## 1. System Overview & Architecture

This module provides the **Patient Voice/Vision Input Interface** and real-time ingestion pipeline:
* **Frontend:** React 19 + Native Web Audio Voice Activity Detection (VAD) + Real-time WebRTC Camera Stream + Caregiver Portal.
* **Backend:** Node.js + Express + Socket.IO server running on port `5000`.
* **Database:** MongoDB Atlas (Database: `engram`).
* **Ingestion Target:** Direct database write + automatic HTTP dispatch to AnchorCare's API (`POST /api/engram/episodes`).

```
  [ Patient Web Companion ] (React + WebRTC Audio/Video)
             │
             ▼ (Socket.IO Real-time Stream)
  [ Node.js Companion Backend ] (Port 5000)
             │
             ├──> Writes to MongoDB Atlas:
             │     • engram.conversations  (Full dialogue turns)
             │     • engram.memories       (Structured who/what/where/when)
             │     • engram.sources        (Canonical AnchorCare source reports)
             │     • engram.episodes       (Canonical AnchorCare episode drafts)
             │     • engram.alerts         (Emergency / Dosage safety flags)
             │
             └──> Real-time HTTP Dispatch (Background):
                   POST /api/engram/episodes (as DRAFT requiring caregiver review)
```

---

## 2. Shared MongoDB Atlas Cluster Configuration

Both systems connect to the same MongoDB Atlas cluster.

* **Cluster Host:** `engramdemo.betk40.mongodb.net`
* **Target Database:** `engram`
* **Patient / Subject Identity Mapping:**
  * **Input System ID:** `patientId = "arthur_01"`
  * **AnchorCare Household ID:** `householdId = "anchorcare-demo"`
  * **AnchorCare Subject ID:** `subjectId = "demo-person-001"`

---

## 3. Database Collection Schemas

### A. `engram.conversations` (Dialogue Turns)
Logs every statement spoken/typed by the patient and every spoken response from the companion.
```json
{
  "_id": "6adcea0986c2c2e392502aa7",
  "householdId": "anchorcare-demo",
  "subjectId": "demo-person-001",
  "patientId": "arthur_01",
  "role": "user",
  "content": "I went for a walk today.",
  "timestamp": "2026-10-24T17:25:29.409Z"
}
```

### B. `engram.memories` (Extracted Semantic Records)
Stores structured memory records extracted from conversations.
```json
{
  "_id": "6adcea0986c2c2e392502aa9",
  "householdId": "anchorcare-demo",
  "subjectId": "demo-person-001",
  "patientId": "arthur_01",
  "who": ["Sarah"],
  "what": "Had lunch with Sarah",
  "where": "Kitchen",
  "when": "2026-10-24T17:25:29.409Z",
  "createdAt": "2026-10-24T17:25:29.624Z"
}
```

### C. `engram.sources` (AnchorCare Canonical Source Table)
```json
{
  "_id": "source_3da6f3bc1c441ee5c482e62f71a6b9e911a9692e808a80049ad3639a269cadc3",
  "householdId": "anchorcare-demo",
  "subjectId": "demo-person-001",
  "content": "I went for a walk today.",
  "sourceType": "user_report",
  "recordedAt": "2026-10-24T17:25:29.409Z"
}
```

### D. `engram.episodes` (AnchorCare Canonical Episodes Table)
All newly ingested memories start with `reviewStatus: "pending_caregiver_review"` (Draft).
```json
{
  "_id": "ep_1792864321_ab12",
  "householdId": "anchorcare-demo",
  "subjectId": "demo-person-001",
  "summary": "Had lunch with Sarah",
  "what": "Had lunch with Sarah",
  "place": "Kitchen",
  "searchText": "Had lunch with Sarah. Kitchen",
  "sourceIds": ["source_3da6f3bc1c441ee5c482e62f71a6b9e911a9692e808a80049ad3639a269cadc3"],
  "personIds": ["Sarah"],
  "eventStart": "2026-10-24T17:25:29.409Z",
  "recordedAt": "2026-10-24T17:25:29.624Z",
  "reviewStatus": "pending_caregiver_review",
  "eventStatus": "reported_completed",
  "isCurrent": true
}
```

### E. `engram.alerts` (Doctor & Caregiver Safety Notifications)
Generated when the patient reports pain, falls, or asks about medicine dosage.
```json
{
  "_id": "6adcf12386c2c2e392502b01",
  "householdId": "anchorcare-demo",
  "subjectId": "demo-person-001",
  "patientId": "arthur_01",
  "type": "MEDICATION_DOSAGE",
  "message": "Patient inquired about medication dosage. Advice withheld.",
  "timestamp": "2026-10-24T18:00:00.000Z"
}
```

---

## 4. API Endpoints Expected by the Companion

### 1. Ingestion Endpoint
* **Method:** `POST`
* **Route:** `/api/engram/episodes`
* **Header:** `Authorization: Bearer <ANCHORCARE_ADMIN_KEY>`
* **Header:** `Idempotency-Key: engram_mem_<source_record_id>`
* **Body:**
  ```json
  {
    "household_id": "anchorcare-demo",
    "subject_id": "demo-person-001",
    "source_type": "patient_report",
    "review_status": "pending_caregiver_review",
    "text": "Had lunch with Sarah",
    "occurred_at": "2026-10-24T17:25:29.409Z",
    "context": {
      "people_mentioned": ["Sarah"],
      "location": "Kitchen",
      "has_visual_frame": false,
      "input_channel": "webrtc_voice_or_text"
    },
    "provenance": {
      "source_system": "engram-input-voice-companion",
      "source_db": "engram",
      "source_collection": "memories",
      "source_record_id": "6adcea0986c2c2e392502aa9",
      "source_patient_id": "arthur_01",
      "recorded_at": "2026-10-24T17:25:29.624Z"
    }
  }
  ```

### 2. Caregiver Review Endpoint
* **Method:** `POST`
* **Route:** `/api/engram/episodes/review`
* **Body:**
  ```json
  {
    "episode_id": "ep_1792864321_ab12",
    "action": "approve" 
  }
  ```
  *(Actions: `approve` | `reject` | `withdraw`)*

---

## 5. Running the Ingestion / Retrieval Adapter

An isolated adapter is included in the project:
1. **Read-Only Dry Run:**
   ```bash
   node adapter/dry-run.js
   ```
2. **Run Acceptance Test Suite:**
   ```bash
   node adapter/demo-acceptance.js
   ```
3. **Manual Batch Sync:**
   ```bash
   node adapter/sync.js
   ```
