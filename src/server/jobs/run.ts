import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/db";

/**
 * Records every background-style operation in JobExecution so failures are visible and
 * auditable. Gate 2 moves scheduling onto a durable queue; this wrapper stays the same.
 */
export async function runJob<T>(
  job: { type: string; userId?: string; metadata?: Prisma.InputJsonValue },
  fn: () => Promise<T>,
): Promise<T> {
  const exec = await prisma.jobExecution.create({
    data: { type: job.type, userId: job.userId, metadata: job.metadata },
  });
  try {
    const result = await fn();
    await prisma.jobExecution.update({
      where: { id: exec.id },
      data: { status: "succeeded", finishedAt: new Date() },
    });
    return result;
  } catch (err) {
    await prisma.jobExecution.update({
      where: { id: exec.id },
      data: { status: "failed", finishedAt: new Date(), error: errorMessage(err) },
    });
    throw err;
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
