// Acceptance helper: delivers the SAME correctly signed inbound-SMS webhook twice, exactly as a
// Twilio retry would, to prove idempotency against the running app.
//
//   node --env-file=.env scripts/replay-twilio-webhook.mjs <From E.164> "<Body>" [MessageSid]
//
// Signs with TWILIO_AUTH_TOKEN and posts to ${PUBLIC_URL}/api/webhooks/twilio/sms.
// This is not proof of live SMS on its own; it complements a real reply from a phone.
import { createHmac, randomBytes } from "node:crypto";

const [from, body = "Add task: finish reading Friday", sid = `SMreplay${randomBytes(12).toString("hex")}`] = process.argv.slice(2);
const { PUBLIC_URL, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER } = process.env;
if (!from || !PUBLIC_URL || !TWILIO_AUTH_TOKEN) {
  console.error("Usage: node --env-file=.env scripts/replay-twilio-webhook.mjs <From> [Body] [MessageSid]; needs PUBLIC_URL and TWILIO_AUTH_TOKEN");
  process.exit(1);
}

const url = `${PUBLIC_URL.replace(/\/$/, "")}/api/webhooks/twilio/sms`;
const params = { MessageSid: sid, From: from, To: TWILIO_FROM_NUMBER ?? "", Body: body };
const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
const signature = createHmac("sha1", TWILIO_AUTH_TOKEN).update(data, "utf8").digest("base64");

for (const n of [1, 2]) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signature },
    body: new URLSearchParams(params),
  });
  console.log(`delivery ${n}: HTTP ${res.status} (MessageSid ${sid})`);
}
console.log("Check the dashboard: exactly one task and one inbound row for this MessageSid.");
