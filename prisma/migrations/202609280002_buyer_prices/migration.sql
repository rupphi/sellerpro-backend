ALTER TABLE "Store" ADD COLUMN "buyerPricesCheckedAt" TIMESTAMP(3),
ADD COLUMN "buyerPricesStatus" TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE "Product" ADD COLUMN "buyerPrice" JSONB;
