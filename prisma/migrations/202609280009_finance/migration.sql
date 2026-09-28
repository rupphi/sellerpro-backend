CREATE TABLE "FinanceSnapshot" (
  "id" TEXT NOT NULL,
  "storeId" TEXT NOT NULL,
  "from" TEXT NOT NULL,
  "to" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "data" JSONB,
  "error" TEXT,
  "checkedAt" TIMESTAMP(3),
  "succeededAt" TIMESTAMP(3),
  CONSTRAINT "FinanceSnapshot_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FinanceSnapshot_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "FinanceSnapshot_storeId_from_to_key" ON "FinanceSnapshot"("storeId", "from", "to");
