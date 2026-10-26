import { randomInt } from "node:crypto";
import { prisma } from "@/server/db";
import { safeEqual, sha256 } from "@/server/crypto";
import { sendSms } from "@/server/delivery/sms";
import { audit } from "@/server/audit/log";

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_CODES_PER_HOUR = 5;
const MAX_ATTEMPTS = 5;

export class PhoneVerificationError extends Error {}

/** Normalizes US-style input to E.164; accepts already-E.164 numbers as-is. */
export function normalizePhone(input: string): string | null {
  const trimmed = input.trim();
  if (/^\+[1-9]\d{7,14}$/.test(trimmed)) return trimmed;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

function hashCode(userId: string, code: string) {
  return sha256(`${userId}:${code}`);
}

export async function startPhoneVerification(userId: string, rawPhone: string) {
  const phone = normalizePhone(rawPhone);
  if (!phone) throw new PhoneVerificationError("Enter a valid phone number, e.g. +1 555 555 0100.");
  const owner = await prisma.user.findFirst({ where: { phoneE164: phone, NOT: { id: userId } } });
  if (owner) throw new PhoneVerificationError("That number is linked to another account.");
  const recent = await prisma.phoneVerification.count({
    where: { userId, createdAt: { gte: new Date(Date.now() - 60 * 60 * 1000) } },
  });
  if (recent >= MAX_CODES_PER_HOUR) throw new PhoneVerificationError("Too many codes requested. Try again in an hour.");

  const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
  await prisma.phoneVerification.create({
    data: { userId, phoneE164: phone, codeHash: hashCode(userId, code), expiresAt: new Date(Date.now() + CODE_TTL_MS) },
  });
  const attempt = await sendSms({
    userId,
    to: phone,
    body: `Your Productive Assistant code is ${code}. Reply STOP to opt out.`,
    purpose: "verification",
  });
  if (attempt.status === "failed") throw new PhoneVerificationError(`Could not send the code: ${attempt.error}`);
  return { phone, provider: attempt.provider };
}

export async function confirmPhoneVerification(userId: string, code: string) {
  const pending = await prisma.phoneVerification.findFirst({
    where: { userId, usedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });
  if (!pending) throw new PhoneVerificationError("No active code. Request a new one.");
  if (pending.attempts >= MAX_ATTEMPTS) throw new PhoneVerificationError("Too many wrong attempts. Request a new code.");
  if (!safeEqual(pending.codeHash, hashCode(userId, code.trim()))) {
    await prisma.phoneVerification.update({ where: { id: pending.id }, data: { attempts: { increment: 1 } } });
    throw new PhoneVerificationError("That code is not correct.");
  }
  await prisma.$transaction([
    prisma.phoneVerification.update({ where: { id: pending.id }, data: { usedAt: new Date() } }),
    prisma.user.update({ where: { id: userId }, data: { phoneE164: pending.phoneE164, phoneVerifiedAt: new Date(), smsOptOut: false } }),
  ]);
  await audit({ userId, actor: "user", action: "phone.verified", metadata: { phone: pending.phoneE164 } });
  return pending.phoneE164;
}
