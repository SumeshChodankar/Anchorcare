// Read-only audit of a live Atlas cluster against the schema registry.
//
//   node db/audit-live.js
//   node db/audit-live.js --all-dbs      also inspect databases other than the configured one
//   node db/audit-live.js --json         machine-readable output
//
// Performs NO writes of any kind — no createIndex, no createCollection, no updates.
// It answers the questions a screenshot cannot:
//
//   * Which collections exist that nothing in this repo indexes?
//   * Which have only the default _id index while the app queries them by other fields?
//   * Is there a TTL index on a collection that must never expire?
//   * Are there stray databases holding data?
//   * Do documents actually carry householdId + subjectId?
//   * Which search indexes exist, and are they queryable?
//
// Findings are ranked P0 (safety) → P3 (hygiene). Fix P0 before a demo.

import "../engram-retrieval/src/env.js";
import collections, { NO_TTL, views } from "./collections.js";

const ALL_DBS = process.argv.includes("--all-dbs");
const AS_JSON = process.argv.includes("--json");
const AUDIT_OLD = process.argv.includes("--old");

// `--old` audits the source cluster (a Phase A checklist step) without re-exporting
// anything; otherwise the target. MONGODB_URI_NEW wins over MONGODB_URI when set.
const uri = AUDIT_OLD
  ? (process.env.MONGODB_URI_OLD || process.env.SOURCE_URI)
  : (process.env.MONGODB_URI_NEW || process.env.MONGODB_URI);
const dbName = process.env.MONGODB_DATABASE || "engram";
if (!uri) {
  console.error(AUDIT_OLD
    ? "--old needs MONGODB_URI_OLD (or SOURCE_URI) set to the old cluster."
    : "Set MONGODB_URI (or MONGODB_URI_NEW) to the cluster you want audited.");
  process.exit(2);
}

const { MongoClient } = await import("mongodb").catch(() => {
  console.error("The 'mongodb' driver is not installed. Run 'npm install' in the repo root.");
  process.exit(2);
});

const findings = [];
const add = (priority, code, message, detail = null) =>
  findings.push({ priority, code, message, detail });

const say = (...args) => { if (!AS_JSON) console.log(...args); };

/** Collections this repo's code writes to. Keep in step with a grep over integration/ + engram-retrieval/src. */
const KNOWN_APP_COLLECTIONS = new Set([
  ...collections.map(c => c.name),
  // provisioned by engram-retrieval/scripts/indexes.js, no spec in this registry
  "people", "prompt_jobs", "prompts", "rehearsal_sets", "practice_slots",
  "devices", "device_observations", "assistance_requests",
  // GridFS bucket for approved images
  "engram_images.files", "engram_images.chunks",
  // views
  ...views.map(v => v.name)
]);

const specByName = new Map(collections.map(c => [c.name, c]));
const keyString = keys => JSON.stringify(keys);

const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });

