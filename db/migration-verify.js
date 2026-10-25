// Proves a migration moved everything, by comparing SOURCE and TARGET directly.
//
//   SOURCE_URI='mongodb+srv://…/' MONGODB_URI='mongodb+srv://…/' node db/migration-verify.js
//   … --deep        also hash every document, not just the _id set
//   … --json        machine-readable
//   … --db engram   override the database name on both sides
//
// Read-only against both clusters. Writes nothing, anywhere.
//
// Checks, per collection:
//   1. presence on both sides
//   2. exact document count (countDocuments, not the estimate)
//   3. _id set checksum  — catches missing, extra or renamed documents
//   4. index parity by key pattern — catches indexes mongorestore skipped
//   5. validator presence — catches collection options that did not carry over
//   6. with --deep, a canonical hash of every document — catches silent field loss
//
// Exits non-zero if ANY collection fails. "No output is good output" does not
// apply here: read the PASS lines and confirm the counts look like your data.

import "../engram-retrieval/src/env.js";
import { createHash } from "node:crypto";

const DEEP = process.argv.includes("--deep");
const AS_JSON = process.argv.includes("--json");
const dbArg = process.argv.indexOf("--db");
const DB_NAME = dbArg > -1 ? process.argv[dbArg + 1] : (process.env.MONGODB_DATABASE || "engram");

// Two naming conventions are accepted. MONGODB_URI_OLD / MONGODB_URI_NEW are the
// explicit pair and win when both are set; SOURCE_URI + MONGODB_URI is the fallback,
// so the same shell that runs provision.js (which only knows MONGODB_URI) also runs
// this without re-exporting anything.
const sourceUri = process.env.MONGODB_URI_OLD || process.env.SOURCE_URI;
const targetUri = process.env.MONGODB_URI_NEW || process.env.MONGODB_URI;
if (!sourceUri || !targetUri) {
  console.error("Set the two cluster URIs. Either pair works:");
  console.error("  MONGODB_URI_OLD  + MONGODB_URI_NEW   (explicit)");
  console.error("  SOURCE_URI       + MONGODB_URI       (matches the other db/ scripts)");
  console.error("Both are read-only here, but use a read-only user on the old cluster if you have one.");
  process.exit(2);
}
if (sourceUri === targetUri) {
  console.error("Both URIs point at the same cluster. Nothing would be compared.");
  process.exit(2);
}

const { MongoClient } = await import("mongodb").catch(() => {
  console.error("The 'mongodb' driver is not installed. Run 'npm install' in the repo root.");
  process.exit(2);
});

const say = (...a) => { if (!AS_JSON) console.log(...a); };

/** Recursively sorts object keys so two clusters serialize the same document identically. */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    if (value._bsontype) return value.toString();            // ObjectId, Decimal128, Binary…
    if (value instanceof Date) return `Date(${value.toISOString()})`;
    return Object.keys(value).sort().reduce((out, key) => {
      out[key] = canonical(value[key]);
      return out;
    }, {});
  }
  return value;
}

const hashOf = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Order-independent checksum: XOR of per-document hashes, so cursor order cannot matter. */
function xorAccumulate(accumulator, hex) {
  const next = Buffer.from(hex, "hex");
  for (let i = 0; i < accumulator.length; i++) accumulator[i] ^= next[i];
  return accumulator;
}

async function fingerprint(db, name, deep) {
  const collection = db.collection(name);
  const count = await collection.countDocuments();
  let accumulator = Buffer.alloc(32);
  const projection = deep ? {} : { _id: 1 };
  const cursor = collection.find({}, { projection }).batchSize(500);
  for await (const doc of cursor) {
    accumulator = xorAccumulate(accumulator, hashOf(canonical(deep ? doc : doc._id)));
  }
  return { count, checksum: accumulator.toString("hex") };
}

async function inventory(client, label) {
  const db = client.db(DB_NAME);
  const infos = await db.listCollections({}, { nameOnly: false }).toArray();
  const result = new Map();
  for (const info of infos) {
    if (info.name.startsWith("system.")) continue;
    if (info.type === "view") { result.set(info.name, { view: true }); continue; }
    let indexes = [];
    try { indexes = await db.collection(info.name).indexes(); } catch { /* ignore */ }
    result.set(info.name, {
      view: false,
      timeseries: !!info.options?.timeseries,
      validator: !!info.options?.validator,
      indexKeys: new Set(indexes.map(i => JSON.stringify(i.key))),
      indexCount: indexes.length
    });
  }
  say(`   ${label}: ${result.size} namespace(s) in "${DB_NAME}"`);
  return { db, result };
}

const results = [];
const problems = [];
const sourceClient = new MongoClient(sourceUri, { serverSelectionTimeoutMS: 20000, readPreference: "secondaryPreferred" });
const targetClient = new MongoClient(targetUri, { serverSelectionTimeoutMS: 20000 });

