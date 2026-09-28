CREATE TABLE "SalesEvent" (
 "id" TEXT NOT NULL PRIMARY KEY, "storeId" TEXT NOT NULL, "source" TEXT NOT NULL,
 "externalKey" TEXT NOT NULL, "orderKey" TEXT NOT NULL, "kind" TEXT NOT NULL,
 "occurredAt" TIMESTAMP(3) NOT NULL, "channel" TEXT NOT NULL, "status" TEXT NOT NULL,
 "article" TEXT NOT NULL DEFAULT '', "productKey" TEXT NOT NULL DEFAULT '', "title" TEXT NOT NULL DEFAULT '',
 "quantity" INTEGER NOT NULL, "amount" DOUBLE PRECISION, "currency" TEXT NOT NULL DEFAULT 'RUB',
 "collectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "SalesEvent_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "SalesEvent_storeId_source_externalKey_key" ON "SalesEvent"("storeId","source","externalKey");
CREATE INDEX "SalesEvent_storeId_occurredAt_kind_idx" ON "SalesEvent"("storeId","occurredAt","kind");
CREATE INDEX "SalesEvent_storeId_orderKey_idx" ON "SalesEvent"("storeId","orderKey");
CREATE TABLE "SalesSource" (
 "id" TEXT NOT NULL PRIMARY KEY, "storeId" TEXT NOT NULL, "source" TEXT NOT NULL, "status" TEXT NOT NULL,
 "coveredFrom" TIMESTAMP(3), "coveredTo" TIMESTAMP(3), "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "error" TEXT, "data" JSONB,
 CONSTRAINT "SalesSource_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "SalesSource_storeId_source_key" ON "SalesSource"("storeId","source");
