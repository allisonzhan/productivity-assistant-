import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { computeTwilioSignature } from "@/server/sms/signature";
import { handleInboundSms } from "@/server/sms/inbound";
import { POST as smsWebhook } from "@/app/api/webhooks/twilio/sms/route";
import { dateOnlyToISO } from "@/server/time";
import { hasDb, makeUser, resetDb } from "../helpers";

const PHONE = "+15551230001";
const WEBHOOK_URL = "https://pa.example.test/api/webhooks/twilio/sms";

function twilioRequest(params: Record<string, string>, opts: { signature?: string } = {}) {
  const signature = opts.signature ?? computeTwilioSignature("test-auth-token", WEBHOOK_URL, params);
  // Arrives on localhost behind a tunnel; validation must use PUBLIC_URL.
  return new Request("http://localhost:3000/api/webhooks/twilio/sms", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signature },
    body: new URLSearchParams(params),
  });
}

const addTask = { MessageSid: "SM00000000000000000000000000000001", From: PHONE, To: "+15555550100", Body: "Add task: finish reading Friday" };

describe.skipIf(!hasDb)("Twilio inbound SMS webhook", () => {
  beforeEach(resetDb);

  it("verifies the signature and creates the task exactly once across duplicate deliveries", async () => {
    const user = await makeUser({ phone: PHONE });

    const first = await smsWebhook(twilioRequest(addTask));
    const replay = await smsWebhook(twilioRequest(addTask));
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(await first.text()).toContain("<Response>");

    const tasks = await prisma.task.findMany({ where: { userId: user.id } });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ title: "Finish reading", sourceType: "sms", status: "open" });
    expect(tasks[0].dueDate).not.toBeNull();
    expect(new Date(dateOnlyToISO(tasks[0].dueDate!)).getUTCDay()).toBe(5); // a Friday

    expect(await prisma.inboundMessage.count()).toBe(1);
    // One confirmation reply (simulator provider in tests), not two.
    const replies = await prisma.deliveryAttempt.findMany({ where: { userId: user.id, purpose: "reply" } });
    expect(replies).toHaveLength(1);
    expect(replies[0].body).toMatch(/^Added: Finish reading \(due Fri /);
    expect(await prisma.auditLog.count({ where: { userId: user.id, action: "task.create" } })).toBe(1);
  });

  it("rejects invalid signatures without side effects", async () => {
    await makeUser({ phone: PHONE });
    const forged = await smsWebhook(twilioRequest(addTask, { signature: "bm90LWEtcmVhbC1zaWduYXR1cmU=" }));
    expect(forged.status).toBe(403);
    const tampered = twilioRequest(addTask, { signature: computeTwilioSignature("test-auth-token", WEBHOOK_URL, { ...addTask, Body: "hi" }) });
    expect((await smsWebhook(tampered)).status).toBe(403);
    expect(await prisma.inboundMessage.count()).toBe(0);
    expect(await prisma.task.count()).toBe(0);
  });

  it("ignores unknown and unverified numbers", async () => {
    const unverified = await makeUser();
    await prisma.user.update({ where: { id: unverified.id }, data: { phoneE164: "+15551230009" } }); // no phoneVerifiedAt
    await smsWebhook(twilioRequest({ ...addTask, From: "+15551230009" }));
    await smsWebhook(twilioRequest({ ...addTask, MessageSid: "SM2", From: "+19998887777" }));
    expect(await prisma.task.count()).toBe(0);
    expect(await prisma.inboundMessage.count({ where: { status: "ignored" } })).toBe(2);
  });

  it("creates tasks only for the account that owns the sending number", async () => {
    const a = await makeUser({ phone: PHONE });
    const b = await makeUser({ phone: "+15551230002" });
    await smsWebhook(twilioRequest({ ...addTask, From: "+15551230002", MessageSid: "SM-b" }));
    expect(await prisma.task.count({ where: { userId: a.id } })).toBe(0);
    expect(await prisma.task.count({ where: { userId: b.id } })).toBe(1);
  });

  it("honors STOP and START", async () => {
    const user = await makeUser({ phone: PHONE });
    await handleInboundSms({ provider: "twilio", providerMessageId: "SM-stop", from: PHONE, body: "STOP" });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).smsOptOut).toBe(true);

    await handleInboundSms({ provider: "twilio", providerMessageId: "SM-add", from: PHONE, body: "Add task: x" });
    expect(await prisma.task.count()).toBe(0);

    await handleInboundSms({ provider: "twilio", providerMessageId: "SM-start", from: PHONE, body: "START" });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).smsOptOut).toBe(false);
  });

  it("asks for clarification on ambiguous dates instead of creating a task", async () => {
    await makeUser({ phone: PHONE });
    const res = await handleInboundSms({ provider: "twilio", providerMessageId: "SM-amb", from: PHONE, body: "Add task: essay next friday" });
    expect(res.reply).toContain("could mean two different days");
    expect(await prisma.task.count()).toBe(0);
  });

  it("rate-limits floods from one number", async () => {
    await makeUser({ phone: PHONE });
    const now = new Date();
    for (let i = 0; i < 12; i++) {
      await handleInboundSms({ provider: "twilio", providerMessageId: `SM-flood-${i}`, from: PHONE, body: `Add task: t${i}` }, { now, sendReply: false });
    }
    expect(await prisma.task.count()).toBe(10);
    expect(await prisma.inboundMessage.count({ where: { command: "rate_limited" } })).toBe(2);
  });
});
