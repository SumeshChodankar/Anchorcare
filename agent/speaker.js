// Who spoke, and therefore where their words may go.
//
// Only the patient's own words become `role: "patient"` turns: those are the only
// ones the companion reads back (the patient_utterances view), the only ones with a
// citable source, and the only ones the loop answers. A caregiver or a known
// visitor is recorded as `role: "caregiver"` for the record. An unidentified voice
// (a stranger, the television) is not recorded at all: a bystander has not
// consented to being transcribed into her memory.

/** Diarizer and console speaker types, mapped to a speaker kind. */
const KINDS = Object.freeze({
  primary_user: "patient",
  patient: "patient",
  caregiver: "caregiver",
  visitor: "visitor"
});

const UNIDENTIFIED = /^(others?|unknown|unidentified)$/i;

/**
 * @returns {{ role: "patient" | "caregiver" | null, speaker: object }}
 *   role null means: do not record this turn.
 */
export function classifySpeaker({ speaker, speakerType, confidence = null, method = "declared" } = {}) {
  const name = String(speaker ?? "").trim() || null;
  const type = String(speakerType ?? "").trim().toLowerCase();

  // Typed text and older clients send no type: whoever is at the console is the user.
  let kind = type ? (KINDS[type] ?? "unknown") : "patient";
  if (name && UNIDENTIFIED.test(name)) kind = "unknown";
  // A visitor the diarizer cannot name is a bystander, not part of the care team.
  if (kind === "visitor" && !name) kind = "unknown";

  const role = kind === "patient" ? "patient" : kind === "unknown" ? null : "caregiver";
  return {
    role,
    speaker: {
      name,
      kind,
      method,
      confidence: Number.isFinite(confidence) && confidence >= 0 && confidence <= 1 ? confidence : null
    }
  };
}
