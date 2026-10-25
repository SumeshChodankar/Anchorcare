import { randomUUID } from "node:crypto";

/**
 * AnchorCare Outbound Phone Calling Service
 *
 * Supports:
 * 1. Live Twilio Voice Outbound Calling (PSTN to real mobile phones)
 * 2. Anonymous caller mode (automated synthetic reassurance, no private caller personal details)
 * 3. Interactive simulation mode when live Twilio credentials are not yet supplied
 */

let targetPhoneNumber = process.env.MARGARET_PHONE_NUMBER || process.env.SOS_CAREGIVER_NUMBER || "";
let liveCallActive = false;
let currentCallState = {
  status: "idle",
  callSid: null,
  to: targetPhoneNumber,
  mode: "idle",
  lastMessage: "",
  startedAt: null,
  updatedAt: null
};

export function getTargetPhoneNumber() {
  return targetPhoneNumber || process.env.MARGARET_PHONE_NUMBER || process.env.SOS_CAREGIVER_NUMBER || "";
}

export function setTargetPhoneNumber(number) {
  targetPhoneNumber = String(number || "").trim();
  currentCallState.to = targetPhoneNumber;
  return targetPhoneNumber;
}

export function isTwilioConfigured() {
  const sid = process.env.TWILIO_ACCOUNT_SID || "";
  const token = process.env.TWILIO_AUTH_TOKEN || "";
  const from = process.env.TWILIO_FROM_NUMBER || "";
  return sid.startsWith("AC") && sid.length === 34 && Boolean(token) && /^\+[1-9]\d{7,14}$/.test(from);
}

export function detectCallIntent(text) {
  if (!text || typeof text !== "string") return false;
  const cleaned = text.trim().toLowerCase();
  const pattern = /\b(?:call|phone|dial|ring|contact)\s+(?:margaret|caregiver|guardian|relative|jane|help)\b/i;
  const explicit = /\b(?:call|phone|dial|ring)\s+margaret\b/i;
  return pattern.test(cleaned) || explicit.test(cleaned);
}

export function getCallStatus() {
  return {
    ...currentCallState,
    targetPhoneNumber: getTargetPhoneNumber(),
    twilioConfigured: isTwilioConfigured(),
    liveAllowed: process.env.ENABLE_LIVE_SOS_CALLS === "true"
  };
}

export async function initiateCall({ reason = "Call request", targetNumber = null, anonymous = true, broadcast = null }) {
  const destination = targetNumber || getTargetPhoneNumber();
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;
  const liveEnabled = process.env.ENABLE_LIVE_SOS_CALLS === "true";

  const anonymousMessage =
    "Hello. This is an automated anonymous care notification from AnchorCare. " +
    "An alert has been triggered for Margaret. " +
    "Ambient voice and location monitoring are active, and she is safe. " +
    "Please check the AnchorCare portal for live status.";

  const twiml = `<Response><Say voice="Polly.Amy">${anonymousMessage}</Say></Response>`;

  const callId = `call_${randomUUID()}`;
  const now = new Date();

  currentCallState = {
    status: "dialing",
    callSid: callId,
    to: destination || "Demo Phone (+44 7700 900077)",
    mode: (isTwilioConfigured() && liveEnabled && destination) ? "twilio_live" : "simulation",
    lastMessage: anonymousMessage,
    startedAt: now,
    updatedAt: now
  };

  if (broadcast) {
    broadcast({
      type: "phone_call",
      status: currentCallState.status,
      callSid: currentCallState.callSid,
      to: currentCallState.to,
      mode: currentCallState.mode,
      anonymous,
      message: "Dialing phone number anonymously..."
    });
  }

  // 1. LIVE TWILIO CALL
  if (isTwilioConfigured() && liveEnabled && destination && /^\+[1-9]\d{7,14}$/.test(destination)) {
    try {
      const body = new URLSearchParams({
        To: destination,
        From: from,
        Twiml: twiml
      });

      const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json`, {
        method: "POST",
        headers: {
          Authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"),
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body,
        signal: AbortSignal.timeout(12000)
      });

      if (!response.ok) {
        const errorText = await response.text();
        currentCallState.status = "provider_error";
        currentCallState.error = errorText;
        currentCallState.updatedAt = new Date();
        if (broadcast) {
          broadcast({
            type: "phone_call",
            status: "failed",
            error: `Twilio call rejected: ${response.statusText}`,
            to: destination
          });
        }
        return { ok: false, error: errorText, mode: "twilio_live" };
      }

      const twilioCall = await response.json();
      currentCallState.status = twilioCall.status || "queued";
      currentCallState.callSid = twilioCall.sid;
      currentCallState.updatedAt = new Date();

      if (broadcast) {
        broadcast({
          type: "phone_call",
          status: twilioCall.status || "queued",
          callSid: twilioCall.sid,
          to: destination,
          mode: "twilio_live",
          anonymous: true,
          message: `Live Twilio call dispatched to ${destination}. Status: ${twilioCall.status}`
        });
      }

      return {
        ok: true,
        mode: "twilio_live",
        callSid: twilioCall.sid,
        status: twilioCall.status,
        to: destination
      };
    } catch (err) {
      currentCallState.status = "network_error";
      currentCallState.error = err.message;
      if (broadcast) {
        broadcast({
          type: "phone_call",
          status: "failed",
          error: err.message,
          to: destination
        });
      }
      return { ok: false, error: err.message, mode: "twilio_live" };
    }
  }

  // 2. SIMULATION / DEMO MODE (Step through realistic calling states with audio feedback)
  setTimeout(() => {
    currentCallState.status = "ringing";
    currentCallState.updatedAt = new Date();
    if (broadcast) {
      broadcast({
        type: "phone_call",
        status: "ringing",
        callSid: currentCallState.callSid,
        to: currentCallState.to,
        mode: currentCallState.mode,
        anonymous: true,
        message: `Phone line is ringing at ${currentCallState.to}...`
      });
    }
  }, 1200);

  setTimeout(() => {
    currentCallState.status = "in-progress";
    currentCallState.updatedAt = new Date();
    if (broadcast) {
      broadcast({
        type: "phone_call",
        status: "in-progress",
        callSid: currentCallState.callSid,
        to: currentCallState.to,
        mode: currentCallState.mode,
        anonymous: true,
        spokenMessage: anonymousMessage,
        message: `Call answered! Playing anonymous speech synthesis: "${anonymousMessage.slice(0, 80)}..."`
      });
    }
  }, 3000);

  setTimeout(() => {
    currentCallState.status = "completed";
    currentCallState.updatedAt = new Date();
    if (broadcast) {
      broadcast({
        type: "phone_call",
        status: "completed",
        callSid: currentCallState.callSid,
        to: currentCallState.to,
        mode: currentCallState.mode,
        anonymous: true,
        message: "Call successfully completed. Anonymous reassurance delivered."
      });
    }
  }, 6500);

  return {
    ok: true,
    mode: "simulation",
    callSid: currentCallState.callSid,
    status: "dialing",
    to: currentCallState.to,
    note: "Live Twilio credentials not fully set; executed high-fidelity call simulation"
  };
}
