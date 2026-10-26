import { verifyTwilioRequest } from "@/server/sms/twilio-request";
import { applyStatusCallback } from "@/server/delivery/sms";

// Twilio message status callback (set per message via StatusCallback).
export async function POST(req: Request) {
  const verified = await verifyTwilioRequest(req);
  if (!verified.ok) return verified.response;
  const { MessageSid, MessageStatus, ErrorCode } = verified.params;
  if (!MessageSid || !MessageStatus) return new Response("Missing MessageSid/MessageStatus", { status: 400 });
  await applyStatusCallback({ messageSid: MessageSid, status: MessageStatus, errorCode: ErrorCode || undefined });
  return new Response(null, { status: 204 });
}
