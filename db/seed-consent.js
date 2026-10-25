// Creates a consent_records document for a subject.
//
//   node db/seed-consent.js --subject margaret --granted-by "Margaret Doyle" --kind subject
//   … --apply                       actually write it (default is a dry run)
//   … --no-proactive                companion may not initiate contact
//   … --no-rehearsal                memory practice not permitted
//   … --supersede                   replace the current record with a new version
//
// WHY THIS IS A SCRIPT AND NOT PART OF provision.js
//
// `provision.js` creates structure. A consent record is not structure: it is an
// assertion that a named person granted permission, on a date, in a stated capacity.
// Software must not manufacture that. So this script REFUSES to run without a named
// grantor and an explicit capacity, and it never invents a default.
//
// What provision.js and audit-live.js do instead is REPORT the absence, loudly,
// because a missing consent record is a silent product failure: procedures carrying a
// `consent_allows_proactive_contact` precondition refuse to run, so the companion
// never speaks first and looks broken rather than blocked.
//
// Spec: docs/ATLAS-MEMORY-SCHEMA.md §9.5 · docs/MIGRATION-RUNBOOK.md §13.3

import "../engram-retrieval/src/env.js";
import { createHash, randomUUID } from "node:crypto";

const argv = process.argv.slice(2);
const flag = name => argv.includes(`--${name}`);
const arg = (name, fallback = null) => {
  const index = argv.indexOf(`--${name}`);
  return index > -1 && argv[index + 1] && !argv[index + 1].startsWith("--")
    ? argv[index + 1] : fallback;
};

const APPLY = flag("apply");
const uri = process.env.MONGODB_URI_NEW || process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DATABASE || "engram";

const householdId = arg("household", process.env.HOUSEHOLD_ID || "demo-household");
const subjectId = arg("subject");
const grantedByName = arg("granted-by");
const grantedByKind = arg("kind");
const grantedByRole = arg("role", null);
const evidenceRef = arg("evidence-ref", null);
const recordedBy = arg("recorded-by", null);

const VALID_KINDS = ["subject", "attorney", "next_of_kin"];

const fail = message => { console.error(`\n${message}\n`); process.exit(2); };

if (!uri) fail("Set MONGODB_URI (or MONGODB_URI_NEW) to the target cluster.");
if (!subjectId) fail("--subject is required, e.g. --subject margaret");

// The two refusals that matter. Neither has a default, deliberately.
if (!grantedByName) {
  fail([
    "--granted-by is required: the name of the person who actually gave consent.",
    "",
    "This script will not invent one. A consent record asserts that a named person",
    "granted permission; a record with a placeholder name is worse than no record,",
    "because the absence is detected and reported while a fabricated name is not.",
    "",
    'Example: --granted-by "Margaret Doyle" --kind subject'
  ].join("\n"));
}
if (!VALID_KINDS.includes(grantedByKind)) {
  fail([
    `--kind must be one of: ${VALID_KINDS.join(", ")}`,
    "",
    "  subject      the person themselves consented",
    "  attorney     someone holding lasting power of attorney consented",
    "  next_of_kin  a family member consented on their behalf",
    "",
    "Capacity fluctuates in dementia, so who consented and in what capacity is part",
    "of the record, not metadata. Pick the one that is actually true."
  ].join("\n"));
}

const { MongoClient } = await import("mongodb").catch(() => {
  console.error("The 'mongodb' driver is not installed. Run 'npm install' in the repo root.");
  process.exit(2);
});

const sha256 = (...parts) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
const scope = { householdId, subjectId };
const now = new Date();

const record = {
  _id: `consent_${now.toISOString().slice(0, 10).replace(/-/g, "_")}_${randomUUID().slice(0, 8)}`,
  ...scope,
  version: 1,                                   // bumped below if superseding
  grantedBy: {
    kind: grantedByKind,
    name: grantedByName,
    role: grantedByRole,
    evidenceRef                                  // a pointer to the signed form, if any
  },
  scopeOfConsent: {
    collections: ["episodes", "semantic_nodes", "identity_core", "daily_logs",
                  "medication_responses", "conversation_turns"],
    purposes: ["memory_support", "medication_reminders", "caregiver_reporting"],
    recipients: []                               // fill in named recipients in the console
  },
  proactiveContactAllowed: !flag("no-proactive"),
  rehearsalAllowed: !flag("no-rehearsal"),
  dataRetention: {
    episodesDays: Number(arg("retain-episodes", 1825)),
    mediaDays: Number(arg("retain-media", 1825)),
    tsDays: Number(arg("retain-ts", 365)),
    auditDays: Number(arg("retain-audit", 2555))
  },
  withdrawnAt: null,
  withdrawnBy: null,
  supersededBy: null,
  recordedAt: now
};
record.digest = sha256(record.grantedBy, record.scopeOfConsent,
                       record.proactiveContactAllowed, record.rehearsalAllowed,
                       record.dataRetention, now.toISOString());

