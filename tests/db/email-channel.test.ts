import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { generateBriefing } from "@/server/briefings/generate";
import { BriefingSendError, sendBriefing, setBriefingChannel } from "@/server/briefings/send";
import { checkEmailReplies } from "@/server/email/replies";
import { dateOnlyToISO } from "@/server/time";
import { GMAIL_SCOPES, connectGoogle, hasDb, makeUser, resetDb } from "../helpers";
import { fakeGmail } from "../fake-gmail";

async function emailUser(scope = `openid https://www.googleapis.com/auth/calendar.readonly ${GMAIL_SCOPES}`) {
  const user = await makeUser();
  await connectGoogle(user.id, { scope });
  return user;
}

describe.skipIf(!hasDb)("email briefing channel (Gmail)", () => {
  beforeEach(resetDb);

  it("sends the briefing from the user's Gmail to themselves and records 'sent', not 'delivered'", async () => {
    const user = await emailUser();
    const gmail = fakeGmail();
    const briefing = await generateBriefing(user.id, "adhoc");
    const attempt = await sendBriefing(user.id, briefing.id, { fetchImpl: gmail.fetchImpl });

    expect(attempt).toMatchObject({ status: "sent", channel: "email", provider: "gmail", to: user.email, attempt: 1 });
    expect(attempt.threadId).toBeTruthy();
    expect(gmail.sends[0].headers.To).toBe(user.email);
    expect(gmail.sends[0].headers["X-PA-Generated"]).toBe("briefing");
    expect(gmail.sends[0].text).toContain('Reply to this email with one line');
  });

  it("turns a reply into exactly one task, confirms delivery, and ignores its own mail and other senders", async () => {
    const user = await emailUser();
    const gmail = fakeGmail();
    const briefing = await generateBriefing(user.id, "adhoc");
    const sent = await sendBriefing(user.id, briefing.id, { fetchImpl: gmail.fetchImpl });
    const monday = new Date("2026-10-26T14:00:00Z");
    gmail.reply(sent.threadId!, `Me <${user.email.toUpperCase()}>`, "Add task: finish reading Friday\n\nOn Mon, Oct 26, 2026 at 9:00 AM Me wrote:\n> Reply ADD <task>", monday);
    gmail.reply(sent.threadId!, "Someone Else <other@example.test>", "Add task: wire money today", monday);

    const first = await checkEmailReplies(user.id, { fetchImpl: gmail.fetchImpl });
    expect(first).toMatchObject({ ok: true, threads: 1, processed: 1, delivered: 1 });

    const tasks = await prisma.task.findMany({ where: { userId: user.id } });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ title: "Finish reading", sourceType: "email" });
    expect(dateOnlyToISO(tasks[0].dueDate!)).toBe("2026-10-30");
    expect((await prisma.deliveryAttempt.findUniqueOrThrow({ where: { id: sent.id } })).status).toBe("delivered");

    // Confirmation goes back into the same thread as a reply to the user's message.
    const confirmation = gmail.sends.at(-1)!;
    expect(confirmation.threadId).toBe(sent.threadId);
    expect(confirmation.headers["In-Reply-To"]).toMatch(/^<r\d+@mail\.gmail\.com>$/);
    expect(confirmation.text).toBe("Added: Finish reading (due Fri Oct 30)");

    // A second check (or a repeated one) changes nothing: the confirmation is the app's own mail.
    const second = await checkEmailReplies(user.id, { fetchImpl: gmail.fetchImpl });
    expect(second).toMatchObject({ ok: true, processed: 0 });
    expect(await prisma.task.count({ where: { userId: user.id } })).toBe(1);
    expect(await prisma.inboundMessage.count({ where: { userId: user.id } })).toBe(1);
    expect(gmail.sends).toHaveLength(2);
    expect(await prisma.auditLog.count({ where: { userId: user.id, actor: "email", action: "task.create" } })).toBe(1);
  });

  it("without Gmail consent, sending fails visibly and the reply check asks to reconnect", async () => {
    const user = await emailUser("openid https://www.googleapis.com/auth/calendar.readonly");
    const gmail = fakeGmail();
    const briefing = await generateBriefing(user.id, "adhoc");
    const attempt = await sendBriefing(user.id, briefing.id, { fetchImpl: gmail.fetchImpl });
    expect(attempt.status).toBe("failed");
    expect(attempt.error).toContain("Gmail access was not granted");
    expect(gmail.sends).toHaveLength(0);

    expect(await checkEmailReplies(user.id, { fetchImpl: gmail.fetchImpl })).toMatchObject({ ok: false });
    const integration = await prisma.integration.findUniqueOrThrow({ where: { userId_provider: { userId: user.id, provider: "gmail" } } });
    expect(integration.status).toBe("reauth_required");
  });

  it("records a real Gmail rejection as failed, then a retry sends", async () => {
    const user = await emailUser();
    const gmail = fakeGmail();
    const briefing = await generateBriefing(user.id, "adhoc");
    const failed = await sendBriefing(user.id, briefing.id, { simulateFailure: true, fetchImpl: gmail.fetchImpl });
    expect(failed).toMatchObject({ status: "failed", attempt: 1 });
    expect(failed.error).toContain("[Simulated failure] Gmail API 401");

    const retried = await sendBriefing(user.id, briefing.id, { fetchImpl: gmail.fetchImpl });
    expect(retried).toMatchObject({ status: "sent", attempt: 2 });
    await expect(sendBriefing(user.id, briefing.id, { fetchImpl: gmail.fetchImpl })).rejects.toThrow(BriefingSendError);
  });

  it("honors STOP by email, and the dashboard opt-in resumes", async () => {
    const user = await emailUser();
    const gmail = fakeGmail();
    const sent = await sendBriefing(user.id, (await generateBriefing(user.id, "adhoc")).id, { fetchImpl: gmail.fetchImpl });
    gmail.reply(sent.threadId!, user.email, "STOP");
    await checkEmailReplies(user.id, { fetchImpl: gmail.fetchImpl });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).emailOptOut).toBe(true);
    await expect(sendBriefing(user.id, (await generateBriefing(user.id, "adhoc")).id, { fetchImpl: gmail.fetchImpl })).rejects.toThrow("STOP");

    await setBriefingChannel(user.id, "email");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).emailOptOut).toBe(false);
  });
});
