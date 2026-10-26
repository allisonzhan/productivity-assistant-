import { env, publicUrl } from "@/server/env";
import { isValidTwilioSignature } from "@/server/sms/signature";

export type VerifiedTwilioRequest =
  | { ok: true; params: Record<string, string> }
  | { ok: false; response: Response };

/**
 * Parses a Twilio form POST and verifies X-Twilio-Signature against the public URL Twilio
 * was configured with (behind a tunnel, req.url is localhost and cannot be used).
 */
export async function verifyTwilioRequest(req: Request): Promise<VerifiedTwilioRequest> {
  const authToken = env().TWILIO_AUTH_TOKEN;
  if (!authToken) {
    return { ok: false, response: new Response("Twilio webhook not configured", { status: 503 }) };
  }
  const form = await req.formData();
  const params: Record<string, string> = {};
  for (const [k, v] of form.entries()) if (typeof v === "string") params[k] = v;

  const { pathname, search } = new URL(req.url);
  const url = `${publicUrl()}${pathname}${search}`;
  if (!isValidTwilioSignature(authToken, req.headers.get("x-twilio-signature"), url, params)) {
    console.warn("Rejected Twilio webhook with invalid signature", { url });
    return { ok: false, response: new Response("Invalid signature", { status: 403 }) };
  }
  return { ok: true, params };
}

export function emptyTwiml(): Response {
  return new Response('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', {
    headers: { "content-type": "text/xml" },
  });
}
