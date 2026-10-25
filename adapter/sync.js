import https from "https";
import http from "http";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import {
  getSourceMemories,
  loadMapping,
  loadCheckpoint,
  saveCheckpoint,
  buildAnchorCarePayload,
} from "./transformer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../backend/.env") });
dotenv.config({ path: path.resolve(__dirname, ".env") });

const ANCHORCARE_API_BASE_URL = process.env.ANCHORCARE_API_BASE_URL || "http://localhost:3000";
// Use Admin / Caregiver key for ingestion & review permissions
const ANCHORCARE_API_KEY = process.env.ANCHORCARE_ADMIN_KEY || process.env.ANCHORCARE_API_KEY || "";
const CONFIGURED_PATIENT_ID = process.env.ANCHORCARE_PATIENT_ID || "demo-person-001";

/**
 * Sends a post request with bounded retries for transient errors (429, 503, network drops).
 * Fails fast without retry on 400 validation or 401/403 authorization errors.
 */
async function postEpisode(payload, retries = 3) {
  const url = new URL("/api/engram/episodes", ANCHORCARE_API_BASE_URL);
  const data = JSON.stringify(payload);

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await new Promise((resolve, reject) => {
        const client = url.protocol === "https:" ? https : http;
        const req = client.request(
          url,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(data),
              Authorization: `Bearer ${ANCHORCARE_API_KEY}`,
            },
            timeout: 10000,
          },
          (res) => {
            let body = "";
            res.on("data", (chunk) => (body += chunk));
            res.on("end", () => {
              if (res.statusCode >= 200 && res.statusCode < 300) {
                try {
                  resolve({ success: true, status: res.statusCode, data: JSON.parse(body) });
                } catch (_) {
                  resolve({ success: true, status: res.statusCode, data: body });
                }
              } else if (res.statusCode === 401 || res.statusCode === 403 || res.statusCode === 400) {
                reject({ transient: false, status: res.statusCode, error: body });
              } else {
                reject({ transient: true, status: res.statusCode, error: body });
              }
            });
          }
        );

        req.on("error", (err) => reject({ transient: true, error: err.message }));
        req.on("timeout", () => {
          req.destroy();
          reject({ transient: true, error: "Request timeout" });
        });

        req.write(data);
        req.end();
      });
    } catch (err) {
      if (!err.transient || attempt === retries) {
        throw err;
      }
      const backoffMs = attempt * 1000;
      console.warn(`[Retry] Attempt ${attempt} failed: ${err.error || err}. Retrying in ${backoffMs}ms...`);
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
}

async function sync() {
  console.log("===============================================================================");
  console.log("              ANCHORCARE INGESTION ADAPTER — LIVE SYNC                         ");
  console.log("===============================================================================\n");

  const mapping = loadMapping();
  const checkpoint = loadCheckpoint();
  const importedSet = new Set(checkpoint.imported_record_ids || []);

  console.log(`[Config] Ingestion Target: ${ANCHORCARE_API_BASE_URL}/api/engram/episodes`);
  console.log(`[Config] Target Subject ID: ${CONFIGURED_PATIENT_ID}`);
  console.log(`[Config] Admin Auth Key:   ${ANCHORCARE_API_KEY ? "CONFIGURED (Hidden)" : "MISSING"}`);

  // Rule 3: Verify destination configured patient matches the mapping
  const mappedArthur = mapping["arthur_01"];
  if (mappedArthur && mappedArthur.target_subject_id !== CONFIGURED_PATIENT_ID) {
    throw new Error(
      `Patient mapping mismatch! mapping.json targets '${mappedArthur.target_subject_id}' but environment targets '${CONFIGURED_PATIENT_ID}'. Sync aborted.`
    );
  }

  const sourceRecords = await getSourceMemories();
  console.log(`\n[Source DB] Found ${sourceRecords.length} records in test.memories.`);

  const stats = {
    imported: 0,
    already_imported: 0,
    needs_review: 0,
    failed: 0,
    unmapped: 0,
  };

  for (const doc of sourceRecords) {
    const id = String(doc._id);

    // 1. Idempotency Check
    if (importedSet.has(id)) {
      stats.already_imported++;
      continue;
    }

    // 2. Transform and Validate
    const evaluated = buildAnchorCarePayload(doc, mapping);

    if (evaluated.reason && evaluated.reason.includes("Unmapped patient")) {
      stats.unmapped++;
      continue;
    }

    if (evaluated.needsReview) {
      stats.needs_review++;
      console.log(`[NEEDS REVIEW] Source ID ${id} (${doc.patientId}): ${evaluated.reason}`);
      continue;
    }

    if (!evaluated.canImport) {
      stats.failed++;
      continue;
    }

    // 3. Post to AnchorCare API as DRAFT
    try {
      console.log(`[Importing] Source ID ${id} -> ${evaluated.proposedHousehold}/${evaluated.proposedSubject}...`);
      await postEpisode(evaluated.payload);

      // 4. Mark checkpoint only after confirmed API success
      importedSet.add(id);
      checkpoint.imported_record_ids = Array.from(importedSet);
      checkpoint.last_run_timestamp = new Date().toISOString();
      saveCheckpoint(checkpoint);

      stats.imported++;
      console.log(`✓ Confirmed imported as draft: ${id}`);
    } catch (err) {
      stats.failed++;
      console.error(`✗ Failed to import ${id}:`, err.error || err);
      if (err.status === 401 || err.status === 403) {
        console.error("Critical: Ingestion endpoint authentication failed. Aborting remaining sync.");
        break;
      }
    }
  }

  console.log("\n===============================================================================");
  console.log("SYNC SUMMARY:");
  console.log(`  Successfully Imported:  ${stats.imported}`);
  console.log(`  Already Imported:       ${stats.already_imported} (Skipped for idempotency)`);
  console.log(`  Needs Human Review:     ${stats.needs_review} (Missing/ambiguous event time)`);
  console.log(`  Unmapped Rejected:      ${stats.unmapped}`);
  console.log(`  Failed:                 ${stats.failed}`);
  console.log("===============================================================================\n");
}

sync().catch((err) => {
  console.error("Fatal sync error:", err);
  process.exit(1);
});
