-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "courseName" TEXT,
ADD COLUMN     "externalId" TEXT,
ADD COLUMN     "externalProvider" TEXT,
ADD COLUMN     "externalSubmittedAt" TIMESTAMPTZ(3),
ADD COLUMN     "htmlLink" TEXT,
ADD COLUMN     "notes" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Task_userId_externalProvider_externalId_key" ON "Task"("userId", "externalProvider", "externalId");

