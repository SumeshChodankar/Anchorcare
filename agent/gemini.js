// The cognition stage: structured reasoning over retrieved memory.
//
// Returns a CareResponse, the exact shape caregiver/models.py already defines, so the
// Python and Node sides agree on what a model answer is. Routing for every field is
// in docs/GEMINI-WRITE-ROUTING.md §2.
//
// The model is given ONLY approved, source-backed material and told to answer from it
// or say it cannot. It is not given its own past output — that is the confabulation
// loop the whole schema is built to prevent.

const ACTION_TYPES = [
  "flag_memory_conflict", "log_patient_mood_report", "show_orientation_card",
  "alert_caregiver_loop_detected", "create_reminder", "draft_family_message",
  "mark_routine_completed", "change_medication_dose", "unlock_door",
  "contact_emergency_services"
];

/** Mirrors CareResponse in caregiver/models.py, extended with wandering & distress detection. */
const CARE_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    answer: { type: "string" },
    evidence_ids: { type: "array", items: { type: "string" } },
    epistemic_basis: { type: "string", enum: ["observed", "reported", "inferred", "insufficient_evidence"] },
    has_conflicting_evidence: { type: "boolean" },
    uncertainty: { type: "string" },
    escalation_required: { type: "boolean" },
    wandering_detected: { type: "boolean" },
    inferred_triples: {
      type: "array",
      items: {
        type: "object",
        properties: {
          subject: { type: "string" },
          predicate: { type: "string" },
          object: { type: "string" }
        },
        required: ["subject", "predicate", "object"]
      }
    },
    proposed_action: {
      type: "object",
      nullable: true,
      properties: {
        action_type: { type: "string", enum: ACTION_TYPES },
        summary: { type: "string" },
        target_person_id: { type: "string" },
        supporting_evidence_ids: { type: "array", items: { type: "string" } }
      },
      required: ["action_type", "summary", "target_person_id"]
    }
  },
  required: ["answer", "evidence_ids", "epistemic_basis", "has_conflicting_evidence", "uncertainty"]
};

const SYSTEM = `You are the memory of a person living with dementia, speaking to her.

ABSOLUTE RULES
1. Answer ONLY from the numbered evidence given. If the evidence does not contain the
   answer, set epistemic_basis to "insufficient_evidence" and say plainly that you do
   not know. Never fill a gap with something plausible.
2. evidence_ids must contain ONLY ids from the evidence block, exactly as written.
   An answer with no evidence_ids must have epistemic_basis "insufficient_evidence".
3. If you are reasoning beyond what the evidence states, set epistemic_basis to
   "inferred" and keep the answer tentative. Do not present an inference as a fact.
4. If two pieces of evidence disagree, set has_conflicting_evidence true and say both
   accounts exist. Never pick one and never merge them.
5. Never state or imply a diagnosis, a prognosis, a medication dose, or a change to
   any treatment.
6. If a SCRIPT is supplied for a topic, reproduce it word for word as your whole
   answer and propose no action.
7. If LOCATION / GEOFENCE STATUS indicates she is outside the safe zone and she expresses confusion,
   asks where her house is, or appears distressed/lost:
   - Set wandering_detected: true and escalation_required: true.
   - Set epistemic_basis: "inferred".
   - Answer with warm, immediate reassurance (e.g. telling her Jane is notified and to stay safe).
   - In inferred_triples, extract: [{"subject": "Patient", "predicate": "State", "object": "Disoriented"}, {"subject": "Patient", "predicate": "Location", "object": "Outside Safe Zone"}].
8. If she or the user asks to "call Margaret", "call caregiver", or contact someone for help:
   - Set escalation_required: true.
   - Set epistemic_basis: "inferred".
   - Answer with warm, direct reassurance that Margaret is being called right now anonymously via the automated care system, and that she is safe.
   - In inferred_triples, extract: [{"subject": "Margaret", "predicate": "ContactStatus", "object": "CallInitiated"}].

HOW TO SPEAK
Short sentences. One idea each. Warm, unhurried, never testing her. Use names, not
pronouns, when naming people. Say when something happened in plain words
("on Thursday", "this morning"), not as a date.
Never say "you told me", "as I said", "remember", or "you forgot".`;

