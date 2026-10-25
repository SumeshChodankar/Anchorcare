// Backfills the semantic layer from collections that already exist.
//
//   node db/backfill-semantic.js --dry-run            # default: print the plan
//   node db/backfill-semantic.js --apply
//   node db/backfill-semantic.js --apply --household demo-household --subject margaret
//
// Spec: docs/ATLAS-MEMORY-SCHEMA.md §16.1 steps 3–6
//
// Safety properties:
//   * Every semantic_node and semantic_edge it writes is reviewStatus "draft", so
//     the companion's behaviour does not change until a caregiver approves.
//   * The one exception is `about` links derived from episodes.personIds on already
//     APPROVED episodes: the caregiver approved that episode with those people on it,
//     so the link is approved rather than re-asked.
//   * Person nodes reuse the people._id, preserving the shared-id invariant.
//   * It never overwrites an existing node, edge, link or episode field that is
//     already populated. Re-running is a no-op.

import "../engram-retrieval/src/env.js";
import { createHash } from "node:crypto";

const sha256 = (...parts) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
const deterministicId = (prefix, ...parts) => `${prefix}_${sha256(...parts)}`;

const APPLY = process.argv.includes("--apply");
const arg = name => {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 ? process.argv[index + 1] : null;
};

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DATABASE || "engram";
if (!uri) { console.error("MONGODB_URI is required."); process.exit(2); }

const firstClause = (text, max = 280) => {
  if (!text) return "";
  const stop = text.search(/[.!?](\s|$)/);
  const clause = stop > 0 ? text.slice(0, stop + 1) : text;
  return clause.length <= max ? clause.trim() : `${clause.slice(0, max - 1).trim()}…`;
};
const localDay = instant => new Date(instant).toISOString().slice(0, 10);

