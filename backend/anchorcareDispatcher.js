import http from "http";
import https from "https";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, ".env") });
dotenv.config({ path: path.resolve(__dirname, "../adapter/.env") });

const ANCHORCARE_API_BASE_URL = process.env.ANCHORCARE_API_BASE_URL || "http://localhost:3000";
const ANCHORCARE_ADMIN_KEY = process.env.ANCHORCARE_ADMIN_KEY || "";
const TARGET_SUBJECT_ID = process.env.ANCHORCARE_PATIENT_ID || "demo-person-001";
const TARGET_HOUSEHOLD_ID = process.env.ANCHORCARE_HOUSEHOLD_ID || "anchorcare-demo";

/**
 * Forwards an extracted memory immediately to AnchorCare as a Draft.
 * Runs non-blocking in the background with an Idempotency-Key.
 */
export async function forwardMemoryToAnchorCare(memoryDoc, hasVisual = false) {
  // If credentials are not present, skip forwarding gracefully
  if (!ANCHORCARE_ADMIN_KEY) {
    return { forwarded: false, reason: "No ANCHORCARE_ADMIN_KEY configured" };
  }

  // Ensure valid event timestamp
  let occurredAt = memoryDoc.when;
  if (!occurredAt || isNaN(Date.parse(occurredAt))) {
    occurredAt = memoryDoc.createdAt ? new Date(memoryDoc.createdAt).toISOString() : new Date().toISOString();
  }

  const payload = {
    household_id: TARGET_HOUSEHOLD_ID,
    subject_id: TARGET_SUBJECT_ID,
    source_type: "patient_report",
    review_status: "pending_caregiver_review", // Always DRAFT
    text: memoryDoc.what,
    occurred_at: occurredAt,
    context: {
      people_mentioned: memoryDoc.who || [],
      location: memoryDoc.where || null,
      has_visual_frame: !!hasVisual,
      input_channel: hasVisual ? "webrtc_camera_voice" : "webrtc_voice_or_text",
    },
    provenance: {
      source_system: "engram-input-voice-companion",
      source_db: "test",
      source_collection: "memories",
      source_record_id: String(memoryDoc._id),
      source_patient_id: memoryDoc.patientId,
      recorded_at: memoryDoc.createdAt ? new Date(memoryDoc.createdAt).toISOString() : new Date().toISOString(),
    },
  };

  const data = JSON.stringify(payload);
  const url = new URL("/api/engram/episodes", ANCHORCARE_API_BASE_URL);

  return new Promise((resolve) => {
    const client = url.protocol === "https:" ? https : http;
    const req = client.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
          Authorization: `Bearer ${ANCHORCARE_ADMIN_KEY}`,
          "Idempotency-Key": `engram_mem_${memoryDoc._id}`, // Prevents duplicate ingestion
        },
        timeout: 5000,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            console.log(`✓ [AnchorCare Dispatch] Memory ${memoryDoc._id} successfully forwarded as Draft (HTTP ${res.statusCode})`);
            resolve({ forwarded: true, status: res.statusCode });
          } else {
            console.warn(`! [AnchorCare Dispatch] Forwarding returned HTTP ${res.statusCode}: ${body}`);
            resolve({ forwarded: false, status: res.statusCode, error: body });
          }
        });
      }
    );

    req.on("error", (err) => {
      // Non-blocking log if target server is offline/unreachable
      console.warn(`! [AnchorCare Dispatch] Target server at ${ANCHORCARE_API_BASE_URL} unreachable (${err.message}). Memory remains safely in MongoDB.`);
      resolve({ forwarded: false, error: err.message });
    });

    req.on("timeout", () => {
      req.destroy();
      console.warn(`! [AnchorCare Dispatch] Timeout connecting to ${ANCHORCARE_API_BASE_URL}`);
      resolve({ forwarded: false, error: "timeout" });
    });

    req.write(data);
    req.end();
  });
}
