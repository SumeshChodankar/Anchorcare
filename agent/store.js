// Minimal store adapter, shaped the way db/ingest.js expects (`.mode`, `.client`,
// `.db`), plus the one guard that defines what this agent is allowed to do.
//
// THE GUARD
//
// The agent runs unattended, forever, with nobody watching. That is autonomy of
// OPERATION. It is not autonomy of AUTHORITY: it may not decide that something is
// true enough to say to the patient.
//
// `safeInsert` enforces that at the last possible moment, in the one place every
// write passes through. A document arriving with reviewStatus "approved", or a
// promoted inference, or a patient-visible inference, throws before it reaches the
// driver. Not a lint rule, not a convention — a thrown error at write time.

import { MongoClient } from "mongodb";

export class AgentApprovalError extends Error {
  constructor(collection, reason) {
    super(`Agent refused to write to ${collection}: ${reason}`);
    this.name = "AgentApprovalError";
    this.collection = collection;
  }
}

/** Collections the agent may write to at all. Anything else throws. */
const WRITABLE = new Set([
  "conversation_turns", "conversation_sessions", "sources",
  "inferences", "care_alerts", "active_tasks", "audit_events", "audit_counters",
  "working_memory", "working_sessions", "engagement_ts", "telemetry_ts", "ts_dedupe"
]);

/** Fields no agent write may ever carry. */
function assertAllowed(collection, doc) {
  if (!WRITABLE.has(collection)) {
    throw new AgentApprovalError(collection, "not in the agent's writable set");
  }
  if (doc?.reviewStatus === "approved") {
    throw new AgentApprovalError(collection, "reviewStatus 'approved' — only a caregiver approves");
  }
  if (collection === "inferences") {
    if (doc?.visibility && doc.visibility !== "caregiver_only") {
      throw new AgentApprovalError(collection, `visibility '${doc.visibility}'`);
    }
    if (doc?.promotion?.state === "promoted") {
      throw new AgentApprovalError(collection, "promotion is a caregiver action");
    }
    if (["caregiver_confirmed", "caregiver_rejected"].includes(doc?.epistemicStatus)) {
      throw new AgentApprovalError(collection, `epistemicStatus '${doc.epistemicStatus}'`);
    }
  }
  if (collection === "conversation_turns" && doc?.role === "companion") {
    if (doc.sourceId) throw new AgentApprovalError(collection, "a generated turn may not carry a sourceId");
    if (doc.epistemic !== "generated") throw new AgentApprovalError(collection, "companion turns are 'generated'");
    const cited = (doc.groundedOn ?? []).filter(r =>
      r.role === "evidence" &&
      (r.collection === "inferences" ||
       (r.collection === "conversation_turns" && r.epistemic === "generated")));
    if (cited.length) {
      throw new AgentApprovalError(collection,
        `cited its own output or an inference as evidence: ${cited.map(c => c.id).join(", ")}`);
    }
  }
  return doc;
}

export class AgentStore {
  constructor(client, db) {
    this.client = client;
    this.db = db;
    this.mode = "mongodb";          // db/ingest.js branches on this
    this.refusals = 0;
  }

  /** Every agent write goes through here. */
  async safeInsert(collection, doc, options = {}) {
    try { assertAllowed(collection, doc); }
    catch (error) { this.refusals++; throw error; }
    try {
      await this.db.collection(collection).insertOne(doc, options);
      return { inserted: true, _id: doc._id };
    } catch (error) {
      if (error.code === 11000) return { inserted: false, duplicate: true, _id: doc._id };
      throw error;
    }
  }

  async safeUpdate(collection, filter, update, options = {}) {
    if (!WRITABLE.has(collection)) {
      this.refusals++;
      throw new AgentApprovalError(collection, "not in the agent's writable set");
    }
    const setFields = update.$set ?? {};
    if (setFields.reviewStatus === "approved") {
      this.refusals++;
      throw new AgentApprovalError(collection, "cannot set reviewStatus 'approved'");
    }
    return this.db.collection(collection).updateOne(filter, update, options);
  }

  // db/ingest.js calls these names on a store in memory mode; present for parity.
  async insert(name, doc) { const r = await this.safeInsert(name, doc); return r.inserted; }

  async close() { await this.client.close(); }
}

export async function connect(cfg) {
  const client = new MongoClient(cfg.uri, {
    serverSelectionTimeoutMS: 15000,
    appName: "anchorcare-agent"
  });
  await client.connect();
  return new AgentStore(client, client.db(cfg.database));
}
