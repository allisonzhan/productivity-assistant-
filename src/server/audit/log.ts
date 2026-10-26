import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/server/db";

type Db = PrismaClient | Prisma.TransactionClient;

export function audit(
  entry: {
    userId: string;
    actor: "user" | "sms" | "sync" | "system";
    action: string;
    entityType?: string;
    entityId?: string;
    metadata?: Prisma.InputJsonValue;
  },
  db: Db = prisma,
) {
  return db.auditLog.create({ data: entry });
}
