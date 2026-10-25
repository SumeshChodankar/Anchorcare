// Moves the scratch `test` database into the real schema.
//
//   node db/restructure-test-db.js                 INSPECT — reads, proposes, writes nothing
//   node db/restructure-test-db.js --apply         write the mapped documents
//   node db/restructure-test-db.js --source-db test --subject margaret
//
// CONTEXT
//
// `test` holds `conversations`, `memories` and `alerts`: the scratch area where input
// was captured while the main `engram` database was kept safe. A question that was
// asked landed in `test.conversations`. None of it was written by this repo's Node
// code, and its document shapes are not defined anywhere, so this script INSPECTS
// FIRST and proposes a mapping you can read before anything is written.
//
// WHERE EACH ONE GOES (docs/GEMINI-WRITE-ROUTING.md has the reasoning)
//
//   test.conversations  → conversation_turns (role: patient, epistemic: observed)
//                       + sources            (sourceType: user_report)
//                       + conversation_sessions
//     A captured question is an OBSERVATION: she said it, so it is evidence and gets
//     a write-once source. Any answer stored alongside it becomes a SECOND turn,
//     role: companion, epistemic: generated, with sourceId null — a generated
//     sentence is never evidence (schema §18.3).
//
//   test.memories       → sources + episodes (reviewStatus: "draft")
//     Draft, always. Nothing here was caregiver-approved, so nothing may reach the
//     patient until someone approves it.
//
//   test.alerts         → care_alerts, but ONLY where evidence can be named.
//     care_alerts requires a non-empty triggerRefs. An alert that cannot say what it
//     was raised about is reported and skipped, never invented into existence.
//
// SAFETY
//   * Idempotent: every _id is derived from the source document, so re-running is a
//     no-op rather than a duplicate.
//   * Additive: nothing in `test` is modified or deleted. Drop it yourself once you
//     are satisfied.
//   * Draft-only: no episode, and no mapped record, arrives approved.

import "../engram-retrieval/src/env.js";
import { createHash, randomUUID } from "node:crypto";

const argv = process.argv.slice(2);
const flag = n => argv.includes(`--${n}`);
const arg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i > -1 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};

const APPLY = flag("apply");
const SOURCE_DB = arg("source-db", "test");
const TARGET_DB = process.env.MONGODB_DATABASE || "engram";
const householdId = arg("household", process.env.HOUSEHOLD_ID || "demo-household");
const subjectId = arg("subject", (process.env.SUBJECT_IDS || "margaret").split(",")[0].trim());
const SAMPLE = Number(arg("sample", 3));

const uri = process.env.MONGODB_URI_NEW || process.env.MONGODB_URI;
if (!uri) { console.error("Set MONGODB_URI (or MONGODB_URI_NEW)."); process.exit(2); }
if (SOURCE_DB === TARGET_DB) { console.error("Source and target database are the same."); process.exit(2); }

const { MongoClient } = await import("mongodb").catch(() => {
  console.error("The 'mongodb' driver is not installed. Run 'npm install' in the repo root.");
  process.exit(2);
});

const sha256 = (...p) => createHash("sha256").update(JSON.stringify(p)).digest("hex");
const scope = { householdId, subjectId };
const now = new Date();

/** Field names vary because nothing defined them. Try the plausible ones, in order. */
const pick = (doc, names, fallback = null) => {
  for (const name of names) {
    const value = name.split(".").reduce((o, k) => (o == null ? o : o[k]), doc);
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return fallback;
};
const asDate = value => {
  if (value instanceof Date) return value;
  const parsed = value == null ? NaN : Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed) : null;
};

const QUESTION_FIELDS = ["question", "query", "text", "prompt", "input", "message", "utterance", "content"];
const ANSWER_FIELDS = ["answer", "response", "reply", "output", "completion", "result"];
const TIME_FIELDS = ["createdAt", "created_at", "timestamp", "ts", "at", "askedAt", "occurredAt", "date"];
const MEMORY_FIELDS = ["text", "memory", "summary", "statement", "content", "description", "note", "body"];
const ALERT_FIELDS = ["message", "text", "summary", "reason", "description", "body", "detail"];
const EVIDENCE_FIELDS = ["evidenceIds", "evidence_ids", "sourceIds", "source_ids", "refs",
                         "relatedIds", "memoryIds", "eventIds", "supporting_evidence_ids"];

const plan = { conversation_turns: [], sources: [], conversation_sessions: [],
               episodes: [], care_alerts: [] };
const skipped = [];
const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });

try {
  await client.connect();
  const src = client.db(SOURCE_DB);
  const dst = client.db(TARGET_DB);

  const present = (await src.listCollections({}, { nameOnly: true }).toArray()).map(c => c.name);
  console.log(`\n${APPLY ? "APPLYING" : "INSPECTING"} — ${SOURCE_DB} → ${TARGET_DB}`);
  console.log(`scope: householdId=${householdId} subjectId=${subjectId}`);
  console.log(`collections in ${SOURCE_DB}: ${present.join(", ") || "(none)"}\n`);

  // ── what is actually in there ────────────────────────────────────────────
  for (const name of present) {
    const count = await src.collection(name).countDocuments();
    const samples = await src.collection(name).find({}).limit(SAMPLE).toArray();
    const fields = new Set();
    for (const doc of samples) for (const key of Object.keys(doc)) fields.add(key);
    console.log(`── ${SOURCE_DB}.${name}  ${count} document(s)`);
    console.log(`   fields seen: ${[...fields].join(", ") || "(none)"}`);
    if (samples[0]) {
      const preview = JSON.stringify(samples[0], (k, v) => typeof v === "string" && v.length > 120
        ? v.slice(0, 117) + "…" : v, 1).replace(/\n\s*/g, " ");
      console.log(`   first doc:   ${preview.slice(0, 400)}`);
    }
    console.log("");
  }

  // ── conversations → turns + sources ──────────────────────────────────────
  if (present.includes("conversations")) {
    const sessionsSeen = new Map();
    let seq = 0;
    for await (const doc of src.collection("conversations").find({}).sort({ _id: 1 })) {
      const question = pick(doc, QUESTION_FIELDS);
      const answer = pick(doc, ANSWER_FIELDS);
      const at = asDate(pick(doc, TIME_FIELDS)) ?? now;
      if (!question) {
        skipped.push({ from: "conversations", _id: String(doc._id),
          why: `no question-like field (looked for: ${QUESTION_FIELDS.join(", ")})` });
        continue;
      }
      const sessionId = String(pick(doc, ["sessionId", "session_id", "conversationId", "thread"],
        `csession_import_${at.toISOString().slice(0, 10)}`));
      if (!sessionsSeen.has(sessionId)) {
        sessionsSeen.set(sessionId, true);
        plan.conversation_sessions.push({
          _id: sessionId, ...scope, channel: "console", initiatedBy: "patient",
          startedAt: at, endedAt: null, durationMs: null,
          turnCount: 0, patientTurnCount: 0, procedureRunIds: [], summaryEpisodeId: null,
          signals: { repeatedQuestionCount: 0, distressReports: 0, safetyVetoes: 0,
                     escalations: 0, scriptedDisclosures: 0, retrievalFailures: 0 },
          consentRef: null, modelRefs: [], closeReason: "imported", redacted: false,
          importedFrom: `${SOURCE_DB}.conversations`
        });
      }

      // The question: observed, therefore evidence, therefore a write-once source.
      const source = {
        _id: `source_${sha256(scope, "test-import", String(doc._id), question)}`,
        ...scope, sourceType: "user_report", modality: "text",
        content: String(question).slice(0, 12000), mediaPtr: null,
        derivedFrom: null, processor: null,
        digest: sha256(question),
        inspection: { required: false, by: null, at: null },
        recordedAt: at, importedFrom: `${SOURCE_DB}.conversations/${doc._id}`
      };
      plan.sources.push(source);
      plan.conversation_turns.push({
        _id: `turn_${sessionId}_${String(seq++).padStart(6, "0")}`,
        ...scope, sessionId, seq: seq - 1,
        role: "patient", epistemic: "observed",
        text: String(question).slice(0, 8000),
        startedAt: at, endedAt: null, transcript: null,
        audio: { storage: "none", ref: null, bytes: 0, durationMs: 0, retainUntil: null },
        sourceId: source._id, groundedOn: [], disclosure: null,
        safety: { precheck: "pass", vetoConstraintId: null, alertIds: [] },
        model: null, latency: null, inferenceIds: [],
        caregiverAnnotation: null, redacted: false, redactionRef: null,
        importedFrom: `${SOURCE_DB}.conversations/${doc._id}`
      });

      // The answer: generated, therefore NOT evidence, therefore sourceId null.
      if (answer) {
        const evidence = pick(doc, EVIDENCE_FIELDS, []);
        plan.conversation_turns.push({
          _id: `turn_${sessionId}_${String(seq++).padStart(6, "0")}`,
          ...scope, sessionId, seq: seq - 1,
          role: "companion", epistemic: "generated",
          text: String(answer).slice(0, 8000),
          startedAt: at, endedAt: at, transcript: null,
          audio: { storage: "none", ref: null, bytes: 0, durationMs: 0, retainUntil: null },
          sourceId: null,
          groundedOn: (Array.isArray(evidence) ? evidence : [evidence]).filter(Boolean)
            .map(id => ({ store: "episodic", collection: null, id: String(id), role: "evidence" })),
          disclosure: null,
          safety: { precheck: "pass", vetoConstraintId: null, alertIds: [] },
          // Imported answers have no reliable model provenance. Recorded as unknown
          // rather than guessed, so nobody later mistakes it for a verified release.
          model: { name: String(pick(doc, ["model", "modelName", "engine"], "unknown-imported")),
                   version: null, promptDigest: null, temperature: null, tokensIn: 0, tokensOut: 0 },
          latency: null, inferenceIds: [],
          caregiverAnnotation: null, redacted: false, redactionRef: null,
          importedFrom: `${SOURCE_DB}.conversations/${doc._id}`
        });
      }
    }
  }

  // ── memories → sources + draft episodes ──────────────────────────────────
  if (present.includes("memories")) {
    for await (const doc of src.collection("memories").find({})) {
      const text = pick(doc, MEMORY_FIELDS);
      const at = asDate(pick(doc, TIME_FIELDS)) ?? now;
      if (!text) {
        skipped.push({ from: "memories", _id: String(doc._id),
          why: `no text-like field (looked for: ${MEMORY_FIELDS.join(", ")})` });
        continue;
      }
      const source = {
        _id: `source_${sha256(scope, "test-import", String(doc._id), text)}`,
        ...scope, sourceType: "caregiver_report", modality: "text",
        content: String(text).slice(0, 12000), mediaPtr: null,
        derivedFrom: null, processor: null, digest: sha256(text),
        inspection: { required: false, by: null, at: null },
        recordedAt: at, importedFrom: `${SOURCE_DB}.memories/${doc._id}`
      };
      plan.sources.push(source);
      const narrative = String(text);
      const stop = narrative.search(/[.!?](\s|$)/);
      plan.episodes.push({
        _id: `episode_import_${sha256(String(doc._id)).slice(0, 16)}`,
        ...scope,
        summary: narrative.slice(0, 2000),
        gist: (stop > 0 ? narrative.slice(0, stop + 1) : narrative).slice(0, 280).trim(),
        searchText: narrative.slice(0, 6000),
        what: null, place: pick(doc, ["place", "location"], null),
        sourceIds: [source._id], personIds: [], semanticRefs: [], chapterId: null,
        eventStart: asDate(pick(doc, ["occurredAt", "eventStart", "happenedAt", ...TIME_FIELDS])) ?? at,
        eventEnd: null, recordedAt: at,
        reviewStatus: "draft",            // nothing imported is patient-visible
        reviewedAt: null, eventStatus: "reported_completed", isCurrent: true,
        supersedes: null, supersededBy: null,
        confidence: null, salience: null, // never invented on import
        emotionalTone: null, sensitivity: "normal", mediaPtr: null,
        derivedModalities: [], visualEmbedding: null,
        visualEmbeddingModel: null, visualEmbeddingAt: null,
        embeddingMeta: {
          textModel: process.env.VOYAGE_EMBED_MODEL || "voyage-4",
          textDims: Number(process.env.VOYAGE_DIMENSIONS || 1024),
          visualModel: null, visualDims: null,
          inputDigest: sha256(narrative.slice(0, 6000)), generatedAt: null
        },
        consolidation: { state: "labile", rehearsalCount: 0, lastConsolidatedAt: null, promotedNodeIds: [] },
        recurrenceKey: null,
        dedupeKey: `import|${SOURCE_DB}.memories|${doc._id}`,
        importedFrom: `${SOURCE_DB}.memories/${doc._id}`
      });
    }
  }

  // ── alerts → care_alerts, only where evidence exists ─────────────────────
  if (present.includes("alerts")) {
    for await (const doc of src.collection("alerts").find({})) {
      const summary = pick(doc, ALERT_FIELDS);
      const at = asDate(pick(doc, TIME_FIELDS)) ?? now;
      const refs = pick(doc, EVIDENCE_FIELDS, []);
      const refList = (Array.isArray(refs) ? refs : [refs]).filter(Boolean);
      if (!summary) {
        skipped.push({ from: "alerts", _id: String(doc._id), why: "no message-like field" });
        continue;
      }
      if (!refList.length) {
        // care_alerts requires triggerRefs minItems 1. An alert that cannot name its
        // evidence is not written — the schema refuses it, and so does this.
        skipped.push({ from: "alerts", _id: String(doc._id),
          why: "no evidence ids; care_alerts requires a non-empty triggerRefs. Import as a caregiver note instead." });
        continue;
      }
      plan.care_alerts.push({
        _id: `alert_import_${sha256(String(doc._id)).slice(0, 16)}`,
        ...scope,
        idempotencyKey: sha256("import", SOURCE_DB, String(doc._id)),
        alertType: "manual",
        severity: ["info", "advisory", "urgent", "emergency"]
          .includes(String(pick(doc, ["severity", "level", "priority"], "info")))
          ? String(pick(doc, ["severity", "level", "priority"], "info")) : "info",
        state: "resolved",       // historical: not a live page to someone's phone
        transitions: [
          { from: null, to: "raised", at, by: "import", note: String(summary).slice(0, 2000) },
          { from: "raised", to: "resolved", at: now, by: "import",
            note: `Imported from ${SOURCE_DB}.alerts as history; not re-notified.` }
        ],
        triggerRefs: refList.map(id => ({ store: "episodic", collection: null, id: String(id) })),
        evidenceSummary: String(summary).slice(0, 2000),
        procedureRunId: null, slaDeadlineAt: null, notifications: [],
        acknowledgedBy: null, acknowledgedAt: null,
        resolution: { outcome: "imported", note: "Historical record", by: "import", at: now },
        createdAt: at, importedFrom: `${SOURCE_DB}.alerts/${doc._id}`
      });
    }
  }

  // ── report ───────────────────────────────────────────────────────────────
  console.log("── proposed writes");
  let total = 0;
  for (const [name, docs] of Object.entries(plan)) {
    if (!docs.length) continue;
    total += docs.length;
    console.log(`   ${TARGET_DB}.${name.padEnd(22)} ${String(docs.length).padStart(5)}`);
  }
  if (!total) console.log("   (nothing mapped)");

  if (skipped.length) {
    console.log(`\n── skipped (${skipped.length})`);
    for (const s of skipped.slice(0, 20)) console.log(`   ${s.from}/${s._id}: ${s.why}`);
    if (skipped.length > 20) console.log(`   … ${skipped.length - 20} more`);
  }

  if (!APPLY) {
    console.log(`
Nothing was written, and nothing in ${SOURCE_DB} was touched.

Read the field lists above. If a question or memory landed under a field name this
script did not look for, tell me the name and I will add it rather than guessing.

When the mapping looks right:
  node db/restructure-test-db.js --apply

Then: npm run schema:audit-live   and approve the draft episodes in the console.
`);
    process.exit(0);
  }

  console.log("\n── writing");
  for (const [name, docs] of Object.entries(plan)) {
    if (!docs.length) continue;
    let inserted = 0, duplicate = 0, failed = 0;
    for (const doc of docs) {
      try { await dst.collection(name).insertOne(doc); inserted++; }
      catch (error) {
        if (error.code === 11000) duplicate++;
        else { failed++; if (failed <= 3) console.log(`   ! ${name}/${doc._id}: ${error.message.slice(0, 160)}`); }
      }
    }
    console.log(`   ${name.padEnd(22)} inserted ${inserted}, already present ${duplicate}, failed ${failed}`);
  }

  // fix session counters now that the turns exist
  for (const session of plan.conversation_sessions) {
    const turns = await dst.collection("conversation_turns").countDocuments({ ...scope, sessionId: session._id });
    const patient = await dst.collection("conversation_turns").countDocuments({ ...scope, sessionId: session._id, role: "patient" });
    await dst.collection("conversation_sessions").updateOne(
      { _id: session._id }, { $set: { turnCount: turns, patientTurnCount: patient } });
  }

  console.log(`
Done. Everything imported is a DRAFT or historical record:
  * episodes are reviewStatus "draft" — approve them in the console before they can
    be spoken to the patient
  * companion turns carry sourceId null and model.name "unknown-imported"
  * alerts are state "resolved" and were not re-notified

${SOURCE_DB} was not modified. Verify, then drop it yourself:
  mongosh "$MONGODB_URI" --eval 'db.getSiblingDB("${SOURCE_DB}").dropDatabase()'
`);
} catch (error) {
  console.error(`\nFailed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await client.close();
}