export function createReasoner(cfg) {
  let client = null;

  return async function reason({ utterance, evidence, identity, script, recent, locationContext }, signal) {
    if (!client) {
      const { GoogleGenAI } = await import("@google/genai");
      client = new GoogleGenAI({ apiKey: cfg.geminiKey });
    }

    const locationBlock = locationContext
      ? `LOCATION / GEOFENCE STATUS\n${locationContext.status_description || locationContext.state || JSON.stringify(locationContext)}`
      : "";

    const evidenceBlock = evidence.length
      ? evidence.map((item, i) =>
          `[E${i + 1}] id=${item.id}\n` +
          `     when: ${item.when}\n` +
          `     what: ${item.text}` +
          (item.people?.length ? `\n     people: ${item.people.join(", ")}` : "")
        ).join("\n\n")
      : "(no approved, source-backed memory matched this question)";

    const identityBlock = identity ? [
      `preferred name: ${identity.preferredName ?? "unknown"}`,
      identity.communication?.maxSentenceWords
        ? `keep sentences under ${identity.communication.maxSentenceWords} words` : null,
      identity.anchorPeople?.length
        ? `people who orient her: ${identity.anchorPeople.map(p => p.relationship ?? p.nodeId).join(", ")}` : null,
      identity.distressTopics?.length
        ? `NEVER raise: ${identity.distressTopics.map(t => t.label).join("; ")}` : null,
      identity.comfortTopics?.length
        ? `safe topics to turn to: ${identity.comfortTopics.map(t => t.label).join("; ")}` : null
    ].filter(Boolean).join("\n") : "(no identity record)";

    const recentBlock = recent?.length
      ? recent.map(t => `she said: "${t.text}"`).join("\n")
      : "(start of the conversation)";

    const prompt = [
      locationBlock,
      `ABOUT HER\n${identityBlock}`,
      `\nWHAT SHE HAS SAID RECENTLY (her words only)\n${recentBlock}`,
      `\nEVIDENCE — approved, source-backed memory\n${evidenceBlock}`,
      script ? `\nSCRIPT — reproduce this exactly as your whole answer:\n"${script}"` : "",
      `\nSHE JUST SAID\n"${utterance}"`,
      `\nAnswer her.`
    ].filter(Boolean).join("\n");

    const response = await client.models.generateContent({
      model: cfg.geminiModel,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: {
        systemInstruction: SYSTEM,
        temperature: cfg.temperature,
        responseMimeType: "application/json",
        responseSchema: CARE_RESPONSE_SCHEMA,
        abortSignal: signal
      }
    });

    const text = response.text ?? response.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("Model returned no content");

    let care;
    try { care = JSON.parse(text); }
    catch { throw new Error(`Model returned unparseable JSON: ${String(text).slice(0, 200)}`); }

    return validate(care, evidence, {
      name: cfg.geminiModel,
      version: response.modelVersion ?? null,
      promptDigest: null,
      temperature: cfg.temperature,
      tokensIn: response.usageMetadata?.promptTokenCount ?? 0,
      tokensOut: response.usageMetadata?.candidatesTokenCount ?? 0
    });
  };
}

/**
 * The model's own claims are checked before anything is written. A hallucinated
 * evidence id is dropped rather than stored, because a citation that points nowhere
 * is worse than no citation: it looks like grounding.
 */
export function validate(care, evidence, model) {
  const known = new Set(evidence.map(e => e.id));
  const alias = new Map(evidence.map((e, i) => [`E${i + 1}`, e.id]));

  const cited = [];
  const hallucinated = [];
  for (const raw of care.evidence_ids ?? []) {
    const id = alias.get(String(raw).trim()) ?? String(raw).trim();
    if (known.has(id)) { if (!cited.includes(id)) cited.push(id); }
    else hallucinated.push(raw);
  }

  let basis = care.epistemic_basis;
  if (!cited.length && basis !== "insufficient_evidence") {
    // It claimed grounding it does not have. Downgrade rather than trust it.
    basis = "insufficient_evidence";
  }

  const action = care.proposed_action && ACTION_TYPES.includes(care.proposed_action.action_type)
    ? care.proposed_action : null;

  return {
    answer: String(care.answer ?? "").slice(0, 8000),
    evidenceIds: cited,
    epistemicBasis: basis,
    hasConflictingEvidence: Boolean(care.has_conflicting_evidence),
    uncertainty: String(care.uncertainty ?? "").slice(0, 2000),
    proposedAction: action,
    hallucinatedIds: hallucinated,
    downgraded: basis !== care.epistemic_basis,
    escalationRequired: Boolean(care.escalation_required || care.escalationRequired),
    wanderingDetected: Boolean(care.wandering_detected || care.wanderingDetected),
    inferredTriples: Array.isArray(care.inferred_triples) ? care.inferred_triples : (Array.isArray(care.inferredTriples) ? care.inferredTriples : []),
    model
  };
}

export { ACTION_TYPES, CARE_RESPONSE_SCHEMA };
