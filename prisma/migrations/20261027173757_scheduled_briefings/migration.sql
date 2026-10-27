-- AlterTable
ALTER TABLE "UserPreference" ADD COLUMN     "morningEnabled" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "ScheduledBriefing" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "forDate" DATE NOT NULL,
    "scheduledFor" TIMESTAMPTZ(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "briefingId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMPTZ(3),
    "error" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ScheduledBriefing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkerHeartbeat" (
    "id" TEXT NOT NULL,
    "startedAt" TIMESTAMPTZ(3) NOT NULL,
    "lastTickAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "WorkerHeartbeat_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ScheduledBriefing_briefingId_key" ON "ScheduledBriefing"("briefingId");

-- CreateIndex
CREATE INDEX "ScheduledBriefing_status_nextAttemptAt_idx" ON "ScheduledBriefing"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "ScheduledBriefing_userId_kind_forDate_key" ON "ScheduledBriefing"("userId", "kind", "forDate");

-- AddForeignKey
ALTER TABLE "ScheduledBriefing" ADD CONSTRAINT "ScheduledBriefing_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
