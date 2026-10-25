// One turn, end to end. The fixed cycle from ATLAS-MEMORY-SCHEMA.md §12, with the
// write routing from GEMINI-WRITE-ROUTING.md §§1–4.
//
//   0  safety precheck        can end the turn by itself
//   1  working context        her recent words only, never the agent's
//   2  retrieval              $rankFusion over approved, source-backed episodes
//   3  canonical re-check     candidates are not answers
//   4  disclosure resolution  constraint ▸ script ▸ lifeStatus ▸ plain
//   5  cognition              gemini-4-argon → CareResponse
//   6  routing                every field to exactly one collection
//
// The patient turn is written BEFORE this runs (daemon.js), so a crash here loses the
// answer, never her words.

import {
  episodicRecallPipeline, groundCandidates, rankForAnswer,
  resolveDisclosure, constraintCovers, activeConstraintsFilter,
  recentTurnsQuery, assertNotSelfCitation
} from "../db/retrieval.js";
// buildCompanionTurn, not recordCompanionTurn: the recorder writes through
// `store.db` directly, which would bypass the guard in agent/store.js. Building the
// document here and inserting it through safeInsert keeps every generated write on
// the guarded path.
import {
  buildCompanionTurn, buildInference, inferenceUpsert, buildAlert,
  severityTier, deterministicId, sha256
} from "../db/ingest.js";
import * as callService from "./call-service.js";
import { loadLifeMemory, lifeEvidence, patientNameFrom, draftPersonalRecord, hasStatement } from "./life-memory.js";

/** Mirrors ACTION_POLICY_MAP in caregiver/policy.py. */
export const ACTION_POLICY = Object.freeze({
  flag_memory_conflict: "auto_execute",
  log_patient_mood_report: "auto_execute",
  show_orientation_card: "auto_execute",
  alert_caregiver_loop_detected: "auto_execute",
  create_reminder: "require_approval",
  draft_family_message: "require_approval",
  mark_routine_completed: "require_approval",
  change_medication_dose: "prohibited",
  unlock_door: "prohibited",
  contact_emergency_services: "prohibited"
});
export const evaluatePolicy = type => ACTION_POLICY[type] ?? "prohibited";

/**
 * True only when the geofence positively reports her outside the safe zone. A reported
 * state wins: the page has already allowed for the fix's accuracy, which a raw
 * distance cannot. Distance decides only when no state was reported.
 */
export function outsideSafeZone(location) {
  if (!location) return false;
  if (["left_safe_zone", "outside_safe_zone"].includes(location.state)) return true;
  if (location.state) return false;
  return Number(location.distanceFromHomeMeters) > 50;
}

export const ALERT_HEADLINE = Object.freeze({
  prohibited_action: "Prohibited action refused",
  phone_call_dispatched: "Voice call triggered",
  distress_call: "Distress: asked for help, care team called",
  wandering_distress: "Wandering / distress outside the safe zone",
  call_requested: "Call for help requested",
  loop_detected: "Repetitive questioning loop"
});

const isCallTriple = t => t?.predicate === "ContactStatus" && t?.object === "CallInitiated";
const isWanderingTriple = t => t?.subject === "Patient" && ["State", "Location"].includes(t?.predicate);

/**
 * Whether this turn raises an urgent alert. A deterministic call request or a loop
 * report always does. The model's wandering/escalation flag does only when the
 * geofence agrees she is outside, or when it marks a call request (prompt rule 8).
 * Anything else the model flagged is vetoed.
 */
export function escalationDecision(care, location, isCallRequest = false, distress = false) {
  const loop = care.proposedAction?.action_type === "alert_caregiver_loop_detected";
  const flagged = Boolean(care.wanderingDetected || care.escalationRequired);
  const modelCall = Boolean(care.escalationRequired && (care.inferredTriples ?? []).some(isCallTriple));
  const wandering = flagged && outsideSafeZone(location);
  const reason = isCallRequest ? "phone_call_dispatched"
    : distress ? "distress_call"
    : wandering ? "wandering_distress"
    : modelCall ? "call_requested"
    : loop ? "loop_detected"
    : null;
  return { alert: reason !== null, reason, wandering,
           vetoed: flagged && !wandering && !modelCall && !isCallRequest && !distress };
}

/** Strips a vetoed wandering claim so neither the UI nor the inference store repeats it. */
export function withoutWanderingClaims(care) {
  return {
    ...care,
    wanderingDetected: false,
    escalationRequired: false,
    inferredTriples: (care.inferredTriples ?? []).filter(t => !isWanderingTriple(t))
  };
}

const DEFER = "Let me check that with Jane and come back to you.";
// Said when the model is unreachable. Not "nothing written down": that would be a
// claim about her memory the system has not checked.
const UNAVAILABLE = "I'm having trouble checking my notes just now. Let's ask Jane.";

