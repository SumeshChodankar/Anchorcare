import mongoose from "mongoose";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load backend .env for MongoDB credentials (READ-ONLY)
dotenv.config({ path: path.resolve(__dirname, "../backend/.env") });
dotenv.config({ path: path.resolve(__dirname, ".env") });

const MAPPING_FILE = path.resolve(__dirname, "mapping.json");
const CHECKPOINT_FILE = path.resolve(__dirname, "checkpoint.json");

// Read-only schema matching your existing test.memories collection
const MemorySourceSchema = new mongoose.Schema(
  {
    patientId: String,
    who: [String],
    what: String,
    where: String,
    when: String,
    createdAt: Date,
  },
  { collection: "memories" }
);

function loadMapping() {
  if (!fs.existsSync(MAPPING_FILE)) {
    throw new Error("mapping.json not found in adapter folder");
  }
  return JSON.parse(fs.readFileSync(MAPPING_FILE, "utf-8")).mappings || {};
}

function loadCheckpoint() {
  if (!fs.existsSync(CHECKPOINT_FILE)) {
    return { imported_record_ids: [] };
  }
  return JSON.parse(fs.readFileSync(CHECKPOINT_FILE, "utf-8"));
}

export function saveCheckpoint(checkpoint) {
  fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(checkpoint, null, 2), "utf-8");
}

/**
 * Evaluates whether an event time is explicit and valid.
 * Rule: We do NOT substitute createdAt silently. If there is no explicit event time,
 * it must be flagged for review.
 */
export function evaluateEventTime(whenStr) {
  if (!whenStr || typeof whenStr !== "string" || whenStr.trim() === "" || whenStr.toLowerCase() === "today" || whenStr.toLowerCase() === "now") {
    return {
      isValid: false,
      reason: "Ambiguous or relative time string. Requires clarification before import.",
      parsedIso: null,
    };
  }

  const parsed = Date.parse(whenStr);
  if (isNaN(parsed)) {
    return {
      isValid: false,
      reason: `Unparseable time string: "${whenStr}". Requires review.`,
      parsedIso: null,
    };
  }

  return {
    isValid: true,
    reason: null,
    parsedIso: new Date(parsed).toISOString(),
  };
}

/**
 * Transforms a source memory record from test.memories into an AnchorCare payload.
 * Follows strict provenance and draft-only review status rules.
 */
export function buildAnchorCarePayload(sourceDoc, mapping) {
  const patientMapping = mapping[sourceDoc.patientId];
  if (!patientMapping) {
    return {
      canImport: false,
      reason: `Unmapped patient ID: "${sourceDoc.patientId}". Rejected by policy.`,
      payload: null,
    };
  }

  const timeEvaluation = evaluateEventTime(sourceDoc.when);

  // If time is missing or ambiguous, flag for review and do not fabricate timestamps
  if (!timeEvaluation.isValid) {
    return {
      canImport: false,
      needsReview: true,
      reason: timeEvaluation.reason,
      payload: null,
      sourceId: String(sourceDoc._id),
      patientId: sourceDoc.patientId,
      proposedHousehold: patientMapping.target_household_id,
      proposedSubject: patientMapping.target_subject_id,
    };
  }

  // Exact AnchorCare Ingestion Contract
  const payload = {
    household_id: patientMapping.target_household_id,
    subject_id: patientMapping.target_subject_id,
    source_type: "patient_report", // Explicitly patient self-report, not verified observation
    review_status: "pending_caregiver_review", // Always DRAFT requiring caregiver approval
    text: sourceDoc.what,
    occurred_at: timeEvaluation.parsedIso,
    context: {
      people_mentioned: sourceDoc.who || [],
      location: sourceDoc.where || null,
    },
    provenance: {
      source_system: "engram-input-voice-companion",
      source_db: "test",
      source_collection: "memories",
      source_record_id: String(sourceDoc._id),
      source_patient_id: sourceDoc.patientId,
      recorded_at: sourceDoc.createdAt ? new Date(sourceDoc.createdAt).toISOString() : new Date().toISOString(),
    },
  };

  return {
    canImport: true,
    needsReview: false,
    reason: null,
    payload,
    sourceId: String(sourceDoc._id),
    patientId: sourceDoc.patientId,
    proposedHousehold: patientMapping.target_household_id,
    proposedSubject: patientMapping.target_subject_id,
  };
}

export async function getSourceMemories() {
  const mongoUri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/test";
  const conn = await mongoose.createConnection(mongoUri).asPromise();
  const MemoryModel = conn.model("MemorySource", MemorySourceSchema);
  const docs = await MemoryModel.find({}).sort({ createdAt: -1 }).lean();
  await conn.close();
  return docs;
}

export { loadMapping, loadCheckpoint };
