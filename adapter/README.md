# AnchorCare Integration Adapter

This adapter connects memories recorded by the **Engram Voice/Multimodal Companion** (`test.memories`) to the **AnchorCare Demo Retrieval App** without modifying either system's database schema.

---

## Safety & Governance Principles

1. **Non-Destructive & Isolated**:
   - Operates in a standalone directory (`adapter/`).
   - Uses **read-only** `.find()` queries on the source database (`test.memories`).
   - Never alters or deletes source records.
2. **Explicit Patient Mapping**:
   - Requires explicit mapping in `adapter/mapping.json`.
   - `arthur_01` maps to `anchorcare-demo` / `demo-person-001`. Unmapped patient IDs are rejected.
3. **Draft-Only Import (Caregiver In the Loop)**:
   - All records are ingested with `review_status: "pending_caregiver_review"` and `source_type: "patient_report"`.
   - Never auto-approved. Never creates medication instructions or reminders.
4. **Timestamp Integrity**:
   - Distinguishes **event time** (`occurred_at`) from **recording time** (`recorded_at`).
   - If an event time is ambiguous (e.g. `"Today"`, `"Now"`, or missing), the record is marked as `NEEDS_REVIEW` and skipped from automatic import rather than fabricating timestamps.
5. **Idempotency**:
   - Maintains an independent checkpoint (`adapter/checkpoint.json`).
   - Retries skip already-imported records by their `_id`.

---

## Commands

### 1. Read-Only Dry Run
Inspects the database, verifies patient mappings, and displays proposed actions without modifying anything:
```bash
node adapter/dry-run.js
```

### 2. Run Test Suite
Runs the unit tests verifying mapping, draft status, time handling, and idempotency:
```bash
node adapter/test.js
```

### 3. Sync to Ingestion Endpoint
When the AnchorCare API is reachable, set `ANCHORCARE_API_URL` and `ANCHORCARE_API_KEY` in `adapter/.env` and run:
```bash
node adapter/sync.js
```