// ── grounded fast path ─────────────────────────────────────────────────────
// A plain recall question whose answer is one approved record does not need a model
// to restate it: reading the record back is faster and cannot embellish it. Anything
// that is a request, a safety signal, or ambiguous goes to the model as before.
const RECALL_OPENER = /^\s*(where|what|when|who|which|did|do|does|have|has|had|was|were|is|are)\b/i;
const NOT_RECALL = /\b(call|phone|ring|dial|change|double|increase|decrease|reduce|stop|dose|lost|hurt|pain|fell|fallen|scared|afraid|frightened|help|emergency|house|home|where am i)\b/i;
const NOT_CONTENT = new Set([
  "where", "what", "when", "which", "whom", "whose", "have", "does", "were", "there", "their",
  "about", "this", "that", "with", "from", "your", "mine", "they", "them", "been", "into",
  "just", "then", "than", "some", "will", "would", "could", "should", "today", "yesterday",
  "morning", "afternoon", "evening", "last", "week", "time", "thing", "things", "please",
  "tell", "know", "remember", "going", "went", "doing", "done",
  // three-letter words carry meaning too ("tea", "Lee"), so the common ones are listed
  "the", "and", "you", "did", "who", "how", "why", "are", "was", "can", "get", "got", "for",
  "not", "any", "has", "had", "her", "his", "him", "she", "its", "our", "out", "now", "put",
  "see", "say", "way", "let", "all", "too", "yet", "may", "one", "use", "ask", "like", "want",
  // time words say when, not what: "next" must not match "Riya is next to me"
  "next", "upcoming", "tomorrow", "soon", "later", "right", "really", "actually", "still"
]);

// "Can you tell me which appointment I have?" is the question "which appointment I have?".
const POLITE = /^\s*(?:(?:hey|ok(?:ay)?|so|um+|uh+|right)[,\s]+)*(?:(?:can|could|would|will) you(?: please)?(?: just)?\s+(?:tell me|let me know|check|remind me(?: of)?|say)[,\s]*(?:please[,\s]*)?|do you know[,\s]+|please[,\s]+)?(?:(?:at|in|on|for|about)\s+(?=(?:which|what|when|where|who)\b))?/i;
export const asQuestion = text => String(text ?? "").replace(POLITE, "");

const contentWords = text => [...new Set(words(text).filter(w => w.length >= 3 && !NOT_CONTENT.has(w)))];

/** How many of a question's content words a text contains. */
export const recallHits = (question, text) => {
  const said = words(text);
  return contentWords(question).filter(a => said.some(w => sameWord(a, w))).length;
};
// "visit" finds "visited"; "glasses" does not find "glass".
const sameWord = (asked, written) => written === asked || (written.startsWith(asked) && written.length - asked.length <= 3);

/** The one approved record a plain recall question is about, or null. */
export function fastRecall(question, ranked) {
  const utterance = asQuestion(question);
  if (!RECALL_OPENER.test(utterance) || NOT_RECALL.test(utterance)) return null;
  const asked = contentWords(utterance);
  if (!asked.length) return null;
  let best = null, bestHits = 0;
  for (const item of ranked) {                       // ranked order breaks ties
    const written = words(item.doc.summary ?? item.doc.searchText ?? "");
    const hits = asked.filter(a => written.some(w => sameWord(a, w))).length;
    if (hits > bestHits) { best = item; bestHits = hits; }
  }
  return best;
}

const spokenSummary = text => {
  const plain = String(text).replace(/^\s*FICTIONAL DEMO\s*[—–-]\s*/i, "").trim();
  return /[.!?]$/.test(plain) ? plain : `${plain}.`;
};

function whenSaid(eventStart, now, timezone) {
  if (!eventStart) return null;
  const at = new Date(eventStart);
  const day = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, year: "numeric", month: "numeric", day: "numeric" });
  if (day.format(at) === day.format(now)) return "today";
  if (now - at < 6 * 86_400_000) return new Intl.DateTimeFormat("en-GB", { timeZone: timezone, weekday: "long" }).format(at);
  return new Intl.DateTimeFormat("en-GB", { timeZone: timezone, day: "numeric", month: "long" }).format(at);
}

const answerOnly = (answer, model, extra = {}) => ({
  answer, evidenceIds: [], epistemicBasis: "insufficient_evidence", hasConflictingEvidence: false,
  uncertainty: "", proposedAction: null, hallucinatedIds: [], downgraded: false,
  escalationRequired: false, wanderingDetected: false, inferredTriples: [],
  model: { name: model, version: null, promptDigest: null, temperature: null, tokensIn: 0, tokensOut: 0 },
  ...extra
});

// ── the rest of Engram: people, personal records, daily logs, plans ─────────
// Ties go to the most authoritative kind: a person card, then a caregiver's record,
// then a daily log, then her own approved report.
const LIFE_PRIORITY = { people: 0, semantic_edges: 1, personal_records: 2, daily_logs: 3 };

/** The approved life-memory item a plain recall question is about: { item, hits } or null. */
export function lifeRecall(asked, items) {
  const question = asQuestion(asked);
  if (!RECALL_OPENER.test(question) || NOT_RECALL.test(question)) return null;
  let best = null;
  for (const item of items) {
    if (item.plan) continue;                         // plans are answered by planAnswer
    const hits = recallHits(question, item.text);
    if (!hits) continue;
    // within personal records, a caregiver's report outranks her own approved report
    const rank = (LIFE_PRIORITY[item.collection] ?? 9) + (item.sourceType === "user_report" ? 0.5 : 0);
    if (!best || hits > best.hits || (hits === best.hits && rank < best.rank)) best = { item, hits, rank };
  }
  return best && { item: best.item, hits: best.hits };
}

const ASKS_WHO = /^\s*who\b/i;
const ASKS_PREFERENCE = /\b(like|likes|prefer|prefers|enjoy|enjoys|love|loves|favou?rite)\b/i;
// "When is my next visit?" asks about the future; a past record matching "visit" is not
// its answer, however well the words line up.
export const asksAboutFuture = text => /\b(next|upcoming|tomorrow|coming up|will|scheduled|going to)\b/i.test(text);

