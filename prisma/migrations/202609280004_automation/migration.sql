ALTER TABLE "User" ADD COLUMN "automation" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "User" ADD COLUMN "automationUpdatedAt" TIMESTAMP(3);
ALTER TABLE "Task" ADD COLUMN "scheduleKey" TEXT;
CREATE UNIQUE INDEX "Task_scheduleKey_key" ON "Task"("scheduleKey");