const counts = { nodes: 0, edges: 0, links: 0, episodes: 0, skipped: 0 };
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
  const now = new Date();
  const scopeFilter = {
    ...(arg("household") ? { householdId: arg("household") } : {}),
    ...(arg("subject") ? { subjectId: arg("subject") } : {})
  };
  console.log(`${APPLY ? "APPLYING" : "DRY RUN"} against ${dbName}\n`);

  // ── step 3: people → draft semantic_nodes, same _id ───────────────────────
  console.log("── people → semantic_nodes (draft)");
  for await (const person of db.collection("people").find(scopeFilter)) {
    const scope = { householdId: person.householdId, subjectId: person.subjectId };
    if (await db.collection("semantic_nodes").findOne({ _id: person._id, ...scope }, { projection: { _id: 1 } })) {
      counts.skipped++; continue;
    }
    const node = {
      _id: person._id, ...scope,
      nodeType: "person",
      label: person.name,
      aliases: [],
      attributes: { relationship: person.relationship ?? null, lastSeenReportedAt: null, voiceSample: null },
      // lifeStatus is UNKNOWN, not "current": the people card never recorded it, and
      // guessing "current" for someone who has died is the worst failure in this schema.
      lifeStatus: "unknown",
      lifeStatusChangedAt: null,
      sensitivity: "normal",
      disclosure: { policy: "defer_to_caregiver", script: null, decidedBy: null, decidedAt: null,
                    reviewNote: "Backfilled from a people card. Set lifeStatus and a disclosure policy before approving." },
      searchText: [person.name, person.relationship].filter(Boolean).join(", "),
      embedding: null,
      sourceIds: [],
      confidence: null,
      reviewStatus: "draft",
      isCurrent: true,
      supersedes: null, supersededBy: null,
      hotEdges: [],
      activation: { score: 0, lastRetrievedAt: null, retrievalCount: 0 },
      version: 1,
      digest: sha256(person.name, person.relationship ?? null),
      recordedAt: now, reviewedAt: null,
      backfilledFrom: "people"
    };
    console.log(`   + node ${node._id} (${node.label}, ${node.attributes.relationship ?? "relationship unknown"}) lifeStatus=unknown`);
    if (APPLY) await db.collection("semantic_nodes").insertOne(node);
    counts.nodes++;
  }

  // ── step 4: personal_records of kind "person" → draft relationship edges ──
  console.log("\n── personal_records → semantic_edges (draft)");
  const RELATION = {
    daughter: "child_of", son: "child_of", child: "child_of",
    mother: "parent_of", father: "parent_of", parent: "parent_of",
    husband: "spouse_of", wife: "spouse_of", spouse: "spouse_of",
    sister: "sibling_of", brother: "sibling_of",
    friend: "friend_of", neighbour: "neighbour_of", neighbor: "neighbour_of",
    carer: "cares_for", caregiver: "cares_for", nurse: "cares_for", gp: "clinician_for", doctor: "clinician_for"
  };
  const INVERSE = {
    child_of: "parent_of", parent_of: "child_of", spouse_of: "spouse_of",
    sibling_of: "sibling_of", friend_of: "friend_of", neighbour_of: "neighbour_of",
    cares_for: "cared_for_by", clinician_for: "patient_of"
  };

  for await (const record of db.collection("personal_records")
      .find({ ...scopeFilter, kind: "person", personId: { $ne: null } })) {
    const scope = { householdId: record.householdId, subjectId: record.subjectId };
    const person = await db.collection("people").findOne({ _id: record.personId, ...scope },
      { projection: { relationship: 1, name: 1 } });
    if (!person) { counts.skipped++; continue; }

    const key = String(person.relationship ?? "").trim().toLowerCase();
    const edgeType = RELATION[key];
    if (!edgeType) {
      console.log(`   ? ${record.personId}: relationship "${person.relationship}" has no edge mapping — leaving to a caregiver`);
      counts.skipped++; continue;
    }

    const subjectNode = `subject_${scope.subjectId}`;
    const pairId = deterministicId("pair", scope, [record.personId, subjectNode].sort(), edgeType);
    const forwardId = deterministicId("edge", scope, record.personId, edgeType, subjectNode);
    if (await db.collection("semantic_edges").findOne({ _id: forwardId }, { projection: { _id: 1 } })) {
      counts.skipped++; continue;
    }

    const base = {
      ...scope, pairId, weight: 0.8, temporal: null, status: "current",
      sourceIds: [], confidence: null, reviewStatus: "draft", isCurrent: true,
      supersedes: null, supersededBy: null, version: 1, recordedAt: now,
      backfilledFrom: `personal_records:${record._id}`
    };
    const inverseType = INVERSE[edgeType] ?? null;
    const docs = [{
      _id: forwardId, ...base, fromId: record.personId, toId: subjectNode,
      edgeType, inverseType, direction: "forward",
      digest: sha256(record.personId, subjectNode, edgeType, null, "current")
    }];
    if (inverseType) {
      docs.push({
        _id: deterministicId("edge", scope, subjectNode, inverseType, record.personId), ...base,
        fromId: subjectNode, toId: record.personId,
        edgeType: inverseType, inverseType: edgeType, direction: "reverse",
        digest: sha256(subjectNode, record.personId, inverseType, null, "current")
      });
    }
    console.log(`   + edge ${person.name} -[${edgeType}]-> ${scope.subjectId}${inverseType ? ` (+ reverse ${inverseType})` : ""}`);
    if (APPLY) await db.collection("semantic_edges").insertMany(docs);
    counts.edges += docs.length;
  }

  // ── steps 5–6: episodes.personIds → approved `about` links + field backfill ─
  console.log("\n── episodes → memory_links + derived fields");
  for await (const episode of db.collection("episodes").find(scopeFilter)) {
    const scope = { householdId: episode.householdId, subjectId: episode.subjectId };
    const approved = episode.reviewStatus === "approved" && episode.isCurrent === true;

    for (const personId of episode.personIds ?? []) {
      const linkId = deterministicId("link", scope, "episodic", episode._id, "about", "semantic", personId);
      if (await db.collection("memory_links").findOne({ _id: linkId }, { projection: { _id: 1 } })) {
        counts.skipped++; continue;
      }
      const link = {
        _id: linkId, ...scope,
        fromStore: "episodic", fromId: episode._id,
        toStore: "semantic", toId: personId,
        linkType: "about", weight: 1,
        createdBy: "caregiver",
        // The caregiver approved THIS episode with THIS person on it, so the link
        // carries that approval forward rather than asking again. A draft episode's
        // links stay drafts.
        reviewStatus: approved ? "approved" : "draft",
        sourceIds: episode.sourceIds ?? [],
        confidence: null,
        recordedAt: now, reviewedAt: approved ? (episode.reviewedAt ?? now) : null,
        isCurrent: true, supersedes: null, supersededBy: null,
        backfilledFrom: "episodes.personIds"
      };
      if (APPLY) await db.collection("memory_links").insertOne(link);
      counts.links++;
    }

    const set = {};
    if (episode.semanticRefs === undefined) set.semanticRefs = episode.personIds ?? [];
    if (episode.gist === undefined) set.gist = firstClause(episode.summary ?? "");
    if (episode.sensitivity === undefined) set.sensitivity = "normal";
    if (episode.consolidation === undefined) {
      set.consolidation = { state: "labile", rehearsalCount: 0, lastConsolidatedAt: null, promotedNodeIds: [] };
    }
    if (episode.dedupeKey === undefined && episode.eventStart) {
      // Includes _id so the unique index cannot reject pre-existing near-duplicates
      // that the old schema legitimately allowed.
      set.dedupeKey = ["backfill", episode._id, localDay(episode.eventStart)].join("|");
    }
    if (episode.embeddingMeta === undefined && episode.searchText) {
      set.embeddingMeta = {
        textModel: process.env.VOYAGE_EMBED_MODEL || "voyage-4",
        textDims: Number(process.env.VOYAGE_DIMENSIONS || 1024),
        visualModel: null, visualDims: null,
        inputDigest: sha256(episode.searchText), generatedAt: null
      };
    }
    if (Object.keys(set).length) {
      if (APPLY) await db.collection("episodes").updateOne({ _id: episode._id, ...scope }, { $set: set });
      counts.episodes++;
    }
  }

  console.log("\n─────────────────────────────────────────────");
  console.log(`nodes ${counts.nodes} · edges ${counts.edges} · links ${counts.links} · episodes updated ${counts.episodes} · skipped ${counts.skipped}`);
  if (!APPLY) console.log("\nDry run. Re-run with --apply to write.");
  else console.log(`
Next, in the caregiver console:
  1. Every backfilled person node is lifeStatus "unknown" with disclosure
     "defer_to_caregiver". Set the real status and policy BEFORE approving —
     this is the field that decides what the companion says about someone who died.
  2. Approve the relationship edges you agree with. Draft edges never traverse.
  3. Run: node db/reconcile.js`);
} catch (error) {
  console.error(`Backfill failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await client.close();
}
