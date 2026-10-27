"use server";

import { revalidatePath } from "next/cache";
import { randomUUID } from "node:crypto";
import { requireUser } from "@/server/auth/session";
import { env } from "@/server/env";
import { syncGoogleCalendar } from "@/server/sync/google-calendar-sync";
import { generateBriefing } from "@/server/briefings/generate";
import { BriefingSendError, sendBriefing, setBriefingChannel } from "@/server/briefings/send";
import { PhoneVerificationError, confirmPhoneVerification, startPhoneVerification } from "@/server/phone/verification";
import { handleInboundSms } from "@/server/sms/inbound";
import { checkEmailReplies } from "@/server/email/replies";
import { setTaskStatus } from "@/server/tasks/service";
import { errorMessage } from "@/server/jobs/run";
import { PreferencesError, savePreferences } from "@/server/scheduling/preferences";

export type FormState = { ok?: boolean; message?: string; messageId?: string };

// Every action derives userId from the session; nothing user-identifying comes from the client.

export async function syncCalendarAction(formData: FormData) {
  const user = await requireUser();
  await syncGoogleCalendar(user.id, { simulateFailure: formData.get("simulateFailure") === "1" });
  revalidatePath("/");
}

export async function sendBriefingAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  try {
    const briefing = await generateBriefing(user.id, "adhoc");
    const attempt = await sendBriefing(user.id, briefing.id, { simulateFailure: formData.get("simulateFailure") === "1" });
    revalidatePath("/");
    if (attempt.status === "failed") return { ok: false, message: `Send failed: ${attempt.error}` };
    const sent = {
      simulator: "Briefing recorded in the SIMULATED outbox.",
      twilio: "Twilio accepted the briefing. Waiting for its delivery report.",
      gmail: `Gmail sent the briefing to ${attempt.to}. Reply to it, then choose "Check for replies".`,
    };
    return { ok: true, message: sent[attempt.provider as keyof typeof sent] ?? `Status: ${attempt.status}` };
  } catch (err) {
    revalidatePath("/");
    return { ok: false, message: err instanceof BriefingSendError ? err.message : `Error: ${errorMessage(err)}` };
  }
}

export async function retryBriefingAction(formData: FormData) {
  const user = await requireUser();
  const briefingId = String(formData.get("briefingId") ?? "");
  try {
    await sendBriefing(user.id, briefingId);
  } catch (err) {
    if (!(err instanceof BriefingSendError)) throw err;
  }
  revalidatePath("/");
}

export async function checkEmailRepliesAction(): Promise<FormState> {
  const user = await requireUser();
  const result = await checkEmailReplies(user.id);
  revalidatePath("/");
  if (!result.ok) return { ok: false, message: `Reply check failed: ${result.error}` };
  if (result.threads === 0) return { ok: true, message: "No briefing emails from the last 7 days to check." };
  return { ok: true, message: `Checked ${result.threads} briefing thread(s): ${result.processed} new repl${result.processed === 1 ? "y" : "ies"} handled.` };
}

export async function savePreferencesAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  try {
    await savePreferences(user.id, {
      timezone: String(formData.get("timezone") ?? "").trim(),
      morningEnabled: formData.get("morningEnabled") === "on",
      morningTime: String(formData.get("morningTime") ?? ""),
      eveningEnabled: formData.get("eveningEnabled") === "on",
      eveningTime: String(formData.get("eveningTime") ?? ""),
      quietHoursStart: String(formData.get("quietHoursStart") ?? ""),
      quietHoursEnd: String(formData.get("quietHoursEnd") ?? ""),
    });
    revalidatePath("/");
    return { ok: true, message: "Saved." };
  } catch (err) {
    return { ok: false, message: err instanceof PreferencesError ? err.message : `Error: ${errorMessage(err)}` };
  }
}

export async function setBriefingChannelAction(formData: FormData) {
  const user = await requireUser();
  await setBriefingChannel(user.id, formData.get("channel") === "sms" ? "sms" : "email");
  revalidatePath("/");
}

export async function startPhoneAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  try {
    const { phone, provider } = await startPhoneVerification(user.id, String(formData.get("phone") ?? ""));
    revalidatePath("/");
    return {
      ok: true,
      message: provider === "simulator" ? `SIMULATED: code for ${phone} is in the simulated outbox below.` : `Code sent to ${phone}.`,
    };
  } catch (err) {
    return { ok: false, message: err instanceof PhoneVerificationError ? err.message : `Error: ${errorMessage(err)}` };
  }
}

export async function confirmPhoneAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  try {
    const phone = await confirmPhoneVerification(user.id, String(formData.get("code") ?? ""));
    revalidatePath("/");
    return { ok: true, message: `${phone} verified.` };
  } catch (err) {
    return { ok: false, message: err instanceof PhoneVerificationError ? err.message : `Error: ${errorMessage(err)}` };
  }
}

/** Local development only: feeds a message through the same handler as the Twilio webhook. */
export async function simulateInboundAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  if (env().SMS_PROVIDER !== "simulator") return { ok: false, message: "The simulator is disabled when SMS_PROVIDER=twilio." };
  if (!user.phoneE164 || !user.phoneVerifiedAt) return { ok: false, message: "Verify a phone number first." };
  const replayId = String(formData.get("replayId") ?? "");
  const messageId = formData.get("replay") === "1" && replayId ? replayId : `SIM-IN-${randomUUID()}`;
  const result = await handleInboundSms({
    provider: "simulator",
    providerMessageId: messageId,
    from: user.phoneE164,
    body: String(formData.get("body") ?? ""),
  });
  revalidatePath("/");
  return {
    ok: true,
    messageId,
    message: result.duplicate
      ? `Duplicate message ID ${messageId}: ignored, nothing created.`
      : `Processed ${messageId}${result.reply ? `. Reply: ${result.reply}` : ""}`,
  };
}

export async function setTaskStatusAction(formData: FormData) {
  const user = await requireUser();
  const status = formData.get("status") === "done" ? "done" : "open";
  await setTaskStatus(user.id, String(formData.get("taskId") ?? ""), status);
  revalidatePath("/");
}
