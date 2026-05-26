-- Migration: add_mesa_model
-- Execute this against the production database when deploying.

-- 1. Add MESA value to Role enum
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'MESA';

-- 2. Make Order.userId nullable
ALTER TABLE "Order" ALTER COLUMN "userId" DROP NOT NULL;

-- 3. Make Order.deliveryAddress nullable
ALTER TABLE "Order" ALTER COLUMN "deliveryAddress" DROP NOT NULL;

-- 4. Add mesaId column to Order
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "mesaId" TEXT;

-- 5. Create Mesa table
CREATE TABLE IF NOT EXISTS "Mesa" (
    "id"          TEXT NOT NULL,
    "name"        TEXT NOT NULL,
    "number"      INTEGER NOT NULL,
    "terminalId"  TEXT,
    "accessToken" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "isActive"    BOOLEAN NOT NULL DEFAULT true,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Mesa_pkey" PRIMARY KEY ("id")
);

-- 6. Unique constraints on Mesa
CREATE UNIQUE INDEX IF NOT EXISTS "Mesa_number_key" ON "Mesa"("number");
CREATE UNIQUE INDEX IF NOT EXISTS "Mesa_accessToken_key" ON "Mesa"("accessToken");

-- 7. Foreign key from Order.mesaId to Mesa.id
ALTER TABLE "Order"
    ADD CONSTRAINT "Order_mesaId_fkey"
    FOREIGN KEY ("mesaId") REFERENCES "Mesa"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
