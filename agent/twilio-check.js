// Checks the Twilio setup without placing a call or sending a text.
//
//   npm run agent:twilio-check                      read-only: credentials, numbers, what will happen
//   npm run agent:twilio-check -- --test-call       ALSO rings the caregiver number once (a real call)
//   npm run agent:twilio-check -- --test-sms        ALSO texts the caregiver number once (a real SMS)
//
// The auth token is never printed, and phone numbers are masked.

import { existsSync } from "node:fs";
if (existsSync(".env")) process.loadEnvFile(".env");

const E164 = /^\+[1-9]\d{7,14}$/;
const env = name => (process.env[name] ?? "").trim();
const mask = n => n ? n.replace(/\d(?=\d{3})/g, "•") : "(not set)";
const sid = env("TWILIO_ACCOUNT_SID"), token = env("TWILIO_AUTH_TOKEN"), from = env("TWILIO_FROM_NUMBER");
const callTo = env("MARGARET_PHONE_NUMBER") || env("SOS_CAREGIVER_NUMBER");
const smsTo = env("CAREGIVER_SMS_NUMBER") || env("SOS_CAREGIVER_NUMBER");
const wantCall = process.argv.includes("--test-call"), wantSms = process.argv.includes("--test-sms");

let problems = 0;
let smsBlocked = false;              // the caller is a verified ID, which cannot send SMS
const ok = (msg) => console.log(`  ✓ ${msg}`);
const bad = (msg) => { problems++; console.log(`  ✗ ${msg}`); };
const note = (msg) => console.log(`  · ${msg}`);

console.log("\n1. Settings in .env");
/^AC[0-9a-f]{32}$/i.test(sid) ? ok(`TWILIO_ACCOUNT_SID  ${sid.slice(0, 6)}…${sid.slice(-4)}`) : bad("TWILIO_ACCOUNT_SID must be AC followed by 32 hex characters");
/^[0-9a-f]{32}$/i.test(token) ? ok("TWILIO_AUTH_TOKEN   set (32 characters, not shown)")
  : token ? bad("TWILIO_AUTH_TOKEN is set but not 32 hex characters (an API key secret is not the auth token)") : bad("TWILIO_AUTH_TOKEN missing");
E164.test(from) ? ok(`TWILIO_FROM_NUMBER  ${mask(from)}`) : bad("TWILIO_FROM_NUMBER must be your Twilio number in +44… form");
E164.test(callTo) ? ok(`call target          ${mask(callTo)}  (${env("MARGARET_PHONE_NUMBER") ? "MARGARET_PHONE_NUMBER" : "SOS_CAREGIVER_NUMBER"})`)
  : bad("no call target: set SOS_CAREGIVER_NUMBER (+44… form)");
E164.test(smsTo) ? ok(`SMS target           ${mask(smsTo)}  (${env("CAREGIVER_SMS_NUMBER") ? "CAREGIVER_SMS_NUMBER" : "SOS_CAREGIVER_NUMBER"})`)
  : bad("no SMS target: set SOS_CAREGIVER_NUMBER or CAREGIVER_SMS_NUMBER");
note(`ENABLE_LIVE_SOS_CALLS=${env("ENABLE_LIVE_SOS_CALLS") || "(not set)"}   ENABLE_LIVE_SMS=${env("ENABLE_LIVE_SMS") || "(not set)"}`);

