import { prisma } from "@/server/db";
import { env, publicUrl } from "@/server/env";
import { errorMessage } from "@/server/jobs/run";
import { simulatorProvider, twilioProvider, type SmsProvider } from "@/server/sms/provider";

export function getSmsProvider(): SmsProvider {
  const e = env();
  if (e.SMS_PROVIDER === "simulator") return simulatorProvider();
  if (!e.TWILIO_ACCOUNT_SID || !e.TWILIO_AUTH_TOKEN || !e.TWILIO_FROM_NUMBER) {
    throw new Error("SMS_PROVIDER=twilio but TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER are not all set");
  }
  return twilioProvider({ accountSid: e.TWILIO_ACCOUNT_SID, authToken: e.TWILIO_AUTH_TOKEN, from: e.TWILIO_FROM_NUMBER });
}

/**
 * Sends one SMS and records it. Status starts "queued" (local), becomes "accepted" only when
 * the provider returns a message ID, and advances further only through signed status callbacks.
 */
export async function sendSms(input: {
  userId: string;
  to: string;
  body: string;
  purpose: "briefing" | "verification" | "reply";
  briefingId?: string;
  attempt?: number;
  simulateFailure?: boolean;
  provider?: SmsProvider;
}) {
  let provider: SmsProvider | undefined = input.provider;
  let configError: string | undefined;
  try {
    provider ??= getSmsProvider();
  } catch (err) {
    configError = errorMessage(err);
  }

  const attempt = await prisma.deliveryAttempt.create({
    data: {
      userId: input.userId,
      briefingId: input.briefingId,
      purpose: input.purpose,
      provider: provider?.name ?? "unconfigured",
      to: input.to,
      body: input.body,
      attempt: input.attempt ?? 1,
      status: "queued",
    },
  });
  if (!provider) {
    return prisma.deliveryAttempt.update({ where: { id: attempt.id }, data: { status: "failed", error: configError } });
  }

  try {
    const res = await provider.send({
      to: input.to,
      body: input.body,
      statusCallback: provider.name === "twilio" ? `${publicUrl()}/api/webhooks/twilio/status` : undefined,
      simulateFailure: input.simulateFailure,
    });
    return prisma.deliveryAttempt.update({
      where: { id: attempt.id },
      data: {
        status: provider.name === "simulator" ? "simulated" : "accepted",
        providerStatus: res.providerStatus,
        providerMessageId: res.providerMessageId,
      },
    });
  } catch (err) {
    return prisma.deliveryAttempt.update({
      where: { id: attempt.id },
      data: { status: "failed", error: errorMessage(err) },
    });
  }
}

// Twilio statuses can arrive out of order; never move backwards.
const RANK: Record<string, number> = {
  queued: 0, accepted: 1, scheduled: 1, sending: 2, sent: 3,
  delivered: 4, undelivered: 4, failed: 4, canceled: 4, read: 5,
};

export async function applyStatusCallback(input: { messageSid: string; status: string; errorCode?: string }) {
  const attempt = await prisma.deliveryAttempt.findUnique({ where: { providerMessageId: input.messageSid } });
  if (!attempt) return { updated: false as const, reason: "unknown_message" };
  const next = input.status.toLowerCase();
  if ((RANK[next] ?? -1) <= (RANK[attempt.status] ?? -1)) return { updated: false as const, reason: "stale" };
  await prisma.deliveryAttempt.update({
    where: { id: attempt.id },
    data: {
      status: next,
      providerStatus: input.status,
      error: input.errorCode ? `Twilio error ${input.errorCode}` : attempt.error,
    },
  });
  return { updated: true as const };
}