try {
  await Promise.all([sourceClient.connect(), targetClient.connect()]);
  const [sv, tv] = await Promise.all([
    sourceClient.db().admin().command({ buildInfo: 1 }),
    targetClient.db().admin().command({ buildInfo: 1 })
  ]);
  say(`source MongoDB ${sv.version}  →  target MongoDB ${tv.version}   database "${DB_NAME}"`);
  if (sv.version.split(".")[0] > tv.version.split(".")[0]) {
    problems.push({ collection: "-", code: "version_downgrade",
      detail: `Source is ${sv.version} and target is ${tv.version}. Restoring newer BSON into an older server can fail on unsupported types.` });
  }
  say(DEEP ? "mode: DEEP (every document hashed)\n" : "mode: standard (_id sets hashed; add --deep for full documents)\n");

  say("── inventory");
  const source = await inventory(sourceClient, "source");
  const target = await inventory(targetClient, "target");
  say("");

  // ── collections present on source ───────────────────────────────────────
  say("── per-collection comparison");
  const width = Math.max(...[...source.result.keys()].map(n => n.length), 14);

  for (const [name, sourceInfo] of [...source.result].sort()) {
    if (sourceInfo.view) continue;                       // views are recreated, not migrated
    const targetInfo = target.result.get(name);

    if (!targetInfo) {
      problems.push({ collection: name, code: "missing_on_target",
        detail: "Collection exists on source but not on target. Data loss." });
      say(`   FAIL ${name.padEnd(width)}  absent on target`);
      results.push({ collection: name, status: "FAIL", reason: "absent on target" });
      continue;
    }

    const [a, b] = await Promise.all([
      fingerprint(source.db, name, DEEP),
      fingerprint(target.db, name, DEEP)
    ]);

    const issues = [];
    if (a.count !== b.count) issues.push(`count ${a.count} → ${b.count}`);
    if (a.checksum !== b.checksum) issues.push(DEEP ? "document checksum differs" : "_id set differs");

    // index parity: every source index key pattern should exist on target.
    // Extra target indexes are expected — db/provision.js adds them deliberately.
    const missingIndexes = [...(sourceInfo.indexKeys ?? [])].filter(k => !targetInfo.indexKeys?.has(k));
    if (missingIndexes.length) issues.push(`${missingIndexes.length} source index(es) not on target`);

    if (sourceInfo.validator && !targetInfo.validator) issues.push("validator not carried over");

    if (issues.length) {
      problems.push({ collection: name, code: "mismatch", detail: issues.join("; "),
                      missingIndexes: missingIndexes.map(k => JSON.parse(k)) });
      say(`   FAIL ${name.padEnd(width)}  ${issues.join("; ")}`);
      results.push({ collection: name, status: "FAIL", source: a, target: b, issues });
    } else {
      say(`   ok   ${name.padEnd(width)}  ${String(a.count).padStart(8)} docs  idx ${sourceInfo.indexCount}→${targetInfo.indexCount}`);
      results.push({ collection: name, status: "PASS", source: a, target: b });
    }
  }

  // ── collections only on target (expected: the new schema) ───────────────
  const newOnTarget = [...target.result.keys()].filter(n => !source.result.has(n));
  if (newOnTarget.length) {
    say(`\n── new on target (expected after db/provision.js): ${newOnTarget.length}`);
    say(`   ${newOnTarget.sort().join(", ")}`);
  }

  // ── report ──────────────────────────────────────────────────────────────
  if (AS_JSON) {
    console.log(JSON.stringify({ database: DB_NAME, deep: DEEP, results, problems, newOnTarget }, null, 2));
  } else {
    say("\n─────────────────────────────────────────────");
    const passed = results.filter(r => r.status === "PASS").length;
    const docs = results.reduce((n, r) => n + (r.target?.count ?? 0), 0);
    if (!problems.length) {
      say(`PASS — ${passed} collection(s), ${docs} document(s) verified identical on both clusters.`);
      say(DEEP
        ? "Every document was hashed. This is as strong a guarantee as you can get without a byte-for-byte dump comparison."
        : "Counts and _id sets match. Re-run with --deep before you decommission the old cluster.");
    } else {
      say(`FAIL — ${problems.length} problem(s):\n`);
      for (const p of problems) {
        say(`   • ${p.collection}: ${p.detail}`);
        if (p.missingIndexes?.length) {
          for (const key of p.missingIndexes) say(`       missing index: ${JSON.stringify(key)}`);
        }
      }
      say(`
Do NOT switch the application over until these are resolved.
  missing_on_target  → re-run mongorestore for that namespace
  count mismatch     → check the mongorestore log for duplicate-key or validator errors
  _id set differs    → a partial restore; restore that namespace again into an empty target
  index missing      → npm run schema:provision, then re-run this check`);
    }
  }
  process.exitCode = problems.length ? 1 : 0;
} catch (error) {
  console.error(`Verification failed to run: ${error.message}`);
  process.exitCode = 2;
} finally {
  await Promise.allSettled([sourceClient.close(), targetClient.close()]);
}
