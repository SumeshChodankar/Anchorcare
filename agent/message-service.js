// Caregiver text messages, sent by the agent on its own when it raises an alert.
//
// This is the ALERT_CAREGIVER_* tier of caregiver/policy.py: telling the care team
// something happened is auto-executed. Messages to family (DRAFT_FAMILY_MESSAGE)
// stay behind caregiver approval and are not sent from here.
//
// Live SMS needs Twilio credentials, CAREGIVER_SMS_NUMBER and ENABLE_LIVE_SMS=true.
// Without all three it runs as a simulation: the message is composed, logged,
// recorded on the alert and shown on the capture page, but nothing leaves the machine.

import { isTwilioConfigured } from "./call-service.js";

const E164 = /^\+[1-9]\d{7,14}$/;
const COOLDOWN_MS = 10 * 60_000;            // one message per alert reason per 10 minutes
const lastSentAt = new Map();

export const caregiverNumber = () => process.env.CAREGIVER_SMS_NUMBER || process.env.SOS_CAREGIVER_NUMBER || "";

export function smsStatus() {
  const to = caregiverNumber();
  return {
    twilioConfigured: isTwilioConfigured(),
    liveAllowed: process.env.ENABLE_LIVE_SMS === "true",
    numberSet: E164.test(to),
    live: isTwilioConfigured() && process.env.ENABLE_LIVE_SMS === "true" && E164.test(to)
  };
}

const masked = number => number ? number.replace(/\d(?=\d{3})/g, "•") : "(no number set)";

// What happened, in words a caregiver hears on the phone or reads on a lock screen.
const SITUATION = Object.freeze({
  distress_call: "has asked for help",
  wandering_distress: "may be lost, outside their safe zone",
  phone_call_dispatched: "has asked to speak to you",
  call_requested: "has asked to speak to you",
  prohibited_action: "asked for something the assistant is not allowed to do",
  loop_detected: "is asking the same question again and again"
});
export const situationFor = (reason, headline) => SITUATION[reason] ?? `needs attention: ${headline ?? "an alert was raised"}`;

// Her words without trailing punctuation, so the sentence around them can end once.
const bare = said => String(said ?? "").trim().replace(/["“”]/g, "").replace(/[.!?,;:s]+$/, "");

const isOutside = location => location?.state === "left_safe_zone";
const miles = location => (Number(location?.distanceFromHomeMeters) / 1609.34).toFixed(1);
const coordsOf = location => {
  const c = location?.coords;
  return c && Number.isFinite(c.lat) && Number.isFinite(c.lng) ? c : null;
};

/** Where she is, as one plain sentence. */
export function locationSentence(location) {
  if (!location?.state) return "Their location is not known.";
  const near = location.placeName ? `, near ${location.placeName}` : "";
  return isOutside(location)
    ? `Their location shows them about ${miles(location)} miles from home${near}.`
    : `Their location shows them at home${near}.`;
}

/** The text a caregiver receives: what happened, her words, when, where, and a map link. */
export function composeAlertMessage({ headline, subjectName, said, location, reason = null, now = new Date(), timezone = "Europe/London" }) {
  const when = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "numeric", minute: "2-digit", hour12: true }).format(now);
  const quote = bare(said) ? ` They said: "${bare(said).slice(0, 120)}."` : "";
  const c = coordsOf(location);
  // The exact position goes to the care team as a map link: they are the ones who need it.
  const map = c ? ` Map: https://maps.google.com/?q=${c.lat.toFixed(5)},${c.lng.toFixed(5)}` : "";
  const what = reason ? situationFor(reason, headline) : headline;
  return `AnchorCare alert (${when}): ${subjectName} ${what}.${quote} ${locationSentence(location)}${map}`.slice(0, 480);
}

/**
 * What the caregiver hears when AnchorCare rings them: who, what happened, her own
 * words, where she is, and that a text with the map is on its way.
 */
export function composeCallScript({ reason, headline, subjectName, said, location, textSent = false }) {
  const words = bare(said) ? ` They said: ${bare(said).slice(0, 160)}.` : "";
  return `This is an urgent call from AnchorCare. ${subjectName} ${situationFor(reason, headline)}.${words} ` +
    `${locationSentence(location)}${textSent ? " A text message with their map location has been sent to this phone." : ""}`;
}

/**
 * Sends (or simulates) one caregiver message. Never throws: a failed message must not
 * take the conversation down with it; the outcome is returned and recorded instead.
 */
export async function sendCaregiverMessage({ body, reason, now = Date.now(), fetchImpl = fetch }) {
  const last = lastSentAt.get(reason) ?? 0;
  if (now - last < COOLDOWN_MS) {
    return { channel: "sms", status: "skipped_cooldown", mode: "none", to: masked(caregiverNumber()), body, at: new Date(now) };
  }
  lastSentAt.set(reason, now);

  const status = smsStatus();
  const to = caregiverNumber();
  if (!status.live) {
    return { channel: "sms", status: "simulated", mode: "simulation", to: masked(to), body, at: new Date(now),
             note: !status.twilioConfigured ? "Twilio not configured" : !status.numberSet ? "CAREGIVER_SMS_NUMBER not set" : "ENABLE_LIVE_SMS is not true" };
  }

  const sid = process.env.TWILIO_ACCOUNT_SID;
  try {
    const response = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({ To: to, From: process.env.TWILIO_FROM_NUMBER, Body: body }),
      signal: AbortSignal.timeout(10_000)
    });
    const json = await response.json().catch(() => ({}));
    return response.ok
      ? { channel: "sms", status: json.status ?? "queued", mode: "twilio_live", sid: json.sid ?? null, to: masked(to), body, at: new Date(now) }
      : { channel: "sms", status: "provider_error", mode: "twilio_live", error: String(json.message ?? response.statusText).slice(0, 200), to: masked(to), body, at: new Date(now) };
  } catch (error) {
    return { channel: "sms", status: "network_error", mode: "twilio_live", error: error.message, to: masked(to), body, at: new Date(now) };
  }
}

/** Test hook: forget cooldowns. */
export function resetMessageCooldowns() { lastSentAt.clear(); }