/** On an equal word match, does this life item fit the question better than an episode? */
export function lifeFitsBetter(question, item) {
  if (ASKS_WHO.test(question)) return item.collection === "people" || item.collection === "semantic_edges";
  if (ASKS_PREFERENCE.test(question)) {
    return item.collection === "personal_records"
      && (item.kind === "preference" || /\b(prefer|prefers|likes?|enjoys?|loves?|favou?rite|preference)\b/i.test(item.text));
  }
  return false;
}

/** A life-memory item read back, citing itself. */
export function lifeCare(item) {
  // Records and logs are read from their note, not their internal label ("Night's sleep (sleep, …):").
  const text = spokenSummary(["personal_records", "daily_logs"].includes(item.collection)
    ? item.text.replace(/^[^:]{1,80}:\s*/, "") : item.text);
  const answer = item.collection === "people" || item.collection === "semantic_edges" ? text
    : item.collection === "daily_logs" ? `Your notes from ${item.when} say: ${text}`
    : item.sourceType === "user_report" ? `You told your care team: "${text}"`
    : `Your notes say: ${text}`;
  return answerOnly(answer, "grounded-recall", { evidenceIds: [item.id], epistemicBasis: "reported" });
}

const ASKS_PLAN = /\b(appointment|visit|visiting|coming (?:to see|over|round)|plans?|scheduled|what(?:'s| is) next|next)\b/i;

/** "When is my appointment?" from an approved upcoming plan, or null when none exists. */
export function planAnswer(asked, items) {
  const question = asQuestion(asked);
  if (!QUESTION_OPENER.test(question) || !ASKS_PLAN.test(question)) return null;
  const next = items.filter(i => i.plan).sort((a, b) => +new Date(a.at) - +new Date(b.at))[0];
  if (!next) return null;
  return answerOnly(`${next.text.replace(/\.$/, "")} is on ${next.when}.`.replace(/^Planned/, "Your planned"),
    "grounded-plan", { evidenceIds: [next.id], epistemicBasis: "reported" });
}

/** The record, read back verbatim, citing itself. */
export function groundedCare(match, now, timezone) {
  const when = whenSaid(match.doc.eventStart, now, timezone);
  const said = spokenSummary(match.doc.summary ?? match.doc.searchText ?? "");
  return answerOnly(when ? `Your notes from ${when} say: ${said}` : `Your notes say: ${said}`,
    "grounded-recall", { evidenceIds: [match.doc._id], epistemicBasis: "reported" });
}

// A request to change a dose is always declined (CHANGE_MEDICATION_DOSE is
// prohibited), so it gets the same fixed reply at once rather than a model's
// rewording of it several seconds later.
const DOSE_WORD = String.raw`\b(dose|doses|dosage|medication|medications|medicine|medicines|pills?|tablets?)\b`;
const CHANGE_WORD = String.raw`\b(double|increase|decrease|reduce|change|halve|skip|stop|extra|more|less)\b`;
const MEDICATION_CHANGE = new RegExp(`${CHANGE_WORD}.*${DOSE_WORD}|${DOSE_WORD}.*${CHANGE_WORD}`, "i");
export const isMedicationChange = text => MEDICATION_CHANGE.test(text);
const MEDICATION_REPLY = "I can't change your medicine. Please check with Jane or your doctor before taking anything different.";

// ── orientation: name, time, day, place ────────────────────────────────────
// Answered from the system's own facts (identity record, clock, geofence), never from
// a model's guess. "Your name appears to be Alex, as the notes are about Alex" is a
// confabulation; with no identity record the honest answer is that it is not written down.
const ASKS_NAME = /\b(what(?:'s| is) my name|what my name is|who am i\b|do you know (?:my name|who i am)|tell me my name|my name\?)/i;
const ASKS_TIME = /\b(what(?:'s| is) the time|what time is it|the time now|time is it)\b/i;
const ASKS_DAY = /\b(what (?:day|date) is it|what(?:'s| is) (?:the )?(?:day|date)(?: today)?|today'?s date|which day is it)\b/i;
const ASKS_PLACE = /\b(where am i\b(?! going)|(?:know|tell me|sure) where i am|my (?:exact |current )?location|am i (?:at )?home|where is this|where are we|where do i live)\b/i;

/** True when the speaker is someone we may tell personal details to. */
const verifiedForPersonal = speaker => !speaker || speaker.method !== "diarization" || speaker.verified === true;

/**
 * Deterministic answers to orientation questions, or null. A question asking two of
 * them ("what's the time, and what's my name?") gets both. `wandering` is set when
 * she asks where she is while the geofence has her outside, so routing escalates.
 */
export function orientationAnswer(text, { identity, location, now, timezone, speaker } = {}) {
  const parts = [];
  let wandering = false;
  if (ASKS_NAME.test(text)) {
    if (!verifiedForPersonal(speaker)) {
      parts.push("I can't tell who is speaking yet, so I won't share personal details. Once your voice is set up, I can.");
    } else if (identity?.preferredName) {
      parts.push(`Your name is ${identity.preferredName}.`);
    } else {
      parts.push("I don't have your name written down yet. Your care team can add it for me.");
    }
  }
  if (ASKS_TIME.test(text)) {
    parts.push(`It's ${new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "numeric", minute: "2-digit", hour12: true }).format(now)}.`);
  }
  if (ASKS_DAY.test(text)) {
    parts.push(`Today is ${new Intl.DateTimeFormat("en-GB", { timeZone: timezone, weekday: "long", day: "numeric", month: "long" }).format(now)}.`);
  }
  if (ASKS_PLACE.test(text)) {
    if (!location || !location.state) {
      parts.push("I can't tell where you are right now.");
    } else if (!outsideSafeZone(location)) {
      parts.push(location.placeName ? `You're at home, near ${location.placeName}.` : "You're at home.");
    } else {
      wandering = true;
      const miles = Number(location.distanceFromHomeMeters) / 1609.34;
      const far = miles < 0.1 ? "just outside your home" : `about ${miles.toFixed(1)} miles from home`;
      parts.push(`You're ${far}${location.placeName ? `, near ${location.placeName}` : ""}. Please stay where you are; I've let your care team know.`);
    }
  }
  return parts.length ? { answer: parts.join(" "), wandering } : null;
}

// ── her own earlier words ──────────────────────────────────────────────────
// What she says is stored as observed speech but is not an approved fact. It can
// still be repeated back to her, attributed and dated, and marked as not yet
// confirmed: "earlier today at 3:05 pm you told me …". That is a quotation, not a
// claim, so it cannot become a false memory the way an unmarked restatement could.
const QUESTION_OPENER = /^\s*(where|what|when|who|which|why|how|did|do|does|is|are|was|were|can|could|will|would)\b/i;

/** Her most relevant earlier statement for a recall question, or null. */
export function herWordsRecall(rawQuestion, utterances, currentTurnId = null) {
  const question = asQuestion(rawQuestion);
  if (!RECALL_OPENER.test(question) || NOT_RECALL.test(question)) return null;
  const asked = contentWords(question);
  if (!asked.length) return null;
  let best = null, bestHits = 0;
  for (const u of utterances) {                      // newest first: ties go to the latest
    if (u._id === currentTurnId || !hasStatement(u.text)) continue;
    const said = words(u.text);
    const hits = asked.filter(a => said.some(w => sameWord(a, w))).length;
    if (hits > bestHits) { best = u; bestHits = hits; }
  }
  return best;
}

function whenSpoken(at, now, timezone) {
  const day = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, year: "numeric", month: "numeric", day: "numeric" });
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "numeric", minute: "2-digit", hour12: true }).format(at);
  if (day.format(at) === day.format(now)) return `earlier today at ${time}`;
  if (day.format(at) === day.format(new Date(+now - 86_400_000))) return `yesterday at ${time}`;
  return `on ${new Intl.DateTimeFormat("en-GB", { timeZone: timezone, weekday: "long", day: "numeric", month: "long" }).format(at)}`;
}

/** Her words read back, attributed, dated, and marked unconfirmed. */
export function herWordsCare(utterance, now, timezone) {
  return answerOnly(
    `${whenSpoken(new Date(utterance.startedAt), now, timezone).replace(/^./, c => c.toUpperCase())} you told me: "${utterance.text.trim()}" Your care team hasn't confirmed that yet.`,
    "her-own-words", { patientWordIds: [utterance._id], epistemicBasis: "reported" });
}

// ── requests to book or schedule ───────────────────────────────────────────
// CREATE_REMINDER needs a caregiver's approval, so the agent queues it for them and
// says so, rather than claiming it booked anything.
// Either order: "book a doctor's appointment" and "I have an appointment, can you book it?"
const BOOK_VERB = String.raw`\b(book|schedule|arrange|set(?: up)?|make|add)\b`;   // "set a reminder", "add it"
const BOOK_NOUN = String.raw`\b(appointment|visit|reminder|doctor|gp|dentist|meeting|check-?up)\b`;
const BOOKING = new RegExp(`${BOOK_VERB}.*${BOOK_NOUN}|${BOOK_NOUN}.*${BOOK_VERB}|\\bremind me\\b`, "i");
export const isBookingRequest = text => BOOKING.test(text) && !isMedicationChange(text);
const BOOKING_REPLY = "I've asked your care team to book that for you. I'll remember you told me about it.";

// Spoken distress: the care team is called, not just alerted. Deliberately specific
// ("I lost my glasses" is not distress; "I'm lost" is), and checked in code so a
// model's mood on the day cannot decide whether a frightened person gets a call.
const DISTRESS = [
  /\b(help me|please help|i need help|somebody help|someone help|get help)\b/i,
  /^\W*help\W*$/i,
  /\bi(?:'m| am) (?:so |very |really )?(?:scared|frightened|afraid|terrified|lost|hurt|in pain)\b/i,
  /\bi(?:'ve| have)? (?:fallen|fell)\b/i,
  /\bcan(?:'t|not) (?:breathe|get up|move)\b/i,
  /\b(chest pain|emergency)\b/i
];
export const isDistress = text => DISTRESS.some(re => re.test(String(text)));

/** Reasons that place a phone call to the care team, as well as alerting them. */
export const CALLS_CARE_TEAM = Object.freeze(["phone_call_dispatched", "distress_call", "wandering_distress"]);

/**
 * What to tell her after a call or distress, matching what the system actually did:
 * only a live, configured call that was really placed is described as a call.
 */
export function callReply(reason, status, { placed = true } = {}) {
  const live = Boolean(placed && status?.twilioConfigured && status?.liveAllowed && status?.targetPhoneNumber);
  if (reason === "distress_call") {
    return live ? "I'm here with you. I'm calling your care team now." : "I'm here with you. I've alerted your care team.";
  }
  if (reason === "phone_call_dispatched" && live) return "I'm making that call for you now.";
  return "I've let your care team know you'd like to speak to someone.";
}

const words = text => String(text).toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];

export function createPipeline(ctx) {
  const { cfg, store, reason, log = () => {} } = ctx;
  const scope = { householdId: cfg.householdId, subjectId: cfg.subjectId };
  const db = store.db;

  let constraintCache = { at: 0, value: [] };

  async function constraints(now) {
    if (now - constraintCache.at < 60_000) return constraintCache.value;
    const value = await db.collection("safety_constraints")
      .find(activeConstraintsFilter(scope, new Date(now))).toArray();
    constraintCache = { at: now, value };
    return value;
  }

  /** Lets a caregiver's change reach a live conversation without waiting for a cache. */
  function invalidateConstraints() { constraintCache = { at: 0, value: [] }; }

  async function run(turn, locationContext = null) {
    const started = Date.now();
    const now = new Date();
    const active = await constraints(started);
    const trace = { retrievalMs: 0, generationMs: 0 };

    // ── 0. safety precheck ────────────────────────────────────────────────
    const veto = active.find(c =>
      c.severity === "absolute" && constraintCovers(c, { text: turn.text }));
    if (veto) {
      log("veto", `${veto._id} — answering from its script`);
      return emit(turn, {
        answer: veto.rule?.responseScript || DEFER,
        evidenceIds: [], epistemicBasis: "insufficient_evidence",
        hasConflictingEvidence: false, uncertainty: "Blocked by a safety constraint.",
        proposedAction: null, hallucinatedIds: [], downgraded: false,
        escalationRequired: false, wanderingDetected: false, inferredTriples: [],
        model: { name: "scripted", version: "constraint_response", promptDigest: null,
                 temperature: null, tokensIn: 0, tokensOut: 0 }
      }, {
        groundedOn: [
          { store: "safety", collection: "safety_constraints", id: veto._id, role: "veto" },
          { store: "safety", collection: "safety_constraints", id: veto._id, role: "script" }
        ],
        disclosure: { policy: "redirect", nodeId: null, scriptUsed: true, constraintIds: [veto._id] },
        precheck: "veto", vetoConstraintId: veto._id,
        locationContext,
        latency: { ...trace, firstTokenMs: Date.now() - started, totalMs: Date.now() - started }
      }, now);
    }

    // ── 1–3. working context, retrieval + canonical re-check, identity ─────
    // Independent reads, so they run together rather than one round trip each.
    const recentQuery = recentTurnsQuery(scope, turn.sessionId, { limit: 6 });
    const t0 = Date.now();
    const [recentRows, ranked, identity, herWords, life] = await Promise.all([
      // working context: HER words only (patient_utterances view)
      db.collection(recentQuery.collection)
        .find(recentQuery.filter).sort(recentQuery.sort).limit(recentQuery.limit).toArray(),
      (async () => {
        try {
          const candidates = await db.collection("episodes")
            .aggregate(episodicRecallPipeline(cfg, scope, turn.text, {}), { maxTimeMS: 20000 })
            .toArray();
          const grounded = await groundCandidates(db, scope, candidates);
          return rankForAnswer(grounded, now).slice(0, 5);
        } catch (error) {
          log("retrieval-failed", error.message);
          return [];
        }
      })(),
      db.collection("identity_core").findOne({ _id: cfg.subjectId }),
      // her own earlier words, from the patient-only view: two weeks, newest first
      db.collection("patient_utterances")
        .find({ ...scope, startedAt: { $gte: new Date(+now - 14 * 86_400_000) } })
        .sort({ startedAt: -1 }).limit(300).toArray().catch(() => []),
      // the rest of Engram: approved people, personal records, daily logs, plans, graph
      loadLifeMemory(db, scope, now)
    ]);
    trace.retrievalMs = Date.now() - t0;
    const recent = recentRows.filter(t => t.seq < turn.seq).reverse();
    const lifeItems = lifeEvidence(life, cfg.timezone);
    // identity_core is the designed home for her name; an approved identity record in
    // personal_records is the fallback, since that is where the capture pipeline puts it.
    const knownIdentity = identity?.preferredName ? identity
      : { ...(identity ?? {}), preferredName: patientNameFrom(life) };

    // ── 4. disclosure ─────────────────────────────────────────────────────
    const nodeIds = [...new Set(ranked.flatMap(g => g.doc.semanticRefs ?? []))];
    const nodes = nodeIds.length
      ? await db.collection("semantic_nodes").find({
          ...scope, _id: { $in: nodeIds }, reviewStatus: "approved", isCurrent: true
        }).toArray()
      : [];

    // A question that names a grief-sensitive or non-current person is answered from
    // the caregiver's script, verbatim, and the model is not asked to compose.
    const mentioned = nodes.find(n =>
      (n.sensitivity && n.sensitivity !== "normal") || ["deceased", "former"].includes(n.lifeStatus));
    let script = null;
    if (mentioned) {
      const named = words(turn.text);
      const hit = [n => n.label, n => n.aliases].some(() =>
        named.some(w => w === String(mentioned.label).toLowerCase()
          || (mentioned.aliases ?? []).some(a => String(a).toLowerCase() === w)));
      if (hit) {
        const loss = (identity?.knownLosses ?? []).find(l => l.nodeId === mentioned._id);
        const resolved = resolveDisclosure(
          [{ nodeId: mentioned._id, node: mentioned, text: turn.text, sourceIds: mentioned.sourceIds }],
          identity ?? {}, active);
        if (resolved[0]?.mode === "script") script = resolved[0].text;
        else if (resolved[0]?.mode === "redirect") script = loss?.script ?? DEFER;
        else if (!resolved.length) script = DEFER;
      }
    }

    // ── 5. cognition ──────────────────────────────────────────────────────
    const evidence = [
      ...ranked.map(g => ({
        id: g.doc._id, collection: "episodes", store: "episodic",
        when: g.doc.eventStart ? new Date(g.doc.eventStart).toDateString() : "unknown",
        text: g.doc.summary ?? g.doc.searchText ?? "",
        people: (g.doc.semanticRefs ?? [])
          .map(id => nodes.find(n => n._id === id)?.label).filter(Boolean)
      })),
      // the life items most related to the question, then people and upcoming plans
      ...lifeItems
        .map(item => ({ item, hits: recallHits(turn.text, item.text) }))
        .filter(({ item, hits }) => hits > 0 || item.plan || item.collection === "people")
        .sort((a, b) => b.hits - a.hits).slice(0, 10).map(({ item }) => item)
    ];
    const evidenceHome = new Map(evidence.map(e => [e.id, e]));

    let care;
    const t1 = Date.now();
    // A question about the future is never answered by reading back a past record.
    const recallable = cfg.fastRecall && !script && !asksAboutFuture(turn.text);
    const quick = recallable ? fastRecall(turn.text, ranked) : null;
    const quickHits = quick ? recallHits(turn.text, quick.doc.summary ?? quick.doc.searchText ?? "") : 0;
    const lifeMatch = recallable ? lifeRecall(turn.text, lifeItems) : null;
    let orientation = null, ownWords = null, plan = null;
    if (script) {
      // The caregiver's words, verbatim: no model is asked to retype them.
      care = answerOnly(script, "disclosure-script");
    } else if (isDistress(turn.text)) {
      // Routing raises the alert, places the call and words the reply from what happened.
      care = answerOnly(callReply("distress_call", callService.getCallStatus()), "distress-script");
    } else if (isMedicationChange(turn.text)) {
      care = answerOnly(MEDICATION_REPLY, "safety-script");
      log("medication-change", "declined without a model call");
    } else if (callService.detectCallIntent(turn.text)) {
      // Routing raises the alert and words the reply from what the call service did.
      care = answerOnly(callReply("phone_call_dispatched", callService.getCallStatus()), "call-script");
    } else if ((orientation = orientationAnswer(turn.text,
                 { identity: knownIdentity, location: locationContext, now, timezone: cfg.timezone, speaker: turn.speaker }))) {
      // wanderingDetected lets routing escalate "where am I?" asked outside the safe zone.
      care = answerOnly(orientation.answer, "orientation", { wanderingDetected: orientation.wandering });
      log("orientation", orientation.answer.slice(0, 60));
    } else if (isBookingRequest(turn.text)) {
      care = answerOnly(BOOKING_REPLY, "booking-request", {
        proposedAction: { action_type: "create_reminder", summary: turn.text.slice(0, 400),
                          target_person_id: cfg.subjectId, supporting_evidence_ids: [] }
      });
    } else if (cfg.fastRecall && (plan = planAnswer(turn.text, lifeItems))) {
      care = plan;
      log("plan", care.evidenceIds[0]);
    } else if (lifeMatch && (lifeMatch.hits > quickHits
                || (lifeMatch.hits === quickHits && lifeFitsBetter(turn.text, lifeMatch.item)))) {
      care = lifeCare(lifeMatch.item);
      log("life-recall", `${lifeMatch.item.collection}/${lifeMatch.item.id}`);
    } else if (quick) {
      care = groundedCare(quick, now, cfg.timezone);
      log("fast-recall", quick.doc._id);
    } else if (cfg.fastRecall && (ownWords = herWordsRecall(turn.text, herWords, turn._id))) {
      care = herWordsCare(ownWords, now, cfg.timezone);
      log("her-words", ownWords._id);
    } else {
      try {
        care = await reason({ utterance: turn.text, evidence, identity: knownIdentity, script, recent, locationContext,
                              herWords: herWords.filter(u => u._id !== turn._id).slice(0, 12) });
      } catch (error) {
        log("cognition-failed", error.message);
        const fallback = fastRecall(turn.text, ranked);
        care = fallback
          ? groundedCare(fallback, now, cfg.timezone)
          : answerOnly(UNAVAILABLE, cfg.geminiModel, { uncertainty: `Model unavailable: ${error.message}` });
      }
    }
    trace.generationMs = Date.now() - t1;

    const groundedOn = [
      ...care.evidenceIds.map(id => ({ store: evidenceHome.get(id)?.store ?? "episodic",
                                       collection: evidenceHome.get(id)?.collection ?? "episodes", id, role: "evidence" })),
      // her own observed words, quoted back: citable as what she said, not as what is true
      ...(care.patientWordIds ?? []).map(id => ({ store: "episodic", collection: "conversation_turns", id, role: "evidence" })),
      ...nodes.map(n => ({ store: "semantic", collection: "semantic_nodes", id: n._id, role: "context" })),
      ...active.filter(c => c.severity === "absolute")
        .map(c => ({ store: "safety", collection: "safety_constraints", id: c._id, role: "filter" })),
      ...(script ? [{ store: "semantic", collection: "semantic_nodes", id: mentioned._id, role: "script" }] : [])
    ];
    assertNotSelfCitation(groundedOn);

    // Her statement goes to the caregiver review queue as a DRAFT personal record. After
    // the reply, and never allowed to fail the turn.
    const draft = turn.role === "patient" ? draftPersonalRecord(scope, turn, now) : null;
    if (draft) {
      store.safeInsert("personal_records", draft)
        .then(r => r.inserted && log("draft-record", `${draft.kind} "${draft.title.slice(0, 60)}" awaiting caregiver review`))
        .catch(error => log("draft-failed", error.message));
    }

    return emit(turn, care, {
      groundedOn,
      disclosure: script
        ? { policy: "defer_to_caregiver", nodeId: mentioned?._id ?? null, scriptUsed: true, constraintIds: [] }
        : { policy: "state_plainly", nodeId: null, scriptUsed: false, constraintIds: [] },
      precheck: "pass", vetoConstraintId: null,
      locationContext,
      latency: { ...trace, firstTokenMs: null, totalMs: Date.now() - started }
    }, now);
  }

  // ── 6. routing ──────────────────────────────────────────────────────────
  async function emit(turn, care, meta, now) {
    const alertIds = [];
    const alertReasons = [];               // parallel to alertIds, for the capture page

    // 6a. a prohibited action is vetoed and escalated; it is never carried out.
    if (care.proposedAction) {
      const policy = evaluatePolicy(care.proposedAction.action_type);
      if (policy === "prohibited") {
        const alert = buildAlert(scope, {
          alertType: "manual", severity: "urgent",
          triggerRefs: [{ store: "episodic", collection: "conversation_turns", id: turn._id }],
          evidenceSummary:
            `The assistant proposed a prohibited action (${care.proposedAction.action_type}) ` +
            `in response to: "${turn.text.slice(0, 200)}". It was refused and not carried out. ` +
            `Its stated reason: ${String(care.proposedAction.summary).slice(0, 400)}`
        }, now);
        await store.safeInsert("care_alerts", alert);
        await store.safeInsert("active_tasks", {
          _id: deterministicId("task", scope, alert.idempotencyKey), ...scope,
          sessionId: turn.sessionId, taskType: "escalate", status: "pending",
          riskTier: severityTier("urgent"), procedureId: null, procedureVersion: null,
          payload: { alertId: alert._id, refusedAction: care.proposedAction.action_type },
          dueAt: now, slaDeadlineAt: alert.slaDeadlineAt,
          blockedBy: [], leaseToken: null, leaseUntil: null, attempts: 0, createdAt: now
        });
        alertIds.push(alert._id);
        alertReasons.push(ALERT_HEADLINE.prohibited_action);
        ctx.onAlert?.({ alert, reason: "prohibited_action", headline: ALERT_HEADLINE.prohibited_action, turn,
                        locationContext: meta.locationContext ?? null });
        log("prohibited", `${care.proposedAction.action_type} refused and escalated`);
      } else if (policy === "require_approval") {
        await store.safeInsert("active_tasks", {
          _id: deterministicId("task", scope, turn._id, care.proposedAction.action_type), ...scope,
          sessionId: turn.sessionId, taskType: "await_caregiver_approval", status: "pending",
          riskTier: 2, procedureId: null, procedureVersion: null,
          payload: { action: care.proposedAction, turnId: turn._id },
          dueAt: now, slaDeadlineAt: new Date(+now + 4 * 3600_000),
          blockedBy: [], leaseToken: null, leaseUntil: null, attempts: 0, createdAt: now
          // no expiresAt: a tier-2 task must not be reaped by TTL
        });
        log("approval-needed", care.proposedAction.action_type);
      }
    }

    // 6a-1. wandering distress or explicit escalation required: immediate urgent alert.
    // The model's wandering flag is a claim, not a fact: the geofence decides.
    const isCallRequest = callService.detectCallIntent(turn.text);
    const decision = escalationDecision(care, meta.locationContext, isCallRequest, isDistress(turn.text));
    if (decision.vetoed) {
      log("wandering-vetoed", `model flagged escalation but geofence says inside or unknown: "${turn.text.slice(0, 60)}"`);
      care = withoutWanderingClaims(care);
    }
    // A call request, spoken distress, or wandering outside the safe zone rings the
    // care team (live only when Twilio is configured; otherwise simulated), at most once
    // per cooldown so repeated words do not become repeated calls.
    let callPlaced = false;
    if (CALLS_CARE_TEAM.includes(decision.reason)) {
      if (callService.callCooldownActive()) {
        log("call-skipped", "a call to the care team is already in progress or was placed in the last 5 minutes");
      } else {
        callPlaced = true;
        log("call-intent", `${decision.reason}: "${turn.text.slice(0, 80)}"`);
        if (ctx.onCall) ctx.onCall(turn, decision.reason);
        else callService.initiateCall({ reason: turn.text });
      }
    }
    if (decision.alert) {
      const alert = buildAlert(scope, {
        alertType: "manual", severity: "urgent",
        triggerRefs: [{ store: "episodic", collection: "conversation_turns", id: turn._id }],
        evidenceSummary:
          `${ALERT_HEADLINE[decision.reason]}: Patient voiced "${turn.text.slice(0, 200)}". ` +
          (callPlaced ? "Outbound anonymous call dispatched. " : "") +
          (meta.locationContext ? `Location: ${meta.locationContext.status_description || meta.locationContext.state}. ` : "") +
          `Assistant note: ${String(care.uncertainty || care.answer).slice(0, 300)}`
      }, now);
      await store.safeInsert("care_alerts", alert);
      await store.safeInsert("active_tasks", {
        _id: deterministicId("task", scope, alert.idempotencyKey), ...scope,
        sessionId: turn.sessionId, taskType: "escalate", status: "pending",
        riskTier: severityTier("urgent"), procedureId: null, procedureVersion: null,
        payload: { alertId: alert._id, reason: decision.reason, locationContext: meta.locationContext ?? null },
        dueAt: now, slaDeadlineAt: alert.slaDeadlineAt,
        blockedBy: [], leaseToken: null, leaseUntil: null, attempts: 0, createdAt: now
      });
      alertIds.push(alert._id);
      alertReasons.push(ALERT_HEADLINE[decision.reason]);
      log(`${decision.reason.replace(/_.*/, "")}-alert`, alert._id);
      ctx.onAlert?.({ alert, reason: decision.reason, headline: ALERT_HEADLINE[decision.reason], turn,
                      locationContext: meta.locationContext ?? null });
    }

    // A call reply states what the system did, never what the model imagined it did.
    if (["phone_call_dispatched", "call_requested", "distress_call"].includes(decision.reason)) {
      care = { ...care, answer: callReply(decision.reason, callService.getCallStatus(), { placed: callPlaced }) };
    } else if (decision.reason === "wandering_distress" && !/care team know/i.test(care.answer)) {
      // The model may not claim it told anyone; the system can, because it just did.
      care = { ...care, answer: `${care.answer.trim()} I've let your care team know where you are.` };
    }

    // 6b. the companion turn — generated, unciteable, model-attributed.
    // buildCompanionTurn throws on a missing model or a self-citation; safeInsert
    // then re-checks at write time. Two independent gates, deliberately.
    const companion = buildCompanionTurn(scope, {
      sessionId: turn.sessionId, seq: turn.seq + 1, text: care.answer,
      model: care.model, groundedOn: meta.groundedOn, disclosure: meta.disclosure,
      safetyPrecheck: meta.precheck, vetoConstraintId: meta.vetoConstraintId,
      alertIds, alertReasons, latency: meta.latency, inferenceIds: []
    }, now);
    await store.safeInsert("conversation_turns", companion);
    await store.safeUpdate("conversation_sessions",
      { _id: turn.sessionId, ...scope }, { $inc: { turnCount: 1 } });

    // 6c. inferences — stored, quarantined, never citable
    const inferences = [];
    if (care.inferredTriples?.length) {
      for (const t of care.inferredTriples) {
        inferences.push({
          inferenceType: "topic",
          claim: {
            subject: t.subject,
            predicate: t.predicate,
            object: t.object,
            triple: `${t.subject} -> ${t.predicate} -> ${t.object}`
          },
          confidence: null
        });
      }
    }
    if (care.epistemicBasis === "inferred") {
      inferences.push({
        inferenceType: "topic",
        claim: { answer: care.answer.slice(0, 500), basis: "inferred", turnId: turn._id },
        confidence: null
      });
    }
    if (care.uncertainty && care.epistemicBasis === "insufficient_evidence") {
      inferences.push({
        inferenceType: "retrieval_miss",
        claim: { question: turn.text.slice(0, 500), uncertainty: care.uncertainty.slice(0, 500) },
        confidence: null
      });
    }
    if (care.hallucinatedIds.length) {
      inferences.push({
        inferenceType: "retrieval_miss",
        claim: { kind: "fabricated_citation", ids: care.hallucinatedIds.slice(0, 10), turnId: turn._id },
        confidence: null
      });
      log("fabricated-citation", care.hallucinatedIds.join(", "));
    }

    const inferenceIds = [];
    for (const spec of inferences) {
      const built = buildInference(scope, {
        ...spec,
        basis: [{ store: "episodic", collection: "conversation_turns", id: turn._id }],
        sessionId: turn.sessionId, turnId: turn._id, model: care.model
      }, now);
      const upsert = inferenceUpsert(scope, {
        ...spec,
        basis: built.basis, sessionId: turn.sessionId, turnId: turn._id, model: care.model
      }, now);
      await store.safeUpdate("inferences", upsert.filter, upsert.update, upsert.options);
      inferenceIds.push(built._id);
    }
    if (inferenceIds.length) {
      await store.safeUpdate("conversation_turns",
        { _id: companion._id }, { $set: { inferenceIds } });
    }

    // 6d. a flagged conflict becomes a contradiction for a caregiver to look at
    if (care.hasConflictingEvidence && care.evidenceIds.length >= 2) {
      log("conflict", care.evidenceIds.slice(0, 2).join(" ↔ "));
    }

    // 6e. session counters
    await store.safeUpdate("conversation_sessions",
      { _id: turn.sessionId, ...scope },
      { $inc: {
          ...(meta.disclosure?.scriptUsed ? { "signals.scriptedDisclosures": 1 } : {}),
          ...(meta.precheck === "veto" ? { "signals.safetyVetoes": 1 } : {}),
          ...(alertIds.length ? { "signals.escalations": alertIds.length } : {}),
          ...(care.evidenceIds.length === 0 ? { "signals.retrievalFailures": 1 } : {})
        },
        $set: { lastTurnAt: now } });

    return { companion, care, alertIds, alertReasons, inferenceIds };
  }

  return { run, invalidateConstraints };
}
