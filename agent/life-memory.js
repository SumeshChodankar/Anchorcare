// The rest of Engram, read by the agent: approved people, personal records (identity,
// preferences, facts), daily logs, upcoming plans, and the approved semantic graph.
//
// These are written by the caregiver web app and the conversation-capture pipeline
// (see the routing handover), not by this agent. Until this module the agent read only
// `episodes`, so a name, a preference or a visit that was approved elsewhere was
// invisible to it and every such question was answered "I don't know".
//
// Only reviewStatus "approved" is read as evidence. A draft is somebody's report that no
// caregiver has looked at yet; quoting it as fact would undo the review step.
//
// It also writes one thing: a DRAFT personal record for each statement she makes, in the
// exact shape engram-retrieval/src/life-records.js uses, so it appears in the caregiver's
// existing review flow (POST /api/engram/admin/life-records/review) and, once approved,
// comes back here as a fact. The agent never approves it; agent/store.js would refuse.

import { sha256 } from "../db/ingest.js";

const DAY = 86_400_000;
const demoPrefix = text => String(text ?? "").replace(/^\s*(?:User report[^:]*:\s*)?FICTIONAL DEMO\s*[—–-]\s*/i, "").trim();

/** Everything approved that could answer a question, in parallel, never throwing. */
export async function loadLifeMemory(db, scope, now) {
  const safe = p => p.catch(() => []);
  const [records, people, logs, plans, nodes, edges] = await Promise.all([
    safe(db.collection("personal_records").find({ ...scope, reviewStatus: "approved" }).sort({ recordedAt: -1 }).limit(200).toArray()),
    safe(db.collection("people").find({ ...scope, reviewStatus: "approved" }).limit(100).toArray()),
    safe(db.collection("daily_logs").find({ ...scope, reviewStatus: "approved", occurredAt: { $gte: new Date(+now - 14 * DAY) } })
      .sort({ occurredAt: -1 }).limit(100).toArray()),
    safe(db.collection("plans").find({ ...scope, reviewStatus: "approved", eventStart: { $gte: new Date(+now - 2 * 3_600_000) } })
      .sort({ eventStart: 1 }).limit(50).toArray()),
    safe(db.collection("semantic_nodes").find({ ...scope, reviewStatus: "approved", isCurrent: true }).limit(200).toArray()),
    safe(db.collection("semantic_edges").find({ ...scope, reviewStatus: "approved", isCurrent: true }).limit(400).toArray())
  ]);
  return { records, people, logs, plans, nodes, edges };
}

/** Her name from an approved identity record, when identity_core has none. */
export function patientNameFrom(life) {
  for (const r of life?.records ?? []) {
    if (r.kind !== "fact" || !/\b(name|identity)\b/i.test(r.title ?? "")) continue;
    const m = demoPrefix(r.originalText).match(/\b(?:named|called|name is)\s+([A-Z][\p{L}'-]+(?:\s+[A-Z][\p{L}'-]+)?)/u);
    if (m) return m[1];
  }
  return null;
}

const fmt = (at, timezone, opts) => new Intl.DateTimeFormat("en-GB", { timeZone: timezone, ...opts }).format(new Date(at));

/**
 * Approved life memory as evidence items: { id, collection, store, when, text }.
 * `store` is the Engram store each collection belongs to, for groundedOn.
 */