try {
  await client.connect();
  const admin = client.db().admin();
  const build = await admin.command({ buildInfo: 1 });
  say(`MongoDB ${build.version}  ·  database: ${dbName}  ·  auditing the ${AUDIT_OLD ? "OLD" : "target"} cluster\n`);

  // ───────────────────── 0. server version and FCV ──────────────────────────
  // A cluster can report 8.0 while its featureCompatibilityVersion still sits lower,
  // during or just after an Atlas version upgrade. $rankFusion is gated on FCV, not
  // on buildInfo, so hybrid retrieval fails on a cluster that *looks* fine.
  say("── version and feature compatibility");
  const major = Number(build.version.split(".")[0]);
  say(`   server: ${build.version}`);
  if (major < 8) {
    add("P0", "server_version_too_low",
      `MongoDB ${build.version}: $rankFusion requires 8.0 or later. Every hybrid recall falls back to ` +
      `application-side fusion, so the companion answers from a degraded path. Create the cluster at 8.0.`,
      { version: build.version });
  }
  let fcv = null;
  try {
    const parameter = await admin.command({ getParameter: 1, featureCompatibilityVersion: 1 });
    fcv = parameter.featureCompatibilityVersion?.version ?? null;
  } catch {
    // Restricted for non-admin credentials on Atlas; absence is not a finding.
  }
  if (fcv) {
    say(`   FCV:    ${fcv}`);
    if (Number(fcv.split(".")[0]) < major) {
      add("P0", "fcv_behind_version",
        `Server reports ${build.version} but featureCompatibilityVersion is ${fcv}. 8.0-only behaviour ` +
        `(notably $rankFusion) can be rejected even though the version looks right. Atlas completes the FCV ` +
        `bump after an upgrade settles — wait and re-check. Do not run setFeatureCompatibilityVersion: it is ` +
        `restricted on Atlas and managed for you.`,
        { version: build.version, fcv });
    }
  } else {
    say("   FCV:    not readable with this credential (normal on Atlas)");
  }
  say("");

  // ───────────────────── 1. stray databases ─────────────────────────────────
  say("── databases on this cluster");
  let dbList = { databases: [] };
  try {
    dbList = await admin.listDatabases();
  } catch (error) {
    add("P3", "list_databases_denied", `Cannot list databases (${error.message}). Run as a user with clusterMonitor to see stray databases.`);
  }
  const systemDbs = new Set(["admin", "local", "config"]);
  for (const entry of dbList.databases ?? []) {
    if (systemDbs.has(entry.name)) continue;
    const mb = (entry.sizeOnDisk / 1048576).toFixed(1);
    if (entry.name === dbName) { say(`   = ${entry.name}  ${mb} MB  (configured)`); continue; }
    say(`   ! ${entry.name}  ${mb} MB  (NOT the configured database)`);
    let names = [];
    try {
      names = (await client.db(entry.name).listCollections({}, { nameOnly: true }).toArray()).map(c => c.name);
    } catch { /* no access */ }
    add("P2", "stray_database",
      `Database "${entry.name}" holds data but nothing in this repo writes to it. ` +
      `createStore() always passes MONGODB_DATABASE, so this came from somewhere else: ` +
      `a teammate's service, a Compass/mongosh session, or a connection string with no database path.`,
      { database: entry.name, sizeMB: Number(mb), collections: names });
  }
  say("");

  // ───────────────────── 2. collection inventory ────────────────────────────
  const db = client.db(dbName);
  const live = await db.listCollections({}, { nameOnly: false }).toArray();
  const liveNames = new Set(live.map(c => c.name));
  const liveCollections = live.filter(c => c.type !== "view");
  const liveViews = live.filter(c => c.type === "view");

  say(`── ${dbName}: ${liveCollections.length} collections, ${liveViews.length} views\n`);

  const rows = [];
  for (const info of liveCollections) {
    const name = info.name;
    if (name.startsWith("system.")) continue;

    const collection = db.collection(name);
    let count = 0, indexes = [];
    try {
      count = await collection.estimatedDocumentCount();
      indexes = await collection.indexes();
    } catch (error) {
      add("P3", "inspect_failed", `Cannot inspect ${name}: ${error.message}`);
      continue;
    }

    const spec = specByName.get(name);
    const designed = (spec?.indexes ?? []).length;
    const actual = indexes.length;
    const ttlIndexes = indexes.filter(i => i.expireAfterSeconds !== undefined);
    const isGridFs = name.endsWith(".files") || name.endsWith(".chunks");

    rows.push({ name, count, actual, designed, ttl: ttlIndexes.length, known: KNOWN_APP_COLLECTIONS.has(name) });

    // --- P0: TTL on a collection that must never expire ---
    for (const index of ttlIndexes) {
      if (NO_TTL.includes(name)) {
        add("P0", "ttl_landmine",
          `${name} has a TTL index "${index.name}" (expireAfterSeconds=${index.expireAfterSeconds}). ` +
          `This collection is in NO_TTL: records here are safety or memory evidence and must not be deleted by a timer.`,
          { collection: name, index: index.name, expireAfterSeconds: index.expireAfterSeconds });
      }
    }

    // --- P0/P1: only the default _id index, but the app queries by other fields ---
    if (!isGridFs && actual <= 1 && count > 0) {
      const store = spec?.store ?? "unknown";
      const priority = store === "safety" ? "P0" : "P1";
      add(priority, "unindexed_collection",
        `${name} has ${count} document(s) and only the default _id index. ` +
        `Every query by any other field is a collection scan.` +
        (store === "safety" ? " This is a SAFETY collection." : ""),
        { collection: name, count, store, designedIndexes: designed });
    }

    // --- P1: designed indexes that are not present ---
    if (spec?.indexes?.length) {
      const have = indexes.map(i => keyString(i.key));
      const haveNames = new Set(indexes.map(i => i.name));
      const missing = spec.indexes.filter(d =>
        !have.includes(keyString(d.keys)) && !(d.options?.name && haveNames.has(d.options.name)));
      if (missing.length) {
        add(count > 0 ? "P1" : "P2", "missing_indexes",
          `${name}: ${missing.length} of ${designed} designed index(es) absent.`,
          { collection: name, count,
            missing: missing.map(m => m.options?.name ?? keyString(m.keys)) });
      }
    }

    // --- P2: live collection that no part of this repo indexes or specs ---
    if (!KNOWN_APP_COLLECTIONS.has(name) && !isGridFs) {
      add("P2", "unknown_collection",
        `${name} exists with ${count} document(s) but is not in the schema registry and is not provisioned by engram-retrieval/scripts/indexes.js.`,
        { collection: name, count });
    }

    // --- P1: scope coverage (invariant I1) ---
    if (!isGridFs && count > 0 && !["audit_counters", "tool_registry", "ts_dedupe",
                                    "mobile_pairings", "mobile_push", "mobile_push_attempts"].includes(name)) {
      try {
        const unscoped = await collection.countDocuments({
          $or: [{ householdId: { $exists: false } }, { subjectId: { $exists: false } }]
        }, { limit: 1, maxTimeMS: 5000 });
        if (unscoped > 0) {
          add("P1", "unscoped_documents",
            `${name} contains document(s) without householdId and/or subjectId. ` +
            `Every scoped query and index silently misses them.`,
            { collection: name });
        }
      } catch { /* timeout on a large unindexed collection is itself the finding above */ }
    }
  }

  // --- P1: specs with no live collection ---
  for (const spec of collections) {
    if (liveNames.has(spec.name)) continue;
    add(spec.existing ? "P1" : "P2", "collection_absent",
      `${spec.name} is ${spec.existing ? "written by existing code" : "defined in the registry"} but does not exist in ${dbName}.` +
      (spec.existing ? " Either it has never been written to, or the index script never ran." : " Run db/provision.js."),
      { collection: spec.name, existing: !!spec.existing });
  }

  // --- views ---
  for (const view of views) {
    if (!liveNames.has(view.name)) {
      add("P2", "view_absent", `View ${view.name} does not exist. It is what gives the companion credential row-level read control.`,
        { view: view.name, viewOn: view.viewOn });
    }
  }

  // ───────────────────── 2b. consent coverage ───────────────────────────────
  // A subject with no consent record is not a data problem — it is a silent product
  // failure. Procedures carrying a `consent_allows_proactive_contact` precondition
  // refuse to run, so the companion simply never speaks first and looks broken.
  if (liveNames.has("consent_records")) {
    say("── consent coverage");
    const subjects = new Set();
    for (const name of ["identity_core", "people", "episodes"]) {
      if (!liveNames.has(name)) continue;
      const field = name === "identity_core" ? "_id" : "subjectId";
      try {
        for (const value of await db.collection(name).distinct(field, {})) {
          if (typeof value === "string") subjects.add(value);
        }
      } catch { /* unindexed distinct on a large collection; skip */ }
    }
    if (!subjects.size) {
      say("   = no subjects found yet; nothing to check");
    } else {
      for (const subjectId of [...subjects].sort()) {
        const current = await db.collection("consent_records").countDocuments({
          subjectId, withdrawnAt: null, supersededBy: null
        });
        if (current) { say(`   = ${subjectId}: consent record present`); continue; }
        const any = await db.collection("consent_records").countDocuments({ subjectId });
        add("P1", "consent_missing",
          any
            ? `${subjectId} has ${any} consent record(s) but none current (all withdrawn or superseded). ` +
              `Proactive procedures will refuse to run.`
            : `${subjectId} has no consent record. Procedures with a consent_allows_proactive_contact ` +
              `precondition refuse to run, so the companion never speaks first and looks broken rather ` +
              `than blocked. Create one with: node db/seed-consent.js --subject ${subjectId} …`,
          { subjectId, recordsFound: any });
        say(`   ✗ ${subjectId}: no current consent record`);
      }
    }
    say("");
  }

  // ───────────────────── 3. search indexes ──────────────────────────────────
  say("── search / vector indexes");
  const expectedSearch = collections.flatMap(c =>
    (c.searchIndexes ?? []).map(s => ({ collection: c.name, name: s.name, type: s.type })));
  // the two index names the existing engram-retrieval code depends on
  expectedSearch.push(
    { collection: "episodes", name: process.env.SEARCH_INDEX || "episodes_text", type: "search" },
    { collection: "episodes", name: process.env.VECTOR_INDEX || "episodes_auto", type: "vectorSearch" });

  const seen = new Set();
  for (const expected of expectedSearch) {
    const key = `${expected.collection}:${expected.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!liveNames.has(expected.collection)) continue;
    let liveIndexes = [];
    try {
      liveIndexes = await db.collection(expected.collection).listSearchIndexes().toArray();
    } catch (error) {
      add("P2", "search_index_unreadable",
        `Cannot list search indexes on ${expected.collection} (${error.message}). Atlas Search may not be enabled on this cluster.`);
      continue;
    }
    const found = liveIndexes.find(i => i.name === expected.name);
    if (!found) {
      add("P1", "search_index_absent",
        `${expected.collection}: search index "${expected.name}" (${expected.type}) does not exist. Retrieval using it will fail or silently return nothing.`,
        expected);
      say(`   ✗ ${expected.collection}.${expected.name} — absent`);
    } else {
      const status = found.status ?? "unknown";
      const queryable = found.queryable === true || status === "READY";
      say(`   ${queryable ? "=" : "!"} ${expected.collection}.${expected.name} — ${status}${queryable ? "" : " (NOT queryable)"}`);
      if (!queryable) {
        add("P1", "search_index_not_queryable",
          `${expected.collection}.${expected.name} exists with status "${status}". Index configuration is not proof of execution — wait for READY before testing retrieval.`,
          { ...expected, status });
      }
    }
  }
  say("");

  // ───────────────── 3b. embedding mode consistency ─────────────────────────
  // The silent-broken case: EMBEDDING_MODE says one thing, the index was built for
  // the other. provision.js never edits an existing search index, so the mismatch
  // survives a re-provision. The query then returns zero results WITHOUT erroring,
  // and the only symptom is the companion saying it has no memory of things it does.
  const mode = process.env.EMBEDDING_MODE || "auto";
  const vectorIndexName = process.env.VECTOR_INDEX || "episodes_auto";
  if (liveNames.has("episodes")) {
    say("── embedding mode");
    say(`   EMBEDDING_MODE=${mode}  VECTOR_INDEX=${vectorIndexName}`);
    try {
      const live = await db.collection("episodes").listSearchIndexes().toArray();
      const index = live.find(i => i.name === vectorIndexName);
      if (!index) {
        say(`   ! ${vectorIndexName} does not exist yet; nothing to compare`);
      } else {
        const definition = index.latestDefinition ?? index.definition ?? {};
        const field = (definition.fields ?? [])
          .find(f => f.type === "autoEmbed" || f.type === "vector");
        const indexMode = field?.type === "autoEmbed" ? "auto"
          : field?.type === "vector" ? "manual" : null;
        say(`   index field: ${field?.type ?? "none found"} on "${field?.path ?? "?"}" → implies ${indexMode ?? "unknown"}`);

        if (indexMode && indexMode !== mode) {
          add("P0", "embedding_mode_mismatch",
            `EMBEDDING_MODE is "${mode}" but index "${vectorIndexName}" is built for "${indexMode}" ` +
            `(${field.type} on ${field.path}). Vector search will return ZERO results without erroring. ` +
            `Fix: point VECTOR_INDEX at a NEW index name built for "${mode}" — never edit the existing one.`,
            { mode, indexMode, index: vectorIndexName, fieldType: field.type, path: field.path });
        } else if (indexMode === "auto") {
          // Automated Embedding is a per-project integration. A queryable index whose
          // documents never match is the signature of a missing integration.
          const approved = await db.collection("episodes")
            .countDocuments({ reviewStatus: "approved", isCurrent: true }, { limit: 1 });
          if (approved && index.queryable) {
            say("   = autoEmbed index is queryable and approved episodes exist");
            say("     (a live query is the only proof the project integration works — npm run atlas:check)");
          }
        } else if (indexMode === "manual") {
          const without = await db.collection("episodes").countDocuments({
            reviewStatus: "approved", isCurrent: true,
            $or: [{ embedding: null }, { embedding: { $exists: false } }]
          });
          if (without) {
            add("P1", "manual_embeddings_missing",
              `${without} approved episode(s) have no "embedding" field. In manual mode they are invisible ` +
              `to vector search until re-embedded. Text search still works, so hybrid retrieval degrades ` +
              `quietly rather than failing.`,
              { count: without });
          }
        }
      }
    } catch (error) {
      say(`   ! cannot inspect ${vectorIndexName} (${error.message})`);
    }
    say("");
  }

  // ───────────────────── 4. report ──────────────────────────────────────────
  if (AS_JSON) {
    console.log(JSON.stringify({ database: dbName, serverVersion: build.version, collections: rows, findings }, null, 2));
  } else {
    say("── inventory");
    const width = Math.max(...rows.map(r => r.name.length), 10);
    say(`   ${"collection".padEnd(width)}  ${"docs".padStart(8)}  idx  designed  flags`);
    for (const row of rows.sort((a, b) => a.name.localeCompare(b.name))) {
      const flags = [
        row.actual <= 1 && row.count > 0 ? "UNINDEXED" : "",
        row.ttl ? "ttl" : "",
        row.known ? "" : "unknown"
      ].filter(Boolean).join(" ");
      say(`   ${row.name.padEnd(width)}  ${String(row.count).padStart(8)}  ${String(row.actual).padStart(3)}  ${String(row.designed).padStart(8)}  ${flags}`);
    }

    const order = ["P0", "P1", "P2", "P3"];
    const labels = {
      P0: "P0 — safety. Fix before the next demo.",
      P1: "P1 — correctness or performance on a live path.",
      P2: "P2 — hygiene and drift.",
      P3: "P3 — informational."
    };
    say("\n─────────────────────────────────────────────");
    for (const priority of order) {
      const group = findings.filter(f => f.priority === priority);
      if (!group.length) continue;
      say(`\n${labels[priority]}`);
      for (const finding of group) {
        say(`   • [${finding.code}] ${finding.message}`);
        if (finding.detail?.missing) say(`       missing: ${finding.detail.missing.join(", ")}`);
        if (finding.detail?.collections?.length) say(`       collections: ${finding.detail.collections.join(", ")}`);
      }
    }
    const counts = order.map(p => `${p}:${findings.filter(f => f.priority === p).length}`).join("  ");
    say(`\n─────────────────────────────────────────────`);
    say(`${findings.length} finding(s)   ${counts}`);
    say(`
This audit wrote nothing. To act on it:
  npm run schema:plan        see exactly what would be created
  npm run schema:provision   create the missing indexes, validators and views
  npm run schema:reconcile   check cache divergence and schema invariants`);
  }

  process.exitCode = findings.some(f => f.priority === "P0") ? 1 : 0;
} catch (error) {
  console.error(`Audit failed to run: ${error.message}`);
  process.exitCode = 2;
} finally {
  await client.close();
}
