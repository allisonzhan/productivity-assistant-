import { createHmac } from "node:crypto";
import { safeEqual } from "@/server/crypto";

/**
 * Twilio request signature: base64(HMAC-SHA1(authToken, url + sorted(key+value)...)).
 * https://www.twilio.com/docs/usage/webhooks/webhooks-security
 */
export function computeTwilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return createHmac("sha1", authToken).update(data, "utf8").digest("base64");
}

export function isValidTwilioSignature(
  authToken: string,
  signature: string | null,
  url: string,
  params: Record<string, string>,
): boolean {
  if (!signature) return false;
  return safeEqual(computeTwilioSignature(authToken, url, params), signature);
}
