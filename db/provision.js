// Idempotent provisioner for the Anchorcare cognitive memory schema.
//
//   node db/provision.js --dry-run     print the plan, touch nothing
//   node db/provision.js               create collections, validators, indexes, search indexes
//
// Properties this script guarantees:
//   * It never drops a collection, index or search index.
//   * It never edits an existing Atlas Search / Vector Search definition. A model,
//     mode or mapping change requires a NEW index name (see docs/NATIVE-ATLAS.md).
//   * It applies validators with collMod only when the collection has none, so an
//     existing collection serving live traffic cannot start rejecting current writes.
//   * It FAILS if a TTL index exists on a collection listed in NO_TTL.
//
// Search index builds are asynchronous. A successful run means "requested", not
// "queryable". Check status in Atlas before relying on retrieval.

import "../engram-retrieval/src/env.js";
import collections, { NO_TTL, WRITE_ONCE, APPEND_ONLY, views } from "./collections.js";

const DRY = process.argv.includes("--dry-run");
const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DATABASE || "engram";

if (!uri) {
  console.error("MONGODB_URI is required. Set STORE=mongodb and your Atlas connection string.");
  process.exit(2);
}

const log = [];
const warn = [];
const fail = [];
const note = (bucket, message) => { bucket.push(message); console.log(message); };

/** Loaded after the config check so a missing driver reports itself, not a stack trace.
 *  Mirrors the dynamic import in engram-retrieval/src/store.js. */
const { MongoClient } = await import("mongodb").catch(() => {
  console.error("The 'mongodb' driver is not installed. Run 'npm install' in the repo root.");
  process.exit(2);
});

const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });

try {
  await client.connect();
  const db = client.db(dbName);
  const build = await db.admin().command({ buildInfo: 1 });
  console.log(`Connected to ${dbName} on MongoDB ${build.version}${DRY ? "  [DRY RUN]" : ""}\n`);

  const existingNames = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map(c => c.name));

  for (const spec of collections) {
    const { name, kind = "regular", timeseries, expireAfterSeconds, validator, indexes = [], searchIndexes = [] } = spec;
    console.log(`── ${name}${spec.existing ? "  (existing)" : ""}${kind === "timeseries" ? "  [time-series]" : ""}`);

    // ---------- collection ----------
    if (!existingNames.has(name)) {
      const options = kind === "timeseries"
        ? { timeseries, ...(expireAfterSeconds ? { expireAfterSeconds } : {}) }
        : { ...(validator ? { validator, validationLevel: "strict", validationAction: "error" } : {}) };
      if (DRY) note(log, `   + create collection ${JSON.stringify(options)}`);
      else { await db.createCollection(name, options); note(log, "   + created"); }
    } else if (validator && kind !== "timeseries") {
      // Only install a validator where none exists; never tighten one underneath live writes.
      const [info] = await db.listCollections({ name }).toArray();
      if (info?.options?.validator) {
        note(warn, "   ! validator already present; left unchanged (review manually before tightening)");
      } else if (DRY) {
        note(log, "   + collMod: add $jsonSchema validator");
      } else {
        await db.command({ collMod: name, validator, validationLevel: "strict", validationAction: "error" });
        note(log, "   + validator applied");
      }
    }

    // ---------- regular indexes ----------
    const haveIndexes = existingNames.has(name)
      ? await db.collection(name).indexes().catch(() => [])
      : [];
    const sameKeys = (a, b) => JSON.stringify(a) === JSON.stringify(b);

    for (const { keys, options = {} } of indexes) {
      const match = haveIndexes.find(i => sameKeys(i.key, keys) || (options.name && i.name === options.name));
      if (match) { console.log(`   = index ${match.name}`); continue; }
      if (DRY) { note(log, `   + index ${options.name || JSON.stringify(keys)} ${JSON.stringify(options)}`); continue; }
      try {
        const created = await db.collection(name).createIndex(keys, options);
        note(log, `   + index ${created}`);
      } catch (error) {
        // A conflicting definition under the same name is a real problem, not a no-op.
        note(fail, `   ✗ index ${options.name || JSON.stringify(keys)}: ${error.message}`);
      }
    }

    // ---------- search / vector indexes ----------
    if (searchIndexes.length) {
      let have = [];
      try { have = await db.collection(name).listSearchIndexes().toArray(); }
      catch (error) { note(warn, `   ! cannot list search indexes (${error.message}); skipping`); have = null; }

      if (have) {
        for (const def of searchIndexes) {
          if (have.some(i => i.name === def.name)) {
            const live = have.find(i => i.name === def.name);
            console.log(`   = search index ${def.name} (${live.status || "unknown"}) — definition left unchanged`);
            continue;
          }
          if (DRY) { note(log, `   + search index ${def.name} (${def.type})`); continue; }
          try {
            await db.collection(name).createSearchIndex(def);
            note(log, `   + search index ${def.name} requested (${def.type}) — build is asynchronous`);
          } catch (error) {
            note(fail, `   ✗ search index ${def.name}: ${error.message}`);
          }
        }
      }
    }
    console.log("");
  }

  // ---------- read-only views (row-level read control) ----------
  console.log("── views");
  for (const view of views) {
    if (existingNames.has(view.name)) {
      const [info] = await db.listCollections({ name: view.name }).toArray();
      if (info?.type !== "view") {
        note(fail, `   ✗ ${view.name} exists and is not a view — refusing to touch it`);
      } else if (JSON.stringify(info.options?.pipeline) !== JSON.stringify(view.pipeline)) {
        note(warn, `   ! ${view.name} pipeline differs from the registry; left unchanged (review it)`);
      } else {
        console.log(`   = ${view.name} on ${view.viewOn}`);
      }
      continue;
    }
    if (!existingNames.has(view.viewOn)) {
      note(warn, `   ! ${view.name} skipped: source collection ${view.viewOn} does not exist yet`);
      continue;
    }
    if (DRY) { note(log, `   + view ${view.name} on ${view.viewOn}`); continue; }
    try {
      await db.createCollection(view.name, { viewOn: view.viewOn, pipeline: view.pipeline });
      note(log, `   + view ${view.name} on ${view.viewOn}`);
    } catch (error) {
      note(fail, `   ✗ view ${view.name}: ${error.message}`);
    }
  }
  console.log("");

  // ---------- TTL assertion (invariant I6) ----------
  // Swept over the whole NO_TTL list, not just the registry, so collections
  // provisioned by engram-retrieval/scripts/indexes.js are covered too.
  console.log("── no-TTL sweep");
  for (const name of NO_TTL) {
    if (!existingNames.has(name)) continue;
    const indexes = await db.collection(name).indexes().catch(() => []);
    const ttl = indexes.filter(i => i.expireAfterSeconds !== undefined);
    if (ttl.length) {
      note(fail, `   ✗ ${name} has a TTL index (${ttl.map(i => i.name).join(", ")}) — safety and memory data must not expire`);
    }
    const [info] = await db.listCollections({ name }).toArray();
    if (info?.options?.expireAfterSeconds) {
      note(fail, `   ✗ ${name} is a time-series collection with expireAfterSeconds set, but is listed NO_TTL`);
    }
  }
  if (!fail.length) console.log("   = no TTL on any protected collection\n");
  else console.log("");

  // ---------- GridFS bucket for media ----------
  if (!existingNames.has("engram_images.files")) {
    note(warn, "! GridFS bucket 'engram_images' not present yet; it is created on first image upload (image-memory.ts).");
  }

  // ---------- consent coverage ----------
  // Structure is provisioned; consent is not. This script will not create a consent
  // record — that would mean software asserting a named person granted permission.
  // It reports the gap instead, because the gap is a silent product failure: a
  // subject with no consent record gets a companion that never speaks first.
  if (!DRY) {
    try {
      const subjects = new Set(await db.collection("identity_core").distinct("_id", {}));
      for (const value of await db.collection("episodes").distinct("subjectId", {})) {
        if (typeof value === "string") subjects.add(value);
      }
      const uncovered = [];
      for (const subjectId of subjects) {
        const current = await db.collection("consent_records")
          .countDocuments({ subjectId, withdrawnAt: null, supersededBy: null });
        if (!current) uncovered.push(subjectId);
      }
      if (uncovered.length) {
        note(warn, `! ${uncovered.length} subject(s) have no current consent record: ${uncovered.join(", ")}`);
        note(warn, "  Procedures gated on consent_allows_proactive_contact will refuse to run.");
        note(warn, `  Fix: node db/seed-consent.js --subject ${uncovered[0]} --granted-by "<name>" --kind subject --apply`);
      }
    } catch {
      // consent_records or identity_core may not exist yet on a first run; not a finding.
    }
  }

  console.log("\n─────────────────────────────────────────────");
  console.log(`${DRY ? "Planned" : "Applied"}: ${log.length} change(s)`);
  if (warn.length) console.log(`Warnings: ${warn.length}`);
  if (fail.length) {
    console.log(`Failures: ${fail.length}`);
    console.log("\nFailures are actionable, not cosmetic. Resolve them before relying on this schema.");
  }
  console.log(`
Write-once collections (grant the app credential find+insert only, no update/remove):
  ${WRITE_ONCE.join(", ")}

Append-only collections (inserts + only the listed fields updatable):
  ${Object.keys(APPEND_ONLY).join(", ")}

Role grants this script cannot make for you (Atlas custom roles — see §14.2, §18.4):
  * anchorcare_companion: NO find on conversation_turns (it reads patient_utterances),
    insert-only on inferences. That is what stops the companion citing its own output.
  * anchorcare_caregiver: find on conversation_turns, inferences, inference_review_queue.

Reminders:
  * Search index builds are asynchronous. Confirm READY/queryable in Atlas.
  * Index configuration is not proof of execution. Claim only features a live query reported.
  * Online Archive does not support $search or $vectorSearch: archived turns and
    episodes leave the recall horizon. Surface that boundary, don't hide it.
  * Run db/verify-audit.js and db/reconcile.js after any backfill.`);

  process.exitCode = fail.length ? 1 : 0;
} catch (error) {
  console.error(`\nProvisioning failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await client.close();
}
