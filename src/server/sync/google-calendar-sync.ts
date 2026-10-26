import { prisma } from "@/server/db";
import { audit } from "@/server/audit/log";
import { errorMessage, runJob } from "@/server/jobs/run";
import { GoogleApiError, listEvents } from "@/server/calendar/google-client";
import { normalizeGoogleEvent } from "@/server/calendar/normalize";
import { GOOGLE_CALENDAR, ReauthRequiredError, getGoogleAccessToken } from "@/server/integrations/google-credentials";

const CALENDAR_ID = "primary";
const WINDOW_PAST_DAYS = 1;
const WINDOW_FUTURE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export type SyncResult =
  | { ok: true; fetched: number; upserted: number; cancelled: number; removed: number }
  | { ok: false; error: string };

export type SyncOptions = {
  fetchImpl?: typeof fetch;
  now?: Date;
  /**
   * Sends a real request to Google with an invalid token, so Google really rejects it.
   * Used to demonstrate the visible, recoverable error path.
   */
  simulateFailure?: boolean;
};

/**
 * Windowed full sync of the primary calendar. Idempotent: events are upserted on
 * (userId, provider, externalId); events missing from the window are soft-deleted.
 * Incremental syncToken sync is a Gate 2 improvement.
 */
export async function syncGoogleCalendar(userId: string, opts: SyncOptions = {}): Promise<SyncResult> {
  const integration = await prisma.integration.findUnique({
    where: { userId_provider: { userId, provider: GOOGLE_CALENDAR } },
  });
  if (!integration) return { ok: false, error: "Google Calendar is not connected." };

  const now = opts.now ?? new Date();
  const timeMin = new Date(now.getTime() - WINDOW_PAST_DAYS * DAY_MS);
  const timeMax = new Date(now.getTime() + WINDOW_FUTURE_DAYS * DAY_MS);

  try {
    return await runJob(
      { type: "calendar_sync", userId, metadata: { simulateFailure: !!opts.simulateFailure } },
      async () => {
        const accessToken = opts.simulateFailure
          ? "simulated-invalid-token"
          : await getGoogleAccessToken(integration.id, opts.fetchImpl);
        const raw = await listEvents({ accessToken, calendarId: CALENDAR_ID, timeMin, timeMax, fetchImpl: opts.fetchImpl });
        const normalized = raw.map(normalizeGoogleEvent).filter((e) => e !== null);

        const result = await prisma.$transaction(async (tx) => {
          let upserted = 0;
          let cancelled = 0;
          const seen: string[] = [];
          for (const e of normalized) {
            const key = { userId_provider_externalId: { userId, provider: GOOGLE_CALENDAR, externalId: e.externalId } };
            if (e.status === "cancelled") {
              const res = await tx.event.updateMany({
                where: { userId, provider: GOOGLE_CALENDAR, externalId: e.externalId, deletedAt: null },
                data: { status: "cancelled", deletedAt: now, lastSyncedAt: now },
              });
              cancelled += res.count;
              continue;
            }
            seen.push(e.externalId);
            const data = { ...e, calendarId: CALENDAR_ID, lastSyncedAt: now, deletedAt: null, verification: "confirmed" };
            await tx.event.upsert({ where: key, create: { userId, provider: GOOGLE_CALENDAR, ...data }, update: data });
            upserted++;
          }
          // Events in the window that Google no longer returns were deleted upstream.
          const removed = await tx.event.updateMany({
            where: {
              userId,
              provider: GOOGLE_CALENDAR,
              deletedAt: null,
              externalId: { notIn: seen },
              OR: [
                { startAt: { gte: timeMin, lt: timeMax } },
                { startDate: { gte: timeMin, lt: timeMax } },
              ],
            },
            data: { deletedAt: now, status: "cancelled" },
          });
          return { upserted, cancelled, removed: removed.count };
        });

        await prisma.integration.update({
          where: { id: integration.id },
          data: { status: "connected", lastSyncAt: now, lastSuccessAt: now, lastError: null, lastErrorAt: null },
        });
        await audit({ userId, actor: "sync", action: "calendar.sync", entityType: "Integration", entityId: integration.id, metadata: { fetched: raw.length, ...result } });
        return { ok: true as const, fetched: raw.length, ...result };
      },
    );
  } catch (err) {
    const message = errorMessage(err);
    await prisma.integration.update({
      where: { id: integration.id },
      data: {
        status: needsReauth(err, opts) ? "reauth_required" : "error",
        lastSyncAt: now,
        lastError: opts.simulateFailure ? `[Simulated failure] ${message}` : message,
        lastErrorAt: now,
      },
    });
    return { ok: false, error: message };
  }
}

function needsReauth(err: unknown, opts: SyncOptions): boolean {
  if (err instanceof ReauthRequiredError) return true;
  return !opts.simulateFailure && err instanceof GoogleApiError && err.status === 401;
}
