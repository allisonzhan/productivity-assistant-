import { z } from "zod";
import { GoogleApiError } from "@/server/calendar/google-client";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const MAX_RETRIES = 2;

const sendResponse = z.object({ id: z.string(), threadId: z.string(), labelIds: z.array(z.string()).optional() });

type Payload = {
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string };
  parts?: Payload[];
};
const payloadSchema: z.ZodType<Payload> = z.lazy(() =>
  z.object({
    mimeType: z.string().optional(),
    filename: z.string().optional(),
    headers: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
    body: z.object({ data: z.string().optional() }).optional(),
    parts: z.array(payloadSchema).optional(),
  }),
);

export const gmailMessageSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  labelIds: z.array(z.string()).default([]),
  internalDate: z.string().optional(), // epoch ms
  payload: payloadSchema.optional(),
});
export type GmailMessage = z.infer<typeof gmailMessageSchema>;

const threadSchema = z.object({ id: z.string(), messages: z.array(gmailMessageSchema).default([]) });

async function gmailRequest(url: string, accessToken: string, fetchImpl: typeof fetch, init?: { method: "POST"; body: string }) {
  // Sends are never retried (a retry could deliver twice); reads retry transient failures.
  const retries = init ? 0 : MAX_RETRIES;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: init?.method ?? "GET",
        headers: { authorization: `Bearer ${accessToken}`, ...(init ? { "content-type": "application/json" } : {}) },
        body: init?.body,
      });
    } catch (err) {
      if (attempt < retries) {
        await sleep(400 * 2 ** attempt);
        continue;
      }
      throw new GoogleApiError(`Network error calling Gmail: ${(err as Error).message}`, 0);
    }
    if (res.ok) return res.json();
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      await sleep(400 * 2 ** attempt);
      continue;
    }
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new GoogleApiError(`Gmail API ${res.status}: ${body.error?.message ?? res.statusText}`, res.status);
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Sends a raw RFC 5322 message from the signed-in mailbox. */
export async function sendGmailMessage(opts: { accessToken: string; mime: string; threadId?: string; fetchImpl?: typeof fetch }) {
  const body = JSON.stringify({ raw: Buffer.from(opts.mime, "utf8").toString("base64url"), threadId: opts.threadId });
  return sendResponse.parse(await gmailRequest(`${API}/messages/send`, opts.accessToken, opts.fetchImpl ?? fetch, { method: "POST", body }));
}

export async function getGmailThread(opts: { accessToken: string; threadId: string; fetchImpl?: typeof fetch }) {
  const url = `${API}/threads/${encodeURIComponent(opts.threadId)}?format=full`;
  return threadSchema.parse(await gmailRequest(url, opts.accessToken, opts.fetchImpl ?? fetch));
}

export function header(message: GmailMessage, name: string): string | undefined {
  return message.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
}
