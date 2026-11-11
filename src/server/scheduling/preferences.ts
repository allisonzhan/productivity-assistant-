import { z } from "zod";
import type { UserPreference } from "@prisma/client";
import { prisma } from "@/server/db";
import { audit } from "@/server/audit/log";
import { isValidZone } from "@/server/time";
import { DEFAULT_PREFS, TIME_RE, type SchedulePrefs } from "@/server/scheduling/due";

export class PreferencesError extends Error {}

export function toSchedulePrefs(pref: UserPreference | null): SchedulePrefs {
  if (!pref) return DEFAULT_PREFS;
  return {
    morningEnabled: pref.morningEnabled,
    morningTime: pref.morningTime,
    eveningEnabled: pref.eveningEnabled,
    eveningTime: pref.eveningTime,
    quietHoursStart: pref.quietHoursStart,
    quietHoursEnd: pref.quietHoursEnd,
  };
}

export async function getSchedulePrefs(userId: string): Promise<SchedulePrefs> {
  return toSchedulePrefs(await prisma.userPreference.findUnique({ where: { userId } }));
}

const time = z.string().regex(TIME_RE, "Times must be HH:MM (24-hour).");
const optionalTime = z.preprocess((v) => (v === "" || v == null ? null : v), time.nullable());

export const preferencesInput = z
  .object({
    timezone: z.string().refine(isValidZone, "Unknown timezone. Use an IANA name like America/New_York."),
    morningEnabled: z.boolean(),
    morningTime: time,
    eveningEnabled: z.boolean(),
    eveningTime: time,
    quietHoursStart: optionalTime,
    quietHoursEnd: optionalTime,
  })
  .refine((p) => (p.quietHoursStart === null) === (p.quietHoursEnd === null), "Set both quiet-hours times, or neither.");

export async function savePreferences(userId: string, input: unknown) {
  const parsed = preferencesInput.safeParse(input);
  if (!parsed.success) throw new PreferencesError(parsed.error.issues.map((i) => i.message).join(" "));
  const { timezone, ...prefs } = parsed.data;
  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: userId }, data: { timezone } });
    await tx.userPreference.upsert({ where: { userId }, create: { userId, ...prefs }, update: prefs });
    await audit({ userId, actor: "user", action: "preferences.update", metadata: { timezone, ...prefs } }, tx);
  });
  return parsed.data;
}
