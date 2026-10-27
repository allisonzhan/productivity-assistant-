import { prisma } from "@/server/db";
import { encrypt } from "@/server/crypto";

export const hasDb = !!process.env.TEST_DATABASE_URL;

export async function resetDb() {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (tables.length) {
    await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} CASCADE`);
  }
}

let n = 0;
export async function makeUser(opts: { phone?: string | null; timezone?: string } = {}) {
  n++;
  return prisma.user.create({
    data: {
      email: `user${n}-${Date.now()}@example.test`,
      googleSubject: `sub-${n}-${Date.now()}`,
      timezone: opts.timezone ?? "America/New_York",
      phoneE164: opts.phone ?? null,
      phoneVerifiedAt: opts.phone ? new Date() : null,
    },
  });
}

export const GMAIL_SCOPES = "https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly";

export async function connectGoogle(userId: string, opts: { expiresAt?: Date; refreshToken?: string | null; scope?: string } = {}) {
  return prisma.integration.create({
    data: {
      userId,
      provider: "google_calendar",
      credential: {
        create: {
          accessTokenEnc: encrypt("valid-access-token"),
          refreshTokenEnc: opts.refreshToken === null ? null : encrypt(opts.refreshToken ?? "refresh-token"),
          expiresAt: opts.expiresAt ?? new Date(Date.now() + 3600_000),
          scope: opts.scope ?? "openid https://www.googleapis.com/auth/calendar.readonly",
        },
      },
    },
  });
}

export function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
