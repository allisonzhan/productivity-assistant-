import { prisma } from "@/server/db";
import { errorMessage } from "@/server/jobs/run";
import { GMAIL_SEND_SCOPE } from "@/server/auth/google-oauth";
import { getGmailAccessToken } from "@/server/integrations/google-credentials";
import { sendGmailMessage } from "@/server/email/gmail-client";
import { buildMime } from "@/server/email/mime";

/**
 * Sends one email from the user's own Gmail to themselves and records it. Status starts
 * "queued" (local), becomes "sent" only when Gmail returns a message ID, and "delivered" only
 * when the reply check sees Gmail's INBOX label on that message.
 */
export async function sendEmail(input: {
  userId: string;
  to: string;
  subject: string;
  body: string;
  purpose: "briefing" | "reply";
  briefingId?: string;
  attempt?: number;
  thread?: { threadId: string; inReplyTo?: string };
  /** Sends a real request with an invalid token, so Gmail really rejects it. */
  simulateFailure?: boolean;
  fetchImpl?: typeof fetch;
}) {
  const attempt = await prisma.deliveryAttempt.create({
    data: {
      userId: input.userId,
      briefingId: input.briefingId,
      purpose: input.purpose,
      channel: "email",
      provider: "gmail",
      to: input.to,
      body: input.body,
      attempt: input.attempt ?? 1,
      status: "queued",
      threadId: input.thread?.threadId,
    },
  });

  try {
    const accessToken = input.simulateFailure
      ? "simulated-invalid-token"
      : await getGmailAccessToken(input.userId, GMAIL_SEND_SCOPE, input.fetchImpl);
    const mime = buildMime({
      from: input.to, // the user's own mailbox
      to: input.to,
      subject: input.subject,
      body: input.body,
      kind: input.purpose,
      inReplyTo: input.thread?.inReplyTo,
    });
    const res = await sendGmailMessage({ accessToken, mime, threadId: input.thread?.threadId, fetchImpl: input.fetchImpl });
    return prisma.deliveryAttempt.update({
      where: { id: attempt.id },
      data: {
        status: "sent",
        providerStatus: res.labelIds?.join(",") || "SENT",
        providerMessageId: res.id,
        threadId: res.threadId,
      },
    });
  } catch (err) {
    const message = errorMessage(err);
    return prisma.deliveryAttempt.update({
      where: { id: attempt.id },
      data: { status: "failed", error: input.simulateFailure ? `[Simulated failure] ${message}` : message },
    });
  }
}