const auth = "Basic " + Buffer.from(`${sid}:${token}`).toString("base64");
const api = async (path, init = {}) => {
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}${path}`, {
    ...init, headers: { Authorization: auth, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(15000)
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

if (/^AC[0-9a-f]{32}$/i.test(sid) && token) {
  console.log("\n2. Twilio account (read-only)");
  const acct = await api(".json");
  if (acct.status === 401) bad("Twilio rejected the SID/token pair (401): copy both again from console.twilio.com → Account info");
  else if (acct.status !== 200) bad(`Twilio answered HTTP ${acct.status}: ${acct.body.message ?? ""}`);
  else {
    ok(`account "${acct.body.friendly_name}" is ${acct.body.status}, type ${acct.body.type}`);
    const trial = acct.body.type === "Trial";
    if (trial) note("trial account: it can only call and text numbers you have verified, and every call starts with a short Twilio trial notice");

    // Upgraded accounts may place no calls until Twilio approves a Primary Customer
    // Profile (KYC); until then every call fails with error 20003.
    if (!trial) {
      const hub = await fetch("https://trusthub.twilio.com/v1/CustomerProfiles?PageSize=20",
        { headers: { Authorization: auth }, signal: AbortSignal.timeout(15000) }).then(r => r.json()).catch(() => null);
      const profiles = hub?.results ?? [];
      const approved = profiles.find(p => p.status === "twilio-approved");
      if (approved) ok(`compliance profile "${approved.friendly_name}" is approved`);
      else if (profiles.length) bad(`compliance profile is ${profiles.map(p => p.status).join(", ")}: calls are blocked until Twilio approves it (Trust Hub → Customer profiles)`);
      else bad("no compliance (KYC) profile: Twilio blocks calls (error 20003) until you submit a Primary Customer Profile in Console → Trust Hub → Customer profiles and it is approved");
    }

    const owned = await api(`/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(from)}`);
    const number = owned.body.incoming_phone_numbers?.[0];
    if (number) {
      ok(`TWILIO_FROM_NUMBER belongs to this account (voice: ${number.capabilities?.voice ? "yes" : "NO"}, sms: ${number.capabilities?.sms ? "yes" : "NO"})`);
      if (!number.capabilities?.voice) bad("this number cannot make voice calls");
      if (!number.capabilities?.sms) note("this number cannot send SMS; caregiver texts will fail (calls still work)");
    } else {
      // A verified caller ID (e.g. your own mobile) may be the caller for voice, never for SMS.
      const ids = (await api(`/OutgoingCallerIds.json?PhoneNumber=${encodeURIComponent(from)}`)).body.outgoing_caller_ids ?? [];
      if (ids.length) {
        ok("TWILIO_FROM_NUMBER is a verified caller ID: calls will show it as the caller");
        note("a verified caller ID cannot send SMS: caregiver texts need a Twilio number (Phone Numbers → Buy a number)");
        if (env("ENABLE_LIVE_SMS") === "true") bad("ENABLE_LIVE_SMS=true but the caller is not a Twilio number, so texts will fail");
        smsBlocked = true;
      } else {
        bad("TWILIO_FROM_NUMBER is neither a number on this account nor a verified caller ID: buy one, or verify it under Phone Numbers → Verified Caller IDs");
      }
    }

    if (trial) {
      const verified = new Set((await api("/OutgoingCallerIds.json?PageSize=100")).body.outgoing_caller_ids?.map(c => c.phone_number) ?? []);
      for (const [label, n] of [["call target", callTo], ["SMS target", smsTo]]) {
        if (!E164.test(n)) continue;
        verified.has(n) ? ok(`${label} ${mask(n)} is a verified caller ID`)
          : bad(`${label} ${mask(n)} is not verified: add it under Phone Numbers → Verified Caller IDs (trial accounts can reach only verified numbers)`);
      }
    }
  }
}

console.log("\n3. What AnchorCare will do");
const ready = problems === 0;
console.log(`  calls: ${ready && env("ENABLE_LIVE_SOS_CALLS") === "true" ? "LIVE — distress, wandering and 'call …' requests ring the caregiver" : `simulated${!ready ? " (fix the ✗ items first)" : " (set ENABLE_LIVE_SOS_CALLS=true to go live)"}`}`);
console.log(`  SMS:   ${smsBlocked ? "simulated (needs a Twilio number; a verified caller ID cannot text)" : ""}${smsBlocked ? "" : ready && env("ENABLE_LIVE_SMS") === "true" ? "LIVE — every alert texts the caregiver" : `simulated${!ready ? " (fix the ✗ items first)" : " (set ENABLE_LIVE_SMS=true to go live)"}`}`);
console.log("  Restart the daemon (and the web app) after changing .env.");

if ((wantCall || wantSms) && !ready) {
  console.log("\nNot sending a test: fix the ✗ items above first.\n");
  process.exit(1);
}
if (wantCall) {
  console.log(`\n4. Test call to ${mask(callTo)} (real)`);
  const twiml = `<Response><Say voice="Polly.Amy">This is a test call from AnchorCare. Your Twilio calling is set up. No action is needed.</Say></Response>`;
  const r = await api("/Calls.json", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ To: callTo, From: from, Twiml: twiml }) });
  r.status === 201 ? ok(`call queued (${r.body.sid}), status ${r.body.status}`) : bad(`call failed: HTTP ${r.status} ${r.body.message ?? ""}`);
}
if (wantSms && smsBlocked) {
  console.log("\nNot sending a test SMS: a verified caller ID cannot send texts.");
} else if (wantSms) {
  console.log(`\n${wantCall ? 5 : 4}. Test SMS to ${mask(smsTo)} (real)`);
  const r = await api("/Messages.json", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ To: smsTo, From: from, Body: "AnchorCare test: caregiver text alerts are set up. No action needed." }) });
  r.status === 201 ? ok(`SMS queued (${r.body.sid}), status ${r.body.status}`) : bad(`SMS failed: HTTP ${r.status} ${r.body.message ?? ""}`);
}
console.log(problems ? `\n${problems} problem(s) to fix.\n` : "\nAll checks passed.\n");
process.exit(problems ? 1 : 0);
