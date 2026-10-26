import { prisma } from "@/server/db";
import { runJob } from "@/server/jobs/run";
import { sendSms } from "@/server/delivery/sms";
import { audit } from "@/server/audit/log";

export const MAX_SEND_ATTEMPTS = 3;

export class BriefingSendError extends Error {}

/** Sends a persisted briefing by SMS. Retries create a new DeliveryAttempt (bounded). */
export async function sendBriefingSms(userId: string, briefingId: string, opts: { simulateFailure?: boolean } = {}) {
  const [user, briefing] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: userId } }),
    prisma.briefing.findFirst({ where: { id: briefingId, userId }, include: { deliveryAttempts: true } }),
  ]);
  if (!briefing) throw new BriefingSendError("Briefing not found");
  if (!user.phoneE164 || !user.phoneVerifiedAt) throw new BriefingSendError("Verify your phone number first.");
  if (user.smsOptOut) throw new BriefingSendError("You replied STOP. Text START to the service number to re-enable SMS.");
  const attempts = briefing.deliveryAttempts.length;
  if (attempts >= MAX_SEND_ATTEMPTS) throw new BriefingSendError(`Gave up after ${MAX_SEND_ATTEMPTS} attempts.`);
  if (briefing.deliveryAttempts.some((a) => !["failed", "undelivered"].includes(a.status))) {
    throw new BriefingSendError("This briefing already has a send that has not failed.");
  }

  const attempt = await runJob({ type: "briefing_send", userId, metadata: { briefingId } }, () =>
    sendSms({
      userId,
      to: user.phoneE164!,
      body: briefing.content,
      purpose: "briefing",
      briefingId,
      attempt: attempts + 1,
      simulateFailure: opts.simulateFailure,
    }),
  );
  await audit({ userId, actor: "system", action: "briefing.send", entityType: "DeliveryAttempt", entityId: attempt.id, metadata: { status: attempt.status } });
  return attempt;
}
