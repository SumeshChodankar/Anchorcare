// Reports divergence between authoritative records and their read-path caches,
// plus the schema invariants that cannot be expressed as a validator.
//
//   node db/reconcile.js
//   node db/reconcile.js --household demo-household --subject margaret
//
// Spec: docs/ATLAS-MEMORY-SCHEMA.md §5.1, §6.2, §14.4
//
// It REPORTS and does not repair. Silent repair hides the ingestion bug that
// caused the divergence, and in this system a quietly repaired link is a claim
// the companion may speak.

import { createHash } from "node:crypto";
import { NO_TTL } from "./collections.js";

const sha256 = value => createHash("sha256").update(JSON.stringify([value])).digest("hex");
const arg = name => {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 ? process.argv[index + 1] : null;
};

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DATABASE || "engram";
if (!uri) { console.error("MONGODB_URI is required."); process.exit(2); }

const findings = [];
const report = (severity, check, message) => {
  findings.push({ severity, check, message });
  console.log(`   ${severity === "defect" ? "✗" : "!"} [${check}] ${message}`);
};

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
  const scopeFilter = {
    ...(arg("household") ? { householdId: arg("household") } : {}),
    ...(arg("subject") ? { subjectId: arg("subject") } : {})
  };
  const LIMIT = 500;

  // ── 1. TTL on a collection that must never expire ──────────────────────────
  console.log("── retention policy");
  for (const name of NO_TTL) {
    const indexes = await db.collection(name).indexes().catch(() => []);
    for (const index of indexes.filter(i => i.expireAfterSeconds !== undefined)) {
      report("defect", "no-ttl", `${name} has a TTL index (${index.name}) — safety and memory data must not expire`);
    }
  }

  // ── 2. episodes.semanticRefs vs approved memory_links ──────────────────────
  console.log("── episodic → semantic caches");
  const episodes = await db.collection("episodes")
    .find({ ...scopeFilter, reviewStatus: "approved", isCurrent: true })
    .project({ semanticRefs: 1, personIds: 1, sourceIds: 1, searchText: 1,
               embeddingMeta: 1, chapterId: 1, householdId: 1, subjectId: 1 })
    .limit(LIMIT).toArray();

  for (const episode of episodes) {
    const scope = { householdId: episode.householdId, subjectId: episode.subjectId };
    const links = await db.collection("memory_links")
      .find({ ...scope, fromId: episode._id, linkType: "about",
              reviewStatus: "approved", isCurrent: true })
      .project({ toId: 1 }).toArray();
    const linked = new Set(links.map(l => l.toId));

    for (const ref of episode.semanticRefs ?? []) {
      if (!linked.has(ref)) {
        report("defect", "semanticRefs", `${episode._id} caches ${ref} with no approved 'about' link — retrieval ignores it`);
      }
    }
    for (const personId of episode.personIds ?? []) {
      if (!(episode.semanticRefs ?? []).includes(personId)) {
        report("warning", "personIds", `${episode._id} has personId ${personId} missing from semanticRefs — vector pre-filter will miss it`);
      }
    }

    // ── 3. approved episodes must have usable evidence (I2, I3) ──────────────
    if (!episode.sourceIds?.length) {
      report("defect", "evidence", `${episode._id} is approved with no sourceIds`);
    } else {
      const sources = await db.collection("sources")
        .find({ ...scope, _id: { $in: episode.sourceIds } })
        .project({ inspection: 1 }).toArray();
      if (sources.length !== episode.sourceIds.length) {
        report("defect", "evidence", `${episode._id} references ${episode.sourceIds.length} source(s) but ${sources.length} exist in scope`);
      }
      const uninspected = sources.filter(s => s.inspection?.required && !s.inspection?.at);
      if (uninspected.length) {
        report("defect", "inspection", `${episode._id} is approved but ${uninspected.length} source(s) were never inspected`);
      }
    }

    // ── 4. stale vectors after a correction ─────────────────────────────────
    if (episode.embeddingMeta?.inputDigest && episode.searchText) {
      if (sha256(episode.searchText) !== episode.embeddingMeta.inputDigest) {
        report("warning", "stale-vector", `${episode._id} searchText no longer matches embeddingMeta.inputDigest — re-embed`);
      }
    }

    // ── 5. chapter pointer resolves ─────────────────────────────────────────
    if (episode.chapterId) {
      const chapter = await db.collection("life_chapters").findOne({ ...scope, _id: episode.chapterId },
        { projection: { reviewStatus: 1 } });
      if (!chapter) report("defect", "chapter", `${episode._id} points at missing chapter ${episode.chapterId}`);
      else if (chapter.reviewStatus !== "approved") {
        report("warning", "chapter", `${episode._id} points at draft chapter ${episode.chapterId}`);
      }
    }
  }
  if (episodes.length === LIMIT) {
    report("warning", "pagination", `checked the first ${LIMIT} approved episodes only — paginate for a full audit`);
  }

  // ── 6. person nodes must have a people card with the same _id ─────────────
  console.log("── semantic layer");
  const personNodes = await db.collection("semantic_nodes")
    .find({ ...scopeFilter, nodeType: "person" })
    .project({ householdId: 1, subjectId: 1, label: 1 }).limit(LIMIT).toArray();
  for (const node of personNodes) {
    const card = await db.collection("people").findOne(
      { _id: node._id, householdId: node.householdId, subjectId: node.subjectId }, { projection: { _id: 1 } });
    if (!card) {
      report("defect", "person-identity", `semantic node ${node._id} (${node.label}) has no matching people card — the shared-id invariant is broken`);
    }
  }

  // ── 7. edge pairs must be complete ────────────────────────────────────────
  const pairs = await db.collection("semantic_edges").aggregate([
    { $match: { ...scopeFilter, isCurrent: true, inverseType: { $ne: null } } },
    { $group: { _id: "$pairId", n: { $sum: 1 },
                directions: { $addToSet: "$direction" },
                approved: { $addToSet: "$reviewStatus" } } },
    { $match: { $expr: { $lt: [{ $size: "$directions" }, 2] } } },
    { $limit: LIMIT }
  ]).toArray();
  for (const pair of pairs) {
    report("defect", "edge-pair", `pairId ${pair._id} has only the ${pair.directions.join("/")} half — $graphLookup will traverse one way only`);
  }

  const mixed = await db.collection("semantic_edges").aggregate([
    { $match: { ...scopeFilter, isCurrent: true, inverseType: { $ne: null } } },
    { $group: { _id: "$pairId", statuses: { $addToSet: "$reviewStatus" } } },
    { $match: { $expr: { $gt: [{ $size: "$statuses" }, 1] } } },
    { $limit: LIMIT }
  ]).toArray();
  for (const pair of mixed) {
    report("defect", "edge-pair", `pairId ${pair._id} halves disagree on reviewStatus (${pair.statuses.join(", ")}) — one direction is speakable and the other is not`);
  }

  // ── 8. hotEdges must reference approved, current edges ────────────────────
  const nodesWithHot = await db.collection("semantic_nodes")
    .find({ ...scopeFilter, hotEdges: { $exists: true, $ne: [] } })
    .project({ hotEdges: 1, householdId: 1, subjectId: 1 }).limit(LIMIT).toArray();
  for (const node of nodesWithHot) {
    for (const hot of node.hotEdges) {
      const edge = await db.collection("semantic_edges").findOne(
        { _id: hot.edgeId, householdId: node.householdId, subjectId: node.subjectId },
        { projection: { isCurrent: 1, reviewStatus: 1 } });
      if (!edge) report("defect", "hotEdges", `${node._id} caches missing edge ${hot.edgeId}`);
      else if (!edge.isCurrent || edge.reviewStatus !== "approved") {
        report("defect", "hotEdges", `${node._id} caches edge ${hot.edgeId} that is ${edge.isCurrent ? "unapproved" : "superseded"} — rebuild the cache`);
      }
    }
  }

  // ── 9. procedures must reference active, sufficiently-tiered tools ────────
  console.log("── procedural layer");
  const procedures = await db.collection("procedures")
    .find({ "approval.status": "active" })
    .project({ procedureId: 1, version: 1, riskTier: 1, steps: 1, escalation: 1 }).toArray();
  for (const procedure of procedures) {
    for (const step of procedure.steps ?? []) {
      const tool = await db.collection("tool_registry").findOne({ _id: step.toolId },
        { projection: { status: 1, maxRiskTier: 1 } });
      if (!tool) {
        report("defect", "tool", `${procedure._id} step ${step.stepId} uses unknown tool ${step.toolId}`);
      } else if (tool.status !== "active") {
        report("defect", "tool", `${procedure._id} step ${step.stepId} uses ${tool.status} tool ${step.toolId} — the procedure cannot run`);
      } else if (tool.maxRiskTier < procedure.riskTier) {
        report("defect", "tool-tier", `${procedure._id} (tier ${procedure.riskTier}) uses ${step.toolId} capped at tier ${tool.maxRiskTier}`);
      }
    }
    if (procedure.riskTier >= 2 && !(procedure.escalation?.ladder ?? []).length) {
      report("defect", "escalation", `${procedure._id} is tier ${procedure.riskTier} with no escalation ladder`);
    }
  }

  // ── 10. safety invariants ─────────────────────────────────────────────────
  console.log("── safety layer");
  const unevidencedAlerts = await db.collection("care_alerts")
    .countDocuments({ ...scopeFilter, $or: [{ triggerRefs: { $size: 0 } }, { triggerRefs: { $exists: false } }] });
  if (unevidencedAlerts) {
    report("defect", "alert-evidence", `${unevidencedAlerts} care_alert(s) name no evidence`);
  }

  const overdue = await db.collection("care_alerts")
    .find({ ...scopeFilter, state: { $in: ["raised", "notified"] }, slaDeadlineAt: { $lt: new Date() } })
    .project({ alertType: 1, severity: 1, slaDeadlineAt: 1 }).limit(50).toArray();
  for (const alert of overdue) {
    report("defect", "alert-sla", `${alert._id} (${alert.alertType}, ${alert.severity}) passed its SLA at ${alert.slaDeadlineAt.toISOString()} and is still unacknowledged`);
  }

  const draftConstraints = await db.collection("safety_constraints")
    .countDocuments({ ...scopeFilter, reviewStatus: { $ne: "approved" } });
  if (draftConstraints) {
    report("defect", "constraint-state", `${draftConstraints} safety_constraint(s) are not approved — a half-entered constraint does not protect anyone`);
  }

  const noAuthority = await db.collection("safety_constraints")
    .countDocuments({ ...scopeFilter, isCurrent: true, $or: [{ authority: null }, { "authority.name": { $exists: false } }] });
  if (noAuthority) {
    report("defect", "constraint-authority", `${noAuthority} current constraint(s) have no named authority`);
  }

  // ── 11. deceased / non-current entities need an explicit disclosure policy ─
  const sensitive = await db.collection("semantic_nodes")
    .find({ ...scopeFilter, isCurrent: true, lifeStatus: { $in: ["deceased", "former"] } })
    .project({ label: 1, lifeStatus: 1, disclosure: 1, sensitivity: 1 }).limit(LIMIT).toArray();
  for (const node of sensitive) {
    if (!node.disclosure?.decidedBy) {
      report("defect", "disclosure", `${node._id} (${node.label}, ${node.lifeStatus}) has no caregiver-decided disclosure policy — the companion would improvise`);
    }
    if (node.lifeStatus === "deceased" && node.disclosure?.policy === "state_plainly" && node.sensitivity === "normal") {
      report("warning", "disclosure", `${node._id} (${node.label}) is deceased, marked normal sensitivity and set to state_plainly — confirm this is a deliberate caregiver decision`);
    }
  }

  // ── 12. contradictions awaiting a human ──────────────────────────────────
  const contradictions = await db.collection("memory_links")
    .countDocuments({ ...scopeFilter, linkType: "contradicts", isCurrent: true });
  if (contradictions) {
    report("warning", "contradictions", `${contradictions} unresolved contradiction link(s) — by design these wait for a caregiver (§17.5)`);
  }

  // ── summary ──────────────────────────────────────────────────────────────
  const defects = findings.filter(f => f.severity === "defect").length;
  const warnings = findings.length - defects;
  console.log("\n─────────────────────────────────────────────");
  console.log(`${defects} defect(s), ${warnings} warning(s)`);
  if (!findings.length) console.log("No divergence found. Caches agree with their authoritative records.");
  else console.log("Nothing was repaired. Fix the writer that produced the divergence, then re-run.");
  process.exitCode = defects ? 1 : 0;
} catch (error) {
  console.error(`Reconciliation failed to run: ${error.message}`);
  process.exitCode = 2;
} finally {
  await client.close();
}