const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });

try {
  await client.connect();
  const db = client.db(dbName);

  const existing = await db.collection("consent_records")
    .find({ ...scope, withdrawnAt: null, supersededBy: null })
    .sort({ version: -1 }).toArray();

  if (existing.length && !flag("supersede")) {
    console.error(`\n${subjectId} already has a current consent record (${existing[0]._id}, v${existing[0].version}).`);
    console.error("consent_records is write-once. To replace it, re-run with --supersede,");
    console.error("which creates a new version and points the old one at it.\n");
    process.exit(1);
  }
  if (existing.length) record.version = (existing[0].version ?? 0) + 1;

  console.log(`\n${APPLY ? "WRITING" : "DRY RUN"} — consent record for ${subjectId}\n`);
  console.log(JSON.stringify(record, null, 2));
  console.log([
    "",
    "Check before applying:",
    `  grantor      ${record.grantedBy.name} (${record.grantedBy.kind}${grantedByRole ? ", " + grantedByRole : ""})`,
    `  proactive    ${record.proactiveContactAllowed ? "ALLOWED — the companion may initiate contact" : "not allowed"}`,
    `  rehearsal    ${record.rehearsalAllowed ? "ALLOWED — memory practice may be offered" : "not allowed"}`,
    `  recipients   ${record.scopeOfConsent.recipients.length || "none set — add them in the caregiver console"}`,
    ""
  ].join("\n"));

  if (!APPLY) {
    console.log("Nothing was written. Re-run with --apply once the above is correct.\n");
    process.exit(0);
  }

  const session = client.startSession();
  try {
    await session.withTransaction(async () => {
      await db.collection("consent_records").insertOne(record, { session });

      if (existing.length) {
        await db.collection("consent_records").updateOne(
          { _id: existing[0]._id, ...scope },
          { $set: { supersededBy: record._id } },
          { session });
      }

      // Chained audit event, matching db/ingest.js chainedAudit().
      const counterId = sha256("audit_counter", scope);
      const counter = await db.collection("audit_counters").findOneAndUpdate(
        { _id: counterId },
        { $inc: { seq: 1 }, $setOnInsert: { ...scope } },
        { upsert: true, returnDocument: "after", includeResultMetadata: false, session });
      const previous = counter.seq > 1
        ? await db.collection("audit_events").findOne(
            { ...scope, seq: counter.seq - 1 }, { projection: { digest: 1 }, session })
        : null;
      const prevDigest = previous?.digest ?? "GENESIS";

      const detail = {
        consentId: record._id,
        version: record.version,
        grantedByKind: record.grantedBy.kind,
        proactiveContactAllowed: record.proactiveContactAllowed,
        rehearsalAllowed: record.rehearsalAllowed,
        supersedes: existing.length ? existing[0]._id : null
      };
      const event = {
        _id: `audit_${randomUUID()}`, ...scope,
        action: "consent_recorded", recordId: record._id, detail, at: now,
        actor: { kind: "caregiver", id: recordedBy ?? "cli", credentialRef: "seed-consent.js" },
        actorRole: "primary_caregiver",
        seq: counter.seq, prevDigest, riskTier: 2
      };
      event.digest = sha256(prevDigest, counter.seq, householdId, subjectId,
                            "consent_recorded", record._id, detail, now.toISOString());
      await db.collection("audit_events").insertOne(event, { session });
    }, { writeConcern: { w: "majority", j: true } });
  } finally {
    await session.endSession();
  }

  console.log(`Written: ${record._id} (v${record.version})`);
  if (!recordedBy) {
    console.log("\nNote: --recorded-by was not given, so the audit event records the actor as 'cli'.");
    console.log("Pass --recorded-by <your id> so the audit trail names a person.");
  }
  console.log("\nNext: npm run schema:audit-live   (consent coverage should now pass)\n");
} catch (error) {
  console.error(`\nFailed: ${error.message}`);
  if (error.code === 121) {
    console.error("Document failed validation — check db/collections.js consent_records validator.");
  }
  process.exitCode = 1;
} finally {
  await client.close();
}
