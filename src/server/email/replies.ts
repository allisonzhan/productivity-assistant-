import { prisma } from "@/server/db";
import { errorMessage, runJob } from "@/server/jobs/run";
import { GMAIL_READ_SCOPE } from "@/server/auth/google-oauth";
import { GMAIL, ReauthRequiredError, getGmailAccessToken, hasGoogleScope } from "@/server/integrations/google-credentials";
import { GoogleApiError } from "@/server/calendar/google-client";
import { getGmailThread, header } from "@/server/email/gmail-client";
import { GENERATED_HEADER, extractReplyCommand, parseAddress, payloadText } from "@/server/email/mime";
import { handleInboundMessage } from "@/server/sms/inbound";

const LOOKBACK_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export type ReplyCheckResult =
  | { ok: true; threads: number; processed: number; delivered: number }
  | { ok: false; error: string };

/**
 * Checks the user's recent briefing threads for replies and runs each new one through the
 * command handler (exactly-once via the InboundMessage unique constraint). Only threads the
 * app started are read, and only messages from the user's own address are acted on.
 * Also marks the app's own sends "delivered" once Gmail shows them in the inbox.
 * Runs on demand in Gate 1; a scheduled worker polls in Gate 2.
 */
export async function checkEmailReplies(userId: string, opts: { fetchImpl?: typeof fetch; now?: Date } = {}): Promise<ReplyCheckResult> {
  const now = opts.now ?? new Date();
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const integration = await prisma.integration.upsert({
    where: { userId_provider: { userId, provider: GMAIL } },
    create: { userId, provider: GMAIL, status: "pending" },
    update: {},
  });

  try {
    return await runJob({ type: "email_reply_check", userId }, async () => {
      const recent = await prisma.deliveryAttempt.findMany({
        where: { userId, channel: "email", threadId: { not: null }, createdAt: { gte: new Date(now.getTime() - LOOKBACK_DAYS * DAY_MS) } },
        select: { threadId: true },
      });
      const threadIds = [...new Set(recent.map((a) => a.threadId!))];
      // Nothing sent recently: skip Gmail (and the token refresh), but still report missing consent.
      if (!threadIds.length && !(await hasGoogleScope(userId, GMAIL_READ_SCOPE))) {
        throw new ReauthRequiredError("Gmail access was not granted. Reconnect Google and allow Gmail access.");
      }
      const accessToken = threadIds.length ? await getGmailAccessToken(userId, GMAIL_READ_SCOPE, opts.fetchImpl) : "";
      const [ownSends, seen] = await Promise.all([
        prisma.deliveryAttempt.findMany({ where: { userId, channel: "email", threadId: { in: threadIds }, providerMessageId: { not: null } } }),
        prisma.inboundMessage.findMany({ where: { userId, provider: "gmail", threadId: { in: threadIds } }, select: { providerMessageId: true } }),
      ]);
      const ownById = new Map(ownSends.map((a) => [a.providerMessageId!, a]));
      const seenIds = new Set(seen.map((m) => m.providerMessageId));
      const me = user.email.toLowerCase();

      let processed = 0;
      let delivered = 0;
      for (const threadId of threadIds) {
        let thread;
        try {
          thread = await getGmailThread({ accessToken, threadId, fetchImpl: opts.fetchImpl });
        } catch (err) {
          if (err instanceof GoogleApiError && err.status === 404) continue; // thread deleted by the user
          throw err;
        }
        for (const message of thread.messages) {
          const own = ownById.get(message.id);
          if (own) {
            if (own.status === "sent" && message.labelIds.includes("INBOX")) {
              await prisma.deliveryAttempt.update({ where: { id: own.id }, data: { status: "delivered", providerStatus: message.labelIds.join(",") } });
              delivered++;
            }
            continue;
          }
          if (header(message, GENERATED_HEADER) || seenIds.has(message.id)) continue;
          // Mail from anyone else in the thread is third-party content: never acted on.
          const from = parseAddress(header(message, "From"));
          if (from !== me) continue;

          await handleInboundMessage(
            {
              channel: "email",
              provider: "gmail",
              providerMessageId: message.id,
              from,
              body: extractReplyCommand(payloadText(message.payload)),
              userId,
              thread: { threadId, subject: header(message, "Subject") ?? "Your briefing", messageIdHeader: header(message, "Message-ID") },
            },
            // Dates like "Friday" resolve relative to when the reply was written.
            { now: message.internalDate ? new Date(Number(message.internalDate)) : now, fetchImpl: opts.fetchImpl },
          );
          processed++;
        }
      }

      await prisma.integration.update({
        where: { id: integration.id },
        data: { status: "connected", lastSyncAt: now, lastSuccessAt: now, lastError: null, lastErrorAt: null },
      });
      return { ok: true as const, threads: threadIds.length, processed, delivered };
    });
  } catch (err) {
    const message = errorMessage(err);
    // 403 is usually "Gmail API not enabled in the Cloud project": a setup error, not a reconnect.
    const reauth = err instanceof ReauthRequiredError || (err instanceof GoogleApiError && err.status === 401);
    await prisma.integration.update({
      where: { id: integration.id },
      data: { status: reauth ? "reauth_required" : "error", lastSyncAt: now, lastError: message, lastErrorAt: now },
    });
    return { ok: false, error: message };
  }
}
