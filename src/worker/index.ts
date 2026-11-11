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
  {
    queue: "scheduler-tick",
    cron: "* * * * *",
    run: async () => {
      const result = await schedulerTick();
      await warnIfGoogleNeedsReconnect();
      return result;
    },
  },
  { queue: "email-reply-check", cron: "*/5 * * * *", run: () => checkAllEmailReplies() },
  { queue: "calendar-sync", cron: "*/15 * * * *", run: () => syncAllCalendars() },
];

function log(message: string, detail?: unknown) {
  console.log(`[worker ${new Date().toISOString()}] ${message}`, detail === undefined ? "" : JSON.stringify(detail));
}

const REAUTH_WARN_EVERY_MS = 60 * 60_000;
let lastReauthWarning = 0;

/** An expired Google login stops every briefing; say so loudly (hourly) instead of failing quietly. */
async function warnIfGoogleNeedsReconnect() {
  if (Date.now() - lastReauthWarning < REAUTH_WARN_EVERY_MS) return;
  const expired = await prisma.integration.count({ where: { provider: { in: ["google_calendar", "gmail"] }, status: "reauth_required" } });
  if (!expired) return;
  lastReauthWarning = Date.now();
  console.warn(
    `\n[worker] !!! GOOGLE ACCESS EXPIRED for ${expired} integration(s): briefings cannot be sent. ` +
      `Open ${env().APP_URL ?? "the app"} and click "Reconnect Google". !!!\n`,
  );
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
