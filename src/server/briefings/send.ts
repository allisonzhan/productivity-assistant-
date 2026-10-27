import { DateTime } from "luxon";
import type { Briefing, DeliveryAttempt } from "@prisma/client";
import { prisma } from "@/server/db";
import { runJob } from "@/server/jobs/run";
import { sendSms } from "@/server/delivery/sms";
import { sendEmail } from "@/server/delivery/email";
import { audit } from "@/server/audit/log";
import { dateOnlyToISO } from "@/server/time";

export const MAX_SEND_ATTEMPTS = 3;

export class BriefingSendError extends Error {}

export type BriefingChannel = "email" | "sms";

export const EMAIL_FOOTER =
  '\n\n--\nReply to this email with one line: "Add task: finish reading Friday", TODAY, TASKS, HELP or STOP.\nBuilt from your stored calendar and tasks.';

export async function getBriefingChannel(userId: string): Promise<BriefingChannel> {
  const pref = await prisma.userPreference.findUnique({ where: { userId } });
  return pref?.briefingChannel === "sms" ? "sms" : "email";
}

/** Choosing email also clears an email STOP: an explicit opt-in by the signed-in user. */
export async function setBriefingChannel(userId: string, channel: BriefingChannel) {
  await prisma.userPreference.upsert({
    where: { userId },
    create: { userId, briefingChannel: channel },
    update: { briefingChannel: channel },
  });
  if (channel === "email") {
    const res = await prisma.user.updateMany({ where: { id: userId, emailOptOut: true }, data: { emailOptOut: false } });
    if (res.count) await audit({ userId, actor: "user", action: "email.opt_in" });
  }
}

/** Sends a persisted briefing on the user's chosen channel. */
export async function sendBriefing(userId: string, briefingId: string, opts: { simulateFailure?: boolean; fetchImpl?: typeof fetch } = {}) {
  return (await getBriefingChannel(userId)) === "sms"
    ? sendBriefingSms(userId, briefingId, opts)
    : sendBriefingEmail(userId, briefingId, opts);
}

async function loadBriefing(userId: string, briefingId: string) {
  const briefing = await prisma.briefing.findFirst({ where: { id: briefingId, userId }, include: { deliveryAttempts: true } });
  if (!briefing) throw new BriefingSendError("Briefing not found");
  return briefing;
}

/** Retries create a new DeliveryAttempt (bounded); never resend over a send that has not failed. */
function nextAttemptNumber(briefing: Briefing & { deliveryAttempts: DeliveryAttempt[] }): number {
  const attempts = briefing.deliveryAttempts.length;
  if (attempts >= MAX_SEND_ATTEMPTS) throw new BriefingSendError(`Gave up after ${MAX_SEND_ATTEMPTS} attempts.`);
  if (briefing.deliveryAttempts.some((a) => !["failed", "undelivered"].includes(a.status))) {
    throw new BriefingSendError("This briefing already has a send that has not failed.");
  }
  return attempts + 1;
}

/** Sends a persisted briefing by SMS. */
export async function sendBriefingSms(userId: string, briefingId: string, opts: { simulateFailure?: boolean } = {}) {
  const [user, briefing] = await Promise.all([prisma.user.findUniqueOrThrow({ where: { id: userId } }), loadBriefing(userId, briefingId)]);
  if (!user.phoneE164 || !user.phoneVerifiedAt) throw new BriefingSendError("Verify your phone number first.");
  if (user.smsOptOut) throw new BriefingSendError("You replied STOP. Text START to the service number to re-enable SMS.");
  const attemptNumber = nextAttemptNumber(briefing);

  const attempt = await runJob({ type: "briefing_send", userId, metadata: { briefingId, channel: "sms" } }, () =>
    sendSms({
      userId,
      to: user.phoneE164!,
      body: briefing.content,
      purpose: "briefing",
      briefingId,
      attempt: attemptNumber,
      simulateFailure: opts.simulateFailure,
    }),
  );
  await audit({ userId, actor: "system", action: "briefing.send", entityType: "DeliveryAttempt", entityId: attempt.id, metadata: { status: attempt.status } });
  return attempt;
}

/** Sends a persisted briefing from the user's Gmail to their own address (Google-verified at sign-in). */
export async function sendBriefingEmail(userId: string, briefingId: string, opts: { simulateFailure?: boolean; fetchImpl?: typeof fetch } = {}) {
  const [user, briefing] = await Promise.all([prisma.user.findUniqueOrThrow({ where: { id: userId } }), loadBriefing(userId, briefingId)]);
  if (user.emailOptOut) throw new BriefingSendError("You replied STOP to a briefing email. Resume email briefings on the dashboard.");
  const attemptNumber = nextAttemptNumber(briefing);

  const attempt = await runJob({ type: "briefing_send", userId, metadata: { briefingId, channel: "email" } }, () =>
    sendEmail({
      userId,
      to: user.email,
      subject: `Your briefing for ${DateTime.fromISO(dateOnlyToISO(briefing.forDate)).toFormat("ccc LLL d")}`,
      body: `${briefing.content}${EMAIL_FOOTER}`,
      purpose: "briefing",
      briefingId,
      attempt: attemptNumber,
      simulateFailure: opts.simulateFailure,
      fetchImpl: opts.fetchImpl,
    }),
  );
  await audit({ userId, actor: "system", action: "briefing.send", entityType: "DeliveryAttempt", entityId: attempt.id, metadata: { status: attempt.status, channel: "email" } });
  return attempt;
}
