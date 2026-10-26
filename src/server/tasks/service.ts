import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/server/db";
import { isoToDateOnly } from "@/server/time";

type Db = PrismaClient | Prisma.TransactionClient;

export function createTask(
  input: { userId: string; title: string; dueDate?: string | null; sourceType: string; sourceRef?: string },
  db: Db = prisma,
) {
  return db.task.create({
    data: {
      userId: input.userId,
      title: input.title,
      dueDate: input.dueDate ? isoToDateOnly(input.dueDate) : null,
      sourceType: input.sourceType,
      sourceRef: input.sourceRef,
    },
  });
}

export function listOpenTasks(userId: string, db: Db = prisma) {
  return db.task.findMany({
    where: { userId, status: "open", deletedAt: null },
    orderBy: [{ dueDate: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }],
  });
}

export async function setTaskStatus(userId: string, taskId: string, status: "open" | "done") {
  // userId in the filter enforces ownership.
  const res = await prisma.task.updateMany({
    where: { id: taskId, userId, deletedAt: null },
    data: { status, completedAt: status === "done" ? new Date() : null },
  });
  return res.count === 1;
}
