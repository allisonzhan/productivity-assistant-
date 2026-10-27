import { Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import { errorMessage, runJob } from "@/server/jobs/run";
import { generateBriefing } from "@/server/briefings/generate";
import { BriefingSendError, MAX_SEND_ATTEMPTS, getBriefingChannel, sendBriefing } from "@/server/briefings/send";
import { checkEmailReplies } from "@/server/email/replies";
import { syncGoogleCalendar } from "@/server/sync/google-calendar-sync";
import { GOOGLE_CALENDAR } from "@/server/integrations/google-credentials";
import { dueBriefings, type ScheduleKind } from "@/server/scheduling/due";
import { toSchedulePrefs } from "@/server/scheduling/preferences";
import { isoToDateOnly } from "@/server/time";

/**
 * Worker-side services. Each is safe to run repeatedly and from more than one worker:
 * a ScheduledBriefing row (unique per user + kind + local date) is the exactly-once claim,
 * and a row is only processed after an atomic status transition.
 */

export const HEARTBEAT_ID = "scheduler";
const RETRY_BASE_MS = 5 * 60_000; // 5 min, then 10 min
const STALE_SENDING_MS = 10 * 60_000; // a worker died mid-send
const FRESH_SYNC_MS = 10 * 60_000;

type Opts = { fetchImpl?: typeof fetch };

export async function recordWorkerStart(now: Date = new Date()) {
  await prisma.workerHeartbeat.upsert({
    where: { id: HEARTBEAT_ID },
    create: { id: HEARTBEAT_ID, startedAt: now, lastTickAt: now },
    update: { startedAt: now, lastTickAt: now },
  });
}

/** One scheduler pass: record liveness, create rows for briefings now due, then send what is ready. */
export async function schedulerTick(now: Date = new Date(), opts: Opts = {}) {
  await prisma.workerHeartbeat.upsert({
    where: { id: HEARTBEAT_ID },
    create: { id: HEARTBEAT_ID, startedAt: now, lastTickAt: now },
    update: { lastTickAt: now },
  });
  const planned = await planDueBriefings(now);
  const processed = await processScheduledBriefings(now, opts);
  return { planned, processed };
}

/** Creates a ScheduledBriefing for every briefing due now; an existing row means it was already handled. */
export async function planDueBriefings(now: Date): Promise<number> {
  const users = await prisma.user.findMany({ include: { preference: true } });
  let created = 0;
  for (const user of users) {
    for (const due of dueBriefings(user.timezone, toSchedulePrefs(user.preference), now)) {
      try {
        await prisma.scheduledBriefing.create({
          data: { userId: user.id, kind: due.kind, forDate: isoToDateOnly(due.forDate), scheduledFor: due.scheduledFor },
        });
        created++;
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") continue;
        throw err;
      }
    }
  }
  return created;
}

export async function processScheduledBriefings(now: Date, opts: Opts = {}) {
  const ready = await prisma.scheduledBriefing.findMany({ where: claimable(now), select: { id: true }, orderBy: { scheduledFor: "asc" } });
  const results = [];
  for (const { id } of ready) results.push(await runScheduledBriefing(id, now, opts));
  return results;
}

function claimable(now: Date): Prisma.ScheduledBriefingWhereInput {
  return {
    OR: [
      { status: "pending" },
      { status: "retrying", nextAttemptAt: { lte: now } },
      { status: "sending", updatedAt: { lt: new Date(now.getTime() - STALE_SENDING_MS) } },
    ],
  };
}

export type ScheduledResult = { id: string; status: "sent" | "retrying" | "failed" | "skipped" | "not_claimed"; error?: string };

/** Generates (once) and sends one scheduled briefing; failures retry with backoff, then stop visibly. */
export async function runScheduledBriefing(id: string, now: Date = new Date(), opts: Opts = {}): Promise<ScheduledResult> {
  const claim = await prisma.scheduledBriefing.updateMany({
    where: { id, ...claimable(now) },
    data: { status: "sending", attempts: { increment: 1 } },
  });
  if (claim.count === 0) return { id, status: "not_claimed" };
  const row = await prisma.scheduledBriefing.findUniqueOrThrow({ where: { id } });
  const finish = async (status: Exclude<ScheduledResult["status"], "not_claimed">, error?: string) => {
    const retryAt = status === "retrying" ? new Date(now.getTime() + RETRY_BASE_MS * 2 ** (row.attempts - 1)) : null;
    await prisma.scheduledBriefing.update({ where: { id }, data: { status, error: error ?? null, nextAttemptAt: retryAt } });
    return { id, status, error };
  };
  const failOrRetry = (error: string) => finish(row.attempts < MAX_SEND_ATTEMPTS ? "retrying" : "failed", error);

  try {
    return await runJob({ type: "scheduled_briefing", userId: row.userId, metadata: { scheduledBriefingId: id, kind: row.kind } }, async () => {
      let briefingId = row.briefingId;
      if (!briefingId) {
        await syncIfStale(row.userId, now, opts);
        briefingId = (await generateBriefing(row.userId, row.kind as ScheduleKind, now)).id;
        await prisma.scheduledBriefing.update({ where: { id }, data: { briefingId } });
      }
      // A previous run may have sent it before dying: never send twice.
      const attempts = await prisma.deliveryAttempt.findMany({ where: { briefingId } });
      if (attempts.some((a) => !["failed", "undelivered"].includes(a.status))) return finish("sent");
      if (attempts.length >= MAX_SEND_ATTEMPTS) return finish("failed", attempts.at(-1)?.error ?? "Send failed");

      const attempt = await sendBriefing(row.userId, briefingId, opts);
      // Thrown so JobExecution records the failure; handled below.
      if (attempt.status === "failed") throw new Error(attempt.error ?? "Send failed");
      return finish("sent");
    });
  } catch (err) {
    // Opted out, no verified phone, etc.: not retryable until the user acts.
    if (err instanceof BriefingSendError) return finish("skipped", err.message);
    return failOrRetry(errorMessage(err));
  }
}

/** Briefings come from stored data; refresh it first if the last sync is old. Failures are recorded, not fatal. */
async function syncIfStale(userId: string, now: Date, opts: Opts) {
  const integration = await prisma.integration.findUnique({ where: { userId_provider: { userId, provider: GOOGLE_CALENDAR } } });
  if (!integration || integration.status === "reauth_required") return;
  if (integration.lastSyncAt && now.getTime() - integration.lastSyncAt.getTime() < FRESH_SYNC_MS) return;
  await syncGoogleCalendar(userId, { now, fetchImpl: opts.fetchImpl });
}

/** Periodic reply check for everyone on the email channel. */
export async function checkAllEmailReplies(now: Date = new Date(), opts: Opts = {}) {
  const users = await prisma.user.findMany({ select: { id: true } });
  const results = [];
  for (const { id } of users) {
    if ((await getBriefingChannel(id)) !== "email") continue;
    results.push({ userId: id, ...(await checkEmailReplies(id, { now, fetchImpl: opts.fetchImpl })) });
  }
  return results;
}

/** Periodic calendar sync. Integrations that need the user to reconnect are left alone (the dashboard says so). */
export async function syncAllCalendars(now: Date = new Date(), opts: Opts = {}) {
  const integrations = await prisma.integration.findMany({
    where: { provider: GOOGLE_CALENDAR, status: { not: "reauth_required" } },
    select: { userId: true },
  });
  const results = [];
  for (const { userId } of integrations) results.push({ userId, ...(await syncGoogleCalendar(userId, { now, fetchImpl: opts.fetchImpl })) });
  return results;
}
