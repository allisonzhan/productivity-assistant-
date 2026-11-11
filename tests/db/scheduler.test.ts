import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { setBriefingChannel } from "@/server/briefings/send";
import { checkAllEmailReplies, schedulerTick } from "@/server/scheduling/scheduler";
import { GMAIL_SCOPES, connectGoogle, hasDb, jsonResponse, makeUser, resetDb } from "../helpers";
import { fakeGmail } from "../fake-gmail";

const EIGHT_OH_FIVE = new Date("2026-10-27T12:05:00Z"); // 8:05 AM in New York
const minutes = (d: Date, m: number) => new Date(d.getTime() + m * 60_000);
const gmailDown = (async () => jsonResponse({ error: { message: "Backend Error" } }, 500)) as unknown as typeof fetch;

async function scheduledUser() {
  const user = await makeUser({ timezone: "America/New_York" });
  const integration = await connectGoogle(user.id, { scope: `openid https://www.googleapis.com/auth/calendar.readonly ${GMAIL_SCOPES}` });
  // Fresh data, so the pre-briefing sync is skipped in these tests.
  await prisma.integration.update({ where: { id: integration.id }, data: { lastSyncAt: EIGHT_OH_FIVE } });
  return user;
}

describe.skipIf(!hasDb)("scheduled briefings (worker)", () => {
  beforeEach(resetDb);

  it("sends the morning briefing once, however many ticks or workers run", async () => {
    const user = await scheduledUser();
    const gmail = fakeGmail();

    const first = await schedulerTick(EIGHT_OH_FIVE, { fetchImpl: gmail.fetchImpl });
    expect(first.planned).toBe(1);
    expect(first.processed).toMatchObject([{ status: "sent" }]);
    const again = await Promise.all([
      schedulerTick(minutes(EIGHT_OH_FIVE, 1), { fetchImpl: gmail.fetchImpl }),
      schedulerTick(minutes(EIGHT_OH_FIVE, 1), { fetchImpl: gmail.fetchImpl }),
    ]);
    expect(again.map((t) => t.planned)).toEqual([0, 0]);

    expect(gmail.sends).toHaveLength(1);
    expect(gmail.sends[0].headers.To).toBe(user.email);
    const row = await prisma.scheduledBriefing.findFirstOrThrow({ where: { userId: user.id }, include: { user: false } });
    expect(row).toMatchObject({ kind: "morning", status: "sent", attempts: 1 });
    const briefing = await prisma.briefing.findUniqueOrThrow({ where: { id: row.briefingId! } });
    expect(briefing.kind).toBe("morning");
    expect(await prisma.workerHeartbeat.findUnique({ where: { id: "scheduler" } })).toMatchObject({ lastTickAt: minutes(EIGHT_OH_FIVE, 1) });
  });

  it("retries a failed send with backoff, then gives up visibly", async () => {
    const user = await scheduledUser();
    const t0 = EIGHT_OH_FIVE;

    expect((await schedulerTick(t0, { fetchImpl: gmailDown })).processed).toMatchObject([{ status: "retrying" }]);
    let row = await prisma.scheduledBriefing.findFirstOrThrow({ where: { userId: user.id } });
    expect(row.nextAttemptAt).toEqual(minutes(t0, 5));
    expect(row.error).toContain("Gmail API 500");

    expect((await schedulerTick(minutes(t0, 4), { fetchImpl: gmailDown })).processed).toEqual([]); // not yet
    expect((await schedulerTick(minutes(t0, 5), { fetchImpl: gmailDown })).processed).toMatchObject([{ status: "retrying" }]);
    row = await prisma.scheduledBriefing.findFirstOrThrow({ where: { userId: user.id } });
    expect(row.nextAttemptAt).toEqual(minutes(t0, 15)); // 10 min backoff

    expect((await schedulerTick(minutes(t0, 15), { fetchImpl: gmailDown })).processed).toMatchObject([{ status: "failed" }]);
    expect((await schedulerTick(minutes(t0, 30), { fetchImpl: gmailDown })).processed).toEqual([]);
    expect(await prisma.deliveryAttempt.count({ where: { userId: user.id, status: "failed" } })).toBe(3);
    expect(await prisma.jobExecution.count({ where: { userId: user.id, type: "scheduled_briefing", status: "failed" } })).toBe(3);
  });

  it("recovers after a transient failure", async () => {
    const user = await scheduledUser();
    const gmail = fakeGmail();
    await schedulerTick(EIGHT_OH_FIVE, { fetchImpl: gmailDown });
    expect((await schedulerTick(minutes(EIGHT_OH_FIVE, 5), { fetchImpl: gmail.fetchImpl })).processed).toMatchObject([{ status: "sent" }]);
    expect(gmail.sends).toHaveLength(1);
    expect(await prisma.deliveryAttempt.findMany({ where: { userId: user.id }, orderBy: { attempt: "asc" }, select: { status: true, attempt: true } })).toEqual([
      { status: "failed", attempt: 1 },
      { status: "sent", attempt: 2 },
    ]);
  });

  it("skips (without retrying) when the user opted out", async () => {
    const user = await scheduledUser();
    await prisma.user.update({ where: { id: user.id }, data: { emailOptOut: true } });
    const gmail = fakeGmail();
    expect((await schedulerTick(EIGHT_OH_FIVE, { fetchImpl: gmail.fetchImpl })).processed).toMatchObject([{ status: "skipped" }]);
    expect((await schedulerTick(minutes(EIGHT_OH_FIVE, 10), { fetchImpl: gmail.fetchImpl })).processed).toEqual([]);
    expect(gmail.sends).toHaveLength(0);
  });

  it("never resends after a worker died mid-send", async () => {
    const user = await scheduledUser();
    const gmail = fakeGmail();
    await schedulerTick(EIGHT_OH_FIVE, { fetchImpl: gmail.fetchImpl });
    // Simulate a crash after Gmail accepted the send but before the row was marked sent.
    await prisma.$executeRaw`UPDATE "ScheduledBriefing" SET status = 'sending', "updatedAt" = ${minutes(EIGHT_OH_FIVE, -30)} WHERE "userId" = ${user.id}`;
    expect((await schedulerTick(minutes(EIGHT_OH_FIVE, 1), { fetchImpl: gmail.fetchImpl })).processed).toMatchObject([{ status: "sent" }]);
    expect(gmail.sends).toHaveLength(1);
  });

  it("does nothing outside the window or before the time", async () => {
    await scheduledUser();
    const gmail = fakeGmail();
    expect((await schedulerTick(new Date("2026-10-27T11:59:00Z"), { fetchImpl: gmail.fetchImpl })).planned).toBe(0);
    expect((await schedulerTick(new Date("2026-10-27T16:00:00Z"), { fetchImpl: gmail.fetchImpl })).planned).toBe(0);
  });

  it("checks email replies only for users on the email channel", async () => {
    const emailUser = await scheduledUser();
    const smsUser = await scheduledUser();
    await setBriefingChannel(smsUser.id, "sms");
    const gmail = fakeGmail();
    const results = await checkAllEmailReplies(EIGHT_OH_FIVE, { fetchImpl: gmail.fetchImpl });
    expect(results.map((r) => r.userId)).toEqual([emailUser.id]);
    expect(results[0]).toMatchObject({ ok: true, threads: 0 });
  });
});
