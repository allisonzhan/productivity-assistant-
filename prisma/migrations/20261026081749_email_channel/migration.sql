-- Email briefing channel (Gmail). Renames InboundMessage.fromE164 -> fromAddress in place
-- (it now holds an E.164 number or an email address) so existing rows are kept.

-- AlterTable
ALTER TABLE "DeliveryAttempt" ADD COLUMN     "threadId" TEXT;

-- AlterTable
ALTER TABLE "InboundMessage" RENAME COLUMN "fromE164" TO "fromAddress";
ALTER TABLE "InboundMessage" ADD COLUMN     "channel" TEXT NOT NULL DEFAULT 'sms',
ADD COLUMN     "threadId" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "emailOptOut" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "UserPreference" ALTER COLUMN "briefingChannel" SET DEFAULT 'email';
