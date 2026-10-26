import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { generateBriefing } from "@/server/briefings/generate";
import { BriefingSendError, sendBriefingSms } from "@/server/briefings/send";
import { applyStatusCallback, sendSms } from "@/server/delivery/sms";
import { twilioProvider } from "@/server/sms/provider";
import { computeTwilioSignature } from "@/server/sms/signature";
import { POST as statusWebhook } from "@/app/api/webhooks/twilio/status/route";
import { isoToDateOnly } from "@/server/time";
import { hasDb, jsonResponse, makeUser, resetDb } from "../helpers";

const PHONE = "+15551230001";

describe.skipIf(!hasDb)("briefing generation and delivery", () => {
  beforeEach(resetDb);

  it("generates the briefing from stored events and tasks and snapshots it", async () => {
    const user = await makeUser({ phone: PHONE });
    const now = new Date("2026-10-25T14:00:00Z");
    await prisma.event.create({
      data: { userId: user.id, provider: "google_calendar", calendarId: "primary", externalId: "e1", title: "CS 101 Lecture", startAt: new Date("2026-10-25T17:00:00Z") },
    });
    await prisma.task.create({ data: { userId: user.id, title: "Finish reading", dueDate: isoToDateOnly("2026-10-30") } });

    const briefing = await generateBriefing(user.id, "adhoc", now);
    expect(briefing.content).toContain("TODAY: 1:00pm CS 101 Lecture");
    expect(briefing.content).toContain("Fri 1 due");
    expect(JSON.stringify(briefing.snapshot)).toContain("Finish reading");
  });

  it("records simulated sends, failures and bounded retries honestly", async () => {
    const user = await makeUser({ phone: PHONE });
    const briefing = await generateBriefing(user.id, "adhoc");

    const failed = await sendBriefingSms(user.id, briefing.id, { simulateFailure: true });
    expect(failed).toMatchObject({ status: "failed", attempt: 1, provider: "simulator" });
    expect(failed.error).toContain("Simulated provider failure");

    const retried = await sendBriefingSms(user.id, briefing.id);
    expect(retried).toMatchObject({ status: "simulated", attempt: 2 });
    await expect(sendBriefingSms(user.id, briefing.id)).rejects.toThrow(BriefingSendError);
  });

  it("refuses to send without a verified phone or after opt-out", async () => {
    const noPhone = await makeUser();
    const b1 = await generateBriefing(noPhone.id, "adhoc");
    await expect(sendBriefingSms(noPhone.id, b1.id)).rejects.toThrow("Verify your phone");

    const optedOut = await makeUser({ phone: PHONE });
    await prisma.user.update({ where: { id: optedOut.id }, data: { smsOptOut: true } });
    const b2 = await generateBriefing(optedOut.id, "adhoc");
    await expect(sendBriefingSms(optedOut.id, b2.id)).rejects.toThrow("STOP");
  });

  it("cannot send another user's briefing", async () => {
    const a = await makeUser({ phone: PHONE });
    const b = await makeUser({ phone: "+15551230002" });
    const briefing = await generateBriefing(a.id, "adhoc");
    await expect(sendBriefingSms(b.id, briefing.id)).rejects.toThrow("Briefing not found");
  });

  it("Twilio: 'accepted' on API success, then only signed callbacks advance status, never backwards", async () => {
    const user = await makeUser({ phone: PHONE });
    let sentForm: URLSearchParams | undefined;
    const provider = twilioProvider({
      accountSid: "ACtest",
      authToken: "test-auth-token",
      from: "+15555550100",
      fetchImpl: (async (_url: string, init: RequestInit) => {
        sentForm = init.body as URLSearchParams;
        return jsonResponse({ sid: "SMabc", status: "queued" }, 201);
      }) as unknown as typeof fetch,
    });
    const attempt = await sendSms({ userId: user.id, to: PHONE, body: "hi", purpose: "briefing", provider });
    expect(attempt).toMatchObject({ status: "accepted", providerMessageId: "SMabc" });
    expect(sentForm?.get("StatusCallback")).toBe("https://pa.example.test/api/webhooks/twilio/status");

    const url = "https://pa.example.test/api/webhooks/twilio/status";
    const callback = (params: Record<string, string>, sig?: string) =>
      statusWebhook(
        new Request("http://localhost:3000/api/webhooks/twilio/status", {
          method: "POST",
          headers: { "x-twilio-signature": sig ?? computeTwilioSignature("test-auth-token", url, params) },
          body: new URLSearchParams(params),
        }),
      );
    expect((await callback({ MessageSid: "SMabc", MessageStatus: "delivered" }, "forged")).status).toBe(403);
    expect((await prisma.deliveryAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).status).toBe("accepted");

    expect((await callback({ MessageSid: "SMabc", MessageStatus: "delivered" })).status).toBe(204);
    await callback({ MessageSid: "SMabc", MessageStatus: "sent" }); // late, out of order
    expect((await prisma.deliveryAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).status).toBe("delivered");
  });

  it("Twilio: API rejection is recorded as failed, never as sent", async () => {
    const user = await makeUser({ phone: PHONE });
    const provider = twilioProvider({
      accountSid: "ACtest",
      authToken: "t",
      from: "+15555550100",
      fetchImpl: (async () => jsonResponse({ code: 21212, message: "The 'From' number +10000000000 is not a valid phone number" }, 400)) as unknown as typeof fetch,
    });
    const attempt = await sendSms({ userId: user.id, to: PHONE, body: "hi", purpose: "briefing", provider, simulateFailure: true });
    expect(attempt.status).toBe("failed");
    expect(attempt.error).toContain("Twilio 400");
    expect(await applyStatusCallback({ messageSid: "unknown", status: "delivered" })).toMatchObject({ updated: false });
  });
});