export function lifeEvidence(life, timezone) {
  const people = new Map((life?.people ?? []).map(p => [p._id, p]));
  const items = [];
  for (const r of life?.records ?? []) {
    items.push({ id: r._id, collection: "personal_records", store: "autobiographical", kind: r.kind, sourceType: r.sourceType,
                 when: r.recordedAt ? fmt(r.recordedAt, timezone, { dateStyle: "medium" }) : "unknown",
                 text: `${r.title}: ${demoPrefix(r.originalText)}`, at: r.recordedAt });
  }
  for (const p of life?.people ?? []) {
    items.push({ id: p._id, collection: "people", store: "semantic", when: "known person",
                 text: `${p.name} is your ${p.relationship ?? "friend"}.` });
  }
  for (const l of life?.logs ?? []) {
    items.push({ id: l._id, collection: "daily_logs", store: "autobiographical",
                 when: fmt(l.occurredAt, timezone, { weekday: "long", hour: "numeric", minute: "2-digit", hour12: true }),
                 text: `${l.label} (${l.activity}, ${String(l.outcome).replace(/_/g, " ")}): ${demoPrefix(l.originalText)}`, at: l.occurredAt });
  }
  for (const p of life?.plans ?? []) {
    const who = p.personId && people.get(p.personId) ? ` with ${people.get(p.personId).name}` : "";
    items.push({ id: p._id, collection: "plans", store: "procedural", plan: true, at: p.eventStart,
                 when: fmt(p.eventStart, timezone, { weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit", hour12: true }),
                 text: `Planned ${p.kind === "visit" ? "visit" : p.kind.replace(/_/g, " ")}${who}.` });
  }
  // Semantic graph, one hop: "Sam Rivera cares_for <her>".
  const nodes = new Map((life?.nodes ?? []).map(n => [n._id, n]));
  for (const e of life?.edges ?? []) {
    const fromId = e.fromId ?? e.from, toId = e.toId ?? e.to;
    const from = nodes.get(fromId), to = nodes.get(toId);
    const name = id => nodes.get(id)?.label ?? (String(id).startsWith("subject_") ? "her" : null);
    if (!name(fromId) || !name(toId) || (!from && !to)) continue;
    items.push({ id: e._id, collection: "semantic_edges", store: "semantic", when: "relationship",
                 text: `${name(fromId)} ${String(e.edgeType).replace(/_/g, " ")} ${name(toId)}.` });
  }
  return items;
}

// ── statement capture ──────────────────────────────────────────────────────
const QUESTION = /^\s*(where|what|when|who|which|why|how|did|do|does|is|are|was|were|can|could|will|would|shall|should)\b|\?\s*$/i;

/**
 * Does any sentence state something? "Can you please check? I have an appointment
 * tomorrow at 9." opens with a question but carries a fact, and must not be skipped.
 */
// A sentence is a question by how it opens: "I have an appointment, can you book it?"
// ends in "?" but states a fact.
const QUESTION_OPENING = /^\s*(where|what|when|who|which|why|how|did|do|does|is|are|was|were|can|could|will|would|shall|should)\b/i;
export const hasStatement = text => String(text ?? "").split(/(?<=[.!?])\s+/)
  .some(s => !QUESTION_OPENING.test(s) && s.trim().split(/\s+/).length >= 3);
const FILLER = /^\s*(hello|hi|hey|thanks|thank you|okay|ok|yes|no|yeah|bye|good (?:morning|night|evening|afternoon))\b[\s.!,]*$/i;
const PREFERENCE = /\bi (?:really )?(?:like|love|prefer|enjoy|hate|dislike|don'?t like|can'?t stand)\b/i;

/**
 * A DRAFT personal record for a statement she made, or null when the turn is a
 * question, a greeting, or too short to be worth a caregiver's time.
 * The record is built exactly as LifeRecords.save() would, so the web app can review it.
 */
export function draftPersonalRecord(scope, turn, now) {
  const text = String(turn.text ?? "").trim();
  if (text.split(/\s+/).length < 4 || !hasStatement(text) || FILLER.test(text)) return null;
  const kind = PREFERENCE.test(text) ? "preference" : "fact";
  const verified = turn.speaker?.verified === true ? "voice-verified" : turn.speaker?.method === "declared" ? "typed" : "speaker not verified";
  // "daemon_": the capture pipeline already uses "agent_" record ids in this collection.
  const recordId = `daemon_${turn._id}`;
  // Title from the first sentence that states something, not "Can you please check?".
  const sentences = text.split(/(?<=[.!?])\s+/);
  const firstSentence = sentences.find(s => !QUESTION_OPENING.test(s) && s.trim().split(/\s+/).length >= 3) ?? sentences[0];
  const content = {                                   // field order matches life-records.js
    kind,
    personId: null,
    title: `${kind === "preference" ? "Reported preference" : "Reported"}: ${firstSentence}`.slice(0, 200),
    originalText: `User report (agent conversation, ${verified}); not confirmed by a caregiver: ${text}`.slice(0, 4000),
    sourceType: "user_report",
    photoRef: null,
    contact: null
  };
  return {
    _id: sha256("personal_records", scope, recordId), ...scope, recordId, ...content,
    digest: sha256(content), reviewStatus: "draft", recordedAt: now
  };
}
