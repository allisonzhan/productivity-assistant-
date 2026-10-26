import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { syncGoogleCalendar } from "@/server/sync/google-calendar-sync";
import { connectGoogle, hasDb, jsonResponse, makeUser, resetDb } from "../helpers";

const NOW = new Date("2026-10-25T14:00:00Z");

const lecture = {
  id: "evt_lecture_1",
  status: "confirmed",
  summary: "CS 101 Lecture",
  htmlLink: "https://www.google.com/calendar/event?eid=abc",
  start: { dateTime: "2026-10-26T09:30:00-04:00" },
  end: { dateTime: "2026-10-26T10:45:00-04:00" },
};

function fakeGoogle(items: unknown[]) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL) => {
    calls.push(String(url));
    return jsonResponse({ items });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe.skipIf(!hasDb)("Google Calendar sync", () => {
  beforeEach(resetDb);

  it("imports events with their external ID and never duplicates on repeat sync", async () => {
    const user = await makeUser();
    await connectGoogle(user.id);
    const google = fakeGoogle([lecture]);

    const first = await syncGoogleCalendar(user.id, { fetchImpl: google.fetchImpl, now: NOW });
    const second = await syncGoogleCalendar(user.id, { fetchImpl: google.fetchImpl, now: NOW });
    expect(first).toMatchObject({ ok: true, upserted: 1 });
    expect(second).toMatchObject({ ok: true, upserted: 1 });

    const events = await prisma.event.findMany({ where: { userId: user.id } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ externalId: "evt_lecture_1", title: "CS 101 Lecture", provider: "google_calendar" });
    expect(events[0].startAt?.toISOString()).toBe("2026-10-26T13:30:00.000Z");
    expect(google.calls[0]).toContain("singleEvents=true");

    const integration = await prisma.integration.findFirstOrThrow({ where: { userId: user.id } });
    expect(integration).toMatchObject({ status: "connected", lastError: null });
    expect(integration.lastSuccessAt?.toISOString()).toBe(NOW.toISOString());
  });

  it("soft-deletes events cancelled or removed upstream", async () => {
    const user = await makeUser();
    await connectGoogle(user.id);
    const other = { ...lecture, id: "evt_other", summary: "Office hours" };
    await syncGoogleCalendar(user.id, { fetchImpl: fakeGoogle([lecture, other]).fetchImpl, now: NOW });

    await syncGoogleCalendar(user.id, { fetchImpl: fakeGoogle([{ id: "evt_lecture_1", status: "cancelled" }]).fetchImpl, now: NOW });
    const live = await prisma.event.findMany({ where: { userId: user.id, deletedAt: null } });
    expect(live).toHaveLength(0);
    expect(await prisma.event.count({ where: { userId: user.id } })).toBe(2);
  });

  it("records a visible error on provider failure and recovers on retry", async () => {
    const user = await makeUser();
    await connectGoogle(user.id);
    const failing = (async () => jsonResponse({ error: { message: "Invalid Credentials" } }, 401)) as unknown as typeof fetch;

    const failed = await syncGoogleCalendar(user.id, { fetchImpl: failing, now: NOW, simulateFailure: true });
    expect(failed.ok).toBe(false);
    let integration = await prisma.integration.findFirstOrThrow({ where: { userId: user.id } });
    expect(integration.status).toBe("error");
    expect(integration.lastError).toContain("[Simulated failure] Google Calendar API 401");
    const job = await prisma.jobExecution.findFirstOrThrow({ where: { userId: user.id, type: "calendar_sync" } });
    expect(job.status).toBe("failed");

    const retried = await syncGoogleCalendar(user.id, { fetchImpl: fakeGoogle([lecture]).fetchImpl, now: NOW });
    expect(retried.ok).toBe(true);
    integration = await prisma.integration.findFirstOrThrow({ where: { userId: user.id } });
    expect(integration).toMatchObject({ status: "connected", lastError: null });
  });

  it("marks the integration reauth_required when the refresh token is revoked", async () => {
    const user = await makeUser();
    await connectGoogle(user.id, { expiresAt: new Date(Date.now() - 1000) });
    const revoked = (async () => jsonResponse({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400)) as unknown as typeof fetch;

    const res = await syncGoogleCalendar(user.id, { fetchImpl: revoked, now: NOW });
    expect(res.ok).toBe(false);
    const integration = await prisma.integration.findFirstOrThrow({ where: { userId: user.id } });
    expect(integration.status).toBe("reauth_required");
  });

  it("retries transient 5xx errors with a bound", async () => {
    const user = await makeUser();
    await connectGoogle(user.id);
    let calls = 0;
    const flaky = (async () => (++calls < 2 ? jsonResponse({}, 503) : jsonResponse({ items: [lecture] }))) as unknown as typeof fetch;
    expect(await syncGoogleCalendar(user.id, { fetchImpl: flaky, now: NOW })).toMatchObject({ ok: true });
    expect(calls).toBe(2);

    let down = 0;
    const alwaysDown = (async () => (down++, jsonResponse({}, 500))) as unknown as typeof fetch;
    expect(await syncGoogleCalendar(user.id, { fetchImpl: alwaysDown, now: NOW })).toMatchObject({ ok: false });
    expect(down).toBe(3);
  });

  it("keeps each user's events isolated", async () => {
    const a = await makeUser();
    const b = await makeUser();
    await connectGoogle(a.id);
    await connectGoogle(b.id);
    await syncGoogleCalendar(a.id, { fetchImpl: fakeGoogle([lecture]).fetchImpl, now: NOW });
    await syncGoogleCalendar(b.id, { fetchImpl: fakeGoogle([lecture]).fetchImpl, now: NOW });
    expect(await prisma.event.count({ where: { userId: a.id } })).toBe(1);
    expect(await prisma.event.count({ where: { userId: b.id } })).toBe(1);
  });
});
