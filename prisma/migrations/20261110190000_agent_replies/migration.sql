-- AlterTable
ALTER TABLE "InboundMessage" ADD COLUMN     "agentStartedAt" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "PendingAction" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "inboundMessageId" TEXT NOT NULL,
    "threadId" TEXT,
    "actions" JSONB NOT NULL,
    "summary" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "resolvedAt" TIMESTAMPTZ(3),
    "resolvedByInboundId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PendingAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentRun" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "inboundMessageId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "input" TEXT NOT NULL,
    "context" JSONB,
    "zone" TEXT NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL,
    "model" TEXT,
    "toolCalls" JSONB,
    "proposedActions" JSONB,
    "pendingActionId" TEXT,
    "reply" TEXT,
    "error" TEXT,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "latencyMs" INTEGER,
    "verdict" TEXT,
    "note" TEXT,
    "expected" JSONB,
    "markedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PendingAction_inboundMessageId_key" ON "PendingAction"("inboundMessageId");

-- CreateIndex
CREATE INDEX "PendingAction_userId_threadId_status_idx" ON "PendingAction"("userId", "threadId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AgentRun_inboundMessageId_key" ON "AgentRun"("inboundMessageId");

-- CreateIndex
CREATE INDEX "AgentRun_userId_createdAt_idx" ON "AgentRun"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentRun_verdict_idx" ON "AgentRun"("verdict");

-- CreateIndex
CREATE INDEX "InboundMessage_status_agentStartedAt_idx" ON "InboundMessage"("status", "agentStartedAt");

-- AddForeignKey
ALTER TABLE "PendingAction" ADD CONSTRAINT "PendingAction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

