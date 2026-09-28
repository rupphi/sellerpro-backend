-- NULL is a persistent session; retain expiry of old sessions until a valid visit.
ALTER TABLE "Session" ALTER COLUMN "expiresAt" DROP NOT NULL;
ALTER TABLE "Session" ADD COLUMN "renewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
