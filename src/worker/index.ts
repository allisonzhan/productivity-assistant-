import { PgBoss } from "pg-boss";
import { env } from "@/server/env";
import { prisma } from "@/server/db";
import { errorMessage } from "@/server/jobs/run";
import { checkAllEmailReplies, recordWorkerStart, schedulerTick, syncAllCalendars } from "@/server/scheduling/scheduler";

/**
 * Background worker (`npm run worker`). pg-boss provides durable cron schedules in Postgres
 * (schema `pgboss`), so several workers can run without double execution. The jobs are thin:
 * all logic lives in idempotent services in src/server/scheduling.
 */

const JOBS: { queue: string; cron: string; run: () => Promise<unknown> }[] = [
  { queue: "scheduler-tick", cron: "* * * * *", run: () => schedulerTick() },
  { queue: "email-reply-check", cron: "*/5 * * * *", run: () => checkAllEmailReplies() },
  { queue: "calendar-sync", cron: "*/15 * * * *", run: () => syncAllCalendars() },
];

function log(message: string, detail?: unknown) {
  console.log(`[worker ${new Date().toISOString()}] ${message}`, detail === undefined ? "" : JSON.stringify(detail));
}

async function main() {
  const boss = new PgBoss({ connectionString: env().DATABASE_URL, schema: "pgboss" });
  boss.on("error", (err) => log(`pg-boss error: ${errorMessage(err)}`));
  await boss.start();

  for (const job of JOBS) {
    // "exclusive": at most one queued-or-active job per queue, so slow runs never pile up.
    await boss.createQueue(job.queue, { policy: "exclusive", retryLimit: 0, expireInSeconds: 600 });
    await boss.schedule(job.queue, job.cron, null, { tz: "UTC" });
    await boss.work(job.queue, async () => {
      try {
        log(`${job.queue} done`, await job.run());
      } catch (err) {
        // Services record their own failures (JobExecution, Integration, ScheduledBriefing).
        log(`${job.queue} failed: ${errorMessage(err)}`);
        throw err;
      }
    });
  }

  await recordWorkerStart();
  // Run everything once at startup instead of waiting for the first cron minute.
  for (const job of JOBS) await boss.send(job.queue);
  log("started", JOBS.map((j) => `${j.queue} @ ${j.cron}`));

  const shutdown = async (signal: string) => {
    log(`stopping (${signal})`);
    await boss.stop({ graceful: true });
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch(async (err) => {
  console.error("[worker] failed to start", err);
  await prisma.$disconnect();
  process.exit(1);
});
