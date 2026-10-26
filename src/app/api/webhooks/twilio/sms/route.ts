import { emptyTwiml, verifyTwilioRequest } from "@/server/sms/twilio-request";
import { handleInboundSms } from "@/server/sms/inbound";

// Twilio inbound messaging webhook (configure on the phone number: HTTP POST).
export async function POST(req: Request) {
  const verified = await verifyTwilioRequest(req);
  if (!verified.ok) return verified.response;
  const { MessageSid, From, Body } = verified.params;
  if (!MessageSid || !From) return new Response("Missing MessageSid/From", { status: 400 });

  // Replies are sent through the REST API (tracked as DeliveryAttempts), not TwiML.
  await handleInboundSms({ provider: "twilio", providerMessageId: MessageSid, from: From, body: Body ?? "" });
  return emptyTwiml();
}
