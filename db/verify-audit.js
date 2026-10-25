// Walks the audit hash chain per scope and reports the first break.
//
//   node db/verify-audit.js
//   node db/verify-audit.js --household demo-household --subject margaret
//
// Spec: docs/ATLAS-MEMORY-SCHEMA.md §14.3
//
// What a clean run proves: no audit event in the chain has been deleted, reordered,
// back-dated or edited since it was written.
// What it does NOT prove: that nobody with project-owner rights rewrote the entire
// chain. That requires the off-cluster digest checkpoints described in §14.3.
// This is tamper-EVIDENT, not tamper-proof. Do not describe it otherwise.

import { createHash } from "node:crypto";

const GENESIS = "GENESIS";
const sha256 = (...parts) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");

const arg = name => {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 ? process.argv[index + 1] : null;
};

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DATABASE || "engram";
if (!uri) { console.error("MONGODB_URI is required."); process.exit(2); }

/** Must match ingest.js chainedAudit() exactly, or every event looks forged. */
function expectedDigest(event) {
  return sha256(
    event.prevDigest, event.seq,
    event.householdId, event.subjectId,
    event.action, event.recordId,
    event.detail ?? {},
    event.at.toISOString()
  );
}

/** Loaded after the config check so a missing driver reports itself, not a stack trace.
 *  Mirrors the dynamic import in engram-retrieval/src/store.js. */
const { MongoClient } = await import("mongodb").catch(() => {
  console.error("The 'mongodb' driver is not installed. Run 'npm install' in the repo root.");
  process.exit(2);
});

const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
let problems = 0;

try {
  await client.connect();
  const db = client.db(dbName);
  const events = db.collection("audit_events");

  const scopes = await events.aggregate([
    { $group: { _id: { householdId: "$householdId", subjectId: "$subjectId" } } },
    { $sort: { "_id.householdId": 1, "_id.subjectId": 1 } }
  ]).toArray();

  const only = { householdId: arg("household"), subjectId: arg("subject") };
  const selected = scopes
    .map(s => s._id)
    .filter(s => (!only.householdId || s.householdId === only.householdId)
              && (!only.subjectId || s.subjectId === only.subjectId));

  if (!selected.length) { console.log("No audit events found for the requested scope."); process.exit(0); }

  for (const scope of selected) {
    const label = `${scope.householdId}/${scope.subjectId}`;
    const preChain = await events.countDocuments({ ...scope, seq: { $exists: false } });
    const total = await events.countDocuments({ ...scope, seq: { $exists: true } });

    if (!total) {
      console.log(`── ${label}: ${preChain} event(s), none chained (pre-chain history — §16.1 step 10)`);
      continue;
    }

    const cursor = events.find({ ...scope, seq: { $exists: true } }).sort({ seq: 1 });
    let expectedSeq = null;
    let prevDigest = GENESIS;
    let checked = 0;
    let broke = false;

    for await (const event of cursor) {
      if (expectedSeq === null) {
        expectedSeq = event.seq;
        if (event.seq !== 1) {
          console.log(`   ! ${label}: chain starts at seq ${event.seq}, not 1 (expected after a migration cut-over)`);
        }
        prevDigest = event.prevDigest ?? GENESIS;
      }

      if (event.seq !== expectedSeq) {
        console.log(`   ✗ ${label}: gap at seq ${expectedSeq} (next stored seq is ${event.seq}) — an event is missing`);
        problems++; broke = true; break;
      }
      if ((event.prevDigest ?? GENESIS) !== prevDigest) {
        console.log(`   ✗ ${label}: seq ${event.seq} prevDigest does not match seq ${event.seq - 1}`);
        problems++; broke = true; break;
      }
      const erased = event.detail?.erased === true;
      const recomputed = expectedDigest(event);
      if (recomputed !== event.digest && !erased) {
        console.log(`   ✗ ${label}: seq ${event.seq} (${event.action} on ${event.recordId}) digest mismatch — content changed after writing`);
        problems++; broke = true; break;
      }
      if (erased && !event.priorDigest) {
        console.log(`   ✗ ${label}: seq ${event.seq} is an erasure tombstone without priorDigest — §9.6 requires it`);
        problems++; broke = true; break;
      }
      if (!event.actor) {
        console.log(`   ! ${label}: seq ${event.seq} has no actor — an event without a subject is not audit`);
      }

      prevDigest = event.digest;
      expectedSeq = event.seq + 1;
      checked++;
    }

    const counter = await db.collection("audit_counters").findOne({ ...scope });
    const counterNote = counter
      ? (counter.seq === expectedSeq - 1 ? "counter in step" : `counter at ${counter.seq}, chain ends at ${expectedSeq - 1}`)
      : "no counter document";

    if (!broke) {
      console.log(`── ${label}: ${checked} chained event(s) verified${preChain ? `, ${preChain} pre-chain` : ""} · ${counterNote}`);
    }
  }

  console.log("\n─────────────────────────────────────────────");
  if (problems) {
    console.log(`${problems} chain break(s). Treat this as a security finding, not a data-quality nit.`);
    console.log("Next: compare against the off-cluster digest checkpoints before concluding anything.");
  } else {
    console.log("No chain breaks found. This is tamper-evidence, not tamper-proofing (§14.3).");
  }
  process.exitCode = problems ? 1 : 0;
} catch (error) {
  console.error(`Verification failed to run: ${error.message}`);
  process.exitCode = 2;
} finally {
  await client.close();
}
